import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import type { AuditLog } from '../store/audit.js';
import type { GatewayConfig } from '../config/config.js';
import { executionLevels, isOwnerWide, keyQuotaSchema } from '../core/contracts.js';
import { Fault } from '../core/util.js';

/** 审计记录与 API 密钥的管理接口（`/v1/audit`、`/v1/keys`）。 */
export function registerKeyRoutes(
  app: FastifyInstance,
  { auth, audit, config }: { auth: Auth; audit: AuditLog; config: GatewayConfig },
): void {
  app.get('/v1/audit', async (req) => {
    if (!isOwnerWide(req.principal))
      throw new Fault('scope_denied', 'The audit trail requires an owner-wide admin key.', 403);
    const q = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .strict()
      .parse(req.query);
    return audit.page(req.principal.owner, q.after, q.limit);
  });
  app.get('/v1/keys', async (req) => ({ data: auth.list(req.principal) }));
  app.post('/v1/keys', async (req) => {
    const b = z
      .object({
        name: z.string().min(1).max(100),
        agents: z.array(z.string()).min(1),
        scopes: z.array(z.enum(['read', 'invoke', 'files', 'approve', 'admin', 'billing'])).min(1),
        quota: keyQuotaSchema.optional(),
        data_scope: z.enum(['own', 'owner']).default('own'),
        execution: z.enum(executionLevels).optional(),
      })
      .strict()
      .parse(req.body);
    return auth.create(
      req.principal,
      b.name,
      b.agents,
      b.scopes,
      b.quota,
      b.data_scope,
      b.execution ?? config.defaultKeyExecution,
    );
  });
  app.post('/v1/keys/:id/quota', async (req) => {
    const b = z
      .object({
        quota: keyQuotaSchema.nullable().optional(),
        reset_usage: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return auth.updateQuota(
      req.principal,
      (req.params as { id: string }).id,
      b.quota ?? undefined,
      b.reset_usage,
    );
  });
  app.delete('/v1/keys/:id', async (req, reply) => {
    auth.revoke(req.principal, (req.params as { id: string }).id);
    return reply.code(204).send();
  });
}
