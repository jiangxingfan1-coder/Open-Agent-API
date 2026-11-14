import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { GATEWAY_FEATURES } from '../src/gateway/server.js';
import { GATEWAY_VERSION } from '../src/gateway/endpoints.js';
import { setup } from './helpers.js';
import { ADMIN, call, keysOf, withPlatform } from './platform-http.js';

// Developer platform routes (P2), site side: behaviour without the platform section, portal static
// assets, hosts and the consoleHosts redirect. In-process inject only.

test('without the platform section the routes do not exist and nothing else changes', async () => {
  const s = await setup();
  try {
    const health = (await call(s, 'GET', '/health')).json();
    assert.deepEqual(health.features, GATEWAY_FEATURES);
    assert.equal(health.version, GATEWAY_VERSION);
    // No credential: the same 401 as for any unknown path (nothing is skipped).
    for (const url of [
      '/v1/portal/site',
      '/v1/portal/agents',
      '/portal/',
      '/portal',
      '/v1/platform/summary',
      '/portal/app.js',
    ]) {
      const anonymous = await call(s, 'GET', url);
      assert.equal(anonymous.statusCode, 401, url);
      assert.equal(anonymous.json().error.code, 'unauthorized', url);
      assert.equal(anonymous.headers.location, undefined, url);
      const known = await call(s, 'GET', url, undefined, ADMIN);
      assert.equal(known.statusCode, 404, url);
      assert.equal(known.json().error.code, 'route_not_found', url);
    }
    const signupAttempt = await call(s, 'POST', '/v1/portal/signup', {
      email: 'a@x.io',
      password: 'password1',
    });
    assert.equal(signupAttempt.statusCode, 401);
    // Existing responses keep their shape: /v1/me has no `account`, OpenAPI no platform paths.
    const me = (await call(s, 'GET', '/v1/me', undefined, ADMIN)).json();
    assert.deepEqual(keysOf(me), ['endpoints', 'principal', 'public_base_url', 'quota', 'usage']);
    const spec = (await call(s, 'GET', '/openapi.json', undefined, ADMIN)).json();
    // Only the setup endpoint (answered whether or not the platform is on) is described.
    assert.deepEqual(
      Object.keys(spec.paths).filter((p) => p.includes('/portal') || p.includes('/platform')),
      ['/v1/platform/setup'],
    );
    assert.equal(spec.info.version, GATEWAY_VERSION);
    assert.equal((await call(s, 'GET', '/')).statusCode, 200, 'the console still answers on /');
  } finally {
    await s.cleanup();
  }
});

test('portal assets: whitelist, shared files, CSP, no credential needed', async () => {
  await withPlatform({}, async (s) => {
    const redirect = await call(s, 'GET', '/portal');
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, '/portal/');
    // web/portal/ is delivered separately: either the real file or a plain 404 `not_found`.
    for (const url of ['/portal/', '/portal/app.js', '/portal/portal.css']) {
      const r = await call(s, 'GET', url);
      assert.ok([200, 404].includes(r.statusCode), `${url}: ${r.statusCode}`);
      if (r.statusCode === 404) assert.equal(r.json().error.code, 'not_found', url);
      else
        assert.equal(
          r.headers['content-security-policy'],
          (await call(s, 'GET', '/brand.svg')).headers['content-security-policy'],
        );
    }
    // Names outside the whitelist never reach the file system.
    for (const url of [
      '/portal/App.js',
      '/portal/app.txt',
      '/portal/index.html',
      '/portal/a.b.js',
      '/portal/x.map',
      '/portal/..%2Fconsole.js',
      '/portal/%2e%2e%2fpackage.json',
      `/portal/${'a'.repeat(60)}.js`,
      '/portal/agents/Bad.svg',
      '/portal/agents/a.png',
    ]) {
      const r = await call(s, 'GET', url);
      assert.equal(r.statusCode, 404, url);
      assert.ok(['not_found', 'route_not_found'].includes(r.json().error.code), url);
    }
    // Reused console files: same bytes, same headers.
    const names = readdirSync(new URL('../../web/agents', import.meta.url)).filter((f) =>
      f.endsWith('.svg'),
    );
    const pairs = [
      ['/brand.svg', '/portal/brand.svg'],
      ['/icons.js', '/portal/icons.js'],
      [`/agents/${names[0]}`, `/portal/agents/${names[0]}`],
    ] as const;
    for (const [consoleUrl, portalUrl] of pairs) {
      const a = await call(s, 'GET', consoleUrl, undefined, ADMIN);
      const b = await call(s, 'GET', portalUrl);
      assert.equal(b.statusCode, 200, portalUrl);
      assert.equal(b.rawPayload.compare(a.rawPayload), 0, portalUrl);
      assert.equal(b.headers['content-type'], a.headers['content-type'], portalUrl);
      assert.equal(
        b.headers['content-security-policy'],
        a.headers['content-security-policy'],
        portalUrl,
      );
      assert.equal(b.headers['cache-control'], 'no-store');
    }
    const missing = await call(s, 'GET', '/portal/agents/zzz-none.svg');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'not_found');
  });
});

test('hosts: Host allowlist and Origin check still apply; consoleHosts redirects / to the portal', async () => {
  const API = 'api.example.com';
  const CONSOLE = 'console.example.com';
  await withPlatform(
    {},
    async (s) => {
      const on = (host: string) => ({ host });
      // Portal paths work on both the API host and the console host.
      for (const host of [API, CONSOLE]) {
        const site = await call(s, 'GET', '/v1/portal/site', undefined, undefined, on(host));
        assert.equal(site.statusCode, 200, host);
        assert.equal(site.json().base_url, `http://${host}`);
        assert.equal(
          (await call(s, 'GET', '/portal', undefined, undefined, on(host))).statusCode,
          302,
          host,
        );
      }
      // `/` : the console on the console host, the portal elsewhere.
      const root = await call(s, 'GET', '/', undefined, undefined, on(API));
      assert.equal(root.statusCode, 302);
      assert.equal(root.headers.location, '/portal/');
      assert.equal((await call(s, 'GET', '/', undefined, undefined, on(CONSOLE))).statusCode, 200);
      const post = await call(s, 'POST', '/', {}, undefined, on(API));
      assert.equal(post.statusCode, 404, 'only GET / is redirected');
      // The console files stay off the API host.
      const consoleJs = await call(s, 'GET', '/console.js', undefined, undefined, on(API));
      assert.equal(consoleJs.statusCode, 404);
      assert.equal(consoleJs.json().error.code, 'route_not_found');
      // Allowlist and Origin checks come first.
      const stranger = await call(
        s,
        'GET',
        '/v1/portal/site',
        undefined,
        undefined,
        on('evil.example.net'),
      );
      assert.equal(stranger.statusCode, 403);
      assert.equal(stranger.json().error.code, 'invalid_host');
      const redirectStranger = await call(
        s,
        'GET',
        '/',
        undefined,
        undefined,
        on('evil.example.net'),
      );
      assert.equal(redirectStranger.json().error.code, 'invalid_host');
      const origin = await call(s, 'GET', '/v1/portal/agents', undefined, undefined, {
        host: API,
        origin: 'https://evil.example.net',
      });
      assert.equal(origin.statusCode, 403);
      assert.equal(origin.json().error.code, 'origin_denied');
      // Admin keys never work on the API host, including for the operator routes.
      const operatorOnApi = await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN, on(API));
      assert.equal(operatorOnApi.statusCode, 403);
      assert.equal(operatorOnApi.json().error.code, 'admin_host_denied');
      assert.equal(
        (await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN, on(CONSOLE))).statusCode,
        200,
      );
    },
    { allowedHosts: [API, CONSOLE, 'localhost'], consoleHosts: [CONSOLE] },
  );
  // Without the platform section `/` stays a 404 on the API host.
  const plain = await setup(undefined, {
    allowedHosts: [API, CONSOLE, 'localhost'],
    consoleHosts: [CONSOLE],
  });
  try {
    const r = await call(plain, 'GET', '/', undefined, undefined, { host: API });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error.code, 'route_not_found');
    assert.equal(r.headers.location, undefined);
  } finally {
    await plain.cleanup();
  }
});
