import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setup, agent, FixtureModel, principal } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { capabilitySchema, type Run } from '../src/core/contracts.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { sha, sleep } from '../src/core/util.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, label: { type: 'string' }, compare: { type: 'string' } },
});
if (!values.out || !values.label)
  throw new Error('Use --label NAME --out NEW_REPORT.json [--compare BASELINE.json].');
const workload = {
  format: 'oaa.fairness-benchmark.v1',
  samples: 7,
  coldSamples: 1,
  cases: ['simple_alone', 'contended_tools', 'contended_dependency_graph'],
  maxActiveRuns: 1,
  toolConcurrency: 2,
  modelDelayMs: 5,
  toolDelayMs: 12,
  toolCount: 12,
  enqueueShort: 'after the first long-task tool starts',
};
const workloadHash = sha(JSON.stringify(workload));
const sources: Record<string, string> = {};
for (const file of [
  'src/kernel/kernel.ts',
  'src/lang/graph.ts',
  'src/core/suspension.ts',
  'src/fabric/network.ts',
  'bench/fairness.ts',
])
  sources[file] = sha(await readFile(file, 'utf8'));
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const results = [];
for (const shape of workload.cases) {
  let firstTool = Promise.withResolvers<void>();
  let tools = 0;
  const driver = new FixtureModel(async (definition, messages, signal) => {
    await sleep(workload.modelDelayMs, signal);
    if (definition.id === 'agent/quick') return { text: 'Quick fixture result.' };
    const answers = messages.filter((message) => message.role === 'tool');
    if (answers.length) {
      const rows =
        shape === 'contended_tools'
          ? answers.map((a) => JSON.parse(a.content))
          : Object.values(JSON.parse(answers[0]!.content));
      if (rows.length !== workload.toolCount || rows.reduce((n, row) => n + row.item, 0) !== 66)
        throw new Error('Fixture results are incomplete or duplicated.');
      return { text: 'Long fixture result: 66.' };
    }
    const calls = Array.from({ length: workload.toolCount }, (_, i) => ({
      id: `s${i}`,
      name: 'lookup',
      arguments: { item: i },
    }));
    return {
      calls:
        shape === 'contended_tools'
          ? calls
          : [
              {
                id: 'graph',
                name: 'execute_graph',
                arguments: {
                  steps: calls.map((call, i) => ({
                    id: call.id,
                    tool: call.name,
                    arguments: {
                      ...call.arguments,
                      ...(i ? { previous: { $ref: `s${i - 1}#/item` } } : {}),
                    },
                  })),
                },
              },
            ],
    };
  });
  const s = await setup(driver, { maxActiveRuns: workload.maxActiveRuns });
  const samples = [];
  try {
    const capability = capabilitySchema.parse({
      id: 'bench/fair-lookup',
      version: '1',
      description: 'Local deterministic scheduling fixture',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'lookup',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('lookup', async (args, _context, signal) => {
      tools++;
      firstTool.resolve();
      await sleep(workload.toolDelayMs, signal);
      if (
        shape === 'contended_dependency_graph' &&
        Number(args.item) > 0 &&
        args.previous !== Number(args.item) - 1
      )
        throw new Error('Dependency result changed.');
      return { value: { item: args.item } };
    });
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/long',
          limits: { toolConcurrency: workload.toolConcurrency },
          tools: [{ name: 'lookup', capability, handler: { kind: 'node', reference: 'lookup' } }],
        }),
      ),
    );
    const submit = (id: string) =>
      s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: id, input: 'Fixed fixture input', background: true }),
      );
    for (let i = 0; i < workload.samples + workload.coldSamples; i++) {
      firstTool = Promise.withResolvers<void>();
      const beforeModels = driver.calls,
        beforeTools = tools;
      const start = performance.now();
      let long: Run | undefined;
      if (shape !== 'simple_alone') {
        long = submit('agent/long');
        await firstTool.promise;
      }
      const shortStart = performance.now(),
        shortWall = Date.now();
      const quick = submit('agent/quick');
      const done = await s.kernel.wait(quick.id);
      const shortMs = performance.now() - shortStart;
      if (
        done.status !== 'completed' ||
        done.output.map((m) => m.text).join('') !== 'Quick fixture result.'
      )
        throw new Error('Short task did not complete correctly.');
      const shortBeforeLong = long
        ? s.store.runIdentity(long.id, 'owner').status !== 'completed'
        : null;
      let longDone: Run | undefined;
      if (long) {
        longDone = await s.kernel.wait(long.id);
        if (
          longDone.status !== 'completed' ||
          longDone.output.map((m) => m.text).join('') !== 'Long fixture result: 66.'
        )
          throw new Error('Long task did not complete correctly.');
      }
      const events = s.store.history(quick.id);
      samples.push({
        cold: i === 0,
        first_event_ms: Math.max(0, events[0]!.time - shortWall),
        first_text_ms: Math.max(
          0,
          events.find((e) => e.type === 'response.output_text.delta')!.time - shortWall,
        ),
        short_final_ms: shortMs,
        makespan_ms: performance.now() - start,
        short_before_long: shortBeforeLong,
        model_calls: driver.calls - beforeModels,
        tool_calls: tools - beforeTools,
        output_verified: true,
        yields: long
          ? s.store
              .history(long.id)
              .filter((e) => e.type === 'run.queued' && e.data.reason === 'fairness').length
          : 0,
      });
      if (
        driver.calls - beforeModels !== (long ? 3 : 1) ||
        tools - beforeTools !== (long ? workload.toolCount : 0)
      )
        throw new Error('Scheduling repeated a model or tool invocation.');
    }
    const warm = samples.filter((sample) => !sample.cold);
    results.push({
      name: shape,
      samples,
      warm_p50_short_final_ms: median(warm.map((sample) => sample.short_final_ms)),
      warm_p50_first_text_ms: median(warm.map((sample) => sample.first_text_ms)),
      warm_p50_first_event_ms: median(warm.map((sample) => sample.first_event_ms)),
      warm_p50_makespan_ms: median(warm.map((sample) => sample.makespan_ms)),
    });
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
  evidence: 'local deterministic admission-fairness benchmark',
  live_model_calls: false,
  notes: [
    'Cold means first requests after fixture initialization, not a cold OS or gateway launch.',
    'Both workloads, tool/model delays and operation counts are held fixed.',
    'Event/text timings use committed-event timestamps, not HTTP delivery measurements.',
    'Token and monetary cost comparisons are not measured.',
    'This is not an OpenAI, AgentScope, native-agent or cross-machine benchmark.',
  ],
  results,
};
if (values.compare) {
  const baseline = JSON.parse(await readFile(values.compare, 'utf8'));
  if (baseline.workload_hash !== workloadHash)
    throw new Error('Workloads differ; comparison refused.');
  report.comparison = {
    baseline: values.compare,
    cases: results.map((result) => {
      const before = baseline.results.find((item: { name: string }) => item.name === result.name);
      if (!before) throw new Error('Baseline case is missing.');
      return {
        name: result.name,
        short_final_p50_reduction_percent:
          (1 - result.warm_p50_short_final_ms / before.warm_p50_short_final_ms) * 100,
        makespan_p50_change_percent:
          (result.warm_p50_makespan_ms / before.warm_p50_makespan_ms - 1) * 100,
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
      results: results.map(({ samples: _, ...summary }) => summary),
      comparison: report.comparison,
    },
    null,
    2,
  ) + '\n',
);
