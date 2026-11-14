import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicModel, GeminiModel } from '../src/providers/models.js';
import { providerSchema } from '../src/config/config.js';
import { Fault } from '../src/core/util.js';
import { agent, FixtureModel, setup } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const start = { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } };
const textStart = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
};
const textDelta = {
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text: 'partial' },
};
const blockStop = { type: 'content_block_stop', index: 0 };
const stop = { type: 'message_stop' };
const reason = (value: string) => ({
  type: 'message_delta',
  delta: { stop_reason: value },
  usage: { output_tokens: 3 },
});
const candidate = (parts: unknown[], finishReason?: string) => ({
  candidates: [
    { index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) },
  ],
});
const isFault = (code: string) => (error: unknown) => error instanceof Fault && error.code === code;

function call(
  t: TestContext,
  kind: 'anthropic-messages' | 'gemini-generate',
  events: unknown[],
  closed = true,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(events.map(frame).join('')));
      if (closed) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const config = providerSchema.parse({
    kind,
    baseUrl: 'https://fixture.invalid',
    apiKeyEnv: 'UNUSED',
    timeoutMs: options.timeoutMs ?? 1000,
  });
  const model =
    kind === 'anthropic-messages'
      ? new AnthropicModel(config, 'fixture')
      : new GeminiModel(config, 'fixture');
  const deltas: string[] = [];
  return {
    result: model.call(
      agent(),
      [{ role: 'user', content: 'fixture' }],
      options.signal ?? new AbortController().signal,
      (text) => deltas.push(text),
    ),
    deltas,
    cancelled: () => cancelled,
  };
}

test('Gemini partial text without finishReason is truncated, not successful', async (t) => {
  const run = call(t, 'gemini-generate', [candidate([{ text: 'partial' }])]);
  await assert.rejects(run.result, isFault('upstream_truncated'));
  assert.deepEqual(run.deltas, ['partial']);
});

for (const finish of ['SAFETY', 'RECITATION', 'MALFORMED_FUNCTION_CALL', 'OTHER', 'FUTURE_REASON'])
  test(`Gemini ${finish} cannot dispatch returned tool calls`, async (t) => {
    await assert.rejects(
      call(t, 'gemini-generate', [
        candidate(
          [{ functionCall: { id: 'call', name: 'write_file', args: { path: 'x', content: 'x' } } }],
          finish,
        ),
      ]).result,
      isFault('upstream_incomplete'),
    );
  });

test('Gemini prompt blocking is not a transport failure eligible for cascade', async (t) => {
  await assert.rejects(
    call(t, 'gemini-generate', [{ promptFeedback: { blockReason: 'SAFETY' } }]).result,
    isFault('upstream_incomplete'),
  );
});

test('Gemini thought text is not exposed as answer text', async (t) => {
  const run = call(t, 'gemini-generate', [
    candidate([{ text: 'internal', thought: true }, { text: 'answer' }], 'STOP'),
  ]);
  assert.equal((await run.result).text, 'answer');
  assert.deepEqual(run.deltas, ['answer']);
});

test('Gemini rejects invalid token accounting instead of poisoning run budgets', async (t) => {
  await assert.rejects(
    call(t, 'gemini-generate', [
      {
        ...candidate([{ text: 'answer' }], 'STOP'),
        usageMetadata: { promptTokenCount: -10, candidatesTokenCount: 1, totalTokenCount: -9 },
      },
    ]).result,
    isFault('invalid_model_result'),
  );
});

test('Anthropic stop_reason without message_stop is a truncated stream', async (t) => {
  await assert.rejects(
    call(t, 'anthropic-messages', [start, textStart, textDelta, blockStop, reason('end_turn')])
      .result,
    isFault('upstream_truncated'),
  );
});

for (const finish of ['refusal', 'pause_turn', 'future_reason'])
  test(`Anthropic ${finish} is not an ordinary completed answer`, async (t) => {
    await assert.rejects(
      call(t, 'anthropic-messages', [start, textStart, textDelta, blockStop, reason(finish), stop])
        .result,
      isFault('upstream_incomplete'),
    );
  });

test('Anthropic incomplete content blocks cannot be committed as a model turn', async (t) => {
  await assert.rejects(
    call(t, 'anthropic-messages', [start, textStart, textDelta, reason('end_turn'), stop]).result,
    isFault('invalid_model_result'),
  );
});

test('Anthropic terminal message releases a connection that stays open', async (t) => {
  const run = call(
    t,
    'anthropic-messages',
    [start, textStart, textDelta, blockStop, reason('end_turn'), stop],
    false,
  );
  const outcome = await Promise.race([
    run.result,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('terminal stream was not released')), 100);
      timer.unref();
    }),
  ]);
  assert.equal(outcome.text, 'partial');
  assert.deepEqual(outcome.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
  assert.equal(run.cancelled(), true);
});

for (const kind of ['anthropic-messages', 'gemini-generate'] as const) {
  test(`${kind} distinguishes provider timeout from user cancellation and closes idle bodies`, async (t) => {
    const guard = setTimeout(() => {}, 2000);
    try {
      const timedOut = call(t, kind, [], false, { timeoutMs: 100 });
      await assert.rejects(timedOut.result, isFault('upstream_timeout'));
      assert.equal(timedOut.cancelled(), true);
      const controller = new AbortController();
      const cancelled = call(t, kind, [], false, { signal: controller.signal });
      const rejected = assert.rejects(cancelled.result, isFault('cancelled'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      await rejected;
      assert.equal(cancelled.cancelled(), true);
    } finally {
      clearTimeout(guard);
    }
  });
}

test('Gemini token truncation discards partial tool arguments instead of producing executable calls', async (t) => {
  const result = await call(t, 'gemini-generate', [
    candidate(
      [{ text: 'partial' }, { functionCall: { name: 'write_file', args: 'unfinished' } }],
      'MAX_TOKENS',
    ),
  ]).result;
  assert.equal(result.finish, 'length');
  assert.deepEqual(result.calls, []);
});

test('Anthropic context truncation retains usage without parsing incomplete tool arguments', async (t) => {
  const result = await call(t, 'anthropic-messages', [
    start,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool', name: 'write_file', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    },
    blockStop,
    reason('model_context_window_exceeded'),
    stop,
  ]).result;
  assert.equal(result.finish, 'length');
  assert.deepEqual(result.calls, []);
  assert.equal(result.usage?.total_tokens, 15);
});

test('missing usage is not converted into a fabricated zero-token measurement', async (t) => {
  const result = await call(t, 'anthropic-messages', [
    { type: 'message_start', message: {} },
    textStart,
    textDelta,
    blockStop,
    reason('end_turn'),
    stop,
  ]).result;
  assert.equal(result.text, 'partial');
  assert.equal(result.usage, null);
});

test('duplicate Gemini function IDs and non-object inputs are rejected before dispatch', async (t) => {
  for (const parts of [
    [
      { functionCall: { id: 'same', name: 'read', args: {} } },
      { functionCall: { id: 'same', name: 'write', args: {} } },
    ],
    [{ functionCall: { name: 'write', args: ['invalid'] } }],
  ])
    await assert.rejects(
      call(t, 'gemini-generate', [candidate(parts, 'STOP')]).result,
      isFault('invalid_model_result'),
    );
});

test('provider refusal remains a failed API run without tool dispatch or automatic route cascade', async (t) => {
  let requests = 0,
    fallbacks = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(
      frame(
        candidate(
          [
            {
              functionCall: {
                name: 'memory_write',
                args: { key: 'must-not-execute', value: 'fixture' },
              },
            },
          ],
          'SAFETY',
        ),
      ),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const driver = new GeminiModel(
    providerSchema.parse({
      kind: 'gemini-generate',
      baseUrl: 'https://fixture.invalid',
      apiKeyEnv: 'UNUSED',
    }),
    'fixture',
  );
  const s = await setup(
    new FixtureModel(async (definition, messages, signal) => {
      if (definition.model === 'fallback') {
        fallbacks++;
        return { text: 'unexpected fallback' };
      }
      return await driver.call(definition, messages, signal, () => {});
    }),
  );
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [builtin('memory_write')],
          routes: [
            { id: 'primary', provider: 'fixture', model: 'primary', priority: 0 },
            { id: 'fallback', provider: 'fixture', model: 'fallback', priority: 1 },
          ],
        }),
      ),
    );
    const accepted = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'fixture',
      model: 'auto',
      background: true,
    });
    assert.ok(accepted.statusCode < 300, accepted.body);
    const run = await s.kernel.wait(accepted.json().id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error?.code, 'upstream_incomplete');
    assert.equal(run.route.id, 'primary');
    assert.equal(requests, 1);
    assert.equal(fallbacks, 0);
    assert.deepEqual(s.store.steps(run.id), []);
  } finally {
    await s.cleanup();
  }
});

test('malformed Gemini payload shapes fail as protocol errors, not retryable transport errors', async (t) => {
  for (const value of [
    { candidates: {} },
    { candidates: [null] },
    candidate([null], 'STOP'),
    candidate([{ text: 123 }], 'STOP'),
    candidate([{ functionCall: 'bad' }], 'STOP'),
  ])
    await assert.rejects(
      call(t, 'gemini-generate', [value]).result,
      isFault('invalid_model_result'),
    );
});

test('Anthropic cannot silently drop malformed deltas or coerce primitive tool arguments', async (t) => {
  await assert.rejects(
    call(t, 'anthropic-messages', [
      start,
      textStart,
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 123 } },
      blockStop,
      reason('end_turn'),
      stop,
    ]).result,
    isFault('invalid_model_result'),
  );
  await assert.rejects(
    call(t, 'anthropic-messages', [
      start,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'write', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '123' },
      },
      blockStop,
      reason('tool_use'),
      stop,
    ]).result,
    isFault('invalid_model_result'),
  );
});
