import test from 'node:test';
import assert from 'node:assert/strict';
import { executeGraph, parseGraph } from '../src/lang/graph.js';
import { ApprovalSuspension, SchedulingSuspension } from '../src/core/suspension.js';
import { Fault } from '../src/core/util.js';

const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const graph = (steps: unknown[]) => parseGraph({ steps }, new Set(['work']));

test('a simultaneous success cannot admit more work after a sibling has already failed', async () => {
  const started: string[] = [];
  await assert.rejects(
    executeGraph(
      graph([
        { id: 'success', tool: 'work', arguments: {} },
        { id: 'failure', tool: 'work', arguments: {} },
        { id: 'later', tool: 'work', arguments: {} },
      ]),
      2,
      signal(),
      async (step) => {
        started.push(step.id);
        if (step.id === 'failure') throw new Fault('fixture_failure', 'Known failure');
        return true;
      },
    ),
    /Known failure/,
  );
  assert.deepEqual(started, ['success', 'failure']);
});

test('foreach branches share the graph concurrency budget and preserve item order', async () => {
  let active = 0,
    peak = 0;
  const steps = graph([
    { id: 'source', tool: '$transform', arguments: { items: [0, 1, 2, 3] } },
    ...['a', 'b', 'c'].map((id) => ({
      id,
      tool: 'work',
      foreach: { $ref: 'source#/items' },
      arguments: { value: { $ref: '$item' } },
    })),
  ]);
  const result = await executeGraph(steps, 2, signal(), async (_step, args) => {
    peak = Math.max(peak, ++active);
    await tick();
    active--;
    return args.value;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(result.a, [0, 1, 2, 3]);
  assert.deepEqual(result.b, result.a);
  assert.deepEqual(result.c, result.a);
});

test('a ready dependent runs without waiting for an unrelated slow sibling', async () => {
  const slow = Promise.withResolvers<void>();
  let dependent = false;
  const run = executeGraph(
    graph([
      { id: 'slow', tool: 'work', arguments: {} },
      { id: 'fast', tool: 'work', arguments: {} },
      { id: 'child', tool: 'work', arguments: { parent: { $ref: 'fast' } } },
    ]),
    2,
    signal(),
    async (step, args) => {
      if (step.id === 'slow') await slow.promise;
      if (step.id === 'child') {
        dependent = true;
        assert.equal(args.parent, 'fast');
      }
      return step.id;
    },
  );
  try {
    await tick();
    assert.equal(dependent, true);
  } finally {
    slow.resolve();
    await run;
  }
});

test('foreach drains started siblings and preserves uncertain failure precedence', async () => {
  const gate = Promise.withResolvers<void>();
  const started: string[] = [];
  let settled = false;
  const run = executeGraph(
    graph([
      { id: 'source', tool: '$transform', arguments: { items: [0, 1, 2] } },
      { id: 'mapped', tool: 'work', foreach: { $ref: 'source#/items' }, arguments: {} },
    ]),
    2,
    signal(),
    async (step) => {
      started.push(step.id);
      if (step.id === 'mapped_0') throw new Fault('known', 'Known failure');
      await gate.promise;
      throw new Fault('unknown', 'Uncertain write', 409, true);
    },
  );
  const result = run
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  try {
    await tick();
    assert.equal(settled, false);
    assert.deepEqual(started, ['mapped_0', 'mapped_1']);
  } finally {
    gate.resolve();
  }
  const error = await result;
  assert.ok(error instanceof Fault && error.uncertain);
  assert.deepEqual(started, ['mapped_0', 'mapped_1']);
});

test('graph boundaries stop admission but drain every started invocation', async () => {
  const gate = Promise.withResolvers<void>();
  const started: string[] = [];
  let settled = false;
  const run = executeGraph(
    graph([
      { id: 'slow', tool: 'work', arguments: {} },
      { id: 'fast', tool: 'work', arguments: {} },
      { id: 'later', tool: 'work', arguments: {} },
    ]),
    2,
    signal(),
    async (step) => {
      started.push(step.id);
      if (step.id === 'slow') await gate.promise;
      return step.id;
    },
    () => {
      throw new SchedulingSuspension();
    },
  );
  const result = run
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await tick();
    assert.equal(settled, false);
    assert.deepEqual(started, ['slow', 'fast']);
  } finally {
    gate.resolve();
  }
  assert.ok((await result) instanceof SchedulingSuspension);
  assert.deepEqual(started, ['slow', 'fast']);
});

test('a blocked foreach does not prevent independent graph work or lose sibling approvals', async () => {
  const started: string[] = [];
  await assert.rejects(
    executeGraph(
      graph([
        { id: 'source', tool: '$transform', arguments: { items: [0, 1] } },
        { id: 'mapped', tool: 'work', foreach: { $ref: 'source#/items' }, arguments: {} },
        { id: 'independent', tool: 'work', depends_on: ['source'], arguments: {} },
        { id: 'blocked', tool: 'work', depends_on: ['mapped'], arguments: {} },
      ]),
      3,
      signal(),
      async (step) => {
        started.push(step.id);
        if (step.id.startsWith('mapped')) throw new ApprovalSuspension([step.id]);
        return true;
      },
    ),
    (error) =>
      error instanceof ApprovalSuspension &&
      assert.deepEqual(error.approvalIds.sort(), ['mapped_0', 'mapped_1']) === undefined,
  );
  assert.ok(started.includes('independent'));
  assert.ok(!started.includes('blocked'));
});

test('cancellation drains active work and never starts queued foreach items', async () => {
  const controller = new AbortController();
  const gate = Promise.withResolvers<void>();
  const started: string[] = [];
  const run = executeGraph(
    graph([
      { id: 'source', tool: '$transform', arguments: { items: [0, 1, 2, 3] } },
      { id: 'mapped', tool: 'work', foreach: { $ref: 'source#/items' }, arguments: {} },
    ]),
    2,
    controller.signal,
    async (step) => {
      started.push(step.id);
      await gate.promise;
      return step.id;
    },
  );
  const rejected = assert.rejects(
    run,
    (error) => error instanceof Fault && error.code === 'cancelled',
  );
  await tick();
  controller.abort();
  gate.resolve();
  await rejected;
  assert.deepEqual(started, ['mapped_0', 'mapped_1']);
});

test('generated foreach and fallback IDs cannot alias another durable graph step', () => {
  for (const steps of [
    [
      { id: 'source', tool: '$transform', arguments: { items: [] } },
      { id: 'mapped', tool: 'work', foreach: { $ref: 'source#/items' }, arguments: {} },
      { id: 'mapped_0', tool: 'work', arguments: {} },
    ],
    [
      { id: 'read', tool: 'work', arguments: {}, fallback: { tool: 'work' } },
      { id: 'read_fallback', tool: 'work', arguments: {} },
    ],
  ])
    assert.throws(() => graph(steps), /collision|collid/i);
});

test('invalid concurrency is rejected rather than hanging or silently returning incomplete results', async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      executeGraph(
        graph([{ id: 'a', tool: 'work', arguments: {} }]),
        concurrency,
        signal(),
        async () => true,
      ),
      /concurrency/i,
    );
  }
});

test('empty and skipped maps release dependents, and completion order never changes array order', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const order: number[] = [];
  const run = executeGraph(
    graph([
      { id: 'source', tool: '$transform', arguments: { empty: [], items: [0, 1] } },
      { id: 'empty', tool: 'work', foreach: { $ref: 'source#/empty' }, arguments: {} },
      {
        id: 'skip',
        tool: 'work',
        when: false,
        foreach: { $ref: 'source#/invalid' },
        arguments: {},
      },
      {
        id: 'mapped',
        tool: 'work',
        foreach: { $ref: 'source#/items' },
        arguments: { index: { $ref: '$index' } },
      },
      {
        id: 'join',
        tool: '$transform',
        arguments: { empty: { $ref: 'empty' }, skip: { $ref: 'skip' }, result: { $ref: 'mapped' } },
      },
    ]),
    2,
    signal(),
    async (_step, args) => {
      const index = Number(args.index);
      await gates[index]!.promise;
      order.push(index);
      return index;
    },
  );
  gates[1]!.resolve();
  try {
    await tick();
    assert.deepEqual(order, [1]);
  } finally {
    gates[0]!.resolve();
  }
  const result = await run;
  assert.deepEqual(result.join, { empty: [], skip: { skipped: true }, result: [0, 1] });
});

test('reference initialization failure drains active work and cannot hide an uncertain sibling', async () => {
  const gate = Promise.withResolvers<void>();
  let settled = false;
  const result = executeGraph(
    graph([
      { id: 'running', tool: 'work', arguments: {} },
      { id: 'bad', tool: 'work', foreach: { $ref: '$input#/missing' }, arguments: {} },
    ]),
    2,
    signal(),
    async () => {
      await gate.promise;
      throw new Fault('unknown', 'Uncertain fixture', 409, true);
    },
    undefined,
    { $input: {} },
  )
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await tick();
    assert.equal(settled, false);
  } finally {
    gate.resolve();
  }
  const error = await result;
  assert.ok(error instanceof Fault && error.uncertain);
});
