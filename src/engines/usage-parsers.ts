import { Fault, sha } from '../core/util.js';
import type { AccountQuota, CollectedUsage, QuotaWindow, TokenDay } from '../core/usage-monitor.js';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown, max = 100): string | null =>
  typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
const provider = (v: unknown): string | null => {
  const s = text(v, 80);
  return s && /^[a-z][a-z0-9-]*$/.test(s) ? s : null;
};
const timestamp = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const invalid = () => new Fault('invalid_request', 'Unsupported or invalid usage snapshot.', 400);

/** CodexBar usage JSON and its opt-in CLIUsageCache; never retain credentials or raw diagnostics. */
export function parseCodexBar(value: unknown, now = Date.now()): CollectedUsage {
  const root = object(value);
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(root.entries)
      ? root.entries
      : root.provider
        ? [root]
        : null;
  if (!entries || entries.length > 512) throw invalid();
  const accounts: AccountQuota[] = [];
  const ids = new Set<string>();
  for (const raw of entries) {
    const entry = object(raw),
      name = provider(entry.provider);
    if (!name) throw invalid();
    const usage = object(entry.usage),
      identity = object(usage.identity);
    const rawSource = typeof entry.source === 'string' ? entry.source.toLowerCase() : '';
    const offline = rawSource.includes('offline');
    const confidence =
      usage.dataConfidence === 'estimated'
        ? 'estimated'
        : usage.dataConfidence === 'exact'
          ? 'exact'
          : usage.dataConfidence === 'percentOnly'
            ? 'percent_only'
            : 'unknown';
    const email = text(identity.accountEmail ?? usage.accountEmail);
    const account =
      email && /^[^@\s]+@[^@\s]+$/.test(email)
        ? email.replace(/^([^@]{0,2})[^@]*@/, '$1***@')
        : null;
    const identityKey = text(entry.account) ?? email ?? text(identity.accountID) ?? 'default';
    const id = sha(`${name}\n${identityKey}`).slice(0, 24);
    if (ids.has(id)) throw invalid();
    ids.add(id);
    const observed = timestamp(
      usage.updatedAt ?? object(entry.credits).updatedAt ?? object(usage.providerCost).updatedAt,
    );
    const observedAt = observed !== null && observed <= now + 60_000 ? observed : null;
    const labels = object(entry.rateWindowLabels);
    const windows: QuotaWindow[] = [];
    const add = (id: string, label: unknown, raw: unknown, known = true) => {
      const row = object(raw),
        used = known ? number(row.usedPercent) : null;
      if (
        !Object.keys(row).length ||
        (used !== null && used > 10_000) ||
        row.isSynthetic === true ||
        row.isPlaceholder === true ||
        row.isSyntheticPlaceholder === true
      )
        return;
      windows.push({
        id,
        label: text(label ?? row.title, 100) ?? id,
        used_percent: used,
        remaining_percent: used === null ? null : Math.max(0, 100 - used),
        resets_at: timestamp(row.resetsAt),
        window_minutes: number(row.windowMinutes),
        limit: number(row.quotaLimit),
        unit: text(row.quotaUnit, 30),
      });
    };
    for (const key of ['primary', 'secondary', 'tertiary']) add(key, labels[key], usage[key]);
    if (Array.isArray(usage.extraRateWindows)) {
      if (usage.extraRateWindows.length > 128) throw invalid();
      for (const [index, raw] of usage.extraRateWindows.entries()) {
        const row = object(raw);
        add(`extra-${index}`, row.label ?? row.title, row.window ?? row, row.usageKnown !== false);
      }
    }
    const credits = object(entry.credits),
      cost = object(usage.providerCost);
    const creditBalance = cost.balanceIsUnavailable === true ? null : number(credits.remaining),
      cashBalance = cost.balanceIsUnavailable === true ? null : number(cost.balance);
    const currencyText = text(cost.currencyCode, 30);
    const currency =
      currencyText && /^[A-Za-z][A-Za-z0-9_-]*$/.test(currencyText) ? currencyText : null;
    const age = (value: unknown) => {
      const stamp = timestamp(value);
      return stamp !== null && stamp <= now + 60_000 ? stamp : null;
    };
    const expired = (stamp: number | null) => stamp === null || now - stamp > 900_000;
    const balanceTime = age(
      cashBalance !== null ? (cost.balanceUpdatedAt ?? cost.updatedAt) : credits.updatedAt,
    );
    const balance =
      cashBalance !== null && currency
        ? {
            remaining: cashBalance,
            unit: currency,
            observed_at: balanceTime,
            stale: expired(balanceTime),
            shared: cost.balanceIsWorkspace === true,
          }
        : creditBalance !== null
          ? {
              remaining: creditBalance,
              unit: 'credits',
              observed_at: balanceTime,
              stale: expired(balanceTime),
              shared: false,
            }
          : null;
    const spent = number(cost.used),
      limit = number(cost.limit),
      budgetTime = age(cost.updatedAt),
      budgetReset = timestamp(cost.resetsAt);
    const budget =
      spent !== null && limit !== null && limit > 0 && currency
        ? {
            used: spent,
            limit,
            remaining: Math.max(0, limit - spent),
            unit: currency,
            period: text(cost.period, 80),
            observed_at: budgetTime,
            resets_at: budgetReset,
            stale: expired(budgetTime) || (budgetReset !== null && budgetReset <= now),
            shared: number(cost.personalUsed) !== null,
            personal_used: number(cost.personalUsed),
          }
        : null;
    const stale =
      observedAt === null ||
      now - observedAt > 900_000 ||
      windows.some((w) => w.resets_at !== null && w.resets_at <= now);
    accounts.push({
      id,
      provider: name,
      account,
      source: offline
        ? 'offline'
        : rawSource.includes('oauth')
          ? 'oauth'
          : rawSource.includes('cli')
            ? 'cli'
            : rawSource.includes('api')
              ? 'api'
              : rawSource.includes('web')
                ? 'web'
                : rawSource.includes('local')
                  ? 'local'
                  : Array.isArray(root.entries)
                    ? 'codexbar-cache'
                    : 'codexbar',
      confidence,
      observed_at: observedAt,
      status:
        offline ||
        entry.error ||
        (!windows.some((w) => w.used_percent !== null) && !balance && !budget)
          ? 'unavailable'
          : stale
            ? 'stale'
            : 'reported',
      windows: offline ? [] : windows,
      balance: offline ? null : balance,
      budget: offline ? null : budget,
    });
  }
  return { collector: 'codexbar', collected_at: now, accounts, daily: [] };
}

/** Unified ccusage daily --by-agent JSON. Parent totals and model breakdowns are not added twice. */
export function parseCcusage(value: unknown, now = Date.now()): CollectedUsage {
  const root = object(value);
  if (!Array.isArray(root.daily) || root.daily.length > 366) throw invalid();
  const daily: TokenDay[] = [],
    seen = new Set<string>();
  for (const raw of root.daily) {
    const day = object(raw),
      date = text(day.period ?? day.date, 10);
    const stamp = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (
      !date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(stamp) ||
      new Date(stamp).toISOString().slice(0, 10) !== date
    )
      throw invalid();
    const rows = Array.isArray(day.agents) ? day.agents : [day];
    if (rows.length > 128) throw invalid();
    for (const raw of rows) {
      const row = object(raw),
        agent = provider(row.agent) ?? (row.date ? 'claude' : 'all');
      const key = `${date}/${agent}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
      const field = (key: string) => {
        const n = number(row[key]);
        return n !== null && Number.isSafeInteger(n) ? n : null;
      };
      daily.push({
        date,
        agent,
        input: field('inputTokens'),
        output: field('outputTokens'),
        cache_read: field('cacheReadTokens'),
        cache_write: field('cacheCreationTokens'),
        total: field('totalTokens'),
      });
    }
  }
  return { collector: 'ccusage', collected_at: now, accounts: [], daily };
}
