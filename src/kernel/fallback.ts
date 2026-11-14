import { LIMITS } from '../core/limits.js';
import type { AgentBundle } from '../core/contracts.js';
import type { NodeHub } from '../fabric/network.js';
import type { RouteTopologyHint } from './routing.js';

/** 备选智能体链：`metadata["oaa.agent_fallback"] = "agent/b,agent/c"`，最多 4 个。 */
export function agentFallbackChain(metadata: Record<string, string> | undefined): string[] {
  const raw = metadata?.['oaa.agent_fallback'];
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].slice(0, LIMITS.agentFallbacks);
}
/**
 * 按线路（provider, model）查询并缓存节点可用性（BYOK、沙箱等级、文件放置、原生轮次状态）。
 * 提交时与换用备选智能体时共用同一套判断。
 */
export function routeInspector(
  hub: NodeHub,
  owner: string,
  bundle: AgentBundle,
  files: Parameters<NodeHub['availability']>[2],
  when: {
    preferred?: string;
    byok: boolean;
    sandbox: boolean;
    providerState: boolean;
    clientTools?: boolean;
  },
) {
  const inspected = new Map<string, ReturnType<NodeHub['availability']>>();
  return (provider: string, model: string) => {
    const key = JSON.stringify([provider, model]);
    let report = inspected.get(key);
    if (!report) {
      report = hub.availability(
        owner,
        { ...bundle.agent, provider, model },
        files,
        when.preferred,
        bundle.digest,
        when.byok,
        when.sandbox,
        when.providerState,
        when.clientTools ?? false,
      );
      inspected.set(key, report);
    }
    return report;
  };
}

export function toTopologyHint(report: ReturnType<NodeHub['availability']>): RouteTopologyHint {
  const best = report.candidates.find((c) => c.available) ?? report.candidates[0];
  return {
    available: report.available,
    ready: report.ready,
    status: report.status,
    waitMs: best?.wait_ms ?? 0,
    estimatedMs: best?.estimated_ms,
    loadRatio: best ? best.active / Math.max(1, best.capacity) : 0,
  };
}
