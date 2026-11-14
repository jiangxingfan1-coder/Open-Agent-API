// Approvals with the OpenAI Node SDK: notice that a task is waiting for approval, then approve or deny it.
//
// What it shows: a background run that needs a person's approval stops in `requires_action`. You find the
// pending items with GET /v1/runs/{id}/actions and decide each one with
// POST /v1/runs/{id}/actions/{action_id} {"decision": "approve" | "deny"}.
// Needs:    npm install openai   and   OAA_API_KEY of a key with the `approve` scope (the key that
//           `oaa quickstart` writes has it)      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    an agent that asks for approval. The offline sample agent does when the task contains "approve":
//           it asks to write a file. An agent that never asks simply finishes ("no approval was needed").
// Run:      node approve_openai.mjs [approve|deny]        (default: approve)
// Result:   approve -> the run completes; deny -> the run fails with permission_denied.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Please write a short note to outputs/note.txt. This needs my approval.';
const DECISION = process.argv[2] ?? 'approve';
if (!['approve', 'deny'].includes(DECISION)) throw new Error('usage: node approve_openai.mjs [approve|deny]');
const TERMINAL = ['completed', 'failed', 'cancelled', 'incomplete'];

const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 60_000 });
const waitingForApproval = (run) => run.metadata?.['oaa.status'] === 'requires_action';

/** Retrieve the run every half second until `until(run)` is true. */
async function poll(run, until) {
  const deadline = Date.now() + 120_000;
  while (!until(run)) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${run.id}`);
    await sleep(500);
    run = await client.responses.retrieve(run.id);
  }
  return run;
}

let run = await client.responses.create({ model: AGENT, input: PROMPT, background: true });
console.log('started', run.id);
run = await poll(run, (r) => TERMINAL.includes(r.status) || waitingForApproval(r));

if (TERMINAL.includes(run.status)) {
  console.log(`${run.status}: no approval was needed |`, run.output_text.slice(0, 100));
  process.exit(0);
}

// The run is parked. GET /v1/runs/{id}/actions lists what it waits for. The gateway's own endpoints are not
// part of the OpenAI SDK, but its generic client.get / client.post reach them with the same key.
const { data: pending } = await client.get(`/runs/${run.id}/actions`);
let decided = 0;
for (const action of pending) {
  if (action.kind === 'client_tool') continue; // a tool result the *caller* must send back: see recipe 04
  const detail = JSON.parse(action.detail.preview);
  console.log(`pending ${action.id} (${action.kind}): ${detail.title}  -> ${DECISION}`);
  await client.post(`/runs/${run.id}/actions/${action.id}`, { body: { decision: DECISION } });
  decided++;
}
assert.ok(decided, 'the run waits for something other than an approval');

run = await poll(run, (r) => TERMINAL.includes(r.status));
if (run.status === 'failed') console.log('failed:', run.error?.code ?? '?'); // a denied approval ends with permission_denied
else console.log(run.status, '|', run.output_text.slice(0, 100));
assert.equal(run.status, DECISION === 'approve' ? 'completed' : 'failed');
console.log('ok');
