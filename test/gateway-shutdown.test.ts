import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stopDetachedGateway } from '../src/client/onboarding.js';
import { setup } from './helpers.js';

// Clean shutdown for `oaa stop` on Windows. No port is opened: app.inject only.

test('shutdown route: loopback admin closes the gateway, remote peers are refused', async (t) => {
  const s = await setup();
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  const remote = await s.app.inject({
    method: 'POST',
    url: '/v1/gateway/shutdown',
    remoteAddress: '203.0.113.9',
    headers: { authorization: `Bearer ${process.env.OAA_TEST_TOKEN}` },
  });
  assert.equal(remote.statusCode, 403);
  const anonymous = await s.app.inject({ method: 'POST', url: '/v1/gateway/shutdown' });
  assert.equal(anonymous.statusCode, 401);
  let closed = false;
  const close = s.app.close.bind(s.app);
  s.app.close = (() => {
    closed = true;
    return close();
  }) as typeof s.app.close;
  const ok = await s.request('POST', '/v1/gateway/shutdown');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().stopping, true);
  for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);
});

test('oaa stop: a successful graceful request avoids the signal', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-stop-graceful-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'server.pid'), '4242');
  let alive = true;
  const killed: number[] = [];
  const result = await stopDetachedGateway(
    dir,
    'http://127.0.0.1:9',
    (pid) => killed.push(pid),
    async () => (alive ? 4242 : undefined),
    async () => {
      alive = false;
      return true;
    },
  );
  assert.equal(result.stopped, true);
  assert.deepEqual(killed, []);
});

test('oaa stop: a failed graceful request falls back to the signal', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-stop-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'server.pid'), '4242');
  let alive = true;
  const killed: number[] = [];
  await stopDetachedGateway(
    dir,
    'http://127.0.0.1:9',
    (pid) => {
      killed.push(pid);
      alive = false;
    },
    async () => (alive ? 4242 : undefined),
    async () => {
      throw new Error('refused');
    },
  );
  assert.deepEqual(killed, [4242]);
});
