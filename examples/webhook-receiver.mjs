#!/usr/bin/env node
// Open Agent API 事件回调的最小接收端：校验签名，打印事件；收到 run.requires_action 时列出待审批项，
// 带 --auto-approve 时用管理员密钥调用审批接口批准（默认只打印，不批准）。只用 Node 内置模块。
// Minimal receiver for Open Agent API webhooks: verifies the signature and prints each event. On
// run.requires_action it lists the pending items and, only with --auto-approve, approves them through
// the approvals API with an admin key. Node built-ins only. Walkthrough: docs/webhooks.md.
//
//   node examples/webhook-receiver.mjs --secret-file webhook.secret \
//     [--port 8790] [--gateway http://127.0.0.1:8787 --token-file .oaa/admin.token --auto-approve]
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8790' },
    host: { type: 'string', default: '127.0.0.1' },
    secret: { type: 'string' },
    'secret-file': { type: 'string' },
    gateway: { type: 'string', default: 'http://127.0.0.1:8787' },
    'token-file': { type: 'string' },
    'auto-approve': { type: 'boolean', default: false },
  },
});
const zh = /^zh/i.test(process.env.OAA_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale);
const t = (cn, en) => (zh ? cn : en);
const read = (file) => readFileSync(file, 'utf8').trim();
const secret = values.secret ?? (values['secret-file'] && read(values['secret-file']));
if (!secret) {
  console.error(t('需要 --secret-file（或 --secret）。', 'Needs --secret-file (or --secret).'));
  process.exit(2);
}
const token = values['token-file'] && read(values['token-file']);
if (values['auto-approve'] && !token) {
  console.error(
    t(
      '--auto-approve 需要 --token-file（管理员密钥）。',
      '--auto-approve needs --token-file (an admin key).',
    ),
  );
  process.exit(2);
}

/** X-OAA-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>. */
function verify(header, body, toleranceSeconds = 300) {
  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((p) => p.split('=').map((s) => s.trim())),
  );
  const ts = Number(parts.t);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest();
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(parts.v1 ?? '') ? parts.v1 : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const seen = new Set(); // X-OAA-Delivery values already handled (deliveries are at-least-once)

async function approve(runId, actionId) {
  const response = await fetch(
    `${values.gateway}/v1/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
}

async function handle(event) {
  const d = event.data ?? {};
  console.log(`${event.type}  ${d.run_id ?? ''}  ${d.agent ?? ''}  ${d.status ?? ''}`.trimEnd());
  if (d.error) console.log(`  error: ${d.error.code}: ${d.error.message}`);
  if (event.type !== 'run.requires_action') return;
  for (const item of d.pending_actions ?? []) {
    const due = new Date(item.expires_at * 1000).toISOString();
    console.log(
      `  ${t('待处理', 'pending')} ${item.id}  ${item.type}  ${item.title}  ${t('到期', 'expires')} ${due}`,
    );
    if (item.status !== 'pending') continue;
    if (!values['auto-approve']) {
      console.log(
        `  ${t('未批准（加 --auto-approve 才会批准）', 'not approved (add --auto-approve to approve)')}`,
      );
      continue;
    }
    try {
      await approve(d.run_id, item.id);
      console.log(`  ${t('已批准', 'approved')} ${item.id}`);
    } catch (error) {
      console.log(`  ${t('批准失败', 'approval failed')}: ${error.message}`);
    }
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST' || !verify(req.headers['x-oaa-signature'], body)) {
      console.log(t('拒绝：签名无效或已过期', 'rejected: invalid or stale signature'));
      res.writeHead(401).end();
      return;
    }
    // Answer quickly; do the work after replying so the gateway does not time out (10 s).
    res.writeHead(204).end();
    const delivery = String(req.headers['x-oaa-delivery']);
    if (seen.has(delivery)) return;
    seen.add(delivery);
    handle(JSON.parse(body)).catch((error) => console.log(`handler error: ${error.message}`));
  });
});
server.listen(Number(values.port), values.host, () => {
  const { port } = server.address();
  console.log(
    t(
      `接收端已就绪：http://${values.host}:${port}/`,
      `Receiver ready: http://${values.host}:${port}/`,
    ),
  );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
