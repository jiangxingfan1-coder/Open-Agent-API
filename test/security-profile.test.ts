import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewaySchema } from '../src/config/config.js';
import { PUBLIC_PROFILE_DEFAULTS, exposureHint } from '../src/config/security-profile.js';
import { call, withPlatform } from './platform-http.js';

// Security profiles: `local` keeps every existing default; `public` fills stricter ones only for
// settings the config leaves unset. In-process only (no sockets).

const base = {
  dataDir: '/tmp/oaa-profile-test',
  keys: [{ name: 'a', owner: 'o', tokenEnv: 'OAA_X', scopes: ['admin'] }],
  localWorker: { nodeId: 'local', dataDir: '/tmp/w' },
};

test('the local profile (default) changes no existing default', () => {
  const plain = gatewaySchema.parse(base);
  const local = gatewaySchema.parse({ ...base, security: { profile: 'local' } });
  for (const c of [plain, local]) {
    assert.equal(c.security.profile, 'local');
    assert.equal(c.defaultKeyExecution, 'host');
    assert.equal(c.maxStoredBytesPerSubject, undefined);
    assert.equal(c.security.requestTimeoutMs, undefined);
    assert.equal(c.localWorker?.nativeEnv.mode, 'inherit');
  }
});

test('the public profile fills stricter defaults, and explicit settings still win', () => {
  const pub = gatewaySchema.parse({ ...base, security: { profile: 'public' } });
  assert.equal(pub.defaultKeyExecution, 'workspace');
  assert.equal(pub.maxStoredBytesPerSubject, PUBLIC_PROFILE_DEFAULTS.maxStoredBytesPerSubject);
  assert.equal(pub.security.requestTimeoutMs, PUBLIC_PROFILE_DEFAULTS.requestTimeoutMs);
  assert.equal(pub.localWorker?.nativeEnv.mode, 'allowlist');

  const explicit = gatewaySchema.parse({
    ...base,
    localWorker: { ...base.localWorker, nativeEnv: { mode: 'inherit' } },
    defaultKeyExecution: 'host',
    maxStoredBytesPerSubject: 5,
    security: { profile: 'public', requestTimeoutMs: 5000 },
  });
  assert.equal(explicit.defaultKeyExecution, 'host');
  assert.equal(explicit.maxStoredBytesPerSubject, 5);
  assert.equal(explicit.security.requestTimeoutMs, 5000);
  assert.equal(explicit.localWorker?.nativeEnv.mode, 'inherit');
});

test('doctor hints at the public profile only when the gateway looks exposed', () => {
  const local = gatewaySchema.parse(base);
  assert.equal(exposureHint(local), undefined);
  const wide = gatewaySchema.parse({ ...base, host: '0.0.0.0' });
  assert.deepEqual(exposureHint(wide)?.reasons, ['host=0.0.0.0']);
  assert.match(exposureHint(wide)!.hint, /security-model\.md/);
  const pub = gatewaySchema.parse({ ...base, host: '0.0.0.0', security: { profile: 'public' } });
  assert.equal(exposureHint(pub), undefined);
  const site = gatewaySchema.parse({
    ...base,
    publicBaseUrl: 'https://api.example.com',
    platform: { owner: 'owner', registration: 'open' },
  });
  assert.deepEqual(exposureHint(site)?.reasons, ['publicBaseUrl', 'platform.registration=open']);
});

test('unauthenticated portal credential forms refuse oversized bodies before parsing', async () => {
  await withPlatform({}, async (s) => {
    for (const url of ['/v1/portal/login', '/v1/portal/signup', '/v1/portal/password-reset']) {
      const r = await call(s, 'POST', url, { email: 'a@b.io', password: 'x'.repeat(70 * 1024) });
      assert.equal(r.statusCode, 413, `${url}: ${r.body}`);
      assert.equal(r.json().error.code, 'payload_too_large');
    }
    const ok = await call(s, 'POST', '/v1/portal/signup', {
      email: 'a@b.io',
      password: 'password1',
    });
    assert.equal(ok.statusCode, 201, ok.body);
  });
});

test('the gateway applies the receive timeout only when one is configured', async () => {
  await withPlatform({}, async (s) => assert.equal(s.app.server.requestTimeout, 0));
  await withPlatform({}, async (s) => assert.equal(s.app.server.requestTimeout, 120_000), {
    security: { profile: 'public' },
  });
});
