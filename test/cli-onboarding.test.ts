import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { GatewayClient } from '../src/client/client.js';
import { cliFailure } from '../src/client/cli-text.js';
import { createCallerKey, stopDetachedGateway } from '../src/client/onboarding.js';
import { Fault } from '../src/core/util.js';
import { setup, token } from './helpers.js';

// 上手路径的命令行：参数错误的码、网关没启动时的提示、`oaa key create`、`oaa stop`。不监听端口。

test('cli: unknown options fail as arguments, not execution_failed', async () => {
  await assert.rejects(main(['invoke', '--no-such-flag']), (e: unknown) => {
    assert.ok(e instanceof Fault);
    assert.equal(e.code, 'arguments');
    return true;
  });
});

test('client: an unreachable gateway says how to start it', async () => {
  // 端口 1 上没有服务：fetch 以 TypeError 失败，不需要也不会监听端口。
  const client = new GatewayClient('http://127.0.0.1:1', 'x'.repeat(32));
  await assert.rejects(client.request('GET', '/v1/me'), (e: unknown) => {
    assert.ok(e instanceof Fault);
    assert.equal(e.code, 'gateway_unreachable');
    assert.match(cliFailure(e, 'zh'), /下一步：.*oaa serve --detach/);
    assert.match(cliFailure(e, 'en'), /Next: .*oaa serve --detach/);
    return true;
  });
});

test('key create: writes a private caller key that can call the agent', async (t) => {
  const ctx = await setup();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-key-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await ctx.app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      payload: typeof init.body === 'string' ? init.body : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') },
    });
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await ctx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  await ctx.request('POST', '/v1/agents/publish', (await import('./helpers.js')).researchBundle());
  const admin = new GatewayClient('http://127.0.0.1:9', token);
  const out = path.join(dir, 'keys', 'app.key');
  const result = await createCallerKey(admin, { name: 'app', agents: ['agent/research'], out });
  assert.equal(result.token_file, out);
  assert.equal(result.base_url, 'http://127.0.0.1:9/v1');
  assert.equal(result.model, 'agent/research');
  assert.deepEqual(result.scopes.sort(), ['files', 'invoke', 'read']);
  assert.ok(!JSON.stringify(result).includes('sk-oaa-'), 'the key itself is not printed');
  assert.match(result.try, /chat\/completions/);
  const key = (await readFile(out, 'utf8')).trim();
  assert.match(key, /^sk-oaa-/);
  // Mode bits exist only on POSIX; Windows relies on the ACL (docs/windows.md).
  if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
  const listed = await ctx.request('GET', '/v1/models', undefined, key);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json().data.map((m: { id: string }) => m.id),
    ['agent/research'],
  );
  await assert.rejects(createCallerKey(admin, { name: 'app', out }), /already exists/);
  await assert.rejects(createCallerKey(admin, { name: 'bad name' }), /--name/);
});

test('stop: only signals the pid that /health reports, then removes the pid file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = 'http://127.0.0.1:9';
  await assert.rejects(stopDetachedGateway(dir, url), /not started with --detach/);
  await writeFile(path.join(dir, 'server.pid'), '4242');
  const killed: number[] = [];
  await assert.rejects(
    stopDetachedGateway(
      dir,
      url,
      (pid) => killed.push(pid),
      async () => 999,
    ),
    (e: unknown) => e instanceof Fault && e.code === 'not_running',
  );
  assert.equal(killed.length, 0);
  await writeFile(path.join(dir, 'server.pid'), '4242');
  let alive = true;
  const result = await stopDetachedGateway(
    dir,
    url,
    (pid, signal) => {
      killed.push(pid);
      assert.equal(signal, 'SIGTERM');
      alive = false;
    },
    async () => (alive ? 4242 : undefined),
  );
  assert.deepEqual(result, { stopped: true, pid: 4242, url });
  assert.deepEqual(killed, [4242]);
  await assert.rejects(stat(path.join(dir, 'server.pid')));
});
