import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeBundle } from '../src/lang/bundle.js';
import {
  domainPattern,
  executionCapabilitiesSchema,
  requiredExecution,
  sandboxable,
  type ModelMessage,
  type ToolBinding,
} from '../src/core/contracts.js';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { advertisedExecution } from '../src/fabric/network.js';
import {
  permittedDomains,
  shellQuote,
  type SandboxLauncher,
  type SandboxPolicy,
} from '../src/engines/sandbox.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { faultOf, sha } from '../src/core/util.js';
import { FixtureModel, agent, token } from './helpers.js';

// Sandbox S1 routing and policy, without starting srt: a recording launcher stands in for the OS
// sandbox (the real boundary is exercised by test/sandbox-srt.test.ts). No sockets.

/** Records each wrap and runs the command unchanged (no isolation: routing tests only). */
class RecordingLauncher implements SandboxLauncher {
  readonly backend = 'srt' as const;
  wraps: { command: string; args: string[]; env: NodeJS.ProcessEnv; policy: SandboxPolicy }[] = [];
  constructor(private readonly verified = true) {}
  report() {
    return this.verified
      ? { backend: 'srt' as const, version: 'test', kinds: ['script' as const] }
      : undefined;
  }
  async wrap(command: string, args: string[], env: NodeJS.ProcessEnv, policy: SandboxPolicy) {
    this.wraps.push({ command, args, env, policy });
    return { command, args, env, release: () => {} };
  }
  async close() {}
}

const SCRIPT = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({echo:JSON.parse(s).text,home:process.env.HOME===process.env.OAA_WORKSPACE})))`;
function scriptTool(network?: string[], required = false): ToolBinding {
  return {
    name: 'echo',
    required,
    capability: {
      id: 'demo/echo',
      version: '1',
      description: 'Echo the text argument.',
      placement: 'portable',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      requiresApproval: false,
      timeoutMs: 20_000,
      cacheTtlMs: 0,
      resultExport: true,
      ...(network ? { network: { allowedDomains: network } } : {}),
    },
    handler: { kind: 'script', path: 'tools/echo.js', runtime: 'node' },
  };
}
const scriptBundle = (id: string, tool: ToolBinding) =>
  makeBundle(agent({ id, tools: [tool] }), [
    { path: 'tools/echo.js', content: Buffer.from(SCRIPT).toString('base64'), sha256: sha(SCRIPT) },
  ]);
const nodeTool: ToolBinding = {
  ...scriptTool(),
  name: 'notes',
  capability: {
    ...scriptTool().capability,
    id: 'private/notes',
    placement: 'host-bound',
    nodeId: 'local',
  },
  handler: { kind: 'node', reference: 'notes' },
};

async function gateway(launcher?: SandboxLauncher) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sandbox-routing-'));
  const toolTurns = (m: ModelMessage[]) => m.filter((x) => x.role === 'tool').length;
  const driver = new FixtureModel((_a, messages) =>
    toolTurns(messages) === 0
      ? { calls: [{ id: 'c1', name: 'echo', arguments: { text: 'hello' } }] }
      : { text: `tool said ${messages.at(-1)!.content}` },
  );
  const workerConfig = workerSchema.parse({
    nodeId: 'local',
    dataDir: path.join(dir, 'worker'),
    scripts: ['node'],
    sandbox: { allowDomains: ['api.example.com', '*.cdn.example.com'] },
  });
  const runtime = new WorkerRuntime(
    workerConfig,
    new Map(),
    new Map([['fixture', driver]]),
    launcher ? { sandbox: launcher } : {},
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
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown, bearer = token) =>
    g.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { authorization: `Bearer ${bearer}` },
    });
  const caller = (
    await request('POST', '/v1/keys', { name: 'c', agents: ['*'], scopes: ['invoke', 'read'] })
  ).json();
  assert.equal(caller.execution, 'sandbox');
  return {
    ...g,
    runtime,
    request,
    caller: caller.token as string,
    cleanup: async () => {
      await g.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('sandbox level: scripts, Claude and Codex fit the sandbox; host tools and other engines never do', () => {
  assert.equal(requiredExecution(agent({ tools: [scriptTool()] })), 'host');
  assert.equal(sandboxable(agent({ tools: [scriptTool()] })), true);
  assert.equal(sandboxable(agent({ tools: [scriptTool(), nodeTool] })), false);
  // S2a: Claude and Codex fit the sandbox (with the caller's key); other native engines do not.
  assert.equal(sandboxable(agent({ engine: 'codex' })), true);
  assert.equal(sandboxable(agent({ engine: 'claude' })), true);
  assert.equal(sandboxable(agent({ engine: 'antigravity' })), false);
  assert.equal(sandboxable(agent({ engine: 'dsh' })), false);
});

test('a sandbox-level caller runs scripts only through the sandbox, with the intersected policy', async () => {
  const launcher = new RecordingLauncher();
  const s = await gateway(launcher);
  try {
    s.store.publish(
      'owner',
      scriptBundle(
        'agent/script',
        scriptTool(['api.example.com', 'img.cdn.example.com', 'evil.example']),
      ),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/hosttool', tools: [nodeTool] })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'antigravity' })));

    const r = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/script', input: 'go' },
      s.caller,
    );
    assert.equal(r.json().status, 'completed', r.body);
    assert.match(JSON.stringify(r.json().output), /hello/);
    assert.match(JSON.stringify(r.json().output), /\\"home\\":true/, 'HOME is the workspace');
    assert.equal(launcher.wraps.length, 1);
    const { policy, command } = launcher.wraps[0]!;
    assert.equal(command, process.execPath);
    assert.deepEqual(policy.allowedDomains.sort(), ['api.example.com', 'img.cdn.example.com']);
    assert.ok(policy.readOnly.some((p) => p.includes(`${path.sep}bundles${path.sep}`)));
    assert.equal(policy.cpuSeconds, 60);
    assert.ok(policy.workspace.length > 0);

    // The owner's admin key keeps host execution: no sandbox wrap.
    const host = await s.request('POST', '/v1/responses', { model: 'agent/script', input: 'go' });
    assert.equal(host.json().status, 'completed', host.body);
    assert.equal(launcher.wraps.length, 1);

    for (const model of ['agent/hosttool', 'agent/native']) {
      const denied = await s.request('POST', '/v1/responses', { model, input: 'x' }, s.caller);
      assert.equal(denied.statusCode, 403, `${model}: ${denied.body}`);
      assert.equal(denied.json().error.code, 'isolation_required', model);
    }
  } finally {
    await s.cleanup();
  }
});

test('without a verified sandbox a sandbox-level script is never run on the host', async () => {
  for (const launcher of [undefined, new RecordingLauncher(false)]) {
    const s = await gateway(launcher);
    try {
      s.store.publish('owner', scriptBundle('agent/script', scriptTool(undefined, true)));
      const r = await s.request(
        'POST',
        '/v1/responses',
        { model: 'agent/script', input: 'go' },
        s.caller,
      );
      assert.equal(r.statusCode, 503, r.body);
      const preview = await s.request(
        'POST',
        '/v1/agents/preview',
        { agent: 'agent/script', model: 'auto' },
        s.caller,
      );
      assert.ok(preview.body.includes('sandbox_unavailable'), preview.body);
      assert.equal(launcher?.wraps.length ?? 0, 0);
    } finally {
      await s.cleanup();
    }
  }
});

test('a worker refuses misrouted sandbox work instead of running it on the host', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sandbox-worker-'));
  try {
    const runtime = new WorkerRuntime(
      workerSchema.parse({ nodeId: 'local', dataDir: dir, scripts: ['node'] }),
    );
    const bundle = scriptBundle('agent/script', scriptTool());
    await runtime.install(bundle);
    await assert.rejects(
      () =>
        runtime.execute(
          {
            kind: 'tool',
            binding: bundle.agent.tools[0]!,
            arguments: { text: 'x' },
            context: {
              runId: 'r',
              sessionId: 's',
              owner: 'owner',
              digest: bundle.digest,
              files: [],
            },
            isolation: 'sandbox',
          },
          new AbortController().signal,
          async () => {},
        ),
      (e) => faultOf(e).code === 'sandbox_unavailable',
    );
    await runtime.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('domains: owner bound intersects publisher declarations; malformed names are rejected', () => {
  assert.deepEqual(
    permittedDomains(
      ['a.example.com', 'b.example.com', 'x.cdn.example.com', 'cdn.example.com'],
      ['a.example.com', '*.cdn.example.com'],
    ),
    ['a.example.com', 'x.cdn.example.com'],
  );
  assert.deepEqual(permittedDomains(['a.example.com'], []), []);
  for (const ok of ['example.com', '*.example.com', 'api.example.co.uk'])
    assert.ok(domainPattern.safeParse(ok).success, ok);
  for (const bad of [
    'http://example.com',
    'example.com:443',
    'example.com/path',
    'a b.com',
    '*',
    'localhost',
    '*.*.com',
  ])
    assert.ok(!domainPattern.safeParse(bad).success, bad);
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
});

test('sandbox metadata reaches a gateway only after sandbox-v1 negotiation', () => {
  const execution = executionCapabilitiesSchema.parse({
    builtins: [],
    scripts: ['node'],
    toolSelection: true,
    nativeModels: {},
    sandbox: { backend: 'srt', version: '0.0.81', kinds: ['script'] },
  });
  assert.equal(
    'sandbox' in advertisedExecution(execution, { byok: false, sandbox: false })!,
    false,
  );
  assert.deepEqual(advertisedExecution(execution, { byok: false, sandbox: true })?.sandbox?.kinds, [
    'script',
  ]);
});
