// A long task with the OpenAI Node SDK: run in the background and poll, cancel, continue.
//
// What it shows (Responses API, `background: true`):
//   1. start a run, poll it until it ends (a request never has to stay open for the whole task);
//   2. cancel a run that is still working (and cope with one that had already finished);
//   3. continue the same conversation with `previous_response_id` (the agent keeps its session).
// Needs:    npm install openai   and   OAA_API_KEY
//           optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT (steps 1 and 3), OAA_LONG_PROMPT (step 2: something slow)
// Agent:    any agent. agent/sample (offline) finishes at once, so a cancel in step 2 ends "incomplete" or
//           "completed", and it cannot continue a session (step 3 reports native_resume_unsupported): its
//           ACP process declares neither session/load nor session/resume. A built-in agent does all three.
// Run:      node long_task_openai.mjs
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Summarise what an API gateway does in two sentences.';
const LONG_PROMPT =
  process.env.OAA_LONG_PROMPT ??
  'Write a very detailed report on the history of the printing press, with sections and sources.';
const TERMINAL = ['completed', 'failed', 'cancelled', 'incomplete'];

const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 60_000 });

/** Poll until the run ends. `requires_action` means it waits for an approval: see recipe 03. */
async function wait(run, limitMs = 600_000) {
  const deadline = Date.now() + limitMs;
  while (!TERMINAL.includes(run.status)) {
    if (run.metadata?.['oaa.status'] === 'requires_action') {
      console.log('  the run is waiting for an approval (see recipe 03); stop polling');
      return run;
    }
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${run.id}`);
    await sleep(1000);
    run = await client.responses.retrieve(run.id);
  }
  return run;
}

// 1. Start in the background and poll. The create call returns at once with status "queued".
let first = await client.responses.create({ model: AGENT, input: PROMPT, background: true });
console.log('started', first.id, first.status);
first = await wait(first);
console.log('1. poll ->', first.status, '|', first.output_text.slice(0, 120));
assert.equal(first.status, 'completed');

// 2. Cancel, then poll for the final state. Three outcomes are normal:
//    - "cancelled": a built-in (kernel) agent stopped cleanly;
//    - "incomplete" with reason effect_outcome_unknown: an external agent (ACP, Codex, ...) was stopped in the
//      middle of a step, so the gateway cannot know whether its side effects happened (docs/operations.md,
//      "Inspect and recover work");
//    - "completed": the run had already finished (cancelling a finished run changes nothing).
let slow = await client.responses.create({ model: AGENT, input: LONG_PROMPT, background: true });
await client.responses.cancel(slow.id);
slow = await wait(await client.responses.retrieve(slow.id));
const reason = slow.incomplete_details?.reason;
console.log('2. cancel ->', slow.status, reason ? `(${reason})` : '');
assert.ok(['cancelled', 'incomplete', 'completed'].includes(slow.status), slow.status);

// 3. Continue the conversation: the new run belongs to the same session. Not every agent can: an external agent
//    that supports neither session/load nor session/resume (the offline sample agent is one) cannot pick up its
//    previous session, and the run fails with native_resume_unsupported. Built-in agents always can.
let second = await client.responses.create({
  model: AGENT,
  input: 'Now say it again, shorter.',
  previous_response_id: first.id,
  background: true,
});
second = await wait(second);
if (second.status === 'failed' && second.error?.code === 'native_resume_unsupported') {
  console.log('3. continue -> this agent cannot continue a session (native_resume_unsupported); use another agent');
} else {
  console.log('3. continue ->', second.status, '|', second.output_text.slice(0, 120));
  assert.equal(second.status, 'completed');
  assert.equal(second.previous_response_id, first.id);
}
console.log('ok');
