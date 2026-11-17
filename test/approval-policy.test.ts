/**
 * 发布时的审批策略（approval-policy-v1）：外部智能体可声明 `approvals: 'auto'`，
 * 运行中的权限请求由策略直接批准、留下可追溯的审批记录，不进入 requires_action。
 * 只用 test/fixtures 里的假智能体，不联网、不监听端口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, copyFile, writeFile } from 'node:fs/promises';
import { agentSchema, type Run } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { agent, principal, setup, waitFor } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof setup>>;
const fixtures = {
  native: path.resolve('test/fixtures/native-full.mjs'),
  claude: path.resolve('test/fixtures/claude-code.mjs'),
  acp: path.resolve('test/fixtures/acp-agent.mjs'),
  adapter: path.resolve('test/fixtures/stream-adapter.mjs'),
};
const outputText = (run: Run) => run.output.map((m) => m.text).join('');
const submit = (s: Gateway, agent: string, input: string) =>
  s.kernel.submit(principal, invocationSchema.parse({ agent, input, background: true }));

type Case = { name: string; engine: string; approved: string; install: (s: Gateway) => unknown };
const CASES: Case[] = [
  {
    name: 'acp',
    engine: 'adapter/acp',
    approved: 'Permission granted; file written.',
    install: (s) => {
      const make = () => ({
        transport: 'acp',
        command: process.execPath,
        args: [fixtures.acp, 'stream'],
        enabled: true,
      });
      s.config.localWorker!.adapters.acp = make() as never;
      s.runtime.config.adapters.acp = make() as never;
      s.runtime.acpTimings = {
        handshakeTimeoutMs: 5_000,
        cancelGraceMs: 1_000,
        exitGraceMs: 1_000,
      };
    },
  },
  {
    name: 'codex',
    engine: 'codex',
    approved: 'Approved and written.',
    install: (s) => {
      const make = () => ({ executable: process.execPath, enabled: true, args: [fixtures.native] });
      s.config.localWorker!.native.codex = make() as never;
      s.runtime.config.native.codex = make() as never;
    },
  },
  {
    name: 'claude',
    engine: 'claude',
    approved: 'Permission granted; file written.',
    install: async (s) => {
      const cli = path.join(s.dir, 'claude-code.mjs');
      await copyFile(fixtures.claude, cli);
      await chmod(cli, 0o755);
      const make = () => ({ executable: cli, enabled: true, args: [] });
      s.config.localWorker!.native.claude = make() as never;
      s.runtime.config.native.claude = make() as never;
    },
  },
  {
    name: 'stream',
    engine: 'adapter/stream',
    approved: 'Approved and written.',
    install: (s) => {
      const make = () => ({
        transport: 'stdio',
        protocol: 'oaa/1-stream',
        command: process.execPath,
        args: [fixtures.adapter],
        enabled: true,
      });
      s.config.localWorker!.adapters.stream = make() as never;
      s.runtime.config.adapters.stream = make() as never;
    },
  },
];

const publish = (s: Gateway, id: string, engine: string, approvals?: 'ask' | 'auto') =>
  s.request('POST', '/v1/agents/publish-native', {
    id,
    engine,
    models: ['default'],
    ...(approvals ? { approvals } : {}),
  });

for (const c of CASES)
  test(`approvals: auto lets ${c.name} run through its permission request without the owner`, async () => {
    const s = await setup(undefined, { approvalTimeoutMs: 30_000 });
    try {
      await c.install(s);
      const auto = await publish(s, `agent/${c.name}-auto`, c.engine, 'auto');
      assert.equal(auto.statusCode, 200, auto.body);
      const run = await s.kernel.wait(
        submit(s, `agent/${c.name}-auto`, 'Write it MODE:approval').id,
      );
      assert.equal(run.status, 'completed', JSON.stringify(run.error));
      assert.equal(outputText(run), c.approved);
      const records = s.store.approvals(run.id);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.status, 'approved');
      assert.equal(records[0]!.kind, 'native');
      assert.deepEqual(records[0]!.response, { auto: true });
      const history = s.store.history(run.id);
      assert.equal(history.filter((e) => e.type === 'run.requires_action').length, 0);
      const resolved = history.filter((e) => e.type === 'approval.resolved');
      assert.deepEqual(
        resolved.map((e) => e.data),
        [{ approval_id: records[0]!.id, decision: 'approve', actor: 'policy:auto' }],
      );

      const defaultId = `agent/${c.name}-default`;
      assert.equal((await publish(s, defaultId, c.engine)).statusCode, 200);
      const automatic = await s.kernel.wait(submit(s, defaultId, 'Write it MODE:approval').id);
      assert.equal(automatic.status, 'completed');
      assert.equal(
        s.store.history(automatic.id).some((e) => e.type === 'run.requires_action'),
        false,
      );
      // An explicitly requested approval policy must still stop for the owner.
      for (const approvals of ['ask'] as const) {
        const id = `agent/${c.name}-${approvals ?? 'default'}`;
        assert.equal((await publish(s, id, c.engine, approvals)).statusCode, 200);
        const asked = submit(s, id, 'Write it MODE:approval');
        await waitFor(
          () => s.store.approvals(asked.id).some((a) => a.status === 'pending'),
          15_000,
        );
        assert.equal(s.store.run(asked.id).status, 'requires_action');
        const pending = s.store.approvals(asked.id).find((a) => a.status === 'pending')!;
        const decided = await s.request('POST', `/v1/runs/${asked.id}/actions/${pending.id}`, {
          decision: 'approve',
        });
        assert.equal(decided.statusCode, 200, decided.body);
        const final = await s.kernel.wait(asked.id);
        assert.equal(final.status, 'completed');
        assert.equal(
          s.store.history(asked.id).find((e) => e.type === 'approval.resolved')?.data.actor,
          'test',
        );
      }
    } finally {
      await s.cleanup();
    }
  });

test('approvals: auto is refused for kernel agents and omitted when not set', () => {
  const base = {
    id: 'agent/digest',
    description: 'Digest pin',
    engine: 'adapter/acp',
    model: 'default',
    provider: 'native',
    instructions: '',
    allowGraph: false,
    routes: [{ id: 'default', model: 'default', provider: 'native', priority: 0 }],
  };
  // 改动前对同一定义实际算出的摘要：不写 approvals 的已发布智能体摘要不变。
  const plain = makeBundle(agentSchema.parse(base));
  assert.equal(plain.digest, '160f61d7b1871262e906bf5dbe7c76f11b84673ff61a848ee5f189bf4bf7ca51');
  assert.equal('approvals' in plain.agent, false);
  assert.equal(agentSchema.parse({ ...base, approvals: 'auto' }).approvals, 'auto');
  const kernel = agentSchema.safeParse({
    ...base,
    engine: 'kernel',
    provider: 'fixture',
    approvals: 'auto',
  });
  assert.equal(kernel.success, false);
  assert.match(kernel.error!.message, /requiresApproval/);
  assert.equal(
    agentSchema.safeParse({ ...base, engine: 'kernel', provider: 'x', approvals: 'ask' }).success,
    true,
  );
});

/** 只发一个 300 KiB 审批请求的最小 Codex app-server 假智能体（同 agent-intake 测试的 MODE:big）。 */
const BIG_CODEX = `
import readline from 'node:readline';
const out = (v) => { if (v.method) v.params = {threadId: 'th', turnId: 't', ...v.params}; process.stdout.write(JSON.stringify(v) + '\\n'); };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id === 9) {
    const ok = msg.result.decision === 'accept';
    out({ method: 'item/completed', params: { item: { id: 'i', type: 'commandExecution', status: ok ? 'completed' : 'declined' } } });
    return out({ method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } });
  }
  if (msg.method === 'initialize') return out({ id: msg.id, result: {} });
  if (msg.method === 'thread/start') return out({ id: msg.id, result: { thread: { id: 'th' }, model: msg.params.model ?? 'default' } });
  if (msg.method !== 'turn/start') return;
  out({ id: msg.id, result: { turn: { id: 't', status: 'inProgress' } } });
  out({ id: 9, method: 'item/commandExecution/requestApproval', params: { command: 'x'.repeat(300 * 1024) } });
});
`;

test('approvals: auto still denies an oversized approval detail', async () => {
  const s = await setup(undefined, { approvalTimeoutMs: 30_000 });
  try {
    const file = path.join(s.dir, 'big-codex.mjs');
    await writeFile(file, BIG_CODEX);
    const make = () => ({ executable: process.execPath, enabled: true, args: [file] }) as never;
    s.config.localWorker!.native.codex = make();
    s.runtime.config.native.codex = make();
    assert.equal((await publish(s, 'agent/big', 'codex', 'auto')).statusCode, 200);
    const done = await s.kernel.wait(submit(s, 'agent/big', 'MODE:big').id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'permission_denied');
    assert.equal(s.store.approvals(done.id).length, 0);
  } finally {
    await s.cleanup();
  }
});

test('approvals: auto streams like a run without permission requests', async () => {
  const s = await setup(undefined, { approvalTimeoutMs: 30_000 });
  try {
    await CASES[3]!.install(s);
    assert.equal((await publish(s, 'agent/stream-auto', 'adapter/stream', 'auto')).statusCode, 200);
    const r = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/stream-auto',
      stream: true,
      messages: [{ role: 'user', content: 'Write it MODE:approval' }],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.body.includes('action_required'), false);
    assert.ok(r.body.trimEnd().endsWith('data: [DONE]'));
    assert.ok(r.body.includes('Approved and written.'));
  } finally {
    await s.cleanup();
  }
});

test('approvals: publish surfaces, catalog field, audit row and /health feature', async () => {
  const s = await setup();
  try {
    await CASES[0]!.install(s);
    assert.equal((await publish(s, 'agent/plain', 'adapter/acp', 'ask')).statusCode, 200);
    assert.equal((await publish(s, 'agent/auto', 'adapter/acp', 'auto')).statusCode, 200);
    const bad = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/x',
      engine: 'adapter/acp',
      models: ['default'],
      approvals: 'always',
    });
    assert.equal(bad.statusCode, 400);
    const listed = (await s.request('GET', '/v1/agents')).json().data;
    const auto = listed.find((a: { id: string }) => a.id === 'agent/auto');
    const plain = listed.find((a: { id: string }) => a.id === 'agent/plain');
    assert.equal(auto.approvals, 'auto');
    assert.equal(plain.approvals, undefined);
    const overview = (await s.request('GET', '/v1/overview')).json();
    assert.equal(
      overview.agents.find((a: { id: string }) => a.id === 'agent/auto').approvals,
      'auto',
    );
    const audit = (await s.request('GET', '/v1/audit')).json().data;
    const rows = audit.filter((r: { code: string }) => r.code === 'approval_policy_auto');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, 'agent/auto');
    assert.equal(rows[0].key_id !== undefined, true);
    assert.equal(rows[0].path, '/v1/agents/publish-native');
    const health = (await s.request('GET', '/health')).json();
    assert.ok(health.features.includes('approval-policy-v1'));
  } finally {
    await s.cleanup();
  }
});

test('approvals in OAA-Lang: compile, format round trip, duplicate declaration', () => {
  const source = (value: string) =>
    `agent "agent/acp" {\n  engine = "adapter/acp"\n  provider = "native"\n  model = "default"\n  approvals = ${value}\n}\n`;
  assert.equal(compileOaaLang(source('auto')).agent.approvals, 'auto');
  assert.equal(compileOaaLang(source('"auto"')).agent.approvals, 'auto');
  assert.equal('approvals' in compileOaaLang(source('ask')).agent, false);
  const formatted = formatOaaLang(source('auto'));
  assert.match(formatted, /approvals = auto/);
  assert.deepEqual(compileOaaLang(formatted).agent, compileOaaLang(source('auto')).agent);
  assert.deepEqual(
    compileOaaLang(formatOaaLang(source('ask'))).agent,
    compileOaaLang(source('ask')).agent,
  );
  assert.throws(() => compileOaaLang(source('auto\n  approvals = ask')), /Duplicate 'approvals'/);
  assert.throws(() => compileOaaLang(source('sometimes')), /approvals/);
});

test('republishing without a policy preserves existing approval and access grants', async () => {
  const s = await setup();
  try {
    const base = { id: 'agent/preserved', engine: 'codex', models: ['default'] };
    const access = {
      modes: ['managed'],
      defaultMode: 'managed',
      approval: 'owner',
      trust: 'private',
    };
    assert.equal(
      (await s.request('POST', '/v1/agents/publish-native', { ...base, access })).statusCode,
      200,
    );
    assert.equal((await s.request('POST', '/v1/agents/publish-native', base)).statusCode, 200);
    const after = s.store.bundle('owner', base.id).agent;
    assert.deepEqual(after.access, access);
    assert.notEqual(after.approvals, 'auto');
    assert.equal(
      (await s.request('POST', '/v1/agents/publish-native', { ...base, approvals: 'auto' }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await s.request('POST', '/v1/agents/publish-native', {
          ...base,
          access: { ...access, approval: 'auto' },
          approvals: 'ask',
        })
      ).statusCode,
      400,
    );
  } finally {
    await s.cleanup();
  }
});

test('explicit policy migration creates a new revision and preserves all other definition fields', async () => {
  const s = await setup();
  try {
    const published = await publish(s, 'agent/migrate', 'codex', 'ask');
    assert.equal(published.statusCode, 200);
    const before = s.store.bundle('owner', 'agent/migrate');
    const migrated = await s.request('POST', '/v1/agents/policy', {
      agent: before.agent.id,
      version: before.digest,
      approval: 'auto',
      orchestration: false,
    });
    assert.equal(migrated.statusCode, 200, migrated.body);
    const after = s.store.bundle('owner', before.agent.id);
    assert.equal(after.agent.approvals, 'auto');
    assert.equal(s.store.bundle('owner', before.agent.id, before.digest).agent.approvals, 'ask');
    assert.deepEqual(after.agent.routes, before.agent.routes);
    assert.deepEqual(after.agent.orchestration, before.agent.orchestration);
    assert.equal(
      (
        await s.request('POST', '/v1/agents/policy', {
          agent: before.agent.id,
          version: before.digest,
          approval: 'ask',
          orchestration: false,
        })
      ).statusCode,
      409,
    );
  } finally {
    await s.cleanup();
  }
});

test('changing approvals alone preserves legacy orchestration helpers', async () => {
  const s = await setup();
  try {
    const before = makeBundle(
      agent({
        orchestration: { enabled: true, scope: 'helpers', helpers: ['agent/reviewer'] },
        access: {
          modes: ['managed'],
          defaultMode: 'managed',
          approval: 'owner',
          trust: 'private',
        },
      }),
    );
    s.store.publish('owner', before);
    const result = await s.request('POST', '/v1/agents/policy', {
      agent: before.agent.id,
      version: before.digest,
      approval: 'auto',
      orchestration: true,
    });
    assert.equal(result.statusCode, 200, result.body);
    const automatic = s.store.bundle('owner', before.agent.id);
    assert.deepEqual(automatic.agent.orchestration, before.agent.orchestration);
    assert.equal(automatic.agent.access?.approval, 'auto');
    const migrated = await s.request('POST', '/v1/agents/policy', {
      agent: automatic.agent.id,
      version: automatic.digest,
      approval: 'auto',
      orchestration: false,
    });
    assert.equal(migrated.statusCode, 200, migrated.body);
    const disabled = s.store.bundle('owner', automatic.agent.id);
    assert.deepEqual(disabled.agent.orchestration, {
      ...automatic.agent.orchestration,
      enabled: false,
    });
  } finally {
    await s.cleanup();
  }
});
