import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerSchema } from '../src/config/config.js';
import { nativeEnvironment } from '../src/engines/process.js';
import { runAdapter } from '../src/engines/adapter.js';
import { agent } from './helpers.js';

// Public deployment P0: owner-configured agent processes can be given an allowlisted environment.
// The default stays `inherit`; proxy variables pass unchanged in both modes. No sockets.

const source: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/owner',
  LANG: 'zh_CN.UTF-8',
  LC_ALL: 'zh_CN.UTF-8',
  OAA_NODE_TOKEN: 'gateway credential',
  oaa_lowercase_token: 'gateway credential',
  UNRELATED_SECRET: 'must not leak',
  ANTHROPIC_BASE_URL: 'https://example.invalid',
  HTTP_PROXY: 'http://proxy.invalid:1',
  https_proxy: 'http://proxy.invalid:2',
  NO_PROXY: 'localhost',
};

test('inherit (default) keeps every variable except OAA_* credentials', () => {
  for (const env of [
    nativeEnvironment(undefined, source),
    nativeEnvironment({ mode: 'inherit', allow: [] }, source),
  ]) {
    assert.deepEqual(
      Object.keys(env).sort(),
      Object.keys(source)
        .filter((k) => !k.toUpperCase().startsWith('OAA_'))
        .sort(),
    );
  }
});

test('allowlist passes basics, LC_*, proxy variables unchanged and owner-listed names only', () => {
  const env = nativeEnvironment({ mode: 'allowlist', allow: ['ANTHROPIC_BASE_URL'] }, source);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/owner',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    HTTP_PROXY: 'http://proxy.invalid:1',
    https_proxy: 'http://proxy.invalid:2',
    NO_PROXY: 'localhost',
  });
  // OAA_* stays out even when an owner lists it.
  assert.equal(
    'OAA_NODE_TOKEN' in nativeEnvironment({ mode: 'allowlist', allow: ['OAA_NODE_TOKEN'] }, source),
    false,
  );
});

test('worker config defaults to inherit and validates variable names', () => {
  const base = { nodeId: 'n', dataDir: '/tmp/oaa-env-check' };
  assert.deepEqual(workerSchema.parse(base).nativeEnv, { mode: 'inherit', allow: [] });
  assert.deepEqual(workerSchema.parse({ ...base, nativeEnv: { mode: 'allowlist' } }).nativeEnv, {
    mode: 'allowlist',
    allow: [],
  });
  assert.throws(() =>
    workerSchema.parse({ ...base, nativeEnv: { mode: 'allowlist', allow: ['BAD-NAME'] } }),
  );
  assert.throws(() => workerSchema.parse({ ...base, nativeEnv: { mode: 'sandbox' } }));
});

test('a real stdio adapter process receives the configured environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-native-env-'));
  // Reads the request line, then reports the variable names it was started with.
  const script =
    "process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({protocol:'oaa/1',type:'result',status:'completed',output_text:JSON.stringify(Object.keys(process.env).sort())}));process.exit(0)})";
  process.env.OAA_TEST_ENV_CREDENTIAL = 'x';
  process.env.TEST_NATIVE_ENV_UNRELATED = 'secret';
  process.env.TEST_NATIVE_ENV_ALLOWED = 'needed';
  const run = async (nativeEnv: Record<string, unknown>) => {
    const config = workerSchema.parse({
      nodeId: 'local',
      dataDir: path.join(dir, 'worker'),
      nativeEnv,
      adapters: {
        probe: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', script],
          enabled: true,
        },
      },
    });
    const result = await runAdapter(
      agent({ id: 'agent/env', engine: 'adapter/probe' }),
      config,
      dir,
      'list your environment',
      { runId: 'resp_env', sessionId: 'session_env', owner: 'owner', digest: 'd', files: [] },
      new AbortController().signal,
    );
    return new Set(JSON.parse(result.text) as string[]);
  };
  try {
    const inherited = await run({});
    assert.ok(inherited.has('TEST_NATIVE_ENV_UNRELATED'), 'inherit keeps today’s behavior');
    assert.ok(inherited.has('TEST_NATIVE_ENV_ALLOWED'));
    assert.ok(!inherited.has('OAA_TEST_ENV_CREDENTIAL'));

    const listed = await run({ mode: 'allowlist', allow: ['TEST_NATIVE_ENV_ALLOWED'] });
    assert.ok(listed.has('PATH'));
    assert.ok(listed.has('TEST_NATIVE_ENV_ALLOWED'));
    assert.ok(!listed.has('TEST_NATIVE_ENV_UNRELATED'), 'unlisted variables are withheld');
    assert.ok(!listed.has('OAA_TEST_ENV_CREDENTIAL'));
  } finally {
    delete process.env.OAA_TEST_ENV_CREDENTIAL;
    delete process.env.TEST_NATIVE_ENV_UNRELATED;
    delete process.env.TEST_NATIVE_ENV_ALLOWED;
    await rm(dir, { recursive: true, force: true });
  }
});
