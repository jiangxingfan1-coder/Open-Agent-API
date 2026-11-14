// Observable-kernel microbenchmarks (in-process app.inject; no sockets, no models).
// Usage: node dist/bench/observability.js --label NAME --out NEW_REPORT.json [--runs 10000]
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { capabilitySchema } from '../src/core/contracts.js';
import { setup, agent, FixtureModel, principal, token } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { buildTimeline } from '../src/gateway/timeline.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, label: { type: 'string' }, runs: { type: 'string' } },
});
if (!values.out || !values.label)
  throw new Error(
    'Use --label NAME --out NEW_REPORT.json. Existing reports are never overwritten.',
  );
const workload = {
  format: 'oaa.observability-benchmark.v1',
  timelineToolCalls: 60,
  activityRuns: Number(values.runs ?? 10_000),
  iterations: 200,
};
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return { p50_ms: at(0.5), p95_ms: at(0.95), samples: values.length };
};
const time = async <T>(fn: () => Promise<T> | T) => {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
};
const quota = {
  keys: [
    {
      name: 'test',
      owner: 'owner',
      tokenEnv: 'OAA_TEST_TOKEN',
      scopes: principal.scopes,
      quota: { rpm: 100_000 },
    },
  ],
};
const headers = { authorization: `Bearer ${token}` };

// 1. Timeline of a run with ~200 lifecycle events (60 tool calls in batches of 4).
const calls = Array.from({ length: workload.timelineToolCalls }, (_, i) => ({
  id: `c${i}`,
  name: 'lookup',
  arguments: { item: i },
}));
const t = await setup(
  new FixtureModel((_a, messages) =>
    messages.some((m) => m.role === 'tool') ? { text: 'done' } : { calls },
  ),
  quota,
);
let timeline: Record<string, unknown>;
try {
  const capability = capabilitySchema.parse({
    id: 'bench/lookup',
    version: '1',
    description: 'Deterministic lookup',
    placement: 'host-bound',
    nodeId: 'local',
    effect: 'read',
    inputSchema: { type: 'object', properties: { item: { type: 'integer' } } },
  });
  t.runtime.config.tools.push({
    reference: 'lookup',
    capability,
    handler: { kind: 'read_directory', root: t.dir },
  });
  t.runtime.handlers.set('lookup', async (args) => ({ value: { item: args.item } }));
  t.store.publish(
    'owner',
    makeBundle(
      agent({
        tools: [{ name: 'lookup', capability, handler: { kind: 'node', reference: 'lookup' } }],
      }),
    ),
  );
  const run = t.kernel.submit(
    principal,
    invocationSchema.parse({ agent: 'agent/test', input: 'timeline', background: true }),
  );
  if ((await t.kernel.wait(run.id)).status !== 'completed') throw new Error('Timeline run failed.');
  const url = `/v1/runs/${run.id}/timeline`;
  const events = t.store.timelineSource(run.id, 'owner').events.length;
  const full: number[] = [];
  const conditional: number[] = [];
  const pure: number[] = [];
  let etag = '';
  let spans = 0;
  for (let i = 0; i < workload.iterations; i++) {
    const r = await time(() => t.app.inject({ method: 'GET', url, headers }));
    full.push(r.ms);
    etag = String(r.value.headers.etag);
    spans = (r.value.json() as { spans: unknown[] }).spans.length;
    const c = await time(() =>
      t.app.inject({ method: 'GET', url, headers: { ...headers, 'if-none-match': etag } }),
    );
    if (c.value.statusCode !== 304) throw new Error('Expected 304 for an unchanged timeline.');
    conditional.push(c.ms);
    const source = t.store.timelineSource(run.id, 'owner');
    pure.push((await time(() => buildTimeline({ ...source, now: Date.now() }))).ms);
  }
  timeline = {
    lifecycle_events: events,
    spans,
    full_request: stats(full),
    conditional_304: stats(conditional),
    build_only: stats(pure),
  };
} finally {
  await t.cleanup();
}

// 2. Activity over N completed runs.
const a = await setup(new FixtureModel(() => ({ text: 'ok' })), quota);
let activity: Record<string, unknown>;
try {
  for (let i = 0; i < 12; i++) a.store.publish('owner', makeBundle(agent({ id: `agent/a${i}` })));
  const seedStart = performance.now();
  for (let i = 0; i < workload.activityRuns; i++) {
    const run = a.kernel.submit(
      principal,
      invocationSchema.parse({ agent: `agent/a${i % 12}`, input: `r${i}`, background: true }),
    );
    if (i % 16 === 15 || i === workload.activityRuns - 1) await a.kernel.wait(run.id);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const seedMs = performance.now() - seedStart;
  const get = (query = '') =>
    a.app.inject({ method: 'GET', url: `/v1/overview/activity${query}`, headers });
  const cold = await time(() => get());
  const body = cold.value.json() as { totals: { started: number }; breakdown_ms: { runs: number } };
  if (body.totals.started !== workload.activityRuns)
    throw new Error(`Expected ${workload.activityRuns} runs, saw ${body.totals.started}.`);
  const warm: number[] = [];
  const notModified: number[] = [];
  const afterChange: number[] = [];
  let etag = String(cold.value.headers.etag);
  for (let i = 0; i < 50; i++) {
    warm.push((await time(() => get())).ms);
    const c = await time(() =>
      a.app.inject({
        method: 'GET',
        url: '/v1/overview/activity',
        headers: { ...headers, 'if-none-match': etag },
      }),
    );
    if (c.value.statusCode !== 304) throw new Error('Expected 304 for unchanged activity.');
    notModified.push(c.ms);
  }
  for (let i = 0; i < 20; i++) {
    a.store.publish('owner', makeBundle(agent({ id: `agent/change${i}` })));
    const r = await time(() => get());
    afterChange.push(r.ms);
    etag = String(r.value.headers.etag);
  }
  const week = await time(() => get('?window=7d'));
  activity = {
    runs: workload.activityRuns,
    seed_ms: seedMs,
    breakdown_runs: body.breakdown_ms.runs,
    cold_first_request_ms: cold.ms,
    recompute_after_change: stats(afterChange),
    warm_cached: stats(warm),
    conditional_304: stats(notModified),
    window_7d_first_request_ms: week.ms,
  };
} finally {
  await a.cleanup();
}
const report = {
  recorded_at: new Date().toISOString(),
  label: values.label,
  workload,
  node: process.version,
  evidence: 'in-process app.inject; deterministic fixtures; no sockets, no models',
  live_model_calls: false,
  timeline,
  activity,
};
const out = path.resolve(values.out);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
