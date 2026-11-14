// Structured output with the OpenAI Node SDK: ask for JSON that fits a schema, and handle the failure.
//
// What it shows: with `response_format` a successful response IS JSON that parses and fits your schema (the gateway
// validates it and sends a wrong answer back to the agent for one correction round). If the agent still cannot
// produce it, the call fails with HTTP 422 and the code `structured_output_invalid`; a schema the gateway cannot
// enforce is refused up front with 400 (`invalid_schema`, `output_schema_unsupported`, ...).
// Needs:    npm install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    a built-in (kernel) agent, or an external agent whose session can be continued (for the correction
//           round). The offline sample agent cannot be asked twice, so it ends in the 422 path below.
// Run:      node structured_openai.mjs
// Exit:     0 = valid JSON received; 3 = structured_output_invalid (handled); 2 = the request itself was refused.
import assert from 'node:assert/strict';
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT =
  process.env.OAA_PROMPT ??
  "Who wrote Hamlet? Give the title of the play, its author and the year of its first performance.";

const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 300_000 });

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, author: { type: 'string' }, year: { type: 'integer' } },
  required: ['title', 'author', 'year'],
  additionalProperties: false,
};

try {
  // `strict` is recorded but adds nothing: what is enforced is the schema itself, so say `required` and
  // `additionalProperties: false` in it if you want them.
  const completion = await client.chat.completions.create({
    model: AGENT,
    messages: [{ role: 'user', content: PROMPT }],
    response_format: { type: 'json_schema', json_schema: { name: 'play', strict: true, schema: SCHEMA } },
  });
  const data = JSON.parse(completion.choices[0].message.content); // always parses, always fits SCHEMA
  console.log('json:', data);
  assert.deepEqual(Object.keys(data).sort(), ['author', 'title', 'year']);
  assert.equal(Number.isInteger(data.year), true);
} catch (error) {
  if (error instanceof OpenAI.UnprocessableEntityError && error.code === 'structured_output_invalid') {
    // The run was created and finished, but its answer never fitted: do not retry blindly, the same agent would
    // answer the same way. Loosen the schema, describe the shape in the prompt, or use a stronger agent.
    console.log(`structured_output_invalid: ${error.message}`);
    process.exit(3);
  }
  if (error instanceof OpenAI.BadRequestError) {
    console.error(`the request was refused (${error.code}): ${error.message}`);
    process.exit(2);
  }
  throw error;
}
console.log('ok');
