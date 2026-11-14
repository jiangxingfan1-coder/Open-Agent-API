// Kernel dispatch overhead with enabled local backends (in-process; no sockets, no models).
// Usage: node dist/bench/dispatch.js --label NAME --out NEW_REPORT.json
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setup, agent, FixtureModel, principal } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, label: { type: 'string' }, backends: { type: 'string' } },
});
if (!values.out || !values.label)
  throw new Error(
    'Use --label NAME --out NEW_REPORT.json. Existing reports are never overwritten.',
  );
const workload = {
  format: 'oaa.dispatch-benchmark.v1',
  enabledLocalBackends: Number(values.backends ?? 16),
  runs: 200,
  warmups: 20,
  model: 'immediate fixture text, no delays',
};
const s = await setup(new FixtureModel(() => ({ text: 'Dispatch fixture result.' })));
try {
  for (const engine of (['codex', 'claude', 'antigravity', 'dsh'] as const).slice(
    0,
    workload.enabledLocalBackends,
  ))
    s.runtime.config.native[engine] = { executable: process.execPath, enabled: true, args: [] };
  for (let i = 0; i < workload.enabledLocalBackends - 4; i++)
    s.runtime.config.adapters[`acp${i}`] = {
      transport: 'stdio',
      command: process.execPath,
      args: [],
      enabled: true,
    };
  s.store.publish('owner', makeBundle(agent()));
  const latencies: number[] = [];
  const started = performance.now();
  for (let i = 0; i < workload.runs + workload.warmups; i++) {
    const start = performance.now();
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: `dispatch ${i}`, background: true }),
    );
    const done = await s.kernel.wait(run.id);
    if (done.status !== 'completed') throw new Error(JSON.stringify(done.error));
    if (i >= workload.warmups) latencies.push(performance.now() - start);
  }
  const totalMs = performance.now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  const report = {
    recorded_at: new Date().toISOString(),
    label: values.label,
    workload,
    node: process.version,
    evidence: 'in-process kernel submit→wait latency with enabled local backends',
    live_model_calls: false,
    sockets: false,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    mean_ms: latencies.reduce((n, v) => n + v, 0) / latencies.length,
    runs_per_second: ((workload.runs + workload.warmups) / totalMs) * 1000,
  };
  const out = path.resolve(values.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await s.cleanup();
}
