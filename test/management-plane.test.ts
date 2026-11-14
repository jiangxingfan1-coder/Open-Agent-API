import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewaySchema } from '../src/config/config.js';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, setup, token } from './helpers.js';

// Public deployment P0: the console and admin keys stay on the management host, and /health only
// reveals the process ID to direct local probes. In-process inject only (no sockets, no models).

const API = 'api.example.com';
const CONSOLE = 'console.example.com';
const separated = {
  allowedHosts: [API, CONSOLE, 'localhost'],
  consoleHosts: [CONSOLE],
};

test('consoleHosts keeps the console and admin keys off the API host', async () => {
  const s = await setup(undefined, separated);
  try {
    const on = (host: string) => ({ host });
    s.store.publish('owner', makeBundle(agent()));

    // Console assets exist only on the console host.
    for (const url of ['/', '/console.js', '/console.css', '/brand.svg']) {
      const api = await s.app.inject({ method: 'GET', url, headers: on(API) });
      assert.equal(api.statusCode, 404, url);
      assert.equal(api.json().error.code, 'route_not_found', url);
      assert.equal(
        (await s.app.inject({ method: 'GET', url, headers: on(CONSOLE) })).statusCode,
        200,
        url,
      );
    }

    // Admin keys are refused on the API host, whatever the route.
    for (const url of ['/v1/agents', '/v1/keys', '/v1/nodes', '/v1/me']) {
      const r = await s.request('GET', url, undefined, token, on(API));
      assert.equal(r.statusCode, 403, `${url}: ${r.body}`);
      assert.equal(r.json().error.code, 'admin_host_denied', url);
    }
    assert.equal(
      (await s.request('GET', '/v1/agents', undefined, token, on(CONSOLE))).statusCode,
      200,
    );

    // A scoped caller key created on the console host works on the API host.
    const created = await s.request(
      'POST',
      '/v1/keys',
      { name: 'caller', agents: ['agent/test'], scopes: ['invoke', 'read'] },
      token,
      on(CONSOLE),
    );
    assert.equal(created.statusCode, 200, created.body);
    const caller = created.json().token as string;
    const run = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'hello' },
      caller,
      on(API),
    );
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().status, 'completed');

    // Health stays public for load balancers, without the process ID.
    const health = await s.app.inject({ method: 'GET', url: '/health', headers: on(API) });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, 'ok');
    assert.ok(Array.isArray(health.json().features));
    assert.equal('pid' in health.json(), false);

    // Unlisted hosts are still rejected by allowedHosts before any of this.
    const unknown = await s.app.inject({
      method: 'GET',
      url: '/',
      headers: on('evil.example.net'),
    });
    assert.equal(unknown.statusCode, 403);
    assert.equal(unknown.json().error.code, 'invalid_host');
  } finally {
    await s.cleanup();
  }
});

test('without consoleHosts nothing changes: console and admin keys work on any allowed host', async () => {
  const s = await setup();
  try {
    assert.equal((await s.app.inject({ method: 'GET', url: '/' })).statusCode, 200);
    assert.equal((await s.request('GET', '/v1/agents')).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});

test('consoleHosts must be covered by allowedHosts', () => {
  const base = {
    dataDir: '/tmp/oaa-config-check',
    keys: [{ name: 'k', owner: 'o', tokenEnv: 'X' }],
  };
  assert.throws(
    () => gatewaySchema.parse({ ...base, allowedHosts: [API], consoleHosts: [CONSOLE] }),
    /must also be listed in allowedHosts/,
  );
  assert.doesNotThrow(() =>
    gatewaySchema.parse({ ...base, allowedHosts: ['*.example.com'], consoleHosts: [CONSOLE] }),
  );
  assert.doesNotThrow(() =>
    gatewaySchema.parse({
      ...base,
      allowedHosts: ['*.example.com'],
      consoleHosts: ['*.example.com'],
    }),
  );
  // A wildcard console entry is broader than a single allowed host.
  assert.throws(
    () =>
      gatewaySchema.parse({ ...base, allowedHosts: [CONSOLE], consoleHosts: ['*.example.com'] }),
    /must also be listed in allowedHosts/,
  );
  assert.throws(() => gatewaySchema.parse({ ...base, consoleHosts: [] }));
});

test('/health shows the process ID only to direct local probes', async () => {
  const s = await setup(undefined, { allowedHosts: ['localhost', '127.0.0.1', '0.0.0.0', API] });
  try {
    const health = async (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
      (await s.app.inject({ method: 'GET', url: '/health', headers, remoteAddress })).json();
    // `oaa serve --detach` probes http://127.0.0.1:<port>/health and matches this PID.
    assert.equal((await health({ host: '127.0.0.1:8787' })).pid, process.pid);
    assert.equal((await health({ host: 'localhost' })).pid, process.pid);
    assert.equal((await health({ host: '0.0.0.0:8787' })).pid, process.pid);
    for (const [label, headers, remote] of [
      ['public Host through a local proxy', { host: API }, '127.0.0.1'],
      ['forwarded for', { host: '127.0.0.1:8787', 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1'],
      ['forwarded host', { host: '127.0.0.1:8787', 'x-forwarded-host': API }, '127.0.0.1'],
      ['RFC 7239 forwarded', { host: '127.0.0.1:8787', forwarded: 'for=203.0.113.9' }, '127.0.0.1'],
      ['remote peer', { host: 'localhost' }, '203.0.113.9'],
    ] as const) {
      const body = await health(headers, remote);
      assert.equal(body.status, 'ok', label);
      assert.equal('pid' in body, false, label);
    }
  } finally {
    await s.cleanup();
  }
});
