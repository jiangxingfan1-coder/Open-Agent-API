import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Fault } from '../src/core/util.js';
import { makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { isWriteUnavailable } from '../src/store/checkpoint.js';
import { Store } from '../src/store/store.js';
import { agent, FixtureModel, principal, setup, token, waitFor } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof setup>>;
async function start(s: Gateway, model = 'agent/test') {
  const r = await s.request('POST', '/v1/responses', { model, input: 'fixture', background: true });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.json().id);
}

for (const mode of ['restore', 'restart'] as const)
  test(`kernel: missing writes mid-model never settle an uncommitted outcome (${mode})`, async () => {
    let s: Gateway;
    const driver = new FixtureModel(() => {
      s.store.db.exec('PRAGMA query_only=ON');
      return { text: 'text that cannot be persisted' };
    });
    s = await setup(driver);
    let again: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      s.store.publish('owner', makeBundle(agent()));
      const key = s.auth.authenticate('Bearer ' + token).keyId!;
      const id = await start(s);
      await waitFor(() => driver.calls === 1);
      assert.equal((await s.request('GET', '/health')).statusCode, 200);
      assert.equal(s.store.run(id).status, 'in_progress');
      assert.equal(s.auth.keyUsage(key).activeRuns, 1);
      if (mode === 'restore') {
        s.store.db.exec('PRAGMA query_only=OFF');
        await waitFor(() => s.store.run(id).status === 'failed');
        assert.equal(s.store.run(id).error?.code, 'persistence_failed');
        assert.equal(s.store.history(id).filter((e) => e.type === 'response.failed').length, 1);
        assert.equal(s.auth.keyUsage(key).activeRuns, 0);
      } else {
        assert.throws(() => new Store(s.config.dataDir), { code: 'gateway_already_running' });
        await s.app.close();
        again = await createGateway(s.config, s.runtime);
        await again.app.ready();
        assert.equal(again.store.run(id).status, 'interrupted');
        assert.equal(again.store.history(id).filter((e) => e.type === 'run.interrupted').length, 1);
        assert.equal(again.auth.keyUsage(key).activeRuns, 0);
        assert.throws(() => new Store(s.config.dataDir), { code: 'gateway_already_running' });
      }
      assert.equal(driver.calls, 1);
    } finally {
      await again?.app.close();
      await s.cleanup();
    }
  });

for (const mode of ['busy', 'full', 'ambiguous'] as const)
  test(`kernel: finished output survives terminal commit failure (${mode}) without rerunning the model`, async (t) => {
    const s = await setup();
    let locker: DatabaseSync | undefined,
      first = true;
    try {
      s.store.publish('owner', makeBundle(agent()));
      const key = s.auth.authenticate('Bearer ' + token).keyId!;
      const db = s.store.db;
      db.exec('CREATE TABLE fixture_space(bytes BLOB)');
      const original = s.store.checkpointTerminal.bind(s.store);
      const errors: number[] = [];
      const timeout = () => Number(db.prepare('PRAGMA busy_timeout').get()!.timeout),
        normal = timeout();
      const lockWaits: number[] = [];
      const exec = db.exec.bind(db);
      if (mode === 'busy')
        t.mock.method(db, 'exec', (sql: string) => {
          if (locker && sql === 'BEGIN IMMEDIATE') lockWaits.push(timeout());
          return exec(sql);
        });
      t.mock.method(s.store, 'checkpointTerminal', (...args: Parameters<typeof original>) => {
        if (args[0].status !== 'completed' || !first) return original(...args);
        first = false;
        if (mode === 'busy') {
          locker = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'));
          locker.exec('BEGIN IMMEDIATE');
        } else if (mode === 'full') {
          const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count);
          db.exec(`PRAGMA max_page_count=${pages + 8};
          CREATE TEMP TRIGGER fill_fixture BEFORE UPDATE OF status ON runs WHEN NEW.status='completed'
          BEGIN INSERT INTO fixture_space VALUES(zeroblob(1048576)); END;`);
        }
        try {
          original(...args);
          if (mode === 'ambiguous')
            throw Object.assign(new Error('lost acknowledgement after commit'), {
              code: 'ERR_SQLITE_ERROR',
              errcode: 10,
            });
        } catch (error) {
          errors.push((error as { errcode: number }).errcode);
          throw error;
        }
      });
      const id = await start(s);
      await waitFor(() => errors.length > 0);
      assert.deepEqual(errors, [{ busy: 5, full: 13, ambiguous: 10 }[mode]]);
      assert.equal(s.store.run(id).status, mode === 'ambiguous' ? 'completed' : 'in_progress');
      assert.equal(s.auth.keyUsage(key).activeRuns, 1);
      if (locker) {
        assert.ok(lockWaits.length > 0 && lockWaits.every((ms) => ms === 0));
        assert.ok(normal > 0);
        assert.equal(timeout(), normal, 'restore the connection timeout after the attempt');
        assert.equal((await s.request('GET', '/health')).statusCode, 200);
        locker.exec('ROLLBACK');
        locker.close();
        locker = undefined;
      }
      if (mode === 'full') db.exec('DROP TRIGGER fill_fixture; PRAGMA max_page_count=1000000');
      await waitFor(() => s.auth.keyUsage(key).activeRuns === 0);
      const saved = s.store.run(id);
      assert.equal(saved.status, 'completed');
      assert.equal(saved.output[0]?.text, 'Fixture response.');
      assert.equal(saved.usage?.total_tokens, 15);
      assert.equal(s.store.history(id).filter((e) => e.type === 'response.completed').length, 1);
      assert.equal(s.driver.calls, 1);
    } finally {
      locker?.close();
      await s.cleanup();
    }
  });

test('kernel: an opaque native operation remains uncertain when its outcome and step cannot be committed', async () => {
  const s = await setup();
  let calls = 0;
  try {
    s.hub.addLocal(
      { nodeId: 'opaque', owner: 'owner', token: 'fixture', agents: ['*'], capabilities: ['*'] },
      {
        advertisement: () => ({
          nodeId: 'opaque',
          providers: [],
          natives: ['adapter/opaque'],
          capabilities: [],
          warm: [],
          concurrency: 1,
        }),
        install: async () => {},
        close: async () => {},
        execute: async () => {
          calls++;
          s.store.db.exec('PRAGMA query_only=ON');
          throw new Fault('native_incomplete', 'Unconfirmed external outcome.', 502, true);
        },
      },
    );
    s.store.publish('owner', makeBundle(agent({ engine: 'adapter/opaque', model: 'default' })));
    const id = await start(s);
    await waitFor(() => calls > 0);
    assert.equal(s.store.run(id).status, 'in_progress');
    assert.equal(s.store.steps(id)[0]?.status, 'running');
    s.store.db.exec('PRAGMA query_only=OFF');
    await waitFor(() => s.store.run(id).status === 'interrupted');
    assert.equal(s.store.steps(id)[0]?.status, 'uncertain');
    assert.equal(s.store.run(id).error?.code, 'effect_outcome_unknown');
    assert.throws(() => s.kernel.resume(principal, id), { code: 'reconciliation_required' });
    assert.equal(calls, 1);
  } finally {
    await s.cleanup();
  }
});

test('store: an unknown same-PID lease is never assumed closed; only storage availability is retryable', async () => {
  const s = await setup();
  try {
    await s.app.close();
    const db = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'));
    try {
      db.prepare('INSERT INTO gateway_owner VALUES(1,?,?)').run(
        process.pid,
        'legacy-or-other-isolate',
      );
    } finally {
      db.close();
    }
    assert.throws(() => new Store(s.config.dataDir), { code: 'gateway_already_running' });
    const error = (errcode: number) =>
      Object.assign(new Error('fixture'), { code: 'ERR_SQLITE_ERROR', errcode });
    for (const n of [5, 6, 8, 10, 13, 14, 8 | (3 << 8)]) assert.ok(isWriteUnavailable(error(n)));
    for (const n of [1, 11, 19, 26]) assert.ok(!isWriteUnavailable(error(n)));
    assert.ok(!isWriteUnavailable(new Error('database is busy')));
  } finally {
    await s.cleanup();
  }
});
