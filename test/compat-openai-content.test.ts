/**
 * OpenAI 兼容入口的非文本内容：内联图片、音频与
 * 不认识的内容块明确拒绝（400 `unsupported_content`），不创建运行，也不把 base64 塞进提示词。
 * 官方 `openai` SDK 经自定义 fetch 接 app.inject，不监听端口。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { setup, agent, FixtureModel, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

async function gateway() {
  const prompts: string[] = [];
  const model = new FixtureModel((_a, messages) => {
    prompts.push(messages.map((m) => String(m.content ?? '')).join('\n'));
    return { text: 'ok' };
  });
  const s = await setup(model);
  s.store.publish('owner', makeBundle(agent()));
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const r = await s.app.inject({
      method: init.method as 'POST',
      url: u.pathname + u.search,
      payload: init.body as string,
      headers: Object.fromEntries(new Headers(init.headers)),
    });
    return new Response(new Uint8Array(r.rawPayload), {
      status: r.statusCode,
      headers: r.headers as Record<string, string>,
    });
  };
  const client = (base: string) =>
    new OpenAI({ apiKey: token, baseURL: base, fetch, maxRetries: 0 });
  const runs = () => s.store.summaries('owner', ['*'], 200).length;
  return { s, prompts, client, runs };
}

type Case = { name: string; part: Record<string, unknown> };
const chatCases: Case[] = [
  {
    name: 'image_url data:',
    part: { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
  },
  {
    name: 'image_url https:',
    part: { type: 'image_url', image_url: { url: 'https://e.x/a.png' } },
  },
  { name: 'input_audio', part: { type: 'input_audio', input_audio: { data: B64, format: 'wav' } } },
  { name: 'unknown', part: { type: 'hologram', data: B64 } },
];
const responsesCases: Case[] = [
  { name: 'input_image', part: { type: 'input_image', image_url: `data:image/png;base64,${B64}` } },
  { name: 'input_audio', part: { type: 'input_audio', input_audio: { data: B64, format: 'mp3' } } },
  { name: 'unknown', part: { type: 'hologram', data: B64 } },
];

const chatBody = (part: Record<string, unknown>) => ({
  model: 'agent/test',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [part, { type: 'text', text: 'what is this?' }] },
  ],
});
const responsesBody = (part: Record<string, unknown>) => ({
  model: 'agent/test',
  input: [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { role: 'user', content: [part] },
  ],
});

function assertSdk(e: unknown, param: string) {
  const err = e as InstanceType<typeof OpenAI.BadRequestError>;
  assertRejected(err.status, { error: { code: err.code ?? undefined, param: err.param } }, param);
}

function assertRejected(
  status: number,
  body: { error?: { code?: string; param?: string | null } },
  param: string,
) {
  assert.equal(status, 400);
  assert.equal(body.error?.code, 'unsupported_content');
  assert.equal(body.error?.param, param);
}

test('openai content: Chat image / audio / unknown parts are rejected on every Chat entry', async () => {
  const { s, prompts, client, runs } = await gateway();
  try {
    for (const c of chatCases) {
      for (const base of ['http://x/v1', 'http://x/v1/compat']) {
        let caught: unknown;
        try {
          await client(base).chat.completions.create(chatBody(c.part) as never);
        } catch (e) {
          caught = e;
        }
        assert.ok(caught instanceof OpenAI.BadRequestError, `${c.name} ${base}`);
        assertSdk(caught, 'messages.1.content.0');
      }
      const uni = await s.app.inject({
        method: 'POST',
        url: '/v1/universal',
        headers: { authorization: `Bearer ${token}`, 'x-oaa-protocol': 'chat' },
        payload: chatBody(c.part),
      });
      assertRejected(uni.statusCode, uni.json(), 'messages.1.content.0');
    }
    assert.equal(runs(), 0);
    assert.ok(!prompts.some((p) => p.includes(B64)));
  } finally {
    await s.cleanup();
  }
});

test('openai content: Responses image / audio / unknown parts are rejected on every Responses entry', async () => {
  const { s, prompts, client, runs } = await gateway();
  try {
    for (const c of responsesCases) {
      for (const base of ['http://x/v1', 'http://x/v1/compat']) {
        let caught: unknown;
        try {
          await client(base).responses.create(responsesBody(c.part) as never);
        } catch (e) {
          caught = e;
        }
        assert.ok(caught instanceof OpenAI.BadRequestError, `${c.name} ${base}`);
        assertSdk(caught, 'input.1.content.0');
      }
      const uni = await s.app.inject({
        method: 'POST',
        url: '/v1/universal',
        headers: { authorization: `Bearer ${token}`, 'x-oaa-protocol': 'responses' },
        payload: responsesBody(c.part),
      });
      assertRejected(uni.statusCode, uni.json(), 'input.1.content.0');
    }
    // 不认识的输入项（不是消息、也不是函数调用 / 输出）同样拒绝，不整块序列化。
    const odd = await s.request('POST', '/v1/compat/responses', {
      model: 'agent/test',
      input: [{ type: 'computer_screenshot', image: B64 }],
    });
    assertRejected(odd.statusCode, odd.json(), 'input.0');
    assert.equal(runs(), 0);
    assert.ok(!prompts.some((p) => p.includes(B64)));
  } finally {
    await s.cleanup();
  }
});

test('openai content: text, file references and tool annotations still reach the agent', async () => {
  const { s, prompts, client } = await gateway();
  try {
    const c = client('http://x/v1/compat');
    await c.chat.completions.create({
      model: 'agent/test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'plain chat text' }] },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'look', arguments: '{"q":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 't1', content: 'tool said yes' },
      ],
    });
    const last = prompts.at(-1)!;
    assert.match(last, /plain chat text/);
    assert.match(last, /look\(\{"q":1\}\)/);
    assert.match(last, /tool said yes/);
    await c.responses.create({
      model: 'agent/test',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'resp text' }] },
        { type: 'function_call', call_id: 'c1', name: 'fn', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'fn output' },
      ],
    } as never);
    const r = prompts.at(-1)!;
    assert.match(r, /resp text/);
    assert.match(r, /\[assistant tool_call:fn\]/);
    assert.match(r, /\[tool:c1\]\nfn output/);
  } finally {
    await s.cleanup();
  }
});

test('universal: structure-detected Chat / Responses / Claude / Gemini reject inline images (no X-OAA-Protocol)', async () => {
  const { s, prompts, runs } = await gateway();
  try {
    const cases: [string, Record<string, unknown>][] = [
      ['chat', chatBody(chatCases[0]!.part)],
      ['responses', responsesBody(responsesCases[0]!.part)],
      [
        'claude',
        {
          model: 'agent/test',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
              ],
            },
          ],
        },
      ],
      [
        'gemini',
        {
          model: 'agent/test',
          contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] }],
        },
      ],
    ];
    for (const [protocol, payload] of cases) {
      const r = await s.app.inject({
        method: 'POST',
        url: '/v1/universal',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      assert.equal(r.headers['x-oaa-detected-protocol'], protocol, r.body);
      assert.equal(r.statusCode, 400, `${protocol}: ${r.body}`);
      assert.ok(r.body.includes('unsupported_content'), `${protocol}: ${r.body}`);
    }
    assert.equal(runs(), 0);
    assert.ok(!prompts.some((p) => p.includes(B64)));
  } finally {
    await s.cleanup();
  }
});
