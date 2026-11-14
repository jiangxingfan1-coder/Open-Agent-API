// Errors and retries with the OpenAI Node SDK: which failures to retry, which not, and how to tell.
//
// What it shows:
//   * `maxRetries: 0` and your own policy. A run is not free to repeat, and an SDK retry after a timeout would start a
//     SECOND run (a disconnected client does not cancel the first one).
//   * One `Idempotency-Key` per logical task, the same on every attempt: a retry then attaches to the run that already
//     exists instead of starting another.
//   * What the gateway tells you: `x-should-retry: false` (do not retry), `Retry-After` (seconds to wait, on 429/503),
//     the stable `error.code`, and the catalog `GET /v1/errors` (`retryable`, and `en` / `nextEn` text) for the rest.
//   * Parts 3 and 4 use a stub `fetch`, so the rate-limit and failed-run cases are shown without having to overload
//     your gateway.
// Needs:    npm install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    any agent.
// Run:      node retries_openai.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Say hello in one sentence.';

const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 300_000 });
const CATALOG = new Map((await client.get('/errors')).data.map((e) => [e.code, e])); // GET /v1/errors (needs `read`)

/** Returns {wait, why}: `wait` seconds to retry after, or undefined to stop. A pure function of what the gateway said. */
function decide(error) {
  if (error instanceof OpenAI.APIConnectionError) {
    // (APIConnectionTimeoutError is a subclass.) The request may have reached the gateway and started a run. Safe
    // only because every attempt carries the same Idempotency-Key: the retry attaches to that run.
    return { wait: 2, why: 'no answer from the gateway; retry with the same Idempotency-Key' };
  }
  assert.ok(error instanceof OpenAI.APIError);
  const code = error.code ?? '?';
  const known = CATALOG.get(code) ?? {};
  // error.headers is a Headers object in current SDK versions and a plain object in older ones.
  const header = (name) => (typeof error.headers?.get === 'function' ? error.headers.get(name) : error.headers?.[name]);
  if (header('x-should-retry') === 'false')
    return { why: `${error.status} ${code}: the gateway says do not retry` };
  if ([429, 503].includes(error.status) && header('retry-after'))
    return { wait: Math.min(Number(header('retry-after')), 60), why: `${error.status} ${code}: server asked to wait` };
  if (known.retryable || [408, 500, 502, 503, 504].includes(error.status))
    return { wait: 2, why: `${error.status} ${code}: transient` };
  return { why: `${error.status} ${code}: ${known.en ?? error.message} ${known.nextEn ?? ''}`.trim() };
}

async function callWithRetry(client_, request, attempts = 4) {
  const key = randomUUID(); // one key per logical task, reused by every attempt
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await client_.chat.completions.create(request, { headers: { 'Idempotency-Key': key } });
      return { result, attempt };
    } catch (error) {
      if (!(error instanceof OpenAI.APIError)) throw error;
      const { wait, why } = decide(error);
      if (wait === undefined || attempt === attempts) throw error;
      console.log(`  attempt ${attempt}: ${why}; waiting ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

const messages = [{ role: 'user', content: PROMPT }];

// 1. A normal call through the wrapper.
const first = await callWithRetry(client, { model: AGENT, messages });
console.log(`1. real call: ok in ${first.attempt} attempt(s): ${JSON.stringify(first.result.choices[0].message.content.slice(0, 60))}`);

// 2. A request that can never succeed: stop at once, and say why from the catalog.
try {
  await callWithRetry(client, { model: 'agent/does-not-exist', messages });
  assert.fail('an unknown agent was accepted');
} catch (error) {
  assert.ok(error instanceof OpenAI.NotFoundError);
  assert.equal(error.code, 'agent_not_found');
  console.log(`2. unknown agent: stop (${decide(error).why})`);
}

/** A client whose `fetch` answers from a list: [status, headers, body] per request. */
function stub(answers) {
  const queue = [...answers];
  const fetch = async () => {
    const [status, headers, body] = queue.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return new OpenAI({ baseURL: 'http://stub.invalid/v1', apiKey: 'stub', maxRetries: 0, fetch });
}
const OK = {
  id: 'chatcmpl_stub',
  object: 'chat.completion',
  created: 0,
  model: AGENT,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};
const RATE_LIMITED = { error: { code: 'rate_limited', message: 'slow down', type: 'invalid_request_error' } };
const RUN_FAILED = { error: { code: 'structured_output_invalid', message: 'run failed', type: 'invalid_request_error' } };

// 3. Rate limited with Retry-After: wait what the server says, then the same request succeeds.
const started = Date.now();
const limited = await callWithRetry(stub([[429, { 'retry-after': '1' }, RATE_LIMITED], [200, {}, OK]]), { model: AGENT, messages });
console.log(`3. simulated 429 + Retry-After: 1: succeeded on attempt ${limited.attempt} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
assert.equal(limited.attempt, 2);

// 4. A run that was created and ended badly (422 with x-should-retry: false): never retry it, the run exists.
try {
  await callWithRetry(stub([[422, { 'x-should-retry': 'false' }, RUN_FAILED], [200, {}, OK]]), { model: AGENT, messages });
  assert.fail('a 422 with x-should-retry: false was retried');
} catch (error) {
  assert.ok(error instanceof OpenAI.UnprocessableEntityError);
  console.log(`4. simulated 422 + x-should-retry: false: stop (${decide(error).why})`);
}
console.log('ok');
