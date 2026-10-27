import express, { type NextFunction, type Request, type Response } from 'express';
import { jsonLogger, type Logger } from './logger';
import type { SalesRepository } from './repository';
import {
  envelopeSchema,
  isKnownEventType,
  reportQuerySchema,
  saleEventSchema,
} from './schema';
import { verifySignature } from './signature';

export interface AppDeps {
  repo: SalesRepository;
  /** Se informado, o POST exige o header X-Signature (HMAC-SHA256 do corpo cru). */
  webhookSecret?: string | undefined;
  bodyLimit?: string | undefined;
  logger?: Logger | undefined;
}

function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function createApp({ repo, webhookSecret, bodyLimit = '100kb', logger = jsonLogger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Recebemos o corpo CRU (Buffer) de qualquer content-type:
  //  1) a assinatura HMAC só pode ser conferida sobre os bytes originais;
  //  2) assim nunca fazemos JSON.parse de algo que ainda não foi autenticado.
  app.post(
    '/webhooks/sales',
    express.raw({ type: () => true, limit: bodyLimit }),
    (req: Request, res: Response) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (webhookSecret && !verifySignature(raw, req.get('x-signature'), webhookSecret)) {
        logger.warn('webhook_rejected', { reason: 'invalid_signature' });
        res.status(401).json({ error: 'invalid_signature' });
        return;
      }

      if (raw.length === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }

      const envelope = envelopeSchema.safeParse(json);
      if (!envelope.success) {
        res.status(422).json({ error: 'invalid_payload', details: issuesOf(envelope.error) });
        return;
      }

      // Plataformas reais mandam vários tipos de evento. Um tipo que não tratamos
      // não é erro do remetente: confirmamos (2xx) para ele não ficar reenviando.
      if (!isKnownEventType(envelope.data.type)) {
        logger.info('webhook_ignored', {
          event_id: envelope.data.event_id,
          type: envelope.data.type,
        });
        res.status(200).json({
          status: 'ignored',
          event_id: envelope.data.event_id,
          reason: 'unsupported_event_type',
        });
        return;
      }

      const parsed = saleEventSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn('webhook_rejected', {
          reason: 'invalid_payload',
          event_id: envelope.data.event_id,
        });
        res.status(422).json({ error: 'invalid_payload', details: issuesOf(parsed.error) });
        return;
      }

      const event = parsed.data;
      const result = repo.ingest(event);

      if (result.outcome === 'duplicate') {
        logger.info('webhook_duplicate', { event_id: event.event_id });
        res.status(200).json({ status: 'duplicate', event_id: event.event_id });
        return;
      }

      if (result.conflict) {
        logger.warn('webhook_sale_conflict', {
          event_id: event.event_id,
          sale_id: event.sale.id,
        });
      }
      logger.info('webhook_processed', {
        event_id: event.event_id,
        sale_id: event.sale.id,
        type: event.type,
        applied: result.applied,
        sale_status: result.saleStatus,
      });

      res.status(201).json({
        status: 'processed',
        event_id: event.event_id,
        sale_id: event.sale.id,
        sale_status: result.saleStatus,
        applied: result.applied,
      });
    },
  );

  app.get('/reports/sales', (req: Request, res: Response) => {
    const query = reportQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'invalid_query', details: issuesOf(query.error) });
      return;
    }
    res.json(repo.report(query.data));
  });

  app.get('/sales/:saleId', (req: Request, res: Response) => {
    const sale = repo.getSale(String(req.params.saleId));
    if (!sale) {
      res.status(404).json({ error: 'sale_not_found' });
      return;
    }
    res.json(sale);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      res.status(e.status).json({ error: 'bad_request' });
      return;
    }

    // Falha nossa => 500, para a plataforma tentar de novo depois. Sem vazar detalhes.
    logger.error('unhandled_error', {
      method: req.method,
      path: req.path,
      message: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
