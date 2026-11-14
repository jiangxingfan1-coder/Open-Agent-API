import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setup, agent, FixtureModel, principal } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, label: { type: 'string' }, compare: { type: 'string' } },
});
if (!values.out || !values.label)
  throw new Error(
    'Use --label NAME --out NEW_REPORT.json [--compare BASELINE.json]. Existing reports are never overwritten.',
  );
const workload = {
  format: 'oaa.streaming-benchmark.v1',
  samples: 3,
  warmups: 1,
  cases: [
    { name: 'small', inputChars: 256, outputChars: 512 },
    { name: 'large_context', inputChars: 65536, outputChars: 8192 },
  ],
  chunkChars: 8,
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const workloadHash = hash(JSON.stringify(workload));
const sources: Record<string, string> = {};
for (const file of [
  'src/store/store.ts',
  'src/store/output.ts',
  'src/kernel/kernel.ts',
  'src/gateway/server.ts',
  'src/gateway/protocol.ts',
  'bench/streaming.ts',
])
  sources[file] = hash(await readFile(file, 'utf8'));
const results = [];
for (const shape of workload.cases) {
  const text = 'x'.repeat(shape.outputChars);
  const s = await setup(new FixtureModel(() => ({ text })));
  const samples = [];
  try {
    s.store.db.exec(`CREATE TEMP TABLE measured_snapshot_writes(bytes INTEGER NOT NULL);
      CREATE TEMP TRIGGER measure_insert AFTER INSERT ON main.runs BEGIN INSERT INTO measured_snapshot_writes VALUES(length(CAST(NEW.payload AS BLOB))); END;
      CREATE TEMP TRIGGER measure_update AFTER UPDATE OF payload ON main.runs BEGIN INSERT INTO measured_snapshot_writes VALUES(length(CAST(NEW.payload AS BLOB))); END;`);
    s.store.publish('owner', makeBundle(agent()));
    for (let i = 0; i < workload.samples + workload.warmups; i++) {
      s.store.db.exec('DELETE FROM measured_snapshot_writes');
      let reads = 0;
      const original = s.store.run.bind(s.store);
      s.store.run = (...args) => {
        reads++;
        return original(...args);
      };
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: 'a'.repeat(shape.inputChars),
          background: true,
        }),
      );
      const result = await s.kernel.wait(run.id);
      const elapsedMs = performance.now() - start;
      s.store.run = original;
      if (result.status !== 'completed' || result.output.map((m) => m.text).join('') !== text)
        throw new Error('The benchmark result does not match its complete expected output.');
      let cursor = 0;
      let replay = '';
      let eventCount = 0;
      while (true) {
        const events = s.store.history(run.id, cursor);
        if (!events.length) break;
        for (const event of events) {
          cursor = event.id;
          eventCount++;
          if (event.type === 'response.output_text.delta') replay += event.data.delta;
        }
        if (events.length < 1000) break;
      }
      if (replay !== text) throw new Error('The durable event stream lost or duplicated text.');
      const counts = s.store.db
        .prepare(
          'SELECT count(*) AS writes,coalesce(sum(bytes),0) AS bytes FROM measured_snapshot_writes',
        )
        .get()!;
      if (i >= workload.warmups)
        samples.push({
          elapsed_ms: elapsedMs,
          snapshot_writes: Number(counts.writes),
          serialized_snapshot_bytes: Number(counts.bytes),
          run_reads: reads,
          event_count: eventCount,
          output_verified: true,
        });
    }
    const sorted = samples.map((s) => s.elapsed_ms).sort((a, b) => a - b);
    results.push({ ...shape, samples, p50_ms: sorted[Math.floor(sorted.length / 2)] });
  } finally {
    await s.cleanup();
  }
}
const report: Record<string, unknown> = {
  recorded_at: new Date().toISOString(),
  label: values.label,
  workload,
  workload_hash: workloadHash,
  source_hashes: sources,
  node: process.version,
  evidence: 'instrumented local deterministic streaming/store benchmark',
  live_model_calls: false,
  filesystem: 'temporary local filesystem',
  notes: [
    'SQLite TEMP triggers count real runs.payload writes and serialized bytes.',
    'Timing includes the same trigger instrumentation in baseline and candidate.',
    'This is not an OpenAI, AgentScope, native-agent, or cross-machine benchmark.',
  ],
  results,
};
if (values.compare) {
  const baseline = JSON.parse(await readFile(values.compare, 'utf8'));
  if (baseline.workload_hash !== workloadHash)
    throw new Error('Refusing comparison between different workloads.');
  report.comparison = {
    baseline: values.compare,
    cases: results.map((r) => {
      const before = baseline.results.find((b: { name: string }) => b.name === r.name);
      return {
        name: r.name,
        p50_reduction_percent: (1 - r.p50_ms! / before.p50_ms) * 100,
        snapshot_writes_before: before.samples[0].snapshot_writes,
        snapshot_writes_after: r.samples[0]!.snapshot_writes,
      };
    }),
  };
}
const out = path.resolve(values.out);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(
  JSON.stringify(
    {
      report: out,
      label: values.label,
      results: results.map((r) => ({
        name: r.name,
        p50_ms: r.p50_ms,
        snapshot_writes: r.samples[0]?.snapshot_writes,
        serialized_snapshot_bytes: r.samples[0]?.serialized_snapshot_bytes,
      })),
      comparison: report.comparison,
    },
    null,
    2,
  ) + '\n',
);
