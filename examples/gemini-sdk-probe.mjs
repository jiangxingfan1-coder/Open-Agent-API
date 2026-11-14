// 用官方 @google/genai SDK 探测 Open Agent API 的 Gemini 兼容入口（手动运行的一次性脚本，不属于自动测试；
// 回归靠 test/compat-claude-gemini.test.ts 与 test/compat-gemini-sdk-findings.test.ts 的线上格式断言）。
//
// 用法：
//   1. 在本仓库里先 `npm run build`。
//   2. @google/genai 3.2.0 不是项目依赖，不要加进 package.json：在仓库外的临时目录里
//      执行 `npm install @google/genai@3.2.0`，把本文件复制进去。
//   3. 在那个目录运行：
//        OAA_REPO=/path/to/open-agent-api node gemini-sdk-probe.mjs
//      （PROBE_API_VERSION=v1beta 改走 /v1beta；不设时用 SDK 默认的 v1。）
// 输出每个场景的结果、SDK 发出的请求数与网关新建的运行数。
// 网关在进程内运行（app.inject），不监听端口；SDK 的请求经 httpOptions.fetch 转给 inject，
// 另把 globalThis.fetch 换成只认假 baseUrl 的版本，其余请求一律抛错，保证不出网。
import { GoogleGenAI, ApiError } from '@google/genai';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.env.OAA_REPO ?? process.cwd();
const imp = (p) => import(pathToFileURL(path.join(REPO, 'dist', p)).href);
const { setup, agent, FixtureModel, token, principal } = await imp('test/helpers.js');
const { builtin, makeBundle } = await imp('src/lang/bundle.js');

const BASE = 'http://gemini.fake.invalid';
// PROBE_API_VERSION=v1beta 显式指定；不设则用 SDK 默认（3.2.0 是 v1）。
const API_VERSION = process.env.PROBE_API_VERSION;
const realFetch = globalThis.fetch;
const state = { mode: 'ok', inputs: [], requests: [] };
let app;
async function injectFetch(url, init = {}) {
  const u = new URL(String(url instanceof Request ? url.url : url));
  if (u.origin !== BASE) throw new Error(`blocked outbound fetch: ${u.origin}`);
  const headers = Object.fromEntries(new Headers(init.headers));
  state.requests.push({ method: init.method, url: u.pathname + u.search, headers, body: init.body });
  const r = await app.inject({
    method: init.method ?? 'GET',
    url: u.pathname + u.search,
    payload: init.body,
    headers,
  });
  return new Response(r.statusCode === 204 ? null : new Uint8Array(r.rawPayload), {
    status: r.statusCode,
    headers: r.headers,
  });
}
globalThis.fetch = (url, init) => {
  const u = new URL(String(url instanceof Request ? url.url : url));
  if (u.origin === BASE) return injectFetch(url, init);
  throw new Error(`blocked outbound fetch: ${u.origin}`);
};
void realFetch;

const model = new FixtureModel((a, messages) => {
  state.inputs.push(messages.map((m) => m.content).join('\n'));
  if (state.mode === 'fail') throw new Error('boom');
  if (state.mode === 'len') return { text: 'partial text', finish: 'length' };
  if (state.mode === 'bridge' || state.mode === 'bridge2') {
    const results = messages.filter((m) => m.role === 'tool');
    if (results.length) return { text: `R:${results.map((m) => m.content).join('|')}` };
    return {
      text: '',
      calls: [
        { id: 'a', name: 'edit_file', arguments: { path: 'a.ts' } },
        ...(state.mode === 'bridge2' ? [{ id: 'b', name: 'lint', arguments: {} }] : []),
      ],
    };
  }
  if (state.mode === 'approval')
    return messages.some((m) => m.role === 'tool')
      ? { text: 'done' }
      : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a', content: 'b' } }] };
  return { text: 'Hello world from fixture.' };
});
const s = await setup(model);
app = s.app;
s.store.publish('owner', makeBundle(agent()));
const write = builtin('write_file');
write.capability.requiresApproval = true;
s.store.publish('owner', makeBundle(agent({ id: 'agent/approve', tools: [write] })));
s.store.publish('owner', makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })));
const runs = () => s.store.summaries('owner', ['*'], 200).length;

const ai = (opts = {}) =>
  new GoogleGenAI({
    apiKey: opts.apiKey ?? token,
    httpOptions: { baseUrl: BASE, fetch: injectFetch, ...(API_VERSION ? { apiVersion: API_VERSION } : {}), ...(opts.httpOptions ?? {}) },
  });
const out = [];
const log = (name, value) => {
  out.push(name);
  console.log(`\n=== ${name}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
};
const errInfo = (e) => ({
  cls: e?.constructor?.name,
  isApiError: e instanceof ApiError,
  status: e?.status,
  message: String(e?.message).slice(0, 600),
});
async function scenario(name, fn) {
  const before = { req: state.requests.length, runs: runs() };
  try {
    const v = await fn();
    log(name, { ok: true, value: v, requests: state.requests.length - before.req, runsCreated: runs() - before.runs });
  } catch (e) {
    log(name, { ok: false, error: errInfo(e), requests: state.requests.length - before.req, runsCreated: runs() - before.runs });
  }
  state.mode = 'ok';
}
const lastReq = () => {
  const r = state.requests.at(-1);
  return { method: r.method, url: r.url, apiKeyHeader: r.headers['x-goog-api-key'] ? 'present' : 'absent', body: r.body ? JSON.parse(r.body) : undefined };
};

await scenario('generateContent 非流式', async () => {
  const r = await ai().models.generateContent({ model: 'agent/test', contents: 'hi' });
  return { text: r.text, candidates: r.candidates, usageMetadata: r.usageMetadata, modelVersion: r.modelVersion, responseId: r.responseId, sdkHttpResponseHeaders: Object.keys(r.sdkHttpResponse?.headers ?? {}).length, request: lastReq() };
});
await scenario('generateContentStream', async () => {
  const chunks = [];
  for await (const c of await ai().models.generateContentStream({ model: 'agent/test', contents: 'hi' }))
    chunks.push({ text: c.text, finish: c.candidates?.[0]?.finishReason, usage: c.usageMetadata, responseId: c.responseId });
  return { chunks, request: lastReq() };
});
await scenario('systemInstruction + 多轮 contents', async () => {
  const r = await ai().models.generateContent({
    model: 'agent/test',
    contents: [
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'answer1' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ],
    config: { systemInstruction: 'be brief' },
  });
  return { text: r.text, agentSaw: state.inputs.at(-1), request: lastReq() };
});
await scenario('chats sendMessage + sendMessageStream', async () => {
  const chat = ai().chats.create({ model: 'agent/test', config: { systemInstruction: 'sys' } });
  const a = await chat.sendMessage({ message: 'one' });
  const parts = [];
  for await (const c of await chat.sendMessageStream({ message: 'two' })) parts.push(c.text);
  return { a: a.text, streamed: parts, history: chat.getHistory().length, agentSaw: state.inputs.at(-1), request: lastReq() };
});
await scenario('maxOutputTokens 截断 + 被忽略参数', async () => {
  state.mode = 'len';
  const r = await ai().models.generateContent({
    model: 'agent/test',
    contents: 'hi',
    config: { maxOutputTokens: 5, temperature: 0.2, topP: 0.9, topK: 3, stopSequences: ['x'] },
  });
  const hdr = Object.fromEntries(Object.entries(r.sdkHttpResponse?.headers ?? {}).filter(([k]) => k.startsWith('x-oaa')));
  return { finish: r.candidates?.[0]?.finishReason, text: r.text, oaaHeaders: hdr, request: lastReq() };
});
await scenario('鉴权：SDK 默认头', async () => {
  await ai().models.generateContent({ model: 'agent/test', contents: 'hi' });
  const r = state.requests.at(-1);
  return { url: r.url, hasXGoogApiKey: Boolean(r.headers['x-goog-api-key']), hasAuthorization: Boolean(r.headers.authorization) };
});
await scenario('鉴权：?key= 查询参数（直接 inject）', async () => {
  const r = await app.inject({ method: 'POST', url: `/v1beta/models/agent/test:generateContent?key=${token}`, payload: { contents: [{ parts: [{ text: 'hi' }] }] } });
  return { status: r.statusCode };
});
await scenario('401 错误 key', () => ai({ apiKey: 'wrong' }).models.generateContent({ model: 'agent/test', contents: 'hi' }));
await scenario('403 无权限 key', () => {
  const scoped = String(s.auth.create(principal, 'other-only', ['agent/approve'], ['read', 'invoke']).token);
  return ai({ apiKey: scoped }).models.generateContent({ model: 'agent/test', contents: 'hi' });
});
await scenario('404 不存在的智能体', () => ai().models.generateContent({ model: 'agent/none', contents: 'hi' }));
await scenario('400 inlineData', () =>
  ai().models.generateContent({ model: 'agent/test', contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }] }));
await scenario('422 运行失败（默认无重试）', () => { state.mode = 'fail'; return ai().models.generateContent({ model: 'agent/test', contents: 'hi' }); });
await scenario('422 运行失败（开启 retryOptions）', () => { state.mode = 'fail'; return ai({ httpOptions: { retryOptions: { attempts: 3, initialDelay: 0.01, maxDelay: 0.02 } } }).models.generateContent({ model: 'agent/test', contents: 'hi' }); });
await scenario('422 待审批', () => { state.mode = 'approval'; return ai().models.generateContent({ model: 'agent/approve', contents: 'hi' }); });
await scenario('流中途失败', async () => {
  state.mode = 'fail';
  const got = [];
  for await (const c of await ai().models.generateContentStream({ model: 'agent/test', contents: 'hi' })) got.push(c);
  return { chunks: got.length };
});
await scenario('429 rpm', async () => {
  const limited = String(s.auth.create(principal, 'rpm', ['*'], ['read', 'invoke'], { rpm: 1 }).token);
  await ai({ apiKey: limited }).models.generateContent({ model: 'agent/test', contents: 'a' });
  try {
    await ai({ apiKey: limited }).models.generateContent({ model: 'agent/test', contents: 'b' });
  } catch (e) {
    return { ...errInfo(e), retryAfter: state.requests.length };
  }
});
await scenario('429 rpm 带 retryOptions（attempts 2）', async () => {
  const limited = String(s.auth.create(principal, 'rpm2', ['*'], ['read', 'invoke'], { rpm: 1 }).token);
  await ai({ apiKey: limited }).models.generateContent({ model: 'agent/test', contents: 'a' });
  return ai({ apiKey: limited, httpOptions: { retryOptions: { attempts: 2, initialDelay: 0.01, maxDelay: 0.02 } } }).models.generateContent({ model: 'agent/test', contents: 'b' });
});
const decl = { functionDeclarations: [{ name: 'edit_file', description: 'Edit', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] };
await scenario('tools 默认模式', async () => {
  const r = await ai().models.generateContent({ model: 'agent/test', contents: 'fix', config: { tools: [decl] } });
  return { text: r.text, functionCalls: r.functionCalls, request: lastReq() };
});
// 桥接（X-OAA-Client-Tools: bridge）：SDK 读 functionCalls、回传 functionResponse 续接同一个运行。
const bridgeAi = () => ai({ httpOptions: { headers: { 'X-OAA-Client-Tools': 'bridge' } } });
const lint = { functionDeclarations: [...decl.functionDeclarations, { name: 'lint', parametersJsonSchema: { type: 'object' } }] };
const runIdOf = (r) => r.sdkHttpResponse?.headers?.['x-run-id'];
await scenario('bridge generateContent + 手工回传 functionResponse', async () => {
  state.mode = 'bridge';
  const first = await bridgeAi().models.generateContent({ model: 'agent/bridge', contents: 'fix', config: { tools: [decl] } });
  const call = first.functionCalls?.[0];
  state.mode = 'bridge';
  const done = await bridgeAi().models.generateContent({
    model: 'agent/bridge',
    config: { tools: [decl] },
    contents: [
      { role: 'user', parts: [{ text: 'fix' }] },
      first.candidates[0].content,
      { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: 'patched' } } }] },
    ],
  });
  return { functionCalls: first.functionCalls, argsIsObject: typeof call?.args === 'object', finish: first.candidates?.[0]?.finishReason, usage: first.usageMetadata, text: done.text, sameRun: runIdOf(first) === runIdOf(done), sameResponseId: first.responseId === done.responseId };
});
await scenario('bridge 并行两个 + 不带 id 回传', async () => {
  state.mode = 'bridge2';
  const first = await bridgeAi().models.generateContent({ model: 'agent/bridge', contents: 'fix', config: { tools: [lint] } });
  state.mode = 'bridge2';
  const done = await bridgeAi().models.generateContent({
    model: 'agent/bridge',
    config: { tools: [lint] },
    contents: [
      { role: 'user', parts: [{ text: 'fix' }] },
      first.candidates[0].content,
      { role: 'user', parts: first.functionCalls.map((c) => ({ functionResponse: { name: c.name, response: { output: c.name } } })) },
    ],
  });
  return { calls: first.functionCalls.map((c) => c.name), text: done.text, sameRun: runIdOf(first) === runIdOf(done) };
});
await scenario('bridge generateContentStream', async () => {
  state.mode = 'bridge';
  const chunks = [];
  for await (const c of await bridgeAi().models.generateContentStream({ model: 'agent/bridge', contents: 'fix', config: { tools: [decl] } }))
    chunks.push({ functionCalls: c.functionCalls, finish: c.candidates?.[0]?.finishReason, usage: c.usageMetadata });
  const call = chunks.find((c) => c.functionCalls)?.functionCalls?.[0];
  state.mode = 'bridge';
  const rest = [];
  for await (const c of await bridgeAi().models.generateContentStream({
    model: 'agent/bridge',
    config: { tools: [decl] },
    contents: [
      { role: 'user', parts: [{ text: 'fix' }] },
      { role: 'model', parts: [{ functionCall: call }] },
      { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: 'ok' } } }] },
    ],
  }))
    rest.push({ text: c.text, finish: c.candidates?.[0]?.finishReason });
  return { chunks, rest };
});
await scenario('bridge chats.sendMessage 往返（SDK 自动历史）', async () => {
  state.mode = 'bridge';
  const before = runs();
  const chat = bridgeAi().chats.create({ model: 'agent/bridge', config: { tools: [decl] } });
  const first = await chat.sendMessage({ message: 'fix' });
  const call = first.functionCalls[0];
  state.mode = 'bridge';
  const done = await chat.sendMessage({ message: [{ functionResponse: { name: call.name, response: { output: 'via chat' } } }] });
  const sent = JSON.parse(state.requests.at(-1).body);
  return {
    functionCalls: first.functionCalls,
    historyModelPart: sent.contents.at(-2),
    lastContent: sent.contents.at(-1),
    text: done.text,
    sameRun: runIdOf(first) === runIdOf(done),
    runsCreated: runs() - before,
  };
});
await scenario('bridge 内置工具 googleSearch 被拒', () =>
  bridgeAi().models.generateContent({ model: 'agent/bridge', contents: 'fix', config: { tools: [{ googleSearch: {} }] } }));
await scenario('tools managed 头', async () => {
  const r = await ai({ httpOptions: { headers: { 'X-OAA-Client-Tools': 'managed' } } }).models.generateContent({ model: 'agent/test', contents: 'fix', config: { tools: [decl] } });
  return { text: r.text, functionCalls: r.functionCalls, agentSawNote: /Harness note/.test(state.inputs.at(-1)) };
});
await scenario('functionResponse 回传（managed）', async () => {
  const r = await ai({ httpOptions: { headers: { 'X-OAA-Client-Tools': 'managed' } } }).models.generateContent({
    model: 'agent/test',
    config: { tools: [decl] },
    contents: [
      { role: 'user', parts: [{ text: 'fix' }] },
      { role: 'model', parts: [{ functionCall: { name: 'edit_file', args: { path: 'a' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'edit_file', response: { ok: true } } }] },
    ],
  });
  return { text: r.text, agentSaw: state.inputs.at(-1) };
});
for (const [name, fn] of [
  ['countTokens', (c) => c.models.countTokens({ model: 'agent/test', contents: 'hi' })],
  ['embedContent', (c) => c.models.embedContent({ model: 'agent/test', contents: 'hi' })],
  ['models.get', (c) => c.models.get({ model: 'agent/test' })],
  ['models.list', async (c) => { const p = await c.models.list(); return p.page; }],
  ['caches.list', async (c) => (await c.caches.list()).page],
  ['files.list', async (c) => (await c.files.list()).page],
])
  await scenario(`未实现端点 ${name}`, async () => { const v = await fn(ai()); return { value: v, request: lastReq() }; });

await s.cleanup();
globalThis.fetch = realFetch;
console.log('\nscenarios:', out.length);
