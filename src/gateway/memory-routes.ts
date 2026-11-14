import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import type { Store } from '../store/store.js';
import { isOwnerWide, principalSubject, type Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';

/** 跨会话记忆的读写接口（`/v1/memory`）。 */
export function registerMemoryRoutes(
  app: FastifyInstance,
  { auth, store }: { auth: Auth; store: Store },
): void {
  /**
   * Memories belong to the caller's own subject. Only an owner-wide admin may name another
   * subject (for example `legacy` rows from before schema v4).
   */
  const memorySubject = (p: Principal, requested?: string): string => {
    if (requested === undefined || requested === principalSubject(p)) return principalSubject(p);
    if (!isOwnerWide(p))
      throw new Fault(
        'scope_denied',
        "Only an owner-wide admin key can access another caller's memories.",
        403,
      );
    return requested;
  };
  app.get('/v1/memory', async (req) => {
    auth.require(req.principal, 'read');
    const q = z
      .object({
        namespace: z.string().max(120).optional(),
        key: z.string().max(240).optional(),
        prefix: z.string().max(240).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        subject: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(req.query);
    const sub = memorySubject(req.principal, q.subject);
    if (q.key) {
      const ns = q.namespace ?? 'default';
      return { entry: store.getMemory(req.principal.owner, sub, ns, q.key) ?? null };
    }
    return {
      data: store.listMemories(req.principal.owner, sub, q.namespace, q.prefix, q.limit),
    };
  });
  const upsertMemoryHandler = async (req: FastifyRequest) => {
    auth.require(req.principal, 'invoke');
    const b = z
      .object({
        namespace: z.string().min(1).max(120).default('default'),
        key: z.string().min(1).max(240),
        value: z.unknown(),
        subject: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(req.body);
    const entry = store.putMemory(
      req.principal.owner,
      memorySubject(req.principal, b.subject),
      b.namespace,
      b.key,
      b.value,
    );
    return { entry };
  };
  app.put('/v1/memory', upsertMemoryHandler);
  app.post('/v1/memory', upsertMemoryHandler);
  app.delete('/v1/memory', async (req) => {
    auth.require(req.principal, 'invoke');
    const q = z
      .object({
        namespace: z.string().min(1).max(120).default('default'),
        key: z.string().min(1).max(240),
        subject: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse((req.query && Object.keys(req.query as object).length ? req.query : req.body) ?? {});
    return {
      deleted: store.deleteMemory(
        req.principal.owner,
        memorySubject(req.principal, q.subject),
        q.namespace,
        q.key,
      ),
    };
  });
}
