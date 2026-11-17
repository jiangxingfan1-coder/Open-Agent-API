import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, FixtureModel, token, secondToken, waitFor } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { taskWorkflowSchema, type TaskWorkflow } from '../src/lang/task-workflow.js';
import { TaskWorkflows } from '../src/store/task-workflows.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { capabilitySchema, principalSubject } from '../src/core/contracts.js';
import { Fault, sleep } from '../src/core/util.js';

const definition = () =>
  taskWorkflowSchema.parse({
    id: 'lifecycle',
    name: 'Lifecycle',
    graph: { steps: [{ id: 'first', tool: 'agent/test', arguments: { input: 'FIRST' } }] },
  });
type Fixture = Awaited<ReturnType<typeof setup>>;
const publish = (s: Fixture, value = definition()) =>
  s.request('POST', '/v1/workflows', { definition: value, revision: 'new' });

test('workflow archive is revision checked, preserves accepted executions and restores with triggers paused', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await gate.promise;
      signal.throwIfAborted();
      return { text: 'ACCEPTED_RESULT' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const body = definition();
    body.trigger = { kind: 'interval', minutes: 60, input: {} };
    body.enabled = true;
    const initial = (await publish(s, body)).json();
    const run = (await s.request('POST', '/v1/workflows/lifecycle/run', {})).json();
    await waitFor(() => s.driver.calls === 1);
    assert.equal(
      (
        await s.request(
          'POST',
          '/v1/workflows/lifecycle/archive',
          { revision: initial.revision },
          secondToken,
        )
      ).statusCode,
      403,
    );
    const archived = await s.request('POST', '/v1/workflows/lifecycle/archive', {
      revision: initial.revision,
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.ok(archived.json().archived_at);
    assert.notEqual(archived.json().revision, initial.revision);
    assert.equal((await s.request('GET', '/v1/workflows')).json().data.length, 0);
    assert.equal((await s.request('GET', '/v1/workflows?archived=true')).json().data.length, 1);
    assert.equal((await s.request('POST', '/v1/workflows/lifecycle/run', {})).statusCode, 400);
    assert.equal(
      (await s.request('POST', '/v1/workflows', { definition: body, revision: initial.revision }))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await s.request('POST', '/v1/workflows', {
          definition: body,
          revision: archived.json().revision,
        })
      ).statusCode,
      400,
    );
    assert.equal((await s.request('GET', `/v1/workflow-runs/${run.id}`)).json().status, 'running');
    gate.resolve();
    await waitFor(
      async () =>
        (await s.request('GET', `/v1/workflow-runs/${run.id}`)).json().status === 'completed',
    );
    assert.equal(
      (await s.request('POST', '/v1/workflows/lifecycle/restore', { revision: initial.revision }))
        .statusCode,
      409,
    );
    const restored = await s.request('POST', '/v1/workflows/lifecycle/restore', {
      revision: archived.json().revision,
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().archived_at, undefined);
    assert.equal(restored.json().definition.enabled, false);
    assert.equal(
      (await s.request('GET', '/v1/workflow-runs')).json().data[0].output.first.output,
      'ACCEPTED_RESULT',
    );
    assert.equal(s.driver.calls, 1);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('cancelling a completed workflow is idempotent and retains its output and children', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    await publish(s);
    const run = (await s.request('POST', '/v1/workflows/lifecycle/run', {})).json();
    await waitFor(
      async () =>
        (await s.request('GET', `/v1/workflow-runs/${run.id}`)).json().status === 'completed',
    );
    const before = (await s.request('GET', `/v1/workflow-runs/${run.id}`)).json();
    for (let i = 0; i < 2; i++) {
      const result = await s.request('POST', `/v1/workflow-runs/${run.id}/cancel`, {});
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().status, 'completed');
      assert.deepEqual(result.json().output, before.output);
      assert.deepEqual(result.json().nodes, before.nodes);
      assert.equal(result.json().cancel_requested, false);
    }
  } finally {
    await s.cleanup();
  }
});

test('cold workflow cancellation stops persisted child calls and a failed cancellation can be retried, not resumed', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(10000, signal);
      return { text: 'SHOULD_NOT_FINISH' };
    }),
  );
  const originalCancel = s.kernel.cancel.bind(s.kernel);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const authority = s.auth.revalidate(`Bearer ${token}`),
      records = new TaskWorkflows<TaskWorkflow>(s.store);
    const record = records.put('owner', definition(), authority, 'new');
    const execution = records.create({
      owner: 'owner',
      subject: principalSubject(authority),
      authority,
      definition: record.definition,
      revision: record.revision,
      input: {},
      fileIds: [],
    });
    const child = (
      await s.request('POST', '/v1/responses', {
        model: 'agent/test',
        input: 'Wait',
        background: true,
      })
    ).json();
    await waitFor(() => s.driver.calls === 1);
    execution.nodes.first = child.id;
    records.save(execution);
    s.kernel.cancel = async () => {
      throw new Fault('run_not_attached', 'Controlled unavailable child.', 409);
    };
    const blocked = await s.request('POST', `/v1/workflow-runs/${execution.id}/cancel`, {});
    assert.equal(blocked.json().status, 'blocked', blocked.body);
    assert.equal(blocked.json().cancel_requested, true);
    assert.equal(blocked.json().error, 'run_not_attached');
    assert.equal(blocked.json().cancellation, undefined);
    assert.equal(
      (await s.request('POST', `/v1/workflow-runs/${execution.id}/resume`, {})).statusCode,
      409,
    );
    s.kernel.cancel = originalCancel;
    const cancelled = await s.request('POST', `/v1/workflow-runs/${execution.id}/cancel`, {});
    assert.equal(cancelled.json().status, 'cancelled', cancelled.body);
    assert.equal(s.store.run(child.id).status, 'cancelled');
    assert.equal(s.driver.calls, 1);
  } finally {
    s.kernel.cancel = originalCancel;
    await s.cleanup();
  }
});

test('concurrent workflow cancellation drains its active child and cannot be overwritten by the runner', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(10000, signal);
      return { text: 'NOT_COMMITTED' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    await publish(s);
    const execution = (await s.request('POST', '/v1/workflows/lifecycle/run', {})).json();
    await waitFor(() => s.driver.calls === 1);
    const results = await Promise.all([
      s.request('POST', `/v1/workflow-runs/${execution.id}/cancel`, {}),
      s.request('POST', `/v1/workflow-runs/${execution.id}/cancel`, {}),
    ]);
    for (const result of results) {
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().status, 'cancelled', result.body);
    }
    const detail = (await s.request('GET', `/v1/workflow-runs/${execution.id}`)).json();
    assert.equal(detail.status, 'cancelled');
    assert.equal(detail.stages[0].status, 'cancelled');
    assert.equal(s.driver.calls, 1);
  } finally {
    await s.cleanup();
  }
});

for (const queued of [false, true])
  test(`persisted cancellation prevents ${queued ? 'queued' : 'interrupted durable'} workflow children from starting after restart`, async () => {
    const s = await setup(
      new FixtureModel(async (_a, _m, signal) => {
        await sleep(10000, signal);
        return { text: 'MUST_NOT_REPLAY' };
      }),
      { maxActiveRuns: 1 },
    );
    let next: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      s.store.publish('owner', makeBundle(agent()));
      const authority = s.auth.revalidate(`Bearer ${token}`),
        records = new TaskWorkflows<TaskWorkflow>(s.store);
      const record = records.put('owner', definition(), authority, 'new');
      const execution = records.create({
        owner: 'owner',
        subject: principalSubject(authority),
        authority,
        definition: record.definition,
        revision: record.revision,
        input: {},
        fileIds: [],
      });
      if (queued) {
        await s.request('POST', '/v1/responses', {
          model: 'agent/test',
          input: 'Occupy the only slot',
          background: true,
        });
        await waitFor(() => s.driver.calls === 1);
      }
      const child = (
        await s.request('POST', '/v1/responses', {
          model: 'agent/test',
          input: 'Workflow child',
          background: true,
          metadata: { 'oaa.durable': 'true', 'oaa.workflow_execution': execution.id },
        })
      ).json();
      await waitFor(() =>
        queued ? s.store.run(child.id).status === 'queued' : s.driver.calls === 1,
      );
      execution.nodes.first = child.id;
      execution.status = 'cancelling';
      execution.cancellation = authority;
      records.save(execution);
      await s.app.close();
      const driver = new FixtureModel();
      next = await createGateway(
        s.config,
        new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
      );
      await next.listen();
      await waitFor(
        () =>
          new TaskWorkflows<TaskWorkflow>(next!.store).execution('owner', execution.id).status ===
          'cancelled',
      );
      assert.equal(driver.calls, 0);
      assert.equal(next.store.run(child.id).status, queued ? 'cancelled' : 'interrupted');
    } finally {
      await next?.app.close();
      await s.cleanup();
    }
  });

test('revocation during workflow cancellation stops disclosure of its private state', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(10000, signal);
      return { text: 'PRIVATE_CANCELLATION_RESULT' };
    }),
  );
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const originalCancel = s.kernel.cancel.bind(s.kernel);
  let pending: ReturnType<typeof s.request> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const caller = (
      await s.request('POST', '/v1/keys', {
        name: 'workflow-owner',
        agents: ['*'],
        scopes: ['admin', 'read', 'invoke'],
      })
    ).json();
    await s.request(
      'POST',
      '/v1/workflows',
      { definition: definition(), revision: 'new' },
      caller.token,
    );
    const execution = (
      await s.request(
        'POST',
        '/v1/workflows/lifecycle/run',
        { input: { private: 'PRIVATE_CANCELLATION_INPUT' } },
        caller.token,
      )
    ).json();
    await waitFor(() => s.driver.calls === 1);
    s.kernel.cancel = async (principal, id) => {
      entered.resolve();
      await release.promise;
      return originalCancel(principal, id);
    };
    pending = s.request('POST', `/v1/workflow-runs/${execution.id}/cancel`, {}, caller.token);
    const response = Promise.resolve(pending);
    await entered.promise;
    await s.request('DELETE', `/v1/keys/${caller.id}`);
    release.resolve();
    const result = await response;
    assert.equal(result.statusCode, 401, result.body);
    assert.doesNotMatch(result.body, /PRIVATE_CANCELLATION/);
  } finally {
    release.resolve();
    await pending;
    s.kernel.cancel = originalCancel;
    await s.cleanup();
  }
});

test('workflow stage projections expose owner approval waits without reading full run payloads', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'APPROVED' }
        : { calls: [{ id: 'gate', name: 'guarded', arguments: {} }] },
    ),
    { approvalTimeoutMs: 10000 },
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/guarded',
      version: '1',
      description: 'Controlled approval',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      requiresApproval: true,
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'guarded',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('guarded', async () => ({ value: 'TEST_ONLY' }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [{ name: 'guarded', capability, handler: { kind: 'node', reference: 'guarded' } }],
        }),
      ),
    );
    await publish(s);
    const execution = (await s.request('POST', '/v1/workflows/lifecycle/run', {})).json();
    await waitFor(
      async () =>
        (await s.request('GET', `/v1/workflow-runs/${execution.id}`)).json().progress.waiting_on ===
        'owner',
    );
    let reads = 0;
    const read = s.store.run.bind(s.store);
    s.store.run = (...args) => {
      reads++;
      return read(...args);
    };
    const detail = await s.request('GET', `/v1/workflow-runs/${execution.id}`);
    s.store.run = read;
    assert.equal(reads, 0);
    assert.equal(detail.json().progress.waiting_on, 'owner');
    assert.deepEqual(
      detail
        .json()
        .stages.map((stage: { status: string; waiting_on: string }) => [
          stage.status,
          stage.waiting_on,
        ]),
      [['requires_action', 'owner']],
    );
    const list = await s.request('GET', '/v1/workflow-runs');
    assert.equal(list.json().data[0].stages, undefined);
    assert.equal(list.json().data[0].progress.waiting_on, 'owner');
    assert.equal(
      (await s.request('GET', `/v1/workflow-runs/${execution.id}`, undefined, secondToken))
        .statusCode,
      403,
    );
    const child = detail.json().stages[0].run_id;
    s.kernel.decide(
      s.auth.revalidate(`Bearer ${token}`),
      child,
      s.store.approvals(child)[0]!.id,
      'approve',
    );
    await waitFor(
      async () =>
        (await s.request('GET', `/v1/workflow-runs/${execution.id}`)).json().status === 'completed',
    );
    const completed = (await s.request('GET', `/v1/workflow-runs/${execution.id}`)).json();
    assert.deepEqual(completed.progress, { started: 1, completed: 1 });
  } finally {
    await s.cleanup();
  }
});
