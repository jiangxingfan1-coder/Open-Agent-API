// First call with the official Anthropic Node SDK: Messages, blocking and streaming.
//
// What it shows: the SDK's base URL is the gateway root (it appends /v1/messages itself); the agent name
// goes into `model`.
// Needs:    npm install @anthropic-ai/sdk   and   OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT)
// Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
// Run:      node hello_anthropic.mjs
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Say hello in one sentence.';

// No "/v1" in baseURL for this SDK. maxRetries: 0 — see 07-errors-and-retries.
const client = new Anthropic({ baseURL: BASE, apiKey: KEY, maxRetries: 0, timeout: 300_000 });
const messages = [{ role: 'user', content: PROMPT }];

// 1. Blocking. max_tokens is required by the SDK; the gateway only uses it to lower the agent's own limit.
const message = await client.messages.create({ model: AGENT, max_tokens: 1024, messages });
const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
console.log('messages:', text);
assert.equal(message.stop_reason, 'end_turn');

// 2. Streaming
const stream = client.messages.stream({ model: AGENT, max_tokens: 1024, messages });
let streamed = '';
stream.on('text', (delta) => (streamed += delta));
const final = await stream.finalMessage();
console.log('messages stream:', streamed);
assert.ok(streamed, 'the stream carried no text');
assert.equal(final.stop_reason, 'end_turn');
console.log('ok');
