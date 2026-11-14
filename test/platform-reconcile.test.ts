import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway/server.js';
import { clipOutput } from '../src/gateway/platform-runs.js';
import { ADMIN, call, newKey, signup, withPlatform, type Setup } from './platform-http.js';

// Developer platform (0.5.0): reconciliation of unsettled run rows at startup, and usage
// statistics computed in SQL. In-process inject only.

type Row = Record<string, unknown>;
const ledgerRows = (db: Setup['store']['db']) =>
  db.prepare('SELECT * FROM platform_ledger ORDER BY id').all() as Row[];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('reconcile: terminal runs settle, missing runs end interrupted, live runs stay; idempotent', async () => {
  await withPlatform({}, async (s) => {
    await call(
      s,
      'PUT',
      '/v1/platform/listings',
      { agent_id: 'agent/paid', price: { per_run: 1, per_1k_tokens: 0.2 } },
      ADMIN,
    );
    const dev = await signup(s, 'a@x.io');
    await call(
      s,
      'POST',
      `/v1/platform/accounts/${dev.account.id}/credit`,
      { amount: 10, note: 'seed' },
      ADMIN,
    );
    const key = (await newKey(s, dev.session)).token as string;
    const submit = async () =>
      (await s.request('POST', '/v1/responses', { model: 'agent/paid', input: 'hi' }, key)).json()
        .id as string;
    const done = await submit();
    const live = await submit();
    const db = s.store.db;
    // Undo the settlement of both runs, as if the gateway had stopped before settling them.
    for (const runId of [done, live]) {
      const row = db.prepare('SELECT * FROM platform_ledger WHERE run_id=?').get(runId)!;
      db.prepare('UPDATE platform_accounts SET balance=balance-? WHERE id=?').run(
        Number(row.amount),
        dev.account.id,
      );
      db.prepare(
        "UPDATE platform_ledger SET amount=0,tokens=0,status='in_progress' WHERE run_id=?",
      ).run(runId);
    }
    db.prepare(
      "UPDATE runs SET status='queued',payload=json_set(payload,'$.status','queued') WHERE id=?",
    ).run(live);
    db.prepare(
      `INSERT INTO platform_ledger(owner,account_id,kind,amount,balance_after,run_id,agent,tokens,status,note,payload,created_at)
       VALUES('owner',?,'run',0,0,'resp_gone','agent/paid',0,'in_progress','',?,?)`,
    ).run(dev.account.id, JSON.stringify({ perRun: 2_000_000, per1kTokens: 0 }), Date.now());
    assert.equal(s.platform!.account(dev.account.id).balance, 10);
    await s.app.close();

    const next = await createGateway(s.config, s.runtime);
    try {
      await next.app.ready();
      await tick();
      const platform = next.platform!;
      const byRun = (runId: string) =>
        next.store.db.prepare('SELECT * FROM platform_ledger WHERE run_id=?').get(runId)!;
      // 1 + 0.2 * 15 / 1000 = 1.003
      assert.equal(byRun(done).status, 'completed');
      assert.equal(Number(byRun(done).amount), -1_003_000);
      assert.equal(byRun(done).tokens, 15);
      assert.equal(byRun('resp_gone').status, 'interrupted');
      assert.equal(Number(byRun('resp_gone').amount), 0);
      assert.equal(byRun(live).status, 'in_progress');
      assert.equal(Number(byRun(live).amount), 0);
      assert.equal(platform.account(dev.account.id).balance, 10 - 1.003);
      assert.equal(platform.ledgerSum(dev.account.id), platform.account(dev.account.id).balance);
      const before = ledgerRows(next.store.db);
      assert.deepEqual(platform.reconcile(), { settled: 0, interrupted: 0, pending: 1 });
      assert.deepEqual(ledgerRows(next.store.db), before, 'a second pass changes nothing');
    } finally {
      await next.app.close();
    }
  });
});

test('reconcile: does nothing without unsettled rows', async () => {
  await withPlatform({}, async (s) => {
    assert.deepEqual(s.platform!.reconcile(), { settled: 0, interrupted: 0, pending: 0 });
  });
});

test('output text is clipped at 200,000 characters with an ellipsis', () => {
  assert.equal(clipOutput('abc'), 'abc');
  const exact = 'x'.repeat(200_000);
  assert.equal(clipOutput(exact), exact);
  const long = clipOutput('y'.repeat(200_001));
  assert.equal(long.length, 200_001);
  assert.ok(long.endsWith('…'));
  assert.equal(long.slice(0, 200_000), 'y'.repeat(200_000));
});

/** The 0.4.0 in-memory aggregation, kept here as the reference the SQL must match. */
function reference(rows: Row[], days: number, now: number, accountId?: string) {
  const DAY = 86_400_000;
  const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const since = Date.parse(`${utc(now)}T00:00:00.000Z`) - (days - 1) * DAY;
  const picked = rows.filter(
    (r) =>
      r.kind === 'run' &&
      Number(r.created_at) >= since &&
      (accountId === undefined || r.account_id === accountId),
  );
  type B = { runs: number; tokens: number; spent: number };
  const empty = (): B => ({ runs: 0, tokens: 0, spent: 0 });
  const totals = empty();
  const daily = new Map<string, B>();
  for (let i = 0; i < days; i++) daily.set(utc(since + i * DAY), empty());
  const byAgent = new Map<string, B>();
  const byAccount = new Map<string, B>();
  const add = (b: B, t: number, sp: number) => {
    b.runs++;
    b.tokens += t;
    b.spent += sp;
  };
  for (const r of picked) {
    const t = Number(r.tokens);
    const sp = Math.max(0, -Number(r.amount));
    add(totals, t, sp);
    const d = daily.get(utc(Number(r.created_at)));
    if (d) add(d, t, sp);
    for (const [map, k] of [
      [byAgent, String(r.agent)],
      [byAccount, String(r.account_id)],
    ] as const) {
      const b = map.get(k) ?? empty();
      map.set(k, b);
      add(b, t, sp);
    }
  }
  const sorted = (m: Map<string, B>) =>
    [...m].sort((a, b) => b[1].spent - a[1].spent || b[1].runs - a[1].runs);
  const p = (b: B) => ({ ...b, spent: b.spent / 1e6 });
  return {
    totals: p(totals),
    daily: [...daily].map(([date, b]) => ({ date, ...p(b) })),
    byAgent: sorted(byAgent).map(([agent, b]) => ({ agent, ...p(b) })),
    byAccount: sorted(byAccount).map(([accountId, b]) => ({ accountId, ...p(b) })),
  };
}

test('usage: SQL aggregation matches the in-memory reference on the same data', async () => {
  await withPlatform({}, async (s) => {
    const db = s.store.db;
    const now = Date.now();
    const DAY = 86_400_000;
    const insertAccount = db.prepare(
      "INSERT INTO platform_accounts(id,owner,email,balance,payload) VALUES(?,'owner',?,?,?)",
    );
    const insertRow = db.prepare(
      `INSERT INTO platform_ledger(owner,account_id,kind,amount,balance_after,run_id,agent,tokens,status,note,payload,created_at)
       VALUES('owner',?,?,?,0,?,?,?,?,'','{}',?)`,
    );
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let a = 0; a < 60; a++) {
      const id = `acct_${String(a).padStart(3, '0')}`;
      const payload = {
        name: id,
        status: a % 7 === 0 ? 'disabled' : 'active',
        createdAt: now,
        lastActiveAt: null,
        passwordHash: 'x',
      };
      insertAccount.run(id, `${id}@x.io`, rand(5_000_000), JSON.stringify(payload));
      const runs = 1 + rand(4);
      for (let r = 0; r < runs; r++) {
        // Some rows fall outside the 30-day window; some are equal-spend ties.
        const age = rand(40) * DAY + rand(DAY);
        const amount = rand(3) === 0 ? 0 : -(1 + rand(4)) * 250_000;
        insertRow.run(
          id,
          'run',
          amount,
          `resp_${a}_${r}`,
          `agent/${['paid', 'free', 'other'][rand(3)]}`,
          rand(500),
          'completed',
          now - age,
        );
      }
      insertRow.run(id, 'grant', 1_000_000, null, null, 0, null, now);
    }
    const rows = ledgerRows(db);
    const platform = s.platform!;
    for (const days of [1, 7, 30, 90]) {
      const ref = reference(rows, days, now);
      const admin = platform.adminUsage(days);
      assert.deepEqual(admin.totals, ref.totals, `totals ${days}`);
      assert.deepEqual(admin.daily, ref.daily, `daily ${days}`);
      assert.deepEqual(admin.byAgent, ref.byAgent, `byAgent ${days}`);
      const top = ref.byAccount.slice(0, 50);
      assert.deepEqual(
        admin.byAccount.map(({ email, ...rest }) => {
          assert.equal(email, `${rest.accountId}@x.io`);
          return rest;
        }),
        top,
        `byAccount ${days}`,
      );
      assert.ok(admin.byAccount.length <= 50);
      const one = reference(rows, days, now, 'acct_005');
      const mine = platform.usage('acct_005', days);
      assert.deepEqual(
        { totals: mine.totals, daily: mine.daily, byAgent: mine.byAgent },
        { totals: one.totals, daily: one.daily, byAgent: one.byAgent },
      );
    }
    assert.equal(reference(rows, 90, now).byAccount.length, 60, 'more than 50 accounts spent');
    const accounts = db.prepare('SELECT balance,payload FROM platform_accounts').all();
    const summary = platform.summary();
    const disabled = accounts.filter((a) => String(a.payload).includes('"disabled"')).length;
    assert.deepEqual(summary.accounts, {
      total: accounts.length,
      active: accounts.length - disabled,
      disabled,
    });
    assert.equal(
      summary.balanceTotal,
      accounts.reduce((sum, a) => sum + Number(a.balance), 0) / 1e6,
    );
    assert.equal(platform.adminUsage(30).balance, summary.balanceTotal);
  });
});
