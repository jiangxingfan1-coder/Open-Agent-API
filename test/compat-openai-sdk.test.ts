/**
 * 用官方 `openai` SDK（node_modules/openai，经自定义 fetch 接到 app.inject，不监听端口）核对
 * OpenAI 兼容面：错误形状、截断、重试头、桥接往返等协议修正的回归。
 *
 * SDK 的重试规则（node_modules/openai/client.js `shouldRetry`）：服务端给 `x-should-retry: true/false`
 * 时听从它；否则 408、409、429、>=500 重试，默认 maxRetries = 2。OpenAI 客户端不设
 * `idempotencyHeader`，所以重试不会带幂等键（client.js 的 `idempotencyHeaders` 分支不生效）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { setup, agent, FixtureModel, token, principal } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import type { AgentDefinition } from '../src/core/contracts.js';

type Mode = 'ok' | 'len' | 'fail' | 'tools' | 'approval';

async function gateway() {
  const state = { mode: 'ok' as Mode, seen: [] as AgentDefinition[] };
  const model = new FixtureModel((a, messages) => {
    state.seen.push(a);
    if (state.mode === 'fail') throw new Error('boom');
    if (state.mode === 'len') return { text: 'partial text', finish: 'length' };
    if (state.mode === 'approval')
      return messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a', content: 'b' } }] };
    if (state.mode === 'tools') {
      const results = messages.filter((m) => m.role === 'tool');
      if (!results.length)
        return { text: 'Editing.', calls: [{ id: 'm1', name: 'edit_file', arguments: { p: 1 } }] };
      return { text: `Done ${results.map((r) => r.content).join(',')}` };
    }
    return { text: 'Hello world from fixture.' };
  });
  const s = await setup(model);
  s.store.publish('owner', makeBundle(agent()));
  s.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  const write = builtin('write_file');
  write.capability.requiresApproval = true;
  s.store.publish('owner', makeBundle(agent({ id: 'agent/approve', tools: [write] })));
  let requests = 0;
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests++;
    const u = new URL(String(url));
    const r = await s.app.inject({
      method: init.method as 'GET',
      url: u.pathname + u.search,
      payload: init.body as string,
      headers: Object.fromEntries(new Headers(init.headers)),
    });
    return new Response(new Uint8Array(r.rawPayload), {
      status: r.statusCode,
      headers: r.headers as Record<string, string>,
    });
  };
  const client = (base = 'http://x/v1', headers: Record<string, string> = {}, apiKey = token) =>
    new OpenAI({ apiKey, baseURL: base, fetch, defaultHeaders: headers, maxRetries: 2 });
  return { s, state, client, requests: () => requests };
}
const runCount = (s: Awaited<ReturnType<typeof setup>>) =>
  s.store.summaries('owner', ['*'], 200).length;

test('openai sdk: Chat and Responses, plain and streamed, parse without errors', async () => {
  const { s, client } = await gateway();
  try {
    const c = client();
    const chat = await c.chat.completions.create({
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(chat.choices[0]!.finish_reason, 'stop');
    const streamed = await c.chat.completions
      .stream({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'hi' }],
        stream_options: { include_usage: true },
      })
      .finalChatCompletion();
    assert.equal(streamed.choices[0]!.message.content, 'Hello world from fixture.');
    const response = await c.responses.stream({ model: 'agent/test', input: 'hi' }).finalResponse();
    assert.equal(response.output_text, 'Hello world from fixture.');
    // 官方 ResponseUsage 里必填的明细对象。
    assert.deepEqual(response.usage?.input_tokens_details, { cached_tokens: 0 });
    assert.deepEqual(response.usage?.output_tokens_details, { reasoning_tokens: 0 });
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: truncation is finish_reason "length" with the partial text', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'len';
    const c = client();
    const plain = await c.chat.completions.create({
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(plain.choices[0]!.finish_reason, 'length');
    assert.equal(plain.choices[0]!.message.content, 'partial text');
    const streamed = await c.chat.completions
      .stream({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'hi' }],
        stream_options: { include_usage: true },
      })
      .finalChatCompletion();
    assert.equal(streamed.choices[0]!.finish_reason, 'length');
    assert.equal(streamed.choices[0]!.message.content, 'partial text');
    assert.equal(streamed.usage?.total_tokens, 15);
    const raw = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.ok(raw.body.endsWith('data: [DONE]\n\n'));
    const resp = await c.responses.create({ model: 'agent/test', input: 'hi' });
    assert.equal(resp.status, 'incomplete');
    assert.equal(resp.incomplete_details?.reason, 'max_output_tokens');
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: a failed run is not retried and carries the real reason', async () => {
  const { s, state, client, requests } = await gateway();
  try {
    state.mode = 'fail';
    const c = client();
    const before = runCount(s);
    const sent = requests();
    await assert.rejects(
      c.chat.completions.create({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (e: InstanceType<typeof OpenAI.UnprocessableEntityError>) => {
        assert.ok(e instanceof OpenAI.UnprocessableEntityError);
        assert.equal(e.status, 422);
        assert.equal(e.code, 'execution_failed');
        assert.match(e.message, /boom/);
        assert.equal(e.headers.get('x-should-retry'), 'false');
        return true;
      },
    );
    assert.equal(requests() - sent, 1, 'the SDK sent the request once');
    assert.equal(runCount(s) - before, 1, 'exactly one run was created');

    // 流里的错误：真实的错误码与原因（不再是固定的 “requires attention”）。
    await assert.rejects(
      c.chat.completions
        .stream({ model: 'agent/test', messages: [{ role: 'user', content: 'hi' }] })
        .finalChatCompletion(),
      (e: InstanceType<typeof OpenAI.APIError>) => {
        assert.equal(e.code, 'execution_failed');
        assert.match(e.message, /boom/);
        assert.equal(e.type, 'server_error');
        return true;
      },
    );
    // Responses：失败照常是 200 的 response 对象（status: failed）。
    const r = await c.responses.create({ model: 'agent/test', input: 'hi' });
    assert.equal(r.status, 'failed');
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: a pending approval is one run, 422 action_required, never retried', async () => {
  const { s, state, client, requests } = await gateway();
  try {
    state.mode = 'approval';
    const before = runCount(s);
    const sent = requests();
    await assert.rejects(
      client().chat.completions.create({
        model: 'agent/approve',
        messages: [{ role: 'user', content: 'write' }],
      }),
      (e: InstanceType<typeof OpenAI.APIError>) => {
        assert.ok(e instanceof OpenAI.UnprocessableEntityError);
        assert.equal(e.code, 'action_required');
        assert.match(e.message, /actions/);
        assert.equal(e.headers.get('x-should-retry'), 'false');
        assert.match(String((e.error as { run_id?: string }).run_id), /^resp_/);
        return true;
      },
    );
    assert.equal(requests() - sent, 1);
    assert.equal(runCount(s) - before, 1);
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: rate limits stay retryable and say when (Retry-After)', async () => {
  const { s, client, requests } = await gateway();
  try {
    const limited = String(
      s.auth.create(principal, 'rpm-key', ['*'], ['read', 'invoke'], { rpm: 1 }).token,
    );
    const c = client('http://x/v1', {}, limited);
    await c.chat.completions.create({
      model: 'agent/test',
      messages: [{ role: 'user', content: 'a' }],
    });
    const raw = await s.request('GET', '/v1/models', undefined, limited);
    assert.equal(raw.statusCode, 429);
    // 窗口真实的剩余秒数：刚进入窗口，剩余接近 60 秒。
    const wait = Number(raw.headers['retry-after']);
    assert.ok(wait >= 58 && wait <= 60, `retry-after ${wait}`);
    assert.equal(raw.headers['x-should-retry'], undefined);
    const sent = requests();
    await assert.rejects(
      new OpenAI({
        apiKey: limited,
        baseURL: 'http://x/v1',
        maxRetries: 0,
        fetch: async (u, i) => {
          const url = new URL(String(u));
          const r = await s.app.inject({
            method: i?.method as 'POST',
            url: url.pathname,
            payload: i?.body as string,
            headers: Object.fromEntries(new Headers(i?.headers)),
          });
          return new Response(new Uint8Array(r.rawPayload), {
            status: r.statusCode,
            headers: r.headers as Record<string, string>,
          });
        },
      }).chat.completions.create({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'b' }],
      }),
      (e: InstanceType<typeof OpenAI.APIError>) => e instanceof OpenAI.RateLimitError,
    );
    assert.equal(requests(), sent);
    // 配额耗尽不可重试：x-should-retry: false。
    const quota = String(
      s.auth.create(principal, 'runs-key', ['*'], ['read', 'invoke'], { maxRuns: 0 }).token,
    );
    const exhausted = await s.request(
      'POST',
      '/v1/chat/completions',
      { model: 'agent/test', messages: [{ role: 'user', content: 'c' }] },
      quota,
    );
    assert.equal(exhausted.statusCode, 429);
    assert.equal(exhausted.headers['x-should-retry'], 'false');
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: strict endpoints name the unsupported parameter and report ignored ones', async () => {
  const { s, client } = await gateway();
  try {
    await assert.rejects(
      client().chat.completions.create({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'hi' }],
        logprobs: true,
      }),
      (e: InstanceType<typeof OpenAI.APIError>) => {
        assert.ok(e instanceof OpenAI.BadRequestError);
        assert.equal(e.code, 'unsupported_parameter');
        assert.equal(e.param, 'logprobs');
        assert.match(e.message, /logprobs/);
        return true;
      },
    );
    const raw = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      seed: 1,
      n: 1,
    });
    assert.equal(raw.statusCode, 200, raw.body);
    assert.equal(raw.headers['x-oaa-ignored-params'], 'temperature, seed, n');
    const plain = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(plain.headers['x-oaa-ignored-params'], undefined);
    const invalid = await s.request('POST', '/v1/responses', { model: 'agent/test' });
    assert.equal(invalid.json().error.param, 'input');
    assert.doesNotMatch(invalid.json().error.message, /^: /);
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: max_tokens / max_output_tokens cap the model call, never raise it', async () => {
  const { s, state, client } = await gateway();
  try {
    const c = client();
    await c.chat.completions.create({
      model: 'agent/test',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(state.seen.at(-1)!.limits.maxOutputTokens, 50);
    await c.responses.create({ model: 'agent/test', input: 'hi', max_output_tokens: 99_999 });
    assert.equal(state.seen.at(-1)!.limits.maxOutputTokens, 4096, 'the agent limit wins');
    await client('http://x/v1/compat').responses.create({
      model: 'agent/test',
      input: 'hi',
      max_output_tokens: 70,
    });
    assert.equal(state.seen.at(-1)!.limits.maxOutputTokens, 70);
    await c.chat.completions.create({
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(state.seen.at(-1)!.limits.maxOutputTokens, 4096);
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: GET /v1/responses/{id}?stream=true reconnects; sequence numbers start at 0', async () => {
  const { s, client } = await gateway();
  try {
    const c = client();
    const created = await c.responses.create({
      model: 'agent/test',
      input: 'hi',
      background: true,
    });
    const final = await c.responses.stream({ response_id: created.id }).finalResponse();
    assert.equal(final.status, 'completed');
    assert.equal(final.output_text, 'Hello world from fixture.');
    const replay = await s.request('GET', `/v1/responses/${created.id}?stream=true`);
    assert.match(String(replay.headers['content-type']), /text\/event-stream/);
    const seqs = [...replay.body.matchAll(/"sequence_number":(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(
      seqs,
      seqs.map((_, i) => i),
    );
    const after = await s.request(
      'GET',
      `/v1/responses/${created.id}?stream=true&starting_after=2`,
    );
    const later = [...after.body.matchAll(/"sequence_number":(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(later, seqs.slice(3));
    const json = await s.request('GET', `/v1/responses/${created.id}`);
    assert.equal(json.json().object, 'response');
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: bridge round trip keeps one response id per task', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'tools';
    const cc = client('http://x/v1/compat', { 'x-oaa-client-tools': 'bridge' });
    const tool = {
      type: 'function' as const,
      name: 'edit-file',
      strict: false,
      parameters: { type: 'object', properties: {} },
    };
    const first = await cc.responses
      .stream({ model: 'agent/bridge', input: 'fix', tools: [tool] })
      .finalResponse();
    const calls = first.output.filter((o) => o.type === 'function_call');
    assert.equal(calls.length, 1);
    const next = await cc.responses.create({
      model: 'agent/bridge',
      tools: [tool],
      previous_response_id: first.id,
      input: calls.map((o) => ({
        type: 'function_call_output' as const,
        call_id: o.call_id,
        output: 'ok',
      })),
    });
    assert.equal(next.id, first.id);
    assert.equal(next.output_text, 'Done ok');
    const chatTool = {
      type: 'function' as const,
      function: { name: 'edit-file', parameters: { type: 'object', properties: {} } },
    };
    const turn = await cc.chat.completions
      .stream({
        model: 'agent/bridge',
        messages: [{ role: 'user', content: 'fix' }],
        tools: [chatTool],
      })
      .finalChatCompletion();
    assert.equal(turn.choices[0]!.finish_reason, 'tool_calls');
    const toolCalls = turn.choices[0]!.message.tool_calls!;
    const done = await cc.chat.completions.create({
      model: 'agent/bridge',
      tools: [chatTool],
      messages: [
        { role: 'user', content: 'fix' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
        ...toolCalls.map((t) => ({ role: 'tool' as const, tool_call_id: t.id, content: 'ok' })),
      ],
    });
    assert.equal(done.choices[0]!.finish_reason, 'stop');
    assert.equal(done.choices[0]!.message.content, 'Done ok');
  } finally {
    await s.cleanup();
  }
});

test('openai sdk: truncated Responses stream ends normally as incomplete; every entry answers 200', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'len';
    const c = client();
    const final = await c.responses.stream({ model: 'agent/test', input: 'hi' }).finalResponse();
    assert.equal(final.status, 'incomplete');
    assert.equal(final.incomplete_details?.reason, 'max_output_tokens');
    assert.equal(final.output_text, 'partial text');
    const raw = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'hi',
      stream: true,
    });
    assert.equal(raw.statusCode, 200);
    assert.match(raw.body, /event: response\.incomplete\n/);
    assert.doesNotMatch(raw.body, /event: (error|response\.failed)\n/);
    const plain = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.json().status, 'incomplete');
    const chat = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(chat.statusCode, 200);
    assert.equal(chat.json().choices[0].finish_reason, 'length');
    assert.equal(chat.json().choices[0].message.content, 'partial text');
  } finally {
    await s.cleanup();
  }
});
