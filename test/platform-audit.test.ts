import test from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_VERSION } from '../src/gateway/endpoints.js';
import { ADMIN, call, signup, withPlatform } from './platform-http.js';

// Developer platform routes (P2): the audit trail of operator actions and the OpenAPI description.
// In-process inject only.

test('audit: credit, status and password changes are recorded without secrets', async () => {
  await withPlatform({}, async (s) => {
    const { account } = await signup(s);
    const before = (await call(s, 'GET', '/v1/audit', undefined, ADMIN)).json().data.length;
    await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: 3, note: 'secret-note-ABC' },
      ADMIN,
    );
    // A refused adjustment changes nothing and writes nothing.
    await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/credit`,
      { amount: -50, note: 'too much' },
      ADMIN,
    );
    await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/status`,
      { status: 'disabled' },
      ADMIN,
    );
    await call(
      s,
      'POST',
      `/v1/platform/accounts/${account.id}/password`,
      { new_password: 'brand-new-password-77' },
      ADMIN,
    );
    const code = (await call(s, 'POST', '/v1/platform/codes', { kind: 'invite' }, ADMIN)).json()
      .data[0].code as string;
    const audit = await call(s, 'GET', '/v1/audit?limit=200', undefined, ADMIN);
    assert.equal(audit.statusCode, 200, audit.body);
    const rows = audit.json().data.slice(before);
    assert.deepEqual(
      rows.map((r: { code: string }) => r.code),
      ['platform_credit_adjusted', 'platform_account_status', 'platform_password_reset'],
    );
    for (const row of rows) {
      assert.equal(row.account_id, account.id);
      assert.equal(row.method, 'POST');
      assert.equal(row.key_id, 'config:test');
      assert.equal(row.suppressed, 0);
      assert.ok(row.path.startsWith(`/v1/platform/accounts/${account.id}/`));
      assert.equal(typeof row.time, 'number');
    }
    assert.equal(rows[0].detail, 'amount=3 balance_after=3');
    assert.equal(rows[1].detail, 'status=disabled');
    assert.equal(rows[2].detail, undefined);
    const text = audit.body;
    for (const secret of ['brand-new-password-77', 'secret-note-ABC', code])
      assert.ok(!text.includes(secret), `the trail must not contain ${secret.slice(0, 6)}…`);
  });
});

test('openapi: with the platform the new routes are described, and each one exists', async () => {
  await withPlatform({}, async (s) => {
    const spec = (await call(s, 'GET', '/openapi.json', undefined, ADMIN)).json();
    assert.equal(spec.info.version, GATEWAY_VERSION);
    let operations = 0;
    for (const [url, methods] of Object.entries(spec.paths) as [
      string,
      Record<string, { security?: unknown[]; parameters: { in: string; name: string }[] }>,
    ][])
      for (const [method, operation] of Object.entries(methods)) {
        operations++;
        assert.ok(
          s.app.hasRoute({
            method: method.toUpperCase() as 'GET',
            url: url.replace(/\{([^}]+)\}/g, ':$1'),
          }),
          `${method} ${url}`,
        );
        assert.deepEqual(
          operation.parameters.filter((p) => p.in === 'path').map((p) => p.name),
          Array.from(url.matchAll(/\{([^}]+)\}/g), ([, name]) => name),
        );
      }
    assert.ok(operations > 60);
    const has = (url: string, method: string) =>
      assert.ok(spec.paths[url]?.[method], `${method} ${url}`);
    for (const [url, method] of [
      ['/v1/portal/site', 'get'],
      ['/v1/portal/agents', 'get'],
      ['/v1/portal/agent', 'get'],
      ['/v1/portal/signup', 'post'],
      ['/v1/portal/login', 'post'],
      ['/v1/portal/logout', 'post'],
      ['/v1/portal/account', 'get'],
      ['/v1/portal/account/password', 'post'],
      ['/v1/portal/keys', 'get'],
      ['/v1/portal/keys', 'post'],
      ['/v1/portal/keys/{id}', 'delete'],
      ['/v1/portal/redeem', 'post'],
      ['/v1/portal/usage', 'get'],
      ['/v1/portal/ledger', 'get'],
      ['/v1/platform/summary', 'get'],
      ['/v1/platform/accounts', 'get'],
      ['/v1/platform/accounts', 'post'],
      ['/v1/platform/accounts/{id}/status', 'post'],
      ['/v1/platform/accounts/{id}/credit', 'post'],
      ['/v1/platform/accounts/{id}/password', 'post'],
      ['/v1/platform/accounts/{id}/ledger', 'get'],
      ['/v1/platform/listings', 'get'],
      ['/v1/platform/listings', 'put'],
      ['/v1/platform/listings', 'delete'],
      ['/v1/platform/codes', 'get'],
      ['/v1/platform/codes', 'post'],
      ['/v1/platform/codes/{id}', 'delete'],
      ['/v1/platform/usage', 'get'],
    ] as const)
      has(url, method);
    for (const url of ['/v1/portal/site', '/v1/portal/agents', '/v1/portal/agent'])
      assert.deepEqual(spec.paths[url].get.security, [], `${url} needs no credential`);
    assert.equal(spec.paths['/v1/platform/summary'].get.security, undefined);
    assert.ok(spec.paths['/v1/responses'].post, 'existing paths are unchanged');
  });
});
