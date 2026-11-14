// Official `openai` Node SDK against the gateway over a real socket: Chat Completions and Responses.
import { createLab, env, check, equal, runsCreated, snapshotRuns, loadOrSkip } from '../lib/harness.mjs';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../node_modules/openai/package.json', import.meta.url), 'utf8'));
const lab = createLab('openai-node', pkg.version);
const mod = await loadOrSkip(lab, 'openai');
if (!mod) process.exit(0);
const OpenAI = mod.default;

const make = (extra = {}) => new OpenAI({ baseURL: `${env.baseUrl}/v1`, apiKey: env.apiKey, maxRetries: 0, ...extra });
const client = make();
const bridge = make({ baseURL: `${env.baseUrl}/v1/compat`, defaultHeaders: { 'X-OAA-Client-Tools': 'bridge' } });
const compat = make({ baseURL: `${env.baseUrl}/v1/compat` });
const M = env.fixture;
const say = (content, extra = {}) => ({ model: M, messages: [{ role: 'user', content }], ...extra });
const text = (c) => c.choices[0].message.content ?? '';
const TOOL = { type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
const RTOOL = { type: 'function', name: 'get_weather', description: 'weather', parameters: TOOL.function.parameters, strict: false };
const rejects = async (promise, Klass, what) => {
  try {
    await promise;
  } catch (error) {
    check(error instanceof Klass, `${what}: expected ${Klass.name}, got ${error?.constructor?.name}: ${error?.message}`);
    return error;
  }
  throw new Error(`${what}: no error was thrown`);
};

await lab.scenario('models.list_and_retrieve', async () => {
  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  check(ids.includes(M) && ids.includes(env.sample), `agents missing: ${ids}`);
  equal((await client.models.retrieve(M)).id, M, 'retrieved id');
});
await lab.scenario('chat.basic', async () => {
  const r = await client.chat.completions.create(say('hi'));
  equal(text(r), 'Hello world from the fixture.', 'content');
  equal(r.choices[0].finish_reason, 'stop', 'finish_reason');
  check(r.usage?.total_tokens > 0, 'usage');
});
await lab.scenario('chat.stream_async_iterator', async () => {
  const chunks = [];
  for await (const c of await client.chat.completions.create(say('LONG', { stream: true, stream_options: { include_usage: true } }))) chunks.push(c);
  check(chunks.length > 5, `only ${chunks.length} chunks`);
  equal(chunks[0].choices[0].delta.role, 'assistant', 'first delta role');
  const last = chunks.at(-1);
  check(last.usage?.total_tokens > 0 && last.choices.length === 0, 'usage chunk');
});
await lab.scenario('chat.stream_helper_final', async () => {
  const final = await client.chat.completions.stream(say('hi')).finalChatCompletion();
  equal(text(final), 'Hello world from the fixture.', 'content');
});
await lab.scenario('chat.sampling_and_vendor_params_tolerated', async () => {
  const r = await client.chat.completions.create(
    say('hi', {
      temperature: 0.3, top_p: 0.9, presence_penalty: 0.1, frequency_penalty: 0.2, seed: 7,
      stop: ['a', 'b', 'c', 'd', 'e', 'f'], user: 'lab', logit_bias: { 50256: -100 }, n: 1,
      max_completion_tokens: 100, reasoning_effort: 'low', store: false, metadata: { lab: '1' },
      top_k: 40, min_p: 0.05, repetition_penalty: 1.1,
    }),
  );
  equal(text(r), 'Hello world from the fixture.', 'content');
});
await lab.scenario('chat.roles_and_content_parts', async () => {
  const r = await client.chat.completions.create({
    model: M,
    messages: [
      { role: 'system', content: 'SYSTEM_MARK' },
      { role: 'developer', content: 'DEVELOPER_MARK' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: [{ type: 'text', text: 'SHOW_PROMPT' }, { type: 'text', text: 'part two' }] },
    ],
  });
  for (const mark of ['SYSTEM_MARK', 'DEVELOPER_MARK', 'first question', 'first answer', 'part two']) check(text(r).includes(mark), `${mark} lost`);
});
await lab.scenario('chat.length_finish', async () => {
  const r = await client.chat.completions.create(say('LENGTH'));
  equal(r.choices[0].finish_reason, 'length', 'finish_reason');
});
await lab.scenario('chat.tools_bridge_roundtrip_stream', async () => {
  const first = await bridge.chat.completions.stream(say('CALLTOOL', { tools: [TOOL] })).finalChatCompletion();
  equal(first.choices[0].finish_reason, 'tool_calls', 'finish_reason');
  const calls = first.choices[0].message.tool_calls;
  equal(JSON.parse(calls[0].function.arguments).city, 'Paris', 'arguments');
  const done = await bridge.chat.completions.create({
    model: M, tools: [TOOL],
    messages: [
      { role: 'user', content: 'CALLTOOL' },
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: calls[0].id, content: 'sunny' },
    ],
  });
  equal(text(done), 'Tool result: sunny', 'final answer');
});
await lab.scenario('chat.tools_on_default_endpoint_error_says_where', async () => {
  const e = await rejects(client.chat.completions.create(say('hi', { tools: [TOOL] })), OpenAI.BadRequestError, 'tools');
  equal(e.code, 'unsupported_parameter', 'code');
  check(/compat/.test(e.message), `message does not point to /v1/compat: ${e.message}`);
});
await lab.scenario('chat.response_format_via_compat', async () => {
  const r = await compat.chat.completions.create(say('JSON', { response_format: { type: 'json_object' } }));
  equal(JSON.parse(text(r)).answer, 'ok', 'json');
});
await lab.scenario('chat.image_part_rejected_clearly', async () => {
  const e = await rejects(
    client.chat.completions.create({ model: M, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }),
    OpenAI.BadRequestError, 'image',
  );
  equal(e.code, 'unsupported_content', 'code');
  equal(e.param, 'messages.0.content.1', 'param');
});
await lab.scenario('errors.class_mapping', async () => {
  await rejects(make({ apiKey: 'sk-oaa-wrong' }).chat.completions.create(say('hi')), OpenAI.AuthenticationError, '401');
  await rejects(client.chat.completions.create({ model: 'agent/none', messages: [{ role: 'user', content: 'hi' }] }), OpenAI.NotFoundError, '404');
  await rejects(client.chat.completions.create({ model: M, messages: [] }), OpenAI.BadRequestError, '400');
});
await lab.scenario('errors.run_failure_not_retried', async () => {
  const before = await snapshotRuns();
  const e = await rejects(make({ maxRetries: 2 }).chat.completions.create(say('FAIL')), OpenAI.APIError, 'failed run');
  equal((await runsCreated(before)), 1, `runs created (HTTP ${e.status})`);
});
await lab.scenario('errors.timeout', async () => {
  await rejects(make({ timeout: 1000 }).chat.completions.create(say('SLOW')), OpenAI.APIConnectionTimeoutError, 'timeout');
});
await lab.scenario('responses.basic_and_stream', async () => {
  const r = await client.responses.create({ model: M, input: 'hi' });
  equal(r.output_text, 'Hello world from the fixture.', 'output_text');
  const events = [];
  const stream = client.responses.stream({ model: M, input: 'LONG' });
  for await (const e of stream) events.push(e.type);
  const final = await stream.finalResponse();
  check(events.includes('response.output_text.delta') && final.output_text.includes('Paragraph 6'), 'stream');
});
await lab.scenario('responses.instructions_typed_items_params', async () => {
  const r = await client.responses.create({
    model: M, instructions: 'INSTRUCTION_MARK', temperature: 0.2, top_p: 0.9, max_output_tokens: 300, store: false,
    parallel_tool_calls: true, tool_choice: 'auto', reasoning: { effort: 'low' }, text: { format: { type: 'text' } },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SHOW_PROMPT' }] },
    ],
  });
  for (const mark of ['INSTRUCTION_MARK', 'q1', 'a1']) check(r.output_text.includes(mark), `${mark} lost`);
});
await lab.scenario('responses.previous_response_id_and_retrieve', async () => {
  const first = await client.responses.create({ model: M, input: 'first question' });
  const second = await client.responses.create({ model: M, input: 'SHOW_PROMPT', previous_response_id: first.id });
  check(second.output_text.includes('first question'), 'continuation lost the earlier turn');
  equal((await client.responses.retrieve(first.id)).output_text, first.output_text, 'retrieve');
});
await lab.scenario('responses.background_poll_and_cancel', async () => {
  let r = await client.responses.create({ model: M, input: 'hi', background: true });
  for (let i = 0; i < 50 && !['completed', 'failed', 'cancelled'].includes(r.status); i++) {
    await new Promise((res) => setTimeout(res, 100));
    r = await client.responses.retrieve(r.id);
  }
  equal(r.status, 'completed', 'background status');
  const slow = await client.responses.create({ model: M, input: 'SLOW', background: true });
  await client.responses.cancel(slow.id);
  let state = slow;
  for (let i = 0; i < 50 && state.status !== 'cancelled'; i++) {
    await new Promise((res) => setTimeout(res, 100));
    state = await client.responses.retrieve(slow.id);
  }
  equal(state.status, 'cancelled', 'cancelled status');
});
await lab.scenario('responses.tools_bridge_roundtrip', async () => {
  const first = await bridge.responses.create({ model: M, input: 'CALLTOOL', tools: [RTOOL] });
  const calls = first.output.filter((o) => o.type === 'function_call');
  equal(calls.length, 1, 'function_call items');
  const done = await bridge.responses.create({
    model: M, tools: [RTOOL], previous_response_id: first.id,
    input: [{ type: 'function_call_output', call_id: calls[0].call_id, output: 'sunny' }],
  });
  equal(done.output_text, 'Tool result: sunny', 'final answer');
});
await lab.scenario('responses.failed_run_is_status_failed', async () => {
  const r = await client.responses.create({ model: M, input: 'FAIL' });
  equal(r.status, 'failed', 'status');
  check(r.error?.code, 'error object');
});
await lab.scenario('unsupported_endpoints_are_clean_404', async () => {
  for (const [name, call] of [['embeddings', () => client.embeddings.create({ model: M, input: 'x' })], ['moderations', () => client.moderations.create({ input: 'x' })]])
    await rejects(call(), OpenAI.APIError, name).then((e) => check(e.status === 404, `${name}: HTTP ${e.status}`));
});
lab.done();
