import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OpenAIModel } from '../src/providers/models.js';
import { providerSchema } from '../src/config/config.js';
import { Fault } from '../src/core/util.js';
import { agent } from './helpers.js';

// 本机回环上的假模型服务：不调用真实模型，不访问外网。
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, any>) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  process.env.OAA_OPENAI_DRIVER_FIXTURE = 'fixture-no-real-credential';
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OAA_OPENAI_DRIVER_FIXTURE;
  }
}
const driver = (baseUrl: string, kind: 'openai-chat' | 'openai-responses', extra = {}) =>
  new OpenAIModel(
    providerSchema.parse({ kind, baseUrl, apiKeyEnv: 'OAA_OPENAI_DRIVER_FIXTURE', ...extra }),
  );
const live = () => new AbortController().signal;
const sse = (res: ServerResponse, frames: unknown[], done = true) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  if (done) res.end('data: [DONE]\n\n');
};
const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

test('Chat：请求只发往 /chat/completions，带密钥，文本和用量解析正确', async () => {
  let seen: { url?: string; auth?: string; body?: Record<string, any> } = {};
  await withServer(
    (req, res, body) => {
      seen = { url: req.url, auth: req.headers.authorization, body };
      sse(res, [
        chatChunk({ content: 'Hel' }),
        chatChunk({ content: 'lo' }, 'stop'),
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ]);
    },
    async (baseUrl) => {
      const deltas: string[] = [];
      const result = await driver(baseUrl, 'openai-chat').call(
        agent(),
        [{ role: 'user', content: 'hi' }],
        live(),
        (text) => deltas.push(text),
      );
      assert.equal(result.text, 'Hello');
      assert.deepEqual(deltas, ['Hel', 'lo']);
      assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
      assert.equal(result.finish, 'stop');
      assert.equal(seen.url, '/v1/chat/completions');
      assert.equal(seen.auth, 'Bearer fixture-no-real-credential');
      assert.equal(seen.body!.stream, true);
      assert.deepEqual(seen.body!.stream_options, { include_usage: true });
      assert.deepEqual(seen.body!.messages, [{ role: 'user', content: 'hi' }]);
    },
  );
});

test('HTTP 错误、限流、连接失败和流里的错误都映射成稳定的错误码', async () => {
  for (const [status, code, http] of [
    [429, 'upstream_rate_limited', 429],
    [500, 'upstream_failed', 502],
    [401, 'upstream_auth_failed', 502],
    [404, 'upstream_model_not_found', 502],
  ] as const)
    await withServer(
      (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"secret upstream detail"}}');
      },
      async (baseUrl) => {
        await assert.rejects(
          driver(baseUrl, 'openai-chat').call(
            agent(),
            [{ role: 'user', content: 'x' }],
            live(),
            () => {},
          ),
          (e: Fault) =>
            e.code === code &&
            e.status === http &&
            e.message.includes(`HTTP ${status}`) &&
            e.message.includes(baseUrl) &&
            !e.message.includes('secret'),
        );
      },
    );
  // 流里夹带错误对象
  await withServer(
    (_req, res) => sse(res, [{ error: { message: 'overloaded' } }]),
    async (baseUrl) => {
      await assert.rejects(
        driver(baseUrl, 'openai-chat').call(
          agent(),
          [{ role: 'user', content: 'x' }],
          live(),
          () => {},
        ),
        (e: Fault) => e.code === 'upstream_failed' && /HTTP unknown/.test(e.message),
      );
    },
  );
  // 连不上
  await assert.rejects(
    (async () => {
      process.env.OAA_OPENAI_DRIVER_FIXTURE = 'fixture-no-real-credential';
      try {
        await driver('http://127.0.0.1:9/v1', 'openai-chat').call(
          agent(),
          [{ role: 'user', content: 'x' }],
          live(),
          () => {},
        );
      } finally {
        delete process.env.OAA_OPENAI_DRIVER_FIXTURE;
      }
    })(),
    (e: Fault) => e.code === 'upstream_failed' && /HTTP unknown/.test(e.message),
  );
});

test('超时只管到收到响应头：迟迟不响应会失败，已经开始的长回答不会被掐断', async () => {
  // 一直不回响应头
  await withServer(
    () => {},
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        driver(baseUrl, 'openai-chat', { timeoutMs: 150 }).call(
          agent(),
          [{ role: 'user', content: 'x' }],
          live(),
          () => {},
        ),
        (e: Fault) => e.code === 'upstream_failed' && /HTTP unknown/.test(e.message),
      );
      assert.ok(Date.now() - started < 2000);
    },
  );
  // 响应头很快回来，但流持续的时间超过了超时值
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chatChunk({ content: 'slow ' }))}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify(chatChunk({ content: 'answer' }, 'stop'))}\n\n`);
        res.end('data: [DONE]\n\n');
      }, 400);
    },
    async (baseUrl) => {
      const result = await driver(baseUrl, 'openai-chat', { timeoutMs: 150 }).call(
        agent(),
        [{ role: 'user', content: 'x' }],
        live(),
        () => {},
      );
      assert.equal(result.text, 'slow answer');
    },
  );
});

test('调用方取消时报 cancelled；流没有结束标记时报 upstream_truncated', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chatChunk({ content: 'partial' }))}\n\n`);
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const task = driver(baseUrl, 'openai-chat').call(
        agent(),
        [{ role: 'user', content: 'x' }],
        controller.signal,
        () => controller.abort(),
      );
      await assert.rejects(task, (e: Fault) => e.code === 'cancelled' && e.status === 409);
    },
  );
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chatChunk({ content: 'no finish' }))}\n\n`);
    },
    async (baseUrl) => {
      await assert.rejects(
        driver(baseUrl, 'openai-chat').call(
          agent(),
          [{ role: 'user', content: 'x' }],
          live(),
          () => {},
        ),
        (e: Fault) => e.code === 'upstream_truncated',
      );
    },
  );
});

test('Responses：解析终态、工具调用与用量；重放上一轮条目时去掉输出专有字段', async () => {
  const bodies: Record<string, any>[] = [];
  await withServer(
    (req, res, body) => {
      bodies.push({ url: req.url, ...body });
      sse(
        res,
        [
          { type: 'response.output_text.delta', delta: 'Hi' },
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'msg_1',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Hi' }],
                },
                {
                  type: 'function_call',
                  id: 'fc_1',
                  call_id: 'call_1',
                  name: 'lookup',
                  arguments: '{"q":"x"}',
                },
              ],
              usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
            },
          },
        ],
        false,
      );
      res.end();
    },
    async (baseUrl) => {
      const model = driver(baseUrl, 'openai-responses');
      const first = await model.call(agent(), [{ role: 'user', content: 'go' }], live(), () => {});
      assert.equal(first.text, 'Hi');
      assert.deepEqual(first.calls, [{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }]);
      assert.equal(first.finish, 'tool_calls');
      assert.deepEqual(first.usage, { input_tokens: 4, output_tokens: 6, total_tokens: 10 });
      assert.equal(bodies[0]!.url, '/v1/responses');
      assert.equal(bodies[0]!.store, false);

      // 第二轮：带着上一轮的原始条目（混入输出专有字段）和工具结果再次调用。
      await model.call(
        agent(),
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'Hi',
            tool_calls: first.calls,
            providerItems: [
              {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                created_by: 'x',
                content: [{ type: 'output_text', text: 'Hi', parsed: { a: 1 } }],
              },
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'lookup',
                arguments: '{"q":"x"}',
                parsed_arguments: { q: 'x' },
                created_by: 'x',
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
        ],
        live(),
        () => {},
      );
      assert.deepEqual(bodies[1]!.input, [
        { role: 'user', content: 'go' },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi' }],
        },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      ]);

      // 不认识的条目类型不能悄悄重放。
      await assert.rejects(
        model.call(
          agent(),
          [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', providerItems: [{ type: 'made_up_item' }] },
          ],
          live(),
          () => {},
        ),
        (e: Fault) => e.code === 'invalid_provider_state',
      );
    },
  );
});

test('Responses：上游报告失败或没有终态时不算成功', async () => {
  await withServer(
    (_req, res) => {
      sse(
        res,
        [{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }],
        false,
      );
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        driver(baseUrl, 'openai-responses').call(
          agent(),
          [{ role: 'user', content: 'x' }],
          live(),
          () => {},
        ),
        (e: Fault) => e.code === 'upstream_failed' && e.message === 'model overloaded',
      );
    },
  );
  await withServer(
    (_req, res) => {
      sse(res, [{ type: 'response.output_text.delta', delta: 'half' }], false);
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        driver(baseUrl, 'openai-responses').call(
          agent(),
          [{ role: 'user', content: 'x' }],
          live(),
          () => {},
        ),
        (e: Fault) => e.code === 'upstream_truncated',
      );
    },
  );
});
