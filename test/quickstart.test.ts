import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerSchema } from '../src/config/config.js';
import { agentSchema } from '../src/core/contracts.js';
import { initSummary } from '../src/client/cli-text.js';
import {
  SAMPLE_ADAPTER,
  SAMPLE_AGENT,
  nextSteps,
  sampleAgentPath,
  sampleDefinition,
  syncConfig,
  usageLines,
} from '../src/client/quickstart.js';
import { buildBundle, makeBundle } from '../src/lang/bundle.js';
import { unavailableReason } from '../src/fabric/runnability.js';
import { claudeSdkStatus } from '../src/engines/claude-sdk.js';
import { setup, token } from './helpers.js';

// oaa quickstart 的组成部分、离线示例智能体、发布警告与改准的报错。不监听端口。

const cliPath = path.resolve('dist/src/cli.js');
const say = (zh: string) => zh;

async function fakeExecutable(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

test('quickstart: sample agent ships next to dist and its JSON definition matches the code', async () => {
  const script = sampleAgentPath(cliPath);
  assert.equal(script, path.resolve('examples/sample-agent.mjs'));
  const fromJson = await buildBundle(path.resolve('examples/sample-agent.json'), [], []);
  assert.equal(fromJson.digest, makeBundle(sampleDefinition()).digest);
  assert.equal(sampleDefinition().id, SAMPLE_AGENT);
  assert.equal(sampleDefinition().engine, `adapter/${SAMPLE_ADAPTER}`);
  assert.match(sampleDefinition().description, /calls no model/);
});

test('quickstart: syncConfig adds the sample agent once and records found natives as disabled', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'oaa-qs-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const agy = await fakeExecutable(bin, 'agy');
  const raw: Parameters<typeof syncConfig>[0] = { port: 8787, localWorker: { adapters: {} } };
  const sample = { node: '/usr/local/bin/node', script: '/x/examples/sample-agent.mjs' };
  assert.equal(syncConfig(raw, sample, 18787, bin), true);
  assert.equal(raw.port, 18787);
  assert.deepEqual(raw.localWorker?.adapters?.[SAMPLE_ADAPTER], {
    transport: 'acp',
    command: sample.node,
    args: [sample.script],
    enabled: true,
  });
  assert.deepEqual(raw.localWorker?.native?.antigravity, {
    executable: agy,
    enabled: false,
    args: [],
  });
  assert.equal(syncConfig(raw, sample, undefined, bin), false, 'second run changes nothing');
  assert.equal(syncConfig(raw, { ...sample, node: '/new/node' }, undefined, bin), true);
});

test('quickstart: printed usage has base URL, model, curl and the OpenAI SDK snippet', () => {
  const lines = usageLines({
    baseUrl: 'http://127.0.0.1:18787/v1',
    keyFile: '/d/.oaa/keys/quickstart.key',
    adminFile: '/d/.oaa/admin.token',
    url: 'http://127.0.0.1:18787',
    prefix: 'oaa',
    dirArgs: '',
    question: 'hi',
    t: (_zh, en) => en,
  }).join('\n');
  assert.match(lines, /Base URL : http:\/\/127\.0\.0\.1:18787\/v1/);
  assert.match(lines, /model {4}: agent\/sample/);
  assert.match(
    lines,
    /curl http:\/\/127\.0\.0\.1:18787\/v1\/chat\/completions .*cat '\/d\/\.oaa\/keys\/quickstart\.key'/,
  );
  assert.match(lines, /from openai import OpenAI/);
  assert.ok(!lines.includes('sk-oaa-'), 'never prints a key');
});

test('quickstart: next steps name installed agents, otherwise built-in agent with a model key', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'oaa-qs-next-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const codex = await fakeExecutable(bin, 'codex');
  const p = {
    url: 'http://127.0.0.1:1',
    adminFile: '/a',
    prefix: 'oaa',
    dirArgs: '',
    cliPath,
    t: say,
  };
  const withCodex = {
    localWorker: workerSchema.parse({
      nodeId: 'local',
      dataDir: bin,
      native: { codex: { executable: codex, enabled: false } },
    }),
  };
  const found = nextSteps(withCodex, p).join('\n');
  assert.match(found, /^  oaa connect codex    \# /m);
  assert.doesNotMatch(found, /curl|publish-native/);
  const none = nextSteps(
    { localWorker: workerSchema.parse({ nodeId: 'local', dataDir: bin }) },
    p,
  ).join('\n');
  assert.match(none, /^    oaa connect ollama$/m);
  assert.match(found, /connect deepseek --key-file/);
});

test('sample agent: offline ACP process does steps, a tool call and an approved write', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'oaa-sample-'));
  const child = spawn(process.execPath, [path.resolve('examples/sample-agent.mjs')], { cwd });
  // End the agent before removing its working directory: Windows cannot remove a directory that
  // is a live process's cwd, and a failed hook would leave the child (and this file) running.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await closed;
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const messages: Record<string, unknown>[] = [];
  let buffer = '';
  const waiters: [(m: Record<string, unknown>) => boolean, (m: Record<string, unknown>) => void][] =
    [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
      buffer = buffer.slice(nl + 1);
      messages.push(m);
      for (const w of [...waiters]) if (w[0](m)) waiters.splice(waiters.indexOf(w), 1) && w[1](m);
    }
  });
  const next = (pred: (m: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const hit = messages.find(pred);
      if (hit) resolve(hit);
      else waiters.push([pred, resolve]);
    });
  const send = (m: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  await next((m) => m.id === 1);
  send({ id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
  const sessionId = ((await next((m) => m.id === 2)).result as { sessionId: string }).sessionId;
  send({
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'please approve a write' }] },
  });
  const permission = await next((m) => m.method === 'session/request_permission');
  send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  const done = await next((m) => m.id === 3);
  assert.deepEqual(done.result, { stopReason: 'end_turn' });
  const updates = messages
    .filter((m) => m.method === 'session/update')
    .map((m) => (m.params as { update: Record<string, unknown> }).update);
  const text = updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => (u.content as { text: string }).text)
    .join('');
  assert.match(text, /offline sample agent\. It calls no model/);
  assert.match(text, /Approved; wrote outputs\/sample-note\.txt/);
  assert.ok(updates.some((u) => u.sessionUpdate === 'plan'));
  assert.ok(updates.some((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'clock-1'));
  assert.match(
    await readFile(path.join(cwd, 'outputs', 'sample-note.txt'), 'utf8'),
    /please approve/,
  );
});

test('runnability: names the missing engine, the disabled adapter, or the missing env var', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'oaa-run-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const codex = await fakeExecutable(bin, 'codex');
  const native = (engine: string) =>
    agentSchema.parse({
      id: `agent/${engine}`,
      engine,
      provider: 'native',
      model: 'default',
      description: engine,
      instructions: '',
      tools: [],
      routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
    });
  const worker = workerSchema.parse({
    nodeId: 'local',
    dataDir: bin,
    native: { codex: { executable: codex, enabled: false } },
    adapters: { off: { transport: 'acp', command: codex, args: [], enabled: false } },
    providers: { default: { kind: 'openai-responses', apiKeyEnv: 'OAA_TEST_MISSING_KEY' } },
  });
  assert.match(unavailableReason(worker, native('antigravity'))!.zh, /没有安装/);
  assert.match(unavailableReason(worker, native('antigravity'))!.en, /not installed/);
  assert.match(
    unavailableReason(worker, native('codex'))!.en,
    /installed but not enabled.*local\/backends\/codex/,
  );
  assert.match(unavailableReason(worker, native('adapter/off'))!.en, /configured but not enabled/);
  const kernel = agentSchema.parse({
    id: 'agent/k',
    description: 'k',
    model: 'm',
    instructions: 'x',
  });
  assert.match(
    unavailableReason(worker, kernel, {})!.en,
    /missing the environment variable OAA_TEST_MISSING_KEY/,
  );
  assert.equal(unavailableReason(worker, kernel, { OAA_TEST_MISSING_KEY: 'k' }), undefined);
  assert.equal(
    unavailableReason(worker, { ...native('antigravity'), allowedNodes: ['remote'] }),
    undefined,
    'agents pinned to other nodes are not judged by the local configuration',
  );
});

test('gateway: publish warns when the agent cannot run here; the call says why', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const published = await ctx.request(
    'POST',
    '/v1/agents/publish-native',
    { id: 'agent/agy', engine: 'antigravity', models: ['default'] },
    token,
    { 'accept-language': 'en' },
  );
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().warning.code, 'not_runnable_here');
  assert.match(published.json().warning.message, /Antigravity engine \(antigravity\)/);
  const call = await ctx.request(
    'POST',
    '/v1/chat/completions',
    { model: 'agent/agy', messages: [{ role: 'user', content: 'x' }] },
    token,
    { 'accept-language': 'zh' },
  );
  assert.equal(call.statusCode, 503);
  assert.equal(call.json().error.code, 'model_unavailable');
  assert.match(call.json().error.message, /引擎 .*antigravity.*没有安装/);
});

test('gateway: 401 says where keys come from; a restricted key gets the GET /v1/models hint', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const missing = await ctx.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: 'agent/x', messages: [] },
    headers: { 'accept-language': 'en' },
  });
  assert.equal(missing.statusCode, 401);
  assert.match(missing.json().error.message, /oaa key create.*oaa quickstart/);
  const key = (
    await ctx.request('POST', '/v1/keys', {
      name: 'r',
      agents: ['agent/research'],
      scopes: ['invoke', 'read'],
    })
  ).json().token as string;
  for (const model of ['agent/does-not-exist', 'agent/research-typo']) {
    const r = await ctx.request(
      'POST',
      '/v1/chat/completions',
      { model, messages: [{ role: 'user', content: 'x' }] },
      key,
      { 'accept-language': 'en' },
    );
    assert.equal(r.statusCode, 403, 'the same answer whether or not the agent exists');
    assert.match(r.json().error.message, /GET \/v1\/models/);
  }
});

test('init summary and Claude SDK hint are actionable for installer users', () => {
  const s = initSummary('/d/.oaa/config.json', '.oaa', 'en');
  assert.equal(s.admin_token_file, path.join('/d/.oaa', 'admin.token'));
  assert.match(s.next, /oaa quickstart/);
  const status = claudeSdkStatus({
    specifier: '@oaa-test/missing-sdk',
    vendorDir: '/nonexistent',
    npm: false,
  });
  assert.ok(status.status === 'requires_separate_install');
  assert.match(status.message, /nodejs\.org|找不到 npm/);
  const withNpm = claudeSdkStatus({
    specifier: '@oaa-test/missing-sdk',
    vendorDir: '/nonexistent',
    npm: true,
  });
  assert.ok(withNpm.status === 'requires_separate_install' && !/nodejs\.org/.test(withNpm.message));
});
