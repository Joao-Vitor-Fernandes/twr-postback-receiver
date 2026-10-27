import fs from 'node:fs';
import path from 'node:path';
// SQLite embutido no Node (22.13+): nenhuma dependência nativa para compilar no deploy.
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS sales (
    id            TEXT PRIMARY KEY NOT NULL,
    product_id    TEXT NOT NULL,
    amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
    currency      TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('approved', 'refunded', 'chargeback')),
    -- occurred_at do evento que definiu o status atual (para resolver eventos fora de ordem)
    status_at     TEXT NOT NULL,
    -- menor occurred_at já visto para a venda: aproxima "quando a venda aconteceu"
    sold_at       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales (sold_at);
  CREATE INDEX IF NOT EXISTS idx_sales_product ON sales (product_id);

  -- Log de eventos. A PRIMARY KEY em event_id é a garantia final de idempotência.
  CREATE TABLE IF NOT EXISTS events (
    event_id     TEXT PRIMARY KEY NOT NULL,
    sale_id      TEXT NOT NULL REFERENCES sales (id),
    type         TEXT NOT NULL,
    occurred_at  TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    applied      INTEGER NOT NULL CHECK (applied IN (0, 1)),
    payload      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_sale ON events (sale_id);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(MIGRATION);
  return db;
}
