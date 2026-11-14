// Approvals by event callback (webhook): be told that a task needs approval, and approve it from the handler.
//
// What it shows: instead of polling, the gateway POSTs a signed event to your endpoint the moment a run
// stops for approval (`run.requires_action`) and when it ends. This script is a complete round trip in one
// process: it starts a local receiver, registers it as a webhook, starts a task, approves (or denies) from the
// handler, waits for `run.completed` / `run.failed`, then removes the webhook again.
// Needs:    Node 20 or newer (built-in modules only, no npm package), and
//           OAA_ADMIN_KEY — an admin key (webhooks can only be configured with one; the file .oaa/admin.token),
//           or OAA_API_KEY if that key is the admin key. The same key approves, so it needs `approve` too.
//           optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that asks for approval; the offline sample agent does when the task contains "approve".
// Run:      node webhook_approve.mjs [approve|deny]        (default: approve)
// Real use: put the receiver on a public HTTPS URL of yours and register it once with
//           `oaa webhook add https://… --event run.requires_action` (see docs/webhooks.md). The
//           standalone receiver examples/webhook-receiver.mjs does the same for a long-running process.
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_ADMIN_KEY ?? process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_ADMIN_KEY (or OAA_API_KEY) first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Please write a short note to outputs/note.txt. This needs my approval.';
const DECISION = process.argv[2] ?? 'approve';
if (!['approve', 'deny'].includes(DECISION)) throw new Error('usage: node webhook_approve.mjs [approve|deny]');

const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
};

/** X-OAA-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>. */
function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(parts.v1 ?? '') ? parts.v1 : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let secret = '';
let runId = '';
const seen = new Set(); // X-OAA-Delivery values already handled: deliveries are at-least-once
let finish;
const ended = new Promise((resolve) => (finish = resolve));

const early = []; // events that arrive before the create call has returned the run id

async function onEvent(event) {
  const data = event.data ?? {};
  if (!runId) return void early.push(event);
  if (data.run_id !== runId) return; // the endpoint receives the events of every run of this owner
  console.log(`event ${event.type} run=${data.run_id} status=${data.status}`);
  if (event.type === 'run.requires_action') {
    for (const item of data.pending_actions ?? []) {
      if (item.status !== 'pending' || item.type === 'client_tool') continue; // a client_tool is answered by the caller
      console.log(`  ${DECISION} ${item.id}: ${item.title}`);
      await api('POST', `/v1/runs/${data.run_id}/actions/${item.id}`, { decision: DECISION });
    }
  } else if (['run.completed', 'run.failed', 'run.cancelled', 'run.incomplete'].includes(event.type)) {
    finish(event);
  }
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (c) => chunks.push(c));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8'); // verify the RAW body, before any JSON parsing
    if (request.method !== 'POST' || !verify(secret, request.headers['x-oaa-signature'], raw)) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(204).end(); // answer within 10 s; do the work afterwards
    const delivery = String(request.headers['x-oaa-delivery']);
    if (seen.has(delivery)) return;
    seen.add(delivery);
    onEvent(JSON.parse(raw)).catch((error) => console.error('handler error:', error.message));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

let endpoint;
let deadline;
try {
  // Register the receiver. The secret is returned only here: keep it to verify signatures.
  endpoint = await api('POST', '/v1/webhooks', {
    url,
    events: ['run.requires_action', 'run.completed', 'run.failed', 'run.cancelled', 'run.incomplete'],
    description: 'cookbook: approvals by callback',
  });
  secret = endpoint.secret;
  console.log('webhook registered:', endpoint.id, url);

  const run = await api('POST', '/v1/responses', { model: AGENT, input: PROMPT, background: true });
  runId = run.id;
  console.log('started', runId);
  for (const event of early.splice(0)) await onEvent(event);

  const last = await Promise.race([
    ended,
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('no final event within 60 s')), 60_000);
    }),
  ]);
  console.log('final event:', last.type);
  const expected = DECISION === 'approve' ? 'run.completed' : 'run.failed';
  if (last.type !== expected) throw new Error(`expected ${expected}, got ${last.type}`);
  if (DECISION === 'deny') console.log('denied:', last.data.error?.code);
  console.log('ok');
} finally {
  clearTimeout(deadline);
  if (endpoint) await api('DELETE', `/v1/webhooks/${endpoint.id}`).catch(() => {});
  server.close();
  server.closeAllConnections?.();
}
