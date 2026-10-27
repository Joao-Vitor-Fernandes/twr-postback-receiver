import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/db';
import { silentLogger } from '../src/logger';
import { SalesRepository } from '../src/repository';
import { sign } from '../src/signature';

type App = ReturnType<typeof createApp>;

function setup(options: { secret?: string; bodyLimit?: string } = {}) {
  const db = openDb(':memory:');
  const repo = new SalesRepository(db);
  const app = createApp({
    repo,
    webhookSecret: options.secret,
    bodyLimit: options.bodyLimit,
    logger: silentLogger,
  });
  return { app, repo, db };
}

let counter = 0;
function evt(
  o: {
    event_id?: string;
    type?: string;
    occurred_at?: string;
    sale_id?: string;
    product_id?: string;
    amount_cents?: number;
    currency?: string;
  } = {},
) {
  return {
    event_id: o.event_id ?? `evt_${++counter}`,
    type: o.type ?? 'sale.approved',
    occurred_at: o.occurred_at ?? '2026-10-20T12:00:00Z',
    sale: {
      id: o.sale_id ?? 'sale_1',
      product_id: o.product_id ?? 'prod_A',
      amount_cents: o.amount_cents ?? 19990,
      currency: o.currency ?? 'BRL',
    },
  };
}

const post = (app: App, body: unknown) =>
  request(app).post('/webhooks/sales').set('Content-Type', 'application/json').send(body as object);

const report = (app: App, query = '') => request(app).get(`/reports/sales${query}`);

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('GET /health', () => {
  it('responde ok', async () => {
    const { app } = setup();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /webhooks/sales — fluxo básico', () => {
  it('registra uma venda aprovada e responde 201', async () => {
    const { app } = setup();
    const res = await post(app, evt({ event_id: 'evt_a' }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'processed',
      event_id: 'evt_a',
      sale_id: 'sale_1',
      sale_status: 'approved',
      applied: true,
    });

    const sale = await request(app).get('/sales/sale_1');
    expect(sale.status).toBe(200);
    expect(sale.body).toMatchObject({
      id: 'sale_1',
      amount_cents: 19990,
      currency: 'BRL',
      status: 'approved',
    });
    expect(sale.body.events).toHaveLength(1);
  });

  it('normaliza moeda para maiúsculas e instante para UTC', async () => {
    const { app } = setup();
    await post(app, evt({ currency: 'brl', occurred_at: '2026-10-20T09:00:00-03:00' }));

    const sale = await request(app).get('/sales/sale_1');
    expect(sale.body.currency).toBe('BRL');
    expect(sale.body.sold_at).toBe('2026-10-20T12:00:00.000Z');
  });

  it('ignora campos desconhecidos e não guarda dados pessoais que não pediu', async () => {
    const { app } = setup();
    const res = await post(app, {
      ...evt(),
      customer: { email: 'pessoa@exemplo.com', cpf: '000.000.000-00' },
    });
    expect(res.status).toBe(201);

    const sale = await request(app).get('/sales/sale_1');
    expect(JSON.stringify(sale.body)).not.toContain('pessoa@exemplo.com');
  });
});

describe('POST /webhooks/sales — idempotência (retentativas)', () => {
  it('mesmo event_id de novo responde 200 duplicate e não conta duas vezes', async () => {
    const { app } = setup();
    const body = evt({ event_id: 'evt_dup' });

    expect((await post(app, body)).status).toBe(201);
    const again = await post(app, body);

    expect(again.status).toBe(200);
    expect(again.body.status).toBe('duplicate');

    const r = await report(app);
    expect(r.body.totals).toEqual([
      expect.objectContaining({ currency: 'BRL', sales_count: 1, net_cents: 19990 }),
    ]);
  });

  it('entregas simultâneas do mesmo evento são contadas uma única vez', async () => {
    const { app } = setup();
    const body = evt({ event_id: 'evt_race' });

    const responses = await Promise.all(Array.from({ length: 10 }, () => post(app, body)));
    const statuses = responses.map((r) => r.status).sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);

    const r = await report(app);
    expect(r.body.totals[0]).toMatchObject({ sales_count: 1, net_cents: 19990 });
  });

  it('um reenvio do mesmo evento com corpo diferente não altera nada (vale o primeiro)', async () => {
    const { app } = setup();
    await post(app, evt({ event_id: 'evt_x', amount_cents: 1000 }));
    const again = await post(app, evt({ event_id: 'evt_x', amount_cents: 999999 }));

    expect(again.body.status).toBe('duplicate');
    const sale = await request(app).get('/sales/sale_1');
    expect(sale.body.amount_cents).toBe(1000);
  });
});

describe('POST /webhooks/sales — ciclo de vida e eventos fora de ordem', () => {
  it('reembolso posterior muda o status e sai da receita líquida', async () => {
    const { app } = setup();
    await post(app, evt({ occurred_at: '2026-10-20T12:00:00Z' }));
    const res = await post(app, evt({ type: 'sale.refunded', occurred_at: '2026-10-21T12:00:00Z' }));

    expect(res.body).toMatchObject({ sale_status: 'refunded', applied: true });

    const r = await report(app);
    expect(r.body.totals[0]).toMatchObject({
      sales_count: 1,
      gross_cents: 19990,
      net_cents: 0,
      refunded_count: 1,
      refunded_cents: 19990,
    });
  });

  it('reembolso que chega ANTES da aprovação não é sobrescrito por ela', async () => {
    const { app } = setup();
    const refund = await post(
      app,
      evt({ type: 'sale.refunded', occurred_at: '2026-10-21T12:00:00Z' }),
    );
    expect(refund.status).toBe(201);

    const approved = await post(app, evt({ occurred_at: '2026-10-20T12:00:00Z' }));
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ sale_status: 'refunded', applied: false });

    const sale = await request(app).get('/sales/sale_1');
    expect(sale.body.status).toBe('refunded');
    // A data da venda passa a ser a da aprovação, que aconteceu primeiro.
    expect(sale.body.sold_at).toBe('2026-10-20T12:00:00.000Z');
  });

  it('qualquer ordem de chegada converge para o mesmo estado final', async () => {
    const events = [
      evt({ event_id: 'e1', type: 'sale.approved', occurred_at: '2026-10-20T10:00:00Z' }),
      evt({ event_id: 'e2', type: 'sale.refunded', occurred_at: '2026-10-21T10:00:00Z' }),
      evt({ event_id: 'e3', type: 'sale.chargeback', occurred_at: '2026-10-22T10:00:00Z' }),
    ];

    for (const order of permutations(events)) {
      const { app } = setup();
      for (const e of order) await post(app, e);

      const sale = await request(app).get('/sales/sale_1');
      expect(sale.body.status).toBe('chargeback');
      expect(sale.body.sold_at).toBe('2026-10-20T10:00:00.000Z');
      expect(sale.body.events).toHaveLength(3);
    }
  });

  it('empate de occurred_at: o status mais grave vence, em qualquer ordem', async () => {
    const at = '2026-10-20T10:00:00Z';
    const events = [
      evt({ event_id: 'a', type: 'sale.approved', occurred_at: at }),
      evt({ event_id: 'b', type: 'sale.refunded', occurred_at: at }),
    ];

    for (const order of permutations(events)) {
      const { app } = setup();
      for (const e of order) await post(app, e);
      const sale = await request(app).get('/sales/sale_1');
      expect(sale.body.status).toBe('refunded');
    }
  });

  it('dados divergentes para a mesma venda não sobrescrevem o original', async () => {
    const { app } = setup();
    await post(app, evt({ amount_cents: 10000 }));
    const res = await post(
      app,
      evt({ type: 'sale.refunded', occurred_at: '2026-10-21T12:00:00Z', amount_cents: 99 }),
    );
    expect(res.status).toBe(201);

    const sale = await request(app).get('/sales/sale_1');
    expect(sale.body.amount_cents).toBe(10000);
    expect(sale.body.status).toBe('refunded');
  });
});

describe('POST /webhooks/sales — entradas inválidas ou inesperadas', () => {
  it('tipo de evento desconhecido: 200 ignored, e nada é gravado', async () => {
    const { app } = setup();
    const res = await post(app, { event_id: 'evt_cart', type: 'cart.abandoned', foo: 'bar' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ignored', reason: 'unsupported_event_type' });

    const r = await report(app);
    expect(r.body.totals).toEqual([]);
  });

  it.each([
    ['sem sale', { event_id: 'x', type: 'sale.approved', occurred_at: '2026-10-20T12:00:00Z' }],
    ['valor decimal', evt({ amount_cents: 199.9 })],
    ['valor zero', evt({ amount_cents: 0 })],
    ['valor negativo', evt({ amount_cents: -5 })],
    ['valor como texto', { ...evt(), sale: { ...evt().sale, amount_cents: '19990' } }],
    ['moeda inválida', evt({ currency: 'REAL' })],
    ['data sem fuso', evt({ occurred_at: '2026-10-20T12:00:00' })],
    ['data inválida', evt({ occurred_at: 'ontem' })],
    ['event_id vazio', evt({ event_id: '' })],
  ])('payload inválido (%s) => 422 com detalhes', async (_name, body) => {
    const { app } = setup();
    const res = await post(app, body);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid_payload');
    expect(res.body.details.length).toBeGreaterThan(0);

    const r = await report(app);
    expect(r.body.totals).toEqual([]);
  });

  it.each([['null'], ['[]'], ['"texto"'], ['42']])('JSON que não é objeto (%s) => 422', async (raw) => {
    const { app } = setup();
    const res = await request(app)
      .post('/webhooks/sales')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(422);
  });

  it('JSON malformado => 400', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/webhooks/sales')
      .set('Content-Type', 'application/json')
      .send('{"event_id": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('corpo vazio => 400', async () => {
    const { app } = setup();
    const res = await request(app).post('/webhooks/sales');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_body');
  });

  it('corpo acima do limite => 413', async () => {
    const { app } = setup({ bodyLimit: '1kb' });
    const res = await post(app, { ...evt(), padding: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('falha interna => 500 genérico (a plataforma tenta de novo), sem vazar detalhes', async () => {
    const { repo } = setup();
    repo.ingest = () => {
      throw new Error('disco cheio: /var/segredo');
    };
    const app = createApp({ repo, logger: silentLogger });

    const res = await post(app, evt());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });
});

describe('SalesRepository — atomicidade', () => {
  it('erro no meio da ingestão desfaz tudo (nenhuma venda "órfã" fica gravada)', () => {
    const { repo } = setup();
    // Falha de propósito no INSERT do evento (event_id NULL), DEPOIS de a venda ter sido inserida.
    const broken = { ...evt(), event_id: null } as unknown as Parameters<typeof repo.ingest>[0];

    expect(() => repo.ingest(broken)).toThrow();
    expect(repo.getSale('sale_1')).toBeUndefined();

    // E o banco continua utilizável (a transação foi encerrada).
    const ok = repo.ingest(evt({ event_id: 'evt_ok' }) as Parameters<typeof repo.ingest>[0]);
    expect(ok.outcome).toBe('processed');
  });
});

describe('POST /webhooks/sales — assinatura HMAC', () => {
  const secret = 'segredo-de-teste';
  const body = JSON.stringify(evt({ event_id: 'evt_signed' }));

  const signedPost = (app: App, raw: string, signature?: string) => {
    const req = request(app).post('/webhooks/sales').set('Content-Type', 'application/json');
    if (signature) req.set('X-Signature', signature);
    return req.send(raw);
  };

  it('aceita assinatura válida', async () => {
    const { app } = setup({ secret });
    const res = await signedPost(app, body, sign(body, secret));
    expect(res.status).toBe(201);
  });

  it('rejeita sem header, com assinatura errada e com corpo adulterado', async () => {
    const { app } = setup({ secret });

    expect((await signedPost(app, body)).status).toBe(401);
    expect((await signedPost(app, body, sign(body, 'outro-segredo'))).status).toBe(401);

    const tampered = body.replace('19990', '1');
    expect((await signedPost(app, tampered, sign(body, secret))).status).toBe(401);

    const r = await report(app);
    expect(r.body.totals).toEqual([]);
  });

  it('rejeita mesmo sem content-type JSON (não dá para pular a verificação)', async () => {
    const { app } = setup({ secret });
    const res = await request(app)
      .post('/webhooks/sales')
      .set('Content-Type', 'text/plain')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('sem WEBHOOK_SECRET configurado, a verificação fica desligada', async () => {
    const { app } = setup();
    const res = await signedPost(app, body);
    expect(res.status).toBe(201);
  });
});

describe('GET /reports/sales', () => {
  it('relatório vazio é válido', async () => {
    const { app } = setup();
    const res = await report(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totals: [], by_product: [], by_day: [] });
  });

  it('agrega por moeda, produto e dia, sem misturar moedas', async () => {
    const { app } = setup();
    await post(app, evt({ sale_id: 's1', product_id: 'A', amount_cents: 10000 }));
    await post(app, evt({ sale_id: 's2', product_id: 'A', amount_cents: 5000 }));
    await post(app, evt({ sale_id: 's3', product_id: 'B', amount_cents: 7000, currency: 'USD' }));
    await post(
      app,
      evt({
        sale_id: 's2',
        type: 'sale.refunded',
        product_id: 'A',
        amount_cents: 5000,
        occurred_at: '2026-10-22T12:00:00Z',
      }),
    );

    const res = await report(app);
    expect(res.body.totals).toEqual([
      {
        currency: 'BRL',
        sales_count: 2,
        gross_cents: 15000,
        net_cents: 10000,
        refunded_count: 1,
        refunded_cents: 5000,
        chargeback_count: 0,
        chargeback_cents: 0,
      },
      {
        currency: 'USD',
        sales_count: 1,
        gross_cents: 7000,
        net_cents: 7000,
        refunded_count: 0,
        refunded_cents: 0,
        chargeback_count: 0,
        chargeback_cents: 0,
      },
    ]);
    expect(res.body.by_product.map((p: { product_id: string; currency: string }) => [p.product_id, p.currency])).toEqual([
      ['A', 'BRL'],
      ['B', 'USD'],
    ]);
    expect(res.body.by_day).toHaveLength(2); // BRL e USD no mesmo dia
  });

  it('filtra por produto', async () => {
    const { app } = setup();
    await post(app, evt({ sale_id: 's1', product_id: 'A' }));
    await post(app, evt({ sale_id: 's2', product_id: 'B' }));

    const res = await report(app, '?product_id=B');
    expect(res.body.totals[0]).toMatchObject({ sales_count: 1 });
    expect(res.body.by_product).toHaveLength(1);
    expect(res.body.filters.product_id).toBe('B');
  });

  it('período é [from, to): inclui o início e exclui o fim', async () => {
    const { app } = setup();
    await post(app, evt({ sale_id: 's1', occurred_at: '2026-10-01T00:00:00Z' }));
    await post(app, evt({ sale_id: 's2', occurred_at: '2026-10-15T12:00:00Z' }));
    await post(app, evt({ sale_id: 's3', occurred_at: '2026-10-31T12:00:00Z' }));

    const res = await report(app, '?from=2026-10-01&to=2026-10-31');
    expect(res.body.totals[0]).toMatchObject({ sales_count: 2 });
  });

  it('agrupa por dia em UTC', async () => {
    const { app } = setup();
    // 23:30 em Brasília (UTC-3) já é dia seguinte em UTC.
    await post(app, evt({ sale_id: 's1', occurred_at: '2026-10-19T23:30:00-03:00' }));

    const res = await report(app);
    expect(res.body.by_day[0].date).toBe('2026-10-20');
  });

  it('aceita datetime com fuso em from/to', async () => {
    const { app } = setup();
    await post(app, evt({ sale_id: 's1', occurred_at: '2026-10-20T12:00:00Z' }));

    const inside = await report(
      app,
      `?from=${encodeURIComponent('2026-10-20T09:00:00-03:00')}&to=${encodeURIComponent('2026-10-20T09:30:00-03:00')}`,
    );
    expect(inside.status).toBe(200);
    expect(inside.body.totals[0]).toMatchObject({ sales_count: 1 });
  });

  it.each([
    ['data inválida', '?from=ontem'],
    ['data impossível', '?from=2026-02-31'],
    ['from depois de to', '?from=2026-10-10&to=2026-10-01'],
    ['from igual a to', '?from=2026-10-10&to=2026-10-10'],
    ['parâmetro repetido', '?product_id=a&product_id=b'],
  ])('query inválida (%s) => 400', async (_name, query) => {
    const { app } = setup();
    const res = await report(app, query);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
  });
});

describe('rotas inexistentes', () => {
  it('GET /sales/:id desconhecida => 404', async () => {
    const { app } = setup();
    const res = await request(app).get('/sales/nao-existe');
    expect(res.status).toBe(404);
  });

  it('rota desconhecida => 404 em JSON', async () => {
    const { app } = setup();
    const res = await request(app).get('/nada');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
