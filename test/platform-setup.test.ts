import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway/server.js';
import { ADMIN, call, keysOf } from './platform-http.js';
import { principal, secondToken, setup } from './helpers.js';

// Enabling the developer platform from the console (GET/PUT /v1/platform/setup): saved in the
// gateway's own data, effective after a restart. In-process inject only.

type Setup = Awaited<ReturnType<typeof setup>>;
const SETUP_KEYS = [
  'desired',
  'enabled',
  'managed_by_config',
  'owner',
  'pending_restart',
  'settings',
  'source',
];
const tables = (s: Pick<Setup, 'store'>) =>
  s.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => String(r.name));
const features = async (s: Pick<Setup, 'app'>) =>
  (await s.app.inject({ method: 'GET', url: '/health' })).json().features as string[];

/** Closes the gateway (keeping its data directory) and starts a new one on the same data. */
async function restart(s: Setup): Promise<Setup> {
  await s.app.close();
  const gateway = await createGateway(s.config, s.runtime);
  await gateway.app.ready();
  return { ...s, ...gateway };
}

test('setup: a gateway without the platform answers, and nothing is created by reading', async () => {
  const s = await setup();
  try {
    const before = tables(s);
    const r = await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.deepEqual(keysOf(body), SETUP_KEYS);
    assert.deepEqual(body, {
      enabled: false,
      source: null,
      managed_by_config: false,
      pending_restart: false,
      owner: 'owner',
      settings: null,
      desired: false,
    });
    const f = await features(s);
    assert.ok(f.includes('platform-setup-v1'));
    assert.ok(!f.includes('platform-v1'));
    assert.equal((await call(s, 'GET', '/v1/portal/agents', undefined, ADMIN)).statusCode, 404);
    // Reading the setup (and the health check) creates no table.
    assert.deepEqual(tables(s), before);
    assert.ok(!before.includes('gateway_platform_setup'));
    assert.ok(!before.some((t) => t.startsWith('platform_')));
    const spec = (await call(s, 'GET', '/openapi.json', undefined, ADMIN)).json();
    assert.ok(spec.paths['/v1/platform/setup']?.get);
    assert.ok(spec.paths['/v1/platform/setup']?.put);
  } finally {
    await s.cleanup();
  }
});

test('setup: enable, restart, edit, disable and re-enable keep the data', async () => {
  let s = await setup();
  try {
    const put = await call(
      s,
      'PUT',
      '/v1/platform/setup',
      { enabled: true, site_name: '我的平台', registration: 'open', signup_credits: 5 },
      ADMIN,
    );
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json(), {
      enabled: false,
      source: null,
      managed_by_config: false,
      pending_restart: true,
      owner: 'owner',
      settings: { site_name: '我的平台', registration: 'open', signup_credits: 5 },
      desired: true,
    });
    // Still off in this process.
    assert.ok(!(await features(s)).includes('platform-v1'));
    assert.equal((await call(s, 'GET', '/v1/portal/agents', undefined, ADMIN)).statusCode, 404);
    // The change is audited.
    const audit = (await call(s, 'GET', '/v1/audit?limit=200', undefined, ADMIN)).json().data;
    const row = audit.find((e: { code: string }) => e.code === 'platform_setup');
    assert.ok(row, JSON.stringify(audit));
    assert.match(row.detail, /enabled=true/);

    s = await restart(s);
    const after = (await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN)).json();
    assert.equal(after.enabled, true);
    assert.equal(after.source, 'console');
    assert.equal(after.pending_restart, false);
    assert.ok((await features(s)).includes('platform-v1'));
    assert.equal(s.platform?.owner, 'owner');
    const signup = await call(s, 'POST', '/v1/portal/signup', {
      email: 'dev@x.io',
      password: 'password1',
    });
    assert.equal(signup.statusCode, 201, signup.body);
    assert.equal(signup.json().account.balance, 5);
    const summary = await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN);
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().site_name, '我的平台');
    assert.equal(summary.json().accounts.total, 1);

    // Edit: saved now, effective after a restart.
    const edit = await call(
      s,
      'PUT',
      '/v1/platform/setup',
      { enabled: true, registration: 'closed' },
      ADMIN,
    );
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().pending_restart, true);
    // Fields not sent keep their saved values.
    assert.deepEqual(edit.json().settings, {
      site_name: '我的平台',
      registration: 'closed',
      signup_credits: 5,
    });
    s = await restart(s);
    assert.equal(
      (await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN)).json().pending_restart,
      false,
    );
    const closed = await call(s, 'POST', '/v1/portal/signup', {
      email: 'b@x.io',
      password: 'password1',
    });
    assert.equal(closed.json().error.code, 'registration_closed');

    // Disable: the switch only; settings and accounts stay.
    const off = await call(s, 'PUT', '/v1/platform/setup', { enabled: false }, ADMIN);
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().desired, false);
    assert.equal(off.json().enabled, true);
    assert.equal(off.json().pending_restart, true);
    assert.equal(off.json().settings.registration, 'closed');
    s = await restart(s);
    const offView = (await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN)).json();
    assert.equal(offView.enabled, false);
    assert.equal(offView.source, null);
    assert.equal(offView.pending_restart, false);
    assert.ok(!(await features(s)).includes('platform-v1'));
    assert.equal((await call(s, 'GET', '/v1/portal/agents', undefined, ADMIN)).statusCode, 404);
    const kept = s.store.db.prepare('SELECT COUNT(*) AS n FROM platform_accounts').get();
    assert.equal(Number(kept?.n), 1);

    // Re-enable: the account is back.
    await call(s, 'PUT', '/v1/platform/setup', { enabled: true }, ADMIN);
    s = await restart(s);
    const back = await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN);
    assert.equal(back.json().accounts.total, 1);
  } finally {
    await s.cleanup();
  }
});

test('setup: a platform section in the config file is read-only here', async () => {
  const s = await setup(undefined, {
    platform: { owner: 'owner', siteName: 'Config site', registration: 'invite' },
  });
  try {
    const view = (await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN)).json();
    assert.equal(view.managed_by_config, true);
    assert.equal(view.source, 'config');
    assert.equal(view.enabled, true);
    assert.equal(view.desired, true);
    assert.equal(view.pending_restart, false);
    assert.deepEqual(view.settings, {
      site_name: 'Config site',
      registration: 'invite',
      signup_credits: 0,
    });
    const put = await call(s, 'PUT', '/v1/platform/setup', { enabled: false }, ADMIN);
    assert.equal(put.statusCode, 409, put.body);
    assert.equal(put.json().error.code, 'platform_managed_by_config');
    assert.ok(!tables(s).includes('gateway_platform_setup'));
  } finally {
    await s.cleanup();
  }
});

test('setup: owner-wide admin on the console host only; the body is strict', async () => {
  const CONSOLE = 'console.example.com';
  const API = 'api.example.com';
  const s = await setup(undefined, {
    allowedHosts: [API, CONSOLE, 'localhost'],
    consoleHosts: [CONSOLE],
  });
  try {
    const on = (host: string) => ({ host });
    const limited = s.auth.create(principal, 'limited', ['agent/x'], ['admin', 'read']);
    const reader = s.auth.create(principal, 'reader', ['*'], ['read', 'invoke']);
    for (const [method, payload] of [
      ['GET', undefined],
      ['PUT', { enabled: true }],
    ] as const) {
      assert.equal(
        (await call(s, method, '/v1/platform/setup', payload, undefined, on(CONSOLE))).statusCode,
        401,
      );
      for (const credential of [limited.token as string, reader.token as string]) {
        const r = await call(s, method, '/v1/platform/setup', payload, credential, on(CONSOLE));
        assert.equal(r.statusCode, 403, r.body);
        assert.equal(r.json().error.code, 'scope_denied');
      }
      const api = await call(s, method, '/v1/platform/setup', payload, ADMIN, on(API));
      assert.equal(api.statusCode, 403);
      assert.equal(api.json().error.code, 'admin_host_denied');
    }
    // An owner-wide admin of another owner sees its own owner, never this one's settings.
    const other = await call(s, 'GET', '/v1/platform/setup', undefined, secondToken, on(CONSOLE));
    assert.equal(other.statusCode, 200, other.body);
    for (const body of [
      { enabled: true, extra: 1 },
      { enabled: true, site_name: '' },
      { enabled: true, site_name: 'x'.repeat(101) },
      { enabled: true, registration: 'public' },
      { enabled: true, signup_credits: -1 },
      { enabled: true, signup_credits: 1_000_000_001 },
      { enabled: 'yes' },
      {},
    ]) {
      const r = await call(s, 'PUT', '/v1/platform/setup', body, ADMIN, on(CONSOLE));
      assert.equal(r.statusCode, 400, `${JSON.stringify(body)}: ${r.body}`);
    }
    // Nothing above saved anything.
    assert.ok(!tables(s).includes('gateway_platform_setup'));
    const ok = await call(s, 'PUT', '/v1/platform/setup', { enabled: true }, ADMIN, on(CONSOLE));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(tables(s).includes('gateway_platform_setup'));
    assert.ok(!tables(s).some((t) => t.startsWith('platform_')));
  } finally {
    await s.cleanup();
  }
});

test('setup: the settings belong to the owner who first saved them', async () => {
  const s = await setup();
  try {
    // First save by the second owner: it becomes theirs.
    const first = await call(s, 'PUT', '/v1/platform/setup', { enabled: true }, secondToken);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().owner, 'second');
    for (const [method, payload] of [
      ['GET', undefined],
      ['PUT', { enabled: false }],
      ['PUT', { enabled: true, registration: 'open' }],
    ] as const) {
      const r = await call(s, method, '/v1/platform/setup', payload, ADMIN);
      assert.equal(r.statusCode, 403, r.body);
      assert.equal(r.json().error.code, 'scope_denied');
      assert.ok(!r.body.includes('second'), r.body);
    }
    const view = (await call(s, 'GET', '/v1/platform/setup', undefined, secondToken)).json();
    assert.equal(view.owner, 'second');
    assert.equal(view.desired, true);
    assert.equal(view.settings.registration, 'closed');
    // Disabled, it still belongs to the second owner.
    await call(s, 'PUT', '/v1/platform/setup', { enabled: false }, secondToken);
    const denied = await call(s, 'PUT', '/v1/platform/setup', { enabled: true }, ADMIN);
    assert.equal(denied.statusCode, 403);
  } finally {
    await s.cleanup();
  }
});

test('setup: with a config platform section only its owner may read it', async () => {
  const s = await setup(undefined, { platform: { owner: 'owner' } });
  try {
    const get = await call(s, 'GET', '/v1/platform/setup', undefined, secondToken);
    assert.equal(get.statusCode, 403, get.body);
    assert.equal(get.json().error.code, 'scope_denied');
    const put = await call(s, 'PUT', '/v1/platform/setup', { enabled: true }, secondToken);
    assert.equal(put.statusCode, 403, put.body);
    assert.equal((await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN)).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});

test('setup: a partial update keeps the saved values', async () => {
  const s = await setup();
  try {
    await call(s, 'PUT', '/v1/platform/setup', { enabled: true, registration: 'open' }, ADMIN);
    const r = await call(s, 'PUT', '/v1/platform/setup', { enabled: true, site_name: 'X' }, ADMIN);
    assert.deepEqual(r.json().settings, {
      site_name: 'X',
      registration: 'open',
      signup_credits: 0,
    });
    await call(s, 'PUT', '/v1/platform/setup', { enabled: false }, ADMIN);
    const back = await call(s, 'PUT', '/v1/platform/setup', { enabled: true }, ADMIN);
    assert.deepEqual(back.json().settings, {
      site_name: 'X',
      registration: 'open',
      signup_credits: 0,
    });
  } finally {
    await s.cleanup();
  }
});
