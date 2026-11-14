import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySchema, type ToolBinding, type RunEvent } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime, type LocalHandler } from '../src/fabric/worker.js';
import { Store } from '../src/store/store.js';
import { Fault, sleep } from '../src/core/util.js';
import { ApprovalSuspension } from '../src/core/suspension.js';
import { executeGraph, parseGraph } from '../src/lang/graph.js';
import { setup, FixtureModel, agent, principal, waitFor } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof setup>>;
const submit = (s: Fixture, id = 'agent/review', input = 'review') =>
  s.kernel.submit(principal, invocationSchema.parse({ agent: id, input, background: true }));
async function parked(s: Fixture, id: string) {
  await waitFor(() => s.store.run(id).checkpoint.suspension?.kind === 'approval');
}
function installTool(
  s: Fixture,
  name: string,
  approved: boolean,
  handler: LocalHandler,
): ToolBinding {
  const capability = capabilitySchema.parse({
    id: `fixture/${name}`,
    version: '1',
    description: 'Local controlled approval fixture',
    placement: 'host-bound',
    nodeId: 'local',
    effect: approved ? 'write' : 'read',
    requiresApproval: approved,
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
const basicModel = () =>
  new FixtureModel((a, messages) =>
    a.id === 'agent/quick' || messages.some((m) => m.role === 'tool')
      ? { text: 'done' }
      : { calls: [{ id: 'guard', name: 'guarded', arguments: {} }] },
  );

test('a parked kernel approval releases the only run slot without repeating its model turn', async () => {
  const s = await setup(basicModel(), { maxActiveRuns: 1, approvalTimeoutMs: 5000 });
  let writes = 0;
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    const review = submit(s);
    await parked(s, review.id);
    const checkpoint = s.store.run(review.id).checkpoint;
    assert.equal(checkpoint.phase, 'tools');
    const quick = submit(s, 'agent/quick', 'quick');
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    assert.equal(s.store.run(review.id).status, 'requires_action');
    assert.equal(s.driver.calls, 2);
    assert.equal(writes, 0);
    const approval = s.store.approvals(review.id)[0]!;
    s.kernel.decide(principal, review.id, approval.id, 'approve');
    assert.equal((await s.kernel.wait(review.id)).status, 'completed');
    assert.equal(s.driver.calls, 3);
    assert.equal(writes, 1);
    assert.equal(s.store.approvals(review.id).length, 1);
    assert.equal(s.store.run(review.id).checkpoint.deadlineAt, checkpoint.deadlineAt);
  } finally {
    await s.cleanup();
  }
});

test('parking waits for already running parallel tools before lending the run slot', async () => {
  const gate = Promise.withResolvers<void>();
  let slowCalls = 0,
    writes = 0;
  const s = await setup(
    new FixtureModel((a, m) =>
      a.id === 'agent/quick' || m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : {
            calls: [
              { id: 'guard', name: 'guarded', arguments: {} },
              { id: 'slow', name: 'slow', arguments: {} },
            ],
          },
    ),
    { maxActiveRuns: 1, approvalTimeoutMs: 5000 },
  );
  try {
    const guarded = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    const slow = installTool(s, 'slow', false, async () => {
      slowCalls++;
      await gate.promise;
      return { value: 'confirmed' };
    });
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [guarded, slow] })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    const review = submit(s);
    await waitFor(() => slowCalls === 1 && s.store.approvals(review.id).length === 1);
    const quick = submit(s, 'agent/quick');
    await sleep(35);
    assert.equal(s.store.run(quick.id).status, 'queued');
    assert.equal(s.store.run(review.id).checkpoint.suspension, undefined);
    gate.resolve();
    await parked(s, review.id);
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
    s.kernel.decide(principal, review.id, s.store.approvals(review.id)[0]!.id, 'approve');
    assert.equal((await s.kernel.wait(review.id)).status, 'completed');
    assert.equal(slowCalls, 1);
    assert.equal(writes, 1);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('independent graph branches keep making progress around approval waits and reuse confirmed steps', async () => {
  const counts = { guarded: 0, read: 0 };
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
                    { id: 'a', tool: 'guarded', arguments: {} },
                    { id: 'b', tool: 'read', arguments: { label: 'b' } },
                    { id: 'c', tool: 'read', arguments: { from: { $ref: 'b#/value' } } },
                  ],
                },
              },
            ],
          },
    ),
    { maxActiveRuns: 1, approvalTimeoutMs: 5000 },
  );
  try {
    const guarded = installTool(s, 'guarded', true, async () => {
      counts.guarded++;
      return { value: { value: 'a' } };
    });
    const read = installTool(s, 'read', false, async (args) => {
      counts.read++;
      return { value: { value: args.label ?? args.from } };
    });
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/review', tools: [guarded, read], limits: { toolConcurrency: 2 } }),
      ),
    );
    const run = submit(s);
    await parked(s, run.id);
    assert.deepEqual(counts, { guarded: 0, read: 2 });
    assert.equal(s.store.steps(run.id).filter((step) => step.status === 'completed').length, 2);
    s.kernel.decide(principal, run.id, s.store.approvals(run.id)[0]!.id, 'approve');
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(JSON.parse(result.output.at(-1)!.text), {
      a: { value: 'a' },
      b: { value: 'b' },
      c: { value: 'b' },
    });
    assert.deepEqual(counts, { guarded: 1, read: 2 });
    assert.equal(s.driver.calls, 2);
  } finally {
    await s.cleanup();
  }
});

test('partial approvals do not create duplicate approvals, repeat writes, or spin on an old decision', async () => {
  let writes = 0;
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : {
            calls: [
              { id: 'a', name: 'guarded', arguments: { label: 'a' } },
              { id: 'b', name: 'guarded', arguments: { label: 'b' } },
            ],
          },
    ),
    { maxActiveRuns: 1, approvalTimeoutMs: 5000 },
  );
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    const run = submit(s);
    await parked(s, run.id);
    const actions = s.store.approvals(run.id);
    assert.equal(actions.length, 2);
    s.kernel.decide(principal, run.id, actions[0]!.id, 'approve');
    await waitFor(
      () => writes === 1 && s.store.run(run.id).checkpoint.suspension?.approvalIds.length === 1,
    );
    const eventCount = s.store.history(run.id).length;
    await sleep(40);
    assert.equal(s.store.history(run.id).length, eventCount);
    assert.equal(s.store.approvals(run.id).length, 2);
    assert.equal(s.driver.calls, 1);
    s.kernel.decide(principal, run.id, actions[1]!.id, 'approve');
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.equal(writes, 2);
  } finally {
    await s.cleanup();
  }
});

test('approval decisions arriving before the parking checkpoint are not lost', async () => {
  let writes = 0;
  const s = await setup(basicModel(), { maxActiveRuns: 1 });
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    const run = submit(s);
    s.store.events.on(run.id, (event: RunEvent) => {
      if (event.type === 'run.requires_action')
        s.kernel.decide(principal, run.id, s.store.approvals(run.id)[0]!.id, 'approve');
    });
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.equal(writes, 1);
    assert.equal(s.store.approvals(run.id).length, 1);
  } finally {
    await s.cleanup();
  }
});

test('parked cancellations and denials expire remaining approvals without dispatching tools', async () => {
  for (const decision of ['cancel', 'deny'] as const) {
    let writes = 0;
    const s = await setup(basicModel(), { maxActiveRuns: 1, approvalTimeoutMs: 80 });
    try {
      const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
      s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
      const run = submit(s);
      await parked(s, run.id);
      const action = s.store.approvals(run.id)[0]!;
      if (decision === 'cancel') await s.kernel.cancel(principal, run.id);
      else s.kernel.decide(principal, run.id, action.id, 'deny');
      const final = await s.kernel.wait(run.id);
      assert.equal(final.status, decision === 'cancel' ? 'cancelled' : 'failed');
      assert.equal(writes, 0);
      assert.throws(
        () => s.kernel.decide(principal, run.id, action.id, 'approve'),
        /no longer pending/,
      );
      await sleep(90);
      assert.equal(s.store.run(run.id).status, final.status);
    } finally {
      await s.cleanup();
    }
  }
});

test('the original run deadline still applies while an approved run waits for readmission', async () => {
  const gate = Promise.withResolvers<void>();
  let quickStarted = false,
    writes = 0;
  const s = await setup(
    new FixtureModel(async (a, m) => {
      if (a.id === 'agent/quick') {
        quickStarted = true;
        await gate.promise;
        return { text: 'quick ended' };
      }
      return m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : { calls: [{ id: 'guard', name: 'guarded', arguments: {} }] };
    }),
    { maxActiveRuns: 1, approvalTimeoutMs: 5000 },
  );
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/review', tools: [binding], limits: { timeoutMs: 60_000 } })),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    const review = submit(s);
    await parked(s, review.id);
    // A short deadline set only once the run is parked: a 250 ms agent limit could expire before
    // the run even parked on a slow machine, which made this test flaky. The kernel reads the
    // stored deadline again when the approval is resolved, so this is the deadline it must keep.
    const parkedRun = s.store.run(review.id);
    parkedRun.checkpoint.deadlineAt = Date.now() + 1500;
    s.store.checkpoint(parkedRun, []);
    const deadline = parkedRun.checkpoint.deadlineAt;
    const quick = submit(s, 'agent/quick');
    await waitFor(() => quickStarted);
    s.kernel.decide(principal, review.id, s.store.approvals(review.id)[0]!.id, 'approve');
    assert.equal(s.store.run(review.id).status, 'queued');
    const result = await s.kernel.wait(review.id);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.error?.code, 'run_timeout');
    assert.equal(result.checkpoint.deadlineAt, deadline);
    assert.equal(writes, 0);
    gate.resolve();
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('shut down parked work resumes from confirmed steps and requires a fresh expired approval', async () => {
  let writes = 0,
    reads = 0;
  const model = new FixtureModel((_a, m) =>
    m.some((x) => x.role === 'tool')
      ? { text: 'done' }
      : {
          calls: [
            { id: 'guard', name: 'guarded', arguments: {} },
            { id: 'read', name: 'read', arguments: {} },
          ],
        },
  );
  const s = await setup(model, { maxActiveRuns: 1, approvalTimeoutMs: 5000 });
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    const guarded = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    const read = installTool(s, 'read', false, async () => ({ value: ++reads }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [guarded, read] })));
    const run = submit(s);
    await parked(s, run.id);
    const prior = s.store.approvals(run.id)[0]!.id;
    assert.equal(reads, 1);
    await s.app.close();
    const next = new FixtureModel(() => ({ text: 'resumed' }));
    const runtime = new WorkerRuntime(
      s.runtime.config,
      s.runtime.handlers,
      new Map([['fixture', next]]),
    );
    replacement = await createGateway(s.config, runtime);
    assert.equal(replacement.store.run(run.id).status, 'interrupted');
    assert.equal(replacement.store.getApproval(prior, 'owner').status, 'expired');
    replacement.kernel.resume(principal, run.id);
    await waitFor(() => replacement!.store.run(run.id).checkpoint.suspension?.kind === 'approval');
    const actions = replacement.store.approvals(run.id);
    assert.equal(actions.length, 2);
    assert.equal(writes, 0);
    replacement.kernel.decide(
      principal,
      run.id,
      actions.find((a) => a.status === 'pending')!.id,
      'approve',
    );
    assert.equal((await replacement.kernel.wait(run.id)).status, 'completed');
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(next.calls, 1);
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('an uncertain parallel effect takes precedence over approval suspension and ordinary failures', async () => {
  const graph = parseGraph(
    {
      steps: [
        { id: 'wait', tool: 'wait', arguments: {} },
        { id: 'fail', tool: 'fail', arguments: {} },
        { id: 'unknown', tool: 'unknown', arguments: {} },
      ],
    },
    new Set(['wait', 'fail', 'unknown']),
  );
  await assert.rejects(
    () =>
      executeGraph(graph, 3, new AbortController().signal, async (step) => {
        if (step.tool === 'wait') throw new ApprovalSuspension(['approval-fixture']);
        if (step.tool === 'fail') throw new Fault('definite_failure', 'known failure');
        throw new Fault('effect_outcome_unknown', 'unknown fixture effect', 409, true);
      }),
    (error) => error instanceof Fault && error.uncertain,
  );
});

test('native approval waits keep their execution slot rather than pretending an opaque process paused', async () => {
  const s = await setup(basicModel(), { maxActiveRuns: 1, approvalTimeoutMs: 5000 });
  try {
    s.hub.addLocal(
      { nodeId: 'native', owner: 'owner', token: 'fixture', agents: ['*'], capabilities: ['*'] },
      {
        advertisement: () => ({
          nodeId: 'native',
          providers: [],
          natives: ['adapter/native-fixture'],
          capabilities: [],
          warm: [],
          concurrency: 1,
        }),
        install: async () => {},
        close: async () => {},
        execute: async (_work, _signal, emit) => {
          await emit({ type: 'approval', data: { tool: 'native-fixture' } });
          return { text: 'native fixture done', nativeState: {}, usage: null };
        },
      },
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/review', engine: 'adapter/native-fixture', model: 'default' })),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    const native = submit(s);
    await waitFor(() => s.store.approvals(native.id).length === 1);
    const quick = submit(s, 'agent/quick');
    await sleep(30);
    assert.equal(s.store.run(quick.id).status, 'queued');
    assert.equal(s.store.run(native.id).checkpoint.suspension, undefined);
    assert.equal(s.hub.nodes.get('native')!.active, 1);
    s.kernel.decide(principal, native.id, s.store.approvals(native.id)[0]!.id, 'approve', {
      answers: { fixture: 'confirmed' },
    });
    assert.equal((await s.kernel.wait(native.id)).status, 'completed');
    assert.equal((await s.kernel.wait(quick.id)).status, 'completed');
  } finally {
    await s.cleanup();
  }
});

test('a denial received during readmission blocks already approved siblings before they can dispatch', async () => {
  const gate = Promise.withResolvers<void>();
  let quickStarted = false,
    writes = 0;
  const s = await setup(
    new FixtureModel(async (a, m) => {
      if (a.id === 'agent/quick') {
        quickStarted = true;
        await gate.promise;
        return { text: 'done' };
      }
      return m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : {
            calls: [
              { id: 'a', name: 'guarded', arguments: { label: 'a' } },
              { id: 'b', name: 'guarded', arguments: { label: 'b' } },
            ],
          };
    }),
    { maxActiveRuns: 1, approvalTimeoutMs: 5000 },
  );
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    const review = submit(s);
    await parked(s, review.id);
    const actions = s.store.approvals(review.id);
    const quick = submit(s, 'agent/quick');
    await waitFor(() => quickStarted);
    s.kernel.decide(principal, review.id, actions[0]!.id, 'approve');
    assert.equal(s.store.run(review.id).status, 'queued');
    s.kernel.decide(principal, review.id, actions[1]!.id, 'deny');
    assert.equal((await s.kernel.wait(review.id)).status, 'failed');
    gate.resolve();
    await s.kernel.wait(quick.id);
    assert.equal(writes, 0);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('a cancellation at the parking transition is not lost or later resurrected', async () => {
  const s = await setup(basicModel(), { maxActiveRuns: 1 });
  let writes = 0;
  let cancellation: ReturnType<typeof s.kernel.cancel> | undefined;
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    const run = submit(s);
    s.store.events.on(run.id, (event: RunEvent) => {
      if (event.type === 'run.parked') cancellation = s.kernel.cancel(principal, run.id);
    });
    assert.equal((await s.kernel.wait(run.id)).status, 'cancelled');
    assert.equal((await cancellation)?.status, 'cancelled');
    assert.equal(s.store.run(run.id).checkpoint.suspension, undefined);
    assert.ok(s.store.approvals(run.id).every((a) => a.status !== 'pending'));
    assert.equal(writes, 0);
  } finally {
    await s.cleanup();
  }
});

test('legacy approval replies embedded in detail remain usable on an explicitly resumed checkpoint', async () => {
  const s = await setup(basicModel(), { maxActiveRuns: 1 });
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  let writes = 0;
  try {
    const binding = installTool(s, 'guarded', true, async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    const run = submit(s);
    await parked(s, run.id);
    const actionId = s.store.approvals(run.id)[0]!.id;
    await s.app.close();
    const legacy = new Store(s.config.dataDir);
    try {
      const action = legacy.getApproval(actionId, 'owner');
      action.status = 'approved';
      action.detail.response = {};
      delete action.response;
      legacy.approval(action);
    } finally {
      legacy.close();
    }
    const next = new FixtureModel(() => ({ text: 'resumed' }));
    replacement = await createGateway(
      s.config,
      new WorkerRuntime(s.runtime.config, s.runtime.handlers, new Map([['fixture', next]])),
    );
    replacement.kernel.resume(principal, run.id);
    assert.equal((await replacement.kernel.wait(run.id)).status, 'completed');
    assert.equal(writes, 1);
    assert.equal(next.calls, 1);
    assert.equal(replacement.store.approvals(run.id).length, 1);
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('parked work still counts toward admission and a fresh idempotency key cannot bypass the quota', async () => {
  const s = await setup(basicModel(), { maxActiveRuns: 2, approvalTimeoutMs: 30_000 });
  try {
    const binding = installTool(s, 'guarded', true, async () => {
      throw new Error('No tool should be approved in this test.');
    });
    s.store.publish('owner', makeBundle(agent({ id: 'agent/review', tools: [binding] })));
    const invocation = invocationSchema.parse({
      agent: 'agent/review',
      input: 'quota fixture',
      background: true,
    });
    const runs = Array.from({ length: 32 }, (_, i) =>
      s.kernel.submit(principal, invocation, `quota-${i}`),
    );
    await waitFor(() => runs.every((r) => s.store.run(r.id).checkpoint.suspension));
    assert.equal(s.store.activeCount('owner'), 32);
    assert.equal(s.kernel.submit(principal, invocation, 'quota-0').id, runs[0]!.id);
    assert.throws(
      () => s.kernel.submit(principal, invocation, 'quota-new'),
      (error) => error instanceof Fault && error.status === 429,
    );
    const blocked = await s.request('POST', '/v1/invoke', invocation, undefined, {
      'Idempotency-Key': 'another-new-key',
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(s.driver.calls, 32);
    await s.kernel.cancel(principal, runs[0]!.id);
    const accepted = s.kernel.submit(principal, invocation, 'after-cancellation');
    await parked(s, accepted.id);
    assert.equal(s.store.activeCount('owner'), 32);
  } finally {
    await s.cleanup();
  }
});
