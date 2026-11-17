import type { AccountQuota } from '../core/usage-monitor.js';

/** Only unambiguous, fresh account evidence can exclude an automatic route. */
export function accountExhausted(account: AccountQuota, now = Date.now()): boolean {
  if (
    account.status !== 'reported' ||
    account.confidence === 'estimated' ||
    account.confidence === 'unknown' ||
    account.observed_at === null ||
    now - account.observed_at > 900_000
  )
    return false;
  const exhaustedWindow = account.windows.some(
    (window) =>
      window.remaining_percent === 0 && (window.resets_at === null || window.resets_at > now),
  );
  const fresh = (time: number | null) => time !== null && now - time <= 900_000;
  const balance =
    account.balance &&
    !account.balance.stale &&
    fresh(account.balance.observed_at) &&
    account.balance.remaining === 0;
  const budget =
    account.budget &&
    !account.budget.stale &&
    fresh(account.budget.observed_at) &&
    account.budget.remaining === 0 &&
    (account.budget.resets_at === null || account.budget.resets_at > now);
  // Subscription windows and optional API credits are not the same account allowance.
  // A zero prepaid balance cannot disable a still-usable subscription route.
  return exhaustedWindow || (!account.windows.length && (!!balance || !!budget));
}

export function engineQuotaExhausted(
  engine: string,
  accounts: readonly AccountQuota[],
  now = Date.now(),
): boolean {
  const provider =
    engine === 'antigravity'
      ? 'antigravity'
      : engine === 'codex'
        ? 'codex'
        : engine === 'claude'
          ? 'claude'
          : undefined;
  if (!provider) return false;
  const matching = accounts.filter((a) => a.provider === provider);
  // A collector is not an identity binding: multiple accounts cannot safely identify the runtime.
  return matching.length === 1 && accountExhausted(matching[0]!, now);
}
