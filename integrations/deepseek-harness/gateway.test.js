import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGateway, gatewayBase } from './gateway.js';

async function setup(t, handler, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-oaa-test-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'sk-oaa-test\n', { mode: options.mode ?? 0o600 });
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return createGateway({
    OAA_DSH_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    OAA_DSH_TOKEN_FILE: tokenFile,
    OAA_DSH_ALLOW_INVOKE: options.invoke === false ? undefined : '1',
  });
}

test('normalizes origin or /v1 and refuses credentials, subpaths and remote plaintext', () => {
  assert.equal(gatewayBase(), 'http://127.0.0.1:8787/v1');
  assert.equal(gatewayBase('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(gatewayBase('http://[::1]:8787/'), 'http://[::1]:8787/v1');
  for (const invalid of ['http://example.com', 'https://user:pass@example.com',
    'https://example.com/other/v1', 'https://example.com?unsafe=1']) {
    assert.throws(() => gatewayBase(invalid), /gateway must be/);
  }
});

test('delegates once per call with an idempotency key, then reads bounded state and output', async t => {
  const calls = [];
  const gateway = await setup(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push([req.method, req.url, req.headers.authorization, req.headers['idempotency-key'],
      body ? JSON.parse(body) : undefined]);
    if (req.url.startsWith('/v1/catalog/agents')) res.end(JSON.stringify({ data: [], next_offset: null }));
    else if (req.url === '/v1/invoke') res.end(JSON.stringify({ id: 'resp_test', status: 'queued' }));
    else if (req.url.includes('/wait?')) res.end(JSON.stringify({ status: 'requires_action' }));
    else res.end(JSON.stringify({ text: 'done', next_cursor: 'page-two' }));
  });
  assert.deepEqual(await gateway.list({}), { data: [], next_offset: null });
  const receipt = await gateway.invoke({ agent: 'agent/sample', input: 'test', idempotency_key: 'one-task' });
  assert.deepEqual(receipt, { id: 'resp_test', status: 'queued' });
  assert.deepEqual(await gateway.wait({ response_id: receipt.id }), { status: 'requires_action' });
  assert.equal((await gateway.read({ response_id: receipt.id, cursor: 'a&b' })).text, 'done');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1], ['POST', '/v1/invoke', 'Bearer sk-oaa-test', 'one-task',
    { protocol: 'oaa/1', background: true, agent: 'agent/sample', model: 'auto', input: 'test' }]);
  assert.equal(calls[2][1], '/v1/runs/resp_test/wait?timeout_ms=10000');
  assert.equal(calls[3][1], '/v1/runs/resp_test/output?max_bytes=4000&cursor=a%26b');
  assert.throws(() => gateway.wait({ response_id: '../approval' }), /response ID/);
  assert.throws(() => gateway.list({ offset: 1 }), /catalog revision/);
  await assert.rejects(gateway.invoke({ agent: 'agent/sample', input: 'test', idempotency_key: 'unsafe key' }), /idempotency key/);
  assert.equal(calls.length, 4);
});

test('blocks disabled delegation and privately reports upstream HTTP failures', async t => {
  let count = 0;
  const gateway = await setup(t, (_req, res) => {
    count++;
    res.writeHead(403);
    res.end('private upstream response');
  }, { invoke: false });
  await assert.rejects(gateway.invoke({}), /Delegation is disabled/);
  assert.equal(count, 0);
  await assert.rejects(gateway.list({}), { message: 'OAA gateway rejected the request (HTTP 403).' });
});

test('refuses redirect, overlong replies, and already-aborted requests', async t => {
  let count = 0;
  const gateway = await setup(t, (_req, res) => {
    count++;
    if (count === 1) {
      res.writeHead(302, { Location: '/redirect-target' });
      res.end();
    } else res.end('a'.repeat(70 * 1024));
  });
  await assert.rejects(gateway.list({}), /redirects are not allowed/);
  assert.equal(count, 1);
  await assert.rejects(gateway.list({}), /exceeded 64 KiB/);
  await assert.rejects(gateway.list({}, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(count, 2);
});

test('refuses a world-readable key file on Unix', { skip: process.platform === 'win32' }, async t => {
  const gateway = await setup(t, (_req, res) => res.end('not expected'), { mode: 0o644 });
  await assert.rejects(gateway.list({}), /private permissions/);
});
