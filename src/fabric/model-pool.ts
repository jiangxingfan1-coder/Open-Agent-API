import type { AgentDefinition } from '../core/contracts.js';
import { modelCatalogSchema, modelRouteId, MAX_AGENT_MODELS } from '../core/model-catalog.js';
import { sha } from '../core/util.js';
import type { NodeHub } from './network.js';
import { WorkerRuntime } from './worker.js';

export function supportsReasoning(hub: NodeHub, owner: string, agent: AgentDefinition): boolean {
  return (
    agent.engine === 'kernel' ||
    hub
      .inventory(owner)
      .some((node) =>
        (
          node.execution as { toolFreeReasoning?: string[] } | undefined
        )?.toolFreeReasoning?.includes(agent.engine),
      )
  );
}

export async function refreshAgentModels(
  hub: NodeHub,
  owner: string,
  engine: string,
): Promise<void> {
  for (const node of hub.nodes.values()) {
    if (node.credential.owner === owner && node.executor instanceof WorkerRuntime) {
      await node.executor.projects.ready;
      await node.executor.modelCatalogs.refresh(engine);
    }
  }
}

/** Materialize discovery without rewriting an immutable published bundle. */
export function discoveredAgent(
  hub: NodeHub,
  owner: string,
  agent: AgentDefinition,
): AgentDefinition {
  if (agent.modelPolicy?.mode !== 'discover' || agent.engine === 'kernel') return agent;
  const models = new Set<string>();
  for (const node of hub.inventory(owner)) {
    if (!Array.isArray(node.natives) || !node.natives.includes(agent.engine)) continue;
    const grants = Array.isArray(node.agent_grants) ? node.agent_grants : [];
    if (!grants.includes('*') && !grants.includes(agent.id)) continue;
    const execution = node.execution as { modelCatalogs?: Record<string, unknown> } | undefined;
    const parsed = modelCatalogSchema.safeParse(execution?.modelCatalogs?.[agent.engine]);
    if (!parsed.success) continue;
    for (const m of parsed.data.models) {
      if (agent.modelPolicy.allow && !agent.modelPolicy.allow.includes(m.id)) continue;
      models.add(m.id);
    }
  }
  const routes = agent.routes.filter(
    (r) =>
      !agent.modelPolicy?.allow ||
      r.model === 'default' ||
      agent.modelPolicy.allow.includes(r.model),
  );
  for (const model of models) {
    if (routes.length >= MAX_AGENT_MODELS) break;
    if (routes.some((r) => r.model === model)) continue;
    let id = modelRouteId(model);
    if (routes.some((r) => r.id === id)) id = `model-${sha(model).slice(0, 20)}`;
    routes.push({ id, provider: agent.provider, model, priority: 1, discovered: true });
  }
  return { ...agent, routes };
}
