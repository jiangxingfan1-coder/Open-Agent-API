import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle } from '../src/lang/bundle.js';
import { GATEWAY_FEATURES } from '../src/gateway/server.js';
import { gatewaySchema } from '../src/config/config.js';
import type { Platform } from '../src/gateway/platform.js';
import { agent, setup } from './helpers.js';

// Developer platform kernel (P1): accounts, sessions, account keys, codes. In-process only.

type Setup = Awaited<ReturnType<typeof setup>>;
const platformConfig = (extra: Record<string, unknown> = {}) => ({
  platform: { owner: 'owner', registration: 'open', ...extra },
});
async function withPlatform(
  extra: Record<string, unknown>,
  fn: (s: Setup, p: Platform) => Promise<void>,
): Promise<void> {
  const s = await setup(undefined, platformConfig(extra));
  try {
    assert.ok(s.platform, 'platform is constructed when configured');
    await fn(s, s.platform);
  } finally {
    await s.cleanup();
  }
}
const tableNames = (s: Setup) =>
  s.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'platform_%'")
    .all()
    .map((r) => String(r.name));

test('platform: without the section nothing changes (features, tables, routes)', async () => {
  const s = await setup();
  try {
    assert.equal(s.platform, undefined);
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(health.json().features, GATEWAY_FEATURES);
    assert.ok(!GATEWAY_FEATURES.includes('platform-v1'));
    assert.deepEqual(tableNames(s), []);
  } finally {
    await s.cleanup();
  }
});

test('platform: config validation and the platform-v1 feature', async () => {
  const base = { dataDir: '/tmp/x', keys: [{ name: 'k', owner: 'o', tokenEnv: 'OAA_UNUSED' }] };
  assert.throws(() =>
    gatewaySchema.parse({ ...base, platform: { owner: 'o', keyExecution: 'host' } }),
  );
  assert.throws(() => gatewaySchema.parse({ ...base, platform: { owner: 'o', extra: 1 } }));
  const parsed = gatewaySchema.parse({ ...base, platform: { owner: 'o' } }).platform!;
  assert.equal(parsed.registration, 'closed');
  assert.equal(parsed.keyExecution, 'workspace');
  assert.deepEqual(parsed.keyQuota, { rpm: 60, maxConcurrentRuns: 2 });
  assert.equal(parsed.maxKeysPerAccount, 10);
  assert.equal(parsed.sessionTtlHours, 720);
  await withPlatform({}, async (s) => {
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    const features = health.json().features as string[];
    assert.ok(features.includes('platform-v1'));
    assert.deepEqual(features, [...features].sort());
    assert.equal(features.length, GATEWAY_FEATURES.length + 1);
    assert.ok(tableNames(s).includes('platform_accounts'));
  });
});

test('platform: registration modes, email uniqueness, password length', async () => {
  await withPlatform({ registration: 'closed' }, async (_s, p) => {
    await assert.rejects(p.signup({ email: 'a@x.io', password: 'password1' }, 'ip'), {
      code: 'registration_closed',
    });
    // Operators can still create accounts.
    const created = await p.createAccount({ email: 'Op@X.io', password: 'password1', credits: 5 });
    assert.equal(created.email, 'op@x.io');
    assert.equal(created.balance, 5);
  });
  await withPlatform({ registration: 'invite' }, async (_s, p) => {
    await assert.rejects(p.signup({ email: 'a@x.io', password: 'password1' }, 'ip'), {
      code: 'invite_required',
    });
    await assert.rejects(
      p.signup({ email: 'a@x.io', password: 'password1', inviteCode: 'OAA-NOPE' }, 'ip'),
      { code: 'invalid_code' },
    );
    const [invite] = p.createCodes({ kind: 'invite', maxUses: 1, credits: 2 });
    const ok = await p.signup(
      { email: 'a@x.io', password: 'password1', inviteCode: invite!.code.toLowerCase() },
      'ip',
    );
    assert.equal(ok.account.balance, 2);
    await assert.rejects(
      p.signup({ email: 'b@x.io', password: 'password1', inviteCode: invite!.code }, 'ip'),
      { code: 'invalid_code' },
      'invite used up',
    );
    assert.equal(p.allCodes()[0]!.used, 1);
  });
  await withPlatform({ registration: 'open', signupCredits: 1.5 }, async (_s, p) => {
    const first = await p.signup({ email: 'Dev@Example.com', password: 'password1' }, 'ip');
    assert.equal(first.account.email, 'dev@example.com');
    assert.equal(first.account.balance, 1.5);
    assert.equal(first.account.status, 'active');
    assert.match(first.session.token, /^oas_/);
    assert.equal(p.ledgerSum(first.account.id), 1.5);
    await assert.rejects(p.signup({ email: 'DEV@example.com', password: 'password1' }, 'ip'), {
      code: 'email_taken',
    });
    await assert.rejects(p.signup({ email: 'c@x.io', password: 'short' }, 'ip'), {
      code: 'invalid_request',
    });
    await assert.rejects(p.signup({ email: 'c@x.io', password: 'x'.repeat(201) }, 'ip'), {
      code: 'invalid_request',
    });
    await assert.rejects(p.signup({ email: 'not-an-email', password: 'password1' }, 'ip'), {
      code: 'invalid_request',
    });
  });
});

test('platform: login errors are uniform and rate limited', async () => {
  await withPlatform({}, async (_s, p) => {
    await p.signup({ email: 'a@x.io', password: 'password1' }, 'ip0');
    const ok = await p.login({ email: 'A@X.IO', password: 'password1' }, 'ip1');
    assert.match(ok.session.token, /^oas_/);
    const wrong = await p.login({ email: 'a@x.io', password: 'password2' }, 'ip1').catch((e) => e);
    const missing = await p
      .login({ email: 'nobody@x.io', password: 'password1' }, 'ip1')
      .catch((e) => e);
    assert.equal(wrong.code, 'invalid_credentials');
    assert.equal(missing.code, 'invalid_credentials');
    assert.equal(wrong.message, missing.message);
    assert.equal(wrong.status, 401);
    // Per email: 10 attempts per window.
    for (let i = 0; i < 8; i++)
      await p.login({ email: 'a@x.io', password: 'bad-password' }, `ip-${i}`).catch(() => {});
    await assert.rejects(p.login({ email: 'a@x.io', password: 'password1' }, 'ip-z'), {
      code: 'rate_limited',
    });
  });
  await withPlatform({}, async (_s, p) => {
    for (let i = 0; i < 10; i++)
      await p.signup({ email: `u${i}@x.io`, password: 'password1' }, 'same-ip');
    await assert.rejects(p.signup({ email: 'u10@x.io', password: 'password1' }, 'same-ip'), {
      code: 'rate_limited',
    });
    await p.signup({ email: 'u10@x.io', password: 'password1' }, 'other-ip');
  });
});

test('platform: sessions expire, log out, and end on password change or disable', async () => {
  await withPlatform({}, async (s, p) => {
    const { account, session } = await p.signup({ email: 'a@x.io', password: 'password1' }, 'i');
    assert.equal(p.session(session.token).id, account.id);
    assert.throws(() => p.session('oas_unknown'), { code: 'session_invalid' });
    assert.throws(() => p.session('oaa_not_a_session'), { code: 'session_invalid' });

    s.store.db.prepare('UPDATE platform_sessions SET expires_at=?').run(Date.now() - 1);
    assert.throws(() => p.session(session.token), { code: 'session_invalid' });

    const second = (await p.login({ email: 'a@x.io', password: 'password1' }, 'i')).session;
    p.logout(second.token);
    assert.throws(() => p.session(second.token), { code: 'session_invalid' });

    const third = (await p.login({ email: 'a@x.io', password: 'password1' }, 'i')).session;
    await assert.rejects(p.changePassword(account.id, 'wrong-pass', 'password2'), {
      code: 'invalid_credentials',
    });
    await p.changePassword(account.id, 'password1', 'password2');
    assert.throws(() => p.session(third.token), { code: 'session_invalid' });
    await assert.rejects(p.login({ email: 'a@x.io', password: 'password1' }, 'i'), {
      code: 'invalid_credentials',
    });

    const fourth = (await p.login({ email: 'a@x.io', password: 'password2' }, 'i')).session;
    await p.resetPassword(account.id, 'password3');
    assert.throws(() => p.session(fourth.token), { code: 'session_invalid' });

    const fifth = (await p.login({ email: 'a@x.io', password: 'password3' }, 'i')).session;
    const key = p.createKey(account.id, 'k1');
    p.setAccountStatus(account.id, 'disabled');
    assert.throws(() => p.session(fifth.token), { code: 'session_invalid' });
    await assert.rejects(p.login({ email: 'a@x.io', password: 'password3' }, 'i'), {
      code: 'account_disabled',
    });
    const denied = await s.request('GET', '/v1/me', undefined, key.token);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'account_disabled');
    p.setAccountStatus(account.id, 'active');
    assert.equal((await s.request('GET', '/v1/me', undefined, key.token)).statusCode, 200);
    // A session token is not an API key.
    const asKey = await s.request('GET', '/v1/me', undefined, fifth.token);
    assert.equal(asKey.statusCode, 401);
  });
});

test('platform: account key principal follows the listings; key limit; /v1/keys unchanged', async () => {
  await withPlatform({ maxKeysPerAccount: 2, keyExecution: 'sandbox' }, async (s, p) => {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/b' })));
    const { account } = await p.signup({ email: 'a@x.io', password: 'password1' }, 'i');
    const k1 = p.createKey(account.id, 'first');
    assert.match(k1.token, /^sk-oaa-/);
    p.createKey(account.id, 'second');
    assert.throws(() => p.createKey(account.id, 'third'), { code: 'key_limit_reached' });
    p.revokeKey(account.id, k1.id);
    const k3 = p.createKey(account.id, 'third');
    assert.deepEqual(
      p.keys(account.id).map((k) => [k.name, k.revoked]),
      [
        ['third', false],
        ['second', false],
      ],
      'the deleted key is gone from the list',
    );
    assert.equal((await s.request('GET', '/v1/me', undefined, k1.token)).statusCode, 401);

    const principal = () => s.auth.revalidate(`Bearer ${k3.token}`);
    assert.equal(principal().subject, `acct:${account.id}`);
    assert.equal(principal().accountId, account.id);
    assert.deepEqual(principal().scopes, ['invoke', 'read', 'files']);
    assert.equal(principal().execution, 'sandbox');
    assert.deepEqual(principal().quota, { rpm: 60, maxConcurrentRuns: 2 });
    assert.deepEqual(principal().agents, []);
    assert.throws(() => p.putListing({ agentId: 'agent/missing' }), { code: 'agent_not_found' });
    p.putListing({ agentId: 'agent/a', title: 'A' });
    assert.deepEqual(principal().agents, ['agent/a']);
    p.putListing({ agentId: 'agent/b', enabled: false });
    assert.deepEqual(principal().agents, ['agent/a']);
    assert.deepEqual(
      p.listedAgents().map((a) => a.id),
      ['agent/a'],
    );
    assert.throws(() => p.listedAgent('agent/b'), { code: 'agent_not_found' });
    const listed = p.listedAgent('agent/a');
    assert.equal(listed.kind, 'kernel');
    assert.deepEqual(listed.models, ['auto']);
    assert.ok(listed.conversion);

    // Unlisted agents cannot be called; no run is created.
    const denied = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/b', input: 'hi' },
      k3.token,
    );
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    p.deleteListing('agent/a');
    assert.deepEqual(principal().agents, []);
    assert.throws(() => p.deleteListing('agent/a'), { code: 'listing_not_found' });

    // The console key list does not include account keys.
    const keys = (await s.request('GET', '/v1/keys')).json() as { data?: unknown[] } | unknown[];
    const rows = (Array.isArray(keys) ? keys : (keys.data ?? [])) as { id: string }[];
    assert.ok(rows.every((k) => !k.id || ![k1.id, k3.id].includes(k.id)));
  });
});

test('platform: accounts are isolated subjects; keys of one account share runs', async () => {
  await withPlatform({}, async (s, p) => {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/free' })));
    p.putListing({ agentId: 'agent/free' });
    const a = (await p.signup({ email: 'a@x.io', password: 'password1' }, 'i')).account;
    const b = (await p.signup({ email: 'b@x.io', password: 'password1' }, 'i')).account;
    const a1 = p.createKey(a.id, 'a1').token;
    const a2 = p.createKey(a.id, 'a2').token;
    const b1 = p.createKey(b.id, 'b1').token;
    const created = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/free', input: 'hi' },
      a1,
    );
    assert.equal(created.json().status, 'completed', created.body);
    const runId = created.json().id as string;
    assert.equal((await s.request('GET', `/v1/responses/${runId}`, undefined, a2)).statusCode, 200);
    assert.equal((await s.request('GET', `/v1/responses/${runId}`, undefined, b1)).statusCode, 404);
    const listed = (await s.request('GET', '/v1/runs', undefined, b1)).json().data as unknown[];
    assert.equal(listed.length, 0);
  });
});

test('platform: credit codes — use limits, expiry, revocation, one use per account', async () => {
  await withPlatform({}, async (s, p) => {
    const a = (await p.signup({ email: 'a@x.io', password: 'password1' }, 'i')).account;
    const b = (await p.signup({ email: 'b@x.io', password: 'password1' }, 'i')).account;
    const c = (await p.signup({ email: 'c@x.io', password: 'password1' }, 'i')).account;
    assert.throws(() => p.createCodes({ kind: 'credit', credits: 0 }), { code: 'invalid_request' });
    assert.throws(() => p.createCodes({ kind: 'credit', credits: 1, count: 101 }), {
      code: 'invalid_request',
    });
    const codes = p.createCodes({ kind: 'credit', credits: 2.25, maxUses: 2, count: 3 });
    assert.equal(codes.length, 3);
    assert.equal(new Set(codes.map((x) => x.code)).size, 3);
    // Only hashes are stored.
    const stored = JSON.stringify(s.store.db.prepare('SELECT * FROM platform_codes').all());
    for (const code of codes) assert.ok(!stored.includes(code.code));

    const [one, two, three] = codes;
    const credited = p.redeem(a.id, one!.code);
    assert.equal(credited.credited, 2.25);
    assert.equal(credited.account.balance, 2.25);
    assert.throws(() => p.redeem(a.id, one!.code), { code: 'invalid_code' }, 'same account');
    p.redeem(b.id, one!.code);
    assert.throws(() => p.redeem(c.id, one!.code), { code: 'invalid_code' }, 'used up');

    p.revokeCode(two!.id);
    assert.throws(() => p.redeem(c.id, two!.code), { code: 'invalid_code' }, 'revoked');
    assert.throws(() => p.revokeCode('code_missing'), { code: 'code_not_found' });

    s.store.db
      .prepare('UPDATE platform_codes SET payload=json_set(payload,?,?) WHERE id=?')
      .run('$.expiresAt', Date.now() - 1, three!.id);
    assert.throws(() => p.redeem(c.id, three!.code), { code: 'invalid_code' }, 'expired');
    const [invite] = p.createCodes({ kind: 'invite' });
    assert.throws(() => p.redeem(c.id, invite!.code), { code: 'invalid_code' }, 'invite ≠ credit');
    assert.equal(p.account(a.id).balance, p.ledgerSum(a.id));
    assert.equal(p.account(b.id).balance, 2.25);
  });
});

test('platform: operator account management and summary', async () => {
  await withPlatform({}, async (_s, p) => {
    const a = await p.createAccount({ email: 'a@x.io', password: 'password1', name: 'Ann' });
    await p.createAccount({ email: 'b@y.io', password: 'password1' });
    const adjusted = p.creditAccount(a.id, 10, 'welcome');
    assert.equal(adjusted.account.balance, 10);
    assert.equal(adjusted.entry.kind, 'adjust');
    assert.equal(adjusted.entry.balanceAfter, 10);
    assert.throws(() => p.creditAccount(a.id, -10.000001, 'too much'), {
      code: 'insufficient_balance',
    });
    p.creditAccount(a.id, -4, 'back');
    assert.equal(p.account(a.id).balance, 6);
    assert.equal(p.ledgerSum(a.id), 6);
    assert.throws(() => p.account('acct_missing'), { code: 'account_not_found' });
    const page = p.adminAccounts({ query: 'x.io' });
    assert.deepEqual(
      page.data.map((x) => [x.email, x.name, x.keys, x.runs]),
      [['a@x.io', 'Ann', 0, 0]],
    );
    const ledger = p.accountLedger(a.id, { limit: 1 });
    assert.equal(ledger.data[0]!.amount, -4);
    assert.ok(ledger.nextCursor);
    assert.equal(
      p.accountLedger(a.id, { limit: 1, cursor: ledger.nextCursor! }).data[0]!.amount,
      10,
    );
    p.setAccountStatus(a.id, 'disabled');
    const summary = p.summary();
    assert.deepEqual(summary.accounts, { total: 2, active: 1, disabled: 1 });
    assert.equal(summary.balanceTotal, 6);
    assert.throws(
      () => p.requireOperator({ owner: 'owner', name: 'x', agents: ['*'], scopes: ['read'] }),
      {
        code: 'scope_denied',
      },
    );
  });
});
