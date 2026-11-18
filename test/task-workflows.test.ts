import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, FixtureModel, waitFor, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { sleep } from '../src/core/util.js';
import { principalSubject } from '../src/core/contracts.js';
import { TaskWorkflows } from '../src/store/task-workflows.js';
import { prune } from '../src/store/retention.js';

const definition = () => ({
  id: 'report',
  name: 'Report',
  graph: {
    steps: [
      { id: 'first', tool: 'agent/test', arguments: { input: 'FIRST' } },
      {
        id: 'second',
        tool: 'agent/test',
        arguments: { input: { $ref: 'first#/output' } },
        depends_on: ['first'],
      },
    ],
    output: { $ref: 'second#/output' },
  },
});

test('event workflows deduplicate completion events and never recursively trigger from their own children', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'EVENT_RESULT' })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    const body = {
      ...definition(),
      enabled: true,
      trigger: { kind: 'event', agent: 'agent/test' },
    };
    assert.equal(
      (await s.request('POST', '/v1/workflows', { definition: body, revision: 'new' })).statusCode,
      200,
    );
    const source = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Trigger once',
    });
    await waitFor(
      async () =>
        (await s.request('GET', '/v1/workflow-runs')).json().data[0]?.status === 'completed',
    );
    s.store.events.emit('summary', {
      owner: 'owner',
      runId: source.json().id,
      agentId: 'agent/test',
      status: 'completed',
    });
    await sleep(50);
    assert.equal((await s.request('GET', '/v1/workflow-runs')).json().data.length, 1);
    assert.equal(s.driver.calls, 3);
  } finally {
    await s.cleanup();
  }
});

test('scheduled workflows revalidate their stored key and do not run after revocation', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const created = (
      await s.request('POST', '/v1/keys', {
        name: 'scheduler',
        agents: ['*'],
        scopes: ['admin', 'read', 'invoke'],
      })
    ).json();
    const body = {
      ...definition(),
      enabled: true,
      trigger: { kind: 'interval', minutes: 60, input: {} },
    };
    const published = await s.request(
      'POST',
      '/v1/workflows',
      { definition: body, revision: 'new' },
      created.token,
    );
    assert.equal(published.statusCode, 200, published.body);
    await s.request('DELETE', `/v1/keys/${created.id}`);
    await s.listen();
    await sleep(80);
    assert.equal(s.driver.calls, 0);
    assert.equal((await s.request('GET', '/v1/workflow-runs')).json().data.length, 0);
    assert.ok(principalSubject(s.auth.revalidate(`Bearer ${token}`)));
  } finally {
    await s.cleanup();
  }
});

test('natural-language drafting makes a tool-free model call but never enables or executes its generated workflow', async () => {
  const s = await setup(
    new FixtureModel((_agent, messages) => {
      assert.match(messages.at(-1)!.content, /JSON Schema:/);
      assert.match(messages.at(-1)!.content, /"graph"/);
      return { text: JSON.stringify({ ...definition(), enabled: true }) };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const draft = await s.request('POST', '/v1/workflows/draft', {
      agent: 'agent/test',
      request: 'Run two stages',
    });
    assert.equal(draft.statusCode, 200, draft.body);
    assert.equal(draft.json().definition.enabled, false);
    assert.equal(draft.json().definition.trigger.kind, 'manual');
    assert.equal(s.driver.calls, 1);
    assert.equal((await s.request('GET', '/v1/workflows')).json().data.length, 0);
    assert.equal((await s.request('GET', '/v1/workflow-runs')).json().data.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('reusable agent workflows validate real DAGs, run by API, and keep private definitions and outputs scoped', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) => ({ text: messages.at(-1)!.content + '_DONE' })),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const published = await s.request('POST', '/v1/workflows', {
      definition: definition(),
      revision: 'new',
    });
    assert.equal(published.statusCode, 200, published.body);
    const started = await s.request('POST', '/v1/workflows/report/run', { input: {} });
    assert.equal(started.statusCode, 202, started.body);
    const id = started.json().id;
    let result: { status: string; output?: string; nodes: Record<string, string> } | undefined;
    await waitFor(async () => {
      result = (await s.request('GET', `/v1/workflow-runs/${id}`)).json();
      return result?.status === 'completed';
    });
    assert.equal(result!.output, 'FIRST_DONE_DONE');
    assert.equal(Object.keys(result!.nodes).length, 2);
    assert.equal(s.driver.calls, 2);
    const key = (
      await s.request('POST', '/v1/keys', {
        name: 'reader',
        agents: ['agent/test'],
        scopes: ['read', 'invoke'],
      })
    ).json();
    const listed = await s.request('GET', '/v1/workflows', undefined, key.token);
    assert.deepEqual(listed.json().data, []);
    assert.equal(
      (await s.request('GET', `/v1/workflow-runs/${id}`, undefined, key.token)).statusCode,
      403,
    );
    const cyclic = definition();
    cyclic.graph.steps[0]!.depends_on = ['second'];
    assert.equal(
      (
        await s.request('POST', '/v1/workflows', {
          definition: { ...cyclic, id: 'cycle' },
          revision: 'new',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await s.request('POST', '/v1/workflows', { definition: definition(), revision: 'new' }))
        .statusCode,
      409,
    );
  } finally {
    await s.cleanup();
  }
});

test('workflow restart reattaches to child runs and never repeats a completed stage', async () => {
  let calls = 0;
  const s = await setup(
    new FixtureModel(async (_a, messages, signal) => {
      calls++;
      if (calls > 1) await sleep(10000, signal);
      return { text: messages.at(-1)!.content + '_DONE' };
    }),
  );
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    await s.request('POST', '/v1/workflows', { definition: definition(), revision: 'new' });
    const started = await s.request('POST', '/v1/workflows/report/run', { input: {} });
    const id = started.json().id;
    await waitFor(() => calls === 2);
    const before = (await s.request('GET', `/v1/workflow-runs/${id}`)).json();
    for (const dryRun of [true, false]) {
      const clean = await prune(s.store, {
        olderThanMs: 86400000,
        now: Date.now() + 2 * 86400000,
        dryRun,
      });
      assert.equal(clean.runs, 0, 'a completed stage is still needed by the unfinished workflow');
    }
    await s.app.close();
    const driver = new FixtureModel((_a, messages) => ({
      text: messages.at(-1)!.content + '_RESUMED',
    }));
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    await next.listen();
    let result: { status: string; nodes: Record<string, string>; output?: string } | undefined;
    await waitFor(async () => {
      result = (
        await next!.app.inject({
          method: 'GET',
          url: `/v1/workflow-runs/${id}`,
          headers: { authorization: `Bearer ${(await import('./helpers.js')).token}` },
        })
      ).json();
      return result?.status === 'completed';
    });
    assert.deepEqual(result!.nodes, before.nodes);
    assert.equal(result!.output, 'FIRST_DONE_RESUMED');
    assert.equal(driver.calls, 1);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});

test('a full workflow queue defers one completion event across restart without consuming its receipt', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const saved = await s.request('POST', '/v1/workflows', {
      revision: 'new',
      definition: {
        ...definition(),
        enabled: true,
        trigger: { kind: 'event', agent: 'agent/test' },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const records = new TaskWorkflows(s.store),
      rec = records.get('owner', 'report');
    const fill = Array.from({ length: 32 }, () =>
      records.create({
        owner: 'owner',
        subject: principalSubject(rec.authority),
        authority: rec.authority,
        definition: { id: 'occupant' },
        revision: '1',
        input: {},
        fileIds: [],
      }),
    );
    const result = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'one event',
    });
    const repeat = {
      owner: 'owner',
      agentId: 'agent/test',
      runId: result.json().id,
      status: 'completed',
    };
    s.store.events.emit('summary', repeat);
    assert.equal(records.get('owner', 'report').triggerStatus?.error, 'concurrency_limit');
    assert.equal(
      s.store.prepare('SELECT count(*) AS n FROM workflow_trigger_receipts').get()?.n,
      0,
    );
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM workflow_pending_events').get()?.n, 1);
    for (const e of fill) {
      e.status = 'completed';
      records.save(e);
    }
    await s.app.close();
    const driver = new FixtureModel();
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    await next.listen();
    const after = new TaskWorkflows(next.store);
    await waitFor(() =>
      after
        .executions('owner')
        .some((x) => x.definition.id === 'report' && x.status === 'completed'),
    );
    next.store.events.emit('summary', repeat);
    assert.equal(after.executions('owner').filter((x) => x.definition.id === 'report').length, 1);
    assert.equal(
      next.store.prepare('SELECT count(*) AS n FROM workflow_trigger_receipts').get()?.n,
      1,
    );
    assert.equal(
      next.store.prepare('SELECT count(*) AS n FROM workflow_pending_events').get()?.n,
      0,
    );
    assert.equal(driver.calls, 2);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});
