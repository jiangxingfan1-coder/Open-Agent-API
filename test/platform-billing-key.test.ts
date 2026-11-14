import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewaySchema } from '../src/config/config.js';
import { principal, secondToken, setup } from './helpers.js';
import { ADMIN, call, keysOf, signup, withPlatform, type Setup } from './platform-http.js';

// Developer platform (0.5.0): the `billing` scope for payment callbacks and `reference`
// de-duplication of credits. In-process inject only.

const billingKey = (s: Setup, scopes = ['billing'], agents = ['*']) =>
  s.auth.create(principal, 'pay', agents, scopes).token as string;

test('billing key: credits (positive only) and finds accounts by email; nothing else', async () => {
  await withPlatform({}, async (s) => {
    const { account, session } = await signup(s, 'buyer@x.io');
    const pay = billingKey(s);
    const found = await call(s, 'GET', '/v1/platform/accounts?query=buyer', undefined, pay);
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().data[0].id, account.id);
    const credit = await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: 3, note: 'order 1' },
      pay,
    );
    assert.equal(credit.statusCode, 200, credit.body);
    assert.equal(credit.json().account.balance, 3);
    const debit = await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: -1, note: 'refund' },
      pay,
    );
    assert.equal(debit.statusCode, 403);
    assert.equal(debit.json().error.code, 'scope_denied');
    // The owner-wide admin may still debit.
    const adminDebit = await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: -1, note: 'refund' },
      ADMIN,
    );
    assert.equal(adminDebit.statusCode, 200, adminDebit.body);
    const denied: [Parameters<typeof call>[1], string, unknown?][] = [
      ['GET', '/v1/platform/summary'],
      ['POST', '/v1/platform/accounts', { email: 'z@x.io', password: 'password1' }],
      ['POST', `/v1/platform/accounts/${account.id}/status`, { status: 'disabled' }],
      ['POST', `/v1/platform/accounts/${account.id}/password`, { new_password: 'password9' }],
      ['POST', `/v1/platform/accounts/${account.id}/reset-code`],
      ['GET', `/v1/platform/accounts/${account.id}/ledger`],
      ['GET', '/v1/platform/listings'],
      ['PUT', '/v1/platform/listings', { agent_id: 'agent/paid' }],
      ['GET', '/v1/platform/codes'],
      ['POST', '/v1/platform/codes', { kind: 'invite' }],
      ['GET', '/v1/platform/usage'],
      ['GET', '/v1/keys'],
      ['POST', '/v1/keys', { name: 'x', agents: ['*'], scopes: ['read'] }],
      ['GET', '/v1/agents'],
      ['GET', '/v1/errors'],
      ['GET', '/openapi.json'],
      ['POST', '/v1/responses', { model: 'agent/free', input: 'hi' }],
    ];
    for (const [method, url, payload] of denied) {
      const r = await call(s, method, url, payload, pay);
      assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`);
      assert.equal(r.json().error.code, 'scope_denied', `${method} ${url}`);
    }
    // Portal routes take sessions, never API keys.
    assert.equal(
      (await call(s, 'GET', '/v1/portal/account', undefined, pay)).json().error.code,
      'session_invalid',
    );
    assert.equal((await call(s, 'GET', '/v1/portal/account', undefined, session)).statusCode, 200);
  });
});

test('billing key: only for the platform owner; the scope is accepted by POST /v1/keys', async () => {
  await withPlatform({}, async (s) => {
    const { account } = await signup(s, 'buyer@x.io');
    const made = await call(
      s,
      'POST',
      '/v1/keys',
      { name: 'pay', agents: ['agent/free'], scopes: ['billing'] },
      ADMIN,
    );
    assert.equal(made.statusCode, 200, made.body);
    assert.deepEqual(made.json().scopes, ['billing']);
    const ok = await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: 1, note: 'n' },
      made.json().token,
    );
    assert.equal(ok.statusCode, 200, ok.body);
    // A billing key of another owner.
    const other = await call(
      s,
      'POST',
      '/v1/keys',
      { name: 'pay', agents: ['*'], scopes: ['billing'] },
      secondToken,
    );
    assert.equal(other.statusCode, 200, other.body);
    for (const url of [
      `/v1/platform/accounts/${account.id}/credit`,
      '/v1/platform/accounts?query=buyer',
    ]) {
      const r = await call(
        s,
        url.endsWith('credit') ? 'POST' : 'GET',
        url,
        url.endsWith('credit') ? { amount: 1, note: 'n' } : undefined,
        other.json().token,
      );
      assert.equal(r.statusCode, 403, url);
      assert.equal(r.json().error.code, 'scope_denied', url);
    }
    // A plain read key cannot credit.
    const read = s.auth.create(principal, 'r', ['*'], ['read']).token as string;
    const r = await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: 1, note: 'n' },
      read,
    );
    assert.equal(r.json().error.code, 'scope_denied');
    const unknown = await call(
      s,
      'POST',
      '/v1/keys',
      { name: 'x', agents: ['*'], scopes: ['billing', 'pay'] },
      ADMIN,
    );
    assert.equal(unknown.statusCode, 400);
  });
});

test('billing key: usable on the API host when consoleHosts is configured', async () => {
  const API = 'api.example.com';
  const CONSOLE = 'console.example.com';
  await withPlatform(
    {},
    async (s) => {
      const { account } = await signup(s, 'buyer@x.io');
      const pay = billingKey(s);
      const r = await call(
        s,
        'POST',
        `/v1/platform/accounts/${account.id}/credit`,
        { amount: 2, note: 'n' },
        pay,
        { host: API },
      );
      assert.equal(r.statusCode, 200, r.body);
      const admin = await call(
        s,
        'POST',
        `/v1/platform/accounts/${account.id}/credit`,
        { amount: 2, note: 'n' },
        ADMIN,
        { host: API },
      );
      assert.equal(admin.json().error.code, 'admin_host_denied');
      const audit = s.store.db
        .prepare("SELECT payload FROM audit_events WHERE code='platform_credit_adjusted'")
        .all();
      assert.equal(audit.length, 1, 'the billing credit is audited');
    },
    { allowedHosts: [API, CONSOLE, 'localhost'], consoleHosts: [CONSOLE] },
  );
});

test('credit reference: a repeat returns the first result, a different amount conflicts', async () => {
  await withPlatform({}, async (s) => {
    const { account } = await signup(s, 'buyer@x.io');
    const other = await signup(s, 'other@x.io');
    const pay = billingKey(s);
    const url = `/v1/platform/accounts/${account.id}/credit`;
    const first = await call(s, 'POST', url, { amount: 5, note: 'p', reference: 'ord_1' }, pay);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(keysOf(first.json()), ['account', 'entry']);
    assert.equal(first.json().entry.reference, 'ord_1');
    const again = await call(s, 'POST', url, { amount: 5, note: 'p', reference: 'ord_1' }, pay);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().duplicate, true);
    assert.deepEqual(again.json().entry, first.json().entry);
    assert.equal(again.json().account.balance, 5);
    const conflict = await call(s, 'POST', url, { amount: 6, note: 'p', reference: 'ord_1' }, pay);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'reference_conflict');
    const elsewhere = await call(
      s,
      'POST',
      `/v1/platform/accounts/${other.account.id}/credit`,
      { amount: 5, note: 'p', reference: 'ord_1' },
      pay,
    );
    assert.equal(elsewhere.statusCode, 409, 'one reference belongs to one account');
    assert.equal(s.platform!.account(account.id).balance, 5);
    assert.equal(s.platform!.ledgerSum(account.id), 5);
    for (const reference of ['', 'x'.repeat(201)]) {
      const r = await call(s, 'POST', url, { amount: 1, note: 'p', reference }, pay);
      assert.equal(r.statusCode, 400, `reference length ${reference.length}`);
    }
    // The ledger shows the reference; entries without one are unchanged.
    const ledger = await call(
      s,
      'GET',
      `/v1/platform/accounts/${account.id}/ledger`,
      undefined,
      ADMIN,
    );
    assert.equal(ledger.json().data[0].reference, 'ord_1');
    const plain = await call(s, 'POST', url, { amount: 1, note: 'p' }, pay);
    assert.equal('reference' in plain.json().entry, false);
  });
});

test('credit reference: recorded in the same transaction as the entry', async () => {
  await withPlatform({}, async (s) => {
    const { account } = await signup(s, 'buyer@x.io');
    const url = `/v1/platform/accounts/${account.id}/credit`;
    // A debit below zero fails: neither the entry nor the reference may remain.
    const fail = await call(s, 'POST', url, { amount: -1, note: 'p', reference: 'ord_x' }, ADMIN);
    assert.equal(fail.statusCode, 402);
    const refs = s.store.db.prepare('SELECT count(*) AS n FROM platform_references').get()!;
    assert.equal(Number(refs.n), 0);
    const ok = await call(s, 'POST', url, { amount: 2, note: 'p', reference: 'ord_x' }, ADMIN);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().duplicate, undefined);
  });
});

test('without platform: the 0.5.0 routes and tables do not exist; config accepts billing', async () => {
  const s = await setup();
  try {
    for (const [method, url] of [
      ['GET', '/v1/portal/runs'],
      ['GET', '/v1/portal/runs/resp_x'],
      ['POST', '/v1/portal/password-reset'],
      ['POST', '/v1/platform/accounts/acct_x/reset-code'],
    ] as const) {
      const r = await call(s, method, url, method === 'POST' ? {} : undefined, ADMIN);
      assert.equal(r.statusCode, 404, url);
      assert.equal(r.json().error.code, 'route_not_found', url);
    }
    const tables = s.store.db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'platform_%'")
      .all();
    assert.deepEqual(tables, []);
    const spec = (await call(s, 'GET', '/openapi.json', undefined, ADMIN)).json();
    assert.ok(!Object.keys(spec.paths).some((p) => p.startsWith('/v1/portal/')));
  } finally {
    await s.cleanup();
  }
  const parsed = gatewaySchema.parse({
    dataDir: '/tmp/x',
    keys: [{ name: 'pay', owner: 'o', tokenEnv: 'OAA_UNUSED', scopes: ['billing'] }],
  });
  assert.deepEqual(parsed.keys[0]!.scopes, ['billing']);
});
