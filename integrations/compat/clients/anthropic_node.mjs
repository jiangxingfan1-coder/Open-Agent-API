// Official `@anthropic-ai/sdk` Node SDK against the gateway: the Messages API.
import { readFile } from 'node:fs/promises';
import { createLab, env, check, equal, runsCreated, snapshotRuns, loadOrSkip } from '../lib/harness.mjs';

const pkg = JSON.parse(await readFile(new URL('../node_modules/@anthropic-ai/sdk/package.json', import.meta.url), 'utf8'));
const lab = createLab('anthropic-node', pkg.version);
const mod = await loadOrSkip(lab, '@anthropic-ai/sdk');
if (!mod) process.exit(0);
const Anthropic = mod.default;

const make = (extra = {}) => new Anthropic({ baseURL: env.baseUrl, apiKey: env.apiKey, maxRetries: 0, ...extra });
const client = make();
const bridge = make({ defaultHeaders: { 'X-OAA-Client-Tools': 'bridge' } });
const M = env.fixture;
const TOOL = { name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const ask = (content, extra = {}, c = client) => c.messages.create({ model: M, max_tokens: 256, messages: [{ role: 'user', content }], ...extra });
const text = (m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
const rejects = async (promise, Klass, what) => {
  try {
    await promise;
  } catch (error) {
    check(error instanceof Klass, `${what}: expected ${Klass.name}, got ${error?.constructor?.name}: ${error?.message}`);
    return error;
  }
  throw new Error(`${what}: no error was thrown`);
};

await lab.scenario('messages.basic', async () => {
  const m = await ask('hi');
  equal(text(m), 'Hello world from the fixture.', 'text');
  equal(m.stop_reason, 'end_turn', 'stop_reason');
  check(m.usage.input_tokens > 0 && m.usage.output_tokens > 0, 'usage');
});
await lab.scenario('messages.stream_events_and_helpers', async () => {
  const types = [];
  for await (const e of await ask('LONG', { stream: true })) types.push(e.type);
  equal(types[0], 'message_start', 'first');
  equal(types.at(-1), 'message_stop', 'last');
  const stream = client.messages.stream({ model: M, max_tokens: 256, messages: [{ role: 'user', content: 'LONG' }] });
  const pieces = [];
  stream.on('text', (t) => pieces.push(t));
  const final = await stream.finalMessage();
  check(pieces.length > 5 && text(final).includes('Paragraph 6'), 'helper stream');
});
await lab.scenario('messages.system_forms_and_history', async () => {
  const a = await ask('SHOW_PROMPT', { system: 'SYSTEM_ONE' });
  check(text(a).includes('SYSTEM_ONE'), 'system string');
  const b = await ask('SHOW_PROMPT', { system: [{ type: 'text', text: 'SYSTEM_TWO', cache_control: { type: 'ephemeral' } }] });
  check(text(b).includes('SYSTEM_TWO'), 'system blocks');
  const c = await client.messages.create({
    model: M, max_tokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: 'SHOW_PROMPT' },
    ],
  });
  check(text(c).includes('first question') && text(c).includes('first answer'), 'history');
});
await lab.scenario('messages.sampling_params_tolerated', async () => {
  const m = await ask('hi', { temperature: 0.2, top_p: 0.9, top_k: 40, stop_sequences: ['END'], metadata: { user_id: 'lab' }, thinking: { type: 'disabled' } });
  equal(text(m), 'Hello world from the fixture.', 'text');
});
await lab.scenario('messages.max_tokens_stop_reason', async () => equal((await ask('LENGTH')).stop_reason, 'max_tokens', 'stop_reason'));
await lab.scenario('messages.tools_default_mode_is_not_an_error', async () => {
  equal(text(await ask('hi', { tools: [TOOL], tool_choice: { type: 'auto' } })), 'Hello world from the fixture.', 'text');
});
await lab.scenario('messages.tools_bridge_roundtrip', async () => {
  const first = await ask('CALLTOOL', { tools: [TOOL] }, bridge);
  equal(first.stop_reason, 'tool_use', 'stop_reason');
  const use = first.content.find((b) => b.type === 'tool_use');
  equal(use.input.city, 'Paris', 'input');
  const done = await bridge.messages.create({
    model: M, max_tokens: 256, tools: [TOOL],
    messages: [
      { role: 'user', content: 'CALLTOOL' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'sunny' }] },
    ],
  });
  equal(text(done), 'Tool result: sunny', 'final');
  const streamed = await bridge.messages.stream({ model: M, max_tokens: 64, tools: [TOOL], messages: [{ role: 'user', content: 'CALLTOOL' }] }).finalMessage();
  equal(streamed.content.find((b) => b.type === 'tool_use')?.input?.city, 'Paris', 'streamed input_json_delta');
});
await lab.scenario('messages.image_rejected_clearly', async () => {
  const e = await rejects(
    ask([{ type: 'text', text: 'x' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]),
    Anthropic.BadRequestError, 'image',
  );
  equal(e.error?.error?.type, 'invalid_request_error', 'error.type');
});
await lab.scenario('errors.class_mapping', async () => {
  await rejects(ask('hi', {}, make({ apiKey: 'sk-oaa-wrong' })), Anthropic.AuthenticationError, '401');
  await rejects(client.messages.create({ model: 'agent/none', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }), Anthropic.NotFoundError, '404');
  await rejects(client.messages.create({ model: M, max_tokens: 8, messages: [] }), Anthropic.BadRequestError, '400');
});
await lab.scenario('errors.run_failure_single_attempt', async () => {
  const before = await snapshotRuns();
  await rejects(ask('FAIL', {}, make({ maxRetries: 2 })), Anthropic.APIError, 'failed run');
  equal((await runsCreated(before)), 1, 'runs created');
});
await lab.scenario('errors.timeout', async () => {
  await rejects(ask('SLOW', {}, make({ timeout: 1000 })), Anthropic.APIConnectionTimeoutError, 'timeout');
});
await lab.scenario('models.list_and_retrieve', async () => {
  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  check(ids.includes(M), `${M} not in ${ids}`);
  equal((await client.models.retrieve(M)).id, M, 'retrieved id');
});
await lab.scenario('unsupported.count_tokens_and_batches_are_clean_404', async () => {
  const a = await rejects(client.messages.countTokens({ model: M, messages: [{ role: 'user', content: 'hi' }] }), Anthropic.NotFoundError, 'count_tokens');
  equal(a.error?.error?.type, 'not_found_error', 'error.type');
  await rejects(client.messages.batches.list(), Anthropic.NotFoundError, 'batches');
});
lab.done();
