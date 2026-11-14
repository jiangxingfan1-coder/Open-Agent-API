import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { capabilitySchema } from '../src/core/contracts.js';
import { setup, FixtureModel, agent, principal } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { sleep } from '../src/core/util.js';

type Shape = 'simple' | 'parallel' | 'dependent';
const samples = 12;
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)]!;
async function measure(shape: Shape, concurrency: number) {
  const model = new FixtureModel(async (_a, m, signal) => {
    await sleep(5, signal);
    if (shape === 'simple' || m.some((x) => x.role === 'tool'))
      return { text: 'Verified fixture result.' };
    return {
      calls: [
        {
          id: 'graph',
          name: 'execute_graph',
          arguments: {
            steps: Array.from({ length: 4 }, (_, i) => ({
              id: `s${i}`,
              tool: 'lookup',
              arguments: { item: i },
              ...(shape === 'dependent' && i ? { depends_on: [`s${i - 1}`] } : {}),
            })),
          },
        },
      ],
    };
  });
  const s = await setup(model);
  const elapsed: number[] = [];
  const firstText: number[] = [];
  const firstEvent: number[] = [];
  let cold = 0;
  try {
    const capability = capabilitySchema.parse({
      id: 'bench/lookup',
      version: '1',
      description: 'Bounded deterministic fixture lookup',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { item: { type: 'integer' } },
        required: ['item'],
      },
    });
    s.runtime.config.tools.push({
      reference: 'lookup',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('lookup', async (args, _ctx, signal) => {
      await sleep(25, signal);
      return { value: { item: args.item, verified: true } };
    });
    const bundle = makeBundle(
      agent({
        limits: { toolConcurrency: concurrency },
        tools: [{ name: 'lookup', capability, handler: { kind: 'node', reference: 'lookup' } }],
      }),
    );
    s.store.publish('owner', bundle);
    for (let i = 0; i <= samples; i++) {
      const start = performance.now();
      const wallStart = Date.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `${shape} fixture ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') throw new Error(JSON.stringify(done.error));
      const ms = performance.now() - start;
      const events = s.store.history(run.id);
      if (i === 0) cold = ms;
      else {
        elapsed.push(ms);
        firstEvent.push(Math.max(0, events[0]!.time - wallStart));
        firstText.push(
          Math.max(
            0,
            (events.find((e) => e.type === 'response.output_text.delta')?.time ?? wallStart) -
              wallStart,
          ),
        );
      }
    }
    return {
      samples,
      cold_ms: cold,
      p50_ms: quantile(elapsed, 0.5),
      p95_ms: quantile(elapsed, 0.95),
      first_event_p50_ms: quantile(firstEvent, 0.5),
      first_text_p50_ms: quantile(firstText, 0.5),
      successful: samples + 1,
      model_calls: model.calls,
      model_tokens: 'fixture only; not a cost measurement',
    };
  } finally {
    await s.cleanup();
  }
}
const results = [];
for (const shape of ['simple', 'parallel', 'dependent'] as const) {
  const baseline = await measure(shape, 1);
  const candidate = await measure(shape, 4);
  results.push({
    shape,
    baseline,
    candidate,
    p50_reduction_percent: (1 - candidate.p50_ms / baseline.p50_ms) * 100,
  });
}
const report = {
  recorded_at: new Date().toISOString(),
  evidence: 'local deterministic scheduler microbenchmark',
  baseline: 'same runtime with toolConcurrency=1',
  candidate: 'same runtime with toolConcurrency=4',
  live_models: false,
  agentscope_comparison: 'not run',
  openai_agents_api_comparison: 'not run',
  cross_machine: 'not run',
  results,
};
await mkdir('.oaa-bench', { recursive: true });
await writeFile('.oaa-bench/runtime.json', JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
