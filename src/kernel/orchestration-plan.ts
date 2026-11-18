import {
  executionPermits,
  requiredExecution,
  sandboxable,
  type AgentBundle,
  type AgentDefinition,
  type Run,
} from '../core/contracts.js';
import {
  orchestrationPlanSchema,
  type OrchestrationMode,
  type OrchestrationStage,
  type OrchestrationState,
} from '../core/orchestration.js';
import { Fault } from '../core/util.js';
import {
  discoveredAgent,
  resolveOrchestrationPlanner,
  supportsReasoning,
  type ResolvedOrchestrationPlanner,
} from '../fabric/model-pool.js';
import { permits } from '../fabric/network.js';
import type { KernelRuntime } from './runtime.js';

export type PlanValidationOptions = {
  plannerAgent?: string;
  reasoningAgents?: ReadonlySet<string>;
};

/** The plan may choose work, but it cannot create new agent, model, or tool grants. */
export function validateOrchestrationPlan(
  value: unknown,
  agent: AgentDefinition,
  pools: Map<string, string[]>,
  maxStages: number,
  options?: PlanValidationOptions,
): OrchestrationStage[] {
  const plan = orchestrationPlanSchema.parse(value).stages;
  const ids = new Set<string>();
  const allowHelpers = agent.orchestration?.scope === 'helpers';
  let phase: 'analyze' | 'execute' | 'review' = 'analyze';
  let hasExecute = false;
  for (const stage of plan) {
    const allowedAgent = allowHelpers
      ? pools.has(stage.agent)
      : stage.role === 'execute'
        ? stage.agent === agent.id
        : stage.agent === agent.id || stage.agent === options?.plannerAgent;
    const needsReasoning = stage.role === 'analyze' || stage.role === 'review';
    if (
      stage.id === 'plan' ||
      /^(fix_|check_)/.test(stage.id) ||
      ids.has(stage.id) ||
      !allowedAgent ||
      !pools.get(stage.agent)?.includes(stage.model) ||
      (needsReasoning && options?.reasoningAgents && !options.reasoningAgents.has(stage.agent))
    )
      throw new Fault(
        'output_contract',
        'The orchestration plan contains an unauthorized model, agent or duplicate stage.',
        422,
      );
    ids.add(stage.id);
    if (stage.role === 'execute') {
      if (phase === 'review' || (!allowHelpers && hasExecute))
        throw new Fault(
          'output_contract',
          allowHelpers
            ? 'Analysis must precede execution, and review must follow it.'
            : 'Exactly one execution stage must belong to the published primary agent.',
          422,
        );
      phase = 'execute';
      hasExecute = true;
    } else if (stage.role === 'analyze') {
      if (phase !== 'analyze')
        throw new Fault(
          'output_contract',
          'Analysis must precede execution, and review must follow it.',
          422,
        );
    } else {
      if (!hasExecute)
        throw new Fault(
          'output_contract',
          'Analysis must precede execution, and review must follow it.',
          422,
        );
      phase = 'review';
    }
  }
  if (!hasExecute || plan.length + 1 > maxStages)
    throw new Fault(
      'output_contract',
      'The orchestration plan exceeds its stage budget or has no execution stage.',
      422,
    );
  return plan;
}

export function formatStageContext(results: OrchestrationState['results']): string {
  return Object.entries(results)
    .filter(([id]) => id !== 'plan')
    .map(([id, r]) => {
      const tag = r.agent ? `[${id} (${r.agent})]` : `[${id}]`;
      const artifacts = r.artifacts?.length
        ? `\nArtifacts: ${r.artifacts
            .map((a) => `${a.name} (id=${a.id}${a.sha256 ? `, sha256=${a.sha256}` : ''})`)
            .join(', ')}`
        : '';
      return `${tag} ${r.output.slice(0, 16_000)}${artifacts}`;
    })
    .join('\n\n');
}

export function collectOrchestrationTopology(
  rt: KernelRuntime,
  run: Run,
  bundle: AgentBundle,
  mode: OrchestrationMode,
  primaryRoutes: string[],
): {
  primaryReasoning: boolean;
  planner: ResolvedOrchestrationPlanner | undefined;
  plannerRouteId: string;
  pools: Map<string, string[]>;
  reasoningAgents: Set<string>;
} {
  const settings = bundle.agent.orchestration!;
  const primaryReasoning = supportsReasoning(rt.hub, run.owner, bundle.agent);
  const planner = resolveOrchestrationPlanner(rt.store, rt.hub, run.owner, bundle.agent, {
    grantedAgents: run.checkpoint.grantedAgents ?? [],
    externalCaller: run.checkpoint.externalCaller,
    toolBoundary: run.metadata['oaa.tool_boundary'],
    execution: run.checkpoint.execution,
    hostAgents: run.checkpoint.hostAgents,
  });

  const pools = new Map<string, string[]>([[run.agentId, [...primaryRoutes]]]);
  const reasoningAgents = new Set<string>(primaryReasoning ? [run.agentId] : []);
  let plannerRouteId = run.route.id;
  if (planner) {
    reasoningAgents.add(planner.agent.id);
    const existing = pools.get(planner.agent.id) ?? [];
    pools.set(planner.agent.id, [...new Set([...existing, ...planner.routes])]);
    if (settings.planner?.route) {
      plannerRouteId = planner.routeId;
    } else {
      const best = rt.router
        .candidates(run.owner, planner.digest, planner.agent, () => true, {
          input: run.input,
          strategy: mode,
        })
        .find((c) => c.automatic_eligible && planner.routes.includes(c.id));
      plannerRouteId = best?.id ?? planner.routeId;
    }
  }
  for (const helper of settings.scope === 'helpers' ? settings.helpers : []) {
    if (!permits(run.checkpoint.grantedAgents ?? [], helper)) continue;
    let child: AgentDefinition;
    try {
      child = discoveredAgent(rt.hub, run.owner, rt.store.bundle(run.owner, helper).agent);
    } catch {
      continue;
    }
    if (
      (run.checkpoint.externalCaller && child.access?.trust === 'private') ||
      (run.metadata['oaa.tool_boundary'] === 'client' && child.engine !== 'kernel')
    )
      continue;
    if (run.checkpoint.execution && run.checkpoint.execution !== 'host') {
      const required = requiredExecution(child);
      const fits =
        executionPermits(run.checkpoint.execution, required) ||
        (run.checkpoint.execution === 'sandbox' && sandboxable(child)) ||
        !!run.checkpoint.hostAgents?.includes(child.id);
      if (!fits) continue;
    }
    const choices = rt.router.choices(child).map((r) => r.id);
    const existing = pools.get(helper) ?? [];
    pools.set(helper, [...new Set([...existing, ...choices])]);
    if (supportsReasoning(rt.hub, run.owner, child)) reasoningAgents.add(helper);
  }
  return { primaryReasoning, planner, plannerRouteId, pools, reasoningAgents };
}

export function normalizePlannerOutput(
  parsed: unknown,
  primaryAgentId: string,
  primaryReasoning: boolean,
  planner: ResolvedOrchestrationPlanner | undefined,
  plannerRouteId: string,
): unknown {
  if (
    primaryReasoning ||
    !planner ||
    !parsed ||
    typeof parsed !== 'object' ||
    !('stages' in parsed)
  )
    return parsed;
  const rawStages = (parsed as { stages?: unknown }).stages;
  if (!Array.isArray(rawStages)) return parsed;
  return {
    ...(parsed as Record<string, unknown>),
    stages: rawStages.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const s = item as Record<string, unknown>;
      if ((s.role === 'analyze' || s.role === 'review') && s.agent === primaryAgentId) {
        return {
          ...s,
          agent: planner.agent.id,
          model:
            typeof s.model === 'string' && planner.routes.includes(s.model)
              ? s.model
              : plannerRouteId,
        };
      }
      return item;
    }),
  };
}
