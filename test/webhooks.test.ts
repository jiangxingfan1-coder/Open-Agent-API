// Webhooks, offline part: signatures, retry schedule, payload shaping, URL rules, event filter and
// the admin API through app.inject. Nothing here opens a port (deliveries are tested in
// webhooks-delivery.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  OUTPUT_LIMIT_BYTES,
  checkWebhookUrl,
  isPrivateAddress,
  retryDelay,
  runData,
  signature,
  snapshotOutput,
  truncateOutput,
  verifySignature,
  wants,
  type TargetPolicy,
} from '../src/gateway/webhook-core.js';
import { faultOf } from '../src/core/util.js';
import { runWebhookCommand } from '../src/client/webhook-cli.js';
import { injectedGateway } from './cli-helpers.js';
import { setup, secondToken, token } from './helpers.js';

const local: TargetPolicy = {
  profile: 'local',
  allowInsecureHttp: false,
  allowPrivateNetwork: false,
};
const pub: TargetPolicy = { ...local, profile: 'public' };

test('webhook signature: HMAC over "t.body", verified with a timestamp tolerance', () => {
  const header = signature('whsec_test', 1_700_000_000, '{"a":1}');
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.ok(verifySignature('whsec_test', header, '{"a":1}', 1_700_000_000));
  assert.ok(verifySignature('whsec_test', header, '{"a":1}', 1_700_000_299));
  assert.ok(!verifySignature('whsec_test', header, '{"a":1}', 1_700_000_301), 'replay window');
  assert.ok(!verifySignature('whsec_test', header, '{"a":2}', 1_700_000_000), 'body changed');
  assert.ok(!verifySignature('other', header, '{"a":1}', 1_700_000_000), 'wrong secret');
  assert.ok(!verifySignature('whsec_test', 't=x,v1=zz', '{"a":1}', 1_700_000_000));
});

test('webhook snapshot has the UTF-8 size of the entire output and keeps valid replacement characters at the boundary', () => {
  for (const parts of [
    [],
    ['', ''],
    ['a', 'b'],
    ['a'.repeat(OUTPUT_LIMIT_BYTES - 3) + '�', 'b'],
    ['a'.repeat(OUTPUT_LIMIT_BYTES - 2) + '世', '🙂'.repeat(23000)],
  ]) {
    const joined = parts.join('\n'),
      result = snapshotOutput(parts.map((text) => ({ text })));
    assert.equal(result.bytes, Buffer.byteLength(joined));
    assert.equal(result.truncated, result.bytes > OUTPUT_LIMIT_BYTES);
    assert.ok(joined.startsWith(result.text));
    assert.ok(Buffer.byteLength(result.text) <= OUTPUT_LIMIT_BYTES);
  }
  assert.equal(truncateOutput('a�b', 4).text, 'a�');
});

test('webhook retry schedule: bounded attempts with jitter inside ±20 %', () => {
  const schedule = [1000, 2000, 4000];
  assert.equal(retryDelay(1, schedule, 0), 1000);
  assert.equal(retryDelay(3, schedule, 0), 4000);
  assert.equal(retryDelay(4, schedule, 0), undefined, 'exhausted after the schedule');
  assert.equal(
    retryDelay(1, schedule, 0.2, () => 0),
    800,
  );
  assert.equal(
    retryDelay(1, schedule, 0.2, () => 1),
    1200,
  );
  const defaults = [1, 2, 3, 4, 5].map((n) => retryDelay(n, undefined, 0)!);
  assert.deepEqual(defaults, [5_000, 30_000, 120_000, 600_000, 1_800_000]);
});

test('webhook payload: run summary without input; output only on request and truncated', () => {
  const run = {
    id: 'resp_1',
    agentId: 'agent/x',
    digest: 'd'.repeat(64),
    status: 'completed',
    error: null,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    keyId: 'key_1',
    subject: 'key:key_1',
    createdAt: 1_700_000_000_123,
    updatedAt: 1_700_000_005_999,
    output: '世'.repeat(20_000),
  };
  const plain = runData(run, 'completed');
  assert.deepEqual(Object.keys(plain).sort(), [
    'agent',
    'agent_version',
    'created_at',
    'error',
    'key_id',
    'object',
    'run_id',
    'status',
    'subject',
    'updated_at',
    'usage',
  ]);
  assert.equal(plain.created_at, 1_700_000_000);
  const withOutput = runData(run, 'completed', { includeOutput: true }) as {
    output: { text: string; truncated: boolean; bytes: number };
  };
  assert.equal(withOutput.output.truncated, true);
  assert.equal(withOutput.output.bytes, 60_000);
  assert.ok(Buffer.byteLength(withOutput.output.text) <= OUTPUT_LIMIT_BYTES);
  assert.ok(!withOutput.output.text.includes('�'), 'no split character');
  assert.deepEqual(truncateOutput('short'), { text: 'short', truncated: false, bytes: 5 });
  const pending = runData(run, 'requires_action', {
    pending: [{ id: 'a', type: 'native', title: 'Write x', status: 'pending', expires_at: 1 }],
  });
  assert.equal((pending.pending_actions as unknown[]).length, 1);
});

test('webhook URL rules: scheme, credentials, plain http, and private targets under public', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return faultOf(e).code;
    }
  };
  assert.equal(
    code(() => checkWebhookUrl('https://hooks.example.com/x', local)),
    'ok',
  );
  assert.equal(
    code(() => checkWebhookUrl('http://127.0.0.1:9/x', local)),
    'ok',
  );
  assert.equal(
    code(() => checkWebhookUrl('http://localhost:9/x', local)),
    'ok',
  );
  assert.equal(
    code(() => checkWebhookUrl('ftp://example.com', local)),
    'webhook_url_invalid',
  );
  assert.equal(
    code(() => checkWebhookUrl('not a url', local)),
    'webhook_url_invalid',
  );
  assert.equal(
    code(() => checkWebhookUrl('https://u:p@example.com', local)),
    'webhook_url_invalid',
  );
  assert.equal(
    code(() => checkWebhookUrl('http://example.com/x', local)),
    'webhook_url_invalid',
  );
  assert.equal(
    code(() => checkWebhookUrl('http://example.com/x', { ...local, allowInsecureHttp: true })),
    'ok',
  );
  // local: private targets allowed; public: refused unless the endpoint opts in.
  assert.equal(
    code(() => checkWebhookUrl('https://10.0.0.5/x', local)),
    'ok',
  );
  for (const target of [
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://172.20.0.1/x',
    'https://169.254.169.254/latest',
    'https://100.100.100.200/x',
    'https://[::1]/x',
    'https://[fd00:ec2::254]/x',
    'https://[fe80::1]/x',
    'https://[::ffff:10.0.0.1]/x',
    'http://127.0.0.1:9/x',
    'https://localhost/x',
  ])
    assert.equal(
      code(() => checkWebhookUrl(target, pub)),
      'webhook_target_denied',
      target,
    );
  assert.equal(
    code(() => checkWebhookUrl('https://hooks.example.com/x', pub)),
    'ok',
  );
  assert.equal(
    code(() => checkWebhookUrl('https://8.8.8.8/x', pub)),
    'ok',
  );
  assert.equal(
    code(() => checkWebhookUrl('https://10.0.0.5/x', { ...pub, allowPrivateNetwork: true })),
    'ok',
  );
  assert.ok(isPrivateAddress('172.31.255.255'));
  assert.ok(!isPrivateAddress('172.32.0.1'));
  assert.ok(!isPrivateAddress('example.com'));
});

test('webhook event filter: empty lists mean all; disabled endpoints get nothing', () => {
  const e = { enabled: true, events: [] as string[], agents: [] as string[] };
  assert.ok(wants(e, 'run.completed', 'agent/a'));
  assert.ok(!wants({ ...e, enabled: false }, 'run.completed', 'agent/a'));
  assert.ok(wants({ ...e, events: ['run.failed'] }, 'run.failed', 'agent/a'));
  assert.ok(!wants({ ...e, events: ['run.failed'] }, 'run.completed', 'agent/a'));
  assert.ok(!wants({ ...e, agents: ['agent/b'] }, 'run.completed', 'agent/a'));
});

test('webhook API: owner-wide admin only; secret returned once; update, rotate, delete', async () => {
  const s = await setup();
  try {
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.ok(health.json().features.includes('webhooks-v1'));
    const created = await s.request('POST', '/v1/webhooks', {
      url: 'http://127.0.0.1:9/hook',
      events: ['run.completed'],
      description: 'ops',
    });
    assert.equal(created.statusCode, 201);
    const endpoint = created.json();
    assert.match(endpoint.id, /^wh_/);
    assert.match(endpoint.secret, /^whsec_/);
    assert.equal(endpoint.status.state, 'ok');
    const listed = (await s.request('GET', '/v1/webhooks')).json().data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].secret, undefined, 'the secret is never listed');
    assert.equal(JSON.stringify(listed).includes(endpoint.secret), false);

    const patched = await s.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${endpoint.id}`,
      payload: { enabled: false, agents: ['agent/test'] },
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().status.state, 'disabled');
    assert.deepEqual(patched.json().agents, ['agent/test']);

    const rotated = (await s.request('POST', `/v1/webhooks/${endpoint.id}/rotate-secret`)).json();
    assert.match(rotated.secret, /^whsec_/);
    assert.notEqual(rotated.secret, endpoint.secret);

    const bad = await s.request('POST', '/v1/webhooks', { url: 'http://example.com/x' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'webhook_url_invalid');
    const unknownEvent = await s.request('POST', '/v1/webhooks', {
      url: 'http://127.0.0.1:9/x',
      events: ['response.output_text.delta'],
    });
    assert.equal(unknownEvent.statusCode, 400);

    // Another owner cannot see or touch it.
    const other = await s.request('GET', `/v1/webhooks/${endpoint.id}`, undefined, secondToken);
    assert.equal(other.statusCode, 404);
    assert.equal(other.json().error.code, 'webhook_not_found');

    const removed = await s.request('DELETE', `/v1/webhooks/${endpoint.id}`);
    assert.equal(removed.statusCode, 204);
    assert.equal((await s.request('GET', `/v1/webhooks/${endpoint.id}`)).statusCode, 404);

    const spec = (await s.request('GET', '/openapi.json')).json();
    assert.ok(spec.paths['/v1/webhooks'].post);
    assert.ok(spec.paths['/v1/webhooks/{id}/deliveries/{delivery}/redeliver'].post);
  } finally {
    await s.cleanup();
  }
});

test('webhook API: keys that are not owner-wide admins are refused', async () => {
  const s = await setup();
  try {
    const key = await s.request('POST', '/v1/keys', {
      name: 'caller',
      agents: ['*'],
      scopes: ['invoke', 'read', 'approve'],
    });
    const callerToken = key.json().token as string;
    for (const [method, url] of [
      ['GET', '/v1/webhooks'],
      ['POST', '/v1/webhooks'],
    ] as const) {
      const r = await s.request(method, url, { url: 'http://127.0.0.1:9/x' }, callerToken);
      assert.equal(r.statusCode, 403, `${method} ${url}`);
      assert.equal(r.json().error.code, 'scope_denied');
    }
  } finally {
    await s.cleanup();
  }
});

test('webhook API: the public profile refuses private targets unless the endpoint opts in', async () => {
  const s = await setup(undefined, { security: { profile: 'public' } });
  try {
    const denied = await s.request('POST', '/v1/webhooks', { url: 'https://10.1.2.3/hook' });
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.json().error.code, 'webhook_target_denied');
    const meta = await s.request('POST', '/v1/webhooks', {
      url: 'https://169.254.169.254/latest/meta-data',
    });
    assert.equal(meta.json().error.code, 'webhook_target_denied');
    const allowed = await s.request('POST', '/v1/webhooks', {
      url: 'https://10.1.2.3/hook',
      allow_private_network: true,
    });
    assert.equal(allowed.statusCode, 201);
  } finally {
    await s.cleanup();
  }
});

test('oaa webhook: add, list, test, deliveries and remove (bilingual output)', async (t) => {
  const g = await injectedGateway(t);
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  // Port 9 on loopback: nothing listens there, so the test delivery fails fast.
  await runWebhookCommand(
    g.admin,
    ['add', 'http://127.0.0.1:9/hook'],
    { event: ['run.completed', 'run.requires_action'], agent: ['agent/sample'] },
    out,
    'en',
  );
  assert.match(lines[0]!, /^Added webhook endpoint wh_/);
  assert.match(lines[1]!, /events: run\.completed, run\.requires_action {2}agents: agent\/sample/);
  assert.match(lines[2]!, /^Signing secret \(shown only once; .*\): whsec_/);

  // --out: the secret goes to a new private file and is not printed; an existing file is refused.
  const secretFile = path.join(g.dir, 'second.secret');
  const printed: string[] = [];
  await runWebhookCommand(
    g.admin,
    ['add', 'http://127.0.0.1:9/other'],
    { out: secretFile },
    (l) => printed.push(l),
    'en',
  );
  assert.match(await readFile(secretFile, 'utf8'), /^whsec_\S+\n$/);
  // Mode bits exist only on POSIX; Windows relies on the ACL (docs/windows.md).
  if (process.platform !== 'win32') assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
  assert.equal(printed.join('\n').includes('whsec_'), false);
  await assert.rejects(
    runWebhookCommand(g.admin, ['add', 'http://127.0.0.1:9/x'], { out: secretFile }, out, 'en'),
    (e: Error & { code?: string }) => e.code === 'output_exists',
  );
  const second = /wh_[0-9a-f]+/.exec(printed[0]!)![0];
  await runWebhookCommand(g.admin, ['remove', second], {}, () => {}, 'en');
  const id = /wh_[0-9a-f]+/.exec(lines[0]!)![0];

  lines.length = 0;
  await runWebhookCommand(g.admin, ['list'], {}, out, 'zh');
  assert.match(lines.join('\n'), new RegExp(`${id} {2}http://127\\.0\\.0\\.1:9/hook {2}ok`));
  assert.match(lines.join('\n'), /排队: 0 {2}连续失败: 0/);

  lines.length = 0;
  const exitCode = process.exitCode;
  await runWebhookCommand(g.admin, ['test', id], {}, out, 'en');
  process.exitCode = exitCode;
  assert.match(
    lines[0]!,
    /whd_\S+ .* webhook\.test {2}pending {2}HTTP — \d+ms {2}1 attempt\(s\) {2}connect ECONNREFUSED/,
  );

  lines.length = 0;
  await runWebhookCommand(g.admin, ['deliveries', id], { json: true }, out, 'en');
  assert.equal(JSON.parse(lines.join('\n'))[0].event_type, 'webhook.test');

  lines.length = 0;
  await runWebhookCommand(g.admin, ['remove', id], {}, out, 'zh');
  assert.match(lines[0]!, /^已删除 wh_/);
  lines.length = 0;
  await runWebhookCommand(g.admin, ['list'], {}, out, 'zh');
  assert.deepEqual(lines, ['还没有事件回调端点。']);
  await assert.rejects(runWebhookCommand(g.admin, ['remove'], {}, out, 'en'), (e: Error) =>
    /endpoint ID|端点编号/.test(e.message),
  );
});
