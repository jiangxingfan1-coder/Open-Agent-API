/**
 * Claude Messages、Gemini 与 `/v1/universal` 的协议合规。
 * 断言按官方文档的字段与事件序列写（Claude 入口另有官方 SDK 的实测：test/compat-anthropic-sdk*.test.ts；
 * Gemini 入口另用临时安装的 `@google/genai` 3.2.0 做过一次性实测：examples/gemini-sdk-probe.mjs，
 * 发现的问题见 test/compat-gemini-sdk-findings.test.ts）：
 * - Claude 错误：https://platform.claude.com/docs/en/api/errors （`{type:"error",error:{type,message}}`，
 *   400 invalid_request_error、401 authentication_error、403 permission_error、404 not_found_error、
 *   409 conflict_error、429 rate_limit_error、500 api_error、529 overloaded_error）
 * - Claude 流：https://platform.claude.com/docs/en/build-with-claude/streaming （message_start、ping、
 *   content_block_start/delta/stop、message_delta、message_stop；错误是 `event: error`）
 * - Claude stop_reason：https://platform.claude.com/docs/en/api/messages （end_turn、max_tokens、tool_use…）
 * - Gemini：https://ai.google.dev/api/generate-content （FinishReason STOP / MAX_TOKENS；不带 alt=sse
 *   时 streamGenerateContent 返回分块的 JSON 数组；REST 示例用 `?key=`）
 * - Google 错误模型：https://cloud.google.com/apis/design/errors （`{error:{code,message,status,details}}`）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, agent, FixtureModel } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import type { AgentDefinition, ModelMessage } from '../src/core/contracts.js';
import {
  errorBody,
  problemStatus,
  retryHeaders,
  runFailure,
} from '../src/gateway/compat-errors.js';

type Mode = 'ok' | 'len' | 'fail';
async function gateway() {
  const state = {
    mode: 'ok' as Mode,
    seen: [] as { agent: AgentDefinition; messages: ModelMessage[] }[],
  };
  const s = await setup(
    new FixtureModel((a, messages) => {
      state.seen.push({ agent: a, messages });
      if (state.mode === 'fail') throw new Error('boom');
      if (state.mode === 'len') return { text: 'partial', finish: 'length' };
      return { text: 'ok' };
    }),
  );
  s.store.publish('owner', makeBundle(agent()));
  const lastUser = () =>
    state.seen
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .at(-1)!.content;
  return { s, state, lastUser };
}
const events = (body: string) =>
  body
    .split('\n\n')
    .filter((f) => f.startsWith('event: '))
    .map((f) => ({
      event: f.split('\n')[0]!.slice(7),
      data: JSON.parse(f.split('\n')[1]!.slice(6)) as Record<string, any>,
    }));
const claude = (extra: Record<string, unknown> = {}) => ({
  model: 'agent/test',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const gem = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

test('claude: a long system prompt reaches the agent whole', async () => {
  const { s, lastUser } = await gateway();
  try {
    const system = `SYSMARK ${'s'.repeat(5000)} END`;
    const r = await s.request('POST', '/v1/messages', claude({ system }));
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(lastUser().includes(system));
    const blocks = await s.request(
      'POST',
      '/v1/messages',
      claude({ system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }),
    );
    assert.equal(blocks.statusCode, 200, blocks.body);
    assert.ok(lastUser().includes(system));
  } finally {
    await s.cleanup();
  }
});

test('universal: detection uses headers and protocol-only structure, never max_tokens', async () => {
  const { s } = await gateway();
  try {
    const chatWithMax = {
      model: 'agent/test',
      max_tokens: 20,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    };
    const chat = await s.request('POST', '/v1/universal', chatWithMax);
    assert.equal(chat.headers['x-oaa-detected-protocol'], 'chat');
    assert.equal(chat.json().object, 'chat.completion');
    const anthropic = await s.request('POST', '/v1/universal', claude(), undefined, {
      'anthropic-version': '2023-06-01',
    });
    assert.equal(anthropic.headers['x-oaa-detected-protocol'], 'claude');
    assert.equal(anthropic.json().type, 'message');
    const noMax = await s.request('POST', '/v1/universal', {
      model: 'agent/test',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
      ],
    });
    assert.equal(noMax.headers['x-oaa-detected-protocol'], 'claude');
    const ambiguous = await s.request('POST', '/v1/universal', claude());
    assert.equal(ambiguous.statusCode, 400);
    assert.equal(ambiguous.json().error.code, 'protocol_undetected');
    const named = await s.request('POST', '/v1/universal', claude(), undefined, {
      'x-oaa-protocol': 'chat',
    });
    assert.equal(named.json().object, 'chat.completion');
    const both = await s.request('POST', '/v1/universal', {
      model: 'agent/test',
      contents: [{ parts: [{ text: 'hi' }] }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(both.headers['x-oaa-detected-protocol'], 'gemini');
  } finally {
    await s.cleanup();
  }
});

test('claude: errors use the Anthropic shape, keep the gateway code, and are not retried', async () => {
  const { s, state } = await gateway();
  try {
    const unauth = await s.request('POST', '/v1/messages', claude(), 'wrong-token');
    assert.equal(unauth.statusCode, 401);
    assert.equal(unauth.json().type, 'error');
    assert.equal(unauth.json().error.type, 'authentication_error');
    const missing = await s.request('POST', '/v1/messages', claude({ model: 'agent/none' }));
    assert.equal(missing.json().error.type, 'not_found_error');
    assert.equal(typeof missing.json().error.code, 'string');
    const invalid = await s.request('POST', '/v1/messages', { model: 'agent/test' });
    assert.equal(invalid.json().error.type, 'invalid_request_error');
    state.mode = 'fail';
    const failed = await s.request('POST', '/v1/messages', claude());
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.headers['x-should-retry'], 'false');
    assert.equal(failed.json().error.code, 'execution_failed');
    assert.match(failed.json().error.message, /boom/);
    assert.match(failed.json().error.run_id, /^resp_/);
  } finally {
    await s.cleanup();
  }
});

test('gemini: errors use the Google shape with the code in ErrorInfo', async () => {
  const { s, state } = await gateway();
  try {
    const url = '/v1beta/models/agent%2Ftest:generateContent';
    const unauth = await s.request('POST', url, gem, 'wrong-token');
    assert.equal(unauth.statusCode, 401);
    assert.equal(unauth.json().error.code, 401);
    assert.equal(unauth.json().error.status, 'UNAUTHENTICATED');
    const bad = await s.request('POST', url, { contents: [] });
    assert.equal(bad.json().error.status, 'INVALID_ARGUMENT');
    assert.equal(bad.json().error.details[0].reason, 'invalid_request');
    const route = await s.request('POST', '/v1beta/models/agent%2Ftest:nope', gem);
    assert.equal(route.json().error.status, 'NOT_FOUND');
    state.mode = 'fail';
    const failed = await s.request('POST', url, gem);
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.headers['x-should-retry'], 'false');
    assert.equal(failed.json().error.details[0].reason, 'execution_failed');
  } finally {
    await s.cleanup();
  }
});

test('claude and gemini report the real finish: max_tokens / MAX_TOKENS on truncation', async () => {
  const { s, state } = await gateway();
  try {
    state.mode = 'len';
    const plain = await s.request('POST', '/v1/messages', claude());
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal(plain.json().stop_reason, 'max_tokens');
    assert.equal(plain.json().content[0].text, 'partial');
    const streamed = events(
      (await s.request('POST', '/v1/messages', claude({ stream: true }))).body,
    );
    assert.equal(streamed.at(-2)!.data.delta.stop_reason, 'max_tokens');
    assert.equal(streamed.at(-1)!.event, 'message_stop');
    const g = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', gem);
    assert.equal(g.json().candidates[0].finishReason, 'MAX_TOKENS');
    const gs = await s.request(
      'POST',
      '/v1beta/models/agent%2Ftest:streamGenerateContent?alt=sse',
      gem,
    );
    assert.match(gs.body, /"finishReason":"MAX_TOKENS"/);
    state.mode = 'ok';
    const done = await s.request('POST', '/v1/messages', claude());
    assert.equal(done.json().stop_reason, 'end_turn');
  } finally {
    await s.cleanup();
  }
});

test('claude and gemini apply the output cap and list ignored sampling parameters', async () => {
  const { s, state } = await gateway();
  try {
    const r = await s.request(
      'POST',
      '/v1/messages',
      claude({ max_tokens: 33, temperature: 0.1, top_k: 5 }),
    );
    assert.equal(state.seen.at(-1)!.agent.limits.maxOutputTokens, 33);
    assert.equal(r.headers['x-oaa-ignored-params'], 'temperature, top_k');
    const g = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      ...gem,
      generationConfig: { maxOutputTokens: 44, temperature: 0.3 },
    });
    assert.equal(state.seen.at(-1)!.agent.limits.maxOutputTokens, 44);
    assert.equal(g.headers['x-oaa-ignored-params'], 'generationConfig.temperature');
    const plain = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', gem);
    assert.equal(plain.headers['x-oaa-ignored-params'], undefined);
  } finally {
    await s.cleanup();
  }
});

test('claude stream: ping after message_start; failures carry the real type, code and reason', async () => {
  const { s, state } = await gateway();
  try {
    const ok = events((await s.request('POST', '/v1/messages', claude({ stream: true }))).body);
    assert.deepEqual(
      ok.map((e) => e.event),
      [
        'message_start',
        'ping',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    );
    state.mode = 'fail';
    const failed = events((await s.request('POST', '/v1/messages', claude({ stream: true }))).body);
    const last = failed.at(-1)!;
    assert.equal(last.event, 'error');
    assert.equal(last.data.error.type, 'api_error');
    assert.equal(last.data.error.code, 'execution_failed');
    assert.match(last.data.error.message, /boom/);
    const g = await s.request(
      'POST',
      '/v1beta/models/agent%2Ftest:streamGenerateContent?alt=sse',
      gem,
    );
    const frame = JSON.parse(g.body.trim().split('\n').at(-1)!.slice(6));
    assert.equal(frame.error.status, 'INTERNAL');
    assert.equal(frame.error.details[0].reason, 'execution_failed');
  } finally {
    await s.cleanup();
  }
});

test('gemini: ?key= authenticates on /v1beta only; no alt=sse streams a JSON array', async () => {
  const { s } = await gateway();
  try {
    const keyed = await s.app.inject({
      method: 'POST',
      url: `/v1beta/models/agent%2Ftest:generateContent?key=${encodeURIComponent((await import('./helpers.js')).token)}`,
      payload: gem,
    });
    assert.equal(keyed.statusCode, 200, keyed.body);
    const elsewhere = await s.app.inject({
      method: 'GET',
      url: `/v1/models?key=${encodeURIComponent((await import('./helpers.js')).token)}`,
    });
    assert.equal(elsewhere.statusCode, 401);
    const array = await s.request('POST', '/v1beta/models/agent%2Ftest:streamGenerateContent', gem);
    assert.match(String(array.headers['content-type']), /application\/json/);
    const chunks = JSON.parse(array.body) as Record<string, any>[];
    assert.ok(chunks.length >= 2);
    assert.equal(chunks.at(-1)!.candidates[0].finishReason, 'STOP');
    assert.equal(chunks.map((c) => c.candidates[0].content.parts[0]?.text ?? '').join(''), 'ok');
    const sse = await s.request(
      'POST',
      '/v1beta/models/agent%2Ftest:streamGenerateContent?alt=sse',
      gem,
    );
    assert.match(String(sse.headers['content-type']), /text\/event-stream/);
  } finally {
    await s.cleanup();
  }
});

test('sk-oaa- key: Bearer, x-api-key, x-goog-api-key and ?key= all authenticate (K1)', async () => {
  const { s } = await gateway();
  try {
    const made = await s.request('POST', '/v1/keys', {
      name: 'sdk',
      agents: ['*'],
      scopes: ['read', 'invoke'],
    });
    const key = made.json().token as string;
    assert.match(key, /^sk-oaa-/);
    const openai = await s.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'agent/test', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(openai.statusCode, 200, openai.body);
    const anthropic = await s.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: claude(),
    });
    assert.equal(anthropic.statusCode, 200, anthropic.body);
    const google = await s.app.inject({
      method: 'POST',
      url: '/v1beta/models/agent%2Ftest:generateContent',
      headers: { 'x-goog-api-key': key },
      payload: gem,
    });
    assert.equal(google.statusCode, 200, google.body);
    const query = await s.app.inject({
      method: 'POST',
      url: `/v1beta/models/agent%2Ftest:generateContent?key=${encodeURIComponent(key)}`,
      payload: gem,
    });
    assert.equal(query.statusCode, 200, query.body);
  } finally {
    await s.cleanup();
  }
});

test('claude and gemini: no raw JSON or base64 reaches the prompt', async () => {
  const { s, lastUser } = await gateway();
  try {
    const image = await s.request(
      'POST',
      '/v1/messages',
      claude({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
              },
            ],
          },
        ],
      }),
    );
    assert.equal(image.statusCode, 400);
    assert.equal(image.json().error.code, 'unsupported_content');
    assert.equal(image.json().error.type, 'invalid_request_error');
    const inline = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] }],
    });
    assert.equal(inline.statusCode, 400);
    assert.equal(inline.json().error.details[0].reason, 'unsupported_content');
    const tools = await s.request(
      'POST',
      '/v1/messages',
      claude({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'look', input: { q: 1 } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [{ type: 'text', text: 'found' }],
              },
            ],
          },
        ],
      }),
    );
    assert.equal(tools.statusCode, 200, tools.body);
    assert.ok(lastUser().includes('[assistant tool_call:look]\n{"q":1}'));
    assert.ok(lastUser().includes('[tool:t1]\nfound'));
    assert.ok(!lastUser().includes('"type":"tool_result"'));
    const fn = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'look', args: { q: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'look', response: { ok: true } } }] },
      ],
    });
    assert.equal(fn.statusCode, 200, fn.body);
    assert.ok(lastUser().includes('[tool:look]\n{"ok":true}'));
  } finally {
    await s.cleanup();
  }
});

test('run-only codes (turn_limit / token_budget): 422 not retried, streams carry the code (no 409)', async () => {
  const s = await setup(
    new FixtureModel(() => ({
      text: 'step',
      calls: [{ id: `l${Math.random()}`, name: 'list_files', arguments: {} }],
    })),
  );
  const limits = (maxTurns: number, maxTotalTokens: number) => ({
    maxTurns,
    maxOutputTokens: 100,
    timeoutMs: 5000,
    toolConcurrency: 1,
    maxTotalTokens,
  });
  try {
    for (const [id, code, l] of [
      ['agent/turn', 'turn_limit', limits(1, 100000)],
      ['agent/budget', 'token_budget', limits(50, 10)],
    ] as const) {
      s.store.publish(
        'owner',
        makeBundle(agent({ id, tools: [builtin('list_files')], limits: l })),
      );
      const msgs = [{ role: 'user', content: 'x' }];
      const gemUrl = `/v1beta/models/${encodeURIComponent(id)}`;
      const plain = [
        await s.request('POST', '/v1/chat/completions', { model: id, messages: msgs }),
        await s.request('POST', '/v1/messages', { model: id, max_tokens: 9, messages: msgs }),
        await s.request('POST', `${gemUrl}:generateContent`, gem),
      ];
      for (const r of plain) {
        assert.equal(r.statusCode, 422, r.body);
        assert.equal(r.headers['x-should-retry'], 'false');
        assert.ok(r.body.includes(code), r.body);
      }
      const resp = await s.request('POST', '/v1/responses', { model: id, input: 'x' });
      assert.equal(resp.statusCode, 200);
      assert.equal(resp.json().incomplete_details.reason, code);
      const cs = await s.request('POST', '/v1/messages', {
        model: id,
        max_tokens: 9,
        stream: true,
        messages: msgs,
      });
      const last = events(cs.body).at(-1)!;
      assert.equal(last.event, 'error');
      assert.equal(last.data.error.type, 'invalid_request_error');
      assert.equal(last.data.error.code, code);
      const gs = await s.request('POST', `${gemUrl}:streamGenerateContent?alt=sse`, gem);
      assert.match(
        gs.body,
        new RegExp(`"code":422,.*"status":"FAILED_PRECONDITION".*"reason":"${code}"`),
      );
    }
  } finally {
    await s.cleanup();
  }
});

test('gemini truncation: 200 with the partial text, plain and as a JSON-array stream', async () => {
  const { s, state } = await gateway();
  try {
    state.mode = 'len';
    const g = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', gem);
    assert.equal(g.statusCode, 200);
    assert.equal(g.json().candidates[0].content.parts[0].text, 'partial');
    const arr = await s.request('POST', '/v1beta/models/agent%2Ftest:streamGenerateContent', gem);
    assert.equal(arr.statusCode, 200);
    const chunks = JSON.parse(arr.body) as { candidates: { finishReason?: string }[] }[];
    assert.equal(chunks.at(-1)!.candidates[0]!.finishReason, 'MAX_TOKENS');
    const gs = await s.request(
      'POST',
      '/v1beta/models/agent%2Ftest:streamGenerateContent?alt=sse',
      gem,
    );
    assert.equal(gs.statusCode, 200);
    assert.doesNotMatch(gs.body, /"error"/);
  } finally {
    await s.cleanup();
  }
});

test('run-only codes: caller limits are the 422 class, service-side causes the 500 class (stream and plain)', async () => {
  const run = (code: string) =>
    ({ id: 'resp_x', status: 'incomplete', error: { code, message: 'm' } }) as never;
  const cases: [string, string, string, number][] = [
    ['turn_limit', 'invalid_request_error', 'FAILED_PRECONDITION', 422],
    ['token_budget', 'invalid_request_error', 'FAILED_PRECONDITION', 422],
    ['max_output_tokens', 'invalid_request_error', 'FAILED_PRECONDITION', 422],
    ['gateway_restarted', 'api_error', 'INTERNAL', 500],
    ['run_timeout', 'api_error', 'INTERNAL', 500],
    ['parent_interrupted', 'api_error', 'INTERNAL', 500],
  ];
  for (const [code, claudeType, geminiStatus, streamStatus] of cases) {
    // 流：problemStatus 决定流里错误帧的类别。
    assert.equal(problemStatus(run(code)), streamStatus, code);
    // 非流式：runFailure 仍是 422 加 x-should-retry: false，错误体的类别按语义。
    const fault = runFailure(run(code));
    assert.equal(fault.status, 422, code);
    assert.deepEqual(retryHeaders(422, fault), { 'x-should-retry': 'false' });
    const c = errorBody('claude', 422, fault) as { error: { type: string; code: string } };
    assert.equal(c.error.type, claudeType, code);
    assert.equal(c.error.code, code);
    const g = errorBody('gemini', 422, fault) as { error: { code: number; status: string } };
    assert.equal(g.error.code, 422, code);
    assert.equal(g.error.status, geminiStatus, code);
  }
});
