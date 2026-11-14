import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FixtureModel, agent, principal } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema, parseResponse } from '../src/gateway/protocol.js';
import { buildHandoffBrief, conversationOf } from '../src/kernel/handoff.js';
import type { ModelMessage, Run } from '../src/core/contracts.js';
import { Fault } from '../src/core/util.js';

const invoke = (fields: Record<string, unknown>) =>
  invocationSchema.parse({ background: true, ...fields });

/** 记录每次模型调用收到的智能体 id 和消息，回复带上智能体 id，便于区分是谁答的。 */
function recordingModel() {
  const seen: { agent: string; model: string; messages: ModelMessage[] }[] = [];
  const driver = new FixtureModel(async (definition, messages) => {
    seen.push({
      agent: definition.id,
      model: definition.model,
      messages: messages.map((m) => ({ ...m })),
    });
    return { text: `reply from ${definition.id}` };
  });
  return { driver, seen };
}

/** 注册一个假的外部智能体引擎，记录它收到的输入。 */
function addExternalEngine(s: Awaited<ReturnType<typeof setup>>, inputs: string[]) {
  s.hub.addLocal(
    {
      nodeId: 'external-fixture',
      owner: 'owner',
      token: 'fixture',
      agents: ['*'],
      capabilities: ['*'],
    },
    {
      advertisement: () => ({
        nodeId: 'external-fixture',
        providers: [],
        natives: ['adapter/handoff-fixture'],
        capabilities: [],
        warm: [],
        concurrency: 1,
      }),
      install: async () => {},
      close: async () => {},
      execute: async (work) => {
        inputs.push(String((work as { input?: unknown }).input));
        return { text: 'external agent reply', nativeState: { thread: 'abc' }, usage: null };
      },
    },
  );
}

test('没有交接标记时，换智能体或换模型续接仍然被拒绝', async () => {
  const { driver } = recordingModel();
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/b' })));
    const first = s.kernel.submit(principal, invoke({ agent: 'agent/a', input: 'first task' }));
    await s.kernel.wait(first.id);
    assert.throws(
      () =>
        s.kernel.submit(
          principal,
          invoke({ agent: 'agent/b', input: 'continue', previous_response_id: first.id }),
        ),
      (e: { code?: string }) => e.code === 'invalid_continuation',
    );
    assert.throws(
      () =>
        s.kernel.submit(
          principal,
          invoke({
            agent: 'agent/a',
            model: 'another-model',
            input: 'continue',
            previous_response_id: first.id,
          }),
        ),
      (e: { code?: string }) => e.code === 'model_switch_requires_new_session',
    );
  } finally {
    await s.cleanup();
  }
});

test('内核智能体之间交接：新智能体看到之前的对话，会话与文件照常继承', async () => {
  const { driver, seen } = recordingModel();
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/b', instructions: 'You are B.' })));
    const file = await s.store.addFile('owner', 'notes.md', Buffer.from('hello'));
    const first = s.kernel.submit(
      principal,
      invoke({ agent: 'agent/a', input: 'first task', file_ids: [file.id] }),
    );
    const done = await s.kernel.wait(first.id);
    assert.equal(done.status, 'completed');

    const preview = s.kernel.preview(principal, {
      agent: 'agent/b',
      model: 'auto',
      file_ids: [],
      previous_response_id: first.id,
      handoff: true,
    });
    assert.equal(preview.error, null);
    assert.equal(preview.session_pinned, false);

    const second = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/b',
        input: 'second task',
        previous_response_id: first.id,
        handoff: true,
      }),
    );
    const finished = await s.kernel.wait(second.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.agentId, 'agent/b');
    assert.equal(finished.sessionId, done.sessionId);
    assert.equal(finished.previousId, first.id);
    assert.equal(finished.metadata['oaa.handoff_from'], 'agent/a');
    assert.deepEqual(finished.fileIds, [file.id]);
    assert.equal(finished.output.map((m) => m.text).join(''), 'reply from agent/b');

    const call = seen.at(-1)!;
    assert.equal(call.agent, 'agent/b');
    assert.deepEqual(
      call.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]),
      [
        ['user', 'first task'],
        ['assistant', 'reply from agent/a'],
        ['user', 'second task'],
      ],
    );
    // 上一个智能体的 provider 状态和工具调用细节不会被带过去。
    assert.ok(call.messages.every((m) => !m.providerState && !m.providerItems && !m.tool_calls));
  } finally {
    await s.cleanup();
  }
});

test('元数据写法 oaa.handoff=true 等价于 handoff 字段，兼容入口不需要改请求结构', async () => {
  const { driver } = recordingModel();
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/b' })));
    const first = s.kernel.submit(principal, invoke({ agent: 'agent/a', input: 'first task' }));
    await s.kernel.wait(first.id);
    const parsed = parseResponse({
      model: 'agent/b',
      input: 'via responses',
      previous_response_id: first.id,
      metadata: { 'oaa.handoff': 'true' },
      background: true,
    });
    assert.equal(parsed.metadata['oaa.handoff'], 'true');
    const second = s.kernel.submit(principal, parsed);
    const finished = await s.kernel.wait(second.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.agentId, 'agent/b');
    assert.equal(finished.metadata['oaa.handoff_from'], 'agent/a');
  } finally {
    await s.cleanup();
  }
});

test('上一轮没有完成时不能交接；对新智能体没有权限时不能交接', async () => {
  const driver = new FixtureModel(async (definition) => {
    if (definition.id === 'agent/broken') throw new Error('fixture failure');
    return { text: 'ok' };
  });
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/broken' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/b' })));
    const failed = s.kernel.submit(principal, invoke({ agent: 'agent/broken', input: 'x' }));
    assert.notEqual((await s.kernel.wait(failed.id)).status, 'completed');
    assert.throws(
      () =>
        s.kernel.submit(
          principal,
          invoke({ agent: 'agent/b', input: 'y', previous_response_id: failed.id, handoff: true }),
        ),
      (e: { code?: string }) => e.code === 'invalid_continuation',
    );

    const ok = s.kernel.submit(principal, invoke({ agent: 'agent/a', input: 'x' }));
    await s.kernel.wait(ok.id);
    const limited = { ...principal, agents: ['agent/a'] };
    assert.throws(
      () =>
        s.kernel.submit(
          limited,
          invoke({ agent: 'agent/b', input: 'y', previous_response_id: ok.id, handoff: true }),
        ),
      (e: { code?: string }) => e.code === 'scope_denied',
    );
  } finally {
    await s.cleanup();
  }
});

test('同一个智能体带交接标记可以换模型线路继续', async () => {
  const { driver, seen } = recordingModel();
  const s = await setup(driver);
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/multi',
          routes: [
            { id: 'main', provider: 'fixture', model: 'fixture' },
            { id: 'alt', provider: 'fixture', model: 'fixture-alt' },
          ],
        }),
      ),
    );
    const first = s.kernel.submit(
      principal,
      invoke({ agent: 'agent/multi', model: 'main', input: 'first' }),
    );
    const done = await s.kernel.wait(first.id);
    assert.equal(done.route.model, 'fixture');
    const second = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/multi',
        model: 'alt',
        input: 'second',
        previous_response_id: first.id,
        handoff: true,
      }),
    );
    const finished = await s.kernel.wait(second.id);
    assert.equal(finished.status, 'completed', JSON.stringify(finished.error));
    assert.equal(finished.route.model, 'fixture-alt');
    assert.equal(finished.sessionId, done.sessionId);
    // 同一个智能体换线路不算「从别的智能体交接」。
    assert.equal(finished.metadata['oaa.handoff_from'], undefined);
    assert.equal(seen.at(-1)!.model, 'fixture-alt');
    assert.equal(finished.checkpoint.nativeState, undefined);
  } finally {
    await s.cleanup();
  }
});

test('内核 → 外部智能体 → 内核：外部智能体收到交接说明，它的回复能再交接回来', async () => {
  const { driver, seen } = recordingModel();
  const s = await setup(driver);
  const inputs: string[] = [];
  try {
    addExternalEngine(s, inputs);
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/external', engine: 'adapter/handoff-fixture', model: 'default' }),
      ),
    );
    const first = s.kernel.submit(principal, invoke({ agent: 'agent/a', input: 'draft the plan' }));
    await s.kernel.wait(first.id);

    const second = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/external',
        input: 'now implement it',
        previous_response_id: first.id,
        handoff: true,
      }),
    );
    const external = await s.kernel.wait(second.id);
    assert.equal(external.status, 'completed', JSON.stringify(external.error));
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0]!.startsWith('[交接说明]'));
    assert.match(inputs[0]!, /之前由智能体「agent\/a」处理/);
    assert.match(inputs[0]!, /用户：draft the plan/);
    assert.match(inputs[0]!, /智能体：reply from agent\/a/);
    assert.ok(inputs[0]!.endsWith('新要求：\nnow implement it'));
    // 运行记录里保存的仍是用户的原始输入。
    assert.equal(external.input, 'now implement it');
    assert.equal(external.metadata['oaa.handoff_from'], 'agent/a');

    // 外部智能体继续自己的会话时不再重复交接说明。
    const third = s.kernel.submit(
      principal,
      invoke({ agent: 'agent/external', input: 'keep going', previous_response_id: second.id }),
    );
    await s.kernel.wait(third.id);
    assert.equal(inputs[1], 'keep going');

    // 再交接回内核智能体：能看到外部智能体的回复。
    const fourth = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/a',
        input: 'review the result',
        previous_response_id: third.id,
        handoff: true,
      }),
    );
    const back = await s.kernel.wait(fourth.id);
    assert.equal(back.status, 'completed', JSON.stringify(back.error));
    assert.equal(back.checkpoint.nativeState, undefined);
    const contents = seen
      .at(-1)!
      .messages.filter((m) => m.role !== 'system')
      .map((m) => m.content);
    assert.ok(contents.includes('external agent reply'));
    assert.equal(contents.at(-1), 'review the result');
  } finally {
    await s.cleanup();
  }
});

test('交接说明：结构固定、有长度上限、只含对话文字和文件名', () => {
  const brief = buildHandoffBrief({
    fromAgent: 'agent/a',
    conversation: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ],
    inputFiles: ['a.md', 'a.md', 'b.csv'],
    artifacts: ['report.md'],
  });
  assert.equal(
    brief,
    [
      '[交接说明] 你正在接手一个进行中的任务。之前由智能体「agent/a」处理。',
      '之前的对话（从旧到新）：',
      '用户：question',
      '智能体：answer',
      '已有文件：a.md、b.csv',
      '之前生成的文件：report.md',
      '请在此基础上继续完成下面的新要求，不要重复已经完成的工作。',
    ].join('\n'),
  );

  const long = buildHandoffBrief({
    fromAgent: 'agent/a',
    conversation: Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `${i}:` + 'x'.repeat(3000),
    })),
    inputFiles: Array.from({ length: 80 }, (_, i) => `f${i}.txt`),
    artifacts: [],
  });
  assert.ok(long.length <= 12_000, `brief is ${long.length} chars`);
  assert.match(long, /更早的内容已省略/);
  assert.match(long, /39:x+…/); // 最近的一条保留，但单条被截断
  assert.doesNotMatch(long, /\n用户：0:/); // 最早的被省略
  assert.match(long, /等 80 个/);

  const previous = {
    checkpoint: {
      messages: [
        { role: 'system', content: 'secret system prompt' },
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c', name: 't', arguments: {} }] },
        { role: 'tool', content: '{"secret":"tool output"}', tool_call_id: 'c' },
        { role: 'assistant', content: 'done' },
      ],
    },
    output: [{ id: 'm', text: 'done' }],
  } as unknown as Run;
  assert.deepEqual(conversationOf(previous), [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'done' },
  ]);
});

test('一键启用已安装的智能体：写入配置、立即生效、可直接发布，不需要重启', async () => {
  const { mkdtemp, writeFile, chmod, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createGateway } = await import('../src/gateway/server.js');
  const { gatewaySchema } = await import('../src/config/config.js');
  const { token } = await import('./helpers.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-enable-'));
  const bin = path.join(root, 'bin');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(bin);
  await writeFile(path.join(bin, 'qwen'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(bin, 'qwen'), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  process.env.OAA_TEST_TOKEN = token;
  const configFile = path.join(root, 'config.json');
  const rawConfig = {
    dataDir: path.join(root, 'gateway'),
    port: 0,
    keys: [{ name: 'test', owner: 'owner', tokenEnv: 'OAA_TEST_TOKEN', scopes: principal.scopes }],
    localWorker: { nodeId: 'local', dataDir: path.join(root, 'worker') },
  };
  await writeFile(configFile, JSON.stringify(rawConfig, null, 2));
  const gateway = await createGateway(gatewaySchema.parse(rawConfig), undefined, { configFile });
  await gateway.app.ready();
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    gateway.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    const missing = await call('POST', '/v1/local/presets/gemini/enable');
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().error.code, 'backend_unavailable');

    const enabled = await call('POST', '/v1/local/presets/qwen/enable');
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.deepEqual(
      {
        engine: enabled.json().engine,
        enabled: enabled.json().enabled,
        configured: enabled.json().configured,
        persisted: enabled.json().persisted,
      },
      { engine: 'adapter/qwen', enabled: true, configured: 'added', persisted: true },
    );
    // 配置文件里新增了一条停用的记录（启用状态记在数据库里）。
    const written = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(written.localWorker.adapters.qwen.transport, 'acp');
    assert.equal(written.localWorker.adapters.qwen.enabled, false);
    assert.equal(written.localWorker.adapters.qwen.command, path.join(bin, 'qwen'));

    const listed = (await call('GET', '/v1/local/backends')).json();
    const backend = listed.data.find((b: { engine: string }) => b.engine === 'adapter/qwen');
    assert.equal(backend.enabled, true);
    assert.equal(backend.publishable, true);

    // 再点一次是幂等的。
    const again = await call('POST', '/v1/local/presets/qwen/enable');
    assert.equal(again.json().configured, 'existing');

    // 不需要重启就能发布成可调用的智能体。
    const published = await call('POST', '/v1/agents/publish-native', {
      id: 'agent/qwen',
      engine: 'adapter/qwen',
      models: ['default'],
    });
    assert.equal(published.statusCode, 200, published.body);
  } finally {
    process.env.PATH = originalPath;
    await gateway.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('失败自动换智能体：还没开始做任何事就失败时，同一个请求改由备选智能体完成', async () => {
  const calls: string[] = [];
  const driver = new FixtureModel(async (definition, messages) => {
    calls.push(definition.id);
    if (definition.id === 'agent/down')
      throw new Fault('upstream_unavailable', 'provider is down', 503);
    return { text: `handled by ${definition.id}: ${messages.at(-1)!.content}` };
  });
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/down' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/backup' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/last' })));
    const run = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/down',
        input: 'please help',
        metadata: { 'oaa.agent_fallback': 'agent/down, agent/backup, agent/last' },
      }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.id, run.id);
    assert.equal(done.agentId, 'agent/backup');
    assert.equal(done.error, null);
    assert.equal(done.output.map((m) => m.text).join(''), 'handled by agent/backup: please help');
    assert.equal(done.metadata['oaa.fallback_from'], 'agent/down');
    assert.equal(done.metadata['oaa.agent_fallback'], 'agent/last');
    assert.deepEqual([...new Set(calls)], ['agent/down', 'agent/backup']);
    // 目录里的归属也跟着改了：按智能体查询和鉴权看到的是备选智能体。
    assert.equal(s.store.runState(run.id, 'owner').agent, 'agent/backup');
    const queued = s.store
      .history(run.id)
      .filter((e) => e.type === 'run.queued')
      .map((e) => e.data);
    assert.deepEqual(queued, [
      {
        reason: 'agent_fallback',
        from: 'agent/down',
        to: 'agent/backup',
        error: 'upstream_unavailable',
      },
    ]);
    assert.equal(s.store.history(run.id).filter((e) => e.type === 'response.failed').length, 0);
  } finally {
    await s.cleanup();
  }
});

test('失败自动换智能体：已经有输出或已经执行过工具时不换，避免重复副作用', async () => {
  const driver = new FixtureModel();
  driver.call = async (definition, messages, _signal, emit) => {
    if (definition.id === 'agent/talks') {
      emit('partial answer');
      throw new Fault('upstream_unavailable', 'dropped mid-stream', 503);
    }
    if (definition.id === 'agent/acts') {
      if (messages.some((m) => m.role === 'tool'))
        throw new Fault('upstream_unavailable', 'dropped after tool', 503);
      return {
        text: '',
        calls: [{ id: 'c1', name: 'list_files', arguments: {} }],
        usage: null,
        finish: 'tool_calls' as const,
      };
    }
    return { text: 'backup answer', calls: [], usage: null, finish: 'stop' as const };
  };
  const s = await setup(driver);
  try {
    const { builtin } = await import('../src/lang/bundle.js');
    s.store.publish('owner', makeBundle(agent({ id: 'agent/talks' })));
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/acts', tools: [builtin('list_files')] })),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/backup' })));
    for (const first of ['agent/talks', 'agent/acts']) {
      const run = s.kernel.submit(
        principal,
        invoke({ agent: first, input: 'x', metadata: { 'oaa.agent_fallback': 'agent/backup' } }),
      );
      const done = await s.kernel.wait(run.id);
      assert.equal(done.status, 'failed', first);
      assert.equal(done.agentId, first);
      assert.equal(done.error?.code, 'upstream_unavailable');
    }
    // 没有声明备选时，行为与以前完全一样。
    s.store.publish('owner', makeBundle(agent({ id: 'agent/down' })));
  } finally {
    await s.cleanup();
  }
});

test('失败自动换智能体：备选必须存在且调用方有权限，否则在提交时就拒绝', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'ok' })));
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/a' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/b' })));
    assert.throws(
      () =>
        s.kernel.submit(
          { ...principal, agents: ['agent/a'] },
          invoke({ agent: 'agent/a', input: 'x', metadata: { 'oaa.agent_fallback': 'agent/b' } }),
        ),
      (e: { code?: string }) => e.code === 'scope_denied',
    );
    assert.throws(() =>
      s.kernel.submit(
        principal,
        invoke({ agent: 'agent/a', input: 'x', metadata: { 'oaa.agent_fallback': 'agent/nope' } }),
      ),
    );
    // 正常成功的运行不受备选声明影响。
    const run = s.kernel.submit(
      principal,
      invoke({ agent: 'agent/a', input: 'x', metadata: { 'oaa.agent_fallback': 'agent/b' } }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.agentId, 'agent/a');
    assert.equal(done.metadata['oaa.fallback_from'], undefined);
  } finally {
    await s.cleanup();
  }
});

test('委托步骤按子智能体的实际情况登记副作用等级：外部智能体是「影响未知」，纯只读的内置智能体才是只读', async () => {
  const driver = new FixtureModel(async (definition, messages) => {
    if (definition.id !== 'agent/boss' || messages.some((m) => m.role === 'tool'))
      return { text: `done by ${definition.id}` };
    return {
      calls: [
        { id: 'c_ext', name: 'ask_external', arguments: { task: 'do the external part' } },
        { id: 'c_ro', name: 'ask_reader', arguments: { task: 'do the read-only part' } },
        { id: 'c_wr', name: 'ask_writer', arguments: { task: 'do the writing part' } },
      ],
    };
  });
  const s = await setup(driver);
  const inputs: string[] = [];
  try {
    const { builtin } = await import('../src/lang/bundle.js');
    addExternalEngine(s, inputs);
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/external', engine: 'adapter/handoff-fixture', model: 'default' }),
      ),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/reader', tools: [builtin('read_file')] })),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/writer', tools: [builtin('write_file')] })),
    );
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/boss',
          delegates: [
            { name: 'ask_external', agent: 'agent/external' },
            { name: 'ask_reader', agent: 'agent/reader' },
            { name: 'ask_writer', agent: 'agent/writer' },
          ],
        }),
      ),
    );
    const run = s.kernel.submit(
      principal,
      invoke({ agent: 'agent/boss', input: 'split the work' }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    const effects = Object.fromEntries(
      s.store.steps(run.id).map((step) => [step.name, step.effect]),
    );
    assert.deepEqual(effects, {
      ask_external: 'unknown',
      ask_reader: 'read',
      ask_writer: 'idempotent-write',
    });
    assert.deepEqual(inputs, ['do the external part']);
  } finally {
    await s.cleanup();
  }
});
