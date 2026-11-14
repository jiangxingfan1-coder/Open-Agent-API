/**
 * 官方 `@google/genai` 3.2.0 实测发现的问题的回归（按线上格式断言，不依赖该 SDK；探测脚本见
 * examples/gemini-sdk-probe.mjs）。进程内（app.inject），不监听端口。
 * - SDK 默认 `apiVersion` 是 `v1`（dist/node/index.mjs 的 GOOGLE_AI_API_DEFAULT_VERSION），
 *   请求打到 `/v1/models/{model}:generateContent`，不是 `/v1beta/...`。
 * - `models.list()` 读 `GET {version}/models` 的 `models[]` 与 `nextPageToken`；`models.get()` 读
 *   `GET {version}/models/{id}` 的 Model（https://ai.google.dev/api/models）。SDK 每个请求都带
 *   `x-goog-api-client`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, agent, FixtureModel, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';

async function gateway() {
  const s = await setup(new FixtureModel(() => ({ text: 'ok' })));
  s.store.publish('owner', makeBundle(agent()));
  return s;
}
const goog = { 'x-goog-api-key': token, 'x-goog-api-client': 'google-genai-sdk/3.2.0 gl-node/v24' };
const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

test('gemini sdk findings: /v1/models/{agent}:generateContent (the SDK default apiVersion) works', async () => {
  const s = await gateway();
  try {
    const r = await s.app.inject({
      method: 'POST',
      url: '/v1/models/agent/test:generateContent',
      headers: goog,
      payload: body,
    });
    assert.equal(r.statusCode, 200, r.body);
    const json = r.json();
    assert.equal(json.candidates[0].content.parts[0].text, 'ok');
    assert.equal(json.candidates[0].finishReason, 'STOP');

    const st = await s.app.inject({
      method: 'POST',
      url: '/v1/models/agent/test:streamGenerateContent?alt=sse',
      headers: goog,
      payload: body,
    });
    assert.equal(st.statusCode, 200, st.body);
    assert.match(String(st.headers['content-type']), /text\/event-stream/);
    const frames = st.body.split('\n\n').filter((f) => f.startsWith('data: '));
    assert.equal(JSON.parse(frames.at(-1)!.slice(6)).candidates[0].finishReason, 'STOP');

    const q = await s.app.inject({
      method: 'POST',
      url: `/v1/models/agent/test:generateContent?key=${token}`,
      payload: body,
    });
    assert.equal(q.statusCode, 200, q.body);

    const bad = await s.app.inject({
      method: 'POST',
      url: '/v1/models/agent/test:generateContent',
      headers: { ...goog, 'x-goog-api-key': 'wrong' },
      payload: body,
    });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().error.code, 401);
    assert.equal(bad.json().error.status, 'UNAUTHENTICATED');

    const other = await s.app.inject({
      method: 'POST',
      url: '/v1/models/agent/test:countTokens',
      headers: goog,
      payload: body,
    });
    assert.equal(other.statusCode, 404);
    assert.equal(other.json().error.status, 'NOT_FOUND');
  } finally {
    await s.cleanup();
  }
});

test('gemini sdk findings: models.list / models.get get the Gemini Model shape', async () => {
  const s = await gateway();
  try {
    for (const url of ['/v1beta/models', '/v1/models']) {
      const r = await s.app.inject({ method: 'GET', url, headers: goog });
      assert.equal(r.statusCode, 200, r.body);
      const m = r.json().models.find((x: { name: string }) => x.name === 'models/agent/test');
      assert.ok(m, r.body);
      assert.deepEqual(m.supportedGenerationMethods, ['generateContent', 'streamGenerateContent']);
      assert.equal(r.json().nextPageToken, undefined);
    }
    for (const url of ['/v1beta/models/agent/test', '/v1/models/agent/test']) {
      const r = await s.app.inject({ method: 'GET', url, headers: goog });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().name, 'models/agent/test');
      assert.equal(r.json().displayName, 'agent/test');
    }
    const missing = await s.app.inject({
      method: 'GET',
      url: '/v1beta/models/agent/none',
      headers: goog,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.status, 'NOT_FOUND');
    const byKey = await s.app.inject({ method: 'GET', url: `/v1beta/models?key=${token}` });
    assert.equal(byKey.statusCode, 200, byKey.body);
    // 不带 x-goog-api-client 的 `/v1/models` 仍是 OpenAI 列表，`/v1/models/{id}` 是 OpenAI 的 Model 对象。
    const openai = await s.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(openai.json().object, 'list');
    const plain = await s.app.inject({
      method: 'GET',
      url: '/v1/models/agent/test',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(plain.statusCode, 200);
    assert.deepEqual(plain.json(), {
      id: 'agent/test',
      object: 'model',
      created: 0,
      owned_by: 'open-agent-api',
    });
  } finally {
    await s.cleanup();
  }
});
