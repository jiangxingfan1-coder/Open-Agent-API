import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import http from 'node:http';
import { makeBundle } from '../src/lang/bundle.js';
import { workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { agent, FixtureModel, principal, secondToken, setup, token, waitFor } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof setup>>;
const request = (s: Gateway, input: string, key: string, auth = token) =>
  s.request('POST', '/v1/responses', { model: 'agent/test', input, background: true }, auth, {
    'idempotency-key': key,
  });
const count = (s: Gateway) => Number(s.store.prepare('SELECT count(*) AS n FROM runs').get()!.n);
function writer(s: Gateway) {
  const other = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'));
  other.exec('BEGIN IMMEDIATE');
  let active = true;
  return () => {
    if (active) {
      active = false;
      other.exec('ROLLBACK');
      other.close();
    }
  };
}
function attempts(t: TestContext, s: Gateway) {
  const original = s.store.createRun.bind(s.store),
    modes: string[] = [];
  t.mock.method(s.store, 'createRun', (...args: Parameters<typeof original>) => {
    modes.push(args[5] ?? 'sync');
    return original(...args);
  });
  return modes;
}
async function fixture() {
  const s = await setup();
  s.store.publish('owner', makeBundle(agent()));
  return s;
}
test('HTTP admission: an external writer leaves health and committed replays available; competing keys charge once', async (t) => {
  const s = await setup(undefined, { platform: { owner: 'owner', registration: 'open' } });
  let unlock = () => {};
  try {
    s.store.publish('owner', makeBundle(agent()));
    const platform = s.platform!;
    platform.putListing({ agentId: 'agent/test', price: { perRun: 1 } });
    const account = await platform.createAccount({
      email: 'admit@example.test',
      password: 'fixture-only-password',
      credits: 10,
    });
    const caller = platform.createKey(account.id, 'admission').token;
    const paid = (input: string, idem: string) => request(s, input, idem, caller);
    const first = await paid('seed', 'seed');
    const seed = first.json().id;
    await s.kernel.wait(seed);
    const key = s.auth.authenticate('Bearer ' + caller).keyId!;
    const modes = attempts(t, s);
    unlock = writer(s);
    const a = paid('same', 'pair');
    await waitFor(() => modes.includes('try'));
    const b = paid('same', 'pair');
    await waitFor(() => modes.includes('defer'));
    const conflict = paid('different', 'pair');
    const cached = await paid('seed', 'seed');
    assert.equal(cached.json().id, seed);
    assert.equal((await s.request('GET', '/health')).statusCode, 200);
    assert.equal(s.store.prepare('PRAGMA busy_timeout').get()!.timeout, 5000);
    assert.equal(count(s), 1);
    assert.equal(platform.account(account.id).balance, 9);
    assert.deepEqual(s.auth.keyUsage(key), { usedRuns: 1, usedTokens: 15, activeRuns: 0 });
    unlock();
    const [one, two, three] = await Promise.all([a, b, conflict]);
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(two.json().id, one.json().id);
    assert.equal(three.statusCode, 409, three.body);
    assert.equal(three.json().error.code, 'idempotency_conflict');
    await s.kernel.wait(one.json().id);
    assert.equal(count(s), 2);
    assert.equal(platform.account(account.id).balance, 8);
    assert.equal(
      s.store.prepare("SELECT count(*) AS n FROM platform_ledger WHERE kind='run'").get()!.n,
      2,
    );
    assert.equal(s.driver.calls, 2);
    assert.deepEqual(s.auth.keyUsage(key), { usedRuns: 2, usedTokens: 30, activeRuns: 0 });
    assert.equal(
      s.store.history(one.json().id).filter((e) => e.type === 'response.created').length,
      1,
    );
  } finally {
    unlock();
    await s.cleanup();
  }
});
test('HTTP admission: expiry has Retry-After and no durable side effects; explicit retry succeeds', async () => {
  const s = await fixture();
  const unlock = writer(s);
  try {
    const key = s.auth.authenticate('Bearer ' + token).keyId!;
    s.store.db.exec('PRAGMA busy_timeout=65');
    const timeout = await request(s, 'hello', 'again');
    assert.equal(timeout.statusCode, 503, timeout.body);
    assert.equal(timeout.json().error.code, 'admission_busy');
    assert.equal(timeout.headers['retry-after'], '1');
    assert.equal(timeout.headers['x-run-id'], undefined);
    assert.equal(s.store.prepare('PRAGMA busy_timeout').get()?.timeout, 65);
    assert.equal(count(s), 0);
    assert.equal(s.auth.keyUsage(key).usedRuns, 0);
    assert.equal(s.driver.calls, 0);
    unlock();
    const ok = await request(s, 'hello', 'again');
    await s.kernel.wait(ok.json().id);
    assert.equal(count(s), 1);
    assert.equal(s.driver.calls, 1);
  } finally {
    unlock();
    await s.cleanup();
  }
});
test('HTTP admission: a caller revoked while waiting cannot create or pay for a run', async (t) => {
  const s = await fixture();
  let unlock = () => {};
  try {
    const k = s.auth.create(principal, 'fixture', ['agent/test'], ['invoke', 'read']);
    const modes = attempts(t, s);
    unlock = writer(s);
    const response = request(s, 'sensitive', 'revoked', String(k.token));
    await waitFor(() => modes.length > 0);
    unlock();
    s.auth.revoke(principal, String(k.id));
    const result = await response;
    assert.equal(result.statusCode, 401, result.body);
    assert.equal(count(s), 0);
    assert.equal(s.driver.calls, 0);
    assert.equal(s.auth.keyUsage(String(k.id)).usedRuns, 0);
  } finally {
    unlock();
    await s.cleanup();
  }
});
test('HTTP admission: waiters are bounded and a changed grant cannot replace the captured grant', async (t) => {
  const s = await fixture();
  let unlock = () => {};
  try {
    const other = new FixtureModel(),
      conf = workerSchema.parse({
        nodeId: 'second-local',
        owner: 'second',
        dataDir: path.join(s.dir, 'other'),
      });
    s.hub.addLocal(
      {
        nodeId: conf.nodeId,
        owner: 'second',
        token: 'fixture',
        agents: ['*'],
        capabilities: ['*'],
      },
      new WorkerRuntime(conf, new Map(), new Map([['fixture', other]])),
    );
    s.store.publish('second', makeBundle(agent({ instructions: 'Second owner fixture.' })));
    const k = s.auth.create(principal, 'fixture', ['agent/test'], ['invoke', 'read']);
    const modes = attempts(t, s);
    unlock = writer(s);
    const pending = Array.from({ length: 8 }, (_, i) =>
      request(s, 'queued' + i, 'key' + i, String(k.token)),
    );
    await waitFor(() => modes.filter((m) => m === 'defer').length >= 7);
    const full = await request(s, 'not admitted', 'overflow', String(k.token));
    assert.equal(full.statusCode, 503, full.body);
    assert.equal(full.json().error.code, 'admission_busy');
    const independent = request(s, 'other tenant', 'key0', secondToken);
    await waitFor(() => modes.filter((m) => m === 'defer').length >= 9);
    assert.equal(count(s), 0);
    unlock();
    s.auth.updateQuota(principal, String(k.id), { maxRuns: 1 });
    for (const result of await Promise.all(pending)) {
      assert.equal(result.statusCode, 403, result.body);
      assert.equal(result.json().error.code, 'authorization_changed');
    }
    const admitted = await independent;
    assert.equal(admitted.statusCode, 200, admitted.body);
    await s.kernel.wait(admitted.json().id);
    assert.equal(count(s), 1);
    assert.equal(s.driver.calls, 0);
    assert.equal(other.calls, 1);
    const ok = await request(s, 'after', 'new', String(k.token));
    await s.kernel.wait(ok.json().id);
    assert.equal(s.driver.calls, 1);
  } finally {
    unlock();
    await s.cleanup();
  }
});
test('HTTP admission: disconnect before creation abandons the request without consuming its key', async (t) => {
  const s = await fixture(),
    base = await s.listen(),
    modes = attempts(t, s),
    unlock = writer(s);
  try {
    const stop = new AbortController();
    const opts = {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'idempotency-key': 'disconnect',
      },
      body: JSON.stringify({ model: 'agent/test', input: 'orphan', background: true }),
    };
    const outcome = fetch(base + '/v1/responses', { ...opts, signal: stop.signal }).catch(
      (e: unknown) => e,
    );
    await waitFor(() => modes.includes('try'));
    stop.abort();
    assert.ok((await outcome) instanceof Error);
    // A live HTTP round trip lets the server process the closed socket while the writer is still held.
    assert.equal((await fetch(base + '/health')).status, 200);
    unlock();
    const replacement = await request(s, 'different input', 'disconnect');
    assert.equal(replacement.statusCode, 200, replacement.body);
    await s.kernel.wait(replacement.json().id);
    assert.equal(count(s), 1);
    assert.equal(s.driver.calls, 1);
  } finally {
    unlock();
    await s.cleanup();
  }
});
test('HTTP admission: a storage error after BEGIN is never replayed', async (t) => {
  const s = await fixture();
  try {
    const attempts = t.mock.method(s.auth, 'stageKeyRun', () => {
      throw Object.assign(new Error('fixture failure after row insertion'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 5,
      });
    });
    const response = await request(s, 'fixture', 'post-begin');
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(attempts.mock.callCount(), 1);
    assert.equal(count(s), 0);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});

test('HTTP admission: chunked waiters reserve the route body allowance and give it back', async (t) => {
  const s = await fixture(),
    base = await s.listen(),
    modes = attempts(t, s),
    unlock = writer(s);
  try {
    const send = () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          base + '/v1/responses',
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + token,
              'content-type': 'application/json',
              'transfer-encoding': 'chunked',
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (s: string) => (body += s));
            res.on('end', () => resolve({ status: res.statusCode!, body }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'agent/test', input: 'body allowance', background: true }));
      });
    const oldest = send();
    await waitFor(() => modes.includes('try'));
    const full = await send();
    assert.equal(full.status, 503, full.body);
    assert.equal(JSON.parse(full.body).error.code, 'admission_busy');
    assert.equal(count(s), 0);
    unlock();
    const accepted = await oldest;
    assert.equal(accepted.status, 200);
    await s.kernel.wait(JSON.parse(accepted.body).id);
    assert.equal(s.driver.calls, 1);
  } finally {
    unlock();
    await s.cleanup();
  }
});
test('HTTP admission: closing the gateway rejects its waiters without creating orphan runs', async (t) => {
  const s = await fixture(),
    modes = attempts(t, s),
    unlock = writer(s);
  try {
    const pending = request(s, 'closing', 'closing');
    await waitFor(() => modes.includes('try'));
    const close = s.app.close();
    const response = await pending;
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'shutting_down');
    unlock();
    await close;
    const check = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'), { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    } finally {
      check.close();
    }
    assert.equal(s.driver.calls, 0);
  } finally {
    unlock();
    await s.cleanup();
  }
});
