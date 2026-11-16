import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DshClient } from '../config/dsh-client.js';
import type { GatewayConfig } from '../config/config.js';
import { allowedExecution, type Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { toolBoundarySchema, type ToolBoundary } from '../core/agent-access.js';
import type { NodeHub } from '../fabric/network.js';
import { refreshAgentModels } from '../fabric/model-pool.js';
import type { Store } from '../store/store.js';
import type { Auth } from './auth.js';
import type { VisibleAgent } from './agent-views.js';
import { connectionSource } from './local-connection-source.js';
import { LocalConnections } from './local-connections.js';

export async function registerLocalConnectionRoutes(
  app: FastifyInstance,
  deps: {
    auth: Auth;
    store: Store;
    hub: NodeHub;
    config: GatewayConfig;
    dshHome?: string;
    isLocalRequest: (req: FastifyRequest) => boolean;
    cachedAgents: (p: Principal) => VisibleAgent[];
  },
): Promise<void> {
  const { auth, store, hub, config, cachedAgents } = deps;
  const enabled = !!config.localWorker && config.security.profile === 'local' && !config.tls;
  const source = (
    p: Principal,
    agent: string,
    model: string,
    base: string,
    toolMode?: ToolBoundary,
  ) => connectionSource(store, hub, config, p, cachedAgents(p), agent, model, base, toolMode);
  const manager = enabled
    ? new LocalConnections(
        auth,
        config.dataDir,
        new DshClient(deps.dshHome),
        config.localWorker!.owner,
        source,
      )
    : undefined;
  await manager?.ready.catch(() => {});
  const guard = (req: FastifyRequest) => {
    auth.requireNodeAdmin(req.principal);
    if (allowedExecution(req.principal) !== 'host')
      throw new Fault(
        'scope_denied',
        'Local client management requires host administrator authority.',
        403,
      );
    if (!deps.isLocalRequest(req) || req.principal.owner !== config.localWorker?.owner || !manager)
      throw new Fault(
        'scope_denied',
        'Local client configuration requires a direct loopback owner-admin connection to a local HTTP gateway.',
        403,
      );
    if (req.headers.origin) {
      let same = false;
      try {
        same = new URL(req.headers.origin).host === req.headers.host;
      } catch {}
      if (!same)
        throw new Fault(
          'scope_denied',
          'Local client configuration requires the same origin.',
          403,
        );
    }
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    if (!port)
      throw new Fault(
        'local_connection_unavailable',
        'Start the local gateway before configuring a client.',
        409,
      );
    return { manager, base: `http://${config.host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/v1` };
  };
  app.get('/v1/local/connections', async (req) => {
    const { manager, base } = guard(req);
    const list = await manager.list(req.principal, base);
    const sources = cachedAgents(req.principal).map((a) => {
      try {
        const selected = source(req.principal, a.id, 'auto', base);
        return {
          id: a.id,
          engine: a.engine,
          available: true,
          tool_modes: selected.toolModes,
          default_tool_mode: selected.toolMode,
          models: selected.models.map((m) => ({
            id: m.id,
            selector: m.id === a.id ? 'auto' : m.id.slice(a.id.length + 1),
            name: m.name,
          })),
        };
      } catch (error) {
        return {
          id: a.id,
          engine: a.engine,
          available: false,
          reason: error instanceof Fault ? error.code : 'local_connection_unavailable',
          models: [],
        };
      }
    });
    return { ...list, sources };
  });
  app.post('/v1/local/connections/preview', async (req) => {
    const { manager, base } = guard(req);
    const body = z
      .object({
        agent: z.string().min(1).max(120),
        model: z.string().min(1).max(200).default('auto'),
        tool_mode: toolBoundarySchema.optional(),
      })
      .strict()
      .parse(req.body);
    const published = store.agentDefinition(req.principal.owner, body.agent);
    if (published.agent.modelPolicy?.mode === 'discover')
      await refreshAgentModels(hub, req.principal.owner, published.agent.engine);
    return manager.preview(req.principal, body.agent, body.model, base, body.tool_mode);
  });
  app.post('/v1/local/connections/apply', async (req) => {
    const { manager, base } = guard(req);
    const { plan_id } = z
      .object({ plan_id: z.string().regex(/^[a-f0-9]{48}$/) })
      .strict()
      .parse(req.body);
    return manager.apply(req.principal, plan_id, base, () =>
      auth.revalidate(req.headers.authorization),
    );
  });
  app.post('/v1/local/connections/:id/check', async (req) => {
    const { manager, base } = guard(req);
    const id = z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .parse((req.params as { id: string }).id);
    return manager.check(req.principal, id, base);
  });
  app.delete('/v1/local/connections/:id', async (req) => {
    const { manager, base } = guard(req);
    const id = z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .parse((req.params as { id: string }).id);
    return manager.remove(req.principal, id, base, () =>
      auth.revalidate(req.headers.authorization),
    );
  });
}
