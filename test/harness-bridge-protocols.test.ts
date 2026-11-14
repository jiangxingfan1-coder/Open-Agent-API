import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from '../src/core/contracts.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { agent, FixtureModel, setup, token } from './helpers.js';

// 桥接扩展到 Responses 与 Claude Messages（docs/harness.md）。全部离线：inject + 确定性模型替身。

type Fixture = Awaited<ReturnType<typeof setup>>;
const BRIDGE = { 'x-oaa-client-tools': 'bridge' };
const SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const RESP_TOOLS = [
  { type: 'function', name: 'edit-file', description: 'Edit a file.', parameters: SCHEMA },
  { type: 'function', name: 'lint', parameters: { type: 'object' } },
];
const CLAUDE_TOOLS = [
  { name: 'edit-file', description: 'Edit a file.', input_schema: SCHEMA },
  { name: 'lint', input_schema: { type: 'object' } },
];
const tools = (messages: ModelMessage[]) => messages.filter((m) => m.role === 'tool');

/** 第一轮调用 edit_file（或并行两个），看到结果后以结果内容结束。 */
function model(parallel = false, text = 'Editing.') {
  return new FixtureModel((_a, messages) => {
    const results = tools(messages);
    if (!results.length)
      return {
        text,
        calls: [
          { id: 'a', name: 'edit_file', arguments: { path: 'a.ts' } },
          ...(parallel ? [{ id: 'b', name: 'lint', arguments: {} }] : []),
        ],
      };
    return { text: `R:${results.map((r) => r.content).join('|')}` };
  });
}
async function bridgeSetup(m: FixtureModel) {
  const s = await setup(m);
  s.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  return s;
}
const responses = (s: Fixture, body: Record<string, unknown>, headers = BRIDGE) =>
  s.request(
    'POST',
    '/v1/compat/responses',
    { model: 'agent/bridge', tools: RESP_TOOLS, ...body },
    token,
    headers,
  );
const claude = (
  s: Fixture,
  body: Record<string, unknown>,
  headers = BRIDGE,
  url = '/v1/compat/messages',
) =>
  s.request(
    'POST',
    url,
    { model: 'agent/bridge', max_tokens: 256, tools: CLAUDE_TOOLS, ...body },
    token,
    headers,
  );
const output = (call_id: string, value: string) => ({
  type: 'function_call_output',
  call_id,
  output: value,
});
const toolResult = (tool_use_id: string, content: unknown, is_error?: boolean) => ({
  type: 'tool_result',
  tool_use_id,
  content,
  ...(is_error ? { is_error } : {}),
});
const USER = { role: 'user', content: 'Fix the bug.' };
function sse(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const lines = Object.fromEntries(
        frame.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
      );
      return { event: lines.event, id: lines.id, data: JSON.parse(lines.data!) };
    });
}

test('responses bridge: single call, parked response, continuation on the same run', async () => {
  const s = await bridgeSetup(model());
  try {
    const first = await responses(s, { input: 'Fix the bug.' });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const body = first.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.metadata['oaa.status'], 'requires_action');
    assert.deepEqual(
      body.output.map((o: { type: string }) => o.type),
      ['message', 'function_call'],
    );
    assert.equal(body.output[0].content[0].text, 'Editing.');
    const call = body.output[1];
    assert.match(call.call_id, /^call_/);
    assert.deepEqual(
      { name: call.name, arguments: call.arguments, status: call.status },
      { name: 'edit-file', arguments: '{"path":"a.ts"}', status: 'completed' },
    );
    const done = await responses(s, {
      previous_response_id: runId,
      input: [output(call.call_id, 'patched')],
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(done.json().status, 'completed');
    assert.equal(done.json().metadata['oaa.status'], 'completed');
    assert.deepEqual(
      done.json().output.map((o: { content: { text: string }[] }) => o.content[0]!.text),
      ['R:patched'],
      'only output after the delivered point',
    );
  } finally {
    await s.cleanup();
  }
});

test('responses bridge: two parallel calls; a partial reply parks again', async () => {
  const s = await bridgeSetup(model(true, ''));
  try {
    const first = await responses(s, { input: 'Fix.' });
    const calls = first.json().output.filter((o: { type: string }) => o.type === 'function_call');
    assert.equal(calls.length, 2);
    assert.equal(first.json().output.length, 2, 'no empty message item');
    const runId = first.headers['x-run-id'];
    const partial = await responses(s, { input: [output(calls[0].call_id, '1')] });
    assert.equal(partial.headers['x-run-id'], runId);
    assert.deepEqual(
      partial.json().output.map((o: { call_id?: string }) => o.call_id),
      [calls[1].call_id],
    );
    const done = await responses(s, { input: [output(calls[1].call_id, '2')] });
    assert.equal(done.json().output[0].content[0].text, 'R:1|2');
  } finally {
    await s.cleanup();
  }
});

test('responses bridge: streaming frames and monotonic sequence numbers', async () => {
  const s = await bridgeSetup(model(false, ''));
  try {
    const first = await responses(s, { input: 'Fix.', stream: true });
    const frames = sse(first.body);
    const runId = first.headers['x-run-id'] as string;
    const callId = s.store.approvals(runId)[0]!.id;
    const tail = frames.slice(-5);
    assert.deepEqual(
      tail.map((f) => f.event),
      [
        'response.output_item.added',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.completed',
      ],
    );
    assert.deepEqual(tail[0]!.data.item, {
      type: 'function_call',
      id: `fc_${callId.slice(5)}`,
      call_id: callId,
      name: 'edit-file',
      arguments: '',
      status: 'in_progress',
    });
    assert.equal(tail[1]!.data.delta, '{"path":"a.ts"}');
    assert.equal(tail[2]!.data.arguments, '{"path":"a.ts"}');
    assert.equal(tail[3]!.data.item.status, 'completed');
    assert.equal(tail[4]!.data.response.metadata['oaa.status'], 'requires_action');
    assert.ok(
      !frames.some(
        (f) =>
          f.event === 'response.in_progress' &&
          f.data.response?.metadata?.['oaa.status'] === 'requires_action',
      ),
      'no synthetic in_progress frame for a caller action',
    );
    const seqs = frames.map((f) => f.data.sequence_number as number);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, String(seqs));
    assert.deepEqual(
      frames.map((f) => Number(f.id)),
      seqs,
    );

    const second = await responses(s, { input: [output(callId, 'ok')], stream: true });
    assert.equal(second.headers['x-run-id'], runId);
    const next = sse(second.body);
    assert.equal(next.at(-1)!.event, 'response.completed');
    assert.ok(!next.some((f) => f.event === 'response.created'), 'resumes after the cursor');
    const nextSeqs = next.map((f) => f.data.sequence_number as number);
    for (let i = 1; i < nextSeqs.length; i++) assert.ok(nextSeqs[i]! > nextSeqs[i - 1]!);
    const text = next
      .filter((f) => f.event === 'response.output_text.delta')
      .map((f) => f.data.delta)
      .join('');
    assert.equal(text, 'R:ok');
  } finally {
    await s.cleanup();
  }
});

test('responses bridge: unknown call ids, mismatched previous_response_id, non-function tools', async () => {
  const s = await bridgeSetup(model());
  try {
    const first = await responses(s, { input: 'Fix.' });
    const runId = first.headers['x-run-id'] as string;
    const callId = first.json().output[1].call_id;
    const unknown = await responses(s, { input: [output('call_nope', 'x')] });
    assert.notEqual(unknown.headers['x-run-id'], runId);
    const other = await responses(s, {
      previous_response_id: unknown.headers['x-run-id'],
      input: [output(callId, 'x')],
    });
    assert.notEqual(other.headers['x-run-id'], runId, 'previous_response_id is not that run');
    assert.equal(s.store.getApproval(callId, 'owner').status, 'pending');
    const builtinTool = await responses(s, { input: 'x', tools: [{ type: 'web_search' }] });
    assert.equal(builtinTool.statusCode, 400);
    assert.equal(builtinTool.json().error.code, 'client_tools_unsupported');
    const managed = await responses(s, { input: 'x', tools: [{ type: 'web_search' }] }, {
      'x-oaa-client-tools': 'managed',
    } as never);
    assert.equal(managed.statusCode, 200, 'managed still ignores built-in tools');
  } finally {
    await s.cleanup();
  }
});

test('claude bridge: single call, tool_use blocks, tool_result continuation', async () => {
  const s = await bridgeSetup(model());
  try {
    const first = await claude(s, { messages: [USER] });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const body = first.json();
    assert.equal(body.stop_reason, 'tool_use');
    assert.deepEqual(body.content[0], { type: 'text', text: 'Editing.' });
    const use = body.content[1];
    assert.deepEqual(
      { type: use.type, name: use.name, input: use.input },
      { type: 'tool_use', name: 'edit-file', input: { path: 'a.ts' } },
    );
    assert.match(use.id, /^call_/);
    const done = await claude(s, {
      messages: [
        USER,
        { role: 'assistant', content: body.content },
        { role: 'user', content: [toolResult(use.id, [{ type: 'text', text: 'patched' }])] },
      ],
    });
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(done.json().stop_reason, 'end_turn');
    assert.deepEqual(done.json().content, [{ type: 'text', text: 'R:patched' }]);
  } finally {
    await s.cleanup();
  }
});

test('claude bridge: parallel calls, partial reply, is_error results', async () => {
  const s = await bridgeSetup(model(true, ''));
  try {
    const first = await claude(s, { messages: [USER] });
    const uses = first.json().content;
    assert.deepEqual(
      uses.map((b: { type: string }) => b.type),
      ['tool_use', 'tool_use'],
    );
    const partial = await claude(s, {
      messages: [USER, { role: 'user', content: [toolResult(uses[0].id, 'one', true)] }],
    });
    assert.equal(partial.json().stop_reason, 'tool_use');
    assert.deepEqual(
      partial.json().content.map((b: { id: string }) => b.id),
      [uses[1].id],
    );
    const done = await claude(s, {
      messages: [USER, { role: 'user', content: [toolResult(uses[1].id, 'two')] }],
    });
    assert.equal(done.json().content[0].text, 'R:{"error":"one"}|two');
  } finally {
    await s.cleanup();
  }
});

test('claude bridge: streaming frames (with and without an open text block)', async () => {
  for (const text of ['', 'Editing.']) {
    const s = await bridgeSetup(model(false, text));
    try {
      const first = await claude(s, { messages: [USER], stream: true });
      const runId = first.headers['x-run-id'] as string;
      const callId = s.store.approvals(runId)[0]!.id;
      const frames = sse(first.body);
      const events = frames.map((f) => f.event);
      const tools = text ? 1 : 0;
      assert.equal(events[0], 'message_start');
      assert.deepEqual(events.slice(-5 - tools), [
        ...(text ? ['content_block_stop'] : []),
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      const start = frames.at(-5)!.data;
      assert.deepEqual(start, {
        type: 'content_block_start',
        index: tools,
        content_block: { type: 'tool_use', id: callId, name: 'edit-file', input: {} },
      });
      assert.deepEqual(frames.at(-4)!.data.delta, {
        type: 'input_json_delta',
        partial_json: '{"path":"a.ts"}',
      });
      assert.equal(frames.at(-2)!.data.delta.stop_reason, 'tool_use');
      assert.equal(frames.at(-2)!.data.usage.output_tokens, 5);
      const second = await claude(s, {
        stream: true,
        messages: [USER, { role: 'user', content: [toolResult(callId, 'ok')] }],
      });
      assert.equal(second.headers['x-run-id'], runId);
      const next = sse(second.body);
      assert.equal(next.at(-2)!.data.delta.stop_reason, 'end_turn');
      assert.equal(
        next
          .filter((f) => f.event === 'content_block_delta')
          .map((f) => f.data.delta.text)
          .join(''),
        'R:ok',
      );
    } finally {
      await s.cleanup();
    }
  }
});

test('claude bridge: unknown ids fall back, server tools are refused, /v1/messages bridges too', async () => {
  const s = await bridgeSetup(model());
  try {
    const first = await claude(s, { messages: [USER] }, BRIDGE, '/v1/messages');
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'];
    assert.equal(first.json().stop_reason, 'tool_use');
    const unknown = await claude(s, {
      messages: [USER, { role: 'user', content: [toolResult('call_nope', 'x')] }],
    });
    assert.notEqual(unknown.headers['x-run-id'], runId);
    for (const type of ['web_search_20250305', 'bash_20250124', 'computer_20250124']) {
      const r = await claude(s, { messages: [USER], tools: [{ type, name: 'x' }] });
      assert.equal(r.statusCode, 400, type);
      assert.equal(r.json().error.code, 'client_tools_unsupported');
    }
  } finally {
    await s.cleanup();
  }
});

test('bridge: requests without tools keep their exact output on Responses and Claude', async () => {
  const s = await bridgeSetup(new FixtureModel(() => ({ text: 'Plain.' })));
  try {
    const r = await responses(s, { input: 'Hi', tools: undefined });
    const run = s.store.run(r.headers['x-run-id'] as string);
    const msgId = run.output[0]!.id;
    assert.equal(
      r.body,
      JSON.stringify({
        id: run.id,
        object: 'response',
        created_at: Math.floor(run.createdAt / 1000),
        completed_at: Math.floor(run.updatedAt / 1000),
        status: 'completed',
        error: null,
        incomplete_details: null,
        model: 'agent/bridge',
        output: [
          {
            id: msgId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Plain.', annotations: [], logprobs: [] }],
          },
        ],
        // 官方 ResponseUsage 的两个必填明细对象。
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        metadata: {
          'oaa.compat_mode': 'true',
          'oaa.status': 'completed',
          'oaa.agent_version': run.digest,
          'oaa.selected_model': 'fixture',
          'oaa.selected_route': 'default',
          'oaa.session_id': run.sessionId,
        },
        previous_response_id: null,
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
        text: { format: { type: 'text' } },
        store: true,
      }),
    );
    const c = await claude(s, { messages: [{ role: 'user', content: 'Hi' }], tools: undefined });
    assert.equal(
      c.body,
      JSON.stringify({
        id: `msg_${c.headers['x-run-id']}`,
        type: 'message',
        role: 'assistant',
        model: 'agent/bridge',
        content: [{ type: 'text', text: 'Plain.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        container: null,
        diagnostics: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
          inference_geo: null,
          speed: null,
        },
      }),
    );
  } finally {
    await s.cleanup();
  }
});

test('bridge: a run started over Chat continues over Responses (rendered in Responses form)', async () => {
  const s = await bridgeSetup(model());
  try {
    const first = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      {
        model: 'agent/bridge',
        messages: [USER],
        tools: [{ type: 'function', function: { name: 'edit-file', parameters: SCHEMA } }],
      },
      token,
      BRIDGE,
    );
    const runId = first.headers['x-run-id'];
    const callId = first.json().choices[0].message.tool_calls[0].id;
    const done = await responses(s, { input: [output(callId, 'via responses')] });
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(done.json().object, 'response');
    assert.equal(done.json().output[0].content[0].text, 'R:via responses');
  } finally {
    await s.cleanup();
  }
});

test('bridge: caller results are written back unquoted, JSON objects as values', async () => {
  const seen: string[] = [];
  const m = new FixtureModel((_a, messages) => {
    const results = tools(messages);
    if (results.length < 3)
      return { calls: [{ id: `c${results.length}`, name: 'edit_file', arguments: { path: 'p' } }] };
    seen.push(...results.map((r) => r.content));
    return { text: 'ok' };
  });
  const s = await bridgeSetup(m);
  try {
    let r = await responses(s, { input: 'go' });
    for (const value of ['plain text', '{"a": 1}', '"quoted"']) {
      const callId = r
        .json()
        .output.find((o: { type: string }) => o.type === 'function_call').call_id;
      r = await responses(s, { input: [output(callId, value)] });
    }
    assert.deepEqual(seen, ['plain text', '{"a":1}', '"quoted"']);
    // 已发布工具的结果照旧经 JSON 序列化（这里不受影响，由既有测试覆盖）。
  } finally {
    await s.cleanup();
  }
});
