import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agent, FixtureModel, setup, token, waitFor } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { TaskWorkflows, workflowAllowsChildRecovery } from '../src/store/task-workflows.js';
import { prune } from '../src/store/retention.js';

const definition = {
  id: 'probe',
  name: 'Probe',
  graph: { steps: [{ id: 'only', tool: 'agent/test', arguments: { input: 'ordinary fixture' } }] },
};

test('usage reset settles outstanding terminal deltas first and does not restore old usage later', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const p = s.auth.authenticate('Bearer ' + token),
      key = p.keyId!;
    s.store.db.exec(
      "CREATE TEMP TRIGGER fail_total BEFORE UPDATE OF used_tokens ON api_key_usage BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END",
    );
    await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hello' });
    assert.throws(() => s.auth.updateQuota(p, key, undefined, true), /fixture settlement failure/);
    s.store.db.exec('DROP TRIGGER fail_total');
    s.auth.updateQuota(p, key, undefined, true);
    s.auth.accounting.recover();
    assert.deepEqual(s.auth.keyUsage(key), { usedRuns: 0, usedTokens: 0, activeRuns: 0 });
    assert.equal(s.driver.calls, 1);
  } finally {
    await s.cleanup();
  }
});
test('failed admission commits neither the run nor key/ledger usage; retry of the same key executes exactly once', async () => {
  const s = await setup(undefined, { platform: { owner: 'owner', registration: 'open' } });
  try {
    s.store.publish('owner', makeBundle(agent()));
    const platform = s.platform!;
    platform.putListing({ agentId: 'agent/test', price: { perRun: 1 } });
    const acct = await platform.createAccount({
      email: 'fixture@example.test',
      password: 'test-password',
      credits: 10,
    });
    const key = platform.createKey(acct.id, 'test'),
      kid = s.auth.authenticate('Bearer ' + key.token).keyId!;
    let queued = 0;
    s.store.events.on('summary', (e: { status: string }) => {
      if (e.status === 'queued') queued++;
    });
    s.store.db.exec(
      "CREATE TEMP TRIGGER fail_usage BEFORE INSERT ON api_key_usage BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
    );
    const invoke = () =>
      s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hello' }, key.token, {
        'idempotency-key': 'same',
      });
    assert.equal((await invoke()).statusCode, 500);
    for (const table of [
      'runs',
      'events',
      'run_output_baselines',
      'run_summaries',
      'api_key_pending_runs',
    ])
      assert.equal(s.store.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0, table);
    assert.equal(
      s.store.prepare("SELECT count(*) AS n FROM platform_ledger WHERE kind='run'").get()?.n,
      0,
    );
    assert.equal(platform.account(acct.id).balance, 10);
    assert.deepEqual(s.auth.keyUsage(kid), { usedRuns: 0, usedTokens: 0, activeRuns: 0 });
    assert.equal(queued, 0);
    assert.equal(s.driver.calls, 0);
    s.store.db.exec('DROP TRIGGER fail_usage');
    const first = (await invoke()).json(),
      duplicate = (await invoke()).json();
    assert.equal(first.status, 'completed');
    assert.equal(duplicate.id, first.id);
    assert.equal(s.driver.calls, 1);
    assert.equal(s.auth.keyUsage(kid).usedRuns, 1);
    assert.equal(platform.account(acct.id).balance, 9);
  } finally {
    await s.cleanup();
  }
});

test('failed final accounting keeps its marker and survives a prune and restart without re-executing the model', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const key = s.auth.authenticate('Bearer ' + token).keyId!;
    s.store.db.exec(
      "CREATE TEMP TRIGGER fail_total BEFORE UPDATE OF used_tokens ON api_key_usage BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END",
    );
    const result = (
      await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hello' })
    ).json();
    assert.equal(result.status, 'completed');
    assert.equal(s.auth.keyUsage(key).usedTokens, 0);
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM api_key_run_tokens').get()?.n, 0);
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM api_key_pending_runs').get()?.n, 1);
    assert.equal((await prune(s.store, { olderThanMs: 60000, now: Date.now() + 120000 })).runs, 0);
    await s.app.close();
    const driver = new FixtureModel();
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    await next.app.ready();
    next.auth.accounting.recover();
    assert.deepEqual(next.auth.keyUsage(key), { usedRuns: 1, usedTokens: 15, activeRuns: 0 });
    assert.equal(next.store.prepare('SELECT count(*) AS n FROM api_key_pending_runs').get()?.n, 0);
    assert.equal(driver.calls, 0);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});

test('a workflow child linkage write error cannot dispatch a child or reserve key capacity', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    assert.equal(
      (await s.request('POST', '/v1/workflows', { revision: 'new', definition })).statusCode,
      200,
    );
    s.store.db.exec(`CREATE TEMP TRIGGER fail_link BEFORE UPDATE OF payload ON workflow_executions
      WHEN json_type(NEW.payload,'$.nodes.only')='text' BEGIN SELECT RAISE(ABORT,'fixture link failed'); END`);
    const result = await s.request('POST', '/v1/workflows/probe/run', {});
    const records = new TaskWorkflows(s.store);
    await waitFor(() => records.execution('owner', result.json().id).status === 'failed');
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM runs').get()?.n, 0);
    assert.equal(s.auth.keyUsage(s.auth.authenticate('Bearer ' + token).keyId).usedRuns, 0);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});

test('actual gateway exit at child admission leaves one linked child and restart executes it once', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    assert.equal(
      (await s.request('POST', '/v1/workflows', { revision: 'new', definition })).statusCode,
      200,
    );
    const file = path.join(s.dir, 'config.json');
    await writeFile(file, JSON.stringify(s.config));
    await s.app.close();
    const stopped = spawnSync(
      process.execPath,
      [path.resolve('dist/test/fixtures/workflow-admission-crash.js'), file],
      { encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(stopped.status, 73, stopped.stderr);
    const driver = new FixtureModel();
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', driver]])),
    );
    const records = new TaskWorkflows(next.store),
      execution = records.executions('owner')[0]!;
    const children = next.store.allRuns(['queued']);
    assert.equal(children.length, 1);
    assert.equal(execution.nodes.only, children[0]!.id);
    assert.ok(workflowAllowsChildRecovery(next.store, children[0]!));
    await next.listen();
    await waitFor(() => records.execution('owner', execution.id).status === 'completed');
    assert.equal(driver.calls, 1);
    assert.equal(next.store.allRuns().length, 1);
    assert.equal(next.auth.keyUsage(children[0]!.checkpoint.keyId).usedRuns, 1);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});
