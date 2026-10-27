import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { jsonLogger as logger } from './logger';
import { SalesRepository } from './repository';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({
  repo: new SalesRepository(db),
  webhookSecret: config.webhookSecret,
  bodyLimit: config.bodyLimit,
  logger,
});

if (!config.webhookSecret) {
  logger.warn('signature_verification_disabled', {
    hint: 'defina WEBHOOK_SECRET para exigir X-Signature nos webhooks',
  });
}

const server = app.listen(config.port, () => {
  logger.info('server_started', { port: config.port, db: config.dbPath });
});

// Balanceadores de carga (Render, AWS...) reaproveitam conexões; um keep-alive maior
// que o deles evita 502 esporádico em conexões reaproveitadas.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

function shutdown(signal: string): void {
  logger.info('shutting_down', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Se alguma conexão não fechar, não ficamos pendurados para sempre.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
