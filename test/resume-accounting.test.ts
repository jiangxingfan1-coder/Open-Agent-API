import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { sleep } from '../src/core/util.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { FixtureModel, agent, principal, setup, token, waitFor } from './helpers.js';
import { call, newKey, pts, signup } from './platform-http.js';
import { Store } from '../src/store/store.js';

// 中断、恢复、重启之后，密钥用量、密钥并发、平台流水与余额四者自洽。进程内 inject，不监听端口。
//
// 每个场景：智能体 agent/slow 第一轮调用内置工具 list_files，第二轮回答。第一次执行时第二轮模型调用
// 一直挂起，网关优雅关闭把运行中断（经 releaseRun，状态 interrupted）；之后用同一数据目录重开网关，
// 第二轮立即返回。FixtureModel 每次完成的模型调用记 15 个 token（10 输入、5 输出），所以中断时
// 运行用了 15，恢复并完成后共 30。

type Gateway = Awaited<ReturnType<typeof createGateway>>;
type Env = Awaited<ReturnType<typeof slowSetup>>;

const ADMIN = token;
async function slowSetup(extra: Record<string, unknown> = {}) {
  const gate = { hang: true, parked: 0 };
  const model = new FixtureModel(async (_a, messages, signal) => {
    if (!messages.some((m) => m.role === 'tool'))
      return { calls: [{ id: 'ls', name: 'list_files', arguments: {} }] };
    if (gate.hang) {
      gate.parked++;
      await sleep(60_000, signal);
    }
    return { text: 'done' };
  });
  const s = await setup(model, extra);
  for (const id of ['agent/slow', 'agent/other'])
    s.store.publish('owner', makeBundle(agent({ id, tools: [builtin('list_files')] })));
  return { s, gate, model };
}
/** Same data directory, slow released. */
async function reopen(env: Env): Promise<Gateway> {
  env.gate.hang = false;
  const g = await createGateway(
    env.s.config,
    new WorkerRuntime(
      env.s.runtime.config,
      env.s.runtime.handlers,
      new Map([['fixture', env.model]]),
    ),
  );
  await g.app.ready();
  await new Promise((resolve) => setImmediate(resolve));
  return g;
}
function inject(
  g: Gateway,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  bearer: string,
  payload?: unknown,
) {
  return g.app.inject({
    method,
    url,
    payload: payload as never,
    headers: { authorization: `Bearer ${bearer}` },
  });
}
async function submit(g: Gateway, bearer: string, model = 'agent/slow'): Promise<string> {
  const r = await inject(g, 'POST', '/v1/responses', bearer, {
    model,
    input: 'x',
    background: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().id as string;
}
/** Waits until `count` model calls are parked on the gate in total. */
async function parked(env: Env, count: number) {
  await waitFor(() => env.gate.parked >= count);
}
async function finish(env: Env, g: Gateway | undefined) {
  if (g) await g.app.close();
  else await env.s.app.close();
  await rm(env.s.dir, { recursive: true, force: true });
}
const ledger = (g: Gateway, runId: string) =>
  g.store.db.prepare('SELECT * FROM platform_ledger WHERE run_id=?').get(runId) as Record<
    string,
    unknown
  >;

/** An owner key with a quota, plus a run interrupted by a graceful shutdown. */
async function interruptedKeyRun(quota: Record<string, number> = {}) {
  const env = await slowSetup();
  const key = env.s.auth.create(principal, 'caller', ['*'], ['invoke', 'read'], quota);
  const runId = await submit(env.s, key.token as string);
  await parked(env, 1);
  assert.deepEqual(env.s.auth.keyUsage(key.id as string), {
    usedTokens: 0,
    usedRuns: 1,
    activeRuns: 1,
  });
  await env.s.app.close();
  return { env, keyId: key.id as string, bearer: key.token as string, runId };
}

test('interrupt -> resume -> complete: key tokens counted once, concurrency tracked, usedRuns unchanged', async () => {
  const { env, keyId, bearer, runId } = await interruptedKeyRun({ maxConcurrentRuns: 1 });
  const g = await reopen(env);
  try {
    assert.equal(g.store.run(runId).status, 'interrupted');
    assert.equal(g.store.run(runId).usage?.total_tokens, 15);
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 15, usedRuns: 1, activeRuns: 0 });
    const resumed = await inject(g, 'POST', `/v1/runs/${runId}/resume`, bearer);
    assert.equal(resumed.statusCode, 200, resumed.body);
    // The resumed run counts against the key's concurrency again (usedRuns stays 1).
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 15, usedRuns: 1, activeRuns: 1 });
    const blocked = await inject(g, 'POST', '/v1/responses', bearer, {
      model: 'agent/slow',
      input: 'y',
      background: true,
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'key_concurrency_limit');
    const done = await g.kernel.wait(runId);
    assert.equal(done.status, 'completed');
    assert.equal(done.usage?.total_tokens, 30);
    // 30, not 15 + 30.
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 30, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(env, g);
  }
});

test('failed resume reservation leaves the run interrupted and retryable without new usage', async () => {
  const { env, keyId, bearer, runId } = await interruptedKeyRun();
  const g = await reopen(env);
  try {
    const before = g.auth.keyUsage(keyId);
    g.store.db.exec(
      "CREATE TEMP TRIGGER fail_rejoin BEFORE INSERT ON api_key_pending_runs BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END",
    );
    assert.equal((await inject(g, 'POST', `/v1/runs/${runId}/resume`, bearer)).statusCode, 500);
    assert.equal(g.store.run(runId).status, 'interrupted');
    assert.equal(g.kernel.stats().queued, 0);
    assert.deepEqual(g.auth.keyUsage(keyId), before);
    g.store.db.exec('DROP TRIGGER fail_rejoin');
    assert.equal((await inject(g, 'POST', `/v1/runs/${runId}/resume`, bearer)).statusCode, 200);
    assert.equal((await g.kernel.wait(runId)).status, 'completed');
    assert.deepEqual(g.auth.keyUsage(keyId), { usedRuns: 1, usedTokens: 30, activeRuns: 0 });
  } finally {
    await finish(env, g);
  }
});

test('interrupt -> no resume: tokens used before the interruption are counted once', async () => {
  const { env, keyId, runId } = await interruptedKeyRun();
  const g = await reopen(env);
  try {
    assert.equal(g.store.run(runId).status, 'interrupted');
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 15, usedRuns: 1, activeRuns: 0 });
    // A second restart does not count the interrupted run again.
    await g.app.close();
    const h = await reopen(env);
    try {
      assert.deepEqual(h.auth.keyUsage(keyId), { usedTokens: 15, usedRuns: 1, activeRuns: 0 });
    } finally {
      await finish(env, h);
    }
  } catch (error) {
    await g.app.close().catch(() => {});
    throw error;
  }
});

test('resume re-checks the key quota: token budget and run count', async () => {
  const tokens = await interruptedKeyRun({ maxTotalTokens: 10 });
  let g = await reopen(tokens.env);
  try {
    const r = await inject(g, 'POST', `/v1/runs/${tokens.runId}/resume`, tokens.bearer);
    assert.equal(r.statusCode, 429, r.body);
    assert.equal(r.json().error.code, 'token_quota_exceeded');
    assert.equal(g.store.run(tokens.runId).status, 'interrupted', 'the run is left as it was');
    assert.deepEqual(g.auth.keyUsage(tokens.keyId), { usedTokens: 15, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(tokens.env, g);
  }
  // maxRuns: the resumed run is the same run, so a quota of 1 still allows it; a quota lowered
  // below the runs already used refuses it.
  const runs = await interruptedKeyRun({ maxRuns: 1 });
  g = await reopen(runs.env);
  try {
    const r = await inject(g, 'POST', `/v1/runs/${runs.runId}/resume`, runs.bearer);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await g.kernel.wait(runs.runId)).status, 'completed');
    assert.deepEqual(g.auth.keyUsage(runs.keyId), { usedTokens: 30, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(runs.env, g);
  }
  const lowered = await interruptedKeyRun({ maxRuns: 1 });
  g = await reopen(lowered.env);
  try {
    g.auth.updateQuota(principal, lowered.keyId, { maxRuns: 1 });
    // Another run of the same key already used the single run.
    g.store.db.prepare('UPDATE api_key_usage SET used_runs=2 WHERE key_id=?').run(lowered.keyId);
    await g.app.close();
    g = await reopen(lowered.env);
    const r = await inject(g, 'POST', `/v1/runs/${lowered.runId}/resume`, lowered.bearer);
    assert.equal(r.statusCode, 429, r.body);
    assert.equal(r.json().error.code, 'run_quota_exceeded');
    assert.equal(g.store.run(lowered.runId).status, 'interrupted');
  } finally {
    await finish(lowered.env, g);
  }
});

test('concurrency limit 1: resuming while another run of the key is in progress is refused', async () => {
  const { env, keyId, bearer, runId } = await interruptedKeyRun({ maxConcurrentRuns: 1 });
  env.gate.hang = true;
  const g = await createGateway(
    env.s.config,
    new WorkerRuntime(
      env.s.runtime.config,
      env.s.runtime.handlers,
      new Map([['fixture', env.model]]),
    ),
  );
  try {
    await g.app.ready();
    const other = await submit(g, bearer);
    await parked(env, 2);
    const r = await inject(g, 'POST', `/v1/runs/${runId}/resume`, bearer);
    assert.equal(r.statusCode, 429, r.body);
    assert.equal(r.json().error.code, 'key_concurrency_limit');
    assert.equal(g.store.run(runId).status, 'interrupted');
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 15, usedRuns: 2, activeRuns: 1 });
    // The owner's admin resuming it is held to the run's key too.
    const admin = await inject(g, 'POST', `/v1/runs/${runId}/resume`, ADMIN);
    assert.equal(admin.statusCode, 429, admin.body);
    assert.equal(admin.json().error.code, 'key_concurrency_limit');
  } finally {
    await finish(env, g);
  }
});

test('restart re-counts queued runs of a key in its concurrency', async () => {
  const env = await slowSetup();
  const key = env.s.auth.create(principal, 'caller', ['*'], ['invoke', 'read'], {
    maxConcurrentRuns: 1,
  });
  const runId = await submit(env.s, key.token as string);
  await parked(env, 1);
  await env.s.app.close();
  // As if the gateway had stopped while the run was still queued.
  const reopened = await reopen(env);
  await reopened.app.close();
  const raw = new Store(env.s.config.dataDir);
  const run = raw.run(runId);
  run.status = 'queued';
  run.error = null;
  raw.save(run);
  raw.close();
  env.gate.hang = true;
  const g = await createGateway(
    env.s.config,
    new WorkerRuntime(
      env.s.runtime.config,
      env.s.runtime.handlers,
      new Map([['fixture', env.model]]),
    ),
  );
  try {
    await g.app.ready();
    // What listen() does after binding the port (no port is opened here).
    g.kernel.start();
    assert.equal(g.auth.keyUsage(key.id as string).activeRuns, 1);
    assert.equal(g.auth.keyUsage(key.id as string).usedRuns, 1);
    const r = await inject(g, 'POST', '/v1/responses', key.token as string, {
      model: 'agent/slow',
      input: 'y',
      background: true,
    });
    assert.equal(r.statusCode, 429, r.body);
    assert.equal(r.json().error.code, 'key_concurrency_limit');
  } finally {
    await finish(env, g);
  }
});

test('resume by the owner admin checks the run key, not the admin key: revoked, expired', async () => {
  const revoked = await interruptedKeyRun();
  let g = await reopen(revoked.env);
  try {
    g.auth.revoke(principal, revoked.keyId);
    // The original key can no longer authenticate at all.
    const own = await inject(g, 'POST', `/v1/runs/${revoked.runId}/resume`, revoked.bearer);
    assert.equal(own.statusCode, 401);
    const r = await inject(g, 'POST', `/v1/runs/${revoked.runId}/resume`, ADMIN);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, 'run_key_inactive');
    assert.equal(g.store.run(revoked.runId).status, 'interrupted');
    assert.equal(g.auth.keyUsage(revoked.keyId).activeRuns, 0);
  } finally {
    await finish(revoked.env, g);
  }
  const expired = await interruptedKeyRun();
  g = await reopen(expired.env);
  try {
    g.auth.updateQuota(principal, expired.keyId, { expiresAt: Date.now() - 1000 });
    const own = await inject(g, 'POST', `/v1/runs/${expired.runId}/resume`, expired.bearer);
    assert.equal(own.statusCode, 401);
    assert.equal(own.json().error.code, 'key_expired');
    const r = await inject(g, 'POST', `/v1/runs/${expired.runId}/resume`, ADMIN);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, 'run_key_inactive');
    assert.equal(g.store.run(expired.runId).status, 'interrupted');
  } finally {
    await finish(expired.env, g);
  }
  // A key that is still valid: the admin may resume it, and the run counts against that key.
  const valid = await interruptedKeyRun({ maxConcurrentRuns: 1 });
  g = await reopen(valid.env);
  try {
    const r = await inject(g, 'POST', `/v1/runs/${valid.runId}/resume`, ADMIN);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(g.auth.keyUsage(valid.keyId).activeRuns, 1);
    assert.equal((await g.kernel.wait(valid.runId)).status, 'completed');
    assert.deepEqual(g.auth.keyUsage(valid.keyId), { usedTokens: 30, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(valid.env, g);
  }
});

// ---- developer platform -------------------------------------------------------------------

/** per_run 1, per_1k_tokens 0.2 (micro-points: 1_000_000 and 200_000). */
async function interruptedAccountRun(balance = 10) {
  const env = await slowSetup({ platform: { owner: 'owner', registration: 'open' } });
  const s = env.s;
  const listed = await call(
    s,
    'PUT',
    '/v1/platform/listings',
    { agent_id: 'agent/slow', price: { per_run: 1, per_1k_tokens: 0.2 } },
    ADMIN,
  );
  assert.equal(listed.statusCode, 200, listed.body);
  const dev = await signup(s, 'a@x.io');
  if (balance)
    await call(
      s,
      'POST',
      `/v1/platform/accounts/${dev.account.id}/credit`,
      { amount: balance, note: 'seed' },
      ADMIN,
    );
  const key = await newKey(s, dev.session);
  const runId = await submit(s, key.token as string);
  await parked(env, 1);
  await s.app.close();
  return { env, accountId: dev.account.id as string, key, runId };
}

test('platform: interrupt settles the tokens used; resume and completion settle the difference', async () => {
  const { env, accountId, key, runId } = await interruptedAccountRun();
  const g = await reopen(env);
  try {
    const platform = g.platform!;
    // Settled at interruption: 0.2 * 15 / 1000 = 0.003 (no per-run charge).
    let row = ledger(g, runId);
    assert.equal(row.status, 'interrupted');
    assert.equal(Number(row.amount), -3_000);
    assert.equal(row.tokens, 15);
    assert.equal(platform.account(accountId).balance, pts(10 - 0.003));
    assert.deepEqual(platform.reconcile(), { settled: 0, interrupted: 0, pending: 0 });
    assert.deepEqual(g.auth.keyUsage(key.id), { usedTokens: 15, usedRuns: 1, activeRuns: 0 });

    const r = await inject(g, 'POST', `/v1/runs/${runId}/resume`, key.token);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(ledger(g, runId).status, 'in_progress', 'running again');
    assert.equal(g.auth.keyUsage(key.id).activeRuns, 1);
    const done = await g.kernel.wait(runId);
    assert.equal(done.status, 'completed');
    // 1 + 0.2 * 30 / 1000 = 1.006, charged once in total.
    row = ledger(g, runId);
    assert.equal(row.status, 'completed');
    assert.equal(Number(row.amount), -1_006_000);
    assert.equal(row.tokens, 30);
    assert.equal(platform.account(accountId).balance, pts(10 - 1.006));
    assert.equal(platform.ledgerSum(accountId), platform.account(accountId).balance);
    assert.deepEqual(g.auth.keyUsage(key.id), { usedTokens: 30, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(env, g);
  }
});

test('platform: a run interrupted by a crash settles at reconcile; a settled row is not reset after purge', async () => {
  const { env, accountId, runId } = await interruptedAccountRun();
  // As if the gateway had crashed: the run still in progress, the ledger row unsettled.
  const reopened = await reopen(env);
  const row = ledger(reopened, runId);
  reopened.store.db
    .prepare('UPDATE platform_accounts SET balance=balance-? WHERE id=?')
    .run(Number(row.amount), accountId);
  reopened.store.db
    .prepare("UPDATE platform_ledger SET amount=0,tokens=0,status='in_progress' WHERE run_id=?")
    .run(runId);
  reopened.store.db
    .prepare(
      "UPDATE runs SET status='in_progress',payload=json_set(payload,'$.status','in_progress') WHERE id=?",
    )
    .run(runId);
  await reopened.app.close();
  const g = await reopen(env);
  try {
    // store.recover marked it interrupted; startup reconciliation charged its 15 tokens.
    assert.equal(g.store.run(runId).status, 'interrupted');
    assert.equal(ledger(g, runId).status, 'interrupted');
    assert.equal(Number(ledger(g, runId).amount), -3_000);
    assert.equal(g.platform!.account(accountId).balance, pts(10 - 0.003));
    // The run is purged: reconcile leaves the settled row alone.
    g.store.db.exec('PRAGMA foreign_keys=OFF');
    g.store.db.prepare('DELETE FROM runs WHERE id=?').run(runId);
    g.store.db.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(g.platform!.reconcile(), { settled: 0, interrupted: 0, pending: 0 });
    assert.equal(Number(ledger(g, runId).amount), -3_000);
    assert.equal(g.platform!.ledgerSum(accountId), g.platform!.account(accountId).balance);
  } finally {
    await finish(env, g);
  }
});

test('platform: resume is refused for a disabled account, an unlisted agent, a low balance', async () => {
  const cases: [string, (g: Gateway, accountId: string) => Promise<void>, number, string][] = [
    [
      'disabled',
      async (g, accountId) => {
        const r = await inject(g, 'POST', `/v1/platform/accounts/${accountId}/status`, ADMIN, {
          status: 'disabled',
        });
        assert.equal(r.statusCode, 200, r.body);
      },
      403,
      'account_disabled',
    ],
    [
      'unlisted',
      async (g) => {
        const r = await inject(g, 'PUT', '/v1/platform/listings', ADMIN, {
          agent_id: 'agent/slow',
          enabled: false,
        });
        assert.equal(r.statusCode, 200, r.body);
      },
      403,
      'scope_denied',
    ],
    [
      'balance',
      async (g, accountId) => {
        const balance = g.platform!.account(accountId).balance;
        const r = await inject(g, 'POST', `/v1/platform/accounts/${accountId}/credit`, ADMIN, {
          amount: -(balance - 0.5),
          note: 'drain',
        });
        assert.equal(r.statusCode, 200, r.body);
      },
      402,
      'insufficient_balance',
    ],
  ];
  for (const [name, change, status, code] of cases) {
    const { env, accountId, key, runId } = await interruptedAccountRun();
    const g = await reopen(env);
    try {
      await change(g, accountId);
      const before = ledger(g, runId);
      const balance = g.platform!.account(accountId).balance;
      for (const bearer of name === 'disabled' ? [ADMIN] : [key.token as string, ADMIN]) {
        const r = await inject(g, 'POST', `/v1/runs/${runId}/resume`, bearer);
        assert.equal(r.statusCode, status, `${name}: ${r.body}`);
        assert.equal(r.json().error.code, code, name);
      }
      if (name === 'disabled') {
        // The account key itself no longer authenticates.
        const own = await inject(g, 'POST', `/v1/runs/${runId}/resume`, key.token as string);
        assert.equal(own.json().error.code, 'account_disabled');
      }
      assert.equal(g.store.run(runId).status, 'interrupted', name);
      assert.deepEqual(ledger(g, runId), before, `${name}: ledger untouched`);
      assert.equal(g.platform!.account(accountId).balance, balance, name);
      assert.equal(g.auth.keyUsage(key.id).activeRuns, 0, name);
    } finally {
      await finish(env, g);
    }
  }
});

test('platform: interrupt -> restart -> resume by the admin -> complete', async () => {
  const { env, accountId, key, runId } = await interruptedAccountRun();
  let g = await reopen(env);
  await g.app.close();
  g = await reopen(env);
  try {
    assert.equal(Number(ledger(g, runId).amount), -3_000);
    const r = await inject(g, 'POST', `/v1/runs/${runId}/resume`, ADMIN);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(g.auth.keyUsage(key.id).activeRuns, 1);
    assert.equal((await g.kernel.wait(runId)).status, 'completed');
    assert.equal(Number(ledger(g, runId).amount), -1_006_000);
    assert.equal(g.platform!.account(accountId).balance, pts(10 - 1.006));
    assert.deepEqual(g.auth.keyUsage(key.id), { usedTokens: 30, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(env, g);
  }
});

test('upgrade: runs interrupted before this version are not counted twice when resumed', async () => {
  const { env, keyId, bearer, runId } = await interruptedKeyRun();
  // The data directory of an earlier version: no per-run record, the 15 tokens already counted.
  const raw = new Store(env.s.config.dataDir);
  raw.db.exec('DROP TABLE api_key_run_tokens');
  raw.close();
  const g = await reopen(env);
  try {
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 15, usedRuns: 1, activeRuns: 0 });
    const r = await inject(g, 'POST', `/v1/runs/${runId}/resume`, bearer);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await g.kernel.wait(runId)).status, 'completed');
    assert.deepEqual(g.auth.keyUsage(keyId), { usedTokens: 30, usedRuns: 1, activeRuns: 0 });
  } finally {
    await finish(env, g);
  }
});
