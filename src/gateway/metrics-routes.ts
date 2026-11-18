/**
 * Prometheus text exposition endpoint (`GET /metrics`, `text/plain; version=0.0.4`).
 *
 * Requires `read` scope and scopes all counters/gauges to the caller's visible runs and tenant
 * (`owner`, `agents`, `visibleSubject`), zero third-party dependencies.
 */
import type { FastifyInstance } from 'fastify';
import { isOwnerWide, visibleSubject, type Principal } from '../core/contracts.js';
import type { NodeHub } from '../fabric/network.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Store } from '../store/store.js';
import {
  activityFrame,
  computeActivity,
  type SummaryWindow,
  type TimelineCache,
} from './activity.js';
import type { Auth } from './auth.js';
import { overviewViewKey, type RevisionCache } from './overview.js';

export type MetricsRouteDeps = {
  auth: Auth;
  store: Store;
  kernel: Kernel;
  hub: NodeHub;
  cachedMetrics: (p: Principal) => ReturnType<Store['metrics']>;
  activityCache: RevisionCache<ReturnType<typeof computeActivity>>;
  timelines: TimelineCache;
  summaryWindows: SummaryWindow;
};

export const METRICS_OPERATIONS: [string, string, string][] = [
  [
    '/metrics',
    'get',
    'Prometheus 0.0.4 metrics: queue depth, active runs, online nodes, per-agent runs/errors/tokens and P50/P95 latency',
  ],
];

const ERROR_STATUSES = new Set(['failed', 'incomplete', 'interrupted']);

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function queryAgentStatusRollup(
  store: Store,
  p: Principal,
): { agent: string; status: string; runs: number; tokens: number }[] {
  const clauses = ['owner = ?'];
  const args: (string | number)[] = [p.owner];
  const subject = visibleSubject(p);
  if (subject !== undefined) {
    clauses.push('subject = ?');
    args.push(subject);
  }
  if (!p.agents.includes('*')) {
    if (!p.agents.length) return [];
    const exact = p.agents.filter((a) => !a.endsWith('*'));
    const prefixes = p.agents.filter((a) => a.endsWith('*')).map((a) => a.slice(0, -1));
    const sub: string[] = [];
    if (exact.length) {
      sub.push(`agent_id IN (${exact.map(() => '?').join(',')})`);
      args.push(...exact);
    }
    for (const pre of prefixes) {
      sub.push("agent_id LIKE ? ESCAPE '\\'");
      args.push(`${pre.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    clauses.push(`(${sub.join(' OR ')})`);
  }
  const rows = store.db
    .prepare(
      `SELECT agent_id AS agent, status, count(*) AS runs, coalesce(sum(total_tokens), 0) AS tokens
         FROM run_summaries WHERE ${clauses.join(' AND ')}
         GROUP BY agent_id, status ORDER BY agent_id, status`,
    )
    .all(...args);
  return rows.map((r) => ({
    agent: String(r.agent),
    status: String(r.status),
    runs: Number(r.runs),
    tokens: Number(r.tokens),
  }));
}

export function renderPrometheusMetrics(
  deps: Omit<MetricsRouteDeps, 'auth'>,
  p: Principal,
): string {
  const { store, kernel, hub, cachedMetrics, activityCache, timelines, summaryWindows } = deps;
  const metrics = cachedMetrics(p);
  const now = Date.now();
  const frame = activityFrame('24h', now);
  const activity = activityCache.get(p.owner, `${overviewViewKey(p)}\n24h\n${frame.start}`, () =>
    computeActivity(store, p, '24h', now, timelines, {
      cache: summaryWindows,
      key: overviewViewKey(p),
    }),
  );
  const rollup = queryAgentStatusRollup(store, p);
  const onlineNodes = hub.inventory(p.owner).length;
  const kernelStats = kernel.stats();
  const queueDepth = isOwnerWide(p)
    ? Math.max(Number(metrics.queued ?? 0), kernelStats.queued)
    : Number(metrics.queued ?? 0);

  const lines: string[] = [];
  const metric = (
    name: string,
    type: 'gauge' | 'counter',
    help: string,
    samples: [Record<string, string>, number][],
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) lines.push(`${name}${formatLabels(labels)} ${value}`);
  };

  metric('oaa_gateway_queue_depth', 'gauge', 'Current queued runs waiting for admission.', [
    [{}, queueDepth],
  ]);
  metric('oaa_active_runs', 'gauge', 'Current unfinished runs visible to the caller.', [
    [{}, Number(metrics.active ?? 0)],
  ]);
  metric('oaa_active_runs_by_state', 'gauge', 'Current unfinished runs broken down by state.', [
    [{ state: 'queued' }, Number(metrics.queued ?? 0)],
    [{ state: 'in_progress' }, Number(metrics.in_progress ?? 0)],
    [{ state: 'requires_action' }, Number(metrics.requires_action ?? 0)],
    [{ state: 'awaiting_caller' }, Number(metrics.awaiting_caller ?? 0)],
  ]);
  metric('oaa_online_nodes', 'gauge', 'Online execution nodes connected for this owner.', [
    [{}, onlineNodes],
  ]);

  metric(
    'oaa_runs_total',
    'counter',
    'Total recorded runs grouped by agent and current status.',
    rollup.map((r) => [{ agent: r.agent, status: r.status }, r.runs]),
  );

  const errorsByAgent = new Map<string, number>();
  for (const r of rollup) {
    if (!errorsByAgent.has(r.agent)) errorsByAgent.set(r.agent, 0);
    if (ERROR_STATUSES.has(r.status))
      errorsByAgent.set(r.agent, (errorsByAgent.get(r.agent) ?? 0) + r.runs);
  }
  metric(
    'oaa_run_errors_total',
    'counter',
    'Total failed, incomplete or interrupted runs per agent.',
    [...errorsByAgent.entries()].map(([agent, count]) => [{ agent }, count]),
  );

  metric(
    'oaa_run_tokens_total',
    'counter',
    'Observed total tokens grouped by agent and run status.',
    rollup.map((r) => [{ agent: r.agent, status: r.status }, r.tokens]),
  );
  metric('oaa_tokens_total', 'counter', 'Observed total tokens across visible runs.', [
    [{}, Number(metrics.total_tokens ?? 0)],
  ]);

  const p50 = activity.latency_ms.p50 ?? 0;
  const p95 = activity.latency_ms.p95 ?? 0;
  metric(
    'oaa_activity_latency_milliseconds',
    'gauge',
    'End-to-end run latency quantiles (milliseconds) over the 24h activity window.',
    [
      [{ window: '24h', quantile: '0.5' }, p50],
      [{ window: '24h', quantile: '0.95' }, p95],
    ],
  );
  metric(
    'oaa_activity_latency_samples',
    'gauge',
    'Finished run sample count in the 24h activity latency window.',
    [[{ window: '24h' }, activity.latency_ms.samples]],
  );

  return lines.join('\n') + '\n';
}

export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRouteDeps): void {
  app.get('/metrics', async (req, reply) => {
    deps.auth.require(req.principal, 'read');
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(renderPrometheusMetrics(deps, req.principal));
  });
}
