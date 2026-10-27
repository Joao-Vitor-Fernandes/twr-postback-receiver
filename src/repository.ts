import type { Db } from './db';
import {
  STATUS_BY_TYPE,
  STATUS_RANK,
  type ReportFilters,
  type SaleEvent,
  type SaleStatus,
} from './schema';

interface SaleRow {
  id: string;
  product_id: string;
  amount_cents: number;
  currency: string;
  status: SaleStatus;
  status_at: string;
  sold_at: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  type: string;
  occurred_at: string;
  received_at: string;
  applied: 0 | 1;
}

export type IngestResult =
  | { outcome: 'duplicate' }
  | {
      outcome: 'processed';
      /** true se este evento mudou o status da venda; false se era mais antigo que o estado atual. */
      applied: boolean;
      saleStatus: SaleStatus;
      /** true se produto/valor/moeda divergem do que já estava gravado (mantemos o original). */
      conflict: boolean;
    };

export interface SaleStats {
  sales_count: number;
  gross_cents: number;
  net_cents: number;
  refunded_count: number;
  refunded_cents: number;
  chargeback_count: number;
  chargeback_cents: number;
}

export interface SalesReport {
  filters: { from: string | null; to: string | null; product_id: string | null };
  generated_at: string;
  totals: Array<{ currency: string } & SaleStats>;
  by_product: Array<{ product_id: string; currency: string } & SaleStats>;
  by_day: Array<{ date: string; currency: string } & SaleStats>;
}

const STATS_COLUMNS = `
  COUNT(*)                                                              AS sales_count,
  SUM(amount_cents)                                                     AS gross_cents,
  COALESCE(SUM(CASE WHEN status = 'approved'   THEN amount_cents END), 0) AS net_cents,
  COUNT(CASE WHEN status = 'refunded' THEN 1 END)                       AS refunded_count,
  COALESCE(SUM(CASE WHEN status = 'refunded'   THEN amount_cents END), 0) AS refunded_cents,
  COUNT(CASE WHEN status = 'chargeback' THEN 1 END)                     AS chargeback_count,
  COALESCE(SUM(CASE WHEN status = 'chargeback' THEN amount_cents END), 0) AS chargeback_cents
`;

export class SalesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Aplica um evento de venda de forma idempotente.
   *
   * - Mesmo `event_id` de novo (retentativa da plataforma) => 'duplicate', nada muda.
   * - Eventos fora de ordem convergem para o mesmo estado final: vence o evento com
   *   maior `occurred_at` (empate: o status mais grave). A ordem de chegada não importa.
   *
   * Roda em transação IMMEDIATE: leitura + escrita acontecem sem outra escrita no meio.
   */
  ingest(event: SaleEvent, now: Date = new Date()): IngestResult {
    return this.inImmediateTransaction(() => this.ingestInTransaction(event, now.toISOString()));
  }

  /** BEGIN IMMEDIATE já pega o lock de escrita: ninguém grava entre o nosso SELECT e o INSERT. */
  private inImmediateTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // se o próprio rollback falhar, o erro original é o que importa
      }
      throw error;
    }
  }

  private ingestInTransaction(event: SaleEvent, nowIso: string): IngestResult {
    const seen = this.db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(event.event_id);
    if (seen) return { outcome: 'duplicate' };

    const incomingStatus = STATUS_BY_TYPE[event.type];
    const current = this.db.prepare('SELECT * FROM sales WHERE id = ?').get(event.sale.id) as
      | SaleRow
      | undefined;

    let applied: boolean;
    let conflict = false;
    let saleStatus: SaleStatus;

    if (!current) {
      this.db
        .prepare(
          `INSERT INTO sales
             (id, product_id, amount_cents, currency, status, status_at, sold_at, created_at, updated_at)
           VALUES (@id, @product_id, @amount_cents, @currency, @status, @at, @at, @now, @now)`,
        )
        .run({
          id: event.sale.id,
          product_id: event.sale.product_id,
          amount_cents: event.sale.amount_cents,
          currency: event.sale.currency,
          status: incomingStatus,
          at: event.occurred_at,
          now: nowIso,
        });
      applied = true;
      saleStatus = incomingStatus;
    } else {
      conflict =
        current.product_id !== event.sale.product_id ||
        current.amount_cents !== event.sale.amount_cents ||
        current.currency !== event.sale.currency;

      const wins =
        event.occurred_at > current.status_at ||
        (event.occurred_at === current.status_at &&
          STATUS_RANK[incomingStatus] > STATUS_RANK[current.status]);
      const soldAt = event.occurred_at < current.sold_at ? event.occurred_at : current.sold_at;

      if (wins) {
        this.db
          .prepare(
            `UPDATE sales
                SET status = @status, status_at = @at, sold_at = @sold_at, updated_at = @now
              WHERE id = @id`,
          )
          .run({
            id: current.id,
            status: incomingStatus,
            at: event.occurred_at,
            sold_at: soldAt,
            now: nowIso,
          });
      } else if (soldAt !== current.sold_at) {
        this.db
          .prepare('UPDATE sales SET sold_at = @sold_at, updated_at = @now WHERE id = @id')
          .run({ id: current.id, sold_at: soldAt, now: nowIso });
      }

      applied = wins;
      saleStatus = wins ? incomingStatus : current.status;
    }

    // Guardamos o evento já validado e sem campos desconhecidos (minimização de dados),
    // não o corpo cru recebido.
    this.db
      .prepare(
        `INSERT INTO events (event_id, sale_id, type, occurred_at, received_at, applied, payload)
         VALUES (@event_id, @sale_id, @type, @occurred_at, @received_at, @applied, @payload)`,
      )
      .run({
        event_id: event.event_id,
        sale_id: event.sale.id,
        type: event.type,
        occurred_at: event.occurred_at,
        received_at: nowIso,
        applied: applied ? 1 : 0,
        payload: JSON.stringify(event),
      });

    return { outcome: 'processed', applied, saleStatus, conflict };
  }

  getSale(id: string) {
    const sale = this.db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SaleRow | undefined;
    if (!sale) return undefined;

    const events = this.db
      .prepare(
        `SELECT event_id, type, occurred_at, received_at, applied
           FROM events WHERE sale_id = ?
          ORDER BY occurred_at, received_at`,
      )
      .all(id) as unknown as EventRow[];

    return {
      id: sale.id,
      product_id: sale.product_id,
      amount_cents: sale.amount_cents,
      currency: sale.currency,
      status: sale.status,
      sold_at: sale.sold_at,
      status_at: sale.status_at,
      events: events.map((e) => ({
        event_id: e.event_id,
        type: e.type,
        occurred_at: e.occurred_at,
        received_at: e.received_at,
        applied: e.applied === 1,
      })),
    };
  }

  /**
   * Relatório agregado no próprio SQL. Período em intervalo semiaberto [from, to)
   * sobre `sold_at`. Valores nunca são somados entre moedas diferentes.
   */
  report(filters: ReportFilters, now: Date = new Date()): SalesReport {
    const where: string[] = [];
    const params: Record<string, string> = {};

    if (filters.from) {
      where.push('sold_at >= @from');
      params.from = filters.from;
    }
    if (filters.to) {
      where.push('sold_at < @to');
      params.to = filters.to;
    }
    if (filters.product_id) {
      where.push('product_id = @product_id');
      params.product_id = filters.product_id;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totals = this.db
      .prepare(
        `SELECT currency, ${STATS_COLUMNS} FROM sales ${clause}
          GROUP BY currency ORDER BY currency`,
      )
      .all(params) as unknown as SalesReport['totals'];

    const byProduct = this.db
      .prepare(
        `SELECT product_id, currency, ${STATS_COLUMNS} FROM sales ${clause}
          GROUP BY product_id, currency ORDER BY currency, net_cents DESC, product_id`,
      )
      .all(params) as unknown as SalesReport['by_product'];

    const byDay = this.db
      .prepare(
        `SELECT substr(sold_at, 1, 10) AS date, currency, ${STATS_COLUMNS} FROM sales ${clause}
          GROUP BY date, currency ORDER BY date, currency`,
      )
      .all(params) as unknown as SalesReport['by_day'];

    return {
      filters: {
        from: filters.from ?? null,
        to: filters.to ?? null,
        product_id: filters.product_id ?? null,
      },
      generated_at: now.toISOString(),
      totals,
      by_product: byProduct,
      by_day: byDay,
    };
  }
}
