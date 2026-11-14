/**
 * 用官方 `@anthropic-ai/sdk`（node_modules/@anthropic-ai/sdk，版本见 package.json 的 devDependencies）
 * 实测 Claude Messages 兼容入口（`/v1/messages`）。SDK 经自定义 fetch 接到 app.inject，不监听端口。
 *
 * SDK 的重试规则（node_modules/@anthropic-ai/sdk/client.js `shouldRetry`，约 838–870 行）：
 * 服务端给 `x-should-retry: true/false` 时听从它；否则 408、409、429、>=500 重试；默认
 * `maxRetries = 2`（client.js 约 168 行）。等待时间（`retryRequest`，约 873–903 行）先看
 * `retry-after-ms`，再看 `retry-after`（秒或 HTTP 日期），不在 (0, 2^31-1] 毫秒内时用指数退避。
 * 所以网关对运行失败与待审批回 422 且带 `x-should-retry: false`：同一请求不会被 SDK 再发一次。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { token } from './helpers.js';
import { gateway, user } from './anthropic-sdk-gateway.js';

/** SDK 1.3.0 的类型里已没有 temperature / top_k / top_p；按旧客户端的写法照样发出去。 */
const sampling = (p: Record<string, unknown>) =>
  p as unknown as Anthropic.MessageCreateParamsNonStreaming;

test('anthropic sdk: messages.create parses id, type, role, model, content, stop_reason, usage', async () => {
  const { s, client } = await gateway();
  try {
    const m = await client().messages.create({
      model: 'agent/test',
      max_tokens: 100,
      messages: user('hi'),
    });
    assert.match(m.id, /^msg_/);
    assert.equal(m.type, 'message');
    assert.equal(m.role, 'assistant');
    assert.equal(m.model, 'agent/test');
    assert.deepEqual(m.content, [{ type: 'text', text: 'Hello world from fixture.' }]);
    assert.equal(m.stop_reason, 'end_turn');
    assert.equal(m.stop_sequence, null);
    assert.equal(typeof m.usage.input_tokens, 'number');
    assert.equal(typeof m.usage.output_tokens, 'number');
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: messages.stream events, finalMessage and finalText', async () => {
  const { s, client } = await gateway();
  try {
    const stream = client().messages.stream({
      model: 'agent/test',
      max_tokens: 100,
      messages: user('hi'),
    });
    const texts: string[] = [];
    const types: string[] = [];
    let blocks = 0;
    let messages = 0;
    stream.on('text', (t) => texts.push(t));
    stream.on('streamEvent', (e) => types.push(e.type));
    stream.on('contentBlock', () => blocks++);
    stream.on('message', () => messages++);
    const final = await stream.finalMessage();
    assert.equal(texts.join(''), 'Hello world from fixture.');
    assert.equal(await stream.finalText(), 'Hello world from fixture.');
    assert.equal(final.stop_reason, 'end_turn');
    assert.match(final.id, /^msg_/);
    assert.equal(final.model, 'agent/test');
    assert.deepEqual(final.content, [{ type: 'text', text: 'Hello world from fixture.' }]);
    assert.equal(typeof final.usage.output_tokens, 'number');
    assert.equal(blocks, 1);
    assert.equal(messages, 1);
    assert.equal(types[0], 'message_start');
    assert.equal(types.at(-1), 'message_stop');
    assert.equal(types.at(-2), 'message_delta');
    assert.ok(types.includes('content_block_start') && types.includes('content_block_stop'));

    // 原始事件迭代（`stream: true`）：SDK 的 Stream 把每个 SSE 帧解析成事件对象。
    const raw = await client().messages.create({
      model: 'agent/test',
      max_tokens: 100,
      messages: user('hi'),
      stream: true,
    });
    const seen: string[] = [];
    let text = '';
    for await (const e of raw) {
      seen.push(e.type);
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') text += e.delta.text;
    }
    assert.equal(text, 'Hello world from fixture.');
    // 网关在 message_start 之后发 ping；SDK 的 Stream 把 ping 帧吞掉不交给调用方
    // （node_modules/@anthropic-ai/sdk/core/streaming.js 约 47 行 `if (sse.event === 'ping') continue`）。
    assert.deepEqual(seen.slice(0, 2), ['message_start', 'content_block_start']);
    assert.deepEqual(seen.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: system (string and cache_control blocks), multi-turn, metadata, stop_sequences, ignored temperature', async () => {
  const { s, state, client } = await gateway();
  try {
    const c = client();
    await c.messages.create({
      model: 'agent/test',
      max_tokens: 100,
      system: 'Be terse.',
      messages: user('hi'),
    });
    assert.match(state.inputs.at(-1)!, /Be terse\./);
    await c.messages.create({
      model: 'agent/test',
      max_tokens: 100,
      system: [{ type: 'text', text: 'Cached rules.', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
      metadata: { user_id: 'u-1' },
      stop_sequences: ['END'],
    });
    const input = state.inputs.at(-1)!;
    for (const part of ['Cached rules.', 'first', 'answer', 'second'])
      assert.match(input, new RegExp(part));
    const { data, response } = await c.messages
      .create(
        sampling({ model: 'agent/test', max_tokens: 100, temperature: 0.3, messages: user('hi') }),
      )
      .withResponse();
    assert.equal(data.stop_reason, 'end_turn');
    assert.match(String(response.headers.get('x-oaa-ignored-params')), /temperature/);
    const asResponse = await c.messages
      .create(sampling({ model: 'agent/test', max_tokens: 100, top_k: 3, messages: user('hi') }))
      .asResponse();
    assert.equal(asResponse.status, 200);
    assert.match(String(asResponse.headers.get('x-oaa-ignored-params')), /top_k/);
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: truncation is stop_reason "max_tokens" with the partial text, plain and streamed', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'len';
    const c = client();
    const plain = await c.messages.create({
      model: 'agent/test',
      max_tokens: 1,
      messages: user('hi'),
    });
    assert.equal(plain.stop_reason, 'max_tokens');
    assert.deepEqual(plain.content, [{ type: 'text', text: 'partial text' }]);
    const stream = c.messages.stream({ model: 'agent/test', max_tokens: 1, messages: user('hi') });
    const final = await stream.finalMessage();
    assert.equal(final.stop_reason, 'max_tokens');
    assert.equal(await stream.finalText(), 'partial text');
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: apiKey, authToken and x-api-key all authenticate; anthropic-beta is accepted', async () => {
  const { s, client, seenHeaders } = await gateway();
  try {
    // SDK 1.3.0 把 apiKey 也发成 `Authorization: Bearer`（client.js `apiKeyAuth`，约 448 行），
    // 并带 `anthropic-version`。
    const viaKey = await client().messages.create({
      model: 'agent/test',
      max_tokens: 10,
      messages: user('hi'),
    });
    assert.equal(viaKey.stop_reason, 'end_turn');
    assert.equal(seenHeaders.at(-1)!['authorization'], `Bearer ${token}`);
    assert.ok(seenHeaders.at(-1)!['anthropic-version']);
    const viaToken = await client({ apiKey: null, authToken: token }).messages.create({
      model: 'agent/test',
      max_tokens: 10,
      messages: user('hi'),
    });
    assert.equal(viaToken.stop_reason, 'end_turn');
    // 旧版 SDK 与 curl 示例的 `x-api-key`（显式头存在时 SDK 不再要求 apiKey，client.js `validateHeaders`）。
    const viaHeader = await client({
      apiKey: null,
      defaultHeaders: { 'x-api-key': token },
    }).messages.create({ model: 'agent/test', max_tokens: 10, messages: user('hi') });
    assert.equal(viaHeader.stop_reason, 'end_turn');
    assert.equal(seenHeaders.at(-1)!['x-api-key'], token);
    assert.equal(seenHeaders.at(-1)!['authorization'], undefined);
    const beta = await client().messages.create(
      { model: 'agent/test', max_tokens: 10, messages: user('hi') },
      { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } },
    );
    assert.equal(beta.stop_reason, 'end_turn');
    const betaApi = await client().beta.messages.create({
      model: 'agent/test',
      max_tokens: 10,
      messages: user('hi'),
      betas: ['token-efficient-tools-2025-02-19'],
    });
    assert.equal(betaApi.stop_reason, 'end_turn');
    assert.equal(seenHeaders.at(-1)!['anthropic-beta'], 'token-efficient-tools-2025-02-19');
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: endpoints we do not serve are a NotFoundError with the Anthropic error body', async () => {
  const { s, client } = await gateway();
  try {
    const c = client();
    const notFound = (e: unknown) => {
      assert.ok(e instanceof Anthropic.NotFoundError, String(e));
      assert.equal(e.status, 404);
      assert.equal(e.type, 'not_found_error');
      const body = e.error as { type: string; error: { type: string; code: string } };
      assert.equal(body.type, 'error');
      assert.equal(body.error.code, 'route_not_found');
      return true;
    };
    await assert.rejects(
      c.messages.countTokens({ model: 'agent/test', messages: user('hi') }),
      notFound,
    );
    await assert.rejects(c.messages.batches.list(), notFound);
    await assert.rejects(c.messages.batches.retrieve('msgbatch_1'), notFound);
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: models.list returns Anthropic model objects', async () => {
  const { s, client } = await gateway();
  try {
    const page = await client().models.list();
    const ids = page.data.map((m) => m.id);
    assert.deepEqual(ids, ['agent/approve', 'agent/bridge', 'agent/test']);
    for (const m of page.data) {
      assert.equal(m.type, 'model');
      assert.equal(m.display_name, m.id);
      assert.ok(!Number.isNaN(Date.parse(m.created_at)), m.created_at);
    }
    assert.equal(page.hasNextPage(), false);
    // OpenAI 客户端（不带 anthropic-version）照旧拿到 OpenAI 的列表形状。
    const openai = await s.request('GET', '/v1/models');
    assert.equal(openai.json().object, 'list');
    assert.equal(openai.json().data[0].object, 'model');
  } finally {
    await s.cleanup();
  }
});

/** SDK 类型（resources/messages/messages.d.ts）里必有、可为 null 的字段：读到 null，不是 undefined。 */
const nullUsage = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
};
const assertNullable = (m: Anthropic.Message) => {
  assert.equal(m.container, null);
  assert.equal(m.diagnostics, null);
  assert.equal(m.stop_details, null);
  assert.equal(m.stop_sequence, null);
  for (const [k, v] of Object.entries(nullUsage))
    assert.equal(m.usage[k as keyof Anthropic.Usage], v, `usage.${k}`);
  assert.equal(typeof m.usage.input_tokens, 'number');
  assert.equal(typeof m.usage.output_tokens, 'number');
};

test('anthropic sdk: nullable Message and Usage fields are null, plain and finalMessage()', async () => {
  const { s, client } = await gateway();
  try {
    const plain = await client().messages.create({
      model: 'agent/test',
      max_tokens: 100,
      messages: user('hi'),
    });
    assertNullable(plain);
    const stream = client().messages.stream({
      model: 'agent/test',
      max_tokens: 100,
      messages: user('hi'),
    });
    const deltas: Anthropic.MessageDeltaUsage[] = [];
    stream.on('streamEvent', (e) => {
      if (e.type === 'message_delta') deltas.push(e.usage);
      if (e.type === 'message_start') assertNullable(e.message);
    });
    assertNullable(await stream.finalMessage());
    assert.equal(deltas.length, 1);
    const [delta] = deltas;
    assert.equal(delta!.cache_creation_input_tokens, null);
    assert.equal(delta!.cache_read_input_tokens, null);
    assert.equal(delta!.output_tokens_details, null);
    assert.equal(delta!.server_tool_use, null);
    assert.equal(typeof delta!.input_tokens, 'number');
  } finally {
    await s.cleanup();
  }
});
