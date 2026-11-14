// First call with the official Google GenAI Node SDK: generateContent, blocking and streaming.
//
// What it shows: the SDK's base URL is the gateway root; the agent name goes into `model` unchanged.
// Needs:    npm install @google/genai   and   OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT)
// Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
// Run:      node hello_genai.mjs
import assert from 'node:assert/strict';
import { FinishReason, GoogleGenAI } from '@google/genai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Say hello in one sentence.';

const client = new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: BASE, apiVersion: 'v1beta' } });

// 1. Blocking
const response = await client.models.generateContent({ model: AGENT, contents: PROMPT });
console.log('generateContent:', response.text);
assert.equal(response.candidates[0].finishReason, FinishReason.STOP);

// 2. Streaming
let streamed = '';
for await (const chunk of await client.models.generateContentStream({ model: AGENT, contents: PROMPT }))
  streamed += chunk.text ?? '';
console.log('streamGenerateContent:', streamed);
assert.ok(streamed, 'the stream carried no text');
console.log('ok');
