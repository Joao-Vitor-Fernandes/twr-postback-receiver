export interface Config {
  port: number;
  dbPath: string;
  /** Se definido, exige assinatura HMAC-SHA256 em todo POST do webhook. */
  webhookSecret: string | undefined;
  bodyLimit: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválida: ${env.PORT}`);
  }

  return {
    port,
    dbPath: env.DB_PATH?.trim() || './data/postbacks.db',
    webhookSecret: env.WEBHOOK_SECRET?.trim() || undefined,
    bodyLimit: env.BODY_LIMIT?.trim() || '100kb',
  };
}
