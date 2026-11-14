import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeBundle } from '../src/lang/bundle.js';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { DeferredProcess, ownedProcess } from '../src/engines/process.js';
import type { SandboxLauncher, SandboxPolicy } from '../src/engines/sandbox.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { faultOf } from '../src/core/util.js';
import { FixtureModel, agent, token } from './helpers.js';

// Sandbox S2a: the Claude and Codex CLIs run for sandbox-level callers with an isolated HOME, the
// caller's key and owner-listed provider domains only. The CLIs are the repository's protocol
// fixtures (no model, no network) and a recording launcher stands in for the OS sandbox, so these
// tests check what would be sandboxed; test/sandbox-srt.test.ts checks the boundary itself.

const CALLER_KEY = 'sk-caller-native-0123456789-marker';

class RecordingLauncher implements SandboxLauncher {
  readonly backend = 'srt' as const;
  wraps: { command: string; args: string[]; env: NodeJS.ProcessEnv; policy: SandboxPolicy }[] = [];
  constructor(private readonly kinds: ('script' | `native/${string}`)[]) {}
  report() {
    return { backend: 'srt' as const, version: 'test', kinds: this.kinds };
  }
  async wrap(command: string, args: string[], env: NodeJS.ProcessEnv, policy: SandboxPolicy) {
    this.wraps.push({ command, args, env, policy });
    return { command, args, env, release: () => {} };
  }
  async close() {}
}

async function gateway(
  kinds: ('script' | `native/${string}`)[] = ['script', 'native/claude', 'native/codex'],
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sandbox-native-'));
  const claudeCli = path.join(dir, 'claude-code.mjs');
  await copyFile(path.resolve('test/fixtures/claude-code.mjs'), claudeCli);
  await chmod(claudeCli, 0o755);
  const workerConfig = workerSchema.parse({
    nodeId: 'local',
    dataDir: path.join(dir, 'worker'),
    native: {
      claude: { executable: claudeCli, enabled: true },
      codex: {
        executable: process.execPath,
        args: [path.resolve('test/fixtures/native-full.mjs')],
        enabled: true,
      },
      antigravity: {
        executable: process.execPath,
        args: [path.resolve('test/fixtures/native-full.mjs')],
        enabled: true,
      },
    },
    sandbox: {
      native: {
        claude: { providerDomains: ['api.anthropic.com'] },
        codex: { providerDomains: ['api.openai.com'] },
      },
    },
  });
  const launcher = new RecordingLauncher(kinds);
  const runtime = new WorkerRuntime(
    workerConfig,
    new Map(),
    new Map([['fixture', new FixtureModel()]]),
    {
      sandbox: launcher,
    },
  );
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    defaultKeyExecution: 'sandbox',
    keys: [
      {
        name: 'test',
        owner: 'owner',
        tokenEnv: 'OAA_TEST_TOKEN',
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
    ],
    localWorker: workerConfig,
  });
  process.env.OAA_TEST_TOKEN = token;
  const g = await createGateway(config, runtime);
  for (const engine of ['claude', 'codex', 'antigravity'])
    g.store.publish('owner', makeBundle(agent({ id: `agent/${engine}`, engine })));
  const request = (
    url: string,
    payload: unknown,
    bearer = token,
    headers: Record<string, string> = {},
  ) =>
    g.app.inject({
      method: 'POST',
      url,
      payload: payload as never,
      headers: { authorization: `Bearer ${bearer}`, ...headers },
    });
  const caller = (
    await request('/v1/keys', { name: 'c', agents: ['*'], scopes: ['invoke', 'read'] })
  ).json().token as string;
  return {
    ...g,
    dir,
    launcher,
    runtime,
    caller,
    run: (engine: string, bearer: string, key?: string) =>
      request(
        '/v1/responses',
        { model: `agent/${engine}`, input: 'MARKER:sandboxed' },
        bearer,
        key ? { 'x-oaa-provider-key': key } : {},
      ),
    preview: (engine: string, bearer: string, key?: string) =>
      request(
        '/v1/agents/preview',
        { agent: `agent/${engine}`, model: 'auto' },
        bearer,
        key ? { 'x-oaa-provider-key': key } : {},
      ),
    cleanup: async () => {
      await g.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const ALLOWED_ENV = (keyVar: string, homeVar: string) =>
  new Set(['PATH', 'LANG', 'HOME', keyVar, homeVar]);

test('sandboxed Claude: isolated HOME, --bare, caller key, provider domains only', async () => {
  const s = await gateway();
  try {
    const r = await s.run('claude', s.caller, CALLER_KEY);
    assert.equal(r.json().status, 'completed', r.body);
    assert.equal(s.launcher.wraps.length, 1);
    const { env, policy, args } = s.launcher.wraps[0]!;
    assert.equal(env.ANTHROPIC_API_KEY, CALLER_KEY);
    assert.ok(String(env.HOME).endsWith(`${path.sep}.oaa-home`), String(env.HOME));
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(String(env.HOME), '.claude'));
    // Nothing from this process (tokens, proxies, the owner's own keys) is passed through.
    const allowed = ALLOWED_ENV('ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR');
    for (const name of Object.keys(env))
      assert.ok(
        allowed.has(name) || /^CLAUDE_(CODE|AGENT_SDK)_/.test(name),
        `unexpected env ${name}`,
      );
    assert.deepEqual(policy.allowedDomains, ['api.anthropic.com']);
    assert.equal(policy.workspace, path.dirname(String(env.HOME)));
    // Exactly the CLI's own directory (no package.json above it), as a real path.
    assert.ok(policy.readOnly.includes(await realpath(s.dir)), JSON.stringify(policy.readOnly));
    assert.ok(!policy.readOnly.includes(path.dirname(await realpath(s.dir))), 'no wider ancestor');
    assert.ok(args.includes('--bare'), JSON.stringify(args));
    assert.ok(args[0]!.endsWith('claude-code.mjs'), 'the real script path, run on node');
  } finally {
    await s.cleanup();
  }
});

test('sandboxed Codex: isolated CODEX_HOME, caller key, own sandbox disabled inside ours', async () => {
  const s = await gateway();
  try {
    const r = await s.run('codex', s.caller, CALLER_KEY);
    assert.equal(r.json().status, 'completed', r.body);
    const { env, policy, args, command } = s.launcher.wraps[0]!;
    assert.equal(command, process.execPath);
    assert.equal(env.OPENAI_API_KEY, CALLER_KEY);
    assert.equal(env.CODEX_HOME, path.join(String(env.HOME), '.codex'));
    for (const name of Object.keys(env))
      assert.ok(ALLOWED_ENV('OPENAI_API_KEY', 'CODEX_HOME').has(name), `unexpected env ${name}`);
    assert.deepEqual(policy.allowedDomains, ['api.openai.com']);
    // Configured args (the fixture script) first, then the engine flags, then the subcommand.
    const flag = args.indexOf('-c');
    assert.ok(
      flag > 0 && args[flag + 1] === 'sandbox_mode="danger-full-access"',
      JSON.stringify(args),
    );
    assert.ok(args.indexOf('app-server') > flag);
    assert.ok(args[0]!.endsWith('native-full.mjs'));
  } finally {
    await s.cleanup();
  }
});

test('sandbox-level native runs need the caller key, a verified sandbox and a sandboxable engine', async () => {
  const s = await gateway();
  try {
    const missing = await s.run('claude', s.caller);
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json().error.code, 'provider_key_required');
    const agy = await s.run('antigravity', s.caller, CALLER_KEY);
    assert.equal(agy.statusCode, 403, agy.body);
    assert.equal(agy.json().error.code, 'isolation_required');
    // The owner's admin key keeps host execution and does not take caller keys for native agents.
    const host = await s.run('claude', token);
    assert.equal(host.json().status, 'completed', host.body);
    const hostByok = await s.run('claude', token, CALLER_KEY);
    assert.equal(hostByok.statusCode, 400);
    assert.equal(hostByok.json().error.code, 'byok_not_supported');
    assert.equal(s.launcher.wraps.length, 0, 'nothing above was started in the sandbox');
    // The caller key never reached the database or any file.
    const hits: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if ((await readFile(p)).includes(CALLER_KEY)) hits.push(p);
      }
    };
    await walk(s.dir);
    assert.deepEqual(hits, []);
  } finally {
    await s.cleanup();
  }
  const unverified = await gateway(['script']);
  try {
    const r = await unverified.run('claude', unverified.caller, CALLER_KEY);
    assert.equal(r.statusCode, 503, r.body);
    const preview = await unverified.preview('claude', unverified.caller, CALLER_KEY);
    assert.ok(preview.body.includes('sandbox_unavailable'), preview.body);
    assert.equal(unverified.launcher.wraps.length, 0);
  } finally {
    await unverified.cleanup();
  }
});

test('a worker refuses misrouted native work instead of running it on the host', async () => {
  const s = await gateway(['script']);
  try {
    const bundle = s.store.bundle('owner', 'agent/claude');
    await s.runtime.install(bundle);
    const work = {
      kind: 'native' as const,
      agent: bundle.agent,
      input: 'x',
      context: { runId: 'r', sessionId: 's', owner: 'owner', digest: bundle.digest, files: [] },
    };
    const reject = (extra: Record<string, unknown>, code: string) =>
      assert.rejects(
        () =>
          s.runtime.execute(
            { ...work, ...extra },
            new AbortController().signal,
            async () => undefined,
          ),
        (e) => faultOf(e).code === code,
      );
    await reject({ credential: { apiKey: CALLER_KEY } }, 'byok_not_supported');
    await reject(
      { isolation: 'sandbox', credential: { apiKey: CALLER_KEY } },
      'sandbox_unavailable',
    );
    assert.equal(s.launcher.wraps.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('DeferredProcess bridges an asynchronously started child and reports start failures', async () => {
  const echo = new DeferredProcess(async () =>
    ownedProcess(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      os.tmpdir(),
      new AbortController().signal,
    ),
  );
  echo.stdin.end('bridged');
  let out = '';
  echo.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => echo.once('exit', r));
  assert.equal(code, 0);
  assert.equal(out, 'bridged');

  const failed = new DeferredProcess(async () => {
    throw new Error('sandbox refused');
  });
  const events: string[] = [];
  failed.on('error', (e: Error) => events.push(`error:${e.message}`));
  await new Promise((r) => failed.once('exit', (c: number) => r(events.push(`exit:${c}`))));
  assert.deepEqual(events, ['error:sandbox refused', 'exit:1']);
});
