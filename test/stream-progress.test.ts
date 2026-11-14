import assert from 'node:assert/strict';
import test from 'node:test';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { agent, FixtureModel, setup, token, waitFor } from './helpers.js';

// Stream progress (docs/progress.md) end to end over every compat protocol: progress travels in each
// protocol's thinking shape and never changes the answer text. Offline: in-process requests, a
// deterministic model that lists files once and then answers.

type Json = Record<string, any>;
const ANSWER = 'The files are listed. Answer ends here.';
const ON = { 'x-oaa-progress': 'reasoning', 'accept-language': 'en' };
const OFF = { 'x-oaa-progress': 'off' };

function toolModel(text = ANSWER) {
  return new FixtureModel((_a, messages) =>
    messages.some((m) => m.role === 'tool')
      ? { text }
      : { calls: [{ id: 'c1', name: 'list_files', arguments: {} }] },
  );
}
async function lab(model = toolModel(), config: Record<string, unknown> = {}) {
  const s = await setup(model, config);
  s.store.publish('owner', makeBundle(agent({ tools: [builtin('list_files')] })));
  return s;
}
type Lab = Awaited<ReturnType<typeof lab>>;
/** The newest run of the owner, through the API. */
async function waitStatus(s: Lab, status: string): Promise<string> {
  let runId = '';
  await waitFor(async () => {
    const run = ((await s.request('GET', '/v1/runs?limit=1')).json().data as Json[])[0];
    runId = run?.id ?? '';
    return run?.status === status;
  });
  return runId;
}

const sse = (body: string) =>
  body
    .split('\n\n')
    .map((f) =>
      f
        .split('\n')
        .find((l) => l.startsWith('data: '))
        ?.slice(6),
    )
    .filter((d): d is string => !!d && d !== '[DONE]')
    .map((d) => JSON.parse(d) as Json);
const events = (body: string) =>
  body
    .split('\n\n')
    .filter((f) => f.includes('data: '))
    .map((f) => ({
      event: f
        .split('\n')
        .find((l) => l.startsWith('event: '))
        ?.slice(7),
      data: JSON.parse(
        f
          .split('\n')
          .find((l) => l.startsWith('data: '))!
          .slice(6),
      ) as Json,
    }));

const chat = (s: Lab, headers: Record<string, string>, extra: Json = {}) =>
  s.request(
    'POST',
    '/v1/chat/completions',
    { model: 'agent/test', messages: [{ role: 'user', content: 'list' }], ...extra },
    token,
    headers,
  );
const chatText = (body: string) =>
  sse(body)
    .map((c) => c.choices?.[0]?.delta?.content ?? '')
    .join('');
const chatReasoning = (body: string) =>
  sse(body)
    .map((c) => c.choices?.[0]?.delta?.reasoning_content ?? '')
    .join('');

test('chat: progress rides in reasoning_content; the content is the same as off and as non-streaming', async () => {
  const s = await lab();
  try {
    const plain = (await chat(s, {})).json();
    const on = await chat(s, ON, { stream: true, stream_options: { include_usage: true } });
    const off = await chat(s, OFF, { stream: true, stream_options: { include_usage: true } });
    const byDefault = await chat(s, {}, { stream: true });
    assert.equal(chatText(on.body), plain.choices[0].message.content);
    assert.equal(chatText(off.body), plain.choices[0].message.content);
    assert.equal(chatText(on.body), ANSWER);
    assert.equal(
      chatReasoning(on.body),
      'Started\nCalling tool list_files (read-only)\nTool list_files finished\n',
    );
    assert.equal(chatReasoning(off.body), '');
    assert.equal(chatReasoning(byDefault.body), '', 'chat is off by default');
    const usage = (body: string) => sse(body).at(-1)!.usage;
    assert.deepEqual(usage(on.body), usage(off.body), 'progress is not counted as output');
    assert.equal(sse(on.body)[0]!.choices[0].delta.role, 'assistant');
    // metadata["oaa.progress"] works like the header.
    const meta = await chat(
      s,
      { 'accept-language': 'zh-CN' },
      {
        stream: true,
        metadata: { 'oaa.progress': 'reasoning' },
      },
    );
    assert.match(chatReasoning(meta.body), /^开始执行\n调用工具 list_files/);
  } finally {
    await s.cleanup();
  }
});

test('responses: progress is a reasoning item at output_index 0, on by default; positions stay consistent', async () => {
  const s = await lab();
  try {
    const body = { model: 'agent/test', input: 'list' };
    const plain = (await s.request('POST', '/v1/responses', body)).json();
    const r = await s.request('POST', '/v1/responses', { ...body, stream: true }, token, {
      'accept-language': 'en',
    });
    const all = events(r.body);
    const kinds = all.map((e) => e.event);
    const added = all.filter((e) => e.event === 'response.output_item.added');
    assert.equal(added[0]!.data.item.type, 'reasoning');
    assert.equal(added[0]!.data.output_index, 0);
    assert.equal(added[1]!.data.item.type, 'message');
    assert.equal(added[1]!.data.output_index, 1);
    assert.ok(
      kinds.indexOf('response.output_item.done') < kinds.indexOf('response.output_text.delta'),
      'the reasoning item closes before the answer starts',
    );
    for (const e of all.filter((x) => x.event === 'response.output_text.delta'))
      assert.equal(e.data.output_index, 1);
    const summary = all
      .filter((e) => e.event === 'response.reasoning_summary_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.match(summary, /^Started\nCalling tool list_files/);
    const text = all
      .filter((e) => e.event === 'response.output_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.equal(text, plain.output_text ?? plain.output[0].content[0].text);
    const done = all.at(-1)!.data.response;
    assert.equal(done.output[0].type, 'reasoning');
    assert.equal(done.output[0].summary[0].text, summary);
    assert.deepEqual(done.usage, plain.usage);
    // Sequence numbers stay contiguous.
    all.forEach((e, i) => assert.equal(e.data.sequence_number, i));
    // Non-streaming output has no reasoning item.
    assert.ok(plain.output.every((i: Json) => i.type !== 'reasoning'));
    // A client that sends the reasoning item back gets a normal answer.
    const back = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: [
        { role: 'user', content: 'list' },
        done.output[0],
        { role: 'assistant', content: text },
        { role: 'user', content: 'again' },
      ],
    });
    assert.equal(back.statusCode, 200, back.body);
    const off = await s.request('POST', '/v1/responses', { ...body, stream: true }, token, OFF);
    assert.ok(!off.body.includes('"reasoning"'));
  } finally {
    await s.cleanup();
  }
});

test('claude: a thinking block at index 0 precedes the text at index 1; echoed thinking is ignored', async () => {
  const s = await lab();
  try {
    const body = {
      model: 'agent/test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'list' }],
    };
    const plain = (await s.request('POST', '/v1/messages', body)).json();
    const off = await s.request('POST', '/v1/messages', { ...body, stream: true });
    assert.ok(!off.body.includes('thinking'), 'claude is off by default');
    const r = await s.request('POST', '/v1/messages', { ...body, stream: true }, token, ON);
    const all = events(r.body);
    assert.equal(all[0]!.event, 'message_start');
    const starts = all.filter((e) => e.event === 'content_block_start');
    assert.deepEqual(
      starts.map((e) => [e.data.index, e.data.content_block.type]),
      [
        [0, 'thinking'],
        [1, 'text'],
      ],
    );
    const deltas = all.filter((e) => e.event === 'content_block_delta');
    const thinking = deltas
      .filter((e) => e.data.delta.type === 'thinking_delta')
      .map((e) => e.data.delta.thinking)
      .join('');
    assert.match(thinking, /^Started\n/);
    const signature = deltas.find((e) => e.data.delta.type === 'signature_delta')!;
    assert.equal(signature.data.index, 0);
    const text = deltas
      .filter((e) => e.data.delta.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    assert.equal(text, plain.content[0].text);
    assert.ok(
      deltas.filter((e) => e.data.delta.type === 'text_delta').every((e) => e.data.index === 1),
    );
    const stops = all.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
    assert.deepEqual(stops, [0, 1]);
    assert.equal(all.at(-1)!.event, 'message_stop');
    const back = await s.request('POST', '/v1/messages', {
      ...body,
      messages: [
        { role: 'user', content: 'list' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking, signature: signature.data.delta.signature },
            { type: 'text', text },
          ],
        },
        { role: 'user', content: 'again' },
      ],
    });
    assert.equal(back.statusCode, 200, back.body);
  } finally {
    await s.cleanup();
  }
});

test('gemini: progress parts are thought parts, on by default; the text parts are the answer', async () => {
  const s = await lab();
  try {
    const body = { contents: [{ role: 'user', parts: [{ text: 'list' }] }] };
    const url = '/v1beta/models/agent%2Ftest:streamGenerateContent?alt=sse';
    const plain = (
      await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', body)
    ).json();
    const parts = (b: string) => sse(b).flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
    const on = parts((await s.request('POST', url, body)).body);
    assert.ok(on.some((p: Json) => p.thought === true));
    const text = on
      .filter((p: Json) => !p.thought)
      .map((p: Json) => p.text ?? '')
      .join('');
    assert.equal(text, plain.candidates[0].content.parts[0].text);
    const off = parts((await s.request('POST', url, body, token, OFF)).body);
    assert.ok(off.every((p: Json) => !p.thought));
    // A client echoing the thought parts back is fine.
    const back = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [
        { role: 'user', parts: [{ text: 'list' }] },
        { role: 'model', parts: [...on.filter((p: Json) => p.thought), { text }] },
        { role: 'user', parts: [{ text: 'again' }] },
      ],
    });
    assert.equal(back.statusCode, 200, back.body);
  } finally {
    await s.cleanup();
  }
});

test('structured output: progress streams while the answer is held, then the answer arrives whole', async () => {
  const answers = ['not json', '{"name":"Ada","age":36}'];
  let turn = 0;
  const s = await lab(new FixtureModel(() => ({ text: answers[Math.min(turn++, 1)] })));
  try {
    const format = {
      type: 'json_schema',
      json_schema: {
        name: 'person',
        strict: true,
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'integer' } },
          required: ['name', 'age'],
          additionalProperties: false,
        },
      },
    };
    const r = await chat(s, ON, { stream: true, response_format: format });
    assert.equal(chatText(r.body), answers[1]);
    assert.match(chatReasoning(r.body), /sent back for correction \(round 1\)/);
    const firstText = sse(r.body).findIndex((c) => c.choices?.[0]?.delta?.content);
    const lastReasoning = sse(r.body).findLastIndex(
      (c) => c.choices?.[0]?.delta?.reasoning_content,
    );
    assert.ok(lastReasoning < firstText, 'the progress comes before the held answer');
  } finally {
    await s.cleanup();
  }
});

test('bridge: progress before the tool_calls hand-off, and again on the resumed stream', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'patched' }
        : { calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }] },
    ),
  );
  s.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  try {
    const tool = {
      type: 'function',
      function: {
        name: 'edit-file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    };
    const headers = { ...ON, 'x-oaa-client-tools': 'bridge' };
    const ask = (messages: Json[]) =>
      s.request(
        'POST',
        '/v1/compat/chat/completions',
        { model: 'agent/bridge', tools: [tool], messages, stream: true },
        token,
        headers,
      );
    const first = await ask([{ role: 'user', content: 'fix' }]);
    const chunks = sse(first.body);
    assert.match(chatReasoning(first.body), /Waiting for the caller to run tool edit-file\n$/);
    const call = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls)!.choices[0].delta
      .tool_calls[0];
    assert.equal(chunks.at(-1)!.choices[0].finish_reason, 'tool_calls');
    const second = await ask([
      { role: 'user', content: 'fix' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: call.id, type: 'function', function: call.function }],
      },
      { role: 'tool', tool_call_id: call.id, content: 'ok' },
    ]);
    assert.equal(chatText(second.body), 'patched');
    assert.match(chatReasoning(second.body), /Resumed|Started/);
  } finally {
    await s.cleanup();
  }
});

test('approval: a Responses stream shows the wait, then the approval, then the answer', async () => {
  const write = builtin('write_file');
  write.capability.requiresApproval = true;
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'written' }
        : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
    ),
    { approvalTimeoutMs: 30_000 },
  );
  s.store.publish('owner', makeBundle(agent({ tools: [write] })));
  try {
    const pending = s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'write', stream: true },
      token,
      {
        'accept-language': 'en',
      },
    );
    const runId = await waitStatus(s, 'requires_action');
    const action = s.store.approvals(runId)[0]!;
    const ok = await s.request('POST', `/v1/runs/${runId}/actions/${action.id}`, {
      decision: 'approve',
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const r = await pending;
    const summary = events(r.body)
      .filter((e) => e.event === 'response.reasoning_summary_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.match(
      summary,
      /Waiting for approval: the owner must approve "write_file" in the console\nApproved\n/,
    );
    assert.equal(events(r.body).at(-1)!.event, 'response.completed');
  } finally {
    await s.cleanup();
  }
});

test('failure and cancellation: the stream still ends with the protocol error after progress', async () => {
  const s = await lab(
    new FixtureModel(() => {
      throw new Error('model broke');
    }),
  );
  try {
    const r = await chat(s, ON, { stream: true });
    const chunks = sse(r.body);
    assert.match(chatReasoning(r.body), /^Started\n/);
    assert.ok(chunks.at(-1)!.error?.code, r.body);
    assert.equal(chatText(r.body), '');
    const claude = await s.request(
      'POST',
      '/v1/messages',
      {
        model: 'agent/test',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      },
      token,
      ON,
    );
    const all = events(claude.body);
    assert.equal(all.at(-1)!.event, 'error');
    assert.equal(all.at(-1)!.data.type, 'error');
  } finally {
    await s.cleanup();
  }
  // Cancelled while waiting: a slow model, cancel through the API.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = await lab(
    new FixtureModel(async (_a, _m, signal) => {
      await Promise.race([gate, new Promise((r) => signal.addEventListener('abort', r))]);
      return { text: 'late' };
    }),
  );
  try {
    const pending = chat(slow, ON, { stream: true });
    const runId = await waitStatus(slow, 'in_progress');
    await slow.request('POST', `/v1/responses/${runId}/cancel`);
    const r = await pending;
    assert.match(chatReasoning(r.body), /^Started\n/);
    assert.equal(sse(r.body).at(-1)!.error?.code, 'cancelled', r.body);
  } finally {
    release();
    await slow.cleanup();
  }
});

test('images and Claude bridge: progress does not disturb image input or tool_use block indexes', async () => {
  const s = await lab(new FixtureModel(() => ({ text: 'seen' })));
  try {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        ],
      },
    ];
    const on = await chat(s, ON, { stream: true, messages });
    const off = await chat(s, OFF, { stream: true, messages });
    assert.equal(on.statusCode, off.statusCode);
    assert.equal(chatText(on.body), chatText(off.body));
    if (on.statusCode === 200) assert.match(chatReasoning(on.body), /^Started\n/);
  } finally {
    await s.cleanup();
  }
  const b = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'patched' }
        : { calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }] },
    ),
  );
  b.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  try {
    const r = await b.request(
      'POST',
      '/v1/compat/messages',
      {
        model: 'agent/bridge',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'fix' }],
        tools: [{ name: 'edit-file', input_schema: { type: 'object', properties: {} } }],
      },
      token,
      { ...ON, 'x-oaa-client-tools': 'bridge' },
    );
    const all = events(r.body);
    const starts = all.filter((e) => e.event === 'content_block_start');
    assert.deepEqual(
      starts.map((e) => [e.data.index, e.data.content_block.type]),
      [
        [0, 'thinking'],
        [1, 'tool_use'],
      ],
      r.body,
    );
    assert.deepEqual(
      all.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index),
      [0, 1],
    );
    assert.equal(all.filter((e) => e.event === 'message_start').length, 1);
    assert.equal(all.at(-1)!.event, 'message_stop');
  } finally {
    await b.cleanup();
  }
});
