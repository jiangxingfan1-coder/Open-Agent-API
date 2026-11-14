import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GatewayClient } from '../src/client/client.js';
import {
  decideApprovals,
  listPending,
  renderPending,
  showApprovals,
  summarizeDetail,
} from '../src/client/approvals.js';
import { Fault } from '../src/core/util.js';
import { injectedGateway, until, type InjectedGateway } from './cli-helpers.js';

// oaa approvals / approve / deny: the sample agent (offline ACP) asks for a write permission when the
// task mentions approval. The gateway is reached through app.inject; no port is opened.

const run = promisify(execFile);

async function startApprovalRun(g: InjectedGateway, input = 'please ask for approval') {
  const started = await g.admin.request<{ id: string }>('POST', '/v1/invoke', {
    protocol: 'oaa/1',
    agent: 'agent/sample',
    input,
    background: true,
  });
  await until(async () =>
    (await listPending(g.admin)).pending.some((a) => a.run_id === started.id),
  );
  return started.id;
}
const state = (g: InjectedGateway, id: string) =>
  g.admin.request<{ status: string; error?: { code: string } | null }>(
    'GET',
    `/v1/runs/${id}/wait?timeout_ms=15000`,
  );

test('approvals: lists a pending approval with agent, operation and expiry; approve continues the run', async (t) => {
  const g = await injectedGateway(t);
  const runId = await startApprovalRun(g);
  const { pending } = await listPending(g.admin);
  assert.equal(pending.length, 1);
  const item = pending[0]!;
  assert.equal(item.run_id, runId);
  assert.equal(item.agent, 'agent/sample');
  assert.equal(item.kind, 'native');
  assert.match(item.summary, /Write outputs\/sample-note\.txt/);
  assert.ok(item.expires_at > Date.now());

  const table = renderPending(pending, 'en').join('\n');
  assert.match(table, /Pending approvals: 1/);
  assert.match(
    table,
    new RegExp(`${runId}\\s+agent/sample\\s+${item.action_id}\\s+in .*Write outputs`),
  );
  assert.match(renderPending(pending, 'zh').join('\n'), /待审批项：1/);
  assert.deepEqual(renderPending([], 'en'), ['No pending approvals.']);

  const lines: string[] = [];
  const results = await decideApprovals(g.admin, {
    run: runId,
    decision: 'approve',
    yes: true,
    interactive: false,
    out: (l) => lines.push(l),
    locale: 'en',
  });
  assert.deepEqual(
    results.map((r) => [r.ok, r.decision]),
    [[true, 'approve']],
  );
  const text = lines.join('\n');
  assert.match(text, /Approve: approval_\S+ \(native, run /);
  assert.match(
    text,
    /"title": "Write outputs\/sample-note\.txt"/,
    'the operation is printed first',
  );
  assert.match(text, /Approved approval_/);
  assert.equal((await state(g, runId)).status, 'completed');
  assert.deepEqual((await listPending(g.admin)).pending, []);
});

test('deny: the run fails with permission_denied and the reason is recorded with the approval', async (t) => {
  const g = await injectedGateway(t);
  const runId = await startApprovalRun(g);
  const lines: string[] = [];
  const [result] = await decideApprovals(g.admin, {
    run: runId,
    decision: 'deny',
    reason: 'not on a production host',
    interactive: false,
    out: (l) => lines.push(l),
    locale: 'zh',
  });
  assert.equal(result?.ok, true);
  assert.match(lines.join('\n'), /已拒绝 approval_/);
  const final = await state(g, runId);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'permission_denied');
  const detail = await g.admin.request<{ actions: { status: string; response?: unknown }[] }>(
    'GET',
    `/v1/runs/${runId}`,
  );
  assert.equal(detail.actions[0]?.status, 'denied');
  assert.deepEqual(detail.actions[0]?.response, { reason: 'not on a production host' });
});

test('approvals --watch prints a new pending approval once and stops cleanly on abort', async (t) => {
  const g = await injectedGateway(t);
  const lines: string[] = [];
  const controller = new AbortController();
  const watching = showApprovals(g.admin, {
    watch: true,
    json: true,
    out: (l) => lines.push(l),
    signal: controller.signal,
    intervalMs: 40,
    locale: 'en',
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(lines, [], 'nothing is printed while nothing is pending');
  const runId = await startApprovalRun(g);
  await until(() => lines.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await watching;
  assert.equal(lines.length, 1, 'each pending item is printed once');
  assert.equal((JSON.parse(lines[0]!) as { run_id: string }).run_id, runId);
});

test('approve: a key without the approve scope is refused before anything is shown or sent', async (t) => {
  const g = await injectedGateway(t);
  const runId = await startApprovalRun(g);
  const lines: string[] = [];
  await assert.rejects(
    decideApprovals(g.caller, { run: runId, decision: 'approve', out: (l) => lines.push(l) }),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'scope_denied' &&
      /--token-file/.test(e.text?.en ?? '') &&
      /审批权限/.test(e.text?.zh ?? ''),
  );
  assert.deepEqual(lines, []);
  assert.equal(
    (await g.admin.request<{ status: string }>('GET', `/v1/runs/${runId}/state`)).status,
    'requires_action',
  );
});

// A scripted client for the multi-item cases: one run, two pending approvals, plus the decisions made.
function scripted(items: { id: string; title: string }[], reject: Record<string, number> = {}) {
  const posts: { path: string; body: unknown }[] = [];
  const client = {
    request: async (method: string, endpoint: string, body?: unknown) => {
      if (endpoint === '/v1/me') return { principal: { scopes: ['approve'] } };
      if (method === 'GET' && endpoint.includes('/actions?'))
        return {
          data: [
            ...items.map((item) => ({
              id: item.id,
              kind: 'native',
              expires_at: Date.now() + 60_000,
              detail: {
                preview: JSON.stringify({ title: item.title, kind: 'edit' }),
                truncated: false,
              },
            })),
            {
              id: 'caller-1',
              kind: 'client_tool',
              expires_at: 0,
              detail: { preview: '{}', truncated: false },
            },
          ],
          total: items.length + 1,
          next_offset: null,
        };
      posts.push({ path: endpoint, body });
      const id = endpoint.split('/').at(-1)!;
      if (reject[id])
        throw new Fault('stale_approval', 'Approval is no longer pending.', reject[id]);
      return { resolved: true };
    },
  } as unknown as GatewayClient;
  return { client, posts };
}
const two = [
  { id: 'a1', title: 'Write a.txt' },
  { id: 'a2', title: 'Run rm -rf build' },
];
const base = { run: 'run_1', decision: 'approve' as const, interactive: false, out: () => {} };

test('approve: several pending items need --action or --all; nothing is decided otherwise', async () => {
  const s = scripted(two);
  await assert.rejects(
    decideApprovals(s.client, { ...base, locale: 'en' }),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'approval_ambiguous' &&
      /2 pending approvals; none was decided/.test(e.text?.en ?? '') &&
      /a1 {2}Write a\.txt \(edit\)/.test(e.text?.en ?? '') &&
      /a2 {2}Run rm -rf build/.test(e.text?.en ?? ''),
  );
  assert.deepEqual(s.posts, []);
});

test('approve --action decides one item; --all decides every item; the caller-tool wait is never offered', async () => {
  const one = scripted(two);
  await decideApprovals(one.client, { ...base, action: 'a2' });
  assert.deepEqual(one.posts, [
    { path: '/v1/runs/run_1/actions/a2', body: { decision: 'approve', response: {} } },
  ]);
  const all = scripted(two);
  const results = await decideApprovals(all.client, { ...base, all: true });
  assert.deepEqual(
    all.posts.map((p) => p.path),
    ['/v1/runs/run_1/actions/a1', '/v1/runs/run_1/actions/a2'],
  );
  assert.equal(results.length, 2);
  const denied = scripted(two);
  await decideApprovals(denied.client, { ...base, decision: 'deny', all: true, reason: 'no' });
  assert.deepEqual(denied.posts[1]?.body, { decision: 'deny', response: { reason: 'no' } });
});

test('approve: unknown item, no pending items, conflicting flags and stale items', async () => {
  await assert.rejects(
    decideApprovals(scripted(two).client, { ...base, action: 'zzz' }),
    (e: unknown) =>
      e instanceof Fault && e.code === 'approval_not_found' && /a1, a2/.test(e.text?.en ?? ''),
  );
  await assert.rejects(
    decideApprovals(scripted([]).client, base),
    (e: unknown) => e instanceof Fault && e.code === 'approval_not_found',
  );
  await assert.rejects(
    decideApprovals(scripted(two).client, { ...base, all: true, action: 'a1' }),
    (e: unknown) => e instanceof Fault && e.code === 'arguments',
  );
  const lines: string[] = [];
  const stale = scripted(two, { a2: 409 });
  const results = await decideApprovals(stale.client, {
    ...base,
    all: true,
    out: (l) => lines.push(l),
    locale: 'en',
  });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, false],
  );
  assert.match(lines.join('\n'), /Failed a2: stale_approval/);
});

test('approve: asks only when interactive; a "no" decides nothing; --yes and scripts never ask', async () => {
  const asked: string[] = [];
  const confirm = async (question: string) => {
    asked.push(question);
    return false;
  };
  const declined = scripted([two[0]!]);
  await assert.rejects(
    decideApprovals(declined.client, { ...base, interactive: true, confirm, locale: 'en' }),
    (e: unknown) => e instanceof Fault && e.code === 'approval_declined',
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /Approve the 1 item\(s\) above\? \[y\/N\]/);
  assert.deepEqual(declined.posts, []);
  for (const options of [{ yes: true, interactive: true }, { interactive: false }]) {
    const s = scripted([two[0]!]);
    await decideApprovals(s.client, { ...base, ...options, confirm });
    assert.equal(s.posts.length, 1);
  }
  assert.equal(asked.length, 1, 'no further questions');
  const deny = scripted([two[0]!]);
  await decideApprovals(deny.client, { ...base, decision: 'deny', interactive: true, confirm });
  assert.equal(deny.posts.length, 1, 'denying never asks');
});

test('summarizeDetail: ACP, tool and unknown shapes', () => {
  assert.equal(
    summarizeDetail(
      JSON.stringify({
        native: 'acp',
        title: 'Write note.txt',
        kind: 'edit',
        locations: [{ path: 'note.txt' }],
      }),
    ),
    'Write note.txt (edit)',
  );
  assert.equal(
    summarizeDetail(JSON.stringify({ tool: 'shell', arguments: { command: 'ls -la' } })),
    'shell ls -la',
  );
  assert.equal(summarizeDetail('{"a":1}'), '{"a":1}');
  assert.equal(summarizeDetail('not json'), 'not json');
});

test('cli: approve without a run ID and approvals without any key fail with clear messages', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'oaa-cli-empty-'));
  try {
    const cli = path.resolve('dist/src/cli.js');
    const env = { ...process.env, OAA_LOCALE: 'en', OAA_TOKEN_FILE: '', OAA_GATEWAY_URL: '' };
    const noRun = await run(process.execPath, [cli, 'approve', '--dir', empty], { env }).catch(
      (e: { stderr: string; code: number }) => e,
    );
    assert.equal((noRun as { code: number }).code, 1);
    assert.match((noRun as { stderr: string }).stderr, /^arguments: approve needs a run ID/);
    const noKey = await run(process.execPath, [cli, 'approvals', '--dir', empty], { env }).catch(
      (e: { stderr: string; code: number }) => e,
    );
    assert.equal((noKey as { code: number }).code, 1);
    assert.match((noKey as { stderr: string }).stderr, /^token_required: No key found/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
