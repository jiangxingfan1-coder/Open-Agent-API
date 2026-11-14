// Check that the environment variables the official SDKs read are enough to reach an agent.
//
// What it shows: the OpenAI and Anthropic SDKs build their client from OPENAI_BASE_URL / OPENAI_API_KEY and
// ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY when you pass nothing. Any tool or framework that creates its client that
// way (and many do) needs no code change: point those variables at the gateway. Note the two Base URLs differ:
// the OpenAI one ends in /v1, the Anthropic one does not.
// Needs:    npm install openai @anthropic-ai/sdk, and the variables below (the README of this folder shows the exports)
//           OPENAI_BASE_URL=http://127.0.0.1:8787/v1     OPENAI_API_KEY=<your key>
//           ANTHROPIC_BASE_URL=http://127.0.0.1:8787     ANTHROPIC_API_KEY=<your key>
//           optional: OAA_AGENT (default agent/sample), OAA_PROMPT
// Agent:    any agent.
// Run:      node env_check.mjs
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const missing = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'].filter((n) => !process.env[n]);
if (missing.length) throw new Error(`Set these first: ${missing.join(', ')} (see the README of this folder).`);
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Say hello in one sentence.';

// No options: base URL and key come from the environment.
const chat = await new OpenAI({ maxRetries: 0 }).chat.completions.create({
  model: AGENT,
  messages: [{ role: 'user', content: PROMPT }],
});
console.log('openai:', chat.choices[0].message.content);

const message = await new Anthropic({ maxRetries: 0 }).messages.create({
  model: AGENT,
  max_tokens: 1024,
  messages: [{ role: 'user', content: PROMPT }],
});
console.log('anthropic:', message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
console.log('ok');
