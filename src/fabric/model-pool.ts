import {
  executionPermits,
  requiredExecution,
  sandboxable,
  type AgentDefinition,
  type ExecutionLevel,
} from '../core/contracts.js';
import { modelCatalogSchema, modelRouteId, MAX_AGENT_MODELS } from '../core/model-catalog.js';
import { sha } from '../core/util.js';
import type { Store } from '../store/store.js';
import { permits, type NodeHub } from './network.js';
import { WorkerRuntime } from './worker.js';

export function supportsReasoning(hub: NodeHub, owner: string, agent: AgentDefinition): boolean {
  return (
    agent.engine === 'kernel' ||
    hub.inventory(owner).some((node) => {
      if (node.accepting === false) return false;
      const grants = Array.isArray(node.agent_grants) ? node.agent_grants.map(String) : ['*'];
      if (!permits(grants, agent.id)) return false;
      return (
        node.execution as { toolFreeReasoning?: string[] } | undefined
      )?.toolFreeReasoning?.includes(agent.engine);
    })
  );
}

export type PlannerCheckOptions = {
  grantedAgents?: readonly string[];
  externalCaller?: boolean;
  toolBoundary?: string;
  execution?: ExecutionLevel;
  hostAgents?: readonly string[];
};

export type ResolvedOrchestrationPlanner = {
  agent: AgentDefinition;
  digest: string;
  routeId: string;
  routes: string[];
};

/** Resolve an authorized, boundary-compatible planner agent when configured on `agent.orchestration`. */
export function resolveOrchestrationPlanner(
  store: Store,
  hub: NodeHub,
  owner: string,
  agent: AgentDefinition,
  options?: PlannerCheckOptions,
): ResolvedOrchestrationPlanner | undefined {
  const spec = agent.orchestration?.planner;
  if (!spec) return undefined;
  if (options?.grantedAgents && !permits([...options.grantedAgents], spec.agent)) return undefined;
  let planner: AgentDefinition;
  let digest: string;
  try {
    const bundle = store.bundle(owner, spec.agent);
    digest = bundle.digest;
    planner = discoveredAgent(hub, owner, bundle.agent);
  } catch {
    return undefined;
  }
  if (!supportsReasoning(hub, owner, planner)) return undefined;
  if (options?.externalCaller && planner.access?.trust === 'private') return undefined;
  if (options?.toolBoundary === 'client' && planner.engine !== 'kernel') return undefined;
  if (options?.execution && options.execution !== 'host') {
    const required = requiredExecution(planner);
    const fits =
      executionPermits(options.execution, required) ||
      (options.execution === 'sandbox' && sandboxable(planner)) ||
      !!options.hostAgents?.includes(planner.id);
    if (!fits) return undefined;
  }
  const choices = planner.routes.length
    ? planner.routes
    : [{ id: 'default', provider: planner.provider, model: planner.model, priority: 0 }];
  if (spec.route) {
    const matched = choices.find((r) => r.id === spec.route || r.model === spec.route);
    if (!matched) return undefined;
    return { agent: planner, digest, routeId: matched.id, routes: [matched.id] };
  }
  return {
    agent: planner,
    digest,
    routeId: choices[0]!.id,
    routes: choices.map((r) => r.id),
  };
}

export function canOrchestrate(
  store: Store,
  hub: NodeHub,
  owner: string,
  agent: AgentDefinition,
  options?: PlannerCheckOptions,
): boolean {
  return (
    supportsReasoning(hub, owner, agent) ||
    resolveOrchestrationPlanner(store, hub, owner, agent, options) !== undefined
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
