import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { capabilitySchema, type ToolBinding, type ToolCall } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime, type LocalHandler } from '../src/fabric/worker.js';
import {
  ApprovalSuspension,
  SchedulingSuspension,
  collectSuspensions,
} from '../src/core/suspension.js';
import { Fault, sleep, sha } from '../src/core/util.js';
import { setup, FixtureModel, agent, principal, token, waitFor } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof setup>>;
const submit = (s: Fixture, id = 'agent/long', input = 'fixture') =>
  s.kernel.submit(principal, invocationSchema.parse({ agent: id, input, background: true }));
function tool(s: Fixture, name: string, handler: LocalHandler, approval = false): ToolBinding {
  const capability = capabilitySchema.parse({
    id: `fixture/${name}`,
    version: '1',
    description: 'Controlled cooperative scheduling fixture',
    placement: 'host-bound',
    nodeId: 'local',
    effect: approval ? 'write' : 'read',
    requiresApproval: approval,
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
function publish(s: Fixture, tools: ToolBinding[], limits: Record<string, number> = {}) {
  s.store.publish('owner', makeBundle(agent({ id: 'agent/long', tools, limits })));
  s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
}
const calls = (n: number, name = 'lookup'): ToolCall[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name, arguments: { item: i } }));
const graph = (id: string, name = 'lookup'): ToolCall => ({
  id,
  name: 'execute_graph',
  arguments: {
    steps: [
      { id: 'first', tool: name, arguments: { item: 0 } },
      { id: 'second', tool: name, arguments: { item: 1, previous: { $ref: 'first#/item' } } },
    ],
  },
});
const yielding = (s: Fixture, runId: string) =>
  waitFor(() => s.store.run(runId).checkpoint.suspension?.kind === 'scheduling');

test('a completed model turn yields the only slot and is not repeated on readmission', async () => {
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const model = new FixtureModel(async (definition, messages) => {
    if (definition.id === 'agent/quick') {
      order.push('quick');
      return { text: 'quick' };
    }
    if (messages.some((m) => m.role === 'tool')) {
      order.push('final');
      return { text: 'done' };
    }
    order.push('plan');
    await gate.promise;
    return { text: 'Planning finished.', calls: calls(1) };
  });
  const s = await setup(model, { maxActiveRuns: 1 });
  try {
    publish(s, [
      tool(s, 'lookup', async () => {
        order.push('tool');
        return { value: 1 };
      }),
    ]);
    const long = submit(s);
    await waitFor(() => order.length === 1);
    const quick = submit(s, 'agent/quick');
    gate.resolve();
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    const done = await s.kernel.wait(long.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(order, ['plan', 'quick', 'tool', 'final']);
    assert.equal(model.calls, 3);
    assert.equal(done.checkpoint.turn, 2);
    assert.equal(done.usage!.total_tokens, 30);
    assert.deepEqual(
      done.output.map((m) => m.text),
      ['Planning finished.', 'done'],
    );
    assert.equal(
      s.store.history(long.id).filter((e) => e.type === 'response.output_text.done').length,
      2,
    );
    assert.equal(
      s.store
        .history(long.id)
        .filter((e) => e.type === 'run.queued' && e.data.reason === 'fairness').length,
      1,
    );
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('a tool batch yields only after every already-started sibling has settled', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started: number[] = [],
    completed: number[] = [];
  let quickStarted = false;
  const s = await setup(
    new FixtureModel((definition, messages) => {
      if (definition.id === 'agent/quick') {
        quickStarted = true;
        assert.deepEqual(completed, [0, 1]);
        return { text: 'quick' };
      }
      return messages.some((m) => m.role === 'tool') ? { text: 'done' } : { calls: calls(4) };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    publish(
      s,
      [
        tool(s, 'lookup', async (args) => {
          const item = Number(args.item);
          started.push(item);
          if (item < 2) await gates[item]!.promise;
          completed.push(item);
          return { value: item };
        }),
      ],
      { toolConcurrency: 2 },
    );
    const long = submit(s);
    await waitFor(() => started.length === 2);
    const quick = submit(s, 'agent/quick');
    gates[0]!.resolve();
    await waitFor(() => completed.length === 1);
    assert.equal(quickStarted, false);
    gates[1]!.resolve();
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    assert.equal((await s.kernel.wait(long.id)).status, 'completed');
    assert.deepEqual(started.slice(0, 2).sort(), [0, 1]);
    assert.deepEqual(started.slice(2).sort(), [2, 3]);
    assert.equal(s.driver.calls, 3);
  } finally {
    gates.forEach((g) => g.resolve());
    await s.cleanup();
  }
});

test('dependent graphs yield between ready batches and reuse confirmed dependency values', async () => {
  const gate = Promise.withResolvers<void>();
  const started: number[] = [];
  const s = await setup(
    new FixtureModel((definition, messages) => {
      if (definition.id === 'agent/quick') {
        assert.deepEqual(started, [0]);
        return { text: 'quick' };
      }
      if (messages.some((m) => m.role === 'tool')) {
        const result = JSON.parse(messages.find((m) => m.role === 'tool')!.content);
        assert.deepEqual(result, { first: { item: 0 }, second: { item: 1 } });
        return { text: 'done' };
      }
      return { calls: [graph('graph')] };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    publish(s, [
      tool(s, 'lookup', async (args) => {
        started.push(Number(args.item));
        if (args.item === 0) await gate.promise;
        else assert.equal(args.previous, 0);
        return { value: { item: args.item } };
      }),
    ]);
    const long = submit(s);
    await waitFor(() => started.length === 1);
    const quick = submit(s, 'agent/quick');
    gate.resolve();
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    assert.equal((await s.kernel.wait(long.id)).status, 'completed');
    assert.deepEqual(started, [0, 1]);
    assert.equal(s.driver.calls, 3);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('parallel graph suspension drains siblings before admitting another run', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started: string[] = [];
  let quickStarted = false;
  const s = await setup(
    new FixtureModel((definition, messages) => {
      if (definition.id === 'agent/quick') {
        quickStarted = true;
        return { text: 'quick' };
      }
      return messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : { calls: [graph('left', 'left'), graph('right', 'right')] };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    publish(
      s,
      ['left', 'right'].map((name, i) =>
        tool(s, name, async (args) => {
          started.push(`${name}:${args.item}`);
          if (args.item === 0) await gates[i]!.promise;
          else assert.equal(args.previous, 0);
          return { value: { item: args.item } };
        }),
      ),
      { toolConcurrency: 2 },
    );
    const long = submit(s);
    await waitFor(() => started.length === 2);
    const quick = submit(s, 'agent/quick');
    gates[0]!.resolve();
    await waitFor(() =>
      s.store.steps(long.id).some((step) => step.name === 'left' && step.status === 'completed'),
    );
    assert.equal(quickStarted, false);
    assert.equal(s.store.run(long.id).status, 'in_progress');
    gates[1]!.resolve();
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    assert.equal((await s.kernel.wait(long.id)).status, 'completed');
    assert.deepEqual(started.sort(), ['left:0', 'left:1', 'right:0', 'right:1']);
  } finally {
    gates.forEach((g) => g.resolve());
    await s.cleanup();
  }
});

test('FIFO checkpoint readmission makes progress for every contending run without replay loops', async () => {
  const order: string[] = [];
  const s = await setup(
    new FixtureModel((_definition, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : {
            calls: calls(2).map((call) => ({
              ...call,
              arguments: {
                ...call.arguments,
                task: messages.find((m) => m.role === 'user')!.content,
              },
            })),
          },
    ),
    { maxActiveRuns: 1 },
  );
  try {
    publish(
      s,
      [
        tool(s, 'lookup', async (args) => {
          order.push(`${args.task}:${args.item}`);
          return { value: args.item };
        }),
      ],
      { toolConcurrency: 1 },
    );
    const runs = ['A', 'B', 'C'].map((input) => submit(s, 'agent/long', input));
    for (const run of runs) assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.deepEqual(order, ['A:0', 'B:0', 'C:0', 'A:1', 'B:1', 'C:1']);
    assert.equal(s.driver.calls, 6);
    for (const run of runs) assert.equal(s.store.steps(run.id).length, 2);
  } finally {
    await s.cleanup();
  }
});

test('cancellation at the durable yield event cannot requeue or execute the cancelled task', async () => {
  const gate = Promise.withResolvers<void>();
  let tools = 0;
  const s = await setup(
    new FixtureModel(async (definition) => {
      if (definition.id === 'agent/quick') return { text: 'quick' };
      await gate.promise;
      return { calls: calls(1) };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    publish(s, [tool(s, 'lookup', async () => ({ value: ++tools }))]);
    const long = submit(s);
    await waitFor(() => s.driver.calls === 1);
    let cancellation: ReturnType<typeof s.kernel.cancel> | undefined;
    s.store.events.on(long.id, (event) => {
      if (event.type === 'run.queued' && event.data.reason === 'fairness')
        cancellation = s.kernel.cancel(principal, long.id);
    });
    const quick = submit(s, 'agent/quick');
    gate.resolve();
    assert.equal((await s.kernel.wait(long.id)).status, 'cancelled');
    await cancellation;
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    assert.equal(tools, 0);
    assert.equal(s.store.run(long.id).status, 'cancelled');
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('a yielded run expires on its original deadline while the next run still owns the slot', async () => {
  const longGate = Promise.withResolvers<void>(),
    quickGate = Promise.withResolvers<void>();
  let tools = 0;
  const s = await setup(
    new FixtureModel(async (definition) => {
      if (definition.id === 'agent/quick') {
        await quickGate.promise;
        return { text: 'quick' };
      }
      await longGate.promise;
      return { calls: calls(1) };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    publish(s, [tool(s, 'lookup', async () => ({ value: ++tools }))], { timeoutMs: 150 });
    const long = submit(s);
    await waitFor(() => s.driver.calls === 1);
    const deadline = s.store.run(long.id).checkpoint.deadlineAt;
    const quick = submit(s, 'agent/quick');
    longGate.resolve();
    const done = await s.kernel.wait(long.id);
    assert.equal(done.status, 'incomplete');
    assert.equal(done.error?.code, 'run_timeout');
    assert.equal(done.checkpoint.deadlineAt, deadline);
    assert.equal(s.store.run(quick.id).status, 'in_progress');
    assert.equal(tools, 0);
    quickGate.resolve();
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
  } finally {
    longGate.resolve();
    quickGate.resolve();
    await s.cleanup();
  }
});

test('approval denial during fair readmission stops the remaining independent branch', async () => {
  const toolGate = Promise.withResolvers<void>(),
    quickGate = Promise.withResolvers<void>();
  const started: number[] = [];
  let guarded = 0;
  const s = await setup(
    new FixtureModel(async (definition, messages) => {
      if (definition.id === 'agent/quick') {
        await quickGate.promise;
        return { text: 'quick' };
      }
      return messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : { calls: [graph('graph'), ...calls(1, 'guarded')] };
    }),
    { maxActiveRuns: 1, approvalTimeoutMs: 5000 },
  );
  try {
    publish(
      s,
      [
        tool(s, 'lookup', async (args) => {
          started.push(Number(args.item));
          if (args.item === 0) await toolGate.promise;
          return { value: { item: args.item } };
        }),
        tool(s, 'guarded', async () => ({ value: ++guarded }), true),
      ],
      { toolConcurrency: 2 },
    );
    const long = submit(s);
    await waitFor(() => started.length === 1 && s.store.approvals(long.id).length === 1);
    const quick = submit(s, 'agent/quick');
    toolGate.resolve();
    await yielding(s, long.id);
    const action = s.store.approvals(long.id)[0]!;
    assert.deepEqual(s.store.run(long.id).checkpoint.suspension!.approvalIds, [action.id]);
    s.kernel.decide(principal, long.id, action.id, 'deny');
    const done = await s.kernel.wait(long.id);
    assert.equal(done.error?.code, 'permission_denied');
    assert.equal(done.status, 'failed');
    assert.deepEqual(started, [0]);
    assert.equal(guarded, 0);
    quickGate.resolve();
    await s.kernel.wait(quick.id);
  } finally {
    toolGate.resolve();
    quickGate.resolve();
    await s.cleanup();
  }
});

test('queued checkpoint recovery reuses confirmed artifacts without another planning turn', async () => {
  const gate = Promise.withResolvers<void>();
  const completed: number[] = [];
  const s = await setup(
    new FixtureModel(async (definition, _messages, signal) => {
      if (definition.id === 'agent/quick') {
        await sleep(10000, signal);
        return { text: 'late' };
      }
      return { calls: calls(2) };
    }),
    { maxActiveRuns: 1 },
  );
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  const handler: LocalHandler = async (args) => {
    if (args.item === 0) await gate.promise;
    completed.push(Number(args.item));
    const text = `fixture ${args.item}`;
    return {
      value: args.item,
      artifacts: [
        {
          name: `${args.item}.txt`,
          content: Buffer.from(text).toString('base64'),
          sha256: sha(text),
        },
      ],
    };
  };
  try {
    publish(s, [tool(s, 'lookup', handler)], { toolConcurrency: 1 });
    const long = submit(s);
    await waitFor(() => s.store.steps(long.id).some((step) => step.status === 'running'));
    submit(s, 'agent/quick');
    gate.resolve();
    await yielding(s, long.id);
    const deadline = s.store.run(long.id).checkpoint.deadlineAt;
    assert.equal(s.store.run(long.id).artifactIds.length, 1);
    await s.app.close();
    const model = new FixtureModel((_definition, messages) => {
      assert.equal(messages.filter((m) => m.role === 'tool').length, 2);
      return { text: 'resumed' };
    });
    const runtime = new WorkerRuntime(
      s.runtime.config,
      new Map([['lookup', handler]]),
      new Map([['fixture', model]]),
    );
    replacement = await createGateway(s.config, runtime);
    assert.equal(replacement.store.run(long.id).status, 'queued');
    replacement.kernel.start();
    const done = await replacement.kernel.wait(long.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.checkpoint.deadlineAt, deadline);
    assert.equal(done.artifactIds.length, 2);
    assert.equal(model.calls, 1);
    assert.deepEqual(completed, [0, 1]);
  } finally {
    gate.resolve();
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('uncertain external effects take precedence over cooperative yield and pending approval', () => {
  const uncertain = new Fault('effect_outcome_unknown', 'Uncertain fixture', 409, true);
  assert.throws(
    () =>
      collectSuspensions([
        { status: 'rejected', reason: new SchedulingSuspension(['prior']) },
        { status: 'rejected', reason: new ApprovalSuspension(['pending']) },
        { status: 'rejected', reason: new Fault('known_failure', 'Known fixture') },
        { status: 'rejected', reason: uncertain },
      ]),
    (error) => error === uncertain,
  );
});

test('a failed scheduling checkpoint cannot release an uncommitted run back into the queue', async () => {
  const gate = Promise.withResolvers<void>();
  let tools = 0;
  const s = await setup(
    new FixtureModel(async (definition) => {
      if (definition.id === 'agent/quick') return { text: 'quick' };
      await gate.promise;
      return { calls: calls(1) };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    publish(s, [tool(s, 'lookup', async () => ({ value: ++tools }))]);
    const long = submit(s);
    await waitFor(() => s.driver.calls === 1);
    const quick = submit(s, 'agent/quick');
    s.store.db.exec(`CREATE TRIGGER fail_fair_checkpoint BEFORE INSERT ON events
      WHEN NEW.type='run.queued' AND json_extract(NEW.payload,'$.reason')='fairness'
      BEGIN SELECT RAISE(ABORT, 'fixture scheduling checkpoint failure'); END;`);
    gate.resolve();
    const done = await s.kernel.wait(long.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'persistence_failed');
    assert.equal(done.checkpoint.suspension, undefined);
    assert.equal(
      s.store.history(long.id).some((event) => event.type === 'run.queued'),
      false,
    );
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    assert.equal(tools, 0);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

for (const api of ['responses', 'chat'] as const)
  test(`the official SDK ${api} stream follows one run across checkpoint readmission`, async () => {
    const gate = Promise.withResolvers<void>();
    let tools = 0;
    const s = await setup(
      new FixtureModel(async (definition, messages) => {
        if (definition.id === 'agent/quick') {
          assert.equal(tools, 0);
          return { text: 'quick' };
        }
        if (messages.some((m) => m.role === 'tool')) return { text: 'done' };
        await gate.promise;
        return { text: 'prefix.', calls: calls(1) };
      }),
      { maxActiveRuns: 1 },
    );
    try {
      publish(s, [tool(s, 'lookup', async () => ({ value: ++tools }))]);
      const url = await s.listen();
      const client = new OpenAI({
        apiKey: token,
        baseURL: url + '/v1',
        maxRetries: 0,
        timeout: 1000,
      });
      let runId: string,
        text = '',
        completed = 0,
        tokens = 0;
      const admitQuick = async () => {
        await waitFor(() => s.driver.calls === 1);
        const quick = submit(s, 'agent/quick');
        gate.resolve();
        assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
      };
      if (api === 'responses') {
        const { data: stream, response } = await client.responses
          .create({
            model: 'agent/long',
            input: 'fixture',
            stream: true,
          })
          .withResponse();
        runId = response.headers.get('x-run-id')!;
        assert.match(runId, /^resp_[a-z0-9]+$/);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('cache-control'), 'no-store, no-cache');
        await admitQuick();
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') text += event.delta;
          if (event.type === 'response.completed') {
            completed++;
            assert.equal(event.response.id, runId);
            tokens = event.response.usage!.total_tokens;
          }
        }
      } else {
        const { data: stream, response } = await client.chat.completions
          .create({
            model: 'agent/long',
            messages: [{ role: 'user', content: 'fixture' }],
            stream: true,
            stream_options: { include_usage: true },
          })
          .withResponse();
        runId = response.headers.get('x-run-id')!;
        assert.match(runId, /^resp_[a-z0-9]+$/);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('cache-control'), 'no-store, no-cache');
        await admitQuick();
        for await (const chunk of stream) {
          assert.equal(chunk.id, `chatcmpl_${runId}`);
          text += chunk.choices[0]?.delta.content ?? '';
          if (chunk.choices[0]?.finish_reason === 'stop') completed++;
          if (chunk.usage) tokens = chunk.usage.total_tokens;
        }
      }
      assert.equal(text, 'prefix.done');
      assert.equal(completed, 1);
      assert.equal(tokens, 30);
      assert.equal(tools, 1);
      assert.equal(s.driver.calls, 3);
      assert.equal(s.store.run(runId).status, 'completed');
      assert.equal(
        s.store
          .history(runId)
          .filter((e) => e.type === 'run.queued' && e.data.reason === 'fairness').length,
        1,
      );
      assert.equal(
        s.store.history(runId).filter((e) => e.type === 'response.in_progress').length,
        2,
      );
    } finally {
      gate.resolve();
      await s.cleanup();
    }
  });
