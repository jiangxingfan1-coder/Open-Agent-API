import type { FastifyInstance } from 'fastify';
import { Fault, canonical, sha } from '../core/util.js';
import { permitsToolBoundary } from '../core/agent-access.js';
import { refreshAgentModels } from '../fabric/model-pool.js';
import { directoryQuery, definitionQuery, page } from './discovery.js';
import type { Store } from '../store/store.js';
import type { NodeHub } from '../fabric/network.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Principal } from '../core/contracts.js';
import type { VisibleAgent } from './agent-views.js';

export function registerAgentModelRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    hub: NodeHub;
    kernel: Kernel;
    cachedAgents: (principal: Principal) => VisibleAgent[];
  },
): void {
  const { store, hub, kernel, cachedAgents } = deps;
  app.get('/v1/agents/models', async (req) => {
    const query = directoryQuery
      .extend({ agent: definitionQuery.shape.agent })
      .strict()
      .parse(req.query);
    kernel.authorize(req.principal, query.agent, 'read');
    if (query.offset > 0 && !query.revision)
      throw new Fault(
        'invalid_request',
        'Pass the revision from the first model page when requesting subsequent pages.',
      );
    const published = store.agentDefinition(req.principal.owner, query.agent);
    if (published.agent.modelPolicy?.mode === 'discover')
      await refreshAgentModels(hub, req.principal.owner, published.agent.engine);
    const agent = cachedAgents(req.principal).find((a) => a.id === query.agent);
    if (!agent)
      throw new Fault('agent_not_found', 'The agent publication is no longer available.', 404);
    const modes = ['managed', 'client', 'hybrid'] as const;
    const toolBoundaries = modes.filter(
      (mode) =>
        agent.tool_boundaries.includes(mode) &&
        (!agent.access || agent.access.modes.includes(mode)) &&
        (!req.principal.connection?.allowedModes ||
          permitsToolBoundary(req.principal.connection.allowedModes, mode)),
    );
    const rows = [
      ...['auto', 'fast', 'best', 'eco'].map((mode) => ({
        id: mode === 'auto' ? agent.id : `${agent.id}@${mode}`,
        kind: 'mode',
        selector: mode,
        available: agent.dispatchable,
      })),
      ...agent.routes.map((route) => ({
        id: `${agent.id}@${route.id}`,
        kind: 'model',
        selector: route.id,
        model: route.model,
        available: route.available,
        verification: route.discovered ? 'discovered' : 'configured',
      })),
    ].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const revision = sha(
      canonical({
        agent: agent.id,
        version: agent.version,
        members: rows.map((row) => [row.id, row.kind, 'model' in row ? row.model : null]),
      }),
    );
    if (query.revision && query.revision !== revision)
      throw new Fault(
        'catalog_changed',
        'The agent model catalog changed. Restart from offset zero.',
        409,
      );
    return page(rows.slice(query.offset, query.offset + query.limit), query.offset, rows.length, {
      agent: agent.id,
      agent_version: agent.version,
      revision,
      tool_boundaries: toolBoundaries,
      account_access: 'not_verified',
    });
  });
}
