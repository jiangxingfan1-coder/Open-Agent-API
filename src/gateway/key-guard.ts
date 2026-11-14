import type { KeyQuota, Principal } from '../core/contracts.js';
import { isOwnerWide } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { permits } from '../fabric/network.js';

/**
 * Key management by an admin key that is limited to some agents: it may only change keys whose
 * every agent it could grant itself, and never its own key (otherwise it could lift its own quota
 * or revoke the owner's wider keys). Owner-wide admin keys are not limited. Unknown IDs pass
 * through so the caller still gets the usual `key_not_found`.
 */
export function assertMayManageKey(
  p: Principal,
  keyId: string,
  keys: readonly Record<string, unknown>[],
): void {
  if (isOwnerWide(p)) return;
  const target = keys.find((k) => k.id === keyId);
  if (!target) return;
  const agents = Array.isArray(target.agents) ? target.agents.map(String) : ['*'];
  if (keyId === p.keyId || agents.some((a) => !permits(p.agents, a)))
    throw new Fault(
      'scope_denied',
      'An agent-limited admin key can only manage keys within its own agents, not itself.',
      403,
    );
}

const QUOTA_LIMITS = [
  'rpm',
  'maxConcurrentRuns',
  'maxTotalTokens',
  'maxRuns',
  'expiresAt',
] as const;

/**
 * An agent-limited admin key with a quota may only give out keys whose every quota limit is set
 * and no looser than its own; otherwise it could mint a key without its own limits. Owner-wide
 * admin keys, and limited admin keys without a quota, are not affected.
 */
export function assertQuotaWithin(p: Principal, quota: KeyQuota | null | undefined): void {
  if (isOwnerWide(p) || !p.quota) return;
  const own = p.quota;
  const loose = QUOTA_LIMITS.filter((k) => {
    const mine = own[k];
    if (mine === undefined) return false;
    const theirs = quota?.[k];
    return theirs === undefined || theirs > mine;
  });
  if (loose.length)
    throw new Fault(
      'quota_exceeds_own',
      `A key you create or change must set ${loose.join(', ')} no higher than your own key's quota.`,
      403,
    );
}
