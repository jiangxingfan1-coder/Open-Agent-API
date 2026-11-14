import test from 'node:test';
import assert from 'node:assert/strict';
import { principal, secondToken } from './helpers.js';
import { ADMIN, call, keysOf, newKey, pts, signup, withPlatform } from './platform-http.js';

// Developer platform routes (P2), operator side: who may call, every route's shape and main
// errors. The audit trail and OpenAPI are in platform-audit.test.ts. In-process inject only.

const ACCOUNT_KEYS = ['balance', 'created_at', 'email', 'id', 'name', 'status'];
const ADMIN_ACCOUNT_KEYS = [...ACCOUNT_KEYS, 'keys', 'last_active_at', 'runs', 'spent'].sort();
const LISTING_KEYS = [
  'agent_exists',
  'agent_id',
  'auto_approvals',
  'blocked_by',
  'callable',
  'enabled',
  'host_execution',
  'price',
  'requires_host',
  'summary',
  'tags',
  'title',
  'updated_at',
  'usage_reported',
];
const CODE_KEYS = [
  'created_at',
  'credits',
  'expires_at',
  'id',
  'kind',
  'max_uses',
  'note',
  'revoked',
  'used',
];

test('operator routes need an owner-wide admin key of the platform owner', async () => {
  await withPlatform({}, async (s) => {
    const { account, session } = await signup(s);
    const accountKey = await newKey(s, session);
    const limited = s.auth.create(principal, 'limited', ['agent/paid'], ['admin', 'read']);
    const routes: [Parameters<typeof call>[1], string, unknown?][] = [
      ['GET', '/v1/platform/summary'],
      ['GET', '/v1/platform/accounts'],
      ['POST', '/v1/platform/accounts', { email: 'z@x.io', password: 'password1' }],
      ['POST', `/v1/platform/accounts/${account.id}/status`, { status: 'disabled' }],
      ['POST', `/v1/platform/accounts/${account.id}/credit`, { amount: 1, note: 'n' }],
      ['POST', `/v1/platform/accounts/${account.id}/password`, { new_password: 'password9' }],
      ['GET', `/v1/platform/accounts/${account.id}/ledger`],
      ['GET', '/v1/platform/listings'],
      ['PUT', '/v1/platform/listings', { agent_id: 'agent/paid' }],
      ['DELETE', '/v1/platform/listings?agent_id=agent%2Fpaid'],
      ['GET', '/v1/platform/codes'],
      ['POST', '/v1/platform/codes', { kind: 'invite' }],
      ['DELETE', '/v1/platform/codes/code_x'],
      ['GET', '/v1/platform/usage'],
    ];
    for (const [method, url, payload] of routes) {
      const anonymous = await call(s, method, url, payload);
      assert.equal(anonymous.statusCode, 401, `${method} ${url}`);
      for (const [who, credential] of [
        ['account key', accountKey.token as string],
        ['admin limited to one agent', limited.token as string],
        ['admin of another owner', secondToken],
      ] as const) {
        const r = await call(s, method, url, payload, credential);
        assert.equal(r.statusCode, 403, `${who}: ${method} ${url}: ${r.body}`);
        assert.equal(r.json().error.code, 'scope_denied', `${who}: ${method} ${url}`);
      }
    }
    // Nothing above changed anything.
    assert.equal(
      (await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN)).json().accounts.total,
      1,
    );
    assert.equal(s.platform!.account(account.id).status, 'active');
    assert.equal(
      (await call(s, 'GET', '/v1/platform/listings', undefined, ADMIN)).json().data.length,
      0,
    );
  });
});

test('operator: accounts, status, credit adjustments, password reset and ledger', async () => {
  await withPlatform({ registration: 'closed' }, async (s) => {
    const empty = await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN);
    assert.deepEqual(keysOf(empty.json()), [
      'accounts',
      'balance_total',
      'listings',
      'registration',
      'runs_total',
      'site_name',
      'spent_total',
      'tokens_total',
    ]);
    assert.deepEqual(empty.json().accounts, { total: 0, active: 0, disabled: 0 });

    const made = await call(
      s,
      'POST',
      '/v1/platform/accounts',
      {
        email: 'Ann@X.io',
        password: 'password1',
        name: 'Ann',
        credits: 5,
      },
      ADMIN,
    );
    assert.equal(made.statusCode, 201, made.body);
    assert.deepEqual(keysOf(made.json()), ['account']);
    assert.deepEqual(keysOf(made.json().account), ACCOUNT_KEYS);
    assert.equal(made.json().account.email, 'ann@x.io');
    assert.equal(made.json().account.balance, 5);
    const id = made.json().account.id as string;
    const dup = await call(
      s,
      'POST',
      '/v1/platform/accounts',
      { email: 'ann@x.io', password: 'password1' },
      ADMIN,
    );
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error.code, 'email_taken');
    const unknownField = await call(
      s,
      'POST',
      '/v1/platform/accounts',
      {
        email: 'q@x.io',
        password: 'password1',
        role: 'x',
      },
      ADMIN,
    );
    assert.equal(unknownField.statusCode, 400);
    assert.equal(unknownField.json().error.code, 'invalid_request');
    for (const email of ['bob@x.io', 'cy@x.io'])
      await call(s, 'POST', '/v1/platform/accounts', { email, password: 'password1' }, ADMIN);

    // Closed registration does not stop the operator.
    const closed = await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN);
    assert.equal(closed.json().accounts.total, 3);

    const page = await call(s, 'GET', '/v1/platform/accounts?limit=2', undefined, ADMIN);
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(keysOf(page.json()), ['data', 'next_cursor']);
    assert.equal(page.json().data.length, 2);
    assert.deepEqual(keysOf(page.json().data[0]), ADMIN_ACCOUNT_KEYS);
    assert.equal(typeof page.json().next_cursor, 'number');
    const rest = await call(
      s,
      'GET',
      `/v1/platform/accounts?limit=2&cursor=${page.json().next_cursor}`,
      undefined,
      ADMIN,
    );
    assert.equal(rest.json().data.length, 1);
    assert.equal(rest.json().next_cursor, null);
    const found = await call(s, 'GET', '/v1/platform/accounts?query=ANN', undefined, ADMIN);
    assert.deepEqual(
      found.json().data.map((a: { email: string }) => a.email),
      ['ann@x.io'],
    );
    assert.equal(
      (await call(s, 'GET', '/v1/platform/accounts?limit=0', undefined, ADMIN)).statusCode,
      400,
    );
    assert.equal(
      (await call(s, 'GET', '/v1/platform/accounts?sort=x', undefined, ADMIN)).statusCode,
      400,
    );

    // Credit: signed, noted, never below zero.
    const credit = await call(
      s,
      'POST',
      `/v1/platform/accounts/${id}/credit`,
      { amount: 2.25, note: 'top up' },
      ADMIN,
    );
    assert.equal(credit.statusCode, 200, credit.body);
    assert.deepEqual(keysOf(credit.json()), ['account', 'entry']);
    assert.equal(credit.json().account.balance, 7.25);
    assert.deepEqual(credit.json().entry, {
      id: credit.json().entry.id,
      kind: 'adjust',
      amount: 2.25,
      balance_after: 7.25,
      agent: null,
      run_id: null,
      tokens: 0,
      status: null,
      note: 'top up',
      created_at: credit.json().entry.created_at,
    });
    const below = await call(
      s,
      'POST',
      `/v1/platform/accounts/${id}/credit`,
      { amount: -100, note: 'x' },
      ADMIN,
    );
    assert.equal(below.statusCode, 402);
    assert.equal(below.json().error.code, 'insufficient_balance');
    for (const body of [
      { amount: 1 },
      { amount: 0, note: 'z' },
      { amount: 'x', note: 'z' },
      { amount: 1, note: 'z', extra: 1 },
    ])
      assert.equal(
        (await call(s, 'POST', `/v1/platform/accounts/${id}/credit`, body, ADMIN)).statusCode,
        400,
        JSON.stringify(body),
      );
    const missing = await call(
      s,
      'POST',
      '/v1/platform/accounts/acct_none/credit',
      { amount: 1, note: 'n' },
      ADMIN,
    );
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'account_not_found');

    const ledger = await call(
      s,
      'GET',
      `/v1/platform/accounts/${id}/ledger?limit=1`,
      undefined,
      ADMIN,
    );
    assert.equal(ledger.statusCode, 200, ledger.body);
    assert.deepEqual(keysOf(ledger.json()), ['data', 'next_cursor']);
    assert.equal(ledger.json().data[0].note, 'top up');
    const older = await call(
      s,
      'GET',
      `/v1/platform/accounts/${id}/ledger?cursor=${ledger.json().next_cursor}`,
      undefined,
      ADMIN,
    );
    assert.deepEqual(
      older.json().data.map((e: { kind: string }) => e.kind),
      ['grant'],
    );
    assert.equal(
      (await call(s, 'GET', '/v1/platform/accounts/acct_none/ledger', undefined, ADMIN)).statusCode,
      404,
    );

    // Status and password reset end the developer's sessions.
    const login = await call(s, 'POST', '/v1/portal/login', {
      email: 'ann@x.io',
      password: 'password1',
    });
    const session = login.json().session.token as string;
    const reset = await call(
      s,
      'POST',
      `/v1/platform/accounts/${id}/password`,
      { new_password: 'password9' },
      ADMIN,
    );
    assert.equal(reset.statusCode, 204);
    assert.equal(reset.body, '');
    assert.equal((await call(s, 'GET', '/v1/portal/account', undefined, session)).statusCode, 401);
    assert.equal(
      (await call(s, 'POST', '/v1/portal/login', { email: 'ann@x.io', password: 'password1' }))
        .statusCode,
      401,
    );
    const again = await call(s, 'POST', '/v1/portal/login', {
      email: 'ann@x.io',
      password: 'password9',
    });
    assert.equal(again.statusCode, 200);
    assert.equal(
      (
        await call(
          s,
          'POST',
          `/v1/platform/accounts/${id}/password`,
          { new_password: 'short' },
          ADMIN,
        )
      ).statusCode,
      400,
    );
    const off = await call(
      s,
      'POST',
      `/v1/platform/accounts/${id}/status`,
      { status: 'disabled' },
      ADMIN,
    );
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual(keysOf(off.json()), ['account']);
    assert.equal(off.json().account.status, 'disabled');
    assert.equal(
      (await call(s, 'GET', '/v1/portal/account', undefined, again.json().session.token))
        .statusCode,
      401,
    );
    assert.equal(
      (await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN)).json().accounts.disabled,
      1,
    );
    const badStatus = await call(
      s,
      'POST',
      `/v1/platform/accounts/${id}/status`,
      { status: 'banned' },
      ADMIN,
    );
    assert.equal(badStatus.statusCode, 400);
    assert.equal(badStatus.json().error.code, 'invalid_request');
    const on = await call(
      s,
      'POST',
      `/v1/platform/accounts/${id}/status`,
      { status: 'active' },
      ADMIN,
    );
    assert.equal(on.json().account.status, 'active');
    assert.equal(
      (await call(s, 'POST', '/v1/platform/accounts/acct_none/status', { status: 'active' }, ADMIN))
        .statusCode,
      404,
    );
  });
});

test('operator: listings, codes and usage', async () => {
  await withPlatform({}, async (s) => {
    const put = await call(
      s,
      'PUT',
      '/v1/platform/listings',
      {
        agent_id: 'agent/paid',
        title: 'Paid',
        summary: 'S',
        tags: ['a', 'b'],
        price: { per_run: 2, per_1k_tokens: 0.5 },
        enabled: true,
      },
      ADMIN,
    );
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(keysOf(put.json()), LISTING_KEYS);
    assert.deepEqual(put.json().price, { per_run: 2, per_1k_tokens: 0.5 });
    assert.equal(put.json().agent_exists, true);
    // A partial update keeps the rest.
    const patched = await call(
      s,
      'PUT',
      '/v1/platform/listings',
      { agent_id: 'agent/paid', price: { per_run: 3 }, enabled: false },
      ADMIN,
    );
    assert.deepEqual(patched.json().price, { per_run: 3, per_1k_tokens: 0.5 });
    assert.equal(patched.json().title, 'Paid');
    assert.deepEqual(patched.json().tags, ['a', 'b']);
    assert.equal(patched.json().enabled, false);
    const none = await call(s, 'PUT', '/v1/platform/listings', { agent_id: 'agent/nope' }, ADMIN);
    assert.equal(none.statusCode, 404);
    assert.equal(none.json().error.code, 'agent_not_found');
    for (const body of [
      {},
      { agent_id: 'agent/paid', x: 1 },
      { agent_id: 'agent/paid', price: { per_run: -1 } },
      { agent_id: 'agent/paid', price: { cost: 1 } },
      { agent_id: 'agent/paid', tags: 'a' },
    ])
      assert.equal(
        (await call(s, 'PUT', '/v1/platform/listings', body, ADMIN)).statusCode,
        400,
        JSON.stringify(body),
      );
    const list = await call(s, 'GET', '/v1/platform/listings', undefined, ADMIN);
    assert.deepEqual(keysOf(list.json()), ['data']);
    assert.equal(list.json().data.length, 1, 'disabled listings are still listed for the operator');
    assert.equal(list.json().data[0].enabled, false);
    assert.equal((await call(s, 'GET', '/v1/portal/agents')).json().data.length, 0);
    assert.equal(
      (await call(s, 'DELETE', '/v1/platform/listings', undefined, ADMIN)).statusCode,
      400,
    );
    const gone = await call(
      s,
      'DELETE',
      '/v1/platform/listings?agent_id=agent%2Fpaid',
      undefined,
      ADMIN,
    );
    assert.equal(gone.statusCode, 204);
    assert.equal(gone.body, '');
    const again = await call(
      s,
      'DELETE',
      '/v1/platform/listings?agent_id=agent%2Fpaid',
      undefined,
      ADMIN,
    );
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error.code, 'listing_not_found');

    // Codes: plaintext only in the creation response.
    const soon = Date.now() + 3_600_000;
    const made = await call(
      s,
      'POST',
      '/v1/platform/codes',
      {
        kind: 'credit',
        credits: 4,
        max_uses: 2,
        count: 3,
        expires_at: soon,
        note: 'launch',
      },
      ADMIN,
    );
    assert.equal(made.statusCode, 201, made.body);
    assert.deepEqual(keysOf(made.json()), ['data']);
    assert.equal(made.json().data.length, 3);
    assert.deepEqual(keysOf(made.json().data[0]), [...CODE_KEYS, 'code'].sort());
    assert.match(made.json().data[0].code, /^OAA-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    assert.equal(new Set(made.json().data.map((c: { code: string }) => c.code)).size, 3);
    assert.deepEqual(
      [
        made.json().data[0].credits,
        made.json().data[0].max_uses,
        made.json().data[0].expires_at,
        made.json().data[0].note,
        made.json().data[0].used,
        made.json().data[0].revoked,
      ],
      [4, 2, soon, 'launch', 0, false],
    );
    const codes = await call(s, 'GET', '/v1/platform/codes', undefined, ADMIN);
    assert.equal(codes.json().data.length, 3);
    assert.deepEqual(keysOf(codes.json().data[0]), CODE_KEYS);
    assert.ok(
      !codes.body.includes(made.json().data[0].code),
      'the listing never carries plaintext',
    );
    const invite = await call(s, 'POST', '/v1/platform/codes', { kind: 'invite' }, ADMIN);
    assert.equal(invite.json().data[0].kind, 'invite');
    assert.equal(invite.json().data[0].expires_at, null);
    for (const body of [
      { kind: 'credit' },
      { kind: 'gift' },
      { kind: 'invite', count: 101 },
      { kind: 'invite', count: 0 },
      { kind: 'invite', max_uses: 0 },
      { kind: 'invite', expires_at: 1000 },
      { kind: 'invite', extra: 1 },
    ])
      assert.equal(
        (await call(s, 'POST', '/v1/platform/codes', body, ADMIN)).statusCode,
        400,
        JSON.stringify(body),
      );

    const { session } = await signup(s);
    const target = made.json().data[0];
    const revoke = await call(s, 'DELETE', `/v1/platform/codes/${target.id}`, undefined, ADMIN);
    assert.equal(revoke.statusCode, 204);
    assert.equal(revoke.body, '');
    const dead = await call(s, 'POST', '/v1/portal/redeem', { code: target.code }, session);
    assert.equal(dead.json().error.code, 'invalid_code', 'a revoked code cannot be redeemed');
    const ok = await call(
      s,
      'POST',
      '/v1/portal/redeem',
      { code: made.json().data[1].code },
      session,
    );
    assert.equal(ok.json().credited, 4);
    const listed = (await call(s, 'GET', '/v1/platform/codes', undefined, ADMIN)).json().data;
    assert.deepEqual(
      listed
        .filter((c: { kind: string }) => c.kind === 'credit')
        .map((c: { used: number; revoked: boolean }) => [c.used, c.revoked])
        .sort(),
      [
        [0, false],
        [0, true],
        [1, false],
      ],
    );
    const unknown = await call(s, 'DELETE', '/v1/platform/codes/code_unknown', undefined, ADMIN);
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, 'code_not_found');

    // Usage over all accounts, after one billed run.
    await call(
      s,
      'PUT',
      '/v1/platform/listings',
      { agent_id: 'agent/paid', price: { per_run: 1, per_1k_tokens: 0 } },
      ADMIN,
    );
    const key = await newKey(s, session);
    const run = await call(
      s,
      'POST',
      '/v1/responses',
      { model: 'agent/paid', input: 'hi' },
      key.token,
    );
    assert.equal(run.statusCode, 200, run.body);
    const usage = await call(s, 'GET', '/v1/platform/usage?days=3', undefined, ADMIN);
    assert.equal(usage.statusCode, 200, usage.body);
    assert.deepEqual(keysOf(usage.json()), [
      'balance',
      'by_account',
      'by_agent',
      'daily',
      'totals',
    ]);
    assert.equal(usage.json().daily.length, 3);
    assert.deepEqual(usage.json().totals, { runs: 1, tokens: 15, spent: 1 });
    assert.deepEqual(usage.json().by_account, [
      {
        account_id: usage.json().by_account[0].account_id,
        email: 'dev@x.io',
        runs: 1,
        tokens: 15,
        spent: 1,
      },
    ]);
    assert.deepEqual(usage.json().by_agent, [
      { agent: 'agent/paid', runs: 1, tokens: 15, spent: 1 },
    ]);
    assert.equal(usage.json().balance, pts(4 - 1));
    for (const days of ['0', '91', 'x'])
      assert.equal(
        (await call(s, 'GET', `/v1/platform/usage?days=${days}`, undefined, ADMIN)).statusCode,
        400,
        days,
      );
    const summary = (await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN)).json();
    assert.deepEqual(
      [
        summary.listings,
        summary.runs_total,
        summary.tokens_total,
        summary.spent_total,
        summary.balance_total,
      ],
      [1, 1, 15, 1, 3],
    );
  });
});
