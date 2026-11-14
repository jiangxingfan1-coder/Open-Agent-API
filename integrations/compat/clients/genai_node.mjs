// Official `@google/genai` Node SDK against the gateway: generateContent.
// (The one-off in-process probe of earlier releases lives in examples/gemini-sdk-probe.mjs.)
import { readFile } from 'node:fs/promises';
import { createLab, env, check, equal, runsCreated, snapshotRuns, loadOrSkip } from '../lib/harness.mjs';

const pkg = JSON.parse(await readFile(new URL('../node_modules/@google/genai/package.json', import.meta.url), 'utf8'));
const lab = createLab('google-genai-node', pkg.version);
const mod = await loadOrSkip(lab, '@google/genai');
if (!mod) process.exit(0);
const { GoogleGenAI, ApiError, FinishReason } = mod;

const make = (httpOptions = {}, apiKey = env.apiKey) => new GoogleGenAI({ apiKey, httpOptions: { baseUrl: env.baseUrl, ...httpOptions } });
const client = make();
const bridge = make({ headers: { 'X-OAA-Client-Tools': 'bridge' } });
const M = env.fixture;
const WEATHER = { functionDeclarations: [{ name: 'get_weather', description: 'weather', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } }] };
const rejects = async (promise, what) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`${what}: no error was thrown`);
};

await lab.scenario('generate.basic', async () => {
  const r = await client.models.generateContent({ model: M, contents: 'hi' });
  equal(r.text, 'Hello world from the fixture.', 'text');
  equal(r.candidates[0].finishReason, FinishReason.STOP, 'finishReason');
  check(r.usageMetadata?.totalTokenCount > 0, 'usageMetadata');
});
await lab.scenario('generate.stream', async () => {
  const chunks = [];
  for await (const c of await client.models.generateContentStream({ model: M, contents: 'LONG' })) chunks.push(c);
  check(chunks.length > 5 && chunks.map((c) => c.text ?? '').join('').includes('Paragraph 6'), 'stream');
  equal(chunks.at(-1).candidates[0].finishReason, FinishReason.STOP, 'last finishReason');
});
await lab.scenario('generate.system_history_and_chat', async () => {
  const r = await client.models.generateContent({
    model: M, config: { systemInstruction: 'SYSTEM_MARK' },
    contents: [
      { role: 'user', parts: [{ text: 'first question' }] },
      { role: 'model', parts: [{ text: 'first answer' }] },
      { role: 'user', parts: [{ text: 'SHOW_PROMPT' }] },
    ],
  });
  for (const mark of ['SYSTEM_MARK', 'first question', 'first answer']) check(r.text.includes(mark), `${mark} lost`);
  const chat = client.chats.create({ model: M });
  await chat.sendMessage({ message: 'one' });
  const two = await chat.sendMessage({ message: 'SHOW_PROMPT' });
  check(two.text.includes('one'), 'chat history');
});
await lab.scenario('generate.config_params_tolerated', async () => {
  const r = await client.models.generateContent({
    model: M, contents: 'hi',
    config: { temperature: 0.2, topP: 0.9, topK: 40, candidateCount: 1, stopSequences: ['END'], seed: 1, responseMimeType: 'text/plain', thinkingConfig: { thinkingBudget: 0 } },
  });
  equal(r.text, 'Hello world from the fixture.', 'text');
});
await lab.scenario('generate.max_output_tokens_finish', async () => {
  const r = await client.models.generateContent({ model: M, contents: 'LENGTH', config: { maxOutputTokens: 5 } });
  equal(r.candidates[0].finishReason, FinishReason.MAX_TOKENS, 'finishReason');
});
await lab.scenario('generate.tools_bridge_roundtrip', async () => {
  const config = { tools: [WEATHER] };
  const first = await client.models.generateContent({ model: M, contents: 'CALLTOOL', config });
  const call = first.functionCalls?.[0];
  equal(call?.name, 'get_weather', 'function call');
  equal(call.args.city, 'Paris', 'args');
  const done = await client.models.generateContent({
    model: M, config,
    contents: [
      { role: 'user', parts: [{ text: 'CALLTOOL' }] },
      first.candidates[0].content,
      { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: 'sunny' } } }] },
    ],
  });
  check(done.text.startsWith('Tool result:') && done.text.includes('sunny'), done.text);
});
await lab.scenario('errors.mapping_and_no_default_retry', async () => {
  let e = await rejects(make({}, 'sk-oaa-wrong').models.generateContent({ model: M, contents: 'hi' }), '401');
  check(e instanceof ApiError && e.status === 401, `401: ${e}`);
  e = await rejects(client.models.generateContent({ model: 'agent/none', contents: 'hi' }), '404');
  check(e instanceof ApiError && e.status === 404, `404: ${e}`);
  const before = await snapshotRuns();
  e = await rejects(client.models.generateContent({ model: M, contents: 'FAIL' }), 'failed run');
  check(e instanceof ApiError, `failed run: ${e}`);
  equal((await runsCreated(before)), 1, 'runs created');
  const retrying = make({ retryOptions: { attempts: 3, initialDelay: 0.01, maxDelay: 0.02 } });
  const before2 = await snapshotRuns();
  await rejects(retrying.models.generateContent({ model: M, contents: 'FAIL' }), 'failed run (retryOptions)');
  equal((await runsCreated(before2)), 1, 'runs created with retryOptions');
});
await lab.scenario('generate.inline_data_image', async () => {
  const r = await client.models.generateContent({ model: M, contents: [{ role: 'user', parts: [{ text: 'SHOW_IMAGES' }, { inlineData: { mimeType: 'image/png', data: env.png } }] }] });
  check(/^Images: 1 \[image\/png:\d+\]$/.test(r.text ?? ''), `reply: ${r.text}`);
});
await lab.scenario('errors.inline_data_to_text_only_agent_rejected_clearly', async () => {
  const e = await rejects(client.models.generateContent({ model: env.textOnly, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: env.png } }] }] }), 'inlineData');
  check(e instanceof ApiError && e.status === 400, `inlineData: ${e}`);
  check(/does not accept images/.test(e.message), `message: ${e.message}`);
});
await lab.scenario('models.get_and_list', async () => {
  const m = await client.models.get({ model: M });
  check(m.name?.includes(M), `name ${m.name}`);
  const names = [];
  for await (const x of await client.models.list()) names.push(x.name);
  check(names.some((n) => n?.includes(M)), `${M} not in ${names}`);
});
await lab.scenario('unsupported.endpoints_are_clean_errors', async () => {
  const results = [];
  for (const [name, call] of [
    ['countTokens', () => client.models.countTokens({ model: M, contents: 'hi' })],
    ['embedContent', () => client.models.embedContent({ model: M, contents: 'hi' })],
  ]) {
    const e = await rejects(call(), name);
    check(e instanceof ApiError && [404, 501].includes(e.status), `${name}: ${e}`);
    results.push(`${name}: HTTP ${e.status}`);
  }
  return results.join('; ');
});
await lab.scenario('generate.tools_explicit_bridge_mode', async () => {
  const r = await bridge.models.generateContent({ model: M, contents: 'CALLTOOL', config: { tools: [WEATHER] } });
  equal(r.functionCalls?.[0]?.name, 'get_weather', 'function call');
});

await lab.scenario('structured.response_schema_json_mime_and_correction_round', async () => {
  const { Type } = mod;
  const r = await client.models.generateContent({
    model: M, contents: 'BADJSON who?',
    config: { responseMimeType: 'application/json', responseSchema: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, age: { type: Type.INTEGER } }, required: ['name', 'age'] } },
  });
  equal(JSON.parse(r.text).name, 'x', 'answer');
  const json = await client.models.generateContent({ model: M, contents: 'who?', config: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } });
  equal(JSON.parse(json.text).ok, true, 'responseJsonSchema');
});
await lab.scenario('structured.failure_is_a_422', async () => {
  const e = await rejects(client.models.generateContent({ model: M, contents: 'ALWAYSBAD who?', config: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', required: ['a'] } } }), 'failure');
  check(e instanceof ApiError && e.status === 422, `status ${e.status}`);
});

lab.done();
