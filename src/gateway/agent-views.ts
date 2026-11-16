import type { Principal } from '../core/contracts.js';
import type { NodeHub } from '../fabric/network.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Store } from '../store/store.js';
import type { CatalogEntry } from './catalog.js';
import { acceptsImages } from './image-input.js';
import { discoveredAgent } from '../fabric/model-pool.js';

// 调用方可见的智能体视图（路由、放置、就绪状态）与目录条目投影，从 gateway/server.ts 拆出。

export type AgentViewDeps = { store: Store; hub: NodeHub; kernel: Kernel };

export const visibleAgentsFor = ({ store, hub, kernel }: AgentViewDeps, p: Principal) =>
  store.agentDefinitions(p.owner, p.agents).map((b) => {
    b = { ...b, agent: discoveredAgent(hub, p.owner, b.agent) };
    const plans = new Map<string, ReturnType<NodeHub['availability']>>();
    const inspect = (provider: string, model: string) => {
      const key = JSON.stringify([provider, model]);
      let plan = plans.get(key);
      if (!plan) {
        plan = hub.availability(p.owner, { ...b.agent, provider, model }, [], undefined, b.digest);
        plans.set(key, plan);
      }
      return plan;
    };
    const routes = kernel.router
      .candidates(
        p.owner,
        b.digest,
        b.agent,
        (provider, model) => inspect(provider, model).available,
      )
      .map((r) => ({ ...r, placement: inspect(r.provider, r.model) }));
    const chosen = routes.find((r) => r.automatic_eligible);
    return {
      id: b.agent.id,
      description: b.agent.description,
      engine: b.agent.engine,
      tool_boundaries:
        b.agent.engine === 'kernel'
          ? ['managed', 'client', 'hybrid']
          : hub
                .inventory(p.owner)
                .some((node) =>
                  (
                    node.execution as { clientTools?: { native: string[] } } | undefined
                  )?.clientTools?.native.includes(b.agent.engine),
                )
            ? ['managed', 'hybrid']
            : ['managed'],
      ...(b.agent.modelPolicy ? { model_policy: b.agent.modelPolicy } : {}),
      ...(b.agent.access ? { access: b.agent.access } : {}),
      ...(b.agent.orchestration ? { orchestration: b.agent.orchestration } : {}),
      version: b.digest,
      skills: b.agent.skills,
      tools: b.agent.tools.map((t) => ({ name: t.name, ...t.capability })),
      ...(b.agent.workflows?.length ? { workflows: b.agent.workflows } : {}),
      ...(b.agent.delegates?.length ? { delegates: b.agent.delegates } : {}),
      ...(b.agent.approvals === 'auto' ? { approvals: 'auto' as const } : {}),
      routes,
      image_input: acceptsImages(hub, p.owner, b, routes),
      ready: chosen?.placement.ready ?? false,
      dispatchable: !!chosen,
      status:
        chosen?.placement.status ??
        (routes.some(
          (r) =>
            (r.health?.cooldownUntil ?? 0) > Date.now() || r.placement.status === 'cooling_down',
        )
          ? 'cooling_down'
          : 'unavailable'),
    };
  });
export const catalogEntries = (agents: VisibleAgent[]): CatalogEntry[] =>
  agents.map((a) => ({
    agent: a.id,
    version: a.version,
    state: {
      ...a,
      routes: a.routes.map((route) => ({
        ...route,
        placement: {
          ...route.placement,
          candidates: route.placement.candidates.map(({ wait_ms, ...candidate }) => ({
            ...candidate,
            cooling_down: wait_ms > 0,
          })),
        },
      })),
    },
  }));

/** 一个调用方可见的智能体：/v1/agents、/v1/models 与概览共用。 */
export type VisibleAgent = ReturnType<typeof visibleAgentsFor>[number];
