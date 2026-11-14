import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle } from '../src/lang/bundle.js';
import type { Platform } from '../src/gateway/platform.js';
import { runCharge } from '../src/gateway/platform-billing.js';
import { agent, setup } from './helpers.js';

// Developer platform billing (P1): per-run + per-token charges, idempotent settlement, balance
// checks before a run exists, and the ledger invariant. In-process only.

type Setup = Awaited<ReturnType<typeof setup>>;
async function withBilling(fn: (s: Setup, p: Platform) => Promise<void>): Promise<void> {
  const s = await setup(undefined, { platform: { owner: 'owner', registration: 'open' } });
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/paid' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/free' })));
    s.platform!.putListing({ agentId: 'agent/paid', price: { perRun: 1.5, per1kTokens: 0.2 } });
    s.platform!.putListing({ agentId: 'agent/free' });
    await fn(s, s.platform!);
  } finally {
    await s.cleanup();
  }
}
async function developer(p: Platform, email: string, credits = 0) {
  const account = await p.createAccount({ email, password: 'password1', credits });
  return { account, key: p.createKey(account.id, 'k') };
}
/** Expected point values computed with floats, rounded the way the platform reports them. */
const pts = (x: number) => Math.round(x * 1e6) / 1e6;
const runRow = (s: Setup, runId: string) =>
  s.store.db.prepare("SELECT * FROM platform_ledger WHERE run_id=? AND kind='run'").all(runId);

test('billing: charge arithmetic is integer micro-points, rounded up', () => {
  const price = { perRun: 1_500_000, per1kTokens: 200_000 };
  assert.equal(runCharge(price, 'completed', 15), 1_500_000 + 3_000);
  assert.equal(runCharge(price, 'failed', 15), 3_000);
  assert.equal(runCharge(price, 'cancelled', 0), 0);
  assert.equal(runCharge({ perRun: 0, per1kTokens: 1 }, 'completed', 1), 1, 'ceil to 1 micro');
  assert.equal(
    runCharge({ perRun: 0, per1kTokens: 1_000_000_000 }, 'completed', 1_000_000_000),
    1_000_000_000_000_000,
    'no float overflow',
  );
});

test('billing: completed run pays per run + per token; balance equals the ledger', async () => {
  await withBilling(async (s, p) => {
    const { account, key } = await developer(p, 'a@x.io', 10);
    const done = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/paid', input: 'hi' },
      key.token,
    );
    assert.equal(done.json().status, 'completed', done.body);
    const runId = done.json().id as string;
    const tokens = done.json().usage.total_tokens as number;
    assert.equal(tokens, 15);
    // 1.5 + 0.2 * 15 / 1000 = 1.503
    assert.equal(p.account(account.id).balance, pts(10 - 1.503));
    assert.equal(p.ledgerSum(account.id), p.account(account.id).balance);
    const rows = runRow(s, runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'completed');
    assert.equal(rows[0]!.tokens, 15);
    assert.equal(rows[0]!.agent, 'agent/paid');
    const ledger = p.ledger(account.id).data;
    assert.equal(ledger[0]!.kind, 'run');
    assert.equal(ledger[0]!.amount, -1.503);
    assert.equal(ledger[1]!.kind, 'grant');
    const usage = p.usage(account.id, 7);
    assert.equal(usage.daily.length, 7);
    assert.equal(usage.daily.at(-1)!.date, new Date().toISOString().slice(0, 10));
    assert.deepEqual(usage.totals, { runs: 1, tokens: 15, spent: 1.503 });
    assert.deepEqual(usage.byAgent, [{ agent: 'agent/paid', runs: 1, tokens: 15, spent: 1.503 }]);
    const admin = p.adminUsage(30);
    assert.equal(admin.byAccount[0]!.email, 'a@x.io');
    assert.equal(p.summary().runsTotal, 1);
    assert.equal(p.adminAccounts().data[0]!.runs, 1);
    assert.deepEqual(p.meAccount(s.auth.revalidate(`Bearer ${key.token}`)), {
      id: account.id,
      balance: pts(10 - 1.503),
    });
    assert.equal(
      p.meAccount(s.auth.revalidate(`Bearer test-owner-key-not-a-provider-credential-0000001`)),
      undefined,
    );
    // The owner's own key is never billed.
    const own = await s.request('POST', '/v1/responses', { model: 'agent/paid', input: 'hi' });
    assert.equal(own.json().status, 'completed');
    assert.equal(runRow(s, own.json().id).length, 0);
  });
});

test('billing: insufficient balance is refused before a run exists; free agents need none', async () => {
  await withBilling(async (s, p) => {
    const { account, key } = await developer(p, 'a@x.io', 1);
    const refused = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/paid', input: 'hi' },
      key.token,
    );
    assert.equal(refused.statusCode, 402, refused.body);
    assert.equal(refused.json().error.code, 'insufficient_balance');
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    // Zero balance on a paid agent with only a token price is refused too.
    p.putListing({ agentId: 'agent/paid', price: { perRun: 0 } });
    p.creditAccount(account.id, -1, 'drain');
    const zero = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/paid', input: 'hi' },
      key.token,
    );
    assert.equal(zero.statusCode, 402);
    const free = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/free', input: 'hi' },
      key.token,
    );
    assert.equal(free.json().status, 'completed', free.body);
    assert.equal(p.account(account.id).balance, 0);
    assert.equal(runRow(s, free.json().id).length, 1);
    assert.equal(p.ledgerSum(account.id), 0);
  });
});

test('billing: failures pay tokens only; repeated settlement adjusts, never double-charges', async () => {
  await withBilling(async (s, p) => {
    const { account, key } = await developer(p, 'a@x.io', 10);
    const principal = s.auth.revalidate(`Bearer ${key.token}`);
    const hooks = s.auth;
    hooks.checkQuotaForRun(principal, 'agent/paid');
    hooks.beginKeyRun(principal.keyId, 'owner', 'resp_failed', 'agent/paid');
    hooks.beginKeyRun(principal.keyId, 'owner', 'resp_failed', 'agent/paid');
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_failed', 1000, 'failed');
    assert.equal(p.account(account.id).balance, pts(10 - 0.2));

    // Interrupted, then resumed and completed: one row, difference charged once.
    hooks.beginKeyRun(principal.keyId, 'owner', 'resp_resume', 'agent/paid');
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_resume', 500, 'interrupted');
    assert.equal(p.account(account.id).balance, pts(10 - 0.2 - 0.1));
    // Non-terminal releases do not settle.
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_resume', 900, 'queued');
    assert.equal(p.account(account.id).balance, pts(10 - 0.2 - 0.1));
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_resume', 1000, 'completed');
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_resume', 1000, 'completed');
    assert.equal(runRow(s, 'resp_resume').length, 1);
    assert.equal(p.account(account.id).balance, pts(10 - 0.2 - 1.7));
    assert.equal(p.ledgerSum(account.id), p.account(account.id).balance);

    // A price change does not affect a run already in progress.
    hooks.beginKeyRun(principal.keyId, 'owner', 'resp_price', 'agent/paid');
    p.putListing({ agentId: 'agent/paid', price: { perRun: 5, per1kTokens: 0 } });
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_price', 0, 'completed');
    assert.equal(p.account(account.id).balance, pts(10 - 0.2 - 1.7 - 1.5));

    p.putListing({ agentId: 'agent/paid', price: { perRun: 1.5, per1kTokens: 0.2 } });
    // Token charges stop at a zero balance (never overdrawn); the next paid submission is refused.
    hooks.beginKeyRun(principal.keyId, 'owner', 'resp_big', 'agent/paid');
    hooks.finishKeyRun(principal.keyId, 'owner', 'resp_big', 100_000_000, 'failed');
    assert.equal(p.account(account.id).balance, 0);
    assert.equal(runRow(s, 'resp_big')[0]!.amount, -6_600_000);
    assert.throws(
      () => hooks.checkQuotaForRun(s.auth.revalidate(`Bearer ${key.token}`), 'agent/paid'),
      {
        code: 'insufficient_balance',
      },
    );
    assert.equal(p.ledgerSum(account.id), p.account(account.id).balance);
    const balance = s.store.db
      .prepare('SELECT balance FROM platform_accounts WHERE id=?')
      .get(account.id)!.balance;
    const sum = s.store.db
      .prepare('SELECT sum(amount) AS s FROM platform_ledger WHERE account_id=?')
      .get(account.id)!.s;
    assert.equal(balance, sum, 'integer invariant in the database');
  });
});
