import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Fault } from '../core/util.js';
import type { Auth } from './auth.js';
import type { Catalog } from './catalog.js';
import { observeAuthorization, openEventStream, revalidateObservation } from './streams.js';

// 目录变更订阅：长轮询 GET /v1/catalog/changes 与 SSE GET /v1/catalog/events。
// 从 gateway/server.ts 拆出。

export type CatalogFeedRouteDeps = { auth: Auth; catalog: Catalog };

export function registerCatalogFeedRoutes(app: FastifyInstance, deps: CatalogFeedRouteDeps): void {
  const { auth, catalog } = deps;
  app.get('/v1/catalog/changes', async (req, reply) => {
    auth.require(req.principal, 'read');
    const q = z
      .object({
        cursor: z.string().min(1).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(32).default(32),
        timeout_ms: z.coerce.number().int().min(0).max(25000).default(20000),
      })
      .strict()
      .parse(req.query);
    const controller = new AbortController();
    const disconnect = () =>
      controller.abort(new Fault('wait_cancelled', 'Catalog reader disconnected.', 499));
    const off = observeAuthorization(auth, req, (error) => controller.abort(error));
    reply.raw.once('close', disconnect);
    try {
      const page = await catalog.wait(
        req.principal,
        q.cursor,
        q.limit,
        q.timeout_ms,
        controller.signal,
      );
      revalidateObservation(auth, req);
      return page;
    } finally {
      off();
      reply.raw.off('close', disconnect);
    }
  });
  app.get('/v1/catalog/events', async (req, reply) => {
    auth.require(req.principal, 'read');
    const q = z
      .object({ cursor: z.string().min(1).max(100).optional() })
      .strict()
      .parse(req.query);
    const header = req.headers['last-event-id'];
    if (header !== undefined && (typeof header !== 'string' || header.length > 100))
      throw new Fault('invalid_catalog_cursor', 'Invalid Last-Event-ID.');
    if (header && q.cursor && header !== q.cursor)
      throw new Fault('invalid_catalog_cursor', 'Conflicting catalog cursors.');
    let after = q.cursor ?? header;
    catalog.page(req.principal, after);
    let stream: ReturnType<typeof openEventStream> | undefined;
    let draining = false;
    const drain = () => {
      if (!stream || stream.closed || draining) return;
      draining = true;
      try {
        while (!stream.closed) {
          const page = subscription.read(after);
          if (page.reset)
            stream.write(
              `id: ${page.cursor}\nevent: catalog.reset\ndata: ${JSON.stringify({ cursor: page.cursor, refresh: '/v1/agents' })}\n\n`,
            );
          else
            for (const change of page.data)
              if (
                !stream.write(
                  `id: ${change.cursor}\nevent: catalog.changed\ndata: ${JSON.stringify(change)}\n\n`,
                )
              )
                break;
          after = page.cursor;
          if (!page.has_more) break;
        }
      } catch {
        stream.close();
      } finally {
        draining = false;
      }
    };
    const subscription = catalog.subscribe(req.principal, drain);
    try {
      stream = openEventStream(req, reply, auth, {}, 65536);
      stream.onClose(subscription.close);
      drain();
    } catch (error) {
      subscription.close();
      throw error;
    }
  });
}
