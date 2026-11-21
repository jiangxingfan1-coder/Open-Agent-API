import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, Fault } from '../src/core/util.js';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import {
  executeGraph,
  parseGraph,
  parsePublishedGraph,
  projectGraphOutput,
} from '../src/lang/graph.js';
import { graphTool } from '../src/providers/models.js';
import { makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { TaskWorkflows } from '../src/store/task-workflows.js';
import { agent, FixtureModel, setup, token, waitFor } from './helpers.js';

const input = {
  rows: [
    { keep: false, text: 'zero' },
    { keep: true, text: 'one' },
    { keep: false, text: 'two' },
    { keep: true, text: 'three' },
  ],
};
const bindings = new Set(['input', '$input']),
  signal = () => new AbortController().signal;
const step = {
  id: 'visit',
  tool: 'visit',
  foreach: { $ref: '$input#/rows', as: 'row', max_items: 4, where: { $expr: 'row.keep' } },
  arguments: { index: { $ref: '$index' }, text: { $ref: '$item#/text' } },
};
const parse = (s: unknown) => parseGraph({ steps: [s] }, new Set(['visit']), undefined, bindings);
const dsl = `agent "agent/selected" {
  model = "m"
  flow selected {
    step visit = $transform(index = $index, text = $item.text) foreach row in $input.rows (max=4) where $(row.keep && $index >= cutoff.value)
    step cutoff = $transform(value=1)
    return $visit
  }
}`;

test('foreach where: compile/format round trip, upstream dependencies and scoped source indices', async () => {
  const compiled = compileOaaLang(dsl),
    formatted = formatOaaLang(dsl);
  assert.match(formatted, / where /);
  assert.equal(canonical(compileOaaLang(formatted)), canonical(compiled));
  const wf = compiled.agent.workflows![0]!,
    plan = parsePublishedGraph({ steps: wf.steps, output: wf.output }, new Set());
  assert.deepEqual(plan.find((s) => s.id === 'visit')!.depends_on, ['cutoff']);
  const scope = { input, $input: input };
  const result = await executeGraph(
    plan,
    2,
    signal(),
    async () => assert.fail('pure transform must not call a tool'),
    undefined,
    scope,
  );
  assert.deepEqual(projectGraphOutput(wf.output, result, scope), [
    { index: 1, text: 'one' },
    { index: 3, text: 'three' },
  ]);
  assert.ok('where' in graphTool.parameters.properties.steps.items.properties.foreach.properties);
});
test('foreach where: the shipped example reads only the files the caller selected', async () => {
  const source = await readFile('examples/filtered-workflow.oaa', 'utf8');
  const compiled = compileOaaLang(source);
  assert.equal(canonical(compileOaaLang(formatOaaLang(source))), canonical(compiled));
  const wf = compiled.agent.workflows![0]!,
    plan = parsePublishedGraph({ steps: wf.steps, output: wf.output }, new Set(['read_file']));
  const input = {
    documents: [
      { path: 'skip.md', selected: false },
      { path: 'read.md', selected: true },
    ],
  };
  const bindings = { input, $input: input },
    seen: string[] = [];
  const result = await executeGraph(
    plan,
    1,
    signal(),
    async (s, args) => {
      seen.push(s.id);
      return args.path;
    },
    undefined,
    bindings,
  );
  assert.deepEqual(seen, ['files_1']);
  assert.deepEqual(projectGraphOutput(wf.output, result, bindings), ['read.md']);
});
test('foreach where: filtered writes never dispatch, kept branches may finish out of order without renumbering', async () => {
  const calls: string[] = [],
    finished: string[] = [],
    last = Promise.withResolvers<void>();
  const result = await executeGraph(
    parse(step),
    2,
    signal(),
    async (s, args) => {
      calls.push(s.id);
      if (args.index === 1) await last.promise;
      else last.resolve();
      finished.push(s.id);
      return args;
    },
    undefined,
    { input, $input: input },
  );
  assert.deepEqual(calls, ['visit_1', 'visit_3']);
  assert.deepEqual(finished, ['visit_3', 'visit_1']);
  assert.deepEqual(result.visit, [
    { index: 1, text: 'one' },
    { index: 3, text: 'three' },
  ]);
});
test('foreach where: check the original input cap and every predicate before dispatch or fallback', async () => {
  let calls = 0;
  const run = (s: unknown, rows: unknown[]) =>
    executeGraph(parse(s), 2, signal(), async () => ++calls, undefined, { $input: { rows } });
  assert.deepEqual(
    (await run({ ...step, foreach: { ...step.foreach, where: false } }, input.rows)).visit,
    [],
  );
  assert.deepEqual((await run(step, [])).visit, []);
  assert.deepEqual((await run({ ...step, when: false }, input.rows)).visit, { skipped: true });
  await assert.rejects(
    run({ ...step, foreach: { ...step.foreach, max_items: 3, where: false } }, input.rows),
    { code: 'foreach_limit_exceeded' },
  );
  await assert.rejects(
    run(
      {
        ...step,
        foreach: { ...step.foreach, where: { $ref: '$row#/keep' } },
        fallback: { value: 'must not mask a bad predicate' },
      },
      [input.rows[1], {}],
    ),
    { code: 'invalid_reference' },
  );
  assert.equal(calls, 0);
  assert.throws(() => parse({ ...step, when: { $expr: 'row.keep' } }), /before the loop/);
  assert.throws(
    () =>
      parse({ ...step, foreach: { ...step.foreach, where: { $expr: 'true || missing.value' } } }),
    /missing/,
  );
  assert.throws(
    () => parse({ ...step, foreach: { ...step.foreach, where: { $ref: '$absent' } } }),
    /absent/,
  );
  assert.throws(
    () => parse({ ...step, foreach: { ...step.foreach, as: 'index' } }),
    /reserves 'index'/,
  );
  assert.throws(
    () => compileOaaLang(dsl.replace('foreach row in $input.rows (max=4) ', '')),
    /preceding 'foreach'/,
  );
  assert.throws(
    () => compileOaaLang(dsl.replace('where $(', 'where true where $(')),
    /Duplicate 'where'/,
  );
  const never = { ...step, foreach: { ...step.foreach, max_items: 32, where: false } };
  assert.throws(
    () =>
      parsePublishedGraph(
        { steps: Array.from({ length: 33 }, (_, i) => ({ ...never, id: 'map' + i })) },
        new Set(['visit']),
      ),
    /1024/,
  );
  assert.throws(
    () =>
      parseGraph(
        { steps: [never, { id: 'visit_1', tool: 'visit', arguments: {} }] },
        new Set(['visit']),
      ),
    /collision/,
  );
  assert.throws(
    () =>
      parseGraph(
        { steps: [{ ...never, retry: { attempts: 1 } }] },
        new Set(['visit']),
        new Map([['visit', 'write']]),
      ),
    { code: 'unsafe_graph_retry' },
  );
});
test('foreach where: filter preflight yields to cancellation and never dispatches past a failed sibling', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => (now += 8));
  const controller = new AbortController(),
    seen: string[] = [];
  const visit = async (s: { id: string }) => {
    seen.push(s.id);
    return 1;
  };
  setImmediate(() => controller.abort());
  await assert.rejects(
    executeGraph(parse(step), 2, controller.signal, visit, undefined, { $input: input }),
    { code: 'cancelled' },
  );
  assert.equal(seen.length, 0);
  const siblings = parseGraph(
    { steps: [{ id: 'failure', tool: 'visit', arguments: {} }, step] },
    new Set(['visit']),
    undefined,
    bindings,
  );
  await assert.rejects(
    executeGraph(
      siblings,
      2,
      signal(),
      async (s) => {
        seen.push(s.id);
        if (s.id === 'failure') throw new Fault('execution_failed', 'fixture sibling failed', 500);
        return 1;
      },
      undefined,
      { $input: input },
    ),
    { code: 'execution_failed' },
  );
  assert.deepEqual(seen, ['failure']);
});
test('foreach where: a real workflow restart keeps selected source positions and does not repeat finished children', async () => {
  const s = await setup();
  let again: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    assert.ok((await s.request('GET', '/health')).json().features.includes('foreach-where-v1'));
    const definition = {
      id: 'probe',
      name: 'Filtered workflow',
      concurrency: 1,
      graph: {
        steps: [
          { id: 'source', tool: '$transform', arguments: { rows: input.rows } },
          {
            id: 'visit',
            tool: 'agent/test',
            arguments: { input: { $ref: '$row#/text' } },
            foreach: { ...step.foreach, $ref: 'source#/rows' },
          },
        ],
        output: { $ref: 'visit' },
      },
    };
    const saved = await s.request('POST', '/v1/workflows', { revision: 'new', definition });
    assert.equal(saved.statusCode, 200, saved.body);
    const config = path.join(s.dir, 'fixture.json');
    await writeFile(config, JSON.stringify(s.config));
    await s.app.close();
    const crash = spawnSync(
      process.execPath,
      [
        path.resolve('dist/test/fixtures/workflow-admission-crash.js'),
        config,
        'admission',
        'three',
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(crash.status, 73, crash.stderr);
    const driver = new FixtureModel();
    again = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    const records = new TaskWorkflows(again.store),
      execution = records.executions('owner')[0]!,
      ids = execution.nodes;
    assert.deepEqual(Object.keys(ids).sort(), ['visit_1', 'visit_3']);
    assert.equal(again.store.run(ids.visit_1!).status, 'completed');
    assert.equal(again.store.run(ids.visit_3!).status, 'queued');
    await again.listen();
    await waitFor(() => records.execution('owner', execution.id).status === 'completed');
    const done = records.execution('owner', execution.id);
    assert.deepEqual(done.nodes, ids);
    assert.deepEqual(
      (done.output as { run_id: string }[]).map((r) => r.run_id),
      [ids.visit_1, ids.visit_3],
    );
    assert.equal(again.store.allRuns().length, 2);
    assert.equal(driver.calls, 1);
    assert.deepEqual(again.auth.keyUsage(again.auth.authenticate('Bearer ' + token).keyId), {
      usedRuns: 2,
      usedTokens: 30,
      activeRuns: 0,
    });
  } finally {
    await again?.app.close();
    await s.cleanup();
  }
});
