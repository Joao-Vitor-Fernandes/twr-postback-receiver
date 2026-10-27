import { z } from 'zod';

export const SALE_EVENT_TYPES = ['sale.approved', 'sale.refunded', 'sale.chargeback'] as const;
export type SaleEventType = (typeof SALE_EVENT_TYPES)[number];
export type SaleStatus = 'approved' | 'refunded' | 'chargeback';

export const STATUS_BY_TYPE: Record<SaleEventType, SaleStatus> = {
  'sale.approved': 'approved',
  'sale.refunded': 'refunded',
  'sale.chargeback': 'chargeback',
};

/**
 * Desempate quando dois eventos da mesma venda têm exatamente o mesmo
 * `occurred_at`: o estado "mais grave" vence, independente da ordem de chegada.
 */
export const STATUS_RANK: Record<SaleStatus, number> = {
  approved: 0,
  refunded: 1,
  chargeback: 2,
};

export function isKnownEventType(type: string): type is SaleEventType {
  return (SALE_EVENT_TYPES as readonly string[]).includes(type);
}

// ISO 8601 completo, COM fuso (Z ou ±hh:mm). Sem fuso o instante seria ambíguo.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseTimestamp(value: string): string | null {
  if (!TIMESTAMP_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseDateOnly(value: string): string | null {
  if (!DATE_ONLY_RE.test(value)) return null;
  const ms = Date.parse(value); // data sem hora = meia-noite UTC
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Rejeita datas "roladas" como 2026-02-31.
  return iso.startsWith(value) ? iso : null;
}

/** Instante normalizado para UTC com milissegundos: comparável como texto. */
const timestamp = z.string().transform((value, ctx) => {
  const normalized = parseTimestamp(value);
  if (normalized === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'deve ser ISO 8601 com fuso, ex: 2026-10-26T14:30:00Z',
    });
    return z.NEVER;
  }
  return normalized;
});

const id = z.string().trim().min(1).max(128);

/** Só o necessário para decidir se entendemos o tipo do evento. */
export const envelopeSchema = z.object({
  event_id: id,
  type: z.string().min(1).max(64),
});

export const saleEventSchema = z.object({
  event_id: id,
  type: z.enum(SALE_EVENT_TYPES),
  occurred_at: timestamp,
  sale: z.object({
    id,
    product_id: id,
    // Dinheiro sempre em inteiro na menor unidade (centavos): nada de float.
    amount_cents: z
      .number('deve ser um número inteiro, em centavos (ex: 19990 = R$ 199,90)')
      .int('deve ser inteiro, em centavos (ex: 19990 = R$ 199,90)')
      .positive('deve ser maior que zero')
      .max(1_000_000_000_000, 'valor acima do limite aceito'),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'deve ter 3 letras (ISO 4217), ex: BRL')
      .transform((c) => c.toUpperCase()),
  }),
});

export type SaleEvent = z.infer<typeof saleEventSchema>;

const reportDate = z.string().transform((value, ctx) => {
  const normalized = parseDateOnly(value) ?? parseTimestamp(value);
  if (normalized === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'use YYYY-MM-DD ou ISO 8601 com fuso, ex: 2026-10-01 ou 2026-10-01T00:00:00-03:00',
    });
    return z.NEVER;
  }
  return normalized;
});

export const reportQuerySchema = z
  .object({
    from: reportDate.optional(),
    to: reportDate.optional(),
    product_id: id.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: '"from" deve ser anterior a "to"',
    path: ['from'],
  });

export type ReportFilters = z.infer<typeof reportQuerySchema>;
