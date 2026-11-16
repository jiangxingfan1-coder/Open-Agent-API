import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import type { Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import type { NodeHub } from '../fabric/network.js';
import type { Auth } from './auth.js';

// 远程节点管理：清单、登记记录、策略历史、drain / resume / revoke 与节点登记（enroll）。
// 从 gateway/server.ts 拆出。enroll 单独一个函数，好让 server.ts 保持拆分前的注册顺序
// （本机后端路由夹在两者之间）。

export type NodeRouteDeps = { auth: Auth; config: GatewayConfig; hub: NodeHub };

export function registerNodeRoutes(app: FastifyInstance, deps: NodeRouteDeps): void {
  const { auth, config, hub } = deps;
  app.get('/v1/nodes', async (req) => {
    auth.requireNodeAdmin(req.principal);
    return { data: hub.inventory(req.principal.owner) };
  });
  const nodeRegistrations = (principal: Principal) => {
    auth.requireNodeAdmin(principal);
    const online = new Map(
      hub.inventory(principal.owner).map((node) => [String(node.nodeId), node]),
    );
    const policies = new Map(
      auth
        .nodePolicies()
        .filter((policy) => policy.owner === principal.owner)
        .map((policy) => [policy.nodeId, policy]),
    );
    const configured = new Set(config.nodeKeys.map((key) => key.nodeId));
    const owned = hub.credentials.filter((credential) => credential.owner === principal.owner);
    const ids = new Set([
      ...owned.map((credential) => credential.nodeId),
      ...online.keys(),
      ...policies.keys(),
    ]);
    return [...ids].sort().map((nodeId) => {
      const credential = owned.find((c) => c.nodeId === nodeId),
        node = online.get(nodeId),
        policy = policies.get(nodeId);
      const local = hub.isLocal(nodeId) || config.localWorker?.nodeId === nodeId;
      return {
        nodeId,
        source: local
          ? 'local'
          : credential
            ? configured.has(nodeId)
              ? 'configured'
              : 'enrolled'
            : 'retired',
        manageable: !local && !!credential,
        state: policy?.state ?? 'active',
        connected: !!node,
        active: node?.active ?? null,
        drained: !!node && policy?.state === 'draining' && node.active === 0,
        agent_grants: credential?.agents ?? node?.agent_grants ?? [],
        capability_grants: credential?.capabilities ?? node?.capability_grants ?? [],
        updated_at: policy?.updatedAt ?? null,
        actor: policy?.actor ?? null,
        reason: policy?.reason ?? '',
      };
    });
  };
  app.get('/v1/nodes/registrations', async (req) => ({ data: nodeRegistrations(req.principal) }));
  app.get('/v1/nodes/:id/history', async (req) => {
    auth.requireNodeAdmin(req.principal);
    const nodeId = z
      .string()
      .min(1)
      .max(120)
      .parse((req.params as { id: string }).id);
    if (!nodeRegistrations(req.principal).some((node) => node.nodeId === nodeId))
      throw new Fault('node_not_found', 'Node registration not found.', 404);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query);
    return auth.nodePolicyHistory(req.principal, nodeId, query.after, query.limit);
  });
  for (const [action, state] of [
    ['drain', 'draining'],
    ['resume', 'active'],
    ['revoke', 'revoked'],
  ] as const)
    app.post(`/v1/nodes/:id/${action}`, async (req) => {
      auth.requireNodeAdmin(req.principal);
      const nodeId = z
        .string()
        .min(1)
        .max(120)
        .parse((req.params as { id: string }).id);
      const { reason } = z
        .object({ reason: z.string().max(1000).default('') })
        .strict()
        .parse(req.body);
      if (hub.isLocal(nodeId) || config.localWorker?.nodeId === nodeId)
        throw new Fault(
          'local_node_policy',
          'Remote credential controls cannot change the local worker.',
          409,
        );
      const credential = hub.credentials.find(
        (c) => c.nodeId === nodeId && c.owner === req.principal.owner,
      );
      if (!credential) throw new Fault('node_not_found', 'Node registration not found.', 404);
      const policy = auth.setNodePolicy(req.principal, credential, state, reason);
      const result = hub.applyPolicy(policy);
      return {
        ...nodeRegistrations(req.principal).find((node) => node.nodeId === nodeId),
        ...result,
        external_effects_stopped: 'not_verified',
      };
    });
}

export function registerNodeEnrollRoute(app: FastifyInstance, deps: NodeRouteDeps): void {
  const { auth, hub } = deps;
  app.post('/v1/nodes/enroll', async (req) => {
    const body = z
      .object({
        node_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        agents: z.array(z.string()).min(1),
        capabilities: z.array(z.string()).min(1),
      })
      .strict()
      .parse(req.body);
    if (hub.credentials.some((c) => c.nodeId === body.node_id) || hub.nodes.has(body.node_id))
      throw new Fault('node_exists', 'Node ID is already configured.', 409);
    const result = auth.enroll(req.principal, body.node_id, body.agents, body.capabilities);
    hub.credentials.push(result.credential);
    return { node_id: body.node_id, token: result.token };
  });
}
