import test from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_VERSION } from '../src/gateway/endpoints.js';
import { ADMIN, call, keysOf, newKey, pts, signup, withPlatform } from './platform-http.js';

// Developer platform routes (P2), portal side: public and session routes, token separation and the
// end-to-end path through /v1/responses. In-process inject only.
// Operator routes, audit and OpenAPI are in platform-admin-routes.test.ts; the platform-less
// behaviour, static assets and hosts are in platform-site.test.ts.

const ACCOUNT_KEYS = ['balance', 'created_at', 'email', 'id', 'name', 'status'];
const LISTED_KEYS = [
  'conversion',
  'description',
  'id',
  'kind',
  'models',
  'price',
  'summary',
  'tags',
  'title',
  'updated_at',
];
const ENTRY_KEYS = [
  'agent',
  'amount',
  'balance_after',
  'created_at',
  'id',
  'kind',
  'note',
  'run_id',
  'status',
  'tokens',
];

test('portal: public routes need no credential and match the contract', async () => {
  await withPlatform({ siteName: 'Agents Hub', registration: 'invite' }, async (s) => {
    const list = (
      await call(
        s,
        'PUT',
        '/v1/platform/listings',
        {
          agent_id: 'agent/paid',
          title: 'Paid agent',
          summary: 'Does paid work',
          tags: ['demo'],
          price: { per_run: 1.5, per_1k_tokens: 0.2 },
        },
        ADMIN,
      )
    ).json();
    assert.equal(list.agent_id, 'agent/paid');
    await call(
      s,
      'PUT',
      '/v1/platform/listings',
      { agent_id: 'agent/free', enabled: false },
      ADMIN,
    );

    const site = await call(s, 'GET', '/v1/portal/site', undefined, undefined, {
      host: 'localhost:8787',
    });
    assert.equal(site.statusCode, 200, site.body);
    assert.deepEqual(keysOf(site.json()), [
      'base_url',
      'endpoints',
      'registration',
      'site_name',
      'version',
    ]);
    assert.equal(site.json().site_name, 'Agents Hub');
    assert.equal(site.json().registration, 'invite');
    const health = (await call(s, 'GET', '/health')).json();
    assert.equal(site.json().version, health.version);
    assert.equal(site.json().version, GATEWAY_VERSION);
    const me = (
      await call(s, 'GET', '/v1/me', undefined, ADMIN, { host: 'localhost:8787' })
    ).json();
    assert.deepEqual(site.json().endpoints, me.endpoints);
    assert.equal(site.json().base_url, me.endpoints.base_url);

    const agents = await call(s, 'GET', '/v1/portal/agents');
    assert.equal(agents.statusCode, 200, agents.body);
    assert.deepEqual(
      agents.json().data.map((a: { id: string }) => a.id),
      ['agent/paid'],
      'only enabled listings are visible',
    );
    const paid = agents.json().data[0];
    assert.deepEqual(keysOf(paid), LISTED_KEYS);
    assert.equal(paid.title, 'Paid agent');
    assert.equal(paid.summary, 'Does paid work');
    assert.deepEqual(paid.tags, ['demo']);
    assert.equal(paid.description, 'Test agent');
    assert.equal(paid.kind, 'kernel');
    assert.deepEqual(paid.price, { per_run: 1.5, per_1k_tokens: 0.2 });
    assert.ok(paid.models.includes('auto'));
    assert.equal(typeof paid.updated_at, 'number');
    assert.equal(typeof paid.conversion, 'object');

    const one = await call(s, 'GET', '/v1/portal/agent?id=agent%2Fpaid');
    assert.equal(one.statusCode, 200, one.body);
    assert.deepEqual(one.json(), paid);
    for (const id of ['agent%2Ffree', 'agent%2Fnone']) {
      const missing = await call(s, 'GET', `/v1/portal/agent?id=${id}`);
      assert.equal(missing.statusCode, 404, id);
      assert.equal(missing.json().error.code, 'agent_not_found');
    }
    assert.equal((await call(s, 'GET', '/v1/portal/agent')).statusCode, 400);
    assert.equal((await call(s, 'GET', '/v1/portal/agent?id=a&x=1')).statusCode, 400);
    assert.equal((await call(s, 'GET', '/v1/portal/zzz')).json().error.code, 'route_not_found');
  });
});

test('portal: signup modes, login, logout, password change and key management', async () => {
  await withPlatform(
    { registration: 'invite', maxKeysPerAccount: 2, signupCredits: 2 },
    async (s) => {
      const body = { email: 'Dev@X.io', password: 'password1', name: 'Dev' };
      const noInvite = await call(s, 'POST', '/v1/portal/signup', body);
      assert.equal(noInvite.statusCode, 403);
      assert.equal(noInvite.json().error.code, 'invite_required');
      const made = (await call(s, 'POST', '/v1/platform/codes', { kind: 'invite' }, ADMIN)).json()
        .data;
      const code = made[0].code as string;
      const roomy = (
        await call(s, 'POST', '/v1/platform/codes', { kind: 'invite', max_uses: 5 }, ADMIN)
      ).json().data[0].code as string;
      const created = await call(s, 'POST', '/v1/portal/signup', { ...body, invite_code: code });
      assert.equal(created.statusCode, 201, created.body);
      assert.deepEqual(keysOf(created.json()), ['account', 'session']);
      assert.deepEqual(keysOf(created.json().account), ACCOUNT_KEYS);
      assert.deepEqual(keysOf(created.json().session), ['expires_at', 'token']);
      assert.equal(created.json().account.email, 'dev@x.io');
      assert.equal(created.json().account.name, 'Dev');
      assert.equal(created.json().account.balance, 2);
      assert.equal(created.json().account.status, 'active');
      assert.match(created.json().session.token, /^oas_/);
      assert.ok(created.json().session.expires_at > Date.now());
      const reused = await call(s, 'POST', '/v1/portal/signup', {
        ...body,
        email: 'b@x.io',
        invite_code: code,
      });
      assert.equal(reused.json().error.code, 'invalid_code', 'a one-use invite code is used up');
      const taken = await call(s, 'POST', '/v1/portal/signup', { ...body, invite_code: roomy });
      assert.equal(taken.statusCode, 409, taken.body);
      assert.equal(taken.json().error.code, 'email_taken');
      const extra = await call(s, 'POST', '/v1/portal/signup', { ...body, admin: true });
      assert.equal(extra.statusCode, 400, 'unknown fields are refused');
      assert.equal(extra.json().error.code, 'invalid_request');
      const short = await call(s, 'POST', '/v1/portal/signup', {
        email: 'c@x.io',
        password: 'short',
      });
      assert.equal(short.json().error.code, 'invalid_request');

      const login = await call(s, 'POST', '/v1/portal/login', {
        email: 'dev@x.io',
        password: 'password1',
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.deepEqual(keysOf(login.json()), ['account', 'session']);
      const bad = await call(s, 'POST', '/v1/portal/login', {
        email: 'dev@x.io',
        password: 'nope-nope',
      });
      const ghost = await call(s, 'POST', '/v1/portal/login', {
        email: 'no@x.io',
        password: 'nope-nope',
      });
      assert.equal(bad.statusCode, 401);
      assert.equal(bad.json().error.code, 'invalid_credentials');
      assert.deepEqual(ghost.json(), bad.json(), 'unknown email and wrong password look the same');
      const session = login.json().session.token as string;

      const account = await call(s, 'GET', '/v1/portal/account', undefined, session);
      assert.equal(account.statusCode, 200, account.body);
      assert.deepEqual(keysOf(account.json()), ['account']);
      assert.deepEqual(keysOf(account.json().account), ACCOUNT_KEYS);

      // Keys: shape, listing without the secret, the per-account limit, revoke.
      const key = await call(s, 'POST', '/v1/portal/keys', { name: 'first' }, session);
      assert.equal(key.statusCode, 201, key.body);
      assert.deepEqual(keysOf(key.json()), [
        'created_at',
        'id',
        'name',
        'quota',
        'revoked',
        'token',
        'usage',
      ]);
      assert.match(key.json().token, /^sk-oaa-[A-Za-z0-9]{48}$/);
      assert.deepEqual(key.json().quota, { rpm: 60, maxConcurrentRuns: 2 });
      assert.deepEqual(key.json().usage, { used_tokens: 0, used_runs: 0, active_runs: 0 });
      assert.equal(key.json().revoked, false);
      const second = await newKey(s, session, 'second');
      const third = await call(s, 'POST', '/v1/portal/keys', { name: 'third' }, session);
      assert.equal(third.statusCode, 409);
      assert.equal(third.json().error.code, 'key_limit_reached');
      const blank = await call(s, 'POST', '/v1/portal/keys', { name: ' ' }, session);
      assert.equal(blank.json().error.code, 'invalid_request');
      const keys = await call(s, 'GET', '/v1/portal/keys', undefined, session);
      assert.deepEqual(
        keys.json().data.map((k: { name: string }) => k.name),
        ['second', 'first'],
        'newest first',
      );
      assert.ok(keys.json().data.every((k: object) => !('token' in k) && !('hash' in k)));
      assert.equal(
        (await call(s, 'DELETE', `/v1/portal/keys/${second.id}`, undefined, session)).statusCode,
        204,
      );
      const afterRevoke = await call(s, 'GET', '/v1/portal/keys', undefined, session);
      assert.deepEqual(
        afterRevoke.json().data.map((k: { name: string; revoked: boolean }) => [k.name, k.revoked]),
        [['first', false]],
        'a deleted key is no longer listed',
      );
      const unknown = await call(s, 'DELETE', '/v1/portal/keys/key_unknown', undefined, session);
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error.code, 'key_not_found');
      const revokedUse = await call(s, 'GET', '/v1/me', undefined, second.token);
      assert.equal(revokedUse.statusCode, 401, 'a revoked key stops working');

      // Password change ends every session; the old password stops working.
      const wrong = await call(
        s,
        'POST',
        '/v1/portal/account/password',
        {
          current_password: 'not-it-not-it',
          new_password: 'password2',
        },
        session,
      );
      assert.equal(wrong.json().error.code, 'invalid_credentials');
      const changed = await call(
        s,
        'POST',
        '/v1/portal/account/password',
        {
          current_password: 'password1',
          new_password: 'password2',
        },
        session,
      );
      assert.equal(changed.statusCode, 204);
      assert.equal(changed.body, '');
      const gone = await call(s, 'GET', '/v1/portal/account', undefined, session);
      assert.equal(gone.statusCode, 401);
      assert.equal(gone.json().error.code, 'session_invalid');
      const relogin = await call(s, 'POST', '/v1/portal/login', {
        email: 'dev@x.io',
        password: 'password2',
      });
      assert.equal(relogin.statusCode, 200);

      // Logout: 204, then the token is dead.
      const token = relogin.json().session.token as string;
      assert.equal((await call(s, 'POST', '/v1/portal/logout', undefined, token)).statusCode, 204);
      assert.equal((await call(s, 'GET', '/v1/portal/account', undefined, token)).statusCode, 401);
    },
  );
  await withPlatform({ registration: 'closed' }, async (s) => {
    const closed = await call(s, 'POST', '/v1/portal/signup', {
      email: 'a@x.io',
      password: 'password1',
    });
    assert.equal(closed.statusCode, 403);
    assert.equal(closed.json().error.code, 'registration_closed');
  });
});

test('portal: redeem, usage and ledger shapes, paging and parameter checks', async () => {
  await withPlatform({}, async (s) => {
    const { session } = await signup(s);
    const bogus = await call(s, 'POST', '/v1/portal/redeem', { code: 'OAA-NOPE' }, session);
    assert.equal(bogus.statusCode, 400);
    assert.equal(bogus.json().error.code, 'invalid_code');
    const codes = (
      await call(s, 'POST', '/v1/platform/codes', { kind: 'credit', credits: 2.5, count: 2 }, ADMIN)
    ).json().data;
    const first = await call(s, 'POST', '/v1/portal/redeem', { code: codes[0].code }, session);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(keysOf(first.json()), ['account', 'credited']);
    assert.equal(first.json().credited, 2.5);
    assert.equal(first.json().account.balance, 2.5);
    const again = await call(s, 'POST', '/v1/portal/redeem', { code: codes[0].code }, session);
    assert.equal(again.json().error.code, 'invalid_code');
    await call(s, 'POST', '/v1/portal/redeem', { code: codes[1].code }, session);

    const usage = await call(s, 'GET', '/v1/portal/usage?days=7', undefined, session);
    assert.equal(usage.statusCode, 200, usage.body);
    assert.deepEqual(keysOf(usage.json()), ['balance', 'by_agent', 'daily', 'totals']);
    assert.equal(usage.json().balance, 5);
    assert.deepEqual(usage.json().totals, { runs: 0, tokens: 0, spent: 0 });
    assert.equal(usage.json().daily.length, 7);
    assert.deepEqual(keysOf(usage.json().daily[0]), ['date', 'runs', 'spent', 'tokens']);
    assert.match(usage.json().daily[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      (await call(s, 'GET', '/v1/portal/usage', undefined, session)).json().daily.length,
      30,
    );
    for (const days of ['0', '91', 'x', '1.5'])
      assert.equal(
        (await call(s, 'GET', `/v1/portal/usage?days=${days}`, undefined, session)).statusCode,
        400,
        days,
      );

    const page = await call(s, 'GET', '/v1/portal/ledger?limit=1', undefined, session);
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(keysOf(page.json()), ['data', 'next_cursor']);
    assert.deepEqual(keysOf(page.json().data[0]), ENTRY_KEYS);
    assert.equal(page.json().data[0].kind, 'redeem');
    assert.equal(page.json().data[0].amount, 2.5);
    assert.equal(page.json().data[0].balance_after, 5);
    assert.equal(typeof page.json().next_cursor, 'number');
    const next = await call(
      s,
      'GET',
      `/v1/portal/ledger?limit=5&cursor=${page.json().next_cursor}`,
      undefined,
      session,
    );
    assert.equal(next.json().data.length, 1);
    assert.equal(next.json().next_cursor, null);
    for (const q of ['limit=0', 'limit=201', 'limit=x', 'cursor=x', 'other=1'])
      assert.equal(
        (await call(s, 'GET', `/v1/portal/ledger?${q}`, undefined, session)).statusCode,
        400,
        q,
      );
  });
});

test('identity: portal sessions and API keys are not interchangeable', async () => {
  await withPlatform({}, async (s) => {
    await call(s, 'PUT', '/v1/platform/listings', { agent_id: 'agent/free' }, ADMIN);
    const { account, session } = await signup(s);
    const key = await newKey(s, session);
    const sessionRoutes: [Parameters<typeof call>[1], string][] = [
      ['POST', '/v1/portal/logout'],
      ['GET', '/v1/portal/account'],
      ['POST', '/v1/portal/account/password'],
      ['GET', '/v1/portal/keys'],
      ['POST', '/v1/portal/keys'],
      ['DELETE', `/v1/portal/keys/${key.id}`],
      ['POST', '/v1/portal/redeem'],
      ['GET', '/v1/portal/usage'],
      ['GET', '/v1/portal/ledger'],
    ];
    for (const [method, url] of sessionRoutes)
      for (const credential of [key.token as string, ADMIN, 'oas_made-up', undefined]) {
        const r = await call(s, method, url, undefined, credential);
        assert.equal(r.statusCode, 401, `${method} ${url} with ${credential?.slice(0, 4)}`);
        assert.equal(r.json().error.code, 'session_invalid');
      }
    // A session token is not an API key.
    for (const [method, url] of [
      ['POST', '/v1/responses'],
      ['GET', '/v1/me'],
      ['GET', '/v1/agents'],
      ['GET', '/v1/platform/summary'],
    ] as const) {
      const r = await call(
        s,
        method,
        url,
        method === 'POST' ? { model: 'agent/free', input: 'hi' } : undefined,
        session,
      );
      assert.equal(r.statusCode, 401, url);
      assert.equal(r.json().error.code, 'unauthorized', url);
    }
    // The account key reaches the call surface but no operator route.
    const own = await call(
      s,
      'POST',
      '/v1/responses',
      { model: 'agent/free', input: 'hi' },
      key.token,
    );
    assert.equal(own.statusCode, 200, own.body);
    const denied = await call(s, 'GET', '/v1/platform/summary', undefined, key.token);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'scope_denied');

    // Disabling the account ends its sessions and refuses its keys.
    const off = await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/status`,
      { status: 'disabled' },
      ADMIN,
    );
    assert.equal(off.statusCode, 200, off.body);
    const dead = await call(s, 'GET', '/v1/portal/account', undefined, session);
    assert.equal(dead.statusCode, 401);
    assert.equal(dead.json().error.code, 'session_invalid');
    const refused = await call(
      s,
      'POST',
      '/v1/responses',
      { model: 'agent/free', input: 'hi' },
      key.token,
    );
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error.code, 'account_disabled');
    const login = await call(s, 'POST', '/v1/portal/login', {
      email: 'dev@x.io',
      password: 'password1',
    });
    assert.equal(login.statusCode, 403);
    assert.equal(login.json().error.code, 'account_disabled');
  });
});

test('portal: signup and login rate limits follow the client address (trustProxy)', async () => {
  await withPlatform(
    {},
    async (s) => {
      // The limiter counts every attempt before validation, so invalid bodies are cheap probes.
      const attempt = (ip: string) =>
        call(s, 'POST', '/v1/portal/signup', { email: 'nope', password: 'password1' }, undefined, {
          'x-forwarded-for': ip,
        });
      for (let i = 0; i < 10; i++) assert.equal((await attempt('203.0.113.7')).statusCode, 400);
      const limited = await attempt('203.0.113.7');
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.json().error.code, 'rate_limited');
      assert.equal(
        (await attempt('203.0.113.8')).statusCode,
        400,
        'another address has its own count',
      );
    },
    { trustProxy: true },
  );
  await withPlatform({}, async (s) => {
    // Without trustProxy the header is ignored: every caller here is the same peer.
    const attempt = (ip: string) =>
      call(s, 'POST', '/v1/portal/signup', { email: 'nope', password: 'password1' }, undefined, {
        'x-forwarded-for': ip,
      });
    for (let i = 0; i < 10; i++) await attempt(`198.51.100.${i}`);
    assert.equal((await attempt('198.51.100.99')).statusCode, 429);
  });
});

test('end to end: list and price, issue a code, sign up, redeem, key, call, then read the books', async () => {
  await withPlatform({}, async (s) => {
    // Operator: list the agent with a price and mint a credit code.
    const listed = await call(
      s,
      'PUT',
      '/v1/platform/listings',
      {
        agent_id: 'agent/paid',
        title: 'Paid agent',
        price: { per_run: 1.5, per_1k_tokens: 0.2 },
      },
      ADMIN,
    );
    assert.equal(listed.statusCode, 200, listed.body);
    const minted = await call(
      s,
      'POST',
      '/v1/platform/codes',
      { kind: 'credit', credits: 10 },
      ADMIN,
    );
    assert.equal(minted.statusCode, 201, minted.body);
    const code = minted.json().data[0].code as string;

    // Developer: sign up, redeem, create a key.
    const { account, session } = await signup(s);
    assert.equal(account.balance, 0);
    const redeemed = await call(s, 'POST', '/v1/portal/redeem', { code }, session);
    assert.equal(redeemed.json().credited, 10);
    const key = await newKey(s, session, 'ci');

    // Call the listed agent with the issued key.
    const run = await call(
      s,
      'POST',
      '/v1/responses',
      { model: 'agent/paid', input: 'hi' },
      key.token,
    );
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().status, 'completed');
    assert.equal(run.json().usage.total_tokens, 15);
    const runId = run.json().id as string;
    const spent = 1.5 + (0.2 * 15) / 1000; // per run + per 1k tokens
    const balance = pts(10 - spent);

    const after = await call(s, 'GET', '/v1/portal/account', undefined, session);
    assert.equal(after.json().account.balance, balance);
    const usage = (await call(s, 'GET', '/v1/portal/usage', undefined, session)).json();
    assert.equal(usage.balance, balance);
    assert.deepEqual(usage.totals, { runs: 1, tokens: 15, spent: pts(spent) });
    assert.deepEqual(usage.by_agent, [
      { agent: 'agent/paid', runs: 1, tokens: 15, spent: pts(spent) },
    ]);
    assert.equal(usage.daily.at(-1).date, new Date().toISOString().slice(0, 10));
    assert.deepEqual(usage.daily.at(-1), {
      date: usage.daily.at(-1).date,
      runs: 1,
      tokens: 15,
      spent: pts(spent),
    });
    const ledger = (await call(s, 'GET', '/v1/portal/ledger', undefined, session)).json();
    assert.deepEqual(
      ledger.data.map((e: { kind: string }) => e.kind),
      ['run', 'redeem'],
    );
    assert.deepEqual(ledger.data[0], {
      id: ledger.data[0].id,
      kind: 'run',
      amount: -pts(spent),
      balance_after: balance,
      agent: 'agent/paid',
      run_id: runId,
      tokens: 15,
      status: 'completed',
      note: '',
      created_at: ledger.data[0].created_at,
    });
    assert.equal(ledger.next_cursor, null);
    const keys = (await call(s, 'GET', '/v1/portal/keys', undefined, session)).json().data;
    assert.deepEqual(keys[0].usage, { used_tokens: 15, used_runs: 1, active_runs: 0 });

    const me = await call(s, 'GET', '/v1/me', undefined, key.token);
    assert.equal(me.statusCode, 200, me.body);
    assert.deepEqual(me.json().account, { id: account.id, balance });
    assert.deepEqual(keysOf(me.json()), [
      'account',
      'endpoints',
      'principal',
      'public_base_url',
      'quota',
      'usage',
    ]);
    // The operator sees the same books.
    const row = (await call(s, 'GET', '/v1/platform/accounts?query=dev', undefined, ADMIN)).json()
      .data[0];
    assert.deepEqual([row.balance, row.keys, row.runs, row.spent], [balance, 1, 1, pts(spent)]);
    const summary = (await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN)).json();
    assert.deepEqual(
      [summary.runs_total, summary.tokens_total, summary.spent_total],
      [1, 15, pts(spent)],
    );

    // Not enough left for another paid run: refused before a run exists.
    await call(
      s,
      'POST',
      '/v1/platform/accounts/' + account.id + '/credit',
      { amount: -balance + 1, note: 'drain' },
      ADMIN,
    );
    const refused = await call(
      s,
      'POST',
      '/v1/responses',
      { model: 'agent/paid', input: 'hi' },
      key.token,
    );
    assert.equal(refused.statusCode, 402, refused.body);
    assert.equal(refused.json().error.code, 'insufficient_balance');
  });
});
