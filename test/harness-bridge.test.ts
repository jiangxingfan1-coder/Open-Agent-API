import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from '../src/core/contracts.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { agent, FixtureModel, setup, token, waitFor } from './helpers.js';

// 桥接（docs/harness.md）：内核智能体 × Chat Completions。全部离线：Fastify inject，确定性模型替身。

type Fixture = Awaited<ReturnType<typeof setup>>;
const BRIDGE = { 'x-oaa-client-tools': 'bridge' };
const EDIT = {
  type: 'function',
  function: {
    name: 'edit-file',
    description: 'Edit a file in the caller workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};
const LINT = {
  type: 'function',
  function: { name: 'lint', parameters: { type: 'object', properties: {} } },
};
const USER = { role: 'user', content: 'Fix the bug.' };
const toolResults = (messages: ModelMessage[]) => messages.filter((m) => m.role === 'tool');

/** 第一轮调用 edit_file（别名），看到工具结果后结束。 */
function editModel() {
  return new FixtureModel((_a, messages) => {
    const results = toolResults(messages);
    if (!results.length)
      return {
        text: 'Editing.',
        calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }],
      };
    return { text: `Done: ${results.map((r) => r.content).join(',')}` };
  });
}
function publish(s: Fixture, tools = [builtin('list_files')]) {
  s.store.publish('owner', makeBundle(agent({ id: 'agent/bridge', tools })));
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
    { model: 'agent/bridge', tools: [EDIT], ...body },
    key,
    headers,
  );
const toolMessage = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });
const assistantCalls = (calls: { id: string }[]) => ({
  role: 'assistant',
  content: null,
  tool_calls: calls,
});
const frames = (body: string) =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map((f) => {
      assert.ok(f.startsWith('data: '), f);
      const data = f.slice(6);
      return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
    });

test('bridge: single call parks, returns tool_calls, and the same run continues', async () => {
  const seen: string[][] = [];
  const model = editModel();
  const inner = model.respond;
  (model as { respond: typeof inner }).respond = (a, m, s) => {
    seen.push(a.tools.map((t) => t.name));
    return inner(a, m, s);
  };
  const s = await setup(model);
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const body = first.json();
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.content, 'Editing.');
    const [call] = body.choices[0].message.tool_calls;
    assert.match(call.id, /^call_/);
    assert.deepEqual(call.type, 'function');
    assert.deepEqual(call.function, { name: 'edit-file', arguments: '{"path":"a.ts"}' });
    assert.deepEqual(seen[0], ['list_files', 'edit_file'], 'model sees published + caller tools');
    assert.equal(s.store.run(runId).status, 'requires_action');

    const second = await chat(s, {
      messages: [USER, assistantCalls([call]), toolMessage(call.id, 'patched')],
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.headers['x-run-id'], runId, 'same run continues');
    assert.equal(second.json().choices[0].finish_reason, 'stop');
    assert.equal(second.json().choices[0].message.content, 'Done: patched');
    const step = s.store.steps(runId).find((x) => x.name === 'edit-file')!;
    assert.equal(step.status, 'completed');
    assert.equal(step.effect, 'unknown');
    assert.equal(step.result?.value, 'patched');
    assert.equal(s.store.run(runId).status, 'completed');
    assert.equal(s.store.allRuns().length, 1);
  } finally {
    await s.cleanup();
  }
});

test('bridge: failure on the second result rolls back the entire submitted batch and its cursor', async () => {
  const s = await setup(
    new FixtureModel((_a, m) =>
      toolResults(m).length
        ? { text: 'done' }
        : {
            text: 'waiting',
            calls: [
              { id: 'a', name: 'edit_file', arguments: { path: 'a.ts' } },
              { id: 'b', name: 'lint', arguments: {} },
            ],
          },
    ),
  );
  try {
    publish(s);
    const first = await chat(s, { messages: [USER], tools: [EDIT, LINT] });
    const runId = String(first.headers['x-run-id']),
      calls = first.json().choices[0].message.tool_calls;
    await waitFor(() => s.store.run(runId).checkpoint.suspension?.kind === 'approval');
    const before = s.store.run(runId).checkpoint.bridge!.delivered;
    s.store.db.exec(`CREATE TEMP TRIGGER fail_second BEFORE UPDATE OF payload ON approvals WHEN
      json_extract(NEW.payload,'$.detail.tool')='lint' AND json_extract(NEW.payload,'$.status')='approved'
      BEGIN SELECT RAISE(ABORT,'second result unavailable'); END`);
    const reply = () =>
      chat(s, {
        tools: [EDIT, LINT],
        messages: [
          USER,
          assistantCalls(calls),
          toolMessage(calls[0].id, 'one'),
          toolMessage(calls[1].id, 'two'),
        ],
      });
    assert.equal((await reply()).statusCode, 500);
    assert.deepEqual(
      s.store.approvals(runId).map((a) => a.status),
      ['pending', 'pending'],
    );
    assert.equal(s.store.run(runId).checkpoint.bridge!.delivered, before);
    assert.equal(s.store.history(runId).filter((e) => e.type === 'approval.resolved').length, 0);
    s.store.db.exec('DROP TRIGGER fail_second');
    const done = await reply();
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(s.store.history(runId).filter((e) => e.type === 'approval.resolved').length, 2);
    assert.equal(s.driver.calls, 2);
  } finally {
    await s.cleanup();
  }
});

test('bridge: two parallel calls are returned together; a partial reply parks again', async () => {
  const model = new FixtureModel((_a, messages) => {
    if (!toolResults(messages).length)
      return {
        calls: [
          { id: 'a', name: 'edit_file', arguments: { path: 'a.ts' } },
          { id: 'b', name: 'lint', arguments: {} },
        ],
      };
    return {
      text: `R:${toolResults(messages)
        .map((m) => m.content)
        .join('|')}`,
    };
  });
  const s = await setup(model);
  try {
    publish(s);
    const first = await chat(s, { messages: [USER], tools: [EDIT, LINT] });
    const calls = first.json().choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    assert.equal(first.json().choices[0].message.content, null);
    assert.deepEqual(
      calls.map((c: { function: { name: string } }) => c.function.name),
      ['edit-file', 'lint'],
    );
    const runId = first.headers['x-run-id'];
    const partial = await chat(s, {
      tools: [EDIT, LINT],
      messages: [USER, assistantCalls(calls), toolMessage(calls[0].id, 'one')],
    });
    assert.equal(partial.headers['x-run-id'], runId);
    assert.equal(partial.json().choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(
      partial.json().choices[0].message.tool_calls.map((c: { id: string }) => c.id),
      [calls[1].id],
    );
    assert.equal(partial.json().choices[0].message.content, null);
    const done = await chat(s, {
      tools: [EDIT, LINT],
      messages: [
        USER,
        assistantCalls(calls),
        toolMessage(calls[0].id, 'one'),
        assistantCalls([calls[1]]),
        toolMessage(calls[1].id, 'two'),
      ],
    });
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(done.json().choices[0].message.content, 'R:one|two');
    assert.equal(model.calls, 2, 'the model ran once per turn');
  } finally {
    await s.cleanup();
  }
});

test('bridge: streaming emits tool_calls frames, then resumes from the cursor', async () => {
  const model = new FixtureModel((_a, messages) =>
    toolResults(messages).length
      ? { text: 'All done.' }
      : { calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }] },
  );
  const s = await setup(model);
  try {
    publish(s);
    const first = await chat(s, {
      messages: [USER],
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(first.statusCode, 200);
    const runId = first.headers['x-run-id'] as string;
    const callId = s.store.approvals(runId)[0]!.id;
    const base = {
      id: `chatcmpl_${runId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(s.store.run(runId).createdAt / 1000),
      model: 'agent/bridge',
      usage: null,
    };
    assert.deepEqual(frames(first.body), [
      {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: { name: 'edit-file', arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      {
        ...base,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      '[DONE]',
    ]);

    const second = await chat(s, {
      stream: true,
      messages: [USER, assistantCalls([{ id: callId }]), toolMessage(callId, 'ok')],
    });
    assert.equal(second.headers['x-run-id'], runId);
    const next = frames(second.body);
    const { usage: _usage, ...plainBase } = base;
    assert.deepEqual(next[0], {
      ...plainBase,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    const text = next
      .slice(1, -2)
      .map((f: { choices: { delta: { content: string } }[] }) => f.choices[0]!.delta.content)
      .join('');
    assert.equal(text, 'All done.', 'no replay of earlier output');
    assert.deepEqual(next.at(-2).choices[0].finish_reason, 'stop');
    assert.equal(next.at(-1), '[DONE]');
  } finally {
    await s.cleanup();
  }
});

test('bridge: published tools run in the gateway while caller tools park', async () => {
  const model = new FixtureModel((_a, messages) =>
    toolResults(messages).length > 1
      ? { text: 'ok' }
      : {
          calls: [
            { id: 'ls', name: 'list_files', arguments: {} },
            { id: 'ed', name: 'edit_file', arguments: { path: 'b' } },
          ],
        },
  );
  const s = await setup(model);
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    const runId = first.headers['x-run-id'] as string;
    const calls = first.json().choices[0].message.tool_calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'edit-file');
    const ls = s.store.steps(runId).find((x) => x.name === 'list_files')!;
    assert.equal(ls.status, 'completed');
    const done = await chat(s, {
      messages: [USER, assistantCalls(calls), toolMessage(calls[0].id, 'x')],
    });
    assert.equal(done.json().choices[0].message.content, 'ok');
    assert.equal(s.store.steps(runId).filter((x) => x.name === 'list_files').length, 1);
  } finally {
    await s.cleanup();
  }
});

test('bridge: unknown or foreign call ids fall back to a new request and leave the run parked', async () => {
  const s = await setup(editModel());
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    const runId = first.headers['x-run-id'] as string;
    const call = first.json().choices[0].message.tool_calls[0];

    const unknown = await chat(s, {
      messages: [USER, assistantCalls([{ id: 'call_nope' }]), toolMessage('call_nope', 'x')],
    });
    assert.equal(unknown.statusCode, 200, unknown.body);
    assert.notEqual(unknown.headers['x-run-id'], runId, 'a new run');

    // 同一 owner、另一个数据分区的调用方拿到 call_id 也续不上。
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
    // 另一个 owner 的密钥：同样不处理（这里该 owner 没有这个智能体，按新请求报错）。
    const foreign = await chat(
      s,
      { messages: [USER, assistantCalls([call]), toolMessage(call.id, 'stolen')] },
      BRIDGE,
      'test-second-owner-key-not-a-provider-key-000001',
    );
    assert.notEqual(foreign.headers['x-run-id'], runId);
    // 混入一个不认识的 ID：整体不处理。
    assert.equal(
      s.kernel.resolveClientTools(
        { ...other, name: 'test', keyId: undefined, scopes: ['admin', 'invoke'] },
        [
          { call_id: call.id, output: 'a' },
          { call_id: 'call_missing', output: 'b' },
        ],
      ),
      undefined,
    );
    assert.equal(s.store.run(runId).status, 'requires_action');
    assert.equal(s.store.getApproval(call.id, 'owner').status, 'pending');
  } finally {
    await s.cleanup();
  }
});

test('bridge: a retried result reattaches to the same run without rewriting it', async () => {
  const s = await setup(editModel());
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    const runId = first.headers['x-run-id'];
    const call = first.json().choices[0].message.tool_calls[0];
    const reply = { messages: [USER, assistantCalls([call]), toolMessage(call.id, 'v1')] };
    const a = await chat(s, reply);
    const b = await chat(s, {
      messages: [USER, assistantCalls([call]), toolMessage(call.id, 'v2')],
    });
    assert.equal(a.headers['x-run-id'], runId);
    assert.equal(b.headers['x-run-id'], runId);
    assert.equal(b.json().choices[0].message.content, a.json().choices[0].message.content);
    assert.equal(s.store.getApproval(call.id, 'owner').response?.output, 'v1');
    assert.equal(s.store.allRuns().length, 1);
  } finally {
    await s.cleanup();
  }
});

test('bridge: invalid caller-tool arguments go back to the model instead of failing the run', async () => {
  const model = new FixtureModel((_a, messages) => {
    const results = toolResults(messages);
    if (!results.length) return { calls: [{ id: 'bad', name: 'edit_file', arguments: {} }] };
    const last = JSON.parse(results.at(-1)!.content) as { error?: string };
    assert.equal(last.error, 'invalid_arguments');
    return { calls: [{ id: 'good', name: 'edit_file', arguments: { path: 'x' } }] };
  });
  const s = await setup(model);
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    assert.equal(first.statusCode, 200, first.body);
    const calls = first.json().choices[0].message.tool_calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.arguments, '{"path":"x"}');
  } finally {
    await s.cleanup();
  }
});

test('bridge: caller-tool actions are not human approvals', async () => {
  const s = await setup(editModel());
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    const runId = first.headers['x-run-id'] as string;
    const call = first.json().choices[0].message.tool_calls[0];
    const decide = await s.request('POST', `/v1/runs/${runId}/actions/${call.id}`, {
      decision: 'approve',
    });
    assert.equal(decide.statusCode, 409);
    assert.equal(decide.json().error.code, 'action_kind_mismatch');
    const actions = (await s.request('GET', `/v1/runs/${runId}/actions`)).json();
    assert.equal(actions.data[0].kind, 'client_tool');
    const overview = (await s.request('GET', '/v1/overview')).json();
    assert.equal(overview.metrics.requires_action, 0, 'not counted as needing a human');
    assert.equal(overview.metrics.awaiting_caller, 1);
    assert.equal(
      overview.metrics.queued + overview.metrics.in_progress + overview.metrics.requires_action,
      overview.metrics.active,
    );
    const timeline = (await s.request('GET', `/v1/runs/${runId}/timeline`)).json();
    const span = timeline.spans.find((x: { kind: string }) => x.kind === 'client_tool');
    assert.ok(span, JSON.stringify(timeline.spans.map((x: { kind: string }) => x.kind)));
    assert.ok(!timeline.spans.some((x: { kind: string }) => x.kind === 'approval'));
  } finally {
    await s.cleanup();
  }
});

test('bridge: an unanswered call times out with client_tool_timeout; a parked run can be cancelled', async () => {
  const s = await setup(editModel(), { approvalTimeoutMs: 400 });
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    const runId = first.headers['x-run-id'] as string;
    await waitFor(() => s.store.run(runId).status === 'failed', 3000);
    assert.equal(s.store.run(runId).error?.code, 'client_tool_timeout');
    const late = await chat(s, {
      messages: [USER, toolMessage(first.json().choices[0].message.tool_calls[0].id, 'late')],
    });
    assert.notEqual(late.headers['x-run-id'], runId, 'an expired call starts a new request');

    const parked = await chat(s, { messages: [USER] }, { 'x-oaa-client-tools': 'bridge' });
    const parkedId = parked.headers['x-run-id'] as string;
    const cancelled = await s.request('POST', `/v1/responses/${parkedId}/cancel`);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(s.store.run(parkedId).status, 'cancelled');
  } finally {
    await s.cleanup();
  }
});

test('bridge: a run parked on caller tools survives a gateway restart and continues', async () => {
  const s = await setup(editModel());
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    publish(s);
    const first = await chat(s, { messages: [USER] });
    const runId = first.headers['x-run-id'] as string;
    const call = first.json().choices[0].message.tool_calls[0];
    await s.app.close();
    const runtime = new WorkerRuntime(
      s.runtime.config,
      s.runtime.handlers,
      new Map([['fixture', editModel()]]),
    );
    replacement = await createGateway(s.config, runtime);
    await replacement.app.ready();
    replacement.kernel.start(); // listen() 里做的事；inject 不监听端口，这里显式调用
    assert.equal(replacement.store.run(runId).status, 'requires_action');
    const resumed = await replacement.app.inject({
      method: 'POST',
      url: '/v1/compat/chat/completions',
      headers: { authorization: `Bearer ${token}`, ...BRIDGE },
      payload: {
        model: 'agent/bridge',
        tools: [EDIT],
        messages: [USER, assistantCalls([call]), toolMessage(call.id, 'after')],
      },
    });
    assert.equal(
      resumed.statusCode,
      200,
      `${resumed.body} ${JSON.stringify(replacement.store.run(runId).checkpoint.suspension)} ${replacement.store.run(runId).status} ${JSON.stringify(replacement.store.approvals(runId))}`,
    );
    assert.equal(resumed.headers['x-run-id'], runId);
    assert.equal(resumed.json().choices[0].message.content, 'Done: after');
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('bridge: conflicts, limits, bad schemas and external agents are refused before execution', async () => {
  const s = await setup(editModel());
  try {
    publish(s);
    s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
    const many = Array.from({ length: 40 }, (_, i) => ({ ...builtin('read_file'), name: `r${i}` }));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/many', tools: many })));
    const fn = (name: string, parameters: unknown = { type: 'object' }) => ({
      type: 'function',
      function: { name, parameters },
    });
    const cases: [string, Record<string, unknown>, string][] = [
      ['conflict', { tools: [fn('list_files')] }, 'client_tool_conflict'],
      ['alias conflict', { tools: [fn('a-b'), fn('a_b')] }, 'client_tool_conflict'],
      ['graph', { tools: [fn('execute_graph')] }, 'client_tool_conflict'],
      [
        'too many',
        { model: 'agent/many', tools: Array.from({ length: 64 }, (_, i) => fn(`c${i}`)) },
        'client_tools_too_many',
      ],
      ['bad schema', { tools: [fn('x', { type: 'bogus' })] }, 'invalid_client_tool'],
      ['bad name', { tools: [fn('bad name')] }, 'invalid_client_tool'],
      ['external', { model: 'agent/native' }, 'client_tools_bridge_unsupported'],
    ];
    for (const [label, body, code] of cases) {
      const r = await chat(s, { messages: [USER], ...body });
      assert.equal(r.statusCode, 400, `${label}: ${r.body}`);
      assert.equal(r.json().error.code, code, label);
    }
    assert.equal(s.store.allRuns().length, 0, 'nothing was executed');
  } finally {
    await s.cleanup();
  }
});

test('bridge: requests without tools are unchanged', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'Plain.' })));
  try {
    publish(s);
    const r = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      { model: 'agent/bridge', messages: [USER] },
      token,
      BRIDGE,
    );
    const runId = r.headers['x-run-id'] as string;
    assert.equal(r.headers['x-oaa-client-tools'], undefined);
    assert.equal(
      r.body,
      JSON.stringify({
        id: `chatcmpl_${runId}`,
        object: 'chat.completion',
        created: Math.floor(s.store.run(runId).createdAt / 1000),
        model: 'agent/bridge',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Plain.', refusal: null },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    assert.equal(s.store.run(runId).checkpoint.bridge, undefined);
  } finally {
    await s.cleanup();
  }
});
