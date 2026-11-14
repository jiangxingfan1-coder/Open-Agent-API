/**
 * 官方 `@anthropic-ai/sdk` 实测 Claude Messages 兼容入口：错误映射、重试与调用方工具（桥接）。
 * 进程内（app.inject），不监听端口；网关见 test/anthropic-sdk-gateway.ts。
 *
 * SDK 的重试规则（node_modules/@anthropic-ai/sdk/client.js）：`shouldRetry`（约 838–870 行）先听
 * `x-should-retry: true/false`，否则 408、409、429、>=500 重试；默认 `maxRetries = 2`（约 168 行）；
 * 等待（`retryRequest`，约 873–903 行）先看 `retry-after-ms`，再看 `retry-after`（秒或 HTTP 日期），
 * 不在 (0, 2^31-1] 毫秒内时用指数退避。错误类按状态码（core/error.js `APIError.generate`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { principal } from './helpers.js';
import { gateway, runCount, user } from './anthropic-sdk-gateway.js';

type Body = {
  type: string;
  error: { type: string; message: string; code: string; run_id?: string };
};
const body = (e: InstanceType<typeof Anthropic.APIError>) => e.error as Body;

test('anthropic sdk: auth, permission, not-found and bad-request errors map to the SDK classes', async () => {
  const { s, client } = await gateway();
  try {
    await assert.rejects(
      client({ apiKey: 'wrong-token' }).messages.create({
        model: 'agent/test',
        max_tokens: 10,
        messages: user('hi'),
      }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.AuthenticationError, String(e));
        assert.equal(e.status, 401);
        assert.equal(e.type, 'authentication_error');
        assert.equal(body(e).type, 'error');
        return true;
      },
    );
    const scoped = String(
      s.auth.create(principal, 'bridge-only', ['agent/bridge'], ['read', 'invoke']).token,
    );
    await assert.rejects(
      client({ apiKey: scoped }).messages.create({
        model: 'agent/test',
        max_tokens: 10,
        messages: user('hi'),
      }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.PermissionDeniedError, String(e));
        assert.equal(e.type, 'permission_error');
        assert.equal(typeof body(e).error.code, 'string');
        return true;
      },
    );
    await assert.rejects(
      client().messages.create({ model: 'agent/none', max_tokens: 10, messages: user('hi') }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.NotFoundError, String(e));
        assert.equal(e.type, 'not_found_error');
        return true;
      },
    );
    await assert.rejects(
      client().messages.create({ model: 'agent/test', max_tokens: 10, messages: [] }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.BadRequestError, String(e));
        assert.equal(e.type, 'invalid_request_error');
        return true;
      },
    );
    await assert.rejects(
      client().messages.create({
        model: 'agent/test',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.BadRequestError, String(e));
        assert.equal(body(e).error.code, 'unsupported_content');
        assert.match(body(e).error.message, /POST \/v1\/files/);
        return true;
      },
    );
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: failed runs and pending approvals are one request, one run, 422 with the run id', async () => {
  const { s, state, client, requests } = await gateway();
  try {
    for (const [mode, model, code] of [
      ['fail', 'agent/test', 'execution_failed'],
      ['approval', 'agent/approve', 'action_required'],
    ] as const) {
      state.mode = mode;
      const before = runCount(s);
      const sent = requests();
      // 默认 maxRetries（2）：x-should-retry: false 让 SDK 不重试。
      await assert.rejects(
        client({ maxRetries: undefined }).messages.create({
          model,
          max_tokens: 10,
          messages: user('go'),
        }),
        (e: InstanceType<typeof Anthropic.APIError>) => {
          assert.ok(e instanceof Anthropic.UnprocessableEntityError, String(e));
          assert.equal(e.status, 422);
          assert.equal(e.headers?.get('x-should-retry'), 'false');
          assert.equal(body(e).error.code, code);
          assert.match(String(body(e).error.run_id), /^resp_/);
          return true;
        },
      );
      assert.equal(requests() - sent, 1, `${mode}: the SDK sent the request once`);
      assert.equal(runCount(s) - before, 1, `${mode}: exactly one run was created`);
    }
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: a run that fails mid-stream surfaces as an APIError with the gateway code', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'fail';
    await assert.rejects(
      client()
        .messages.stream({ model: 'agent/test', max_tokens: 10, messages: user('hi') })
        .finalMessage(),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.APIError, String(e));
        assert.equal(body(e).type, 'error');
        assert.equal(body(e).error.code, 'execution_failed');
        assert.match(body(e).error.message, /boom/);
        assert.equal(e.type, 'api_error');
        return true;
      },
    );
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: rate limits are RateLimitError with Retry-After; quota exhaustion is not retried', async () => {
  const { s, client, requests } = await gateway();
  try {
    const limited = String(
      s.auth.create(principal, 'rpm-key', ['*'], ['read', 'invoke'], { rpm: 1 }).token,
    );
    const c = client({ apiKey: limited, maxRetries: 0 });
    await c.messages.create({ model: 'agent/test', max_tokens: 10, messages: user('a') });
    const sent = requests();
    await assert.rejects(
      c.messages.create({ model: 'agent/test', max_tokens: 10, messages: user('b') }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.RateLimitError, String(e));
        assert.equal(e.type, 'rate_limit_error');
        const wait = Number(e.headers?.get('retry-after'));
        // 窗口真实的剩余秒数：SDK 重试时按它等待（retryRequest），而不是默认的半秒退避。
        assert.ok(wait >= 58 && wait <= 60, `retry-after ${wait}`);
        assert.equal(e.headers?.get('x-should-retry'), null, 'rpm limits stay retryable');
        return true;
      },
    );
    assert.equal(requests() - sent, 1);
    const quota = String(
      s.auth.create(principal, 'runs-key', ['*'], ['read', 'invoke'], { maxRuns: 0 }).token,
    );
    const before = requests();
    await assert.rejects(
      client({ apiKey: quota, maxRetries: undefined }).messages.create({
        model: 'agent/test',
        max_tokens: 10,
        messages: user('c'),
      }),
      (e: InstanceType<typeof Anthropic.APIError>) => {
        assert.ok(e instanceof Anthropic.RateLimitError, String(e));
        assert.equal(e.headers?.get('x-should-retry'), 'false');
        return true;
      },
    );
    assert.equal(requests() - before, 1, 'quota exhaustion is sent once even with retries on');
  } finally {
    await s.cleanup();
  }
});

const tool: Anthropic.Tool = {
  name: 'edit-file',
  description: 'Edit a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
};
const bridge = { 'x-oaa-client-tools': 'bridge' };

test('anthropic sdk: bridge mode hands tool_use blocks to the caller and resumes on tool_result', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'tools';
    const c = client({ defaultHeaders: bridge });
    const first = await c.messages.create({
      model: 'agent/bridge',
      max_tokens: 100,
      tools: [tool],
      messages: user('fix'),
    });
    assert.equal(first.stop_reason, 'tool_use');
    const uses = first.content.filter((b) => b.type === 'tool_use');
    assert.equal(uses.length, 1);
    assert.equal(typeof uses[0]!.id, 'string');
    assert.equal(uses[0]!.name, 'edit-file');
    assert.deepEqual(uses[0]!.input, { path: 'a.ts', line: 3 });
    const done = await c.messages.create({
      model: 'agent/bridge',
      max_tokens: 100,
      tools: [tool],
      messages: [
        { role: 'user', content: 'fix' },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: uses.map((u) => ({
            type: 'tool_result' as const,
            tool_use_id: u.id,
            content: 'ok',
          })),
        },
      ],
    });
    assert.equal(done.stop_reason, 'end_turn');
    assert.deepEqual(done.content, [{ type: 'text', text: 'Done ok' }]);
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: streamed bridge turns assemble input_json_delta into objects (one and two calls)', async () => {
  const { s, state, client } = await gateway();
  try {
    state.mode = 'tools';
    const c = client({ defaultHeaders: bridge });
    const stream = c.messages.stream({
      model: 'agent/bridge',
      max_tokens: 100,
      tools: [tool],
      messages: user('fix'),
    });
    const partials: string[] = [];
    stream.on('inputJson', (partial) => partials.push(partial));
    const final = await stream.finalMessage();
    assert.equal(final.stop_reason, 'tool_use');
    const use = final.content.find((b) => b.type === 'tool_use')!;
    assert.deepEqual(use.input, { path: 'a.ts', line: 3 });
    assert.ok(partials.length >= 1);

    state.mode = 'parallel';
    const two = await c.messages
      .stream({ model: 'agent/bridge', max_tokens: 100, tools: [tool], messages: user('fix') })
      .finalMessage();
    assert.equal(two.stop_reason, 'tool_use');
    const inputs = two.content.filter((b) => b.type === 'tool_use').map((b) => b.input);
    assert.deepEqual(inputs, [{ path: 'a.ts' }, { path: 'b.ts' }]);
    const ids = two.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    assert.equal(new Set(ids).size, 2);
    const resumed = await c.messages
      .stream({
        model: 'agent/bridge',
        max_tokens: 100,
        tools: [tool],
        messages: [
          { role: 'user', content: 'fix' },
          { role: 'assistant', content: two.content },
          {
            role: 'user',
            content: ids.map((id, i) => ({
              type: 'tool_result' as const,
              tool_use_id: id,
              content: `r${i}`,
            })),
          },
        ],
      })
      .finalMessage();
    assert.equal(resumed.stop_reason, 'end_turn');
    assert.deepEqual(resumed.content, [{ type: 'text', text: 'Done r0,r1' }]);
  } finally {
    await s.cleanup();
  }
});

test('anthropic sdk: explicit managed mode ignores tools and says so; the default hands them to a kernel agent', async () => {
  const { s, client } = await gateway();
  try {
    const { data, response } = await client({ defaultHeaders: { 'x-oaa-client-tools': 'managed' } })
      .messages.create({ model: 'agent/test', max_tokens: 10, tools: [tool], messages: user('hi') })
      .withResponse();
    assert.equal(data.stop_reason, 'end_turn');
    assert.equal(response.headers.get('x-oaa-client-tools'), 'ignored');
    // No mode chosen: the kernel agent can take the tools over, and the header says so.
    const auto = await client()
      .messages.create({ model: 'agent/test', max_tokens: 10, tools: [tool], messages: user('hi') })
      .withResponse();
    assert.equal(auto.response.headers.get('x-oaa-client-tools'), 'bridge');
  } finally {
    await s.cleanup();
  }
});
