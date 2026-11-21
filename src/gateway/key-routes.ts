import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectionSchema } from '../core/agent-access.js';
import type { Auth } from './auth.js';
import type { AuditLog } from '../store/audit.js';
import type { GatewayConfig } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { NodeHub } from '../fabric/network.js';
import { executionLevels, isOwnerWide, keyQuotaSchema } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { assertMayManageKey, assertQuotaWithin } from './key-guard.js';

/** 审计记录、API 密钥与运行事件回调的管理接口（`/v1/audit`、`/v1/keys`、`/v1/webhooks`）。 */
export function registerKeyRoutes(
  app: FastifyInstance,
  {
    auth,
    audit,
    config,
    store,
    hub,
  }: { auth: Auth; audit: AuditLog; config: GatewayConfig; store: Store; hub: NodeHub },
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
        scopes: z
          .array(z.enum(['read', 'invoke', 'files', 'approve', 'admin', 'billing', 'node']))
          .min(1),
        capabilities: z.array(z.string()).min(1).optional(),
        quota: keyQuotaSchema.optional(),
        data_scope: z.enum(['own', 'owner']).default('own'),
        execution: z.enum(executionLevels).optional(),
        connection: connectionSchema.optional(),
      })
      .strict()
      .parse(req.body);
    if (b.scopes.includes('node')) {
      if (b.scopes.length !== 1)
        throw new Fault(
          'invalid_request',
          'A node key may carry only the `node` scope; enroll API keys separately.',
          400,
        );
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(b.name))
        throw new Fault('invalid_request', 'Node name must match ^[A-Za-z0-9_-]{1,64}$.', 400);
      if (hub.credentials.some((c) => c.nodeId === b.name) || hub.nodes.has(b.name))
        throw new Fault('node_exists', 'Node ID is already configured.', 409);
      const capabilities = b.capabilities ?? ['*'];
      const enrolled = auth.enroll(req.principal, b.name, b.agents, capabilities);
      hub.credentials.push(enrolled.credential);
      return {
        id: b.name,
        node_id: b.name,
        name: b.name,
        owner: req.principal.owner,
        agents: b.agents,
        capabilities,
        scopes: ['node'] as const,
        token: enrolled.token,
      };
    }
    assertQuotaWithin(req.principal, b.quota);
    return auth.create(
      req.principal,
      b.name,
      b.agents,
      b.scopes as ('read' | 'invoke' | 'files' | 'approve' | 'admin' | 'billing')[],
      b.quota,
      b.data_scope,
      b.execution ??
        (b.connection?.audience === 'external' ? 'workspace' : config.defaultKeyExecution),
      b.connection,
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
    const keyId = (req.params as { id: string }).id;
    assertMayManageKey(req.principal, keyId, auth.list(req.principal));
    assertQuotaWithin(req.principal, b.quota);
    return auth.updateQuota(req.principal, keyId, b.quota ?? undefined, b.reset_usage);
  });
  app.delete('/v1/keys/:id', async (req, reply) => {
    const keyId = (req.params as { id: string }).id;
    assertMayManageKey(req.principal, keyId, auth.list(req.principal));
    auth.revoke(req.principal, keyId);
    return reply.code(204).send();
  });
}
