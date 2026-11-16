import { agentSchema, type AgentBundle, type Work } from './contracts.js';
import type { ModelCatalog } from './model-catalog.js';
import { canonical, Fault } from './util.js';

/** A discovered model may extend a route pool, never any other published authority. */
export function validateModelWork(
  bundle: AgentBundle,
  work: Extract<Work, { kind: 'model' | 'native' }>,
  catalogs: Record<string, ModelCatalog>,
) {
  const agent = agentSchema.parse(work.agent);
  const routes = [
    { provider: bundle.agent.provider, model: bundle.agent.model },
    ...bundle.agent.routes,
  ];
  if (bundle.agent.modelPolicy?.mode === 'discover' && agent.provider === bundle.agent.provider) {
    const catalog = catalogs[agent.engine];
    if (
      catalog?.models.some((m) => m.id === agent.model) &&
      (!bundle.agent.modelPolicy.allow || bundle.agent.modelPolicy.allow.includes(agent.model))
    )
      routes.push({ provider: agent.provider, model: agent.model });
  }
  const { provider, model, ...rest } = agent;
  const { provider: _p, model: _m, ...original } = bundle.agent;
  const extra = rest.tools.slice(original.tools.length);
  if (
    work.kind === 'model' &&
    extra.length &&
    extra.every((t) => t.handler.kind === 'node' && t.handler.reference.startsWith('client/'))
  )
    rest.tools = rest.tools.slice(0, original.tools.length);
  if (
    canonical(rest) !== canonical(original) ||
    !routes.some((r) => r.provider === provider && r.model === model)
  )
    throw new Fault('manifest_mismatch', 'Execution differs from the published agent.', 403);
  return agent;
}
