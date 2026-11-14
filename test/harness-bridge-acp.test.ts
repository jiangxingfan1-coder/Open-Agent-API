import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { AcpTimings } from '../src/engines/acp.js';
import { callerToolPermission, openCallerRelay } from '../src/engines/caller-relay.js';
import { advertisedExecution } from '../src/fabric/network.js';
import { workPlacement } from '../src/fabric/placement.js';
import { conversionProfile } from '../src/engines/conformance.js';
import { GATEWAY_FEATURES } from '../src/gateway/server.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import type { WorkEvent } from '../src/core/contracts.js';
import { sha } from '../src/core/util.js';
import { agent, setup, token, waitFor } from './helpers.js';

// 外部智能体（ACP）的调用方工具桥接（docs/harness.md）：协议级假智能体经 MCP 中继调用调用方工具。
// 需要起子进程（假智能体、中继），不监听 TCP 端口（中继只用 Unix 域套接字）。

type Fixture = Awaited<ReturnType<typeof setup>>;
const fixture = path.resolve('test/fixtures/acp-caller-agent.mjs');
const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };
const BRIDGE = { 'x-oaa-client-tools': 'bridge' };
const EDIT_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};
const EDIT = {
  type: 'function',
  function: { name: 'edit-file', description: 'Edit a file.', parameters: EDIT_SCHEMA },
};
const LINT = {
  type: 'function',
  function: { name: 'lint', parameters: { type: 'object', properties: {} } },
};
type Call = { name: string; arguments?: Record<string, unknown> };
const script = (groups: Call[][], extra: Record<string, unknown> = {}) =>
  `Do the task.\nSCRIPT:${JSON.stringify({ groups, ...extra })}`;
const user = (content: string) => ({ role: 'user', content });
const edit = (p = 'a.ts'): Call => ({ name: 'edit-file', arguments: { path: p } });
const lint: Call = { name: 'lint', arguments: {} };
const toolMessage = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });
const assistantCalls = (calls: { id: string }[]) => ({
  role: 'assistant',
  content: null,
  tool_calls: calls,
});

async function acpSetup(extra: Record<string, unknown> = {}) {
  const s = await setup(undefined, { approvalTimeoutMs: 15_000, ...extra });
  const entry = () => ({
    transport: 'acp' as const,
    command: process.execPath,
    args: [fixture],
    enabled: true,
  });
  s.config.localWorker!.adapters.caller = entry();
  s.runtime.config.adapters.caller = entry();
  s.runtime.acpTimings = fast;
  const published = await s.request('POST', '/v1/agents/publish-native', {
    id: 'agent/caller',
    engine: 'adapter/caller',
    models: ['default'],
  });
  assert.equal(published.statusCode, 200, published.body);
  return s;
}
const chat = (
  s: Fixture,
  body: Record<string, unknown>,
  headers: Record<string, string> = BRIDGE,
  key = token,
) =>
  s.request(
    'POST',
    '/v1/compat/chat/completions',
    { model: 'agent/caller', tools: [EDIT, LINT], ...body },
    key,
    headers,
  );
const post = (s: Fixture, url: string, body: Record<string, unknown>) =>
  s.request('POST', url, { model: 'agent/caller', ...body }, token, BRIDGE);
const workspace = (s: Fixture, runId: string) =>
  path.join(
    s.runtime.config.dataDir,
    'sessions',
    sha('owner').slice(0, 16),
    s.store.run(runId).sessionId,
  );
async function fixtureLog(s: Fixture, runId: string): Promise<string[]> {
  const file = path.join(workspace(s, runId), '.acp-caller.log');
  return existsSync(file) ? (await readFile(file, 'utf8')).trim().split('\n') : [];
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 每个 mcpServers 条目的套接字与令牌文件都已删除，每个中继进程都已退出。 */
async function assertClean(s: Fixture, runId: string) {
  const lines = await fixtureLog(s, runId);
  const files = lines
    .filter((l) => l.startsWith('session/new:') || l.startsWith('session/load:'))
    .flatMap((l) => JSON.parse(l.slice(l.indexOf(':') + 1)) as { args: string[] }[])
    .flatMap((server) => [server.args[3]!, server.args[5]!]);
  const pids = lines.filter((l) => l.startsWith('relay-pid:')).map((l) => Number(l.slice(10)));
  await waitFor(() => files.every((f) => !existsSync(f)) && pids.every((p) => !alive(p)), 10_000);
  for (const f of files) assert.equal(existsSync(path.dirname(f)), false, 'relay dir removed');
}
const eventTypes = (s: Fixture, runId: string) => s.store.history(runId).map((e) => e.type);
const frames = (body: string) =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map((f) => {
      assert.ok(f.startsWith('data: '), f);
      const data = f.slice(6);
      return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
    });

test('acp bridge: a single call becomes tool_calls; the reply reaches the agent over MCP', async () => {
  const s = await acpSetup();
  try {
    const first = await chat(s, { messages: [user(script([[edit()]]))] });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const choice = first.json().choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, null);
    const [call] = choice.message.tool_calls;
    assert.match(call.id, /^call_/);
    assert.deepEqual(call.function, { name: 'edit-file', arguments: '{"path":"a.ts"}' });
    const run = s.store.run(runId);
    assert.equal(run.status, 'requires_action');
    assert.equal(run.checkpoint.suspension, undefined, 'waiting in process, not parked');
    assert.deepEqual(run.checkpoint.bridge?.delivered, 0);
    const awaiting = s.store.history(runId).filter((e) => e.type === 'run.awaiting_caller');
    assert.deepEqual(
      awaiting.map((e) => e.data),
      [{ approval_ids: [call.id] }],
    );

    // 交给智能体的 mcpServers：一个 stdio 条目，服务名 oaa-caller，命令是 oaa mcp-relay。
    const lines = await fixtureLog(s, runId);
    const [server] = JSON.parse(lines.find((l) => l.startsWith('session/new:'))!.slice(12));
    assert.equal(server.name, 'oaa-caller');
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args.slice(1, 3), ['mcp-relay', '--socket']);
    assert.equal(server.args[4], '--token-file');
    assert.deepEqual(server.env, []);
    if (process.platform === 'win32') {
      // Windows: a named pipe (no file, no mode bits); the token file is what authenticates.
      assert.match(server.args[3], /^\\\\\.\\pipe\\oaa-relay-[0-9a-f]{32}$/);
    } else {
      assert.equal(statSync(server.args[3]).mode & 0o777, 0o600, 'socket 0600');
      assert.equal(statSync(server.args[5]).mode & 0o777, 0o600, 'token 0600');
      assert.equal(statSync(path.dirname(server.args[3])).mode & 0o777, 0o700, 'dir 0700');
    }
    const tools = JSON.parse(lines.find((l) => l.startsWith('tools:'))!.slice(6));
    assert.deepEqual(tools, [
      { name: 'edit-file', description: 'Edit a file.', inputSchema: EDIT_SCHEMA },
      { name: 'lint', inputSchema: { type: 'object', properties: {} } },
    ]);

    const second = await chat(s, {
      messages: [user('x'), assistantCalls([call]), toolMessage(call.id, 'patched')],
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.headers['x-run-id'], runId, 'same run continues');
    assert.equal(second.json().choices[0].finish_reason, 'stop');
    assert.equal(second.json().choices[0].message.content, 'Results: edit-file=patched');
    const final = s.store.run(runId);
    assert.equal(final.status, 'completed');
    const step = s.store.steps(runId).find((x) => x.name === 'edit-file')!;
    assert.deepEqual(
      [step.status, step.effect, step.result?.value],
      ['completed', 'unknown', 'patched'],
    );
    assert.equal(s.store.approvals(runId)[0]!.status, 'approved');
    const sequence = 'created in_progress progress queued requires_action awaiting_caller resolved';
    assert.deepEqual(
      eventTypes(s, runId).map((t) => t.split('.').pop()),
      [
        ...sequence.split(' '),
        'completed',
        'added',
        'added',
        'delta',
        'done',
        'done',
        'done',
        'completed',
      ],
    );
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: parallel calls are announced once; sequential calls come one reply at a time', async () => {
  const s = await acpSetup();
  try {
    const first = await chat(s, { messages: [user(script([[edit(), lint]]))] });
    const runId = first.headers['x-run-id'] as string;
    const calls = first.json().choices[0].message.tool_calls;
    assert.deepEqual(calls.map((c: { function: { name: string } }) => c.function.name).sort(), [
      'edit-file',
      'lint',
    ]);
    const awaiting = s.store.history(runId).filter((e) => e.type === 'run.awaiting_caller');
    assert.equal(awaiting.length, 1, 'one announcement for calls that arrived together');
    assert.equal((awaiting[0]!.data.approval_ids as string[]).length, 2);
    const done = await chat(s, {
      messages: [
        user('x'),
        assistantCalls(calls),
        ...calls.map((c: { id: string; function: { name: string } }) =>
          toolMessage(c.id, `ok-${c.function.name}`),
        ),
      ],
    });
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(
      done.json().choices[0].message.content,
      'Results: edit-file=ok-edit-file; lint=ok-lint',
    );
    await assertClean(s, runId);

    const seq = await chat(s, { messages: [user(script([[edit('b.ts')], [lint]]))] });
    const seqRun = seq.headers['x-run-id'] as string;
    const [a] = seq.json().choices[0].message.tool_calls;
    assert.equal(a.function.name, 'edit-file');
    const next = await chat(s, {
      messages: [user('x'), assistantCalls([a]), toolMessage(a.id, 'one')],
    });
    assert.equal(next.headers['x-run-id'], seqRun);
    assert.equal(next.json().choices[0].finish_reason, 'tool_calls');
    const [b] = next.json().choices[0].message.tool_calls;
    assert.equal(b.function.name, 'lint');
    const last = await chat(s, {
      messages: [user('x'), assistantCalls([b]), toolMessage(b.id, 'two')],
    });
    assert.equal(last.json().choices[0].message.content, 'Results: edit-file=one; lint=two');
    assert.equal(s.store.allRuns().length, 2);
    await assertClean(s, seqRun);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: streamed Chat hands off with tool_calls frames and resumes with text', async () => {
  const s = await acpSetup();
  try {
    const first = await chat(s, {
      stream: true,
      messages: [user(script([[edit()]], { before: 'Working.' }))],
    });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const one = frames(first.body);
    const call = one[2].choices[0].delta.tool_calls[0];
    assert.match(call.id, /^call_/);
    assert.deepEqual(
      one.map((f) => (f === '[DONE]' ? f : [f.choices[0].delta, f.choices[0].finish_reason])),
      [
        [{ role: 'assistant', content: '' }, null],
        [{ content: 'Working.' }, null],
        [
          {
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: 'function',
                function: { name: 'edit-file', arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          null,
        ],
        [{}, 'tool_calls'],
        '[DONE]',
      ],
    );
    const second = await chat(s, {
      stream: true,
      messages: [user('x'), assistantCalls([call]), toolMessage(call.id, 'patched')],
    });
    assert.equal(second.headers['x-run-id'], runId);
    assert.deepEqual(
      frames(second.body).map((f) =>
        f === '[DONE]' ? f : [f.choices[0].delta, f.choices[0].finish_reason],
      ),
      [
        [{ role: 'assistant', content: '' }, null],
        [{ content: 'Results: edit-file=patched' }, null],
        [{}, 'stop'],
        '[DONE]',
      ],
    );
    assert.deepEqual(
      s.store.run(runId).output.map((m) => m.text),
      ['Working.', 'Results: edit-file=patched'],
    );
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: Responses and Claude Messages each hand off and continue', async () => {
  const s = await acpSetup();
  try {
    const respTools = [{ type: 'function', name: 'edit-file', parameters: EDIT_SCHEMA }];
    const r1 = await post(s, '/v1/compat/responses', {
      tools: respTools,
      input: script([[edit()]]),
    });
    assert.equal(r1.statusCode, 200, r1.body);
    const runId = r1.headers['x-run-id'] as string;
    assert.equal(r1.json().metadata['oaa.status'], 'requires_action');
    const fc = r1.json().output.find((o: { type: string }) => o.type === 'function_call');
    assert.deepEqual([fc.name, fc.arguments], ['edit-file', '{"path":"a.ts"}']);
    const r2 = await post(s, '/v1/compat/responses', {
      tools: respTools,
      previous_response_id: runId,
      input: [{ type: 'function_call_output', call_id: fc.call_id, output: 'R' }],
    });
    assert.equal(r2.headers['x-run-id'], runId);
    assert.deepEqual(
      r2.json().output.map((o: { content: { text: string }[] }) => o.content[0]!.text),
      ['Results: edit-file=R'],
    );
    await assertClean(s, runId);

    const claudeTools = [{ name: 'edit-file', input_schema: EDIT_SCHEMA }];
    const c1 = await post(s, '/v1/compat/messages', {
      max_tokens: 256,
      tools: claudeTools,
      messages: [user(script([[edit()]]))],
    });
    assert.equal(c1.statusCode, 200, c1.body);
    const claudeRun = c1.headers['x-run-id'] as string;
    assert.equal(c1.json().stop_reason, 'tool_use');
    const use = c1.json().content.find((b: { type: string }) => b.type === 'tool_use');
    assert.deepEqual([use.name, use.input], ['edit-file', { path: 'a.ts' }]);
    const c2 = await post(s, '/v1/compat/messages', {
      max_tokens: 256,
      tools: claudeTools,
      messages: [
        user('x'),
        { role: 'assistant', content: [use] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'C' }] },
      ],
    });
    assert.equal(c2.headers['x-run-id'], claudeRun);
    assert.equal(c2.json().stop_reason, 'end_turn');
    assert.equal(c2.json().content[0].text, 'Results: edit-file=C');
    await assertClean(s, claudeRun);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: a timeout or a cancel ends the run and stops the agent and the relay', async () => {
  for (const mode of ['timeout', 'cancel'] as const) {
    const s = await acpSetup(mode === 'timeout' ? { approvalTimeoutMs: 1_500 } : {});
    try {
      const first = await chat(s, { messages: [user(script([[edit()]]))] });
      const runId = first.headers['x-run-id'] as string;
      assert.equal(first.json().choices[0].finish_reason, 'tool_calls');
      if (mode === 'cancel')
        assert.equal((await s.request('POST', `/v1/responses/${runId}/cancel`)).statusCode, 200);
      const final = await s.kernel.wait(runId);
      if (mode === 'timeout')
        assert.deepEqual([final.status, final.error?.code], ['failed', 'client_tool_timeout']);
      else assert.equal(final.status, 'interrupted');
      assert.equal(s.store.approvals(runId)[0]!.status, 'expired');
      if (mode === 'cancel')
        await waitFor(async () => (await fixtureLog(s, runId)).includes('cancel-acknowledged'));
      await assertClean(s, runId);
    } finally {
      await s.cleanup();
    }
  }
});

test('acp bridge: another caller cannot continue; a repeated reply reattaches to the same run', async () => {
  const s = await acpSetup();
  try {
    const first = await chat(s, { messages: [user(script([[edit()]]))] });
    const runId = first.headers['x-run-id'] as string;
    const [call] = first.json().choices[0].message.tool_calls;
    const other = {
      name: 'other',
      owner: 'owner',
      keyId: 'key_other',
      agents: ['*'],
      scopes: ['invoke', 'read'],
    };
    assert.equal(
      s.kernel.resolveClientTools(other, [{ call_id: call.id, output: 'stolen' }]),
      undefined,
    );
    assert.equal(s.store.getApproval(call.id, 'owner').status, 'pending');
    const reply = { messages: [user('x'), assistantCalls([call]), toolMessage(call.id, 'ok')] };
    const done = await chat(s, reply);
    assert.equal(done.json().choices[0].message.content, 'Results: edit-file=ok');
    const again = await chat(s, reply);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.headers['x-run-id'], runId, 'the retry reattaches');
    assert.equal(again.json().choices[0].message.content, 'Results: edit-file=ok');
    assert.equal(s.store.allRuns().length, 1);
    assert.equal(s.store.steps(runId).find((x) => x.name === 'edit-file')!.result?.value, 'ok');
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: invalid arguments and unknown names return isError to the agent', async () => {
  const s = await acpSetup();
  try {
    const r = await chat(s, {
      messages: [
        user(script([[{ name: 'edit-file', arguments: { path: 7 } }], [{ name: 'nope' }]])),
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    const runId = r.headers['x-run-id'] as string;
    assert.equal(r.json().choices[0].finish_reason, 'stop');
    const text = r.json().choices[0].message.content as string;
    assert.match(text, /edit-file=ERROR\(invalid_arguments/);
    assert.match(text, /nope=ERROR\(Unknown caller tool 'nope'/);
    assert.equal(s.store.run(runId).status, 'completed');
    assert.equal(s.store.approvals(runId).length, 0, 'no pending action was created');
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: without tools or without bridge the agent still gets mcpServers: []', async () => {
  const s = await acpSetup();
  try {
    const plain = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      { model: 'agent/caller', messages: [user('hello')] },
      token,
      BRIDGE,
    );
    const managed = await chat(s, { messages: [user(script([[edit()]]))] }, {});
    assert.equal(managed.headers['x-oaa-client-tools'], 'ignored');
    for (const r of [plain, managed]) {
      assert.equal(r.statusCode, 200, r.body);
      const runId = r.headers['x-run-id'] as string;
      assert.equal(r.json().choices[0].message.content, 'No caller tools.');
      assert.equal(s.store.run(runId).checkpoint.bridge, undefined);
      assert.ok((await fixtureLog(s, runId)).includes('session/new:[]'));
    }
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: a gateway shutdown interrupts the waiting run instead of keeping it parked', async () => {
  const s = await acpSetup();
  try {
    const first = await chat(s, { messages: [user(script([[edit()]]))] });
    const runId = first.headers['x-run-id'] as string;
    assert.equal(s.store.awaitingCaller(runId), true);
    assert.equal(s.store.run(runId).checkpoint.suspension, undefined);
    await s.kernel.close();
    const run = s.store.run(runId);
    assert.equal(run.status, 'interrupted');
    assert.equal(s.store.approvals(runId)[0]!.status, 'expired');
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: recovery after a crash interrupts a run that was waiting in process', async () => {
  const s = await acpSetup();
  try {
    const first = await chat(s, { messages: [user(script([[edit()]]))] });
    const runId = first.headers['x-run-id'] as string;
    assert.equal(s.store.awaitingCaller(runId), true);
    // 网关崩溃后重启时 store.recover() 读到的就是这个状态：没有 suspension，不能当作停车保留。
    s.store.recover();
    assert.equal(s.store.run(runId).status, 'interrupted');
    assert.equal(s.store.run(runId).error?.code, 'gateway_restarted');
    assert.equal(s.store.approvals(runId)[0]!.status, 'expired');
    await s.kernel.close();
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: workers that did not declare client-tools-v1 never receive caller tools', async () => {
  const s = await acpSetup();
  try {
    const original = s.runtime.advertisement.bind(s.runtime);
    s.runtime.advertisement = () => {
      const a = original();
      delete a.execution!.clientTools;
      return a;
    };
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/kernel', tools: [builtin('list_files')] })),
    );
    for (const model of ['agent/caller', 'agent/kernel']) {
      const r = await chat(s, { model, messages: [user(script([[edit()]]))] });
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error.code, 'client_tools_bridge_unsupported', model);
    }
    assert.equal(s.store.allRuns().length, 0);

    // 远端执行机器：网关没有提供 client-tools-v1 时不发送 clientTools 声明。
    const full = original().execution!;
    assert.ok(full.clientTools?.native.includes('adapter/caller'));
    assert.ok(full.clientTools?.native.includes('kernel'));
    const negotiated = { byok: true, sandbox: true, providerState: true };
    assert.equal(advertisedExecution(full, negotiated)!.clientTools, undefined);
    assert.deepEqual(
      advertisedExecution(full, { ...negotiated, clientTools: true })!.clientTools,
      full.clientTools,
    );
    // 放置：带 clientTools 的任务不会放到没有声明的执行机器上。
    const acp = agent({ id: 'agent/caller', engine: 'adapter/caller', model: 'default' });
    const node = {
      credential: { nodeId: 'old', owner: 'owner', token: 't', capabilities: ['*'], agents: ['*'] },
      advertisement: {
        ...original(),
        nodeId: 'old',
        execution: { ...full, clientTools: undefined },
      },
    };
    const work = {
      kind: 'native' as const,
      agent: acp,
      input: 'x',
      context: { runId: 'r', sessionId: 's', owner: 'owner', digest: 'd', files: [] },
      clientTools: [{ name: 'lint', parameters: { type: 'object' } }],
    };
    assert.ok(workPlacement(work, acp, node).some((r) => r.code === 'client_tools_unsupported'));
    const { clientTools: _drop, ...plainWork } = work;
    assert.ok(
      !workPlacement(plainWork, acp, node).some((r) => r.code === 'client_tools_unsupported'),
    );

    assert.ok(GATEWAY_FEATURES.includes('harness-bridge-acp-v1'));
    assert.equal(conversionProfile('adapter/caller', s.runtime.config).client_tools, 'bridge');
  } finally {
    await s.cleanup();
  }
});

test('mcp-relay: a wrong token cannot connect; close() removes the socket and token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-relay-test-'));
  try {
    const events: WorkEvent[] = [];
    const relay = await openCallerRelay(
      dir,
      [{ name: 'lint', parameters: { type: 'object' } }],
      async (event) => {
        events.push(event);
        return { output: 'x' };
      },
    );
    const [cli, , , socketPath, , tokenPath] = relay.server.args as [string, ...string[]];
    const wrong = path.join(dir, 'wrong-token');
    await writeFile(wrong, 'not-the-token');
    const child = spawn(
      process.execPath,
      [cli, 'mcp-relay', '--socket', socketPath!, '--token-file', wrong],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.notEqual(code, 0);
    assert.equal(stdout, '', 'nothing on the protocol channel');
    assert.equal(events.length, 0);
    assert.ok(existsSync(socketPath!) && existsSync(tokenPath!));
    await relay.close();
    assert.equal(existsSync(socketPath!), false);
    assert.equal(existsSync(tokenPath!), false);
    assert.equal(existsSync(relay.dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('acp bridge: a permission request for a relay tool is allowed without an owner approval', async () => {
  const s = await acpSetup();
  try {
    const permission = { title: 'Run mcp_oaa-caller_<name>' };
    const first = await chat(s, { messages: [user(script([[edit()]], { permission }))] });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    assert.equal(first.json().choices[0].finish_reason, 'tool_calls');
    const approvals = s.store.approvals(runId);
    assert.deepEqual(
      approvals.map((a) => a.kind),
      ['client_tool'],
      'no owner approval for a caller tool',
    );
    const progress = s.store
      .history(runId)
      .filter((e) => e.type === 'tool.progress' && e.data.event === 'permission_auto_allowed');
    assert.equal(progress.length, 1);
    assert.equal(progress[0]!.data.tool, 'edit-file');
    const [call] = first.json().choices[0].message.tool_calls;
    const second = await chat(s, {
      messages: [user('x'), assistantCalls([call]), toolMessage(call.id, 'patched')],
    });
    assert.equal(second.json().choices[0].message.content, 'Results: edit-file=patched');
    assert.ok(
      (await fixtureLog(s, runId)).includes(
        'permission:edit-file:{"outcome":"selected","optionId":"allow"}',
      ),
    );
    await assertClean(s, runId);
  } finally {
    await s.cleanup();
  }
});

test('acp bridge: a permission request without the relay name still goes to the owner', async () => {
  const s = await acpSetup({ approvalTimeoutMs: 1_500 });
  try {
    const permission = { title: 'Run <name>' };
    const first = await chat(s, { messages: [user(script([[edit()]], { permission }))] });
    const runId = first.headers['x-run-id'] as string;
    await waitFor(() => s.store.approvals(runId).length > 0, 10_000);
    const approvals = s.store.approvals(runId);
    assert.deepEqual(
      approvals.map((a) => a.kind),
      ['native'],
      first.body,
    );
    assert.ok(
      !s.store.history(runId).some((e) => e.data?.event === 'permission_auto_allowed'),
      'not auto-allowed',
    );
    await s.request('POST', `/v1/responses/${runId}/cancel`);
    await s.kernel.wait(runId);
  } finally {
    await s.cleanup();
  }
});

test('callerToolPermission: only relay-provided tools in a bridged turn are recognised', () => {
  const tools = ['get_secret_number', 'edit-file'];
  const call = (title: string, rawInput: unknown = { reason: 'x' }) => ({
    toolCallId: 't1',
    title,
    kind: 'other',
    rawInput,
  });
  const cases: [string, unknown, string[], string | null][] = [
    ['Qoder 标题', call('get_secret_number (oaa-caller)'), tools, 'get_secret_number'],
    ['mcp_ 前缀标题', call('Run mcp_oaa-caller_get_secret_number'), tools, 'get_secret_number'],
    ['服务名大写', call('Run MCP_OAA-CALLER_edit-file'), tools, 'edit-file'],
    [
      '服务名只在 rawInput',
      call('get_secret_number', { server: 'oaa-caller', tool: 'get_secret_number' }),
      tools,
      'get_secret_number',
    ],
    ['只有工具名没有服务名', call('get_secret_number'), tools, null],
    ['有服务名但工具不在清单', call('rm_rf (oaa-caller)'), tools, null],
    ['工具名只是某个词的一部分', call('get_secret_number_v2 (oaa-caller)'), tools, null],
    ['非桥接回合', call('get_secret_number (oaa-caller)'), [], null],
    ['没有标题', { toolCallId: 't1', rawInput: { server: 'oaa-caller' } }, tools, null],
  ];
  for (const [label, toolCall, names, expected] of cases)
    assert.equal(callerToolPermission(toolCall, names), expected, label);
});

/**
 * 计时器比墙上时钟早到（`setTimeout` 走单调时钟，`Date.now()` 走墙上时钟，二者相差约 1 ms
 * 就会出现，墙上时钟被校时往回拨时更多）：等待不能就此停住，要重新计时到真正过期。这里把
 * `Date.now()` 在临到期前往回拨 400 ms，让计时器必然「早到」。修正前运行一直挂着，直到假智能体自己的
 * 600 秒 MCP 调用超时后以 completed 结束。
 */
test('acp bridge: a timer firing before the wall-clock deadline still times out', async () => {
  for (const permission of [undefined, { title: 'Run <name>' }]) {
    const s = await acpSetup({ approvalTimeoutMs: 1_000 });
    const realNow = Date.now;
    try {
      const extra = permission ? { permission } : {};
      // 权限请求不交给调用方，请求要等到运行结束才返回：不等它，直接从存储里找运行。
      const first = chat(s, { messages: [user(script([[edit()]], extra))] });
      await waitFor(() => s.store.allRuns().some((r) => s.store.approvals(r.id).length), 10_000);
      const runId = s.store.allRuns()[0]!.id;
      // 等待早已开始计时；临到期前把时钟往回拨，计时器按原定时刻触发时就比 `Date.now()` 早。
      const { expiresAt } = s.store.approvals(runId)[0]!;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - realNow() - 200)));
      Date.now = () => realNow() - 400;
      const final = await Promise.race([
        s.kernel.wait(runId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the wait never ended')), 8_000).unref(),
        ),
      ]);
      Date.now = realNow;
      await first;
      const code = permission ? 'approval_expired' : 'client_tool_timeout';
      assert.deepEqual([final.status, final.error?.code], ['failed', code]);
      assert.equal(s.store.approvals(runId)[0]!.status, 'expired');
    } finally {
      Date.now = realNow;
      await s.cleanup();
    }
  }
});
