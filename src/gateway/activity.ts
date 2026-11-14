/**
 * Activity pulse for the console: run counts per UTC-aligned bucket, totals, end-to-end latency,
 * per-agent counts and an aggregated time breakdown of recent finished runs. Derived only from
 * run summaries and (for the breakdown) run timelines; nothing here executes work.
 */
import type { Principal, RunStatus } from '../core/contracts.js';
import { terminal, visibleSubject } from '../core/contracts.js';
import type { Store, SummaryRow } from '../store/store.js';
import { buildTimeline, type Breakdown, type Timeline } from './timeline.js';

export type ActivityWindow = '24h' | '7d';
const frames: Record<ActivityWindow, { bucketMs: number; buckets: number }> = {
  '24h': { bucketMs: 3_600_000, buckets: 24 },
  '7d': { bucketMs: 21_600_000, buckets: 28 },
};
/** Finished runs whose timelines are aggregated into breakdown_ms. */
export const ACTIVITY_BREAKDOWN_RUNS = 100;
export const ACTIVITY_TOP_AGENTS = 8;

/** Buckets are aligned to UTC multiples of the bucket size; the last one is the current bucket. */
export function activityFrame(window: ActivityWindow, now: number) {
  const { bucketMs, buckets } = frames[window];
  const current = Math.floor(now / bucketMs) * bucketMs;
  return { bucketMs, buckets, start: current - (buckets - 1) * bucketMs };
}

type Counts = {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  active: number;
};
const zero = (): Counts => ({
  started: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  active: 0,
});
/** `incomplete` (deadline, turn or token limits) counts as failed; cancellation is not failure. */
function count(counts: Counts, status: RunStatus): void {
  counts.started++;
  if (status === 'completed') counts.completed++;
  else if (status === 'failed' || status === 'incomplete') counts.failed++;
  else if (status === 'cancelled') counts.cancelled++;
  else if (status === 'interrupted') counts.interrupted++;
  else counts.active++;
}
const percentile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]! : null;

/** Bounded cache of finished-run timelines; a finished run's timeline does not change. */
export class TimelineCache {
  private readonly entries = new Map<string, { version: string; timeline: Timeline }>();
  constructor(private readonly limit = 1024) {}
  get(store: Store, owner: string, runId: string, version: string): Timeline {
    const hit = this.entries.get(runId);
    if (hit && hit.version === version) {
      this.entries.delete(runId);
      this.entries.set(runId, hit);
      return hit.timeline;
    }
    const timeline = buildTimeline({ ...store.timelineSource(runId, owner), now: Date.now() });
    this.entries.delete(runId);
    this.entries.set(runId, { version, timeline });
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return timeline;
  }
}

/**
 * Statuses that never change again. `interrupted` is terminal for counting but can be resumed,
 * so it is re-read like an active run. Run summaries are never deleted.
 */
const FINAL = new Set<RunStatus>(['completed', 'failed', 'cancelled', 'incomplete']);
/** Above this many rows a view is not kept in memory; it falls back to a full scan. */
const WINDOW_ROW_LIMIT = 100_000;

/**
 * Incremental source for the activity pulse. A full scan parses two JSON fields per run in the
 * window (about 10 ms for 10,000 runs). Finished runs never change, so each view keeps the rows it
 * has read and later reads only runs inserted since (by ordinal) plus the few still-changing ones.
 */
export class SummaryWindow {
  private readonly views = new Map<
    string,
    { since: number; maxOrdinal: number; rows: Map<string, SummaryRow> }
  >();
  constructor(private readonly limit = 32) {}
  rows(store: Store, principal: Principal, key: string, since: number): SummaryRow[] {
    const { owner, agents } = principal;
    const subject = visibleSubject(principal);
    let view = this.views.get(key);
    this.views.delete(key);
    if (!view || since < view.since) {
      const all = store.summariesSince(owner, agents, since, 0, subject);
      view = {
        since,
        maxOrdinal: all.reduce((max, row) => Math.max(max, row.ordinal), 0),
        rows: new Map(all.map((row) => [row.id, row])),
      };
    } else {
      for (const row of store.summariesSince(owner, agents, since, view.maxOrdinal, subject)) {
        view.rows.set(row.id, row);
        view.maxOrdinal = Math.max(view.maxOrdinal, row.ordinal);
      }
      const open = [...view.rows.values()].filter((row) => !FINAL.has(row.status));
      for (const row of store.summariesById(
        owner,
        open.map((row) => row.id),
      ))
        view.rows.set(row.id, row);
      if (since > view.since) {
        for (const [id, row] of view.rows) if (row.created < since) view.rows.delete(id);
        view.since = since;
      }
    }
    const rows = [...view.rows.values()].sort((a, b) => b.ordinal - a.ordinal);
    if (rows.length <= WINDOW_ROW_LIMIT) {
      this.views.set(key, view);
      if (this.views.size > this.limit) this.views.delete(this.views.keys().next().value!);
    }
    return rows;
  }
}

export function computeActivity(
  store: Store,
  principal: Principal,
  window: ActivityWindow,
  now: number,
  timelines: TimelineCache,
  source?: { cache: SummaryWindow; key: string },
) {
  const frame = activityFrame(window, now);
  const buckets = Array.from({ length: frame.buckets }, zero);
  const totals = zero();
  const latencies: number[] = [];
  const recent: { id: string; version: string }[] = [];
  const agents = new Map<
    string,
    { runs: number; completed: number; failed: number; durations: number[] }
  >();
  const rows = source
    ? source.cache.rows(store, principal, `${source.key}\n${window}`, frame.start)
    : store.summariesSince(
        principal.owner,
        principal.agents,
        frame.start,
        0,
        visibleSubject(principal),
      );
  for (const row of rows) {
    const index = Math.min(
      frame.buckets - 1,
      Math.max(0, Math.floor((row.created - frame.start) / frame.bucketMs)),
    );
    count(buckets[index]!, row.status);
    count(totals, row.status);
    const agent = agents.get(row.agent) ?? { runs: 0, completed: 0, failed: 0, durations: [] };
    agents.set(row.agent, agent);
    agent.runs++;
    if (row.status === 'completed') agent.completed++;
    else if (row.status === 'failed' || row.status === 'incomplete') agent.failed++;
    if (terminal(row.status)) {
      const elapsed = Math.max(0, row.updated - row.created);
      latencies.push(elapsed);
      agent.durations.push(elapsed);
      if (recent.length < ACTIVITY_BREAKDOWN_RUNS)
        recent.push({ id: row.id, version: `${row.status}:${row.updated}` });
    }
  }
  latencies.sort((a, b) => a - b);
  let breakdown: (Breakdown & { runs: number }) | null = null;
  for (const run of recent) {
    let timeline: Timeline;
    try {
      timeline = timelines.get(store, principal.owner, run.id, run.version);
    } catch {
      continue;
    }
    breakdown ??= { queue: 0, model: 0, tools: 0, approval: 0, other: 0, runs: 0 };
    for (const key of ['queue', 'model', 'tools', 'approval', 'other'] as const)
      breakdown[key] += timeline.breakdown_ms[key];
    breakdown.runs++;
  }
  const settled = totals.completed + totals.failed + totals.interrupted;
  return {
    window,
    generated_at: new Date(now).toISOString(),
    bucket_ms: frame.bucketMs,
    buckets: buckets.map((counts, i) => ({
      start: new Date(frame.start + i * frame.bucketMs).toISOString(),
      ...counts,
    })),
    totals: {
      ...totals,
      success_rate: settled ? Number((totals.completed / settled).toFixed(4)) : null,
    },
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      samples: latencies.length,
    },
    breakdown_ms: breakdown,
    agents: [...agents]
      .sort((a, b) => b[1].runs - a[1].runs || a[0].localeCompare(b[0]))
      .slice(0, ACTIVITY_TOP_AGENTS)
      .map(([agent, stats]) => ({
        agent,
        runs: stats.runs,
        completed: stats.completed,
        failed: stats.failed,
        p50_ms: percentile(
          stats.durations.sort((a, b) => a - b),
          0.5,
        ),
      })),
  };
}
