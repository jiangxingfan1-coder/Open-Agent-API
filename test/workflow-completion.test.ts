import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { createGateway } from '../src/gateway/server.js';
import { makeBundle } from '../src/lang/bundle.js';
import { prune } from '../src/store/retention.js';
import { TaskWorkflows } from '../src/store/task-workflows.js';
import { WORKFLOW_EVENT_READY } from '../src/store/workflow-events.js';
import { agent, FixtureModel, setup, waitFor } from './helpers.js';

const flow = {
  id: 'on-completion',
  name: 'Follow up',
  enabled: true,
  trigger: { kind: 'event', agent: 'agent/source' },
  graph: {
    steps: [{ id: 'next', tool: 'agent/follow', arguments: { input: { $ref: 'input#/output' } } }],
  },
};

test('a completion only captures current matching subscriptions; replay respects revision and revoked grants', async () => {
  const s = await setup();
  try {
    for (const id of ['agent/source', 'agent/follow'])
      s.store.publish('owner', makeBundle(agent({ id })));
    // Keep the durable notifications but delay dispatch, as during shutdown.
    s.store.events.removeAllListeners(WORKFLOW_EVENT_READY);
    const key = (
      await s.request('POST', '/v1/keys', {
        name: 'subscriber',
        agents: ['*'],
        scopes: ['admin', 'invoke', 'read'],
      })
    ).json();
    const publish = async (id: string) => {
      const r = await s.request(
        'POST',
        '/v1/workflows',
        { definition: { ...flow, id }, revision: 'new' },
        key.token,
      );
      assert.equal(r.statusCode, 200, r.body);
      return r.json().revision as string;
    };
    const archived = await publish('archived');
    await publish('revoked');
    await s.request('POST', '/v1/responses', { model: 'agent/source', input: 'other subject' });
    const records = new TaskWorkflows(s.store);
    assert.equal(records.pendingEvents().length, 0);
    const source = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/source', input: 'in scope' },
      key.token,
    );
    assert.equal(source.json().status, 'completed');
    assert.equal(records.pendingEvents().length, 2);
    await publish('too-late');
    // A duplicate terminal checkpoint must not target a newly published subscription.
    s.store.checkpoint(s.store.run(source.json().id), [], () => ({
      type: 'response.completed',
      data: {},
    }));
    assert.equal(records.pendingEvents().length, 2);
    assert.equal(
      (await s.request('POST', '/v1/workflows/archived/archive', { revision: archived }, key.token))
        .statusCode,
      200,
    );
    await s.request('DELETE', '/v1/keys/' + key.id);
    await s.listen();
    await waitFor(() => records.pendingEvents().length === 0);
    assert.equal(records.get('owner', 'revoked').triggerStatus?.error, 'run_key_inactive');
    assert.equal(records.executions('owner').length, 0);
    assert.equal(s.driver.calls, 2);
  } finally {
    await s.cleanup();
  }
});

test('a failed completion write cannot leave a trigger without a completed source', async () => {
  const s = await setup();
  try {
    for (const id of ['agent/source', 'agent/follow'])
      s.store.publish('owner', makeBundle(agent({ id })));
    assert.equal(
      (await s.request('POST', '/v1/workflows', { definition: flow, revision: 'new' })).statusCode,
      200,
    );
    s.store.db.exec(
      "CREATE TEMP TRIGGER fail_capture AFTER INSERT ON workflow_pending_events BEGIN SELECT RAISE(ABORT,'fixture journal unavailable'); END;",
    );
    await s.request('POST', '/v1/responses', { model: 'agent/source', input: 'one' });
    assert.equal(
      s.store.prepare("SELECT count(*) AS n FROM events WHERE type='response.completed'").get()?.n,
      0,
    );
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM workflow_pending_events').get()?.n, 0);
    assert.equal(new TaskWorkflows(s.store).executions('owner').length, 0);
    assert.deepEqual(
      s.store.allRuns().map((r) => r.status),
      ['failed'],
    );
    assert.equal(s.driver.calls, 1);
  } finally {
    await s.cleanup();
  }
});

test('a full trigger backlog reports overflow without failing or silently acknowledging the source event', async () => {
  const s = await setup();
  try {
    for (const id of ['agent/source', 'agent/follow'])
      s.store.publish('owner', makeBundle(agent({ id })));
    const saved = await s.request('POST', '/v1/workflows', { definition: flow, revision: 'new' });
    assert.equal(saved.statusCode, 200, saved.body);
    s.store.db
      .exec(`WITH RECURSIVE entries(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM entries WHERE i<256)
      INSERT INTO workflow_pending_events SELECT 'owner','on-completion','old:'||i,'earlier','{}' FROM entries`);
    const source = await s.request('POST', '/v1/responses', {
      model: 'agent/source',
      input: 'overflow',
    });
    assert.equal(source.json().status, 'completed', source.body);
    assert.equal(
      new TaskWorkflows(s.store).get('owner', flow.id).triggerStatus?.error,
      'queue_full',
    );
    assert.equal(
      s.store.prepare('SELECT count(*) AS n FROM workflow_pending_events').get()?.n,
      256,
    );
    assert.equal(
      s.store.prepare('SELECT count(*) AS n FROM workflow_trigger_receipts').get()?.n,
      0,
    );
  } finally {
    await s.cleanup();
  }
});

for (const faultAt of ['running', 'completed'] as const)
  test(`a failed workflow ${faultAt} write retries without a hot loop or duplicate child`, async () => {
    const s = await setup();
    try {
      s.store.publish('owner', makeBundle(agent({ id: 'agent/follow' })));
      const saved = await s.request('POST', '/v1/workflows', {
        definition: { ...flow, trigger: { kind: 'manual' } },
        revision: 'new',
      });
      assert.equal(saved.statusCode, 200, saved.body);
      let attempts = 0;
      s.store.db.function('count_write', () => ++attempts);
      s.store.db
        .exec(`CREATE TEMP TRIGGER refuse_write BEFORE UPDATE OF status ON workflow_executions WHEN NEW.status='${faultAt}'
      BEGIN SELECT count_write(); SELECT RAISE(ABORT,'workflow checkpoint unavailable'); END`);
      const start = await s.request('POST', '/v1/workflows/' + flow.id + '/run', {
        input: { output: 'hello' },
      });
      assert.equal(start.statusCode, 202, start.body);
      const records = new TaskWorkflows(s.store);
      await waitFor(() => attempts === 1);
      assert.equal(
        records.execution('owner', start.json().id).status,
        faultAt === 'running' ? 'queued' : 'running',
      );
      assert.equal((await s.request('GET', '/health')).statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(attempts, 1);
      s.store.db.exec('DROP TRIGGER refuse_write');
      await waitFor(() => records.execution('owner', start.json().id).status === 'completed', 6000);
      assert.equal(s.driver.calls, 1);
      assert.equal(s.store.allRuns().length, 1);
    } finally {
      await s.cleanup();
    }
  });

test('a process exit between source completion and its observer preserves exactly one workflow across prune and restart', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    for (const id of ['agent/source', 'agent/follow'])
      s.store.publish('owner', makeBundle(agent({ id })));
    const saved = await s.request('POST', '/v1/workflows', { revision: 'new', definition: flow });
    assert.equal(saved.statusCode, 200, saved.body);
    const config = path.join(s.dir, 'gateway.json');
    await writeFile(config, JSON.stringify(s.config));
    await s.app.close();
    const child = spawnSync(
      process.execPath,
      [path.resolve('dist/test/fixtures/workflow-admission-crash.js'), config, 'completion'],
      { encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(child.status, 74, child.stderr);
    const calls: string[] = [];
    const driver = new FixtureModel((a, m) => {
      calls.push(a.id);
      return { text: m.at(-1)!.content };
    });
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    await next.app.ready();
    const records = new TaskWorkflows(next.store);
    const [source] = next.store.allRuns(['completed']);
    assert.equal(source?.agentId, 'agent/source');
    assert.equal(records.executions('owner').length, 0);
    assert.equal(
      records.pendingEvents().length,
      1,
      'the source and its pending delivery must commit together',
    );
    const expectedOutput = source!.output.map((m) => m.text).join('\n');
    assert.equal(
      (await prune(next.store, { olderThanMs: 60000, now: Date.now() + 120000 })).runs,
      1,
    );
    await next.listen();
    await waitFor(() => records.executions('owner')[0]?.status === 'completed');
    assert.deepEqual(records.executions('owner')[0]?.input, {
      run_id: source!.id,
      agent: 'agent/source',
      output: expectedOutput,
    });
    assert.deepEqual(calls, ['agent/follow']);
    await next.app.close();
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    await next.listen();
    const after = new TaskWorkflows(next.store);
    assert.equal(after.pendingEvents().length, 0);
    assert.equal(after.executions('owner').length, 1);
    assert.equal(
      next.store.prepare('SELECT count(*) AS n FROM workflow_trigger_receipts').get()?.n,
      1,
    );
    assert.deepEqual(calls, ['agent/follow']);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});
