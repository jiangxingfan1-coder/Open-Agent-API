/**
 * 开发者平台：上架项能不能被账号密钥调用，以及按用量定价是否成立。
 *
 * 账号密钥的执行级别只有 `workspace` / `sandbox`；外部智能体与带本机工具的智能体需要 `host`。
 * 所有者对某个上架项显式打开 `hostExecution` 后，账号密钥只对那一个智能体放开 `host`
 * （Principal.hostAgents）；它委托到的智能体要各自上架并各自打开，否则同样被拒绝。
 * 这里只做判断与提示，真正的拒绝在内核的 checkExecution（`isolation_required`）。
 */
import type { WorkerConfig } from '../config/config.js';
import {
  executionPermits,
  requiredExecution,
  sandboxable,
  type AgentDefinition,
} from '../core/contracts.js';
import { LIMITS } from '../core/limits.js';
import { Fault } from '../core/util.js';
import { conversionProfile } from '../engines/conformance.js';
import type { Store } from '../store/store.js';

export type ListingAccess = {
  /** The listed agent itself needs more than the account keys' execution level. */
  requiresHost: boolean;
  /** Agents (the listed one or its delegates) that account keys would be refused right now. */
  blockedBy: string[];
  /** The agent's engine always reports token usage, so a per-token price can be charged. */
  usageReported: boolean;
  /** External agent whose permission requests are approved automatically (`approvals: auto`). */
  autoApprovals: boolean;
};

/** Whether an account key at `level` may run `def` without an explicit host opt-in. */
export function fitsLevel(def: AgentDefinition, level: 'workspace' | 'sandbox'): boolean {
  const required = requiredExecution(def);
  return executionPermits(level, required) || (level === 'sandbox' && sandboxable(def));
}

/**
 * Access of one listing. `hostIds` are the agents opted into host execution, the listing itself
 * included when its switch is on. Delegates are walked like the kernel's checkExecution does.
 */
export function listingAccess(
  store: Store,
  owner: string,
  agentId: string,
  level: 'workspace' | 'sandbox',
  hostIds: readonly string[],
  worker?: WorkerConfig,
): ListingAccess {
  let root: AgentDefinition;
  try {
    root = store.bundle(owner, agentId).agent;
  } catch {
    return { requiresHost: false, blockedBy: [], usageReported: true, autoApprovals: false };
  }
  const blockedBy: string[] = [];
  const seen = new Set<string>();
  const visit = (def: AgentDefinition, depth: number): void => {
    if (seen.has(def.id) || depth > LIMITS.delegationCheckDepth) return;
    seen.add(def.id);
    if (!fitsLevel(def, level) && !hostIds.includes(def.id)) blockedBy.push(def.id);
    for (const d of def.delegates ?? []) {
      try {
        visit(store.bundle(owner, d.agent).agent, depth + 1);
      } catch {
        // An unpublished delegate fails at run time with its own error.
      }
    }
  };
  visit(root, 0);
  return {
    requiresHost: !fitsLevel(root, level),
    blockedBy,
    usageReported: conversionProfile(root.engine, worker).usage === 'reported',
    autoApprovals: root.engine !== 'kernel' && root.approvals === 'auto',
  };
}

/**
 * A per-token price needs reported usage: an agent that does not always report tokens would run
 * for free on a per-token-only price (or be charged a guess). Such agents take per-run prices.
 */
export function assertUsagePricing(access: ListingAccess, per1kTokens: number): void {
  if (per1kTokens > 0 && !access.usageReported)
    throw new Fault(
      'usage_pricing_unsupported',
      'This agent does not report token usage; price it per run (price.per_1k_tokens must be 0).',
      400,
    );
}

/** The `isolation_required` message for an account key and a listing without the switch. */
export function hostRefusal(agentId: string): string {
  return `Agent '${agentId}' runs with host authority; the owner has not allowed platform accounts to run it on this machine.`;
}
