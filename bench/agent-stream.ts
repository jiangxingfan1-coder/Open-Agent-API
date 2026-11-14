import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { runA2A } from '../src/engines/a2a.js';
import { agentSchema } from '../src/core/contracts.js';
import { workerSchema } from '../src/config/config.js';
import { sha } from '../src/core/util.js';

const out = process.argv[2];
if (!out) throw new Error('Usage: node dist/bench/agent-stream.js NEW_REPORT.json');
const text = 'x'.repeat(256 * 1024);
const bytes = Buffer.from(
  [
    { result: { artifactUpdate: { taskId: 't', artifact: { parts: [{ text }] } } } },
    { result: { statusUpdate: { taskId: 't', status: { state: 'TASK_STATE_COMPLETED' } } } },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join(''),
);
const config = workerSchema.parse({
  nodeId: 'fixture',
  dataDir: '/tmp/unused-oaa-stream-bench',
  adapters: { peer: { transport: 'a2a', enabled: true, url: 'https://fixture.invalid/rpc' } },
});
const definition = agentSchema.parse({
  id: 'agent/fixture',
  description: 'Local stream benchmark',
  instructions: '',
  engine: 'adapter/peer',
  model: 'default',
});
const samples = [];
for (let i = 0; i < 8; i++) {
  let offset = 0,
    requests = 0,
    events = 0;
  const started = performance.now();
  const result = await runA2A(
    definition,
    config,
    'fixture',
    new AbortController().signal,
    async () => {
      events++;
    },
    undefined,
    (async () => {
      requests++;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.subarray(offset, offset + 127));
            offset += 127;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch,
  );
  const ms = performance.now() - started;
  assert.equal(result.text, text);
  assert.equal(result.nativeState.state, 'completed');
  assert.equal(requests, 1);
  samples.push({ ms, requests, events, outputHash: sha(result.text) });
}
const warm = samples
  .slice(1)
  .map((sample) => sample.ms)
  .sort((a, b) => a - b);
const report = {
  kind: 'local-fragmented-a2a-stream',
  node: process.version,
  workloadHash: sha(bytes),
  sourceHash: sha(await readFile(new URL('../src/engines/a2a.js', import.meta.url))),
  coldMs: samples[0]!.ms,
  medianWarmMs: warm[Math.floor(warm.length / 2)],
  samples,
  boundary: 'In-process credential-free fixture; not real provider or remote-agent latency.',
};
await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
