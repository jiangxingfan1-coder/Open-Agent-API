import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { executeGraph, parseGraph } from '../src/lang/graph.js';
import { sha, sleep } from '../src/core/util.js';

const out = process.argv[2];
if (!out) throw new Error('Usage: node dist/bench/kernel-graph.js NEW_REPORT.json');
const definition = {
  steps: [
    { id: 'slow', tool: 'work', arguments: { delay: 120 } },
    { id: 'fast', tool: 'work', arguments: { delay: 25 } },
    { id: 'child', tool: 'work', arguments: { delay: 25, parent: { $ref: 'fast#/id' } } },
    { id: 'grandchild', tool: 'work', arguments: { delay: 25, parent: { $ref: 'child#/id' } } },
    { id: 'last', tool: 'work', arguments: { delay: 25, parent: { $ref: 'grandchild#/id' } } },
  ],
};
const steps = parseGraph(definition, new Set(['work']));
const samples = [];
for (let trial = 0; trial < 8; trial++) {
  let active = 0,
    peak = 0,
    calls = 0;
  const start = performance.now();
  const result = await executeGraph(steps, 2, new AbortController().signal, async (step, args) => {
    calls++;
    peak = Math.max(peak, ++active);
    try {
      await sleep(Number(args.delay));
      return { id: step.id, parent: args.parent ?? null };
    } finally {
      active--;
    }
  });
  const ms = performance.now() - start;
  assert.equal(calls, 5);
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.deepEqual(result.last, { id: 'last', parent: 'grandchild' });
  samples.push({ ms, calls, peak, resultHash: sha(JSON.stringify(result)) });
}
const warm = samples
  .slice(1)
  .map((s) => s.ms)
  .sort((a, b) => a - b);
const report = {
  kind: 'local-deterministic-graph-scheduler',
  node: process.version,
  workloadHash: sha(JSON.stringify(definition)),
  sourceHash: sha(await readFile(new URL('../src/lang/graph.js', import.meta.url))),
  coldMs: samples[0]!.ms,
  medianWarmMs: warm[Math.floor(warm.length / 2)],
  samples,
  boundary: 'No provider calls, SQLite workload, remote workers, or production speed claim.',
};
await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
