import type { AgentDefinition, Run } from '../core/contracts.js';
import type { ModelPerformance } from '../core/model-evaluation.js';
import type { ModelSourceEvidence } from '../core/model-sources.js';
import { measuredRouteScore } from './routing-performance.js';
import { Fault } from '../core/util.js';

import { detectTaskIntent, type TaskIntent } from './task-intent.js';
export {
  detectTaskIntent,
  analyzeTaskIntent,
  type TaskIntent,
  type IntentProfile,
} from './task-intent.js';
import { isRoutingModeId } from '../core/model-catalog.js';
export type RoutingStrategy = 'auto' | 'speed' | 'cost' | 'quality' | 'balanced';

export interface SemanticProfile {
  strategy: RoutingStrategy;
  intent?: TaskIntent;
}

const SEMANTIC_PROFILES: Record<string, SemanticProfile> = {
  auto: { strategy: 'auto' },
  fast: { strategy: 'speed', intent: 'fast' },
  speed: { strategy: 'speed', intent: 'fast' },
  turbo: { strategy: 'speed', intent: 'fast' },
  best: { strategy: 'quality' },
  quality: { strategy: 'quality' },
  pro: { strategy: 'quality' },
  eco: { strategy: 'cost' },
  cost: { strategy: 'cost' },
  cheap: { strategy: 'cost' },
  lite: { strategy: 'cost' },
  balanced: { strategy: 'balanced' },
  coding: { strategy: 'quality', intent: 'coding' },
  code: { strategy: 'quality', intent: 'coding' },
  reasoning: { strategy: 'quality', intent: 'reasoning' },
  deep: { strategy: 'quality', intent: 'reasoning' },
};

export function resolveSemanticProfile(selector: string): SemanticProfile | undefined {
  const clean = selector.trim().replace(/^@/, '').toLowerCase();
  return SEMANTIC_PROFILES[clean];
}

export interface InlineDirectiveResult {
  cleanedInput: string;
  model?: string;
  strategy?: RoutingStrategy;
  agent_version?: string;
}

const VALID_STRATEGIES = new Set<string>(['auto', 'speed', 'cost', 'quality', 'balanced']);

/** Narrow a metadata string to a known strategy; unknown or missing values yield undefined. */
export function asRoutingStrategy(value: string | undefined): RoutingStrategy | undefined {
  return value !== undefined && VALID_STRATEGIES.has(value)
    ? (value as RoutingStrategy)
    : undefined;
}

/**
 * Extracts optional `@oaa(...)` inline prompt directives from the start of user input
 * (or the start of the final `[user]\n` turn), enabling zero-config model/strategy control
 * inside rigid third-party chat clients.
 */
export function extractInlineDirective(input: string): InlineDirectiveResult {
  const parseDirectiveSpec = (rawSpec: string) => {
    let model: string | undefined;
    let strategy: RoutingStrategy | undefined;
    let agent_version: string | undefined;
    for (const part of rawSpec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq === -1) {
        if (VALID_STRATEGIES.has(part.toLowerCase())) {
          strategy = part.toLowerCase() as RoutingStrategy;
        } else {
          model = part;
        }
        continue;
      }
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = part.slice(eq + 1).trim();
      if (!val) continue;
      if (key === 'model' || key === 'route') model = val;
      else if (key === 'strategy' && VALID_STRATEGIES.has(val.toLowerCase())) {
        strategy = val.toLowerCase() as RoutingStrategy;
      } else if ((key === 'version' || key === 'agent_version') && /^[a-f0-9]{64}$/.test(val)) {
        agent_version = val;
      }
    }
    return { model, strategy, agent_version };
  };

  const directMatch = /^(\s*)@oaa\(([^)\r\n]{1,200})\)[ \t]*\r?\n?([\s\S]+)$/i.exec(input);
  if (directMatch && directMatch[3]!.trim().length > 0) {
    const parsed = parseDirectiveSpec(directMatch[2]!);
    return {
      cleanedInput: directMatch[3]!,
      ...parsed,
    };
  }

  const lastUserIdx = input.lastIndexOf('[user]\n');
  if (lastUserIdx !== -1) {
    const afterUser = input.slice(lastUserIdx + '[user]\n'.length);
    const userMatch = /^(\s*)@oaa\(([^)\r\n]{1,200})\)[ \t]*\r?\n?([\s\S]+)$/i.exec(afterUser);
    if (userMatch && userMatch[3]!.trim().length > 0) {
      const parsed = parseDirectiveSpec(userMatch[2]!);
      return {
        cleanedInput: input.slice(0, lastUserIdx + '[user]\n'.length) + userMatch[3]!,
        ...parsed,
      };
    }
  }

  return { cleanedInput: input };
}

export interface ModelSelectionResolution {
  agent: string;
  model: string;
  agent_version?: string;
  strategy?: RoutingStrategy;
  chain?: string[];
}

export function resolveModelSelector(
  rawModel: string,
  metadata?: Record<string, string>,
  headers?: Record<string, unknown>,
  inline?: InlineDirectiveResult,
): ModelSelectionResolution {
  let agent = rawModel.trim();
  let modelFromSpec: string | undefined;

  // 1. 解析复合语法：agent@model, agent:model, agent@modelA|modelB
  if (agent.includes('@')) {
    const atIndex = agent.indexOf('@');
    modelFromSpec = agent.slice(atIndex + 1).trim() || undefined;
    agent = agent.slice(0, atIndex).trim();
  } else if (agent.includes(':') && !agent.startsWith('http')) {
    const colonIndex = agent.indexOf(':');
    modelFromSpec = agent.slice(colonIndex + 1).trim() || undefined;
    agent = agent.slice(0, colonIndex).trim();
  }

  // 2. 检查 Header 中的覆盖项与路由策略
  const headerModel =
    (headers?.['x-oaa-model'] as string | undefined) ??
    (headers?.['x-model'] as string | undefined) ??
    (headers?.['x-target-model'] as string | undefined);

  const headerVersion =
    (headers?.['x-oaa-agent-version'] as string | undefined) ??
    (headers?.['x-agent-version'] as string | undefined);

  const rawHeaderStrategy = (
    (headers?.['x-routing-strategy'] as string | undefined) ??
    (headers?.['x-oaa-strategy'] as string | undefined)
  )?.toLowerCase();
  const headerStrategy =
    rawHeaderStrategy && VALID_STRATEGIES.has(rawHeaderStrategy)
      ? (rawHeaderStrategy as RoutingStrategy)
      : undefined;

  // 3. 确定最终 model：metadata['oaa.model'] > header > 复合语法 > @oaa(...) 内联指令 > auto
  const finalModel =
    metadata?.['oaa.model'] ?? headerModel ?? modelFromSpec ?? inline?.model ?? 'auto';
  const finalVersion = metadata?.['oaa.agent_version'] ?? headerVersion ?? inline?.agent_version;

  const semantic = resolveSemanticProfile(finalModel);
  const finalStrategy =
    (metadata?.['oaa.routing_strategy'] as RoutingStrategy | undefined) ??
    headerStrategy ??
    inline?.strategy ??
    semantic?.strategy ??
    'auto';

  const chain = finalModel.includes('|')
    ? finalModel
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return {
    agent,
    model: finalModel,
    agent_version: finalVersion,
    strategy: finalStrategy,
    chain,
  };
}

export type Health = {
  averageMs: number;
  jitterMs?: number;
  failures: number;
  consecutiveFailures?: number;
  cooldownUntil: number;
  calls: number;
  successfulCalls: number;
  halfOpenProbeInFlight?: boolean;
};

export interface RouteTopologyHint {
  available: boolean;
  ready?: boolean;
  status?: 'ready' | 'degraded' | 'busy' | 'cooling_down' | 'unavailable';
  estimatedMs?: number;
  waitMs?: number;
  loadRatio?: number;
}

export type RouteInspector = (provider: string, model: string) => boolean | RouteTopologyHint;

function normalizeHint(raw: boolean | RouteTopologyHint): RouteTopologyHint {
  return typeof raw === 'boolean' ? { available: raw } : raw;
}

export interface RoutingContext {
  strategy?: RoutingStrategy;
  intent?: TaskIntent;
  input?: string;
  metadata?: Record<string, string>;
}

export type RouteChoice = {
  id: string;
  provider: string;
  model: string;
  priority: number;
  tags?: string[];
  costTier?: number;
  speedTier?: number;
  qualityTier?: number;
  discovered?: boolean;
};

export class ModelRouter {
  private health = new Map<string, Health>();
  evidence?: (
    owner: string,
    agent: AgentDefinition,
    digest: string,
  ) => Map<string, ModelPerformance>;
  quotaBlocked?: (owner: string, agent: AgentDefinition) => boolean;
  knowledge?: (owner: string, agent: string, route: string, model: string) => ModelSourceEvidence[];
  /** Notified after route health changes so read models (e.g. /v1/overview) can invalidate. */
  observer?: (owner: string) => void;

  choices(agent: AgentDefinition): RouteChoice[] {
    return agent.routes.length
      ? agent.routes
      : [{ id: 'default', provider: agent.provider, model: agent.model, priority: 0 }];
  }

  private matchSingleToken(
    routes: RouteChoice[],
    token: string,
    owner: string,
    digest: string,
    agent: AgentDefinition,
    inspector: RouteInspector,
    context?: RoutingContext,
  ): { route: RouteChoice; mode: 'auto' | 'explicit'; hint: RouteTopologyHint } | null {
    const exact = routes.find((r) => r.id === token);
    const policyAware = !!(agent.modelPolicy || agent.access || agent.orchestration);
    const modelMatches =
      policyAware && isRoutingModeId(token.replace(/^@/, ''))
        ? []
        : routes.filter((r) => r.model === token);
    if (!exact && modelMatches.length > 1) {
      throw new Fault(
        'ambiguous_model',
        'Several routes use this model. Select an explicit route ID.',
      );
    }
    const direct = exact ?? modelMatches[0];
    if (direct) {
      return {
        route: direct,
        mode: 'explicit',
        hint: normalizeHint(inspector(direct.provider, direct.model)),
      };
    }

    const semantic = resolveSemanticProfile(token);
    if (semantic) {
      const candidates = this.candidates(owner, digest, agent, inspector, {
        ...context,
        strategy: semantic.strategy,
        intent: semantic.intent ?? context?.intent,
      }).filter((r) => r.automatic_eligible);
      if (!candidates.length) {
        throw new Fault(
          'model_unavailable',
          'No authorized healthy model route is available. Configure or enable an execution node.',
          503,
        );
      }
      const chosen = candidates[0]!;
      return {
        route: chosen,
        mode: 'auto',
        hint: { available: true },
      };
    }

    if (policyAware) return null;
    const clean = token.trim().replace(/^@/, '').toLowerCase();
    if (clean.length >= 3) {
      const tagMatches = routes.filter((r) => r.tags?.some((t) => t.toLowerCase() === clean));
      const familyMatches = tagMatches.length
        ? tagMatches
        : routes.filter(
            (r) => r.model.toLowerCase().includes(clean) || r.id.toLowerCase().includes(clean),
          );
      if (familyMatches.length > 0) {
        const ranked = this.candidates(owner, digest, agent, inspector, context).filter((c) =>
          familyMatches.some((m) => m.id === c.id),
        );
        const healthy =
          ranked.find((c) => c.automatic_eligible) ?? ranked.find((c) => c.available) ?? ranked[0]!;
        return {
          route: healthy,
          mode: 'explicit',
          hint: { available: healthy.available },
        };
      }
    }

    return null;
  }

  select(
    owner: string,
    digest: string,
    agent: AgentDefinition,
    selection: string,
    available: RouteInspector,
    previous?: Run,
    context?: RoutingContext,
  ): Run['route'] {
    const routes = this.choices(agent);
    if (previous) {
      if (
        selection !== 'auto' &&
        selection !== previous.route.id &&
        selection !== previous.route.model
      )
        throw new Fault(
          'model_switch_requires_new_session',
          'A continuing session keeps its model route. Start a new session to switch models.',
          409,
        );
      return previous.route;
    }

    if (selection.includes('|')) {
      const segments = selection
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      let anyRecognized = false;
      for (const seg of segments) {
        try {
          const matched = this.matchSingleToken(
            routes,
            seg,
            owner,
            digest,
            agent,
            available,
            context,
          );
          if (!matched) continue;
          anyRecognized = true;
          const h = this.health.get(`${owner}:${digest}:${matched.route.id}`);
          const cooling = (h?.cooldownUntil ?? 0) > Date.now();
          if (matched.hint.available && !cooling) {
            return {
              id: matched.route.id,
              provider: matched.route.provider,
              model: matched.route.model,
              mode: 'auto',
            };
          }
        } catch (e) {
          if (e instanceof Fault && e.code === 'model_unavailable') {
            anyRecognized = true;
            continue;
          }
          throw e;
        }
      }
      if (!anyRecognized) {
        throw new Fault(
          'model_not_supported',
          "The selected model is not in this agent's published route pool.",
        );
      }
      throw new Fault(
        'model_unavailable',
        'No authorized healthy model route in the requested fallback chain is available.',
        503,
      );
    }

    if (selection !== 'auto') {
      const matched = this.matchSingleToken(
        routes,
        selection,
        owner,
        digest,
        agent,
        available,
        context,
      );
      if (!matched)
        throw new Fault(
          'model_not_supported',
          "The selected model is not in this agent's published route pool.",
        );
      if (!matched.hint.available)
        throw new Fault(
          'model_unavailable',
          'No authorized worker provides the selected route.',
          503,
        );
      return {
        id: matched.route.id,
        provider: matched.route.provider,
        model: matched.route.model,
        mode: matched.mode,
      };
    }

    const candidates = this.candidates(owner, digest, agent, available, context).filter(
      (r) => r.automatic_eligible,
    );
    if (!candidates.length)
      throw new Fault(
        'model_unavailable',
        'No authorized healthy model route is available. Configure or enable an execution node.',
        503,
      );
    const chosen = candidates[0]!;
    return { id: chosen.id, provider: chosen.provider, model: chosen.model, mode: 'auto' };
  }

  candidates(
    owner: string,
    digest: string,
    agent: AgentDefinition,
    available: RouteInspector,
    context?: RoutingContext,
  ) {
    const now = Date.now();
    const strategy =
      context?.strategy ??
      (context?.metadata?.['oaa.routing_strategy'] as RoutingStrategy | undefined) ??
      'auto';
    const intent =
      context?.intent ??
      (context?.input ? detectTaskIntent(context.input, agent.tools.length) : 'general');
    const evidence = this.evidence?.(owner, agent, digest);
    const quotaBlocked = this.quotaBlocked?.(owner, agent) === true;

    const rawList = this.choices(agent).map((r) => {
      const health = this.health.get(`${owner}:${digest}:${r.id}`);
      const performance = evidence?.get(r.id);
      const hint = normalizeHint(available(r.provider, r.model));
      const usable = hint.available;
      const cooldownExpired = (health?.cooldownUntil ?? 0) <= now;
      const isHalfOpen =
        usable &&
        cooldownExpired &&
        (health?.consecutiveFailures ?? 0) > 0 &&
        (health?.cooldownUntil ?? 0) > 0;
      const probeBlocked = isHalfOpen && health?.halfOpenProbeInFlight === true;
      const autoEligible = usable && cooldownExpired && !probeBlocked && !quotaBlocked;

      const avgMs = health?.averageMs ?? hint.estimatedMs ?? 1000;
      const jitterPenalty = Math.round((health?.jitterMs ?? 0) * 0.5);
      const topologyPenalty =
        (hint.waitMs ?? 0) * 2 +
        Math.round((hint.loadRatio ?? 0) * 1500) +
        (hint.status === 'degraded' ? 2500 : 0) +
        (hint.status === 'busy' ? 5000 : 0) +
        (isHalfOpen ? 3500 : 0);

      let score =
        r.priority * 10_000 +
        avgMs +
        jitterPenalty +
        (health?.failures ?? 0) * 2000 +
        topologyPenalty;

      // 联合模型-节点-意图帕累托加权调优 (Joint Model-Node-Intent Co-Scheduling)
      if (strategy === 'speed' || intent === 'fast') {
        const speedBonus = r.speedTier !== undefined ? (5 - r.speedTier) * 1500 : 0;
        const speedEstMs =
          health?.averageMs ??
          (r.speedTier !== undefined ? (6 - r.speedTier) * 150 : (hint.estimatedMs ?? 500));
        score =
          speedEstMs * 5 +
          jitterPenalty * 2 +
          (health?.failures ?? 0) * 10_000 +
          r.priority * 100 +
          speedBonus +
          topologyPenalty;
      } else if (strategy === 'cost') {
        const tierPenalty = ((r.costTier ?? 3) - 1) * 15_000;
        score = tierPenalty + r.priority * 1000 + avgMs + topologyPenalty;
      } else if (strategy === 'quality' || intent === 'coding' || intent === 'reasoning') {
        const tagBonus =
          intent !== 'general' && r.tags?.some((t) => t.toLowerCase() === intent) ? -2500 : 0;
        score =
          (5 - (r.qualityTier ?? 3)) * 15_000 +
          r.priority * 1000 +
          avgMs +
          tagBonus +
          topologyPenalty;
      } else if (strategy === 'balanced') {
        score =
          r.priority * 5_000 +
          avgMs * 2 +
          jitterPenalty +
          (health?.failures ?? 0) * 3000 +
          topologyPenalty;
      }

      score =
        measuredRouteScore(
          {
            performance,
            strategy,
            intent,
            topologyPenalty,
            priority: r.priority,
            costTier: r.costTier,
            now,
          },
          health?.successfulCalls ? health.averageMs : undefined,
        ) ?? score;

      return {
        ...r,
        available: usable,
        automatic_eligible: autoEligible,
        half_open: isHalfOpen,
        quota_blocked: quotaBlocked,
        score,
        health: health ? { ...health } : null,
        performance: performance ?? null,
        latency_evidence: health?.successfulCalls ? 'observed_execution' : 'default_estimate',
      };
    });

    // 若全部可用路由均因单飞半开探测阻塞而无候选，放开最高优半开节点避免假死
    if (!rawList.some((r) => r.automatic_eligible)) {
      for (const r of rawList) {
        if (r.available && !r.quota_blocked && (r.health?.cooldownUntil ?? 0) <= now) {
          r.automatic_eligible = true;
        }
      }
    }

    return rawList.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  }

  cascade(
    owner: string,
    digest: string,
    agent: AgentDefinition,
    available: RouteInspector,
    context?: RoutingContext,
    excludeIds?: ReadonlySet<string>,
  ) {
    const chainRaw = context?.metadata?.['oaa.model_chain'];
    const allEligible = this.candidates(owner, digest, agent, available, context).filter(
      (r) => r.automatic_eligible && (!excludeIds || !excludeIds.has(r.id)),
    );
    if (!chainRaw) return allEligible;

    const ordered: typeof allEligible = [];
    const seen = new Set<string>();
    for (const seg of chainRaw
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const clean = seg.replace(/^@/, '').toLowerCase();
      const found = allEligible.find(
        (r) =>
          r.id === seg ||
          r.model === seg ||
          r.tags?.some((t) => t.toLowerCase() === clean) ||
          (clean.length >= 3 &&
            (r.model.toLowerCase().includes(clean) || r.id.toLowerCase().includes(clean))),
      );
      if (found && !seen.has(found.id)) {
        seen.add(found.id);
        ordered.push(found);
      }
    }
    for (const r of allEligible) {
      if (!seen.has(r.id)) ordered.push(r);
    }
    return ordered;
  }

  beginProbe(owner: string, digest: string, routeId: string): boolean {
    const h = this.health.get(`${owner}:${digest}:${routeId}`);
    if (!h || (h.consecutiveFailures ?? 0) === 0 || h.cooldownUntil === 0) return false;
    if (h.cooldownUntil <= Date.now()) {
      h.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  record(run: Run, durationMs: number, error?: string): void {
    if (
      error &&
      !['upstream_rate_limited', 'upstream_failed', 'upstream_truncated'].includes(error)
    )
      return;
    const key = `${run.owner}:${run.digest}:${run.route.id}`;
    const h = this.health.get(key) ?? {
      averageMs: error ? 1000 : durationMs,
      jitterMs: 0,
      failures: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      calls: 0,
      successfulCalls: 0,
      halfOpenProbeInFlight: false,
    };
    h.calls++;
    h.halfOpenProbeInFlight = false;
    if (!error) {
      const prevAvg = h.averageMs;
      h.averageMs = h.successfulCalls ? h.averageMs * 0.8 + durationMs * 0.2 : durationMs;
      const deviation = Math.abs(durationMs - prevAvg);
      h.jitterMs = h.successfulCalls ? (h.jitterMs ?? 0) * 0.8 + deviation * 0.2 : 0;
      h.successfulCalls++;
    }
    if (
      error &&
      ['upstream_rate_limited', 'upstream_failed', 'upstream_truncated'].includes(error)
    ) {
      h.failures++;
      h.consecutiveFailures = (h.consecutiveFailures ?? 0) + 1;
      const backoffMs = Math.min(120_000, 30_000 * 2 ** Math.max(0, h.consecutiveFailures - 1));
      h.cooldownUntil = Date.now() + backoffMs;
    } else if (!error) {
      h.failures = Math.max(0, h.failures - 1);
      h.consecutiveFailures = 0;
      if (h.cooldownUntil <= Date.now()) h.cooldownUntil = 0;
    }
    this.health.set(key, h);
    try {
      this.observer?.(run.owner);
    } catch {
      // Observer failures must not affect routing health.
    }
  }

  stats(owner: string, digest: string, id: string): Health | undefined {
    return this.health.get(`${owner}:${digest}:${id}`);
  }
}
