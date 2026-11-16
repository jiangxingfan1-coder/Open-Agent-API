import { PRESET_NOTES_EN } from '../src/config/agent-presets-en.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAcp, type AcpTimings } from '../src/engines/acp.js';
import { gatewaySchema, initialize, workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { acpPresets, discoverAcpAgents, nativeBackends } from '../src/config/agent-presets.js';
import { conversionProfile } from '../src/engines/conformance.js';
import { createGateway } from '../src/gateway/server.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { WorkEvent } from '../src/core/contracts.js';
import { Fault, sha } from '../src/core/util.js';
import { agent, principal, setup, token, waitFor } from './helpers.js';

const fixture = path.resolve('test/fixtures/acp-agent.mjs');
const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };
const tempDir = (prefix = 'oaa-acp-') => mkdtemp(path.join(os.tmpdir(), prefix));
const fixtureLog = async (dir: string) =>
  (await readFile(path.join(dir, '.acp-fixture.log'), 'utf8')).trim().split('\n');
const acpAgent = (overrides: Record<string, unknown> = {}) =>
  agent({ engine: 'adapter/fixture', model: 'default', instructions: '', ...overrides });
function acpWorker(dir: string, mode: string, enabled = true) {
  return workerSchema.parse({
    nodeId: 'local',
    dataDir: dir,
    adapters: {
      fixture: {
        transport: 'acp',
        command: process.execPath,
        args: [fixture, mode],
        enabled,
        preset: 'gemini',
      },
    },
  });
}
function recorder(answer?: (data: Record<string, unknown>) => Record<string, unknown> | void) {
  const events: WorkEvent[] = [];
  return {
    events,
    emit: async (event: WorkEvent) => {
      events.push(event);
      if (event.type === 'approval') return answer?.(event.data);
    },
    deltas: () => events.filter((e) => e.type === 'text').map((e) => String(e.data.delta)),
    progress: () => events.filter((e) => e.type === 'progress').map((e) => e.data.event),
  };
}
const code = (expected: string, message?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof Fault, `expected a Fault, got ${String(error)}`);
  assert.equal(error.code, expected, error.message);
  if (message) assert.match(error.message, message);
  return true;
};

test('ACP turn: handshake, streamed text, ignored pre-prompt/thought chunks, reported usage', async () => {
  const dir = await tempDir();
  try {
    const r = recorder();
    const result = await runAcp(
      acpAgent({ instructions: 'Follow the owner rules.' }),
      acpWorker(dir, 'stream'),
      dir,
      'MARKER:alpha task',
      AbortSignal.timeout(15_000),
      r.emit,
      undefined,
      fast,
    );
    assert.equal(result.text, 'ACP fixture turn 1 (model default): alpha');
    assert.deepEqual(r.deltas(), ['ACP fixture turn 1', ' (model default)', ': alpha']);
    assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    assert.equal(result.nativeState.transport, 'acp');
    assert.equal(result.nativeState.adapter, 'fixture');
    assert.equal(result.nativeState.preset, 'gemini');
    assert.equal(result.nativeState.agentName, 'oaa-acp-fixture');
    assert.equal(result.nativeState.resumable, true);
    assert.equal(result.nativeState.usageScope, 'agent_reported_turn');
    assert.deepEqual(result.nativeState.contextUsage, { used: 1234, size: 200000 });
    assert.match(String(result.nativeState.sessionId), /^fixture-session-/);
    const serialized = JSON.stringify(r.events);
    assert.ok(!serialized.includes('PRIVATE-THOUGHT'), 'thought text must not leak into output');
    assert.ok(!serialized.includes('NOT-PART-OF-THE-TURN'), 'pre-prompt chunks are not output');
    assert.deepEqual(r.progress(), ['initialized', 'thinking', 'tool', 'tool', 'plan']);
    const log = await fixtureLog(dir);
    assert.ok(log.includes('initialize:1:fs=false/false:terminal=false:client=open-agent-api'));
    assert.ok(log.includes(`session/new:${path.resolve(dir)}:mcp=0`));
    assert.ok(log.includes('prompt:Follow the owner rules.'), 'instructions precede the task');
    assert.ok(log.includes('stdin-closed'), 'the owned process is closed after the turn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP continuation uses session/load and does not replay history into new output', async () => {
  const dir = await tempDir();
  try {
    const cfg = acpWorker(dir, 'stream');
    const first = await runAcp(
      acpAgent(),
      cfg,
      dir,
      'MARKER:one',
      AbortSignal.timeout(15_000),
      recorder().emit,
      undefined,
      fast,
    );
    const r = recorder();
    const second = await runAcp(
      acpAgent(),
      cfg,
      dir,
      'MARKER:two',
      AbortSignal.timeout(15_000),
      r.emit,
      first.nativeState,
      fast,
    );
    assert.equal(second.text, 'ACP fixture turn 2 (model default): two');
    assert.deepEqual(r.deltas(), ['ACP fixture turn 2', ' (model default)', ': two']);
    assert.equal(second.nativeState.sessionId, first.nativeState.sessionId);
    const log = await fixtureLog(dir);
    assert.ok(
      log.some(
        (l) => l === `session/load:${String(first.nativeState.sessionId)}:${path.resolve(dir)}`,
      ),
    );
    assert.equal(log.filter((l) => l.startsWith('session/new:')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP continuation fails honestly when the agent cannot restore sessions', async () => {
  const dir = await tempDir();
  try {
    const cfg = acpWorker(dir, 'noload');
    const first = await runAcp(
      acpAgent(),
      cfg,
      dir,
      'MARKER:one',
      AbortSignal.timeout(15_000),
      recorder().emit,
      undefined,
      fast,
    );
    assert.equal(first.nativeState.resumable, false);
    await assert.rejects(
      runAcp(
        acpAgent(),
        cfg,
        dir,
        'MARKER:two',
        AbortSignal.timeout(15_000),
        recorder().emit,
        first.nativeState,
        fast,
      ),
      code('native_resume_unsupported'),
    );
    await assert.rejects(
      runAcp(
        acpAgent(),
        cfg,
        dir,
        'x',
        AbortSignal.timeout(15_000),
        recorder().emit,
        { adapter: 'other', sessionId: 's' },
        fast,
      ),
      code('native_resume_unsupported'),
    );
    const log = await fixtureLog(dir);
    assert.equal(
      log.filter((l) => l.startsWith('prompt:')).length,
      1,
      'no prompt without a restored session',
    );
    assert.equal(
      log.filter((l) => l.startsWith('started:')).length,
      2,
      'adapter mismatch fails before spawning',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP permission requests use the owner approval bridge and only grant allow_once', async () => {
  const dir = await tempDir();
  try {
    const approvals: Record<string, unknown>[] = [];
    const r = recorder((data) => {
      approvals.push(data);
      return { decision: 'approve' };
    });
    const result = await runAcp(
      acpAgent(),
      acpWorker(dir, 'permission'),
      dir,
      'write it',
      AbortSignal.timeout(15_000),
      r.emit,
      undefined,
      fast,
    );
    assert.equal(result.text, 'Permission granted; file written.');
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvals[0], {
      native: 'acp',
      adapter: 'fixture',
      preset: 'gemini',
      tool_call_id: 'call-1',
      title: 'Write outputs/approved.txt',
      kind: 'edit',
      input: { path: 'outputs/approved.txt', content: 'approved' },
      locations: ['outputs/approved.txt'],
      options: [
        { kind: 'allow_once', name: 'Allow' },
        { kind: 'reject_once', name: 'Reject' },
      ],
    });
    assert.ok((await fixtureLog(dir)).includes('permission:selected:once'));
    assert.equal(await readFile(path.join(dir, 'outputs/approved.txt'), 'utf8'), 'approved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP permission is refused on owner denial, without an approval bridge, or without allow_once', async () => {
  for (const [mode, answer, asked] of [
    ['permission', { decision: 'deny' }, 1],
    ['permission', undefined, 1],
    ['permission-always', { decision: 'approve' }, 0],
  ] as const) {
    const dir = await tempDir();
    try {
      let count = 0;
      const r = recorder(() => {
        count++;
        return answer;
      });
      await assert.rejects(
        runAcp(
          acpAgent(),
          acpWorker(dir, mode),
          dir,
          'write it',
          AbortSignal.timeout(15_000),
          r.emit,
          undefined,
          fast,
        ),
        code('permission_denied'),
      );
      assert.equal(count, asked);
      assert.ok((await fixtureLog(dir)).includes('permission:selected:no'));
      assert.equal(existsSync(path.join(dir, 'outputs/approved.txt')), false);
      assert.ok(
        r.events.some((e) => e.type === 'progress' && e.data.event === 'permission_denied'),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('ACP cancellation sends session/cancel and waits for the agent acknowledgement', async () => {
  const dir = await tempDir();
  try {
    const controller = new AbortController();
    const r = recorder();
    const emit = async (event: WorkEvent) => {
      await r.emit(event);
      if (event.type === 'text') controller.abort();
    };
    await assert.rejects(
      runAcp(
        acpAgent(),
        acpWorker(dir, 'hang'),
        dir,
        'long task',
        controller.signal,
        emit,
        undefined,
        fast,
      ),
      code('cancelled'),
    );
    assert.deepEqual(r.deltas(), ['working...']);
    const log = await fixtureLog(dir);
    assert.ok(log.some((l) => l.startsWith('cancel:fixture-session-')));
    assert.ok(log.includes('cancel-acknowledged'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an ACP agent that ignores cancel and SIGTERM is still terminated', async () => {
  const dir = await tempDir();
  try {
    const controller = new AbortController();
    const started = Date.now();
    const emit = async (event: WorkEvent) => {
      if (event.type === 'text') controller.abort();
    };
    await assert.rejects(
      runAcp(
        acpAgent(),
        acpWorker(dir, 'stubborn'),
        dir,
        'long task',
        controller.signal,
        emit,
        undefined,
        {
          ...fast,
          cancelGraceMs: 200,
          exitGraceMs: 200,
        },
      ),
      code('cancelled'),
    );
    assert.ok(Date.now() - started < 10_000);
    const log = await fixtureLog(dir);
    const pid = Number(log.find((l) => l.startsWith('started:stubborn:'))!.split(':')[2]);
    // Windows has no catchable SIGTERM: the tree is ended with taskkill /F directly.
    if (process.platform !== 'win32') assert.ok(log.includes('sigterm-ignored'));
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP failures are reported with specific codes and redacted details', async () => {
  for (const [mode, expected, message] of [
    ['fail', 'native_protocol_error', /session\/prompt/],
    ['crash', 'native_incomplete', /fixture crashed on purpose/],
    ['auth', 'adapter_auth_required', /不会代为认证/],
    ['refusal', 'native_incomplete', /refusal/],
    ['garbage', 'native_protocol_error', /非 JSON/],
    ['version2', 'native_protocol_error', /协议版本 2/],
  ] as const) {
    const dir = await tempDir();
    try {
      await assert.rejects(
        runAcp(
          acpAgent(),
          acpWorker(dir, mode),
          dir,
          'task',
          AbortSignal.timeout(15_000),
          recorder().emit,
          undefined,
          fast,
        ),
        (error: unknown) => {
          code(expected, message)(error);
          assert.ok(!(error as Error).message.includes('fixture-secret-value-123456'));
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const dir = await tempDir();
  try {
    await assert.rejects(
      runAcp(
        acpAgent(),
        acpWorker(dir, 'silent'),
        dir,
        'task',
        AbortSignal.timeout(15_000),
        recorder().emit,
        undefined,
        {
          ...fast,
          handshakeTimeoutMs: 300,
        },
      ),
      code('adapter_timeout'),
    );
    await assert.rejects(
      runAcp(
        acpAgent(),
        workerSchema.parse({
          nodeId: 'local',
          dataDir: dir,
          adapters: { fixture: { transport: 'acp', command: '/must-not-execute', enabled: false } },
        }),
        dir,
        'task',
        AbortSignal.timeout(5_000),
        recorder().emit,
      ),
      code('adapter_disabled'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit ACP models are confirmed through session config before the prompt is sent', async () => {
  const dir = await tempDir();
  try {
    const large = await runAcp(
      acpAgent({ model: 'fixture-large' }),
      acpWorker(dir, 'models'),
      dir,
      'MARKER:m',
      AbortSignal.timeout(15_000),
      recorder().emit,
      undefined,
      fast,
    );
    assert.equal(large.text, 'ACP fixture turn 1 (model fixture-large): m');
    assert.ok((await fixtureLog(dir)).includes('model:fixture-large'));
    await rm(path.join(dir, '.acp-fixture.log'));
    const current = await runAcp(
      acpAgent({ model: 'fixture-small' }),
      acpWorker(dir, 'models'),
      dir,
      'MARKER:s',
      AbortSignal.timeout(15_000),
      recorder().emit,
      undefined,
      fast,
    );
    assert.match(current.text, /model fixture-small/);
    assert.ok(
      !(await fixtureLog(dir)).some((l) => l.startsWith('model:')),
      'no change when already selected',
    );
    await rm(path.join(dir, '.acp-fixture.log'));
    // A restored session that echoes no model configuration keeps the model confirmed earlier,
    // but a different explicit model cannot be confirmed and is refused before prompting.
    const resumed = await runAcp(
      acpAgent({ model: 'fixture-large' }),
      acpWorker(dir, 'models'),
      dir,
      'MARKER:r',
      AbortSignal.timeout(15_000),
      recorder().emit,
      large.nativeState,
      fast,
    );
    assert.match(resumed.text, /^ACP fixture turn 2 /);
    await assert.rejects(
      runAcp(
        acpAgent({ model: 'fixture-small' }),
        acpWorker(dir, 'models'),
        dir,
        'x',
        AbortSignal.timeout(15_000),
        recorder().emit,
        large.nativeState,
        fast,
      ),
      code('model_not_supported'),
    );
    await rm(path.join(dir, '.acp-fixture.log'));
    for (const mode of ['models', 'stream'])
      await assert.rejects(
        runAcp(
          acpAgent({ model: 'unknown-model' }),
          acpWorker(dir, mode),
          dir,
          'x',
          AbortSignal.timeout(15_000),
          recorder().emit,
          undefined,
          fast,
        ),
        code('model_not_supported'),
      );
    assert.ok(
      !(await fixtureLog(dir)).some((l) => l.startsWith('prompt:')),
      'unsupported model never prompts',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workers advertise only enabled ACP adapters whose executable exists', async () => {
  const dir = await tempDir();
  try {
    assert.ok(
      !new WorkerRuntime(acpWorker(dir, 'stream', false))
        .advertisement()
        .natives.includes('adapter/fixture'),
    );
    const ad = new WorkerRuntime(acpWorker(dir, 'stream')).advertisement();
    assert.ok(ad.natives.includes('adapter/fixture'));
    assert.deepEqual(ad.execution?.nativeModels['adapter/fixture'], { mode: 'declared' });
    const missing = workerSchema.parse({
      nodeId: 'local',
      dataDir: dir,
      adapters: {
        fixture: { transport: 'acp', command: path.join(dir, 'missing'), enabled: true },
      },
    });
    assert.ok(!new WorkerRuntime(missing).advertisement().natives.includes('adapter/fixture'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ACP preset catalog matches the console icons and never discovers npx launchers', () => {
  const ids = acpPresets.map((p) => p.id);
  assert.equal(ids.length, 32);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of acpPresets) {
    assert.match(preset.id, /^[a-z0-9-]+$/);
    assert.ok(['documented', 'preview', 'community'].includes(preset.maturity));
    if (preset.verified) assert.match(preset.verified, /^\d{4}-\d{2}-\d{2}$/);
    // Every npx registry launcher is a non-vendor adapter or must be installed by the owner.
    if (preset.maturity === 'community') assert.match(preset.notes, /非官方|非厂商/);
    // 英文说明（agent-presets-en.ts）：每个预设都有，不含汉字，语义标记与中文一致。
    const en = PRESET_NOTES_EN[preset.id] ?? '';
    assert.ok(en.length > 0 && !/\p{Script=Han}/u.test(en), `English notes for ${preset.id}`);
    if (preset.maturity === 'community') assert.match(en, /Unofficial|Not from the vendor/);
    assert.equal(/不会运行 npx/.test(preset.notes), /never runs npx/.test(en), preset.id);
    assert.match(preset.docs_url, /^https:\/\//);
    assert.equal(preset.launcher === 'npx', preset.executable === 'npx', preset.id);
    assert.ok(!preset.discover?.names.includes('npx'), preset.id);
    assert.ok(existsSync(path.resolve('web/agents', `${preset.id}.svg`)), `icon for ${preset.id}`);
  }
  for (const native of Object.values(nativeBackends))
    assert.ok(existsSync(path.resolve('web/agents', `${native.preset}.svg`)), native.preset);
  for (const expected of [
    'gemini',
    'qwen',
    'kimi',
    'opencode-acp',
    'goose',
    'cursor',
    'copilot',
    'kiro',
    'qoder',
    'auggie',
    'factory-droid',
    'cline',
    'vibe',
    'amp-acp',
    'deepseek-harness',
    'claude-acp',
    'codex-acp',
  ])
    assert.ok(ids.includes(expected), expected);
});

async function fakeBinaries(names: string[]) {
  const root = await tempDir('oaa-acp-path-');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  for (const name of names) {
    await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(bin, name), 0o755);
  }
  // A Cursor install resolves through a vendor directory; a bare `agent` does not.
  await mkdir(path.join(root, 'cursor-agent-dist'));
  await writeFile(path.join(root, 'cursor-agent-dist', 'cursor-agent'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(root, 'cursor-agent-dist', 'cursor-agent'), 0o755);
  await symlink(
    path.join(root, 'cursor-agent-dist', 'cursor-agent'),
    path.join(bin, 'cursor-agent'),
  );
  return { root, bin };
}

test('discovery finds installed ACP executables by name only and init records them disabled', async () => {
  const { root, bin } = await fakeBinaries(['gemini', 'qwen', 'dsh', 'codex-acp', 'npx', 'agent']);
  const original = process.env.PATH;
  try {
    const found = await discoverAcpAgents(bin);
    assert.deepEqual(found.map((f) => f.preset.id).sort(), [
      'codex-acp',
      'cursor',
      'deepseek-harness',
      'gemini',
      'qwen',
    ]);
    const byId = new Map(found.map((f) => [f.preset.id, f]));
    assert.deepEqual(byId.get('gemini')!.args, ['--acp']);
    assert.deepEqual(byId.get('codex-acp')!.args, []);
    assert.deepEqual(byId.get('deepseek-harness')!.args, ['--profile', 'acp']);
    assert.equal(byId.get('cursor')!.executable, path.join(bin, 'cursor-agent'));
    process.env.PATH = bin;
    const file = await initialize(path.join(root, 'state'));
    process.env.PATH = original;
    const config = JSON.parse(await readFile(file, 'utf8'));
    const adapters = config.localWorker.adapters as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(adapters).sort(), [
      'codex-acp',
      'cursor',
      'deepseek-harness',
      'gemini',
      'qwen',
    ]);
    assert.ok(Object.values(adapters).every((a) => a.enabled === false && a.transport === 'acp'));
    assert.deepEqual(adapters.gemini, {
      transport: 'acp',
      command: path.join(bin, 'gemini'),
      args: ['--acp'],
      enabled: false,
      preset: 'gemini',
    });
    assert.equal(config.localWorker.native.dsh.enabled, false);
  } finally {
    process.env.PATH = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('package-backed ACP presets discover real binary names without npx arguments', async () => {
  const { root, bin } = await fakeBinaries(['pi-acp', 'deepagents-acp', 'mcode', 'glm-acp-agent']);
  try {
    const found = new Map((await discoverAcpAgents(bin)).map((item) => [item.preset.id, item]));
    for (const [preset, binary, args] of [
      ['pi-acp', 'pi-acp', []],
      ['deepagents', 'deepagents-acp', []],
      ['minimax-code', 'mcode', ['acp']],
      ['glm', 'glm-acp-agent', []],
    ] as const) {
      assert.equal(found.get(preset)?.executable, path.join(bin, binary));
      assert.deepEqual(found.get(preset)?.args, [...args]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oaa doctor --write appends discovered ACP agents disabled and is idempotent', async () => {
  const { root, bin } = await fakeBinaries(['kimi', 'goose']);
  const original = process.env.PATH;
  try {
    process.env.PATH = path.join(root, 'empty');
    const file = await initialize(path.join(root, 'state'));
    process.env.PATH = original;
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).localWorker.adapters, {});
    const doctor = async (...extra: string[]) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [path.resolve('dist/src/cli.js'), 'doctor', '--config', file, ...extra],
            { env: { ...process.env, PATH: bin } },
          )
        ).stdout,
      );
    const readOnly = await doctor();
    assert.deepEqual(readOnly.acp_agents.map((a: { preset: string }) => a.preset).sort(), [
      'cursor',
      'goose',
      'kimi',
    ]);
    assert.ok(readOnly.acp_agents.every((a: { configured: boolean }) => !a.configured));
    assert.equal(readOnly.written_disabled_adapters, undefined);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).localWorker.adapters, {});
    const written = await doctor('--write');
    assert.deepEqual([...written.written_disabled_adapters].sort(), ['cursor', 'goose', 'kimi']);
    assert.equal(written.restart_required, true);
    assert.equal(written.live_model_calls, false);
    const adapters = JSON.parse(await readFile(file, 'utf8')).localWorker.adapters;
    assert.ok(Object.values(adapters).every((a) => (a as { enabled: boolean }).enabled === false));
    assert.deepEqual(adapters.kimi.args, ['acp']);
    const again = await doctor('--write');
    assert.deepEqual(again.written_disabled_adapters, []);
    assert.ok(again.acp_agents.every((a: { configured: boolean }) => a.configured));
  } finally {
    process.env.PATH = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('local backends list native and ACP entries; enable, publish, overview and invoke through the gateway', async () => {
  const s = await setup();
  try {
    const entry = () => ({
      transport: 'acp' as const,
      command: process.execPath,
      args: [fixture, 'stream'],
      enabled: false,
      preset: 'gemini',
    });
    s.config.localWorker!.adapters.gemini = entry();
    s.runtime.config.adapters.gemini = entry();
    s.config.localWorker!.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.runtime.config.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.runtime.acpTimings = fast;
    const before = (await s.request('GET', '/v1/local/backends')).json();
    const codex = before.data.find((b: { engine: string }) => b.engine === 'codex');
    assert.deepEqual(
      {
        kind: codex.kind,
        preset: codex.preset,
        name: codex.name,
        publishable: codex.publishable,
        model_overrides: codex.model_overrides,
        evidence: codex.evidence,
      },
      {
        kind: 'native',
        preset: 'codex',
        name: 'Codex',
        publishable: false,
        model_overrides: 'declared routes',
        evidence: 'installed_not_exercised',
      },
    );
    const gemini = before.data.find((b: { engine: string }) => b.engine === 'adapter/gemini');
    assert.deepEqual(gemini, {
      engine: 'adapter/gemini',
      kind: 'acp',
      transport: 'acp',
      preset: 'gemini',
      name: 'Gemini CLI',
      executable: process.execPath,
      args: [fixture, 'stream'],
      enabled: false,
      maturity: 'documented',
      docs_url: acpPresets.find((p) => p.id === 'gemini')!.docs_url,
      verified: '2026-11-08',
      publishable: false,
      evidence: 'installed_not_exercised',
      conversion: conversionProfile('adapter/gemini', s.config.localWorker),
    });
    const presets = before.presets as {
      id: string;
      kind: string;
      configured: boolean;
      engine?: string;
    }[];
    assert.equal(presets.length, 36);
    assert.equal(new Set(presets.map((p) => p.id)).size, 36);
    assert.deepEqual(
      presets.filter((p) => p.kind === 'native').map((p) => p.id),
      ['codex', 'claude', 'antigravity', 'dsh'],
    );
    const geminiPreset = presets.find((p) => p.id === 'gemini')!;
    assert.equal(geminiPreset.configured, true);
    assert.equal(geminiPreset.engine, 'adapter/gemini');

    const blocked = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/gemini',
      engine: 'adapter/gemini',
      models: ['default'],
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, 'backend_not_enabled');
    const enabled = await s.request('POST', '/v1/local/backends/adapter%2Fgemini', {
      enabled: true,
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.deepEqual(enabled.json(), {
      engine: 'adapter/gemini',
      enabled: true,
      global_agent_configuration_changed: false,
    });
    assert.equal(s.runtime.config.adapters.gemini!.enabled, true);
    const listed = (await s.request('GET', '/v1/local/backends'))
      .json()
      .data.find((b: { engine: string }) => b.engine === 'adapter/gemini');
    assert.equal(listed.publishable, true);

    const published = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/gemini',
      engine: 'adapter/gemini',
      models: ['default'],
    });
    assert.equal(published.statusCode, 200, published.body);
    const overview = (await s.request('GET', '/v1/overview')).json();
    const card = overview.agents.find((a: { id: string }) => a.id === 'agent/gemini');
    assert.equal(card.engine, 'adapter/gemini');
    assert.equal(card.preset, 'gemini');
    assert.equal(card.description, 'Gemini CLI（ACP 智能体）');

    const first = await s.request('POST', '/v1/invoke', {
      protocol: 'oaa/1',
      agent: 'agent/gemini',
      model: 'default',
      input: 'MARKER:gateway',
    });
    assert.equal(first.json().status, 'completed', first.body);
    assert.equal(
      first.json().output[0].content[0].text,
      'ACP fixture turn 1 (model default): gateway',
    );
    assert.equal(first.json().usage.total_tokens, 18);
    const second = await s.request('POST', '/v1/invoke', {
      protocol: 'oaa/1',
      agent: 'agent/gemini',
      model: 'default',
      input: 'MARKER:again',
      previous_response_id: first.json().id,
    });
    assert.equal(second.json().status, 'completed', second.body);
    assert.equal(
      second.json().output[0].content[0].text,
      'ACP fixture turn 2 (model default): again',
    );
    assert.equal(s.driver.calls, 0);

    const disabled = await s.request('POST', '/v1/local/backends/adapter/gemini', {
      enabled: false,
    });
    assert.equal(disabled.json().enabled, false);
    assert.equal(
      (await s.request('POST', '/v1/local/backends/adapter%2Fmissing', { enabled: true }))
        .statusCode,
      404,
    );
    assert.equal(
      (await s.request('POST', '/v1/local/backends/not-an-engine', { enabled: true })).statusCode,
      400,
    );
  } finally {
    await s.cleanup();
  }
});

test('gateway ACP approvals reach the owner, and approved outputs become artifacts', async () => {
  for (const decision of ['approve', 'deny'] as const) {
    const s = await setup(undefined, { approvalTimeoutMs: 15_000 });
    try {
      const entry = () => ({
        transport: 'acp' as const,
        command: process.execPath,
        args: [fixture, 'permission'],
        enabled: true,
        preset: 'cline',
      });
      s.config.localWorker!.adapters.cline = entry();
      s.runtime.config.adapters.cline = entry();
      s.runtime.acpTimings = fast;
      assert.equal(
        (
          await s.request('POST', '/v1/agents/publish-native', {
            id: 'agent/cline',
            engine: 'adapter/cline',
            models: ['default'],
          })
        ).statusCode,
        200,
      );
      const run = await s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/cline', input: 'write it', background: true }),
      );
      await waitFor(() => s.store.approvals(run.id).length === 1, 10_000);
      const approval = s.store.approvals(run.id)[0]!;
      assert.equal(approval.kind, 'native');
      assert.equal(approval.detail.native, 'acp');
      assert.equal(approval.detail.title, 'Write outputs/approved.txt');
      const decided = await s.request('POST', `/v1/runs/${run.id}/actions/${approval.id}`, {
        decision,
      });
      assert.equal(decided.statusCode, 200, decided.body);
      const final = await s.kernel.wait(run.id);
      if (decision === 'approve') {
        assert.equal(final.status, 'completed', JSON.stringify(final.error));
        assert.equal(final.output[0]!.text, 'Permission granted; file written.');
        assert.equal(final.artifactIds.length, 1);
      } else {
        assert.equal(final.status, 'failed');
        assert.equal(final.error?.code, 'permission_denied');
        assert.equal(final.artifactIds.length, 0);
      }
    } finally {
      await s.cleanup();
    }
  }
});

test('gateway cancellation of an ACP run notifies the agent and reports an unconfirmed outcome', async () => {
  const s = await setup();
  try {
    const entry = () => ({
      transport: 'acp' as const,
      command: process.execPath,
      args: [fixture, 'hang'],
      enabled: true,
    });
    s.config.localWorker!.adapters.kimi = entry();
    s.runtime.config.adapters.kimi = entry();
    s.runtime.acpTimings = fast;
    await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/kimi',
      engine: 'adapter/kimi',
      models: ['default'],
    });
    const run = await s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/kimi', input: 'long task', background: true }),
    );
    await waitFor(
      () =>
        s.store
          .history(run.id)
          .some(
            (e) =>
              e.type === 'response.output_text.delta' && String(e.data.delta).includes('working'),
          ),
      10_000,
    );
    const cancelled = await s.request('POST', `/v1/responses/${run.id}/cancel`);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const final = await s.kernel.wait(run.id);
    // Same platform semantics as other native engines: a started native turn that is cancelled
    // may already have had side effects, so it is reported as interrupted, not cleanly cancelled.
    assert.equal(final.status, 'interrupted');
    assert.equal(final.error?.code, 'effect_outcome_unknown');
    assert.equal(s.store.getStep(`native_${run.id}`)?.status, 'uncertain');
    const workspace = path.join(
      s.runtime.config.dataDir,
      'sessions',
      sha('owner').slice(0, 16),
      final.sessionId,
    );
    await waitFor(async () => (await fixtureLog(workspace)).includes('cancel-acknowledged'), 5_000);
    const overview = (await s.request('GET', '/v1/overview')).json();
    assert.equal(overview.agents.find((a: { id: string }) => a.id === 'agent/kimi').preset, 'kimi');
  } finally {
    await s.cleanup();
  }
});

test('ACP handshake check runs initialize only and is reflected in backend evidence', async () => {
  const s = await setup();
  try {
    const entry = () => ({
      transport: 'acp' as const,
      command: process.execPath,
      args: [fixture, 'stream'],
      enabled: false,
      preset: 'qwen',
    });
    s.config.localWorker!.adapters.qwen = entry();
    s.runtime.config.adapters.qwen = entry();
    const check = await s.request('POST', '/v1/local/backends/adapter%2Fqwen/check');
    assert.equal(check.statusCode, 200, check.body);
    assert.equal(check.json().status, 'passed');
    assert.deepEqual(check.json().agent, { name: 'oaa-acp-fixture', version: '1.0.0' });
    assert.equal(check.json().load_session, true);
    assert.deepEqual(check.json().auth_methods, ['fixture-login']);
    assert.equal(check.json().model_called, false);
    const row = (await s.request('GET', '/v1/local/backends'))
      .json()
      .data.find((b: { engine: string }) => b.engine === 'adapter/qwen');
    assert.equal(row.evidence, 'handshake_passed');
    assert.equal(row.enabled, false, 'a check never enables the adapter');
    assert.equal(row.handshake.agent.name, 'oaa-acp-fixture');
    assert.equal(
      (await s.request('POST', '/v1/local/backends/adapter/qwen/check')).statusCode,
      200,
    );
    assert.equal((await s.request('POST', '/v1/local/backends/codex/check')).statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('local ACP enablement persists in the platform database and is invalidated by a changed command', async () => {
  const dir = await tempDir();
  process.env.OAA_TEST_TOKEN = token;
  const build = (command = process.execPath) =>
    gatewaySchema.parse({
      dataDir: path.join(dir, 'gateway'),
      port: 0,
      keys: [
        { name: 'test', owner: 'owner', tokenEnv: 'OAA_TEST_TOKEN', scopes: principal.scopes },
      ],
      localWorker: {
        nodeId: 'local',
        dataDir: path.join(dir, 'worker'),
        adapters: {
          gemini: { transport: 'acp', command, args: [fixture], enabled: false, preset: 'gemini' },
        },
      },
    });
  try {
    const first = await createGateway(build());
    await first.app.ready();
    const enabled = await first.app.inject({
      method: 'POST',
      url: '/v1/local/backends/adapter%2Fgemini',
      payload: { enabled: true },
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    await first.app.close();
    const restored = build();
    const second = await createGateway(restored);
    assert.equal(restored.localWorker!.adapters.gemini!.enabled, true);
    await second.app.close();
    const changed = build(path.join(dir, 'different-command'));
    const third = await createGateway(changed);
    assert.equal(changed.localWorker!.adapters.gemini!.enabled, false);
    await third.app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
