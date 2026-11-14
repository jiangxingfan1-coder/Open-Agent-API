import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySchema, type Effect, type ToolBinding } from '../src/core/contracts.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { graphToolEffects } from '../src/lang/graph.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { LocalHandler } from '../src/fabric/worker.js';
import { ToolCache } from '../src/kernel/tool-cache.js';
import { ExecutionPool } from '../src/kernel/execution-pool.js';
import { Fault } from '../src/core/util.js';
import { setup, agent, FixtureModel, principal, waitFor } from './helpers.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function tool(
  s: Awaited<ReturnType<typeof setup>>,
  name: string,
  effect: Effect,
  handler: LocalHandler,
): ToolBinding {
  const capability = capabilitySchema.parse({
    id: `fixture/${name}`,
    version: '1',
    description: 'Owned local kernel fixture',
    placement: 'host-bound',
    nodeId: 'local',
    effect,
    cacheTtlMs: effect === 'read' ? 60000 : 0,
    inputSchema: { type: 'object' },
  });
  s.runtime.config.tools.push({
    reference: name,
    capability,
    handler: { kind: 'read_directory', root: s.dir },
  });
  s.runtime.handlers.set(name, handler);
  return { name, capability, handler: { kind: 'node', reference: name } };
}

test('parallel graphs and nested workflows share one per-run leaf budget', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : {
            calls: ['left', 'right'].map((id) => ({
              id,
              name: 'execute_graph',
              arguments: {
                steps: [
                  { id: 'flow', tool: 'flow', arguments: { value: id } },
                  { id: 'direct', tool: 'work', arguments: { value: `${id}-direct` } },
                ],
              },
            })),
          },
    ),
  );
  try {
    const binding = tool(s, 'work', 'read', async (args) => {
      calls++;
      peak = Math.max(peak, ++active);
      await tick();
      active--;
      return { value: args.value };
    });
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [binding],
          limits: { toolConcurrency: 2 },
          workflows: [
            {
              name: 'flow',
              inputSchema: { type: 'object' },
              steps: [
                { id: 'source', tool: '$transform', arguments: { items: [0, 1, 2, 3] } },
                {
                  id: 'mapped',
                  tool: 'work',
                  foreach: { $ref: 'source#/items' },
                  arguments: { value: { $template: '{{$input#/value}}-{{$item}}' } },
                },
              ],
            },
          ],
        }),
      ),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.equal(peak, 2);
    assert.equal(calls, 10);
    assert.equal(active, 0);
    assert.equal(s.store.steps(run.id).filter((step) => step.status === 'completed').length, 10);
  } finally {
    await s.cleanup();
  }
});

test('a read finishing after a parallel write cannot repopulate stale cached data', async () => {
  const readStarted = Promise.withResolvers<void>();
  const writeFinished = Promise.withResolvers<void>();
  let value = 0,
    reads = 0,
    writes = 0;
  const s = await setup(
    new FixtureModel((_a, messages) => {
      const count = messages.filter((m) => m.role === 'tool').length;
      if (!count)
        return {
          calls: [
            { id: 'read0', name: 'read_value', arguments: {} },
            { id: 'write', name: 'write_value', arguments: {} },
          ],
        };
      if (count === 2) return { calls: [{ id: 'read1', name: 'read_value', arguments: {} }] };
      return { text: messages.filter((m) => m.role === 'tool').at(-1)!.content };
    }),
  );
  try {
    const read = tool(s, 'read_value', 'read', async () => {
      reads++;
      const captured = value;
      if (reads === 1) {
        readStarted.resolve();
        await writeFinished.promise;
        await tick();
      }
      return { value: captured };
    });
    const write = tool(s, 'write_value', 'write', async () => {
      writes++;
      await readStarted.promise;
      value = 1;
      writeFinished.resolve();
      return { value };
    });
    s.store.publish(
      'owner',
      makeBundle(agent({ tools: [read, write], limits: { toolConcurrency: 2 } })),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.output.at(-1)!.text, '1');
    assert.equal(reads, 2);
    assert.equal(writes, 1);
  } finally {
    readStarted.resolve();
    writeFinished.resolve();
    await s.cleanup();
  }
});

test('read cache fences late fills, reads during writes, and overlapping write completion', () => {
  const cache = new ToolCache();
  const before = cache.beginRead();
  cache.set('before', { value: 0 }, 1000, before);
  const endA = cache.beginWrite();
  assert.equal(cache.get('before'), undefined);
  const during = cache.beginRead();
  const endB = cache.beginWrite();
  endA();
  assert.equal(cache.beginRead(), undefined);
  endB();
  endB();
  cache.set('late', { value: 0 }, 1000, before);
  cache.set('during', { value: 0 }, 1000, during);
  assert.equal(cache.get('late'), undefined);
  assert.equal(cache.get('during'), undefined);
  cache.set('fresh', { value: 1 }, 1000, cache.beginRead());
  assert.deepEqual(cache.get('fresh'), { value: 1 });
});

test('read cache is byte-bounded, expires, evicts LRU entries, and isolates returned values', () => {
  let now = 10;
  const cache = new ToolCache(2, 100, () => now);
  const generation = cache.beginRead();
  const value = { value: { x: 1 } };
  cache.set('a', value, 20, generation);
  value.value.x = 9;
  cache.set('b', { value: 2 }, 20, generation);
  const read = cache.get('a')!;
  assert.deepEqual(read, { value: { x: 1 } });
  read.value = { x: 22 };
  cache.set('c', { value: 3 }, 20, generation);
  assert.equal(cache.get('b'), undefined);
  assert.deepEqual(cache.get('a'), { value: { x: 1 } });
  cache.set('large', { value: 'x'.repeat(200) }, 20, generation);
  assert.equal(cache.get('large'), undefined);
  cache.set('d', { value: 'x'.repeat(70) }, 20, generation);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);
  assert.ok(cache.get('d'));
  now = 30;
  assert.equal(cache.get('d'), undefined);
});

test('leaf permits are released on failure and cancelled waiters never dispatch', async () => {
  const pool = new ExecutionPool(1);
  const gate = Promise.withResolvers<void>();
  const controller = new AbortController();
  const first = pool.run(controller.signal, async () => {
    await gate.promise;
    throw new Error('fixture');
  });
  let dispatched = false;
  const queued = pool.run(controller.signal, async () => {
    dispatched = true;
  });
  const firstError = assert.rejects(first, /fixture/);
  const queuedError = assert.rejects(
    queued,
    (error) => error instanceof Fault && error.code === 'cancelled',
  );
  controller.abort();
  gate.resolve();
  await Promise.all([firstError, queuedError]);
  assert.equal(dispatched, false);
  assert.equal(await pool.run(new AbortController().signal, async () => 42), 42);
});

test('workflow effects propagate transitively without assuming compound write idempotency', () => {
  const definition = agent({
    tools: [builtin('read_file'), builtin('write_file')],
    delegates: [{ name: 'delegate', agent: 'agent/child' }],
    workflows: [
      { name: 'read_only', steps: [{ id: 'a', tool: 'read_file', arguments: {} }] },
      { name: 'writing', steps: [{ id: 'a', tool: 'write_file', arguments: {} }] },
      { name: 'nested', steps: [{ id: 'a', tool: 'writing', arguments: {} }] },
      { name: 'opaque', steps: [{ id: 'a', tool: 'delegate', arguments: { task: 'fixture' } }] },
    ],
  });
  makeBundle(definition);
  const effects = graphToolEffects(definition);
  assert.equal(effects.get('read_only'), 'read');
  assert.equal(effects.get('writing'), 'write');
  assert.equal(effects.get('nested'), 'write');
  assert.equal(effects.get('opaque'), 'unknown');
  for (const name of ['writing', 'nested', 'opaque', 'delegate']) {
    assert.throws(
      () =>
        makeBundle(
          agent({
            ...definition,
            workflows: [
              ...definition.workflows!,
              {
                name: 'mask',
                steps: [{ id: 'a', tool: name, arguments: {}, fallback: { value: null } }],
              },
            ],
          }),
        ),
      /Fallback cannot mask/,
    );
  }
  assert.doesNotThrow(() =>
    makeBundle(
      agent({
        ...definition,
        workflows: [
          ...definition.workflows!,
          {
            name: 'safe',
            steps: [{ id: 'a', tool: 'read_only', arguments: {}, fallback: { value: null } }],
          },
        ],
      }),
    ),
  );
});

test('a dynamic graph cannot hide a writing workflow behind a read-only fallback', async () => {
  let writes = 0;
  const s = await setup(
    new FixtureModel(() => ({
      calls: [
        {
          id: 'graph',
          name: 'execute_graph',
          arguments: {
            steps: [
              { id: 'effect', tool: 'writing', arguments: {}, fallback: { value: { ok: true } } },
            ],
          },
        },
      ],
    })),
  );
  try {
    const write = tool(s, 'write_value', 'write', async () => ({ value: ++writes }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [write],
          workflows: [
            {
              name: 'writing',
              steps: [{ id: 'a', tool: 'write_value', arguments: {} }],
            },
          ],
        }),
      ),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'unsafe_graph_fallback');
    assert.equal(writes, 0);
  } finally {
    await s.cleanup();
  }
});

test('foreach approval readmission reuses confirmed siblings and never repeats a write or model turn', async () => {
  const writes: number[] = [];
  let reads = 0;
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: messages.find((m) => m.role === 'tool')!.content }
        : {
            calls: [
              {
                id: 'graph',
                name: 'execute_graph',
                arguments: {
                  steps: [
                    { id: 'source', tool: '$transform', arguments: { items: [0, 1] } },
                    {
                      id: 'mapped',
                      tool: 'guarded',
                      foreach: { $ref: 'source#/items' },
                      arguments: { item: { $ref: '$item' } },
                    },
                    { id: 'independent', tool: 'read_value', arguments: {} },
                  ],
                },
              },
            ],
          },
    ),
    { approvalTimeoutMs: 5000 },
  );
  try {
    const guarded = tool(s, 'guarded', 'write', async (args) => {
      writes.push(Number(args.item));
      return { value: args.item };
    });
    guarded.capability.requiresApproval = true;
    const read = tool(s, 'read_value', 'read', async () => ({ value: ++reads }));
    s.store.publish(
      'owner',
      makeBundle(agent({ tools: [guarded, read], limits: { toolConcurrency: 2 } })),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    await waitFor(() => !!s.store.run(run.id).checkpoint.suspension);
    const approvals = s.store.approvals(run.id).filter((approval) => approval.status === 'pending');
    // An approval blocks the map's later admission; approve newly discovered items as well.
    assert.ok(approvals.length > 0);
    for (const approval of approvals) s.kernel.decide(principal, run.id, approval.id, 'approve');
    await waitFor(
      () =>
        s.store.run(run.id).status === 'completed' ||
        (!!s.store.run(run.id).checkpoint.suspension &&
          s.store.approvals(run.id).some((a) => a.status === 'pending')),
    );
    for (const approval of s.store.approvals(run.id).filter((a) => a.status === 'pending'))
      s.kernel.decide(principal, run.id, approval.id, 'approve');
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(JSON.parse(done.output.at(-1)!.text).mapped, [0, 1]);
    assert.deepEqual(writes.sort(), [0, 1]);
    assert.equal(reads, 1);
    assert.equal(s.driver.calls, 2);
    assert.equal(s.store.approvals(run.id).length, 2);
  } finally {
    await s.cleanup();
  }
});
