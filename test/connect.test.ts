import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatewaySchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { GatewayClient } from '../src/client/client.js';
import { connectAgent, engineFor } from '../src/client/connect.js';
import { createCallerKey } from '../src/client/onboarding.js';
import { Fault } from '../src/core/util.js';
import { token } from './helpers.js';

// oaa connect：用 ACP 测试替身当作「本机已装的智能体」，走检测 → 启用 → 发布 → 密钥 → 打印命令，
// 并确认它从不调用这个智能体。网关经 app.inject 接到 fetch 上，不监听端口。

const URL_BASE = 'http://127.0.0.1:9';

async function gatewayWithFixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-connect-'));
  process.env.OAA_CONNECT_TEST_TOKEN = token;
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    keys: [
      {
        name: 'owner',
        owner: 'owner',
        tokenEnv: 'OAA_CONNECT_TEST_TOKEN',
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
    ],
    localWorker: {
      nodeId: 'local',
      dataDir: path.join(dir, 'worker'),
      adapters: {
        fixture: {
          transport: 'acp',
          command: process.execPath,
          args: [path.resolve('test/fixtures/acp-agent.mjs'), 'stream'],
          enabled: false,
        },
      },
    },
  });
  const gateway = await createGateway(config);
  await gateway.app.ready();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await gateway.app.inject({
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
    await gateway.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { gateway, dir, admin: new GatewayClient(URL_BASE, token) };
}

test('connect: names map to engines', () => {
  assert.equal(engineFor('codex'), 'codex');
  assert.equal(engineFor('agy'), 'antigravity');
  assert.equal(engineFor('Claude'), 'claude');
  assert.equal(engineFor('gemini'), 'adapter/gemini');
  assert.equal(engineFor('adapter/x'), 'adapter/x');
});

test('connect: enables, publishes, prepares a key, prints the call, never calls the agent; idempotent', async (t) => {
  const { gateway, dir, admin } = await gatewayWithFixture(t);
  const keysDir = path.join(dir, 'keys');
  const run = async () => {
    const lines: string[] = [];
    await connectAgent(admin, {
      name: 'fixture',
      keysDir,
      prefix: 'oaa',
      locale: 'en',
      out: (l) => lines.push(l),
    });
    return lines.join('\n');
  };
  const first = await run();
  assert.match(first, /1\/4 Found adapter\/fixture/);
  assert.match(first, /2\/4 Enabled adapter\/fixture on this gateway/);
  assert.match(first, /3\/4 Published as agent\/fixture/);
  assert.match(first, /4\/4 Created a key for agent\/fixture only: .*fixture\.key/);
  assert.match(first, /model {4}: agent\/fixture/);
  assert.match(first, /curl http:\/\/127\.0\.0\.1:9\/v1\/chat\/completions .*fixture\.key/);
  assert.match(first, /connect did not call adapter\/fixture/);
  assert.ok(!first.includes('sk-oaa-'), 'never prints a key');
  assert.match(await readFile(path.join(keysDir, 'fixture.key'), 'utf8'), /^sk-oaa-/);

  const second = await run();
  assert.match(second, /2\/4 Already enabled; skipped/);
  assert.match(second, /3\/4 agent\/fixture is already published; skipped/);
  assert.match(second, /4\/4 Reusing key: .*fixture\.key/);

  await createCallerKey(admin, {
    name: 'quickstart',
    agents: ['*'],
    out: path.join(keysDir, 'quickstart.key'),
  });
  assert.match(await run(), /4\/4 The same key can already call it: .*quickstart\.key/);

  const runs = await gateway.app.inject({
    method: 'GET',
    url: '/v1/runs',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(runs.json().data.length, 0, 'connect never invokes the agent');
});

test('connect: clear errors for a missing native agent and an unknown name', async (t) => {
  const { admin, dir } = await gatewayWithFixture(t);
  const keysDir = path.join(dir, 'keys');
  await assert.rejects(
    connectAgent(admin, {
      name: 'codex',
      keysDir,
      prefix: 'oaa',
      locale: 'zh',
      pathEnv: '',
      out: () => {},
    }),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'native_not_installed' &&
      /没有找到 codex.*oaa quickstart/.test(e.text?.zh ?? ''),
  );
  await assert.rejects(
    connectAgent(admin, {
      name: 'no-such-agent',
      keysDir,
      prefix: 'oaa',
      locale: 'en',
      out: () => {},
    }),
    (e: unknown) =>
      e instanceof Fault && e.code === 'backend_unavailable' && /oaa doctor/.test(e.text?.en ?? ''),
  );
});
