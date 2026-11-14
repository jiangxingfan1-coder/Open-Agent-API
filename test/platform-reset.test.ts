import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, call, keysOf, signup, withPlatform, type Setup } from './platform-http.js';

// Developer platform (0.5.0): one-time password reset codes issued by the operator.
// In-process inject only.

const issue = (s: Setup, accountId: string) =>
  call(s, 'POST', `/v1/platform/accounts/${accountId}/reset-code`, undefined, ADMIN);
const reset = (s: Setup, body: Record<string, unknown>, ip?: string) =>
  call(
    s,
    'POST',
    '/v1/portal/password-reset',
    body,
    undefined,
    ip ? { 'x-forwarded-for': ip } : {},
  );
const login = (s: Setup, email: string, password: string) =>
  call(s, 'POST', '/v1/portal/login', { email, password });

test('reset code: issued once, sets a new password, ends sessions and works only once', async () => {
  await withPlatform({}, async (s) => {
    const { account, session } = await signup(s, 'dev@x.io');
    const made = await issue(s, account.id);
    assert.equal(made.statusCode, 201, made.body);
    assert.deepEqual(keysOf(made.json()), ['code', 'expires_at']);
    const { code, expires_at } = made.json();
    assert.equal(typeof code, 'string');
    assert.ok(code.length >= 16);
    const day = 24 * 3_600_000;
    assert.ok(Math.abs(expires_at - (Date.now() + day)) < 60_000);
    const stored = JSON.stringify(s.store.db.prepare('SELECT * FROM platform_reset_codes').all());
    assert.ok(!stored.includes(code), 'only the hash is stored');
    const ok = await reset(s, { email: 'DEV@x.io', code, new_password: 'new-password-1' });
    assert.equal(ok.statusCode, 204, ok.body);
    assert.equal((await call(s, 'GET', '/v1/portal/account', undefined, session)).statusCode, 401);
    assert.equal((await login(s, 'dev@x.io', 'password1')).statusCode, 401);
    assert.equal((await login(s, 'dev@x.io', 'new-password-1')).statusCode, 200);
    const twice = await reset(s, { email: 'dev@x.io', code, new_password: 'new-password-2' });
    assert.equal(twice.statusCode, 400);
    assert.equal(twice.json().error.code, 'invalid_code');
    // The audit names the method, never the code.
    const audit = await call(s, 'GET', '/v1/audit?limit=200', undefined, ADMIN);
    const row = audit
      .json()
      .data.find((r: { code: string }) => r.code === 'platform_password_reset');
    assert.equal(row.detail, 'reset_code');
    assert.equal(row.account_id, account.id);
    assert.ok(!audit.body.includes(code));
  });
});

test('reset code: a new code replaces the old one; expired codes fail; errors are uniform', async () => {
  await withPlatform({}, async (s) => {
    const { account } = await signup(s, 'dev@x.io');
    await signup(s, 'other@x.io');
    const old = (await issue(s, account.id)).json().code as string;
    const fresh = (await issue(s, account.id)).json().code as string;
    assert.notEqual(old, fresh);
    const cases: Record<string, unknown>[] = [
      { email: 'dev@x.io', code: old, new_password: 'new-password-1' },
      { email: 'nobody@x.io', code: fresh, new_password: 'new-password-1' },
      { email: 'other@x.io', code: fresh, new_password: 'new-password-1' },
      { email: 'dev@x.io', code: 'wrong-code', new_password: 'new-password-1' },
      { email: 'not-an-email', code: fresh, new_password: 'new-password-1' },
    ];
    const bodies = new Set<string>();
    for (const body of cases) {
      const r = await reset(s, body);
      assert.equal(r.statusCode, 400, JSON.stringify(body));
      assert.equal(r.json().error.code, 'invalid_code', JSON.stringify(body));
      bodies.add(r.body);
    }
    assert.equal(bodies.size, 1, 'the same response whether or not the email exists');
    const short = await reset(s, { email: 'dev@x.io', code: fresh, new_password: 'short' });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error.code, 'invalid_request');
    s.store.db.prepare('UPDATE platform_reset_codes SET expires_at=?').run(Date.now() - 1);
    const expired = await reset(s, { email: 'dev@x.io', code: fresh, new_password: 'pw-12345678' });
    assert.equal(expired.json().error.code, 'invalid_code');
    // Unknown account for the operator route.
    const missing = await issue(s, 'acct_missing');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'account_not_found');
  });
});

test('reset code: rate limited per email like login', async () => {
  await withPlatform(
    {},
    async (s) => {
      await signup(s, 'dev@x.io');
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++)
        statuses.push(
          (
            await reset(
              s,
              { email: 'dev@x.io', code: 'nope', new_password: 'pw-12345678' },
              `10.0.0.${i}`,
            )
          ).statusCode,
        );
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
      assert.equal(statuses[10], 429);
    },
    { trustProxy: true },
  );
});

test('reset code: rate limited per IP like login', async () => {
  await withPlatform(
    {},
    async (s) => {
      let last = 0;
      for (let i = 0; i < 31; i++)
        last = (
          await reset(
            s,
            { email: `u${i}@x.io`, code: 'nope', new_password: 'pw-12345678' },
            '10.9.9.9',
          )
        ).statusCode;
      assert.equal(last, 429);
    },
    { trustProxy: true },
  );
});
