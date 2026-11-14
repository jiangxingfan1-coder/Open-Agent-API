// First call with the official OpenAI Node SDK: Chat Completions and Responses, blocking and streaming.
//
// What it shows: the agent name goes into `model`; nothing else about your code changes.
// Needs:    npm install openai   and   OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT)
// Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
// Run:      node hello_openai.mjs
import assert from 'node:assert/strict';
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Say hello in one sentence.';

// maxRetries: 0 — an agent run is not free to repeat, and a retried request would start a second run
// (see 07-errors-and-retries). The timeout is generous because an agent may work for a while.
const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 300_000 });
const messages = [{ role: 'user', content: PROMPT }];

// 1. Chat Completions, blocking
const chat = await client.chat.completions.create({ model: AGENT, messages });
console.log('chat:', chat.choices[0].message.content);
assert.equal(chat.choices[0].finish_reason, 'stop');

// 2. Chat Completions, streaming
let streamed = '';
for await (const chunk of await client.chat.completions.create({ model: AGENT, messages, stream: true }))
  streamed += chunk.choices[0]?.delta?.content ?? '';
console.log('chat stream:', streamed);
assert.ok(streamed, 'the stream carried no text');

// 3. Responses, blocking. The response id is also the run id: keep it to look the run up later.
const response = await client.responses.create({ model: AGENT, input: PROMPT });
console.log('responses:', response.output_text, `(run ${response.id})`);

// 4. Responses, streaming
let deltas = '';
for await (const event of await client.responses.create({ model: AGENT, input: PROMPT, stream: true }))
  if (event.type === 'response.output_text.delta') deltas += event.delta;
console.log('responses stream:', deltas);
assert.ok(deltas, 'the stream carried no text');
console.log('ok');
