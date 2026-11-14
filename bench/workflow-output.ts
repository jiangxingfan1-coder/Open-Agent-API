import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { executeGraph, parseGraph, projectGraphOutput } from '../src/lang/graph.js';
import { sha } from '../src/core/util.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node dist/bench/workflow-output.js NEW_REPORT.json');
const definition = {
  steps: Array.from({ length: 8 }, (_, i) => ({
    id: `source${i}`,
    tool: 'read',
    arguments: { index: i },
  })),
  output: { first: { $ref: 'source0#/id' }, last: { $ref: 'source7#/id' } },
};
const steps = parseGraph(definition, new Set(['read']));
const samples = [];
for (const mode of ['default', 'projected'] as const) {
  let calls = 0;
  const results = await executeGraph(
    steps,
    4,
    new AbortController().signal,
    async (_step, args) => {
      calls++;
      return { id: args.index, source: 'x'.repeat(32768) };
    },
  );
  const output = projectGraphOutput(mode === 'projected' ? definition.output : undefined, results);
  assert.equal(calls, 8);
  assert.deepEqual(projectGraphOutput(definition.output, results), { first: 0, last: 7 });
  samples.push({
    mode,
    toolCalls: calls,
    leafResultHash: sha(JSON.stringify(results)),
    resultBytes: Buffer.byteLength(JSON.stringify(output)),
    selected: { first: 0, last: 7 },
  });
}
assert.equal(samples[0]!.leafResultHash, samples[1]!.leafResultHash);
const report = {
  kind: 'local-workflow-result-projection',
  workloadHash: sha(JSON.stringify(definition)),
  samples,
  boundary:
    'Explicit selected fields, not semantic summarization, token/cost measurement, model latency, or a privacy boundary.',
};
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
