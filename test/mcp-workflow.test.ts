import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { GatewayClient } from '../src/client/client.js';
import { createMcpBridge } from '../src/client/mcp.js';
import { outputPage, textPrefix } from '../src/store/inspection.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { Fault, sleep } from '../src/core/util.js';
import type { OutputMessage, RunStatus } from '../src/core/contracts.js';
import {
  setup,
  FixtureModel,
  researchFixture,
  researchBundle,
  agent,
  principal,
  token,
  secondToken,
  waitFor,
} from './helpers.js';

const exec = promisify(execFile);
const cli = path.resolve('dist/src/cli.js');
const payload = <T = Record<string, unknown>>(raw: unknown): T => {
  const result = CallToolResultSchema.parse(raw);
  if (result.structuredContent) return result.structuredContent as T;
  const text = result.content.find((c) => c.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text) as T;
};
async function bridge(url: string, key = token) {
  const server = createMcpBridge(new GatewayClient(url, key));
  const client = new Client({ name: 'workflow-fixture', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('output cursors preserve escaped Unicode text, message boundaries, and post-interruption tails', () => {
  const text = '\ud83d\ude00\u4e2d\u6587\n"\\\u0001'.repeat(900);
  const run = {
    id: 'resp_fixture',
    status: 'completed' as RunStatus,
    output: [
      { id: 'msg_first', text, status: 'completed' as const },
      { id: 'msg_second', text: 'second', status: 'completed' as const },
    ],
  };
  let cursor: string | undefined;
  let reconstructed = '';
  let last = outputPage(run, cursor, 256);
  for (let pages = 0; pages < 1000; pages++) {
    const page = outputPage(run, cursor, 256);
    assert.ok(Buffer.byteLength(JSON.stringify(page.text)) <= 256);
    assert.equal(page.text, Buffer.from(page.text).toString('utf8'));
    reconstructed += page.text;
    last = page;
    if (page.done) break;
    assert.ok(page.next_cursor && page.next_cursor !== cursor);
    cursor = page.next_cursor;
  }
  assert.equal(last.done, true);
  assert.equal(reconstructed, text + 'second');
  assert.throws(() => outputPage({ ...run, id: 'another' }, last.tail_cursor), /another response/);
  assert.throws(() => outputPage(run, 'not-json'), /invalid/);
  const next = {
    ...run,
    output: [...run.output, { id: 'msg_resumed', text: 'resumed', status: 'completed' as const }],
  };
  assert.equal(outputPage(next, last.tail_cursor).text, 'resumed');
  assert.equal(textPrefix('\ud83d\ude00x', 6), '\ud83d\ude00');
});

test('an unfinished surrogate is held until its matching streaming delta arrives', () => {
  const output: OutputMessage[] = [{ id: 'msg', text: 'prefix\ud83d', status: 'in_progress' }];
  const run = { id: 'resp_stream', status: 'in_progress' as RunStatus, output };
  const first = outputPage(run);
  assert.equal(first.text, 'prefix');
  assert.equal(first.waiting_for_output, true);
  output[0]!.text += '\ude00suffix';
  output[0]!.status = 'completed';
  run.status = 'completed';
  const second = outputPage(run, first.next_cursor!);
  assert.equal(second.text, '\ud83d\ude00suffix');
  assert.equal(second.done, true);
});

test('generated MCP configuration drives a real stdio upload, invoke, wait, and report-resource workflow', async () => {
  const s = await setup(researchFixture());
  const client = new Client({ name: 'stdio-workflow-fixture', version: '1.0.0' });
  try {
    s.store.publish('owner', researchBundle());
    const url = await s.listen();
    const tokenFile = path.join(s.dir, 'client.token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    const integration = path.join(s.dir, 'mcp.json');
    await exec(process.execPath, [
      cli,
      'integration',
      '--out',
      integration,
      '--url',
      url,
      '--token-file',
      tokenFile,
    ]);
    const config = JSON.parse(await readFile(integration, 'utf8')).mcpServers['open-agent-api'];
    assert.ok(path.isAbsolute(config.command));
    assert.ok(!JSON.stringify(config).includes(token));
    await client.connect(new StdioClientTransport(config));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'oaa_wait_run'));
    assert.equal(
      tools.tools.some((t) => /approve|decide/.test(t.name)),
      false,
    );
    const uploaded = payload<{ id: string }>(
      await client.callTool({
        name: 'oaa_upload_text',
        arguments: {
          filename: 'source.txt',
          text: 'Source A: a verified local fixture fact.',
          allowed_nodes: ['local'],
        },
      }),
    );
    const args = {
      agent: 'agent/research',
      input: 'Generate a cited source report.',
      file_ids: [uploaded.id],
      idempotency_key: 'stdio-workflow-request',
    };
    const result = payload<{ id: string }>(
      await client.callTool({ name: 'oaa_invoke', arguments: args }),
    );
    const waited = payload<{ id: string; status: string; artifact_count: number }>(
      await client.callTool({ name: 'oaa_wait_run', arguments: { response_id: result.id } }),
    );
    assert.equal(waited.status, 'completed');
    assert.equal(waited.artifact_count, 1);
    const calls = s.driver.calls;
    assert.equal(
      payload<{ id: string }>(await client.callTool({ name: 'oaa_invoke', arguments: args })).id,
      result.id,
    );
    assert.equal(s.driver.calls, calls);
    const conflict = await client.callTool({
      name: 'oaa_invoke',
      arguments: { ...args, input: 'different task' },
    });
    assert.equal(conflict.isError, true);
    assert.equal(payload<{ error: { code: string } }>(conflict).error.code, 'idempotency_conflict');
    const artifacts = await client.callTool({
      name: 'oaa_list_artifacts',
      arguments: { response_id: result.id },
    });
    const resource = CallToolResultSchema.parse(artifacts).content.find(
      (c) => c.type === 'resource_link',
    );
    assert.ok(resource && resource.type === 'resource_link');
    assert.match(resource.uri, /^oaa:\/\/files\/artifact_/);
    const file = await client.readResource({ uri: resource.uri });
    const content = file.contents[0]!;
    assert.ok('blob' in content);
    assert.match(
      Buffer.from(content.blob as string, 'base64').toString('utf8'),
      /verified local fixture fact/,
    );
    assert.deepEqual(s.store.file(uploaded.id, 'owner').allowedNodes, ['local']);
  } finally {
    await client.close();
    await s.cleanup();
  }
});

test('MCP compact reads never discard response IDs or require loading whole checkpoints and step results', async () => {
  const text = 'Long output \u4e2d\u6587\ud83d\ude00\n'.repeat(4000);
  const model = new FixtureModel();
  model.call = async (_a, _m, _signal, emit) => {
    emit(text);
    return { text, calls: [], finish: 'stop', usage: null };
  };
  const s = await setup(model);
  let mcp: Awaited<ReturnType<typeof bridge>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'private-context-marker' }),
    );
    await s.kernel.wait(run.id);
    s.store.step({
      id: 'large-step',
      runId: run.id,
      callId: 'large',
      name: 'fixture',
      effect: 'read',
      status: 'completed',
      arguments: { secret: 'private-step-marker' },
      result: { value: 'x'.repeat(100000) },
    });
    const url = await s.listen();
    mcp = await bridge(url);
    const originalRun = s.store.run.bind(s.store),
      originalSteps = s.store.steps.bind(s.store);
    s.store.run = () => {
      throw new Error('Compact routes must not deserialize a full checkpoint.');
    };
    s.store.steps = () => {
      throw new Error('Compact routes must not deserialize step results.');
    };
    try {
      const info = await mcp.client.callTool({
        name: 'oaa_get_run',
        arguments: { response_id: run.id },
      });
      assert.equal(info.isError, undefined);
      assert.equal(payload<{ id: string }>(info).id, run.id);
      assert.ok(Buffer.byteLength(JSON.stringify(info)) < 14000);
      assert.ok(!JSON.stringify(info).includes('private-context-marker'));
      assert.ok(!JSON.stringify(info).includes('private-step-marker'));
      let cursor: string | undefined,
        received = '';
      for (let i = 0; i < 100; i++) {
        const page = payload<{ text: string; done: boolean; next_cursor: string }>(
          await mcp.client.callTool({
            name: 'oaa_read_output',
            arguments: { response_id: run.id, cursor, max_bytes: 8000 },
          }),
        );
        received += page.text;
        if (page.done) break;
        assert.ok(page.next_cursor !== cursor);
        cursor = page.next_cursor;
      }
      assert.equal(received, text);
    } finally {
      s.store.run = originalRun;
      s.store.steps = originalSteps;
    }
  } finally {
    await mcp?.close();
    await s.cleanup();
  }
});

test('a timed-out or cancelled MCP wait frees its listener without cancelling the background task', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(10000, signal);
      return { text: 'late' };
    }),
  );
  let mcp: Awaited<ReturnType<typeof bridge>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();
    mcp = await bridge(url);
    const run = payload<{ id: string }>(
      await mcp.client.callTool({
        name: 'oaa_invoke',
        arguments: { agent: 'agent/test', input: 'wait fixture' },
      }),
    );
    const timed = payload<{ timed_out: boolean; status: string }>(
      await mcp.client.callTool({
        name: 'oaa_wait_run',
        arguments: { response_id: run.id, timeout_ms: 35 },
      }),
    );
    assert.equal(timed.timed_out, true);
    assert.equal(timed.status, 'in_progress');
    assert.equal(s.store.events.listenerCount(run.id), 0);
    const controller = new AbortController();
    const waiting = mcp.client.callTool(
      { name: 'oaa_wait_run', arguments: { response_id: run.id, timeout_ms: 20000 } },
      undefined,
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(waiting);
    await waitFor(() => s.store.events.listenerCount(run.id) === 1);
    controller.abort();
    await cancelled;
    await waitFor(() => s.store.events.listenerCount(run.id) === 0);
    assert.equal(s.store.run(run.id).status, 'in_progress');
    const result = payload<{ status: string }>(
      await mcp.client.callTool({ name: 'oaa_cancel', arguments: { response_id: run.id } }),
    );
    assert.equal(result.status, 'cancelled');
  } finally {
    await mcp?.close();
    await s.cleanup();
  }
});

test('file resources enforce owner, agent and files scopes; oversized resources fail rather than truncate', async () => {
  const s = await setup();
  let other: Awaited<ReturnType<typeof bridge>> | undefined,
    noFiles: Awaited<ReturnType<typeof bridge>> | undefined,
    owner: Awaited<ReturnType<typeof bridge>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'file scope fixture' }),
    );
    await s.kernel.wait(run.id);
    const file = await s.store.addFile(
      'owner',
      'private.bin',
      Buffer.alloc(5 * 1024 * 1024, 65),
      undefined,
      run.id,
    );
    const url = await s.listen();
    const uri = `oaa://files/${file.id}`;
    other = await bridge(url, secondToken);
    await assert.rejects(() => other!.client.readResource({ uri }), /not found/);
    // Observer keys (data_scope 'owner') reach the file; scope and agent grants still apply.
    const scoped = s.auth.create(
      principal,
      'read-only-fixture',
      ['agent/test'],
      ['read'],
      undefined,
      'owner',
    );
    noFiles = await bridge(url, String(scoped.token));
    await assert.rejects(() => noFiles!.client.readResource({ uri }), /scope|grant/i);
    owner = await bridge(url);
    await assert.rejects(() => owner!.client.readResource({ uri }), /4 MiB/);
    assert.equal((await new GatewayClient(url, token).download(file.id)).length, file.bytes);
    const wrongAgent = s.auth.create(
      principal,
      'other-agent-fixture',
      ['agent/not-this-one'],
      ['read', 'files'],
      undefined,
      'owner',
    );
    const rejected = await s.request(
      'GET',
      `/v1/files/${file.id}/content`,
      undefined,
      String(wrongAgent.token),
    );
    assert.equal(rejected.statusCode, 403);
    assert.equal(
      (await s.request('GET', `/v1/runs/${run.id}/output`, undefined, secondToken)).statusCode,
      404,
    );
  } finally {
    await other?.close();
    await noFiles?.close();
    await owner?.close();
    await s.cleanup();
  }
});

test('CLI upload, invoke, wait, output and download complete a report workflow without overwriting files', async () => {
  const s = await setup(researchFixture());
  try {
    s.store.publish('owner', researchBundle());
    const url = await s.listen();
    const keyFile = path.join(s.dir, 'cli.token');
    await writeFile(keyFile, token, { mode: 0o600 });
    const call = async (...args: string[]) =>
      JSON.parse(
        (await exec(process.execPath, [cli, ...args, '--url', url, '--token-file', keyFile]))
          .stdout,
      );
    const source = path.join(s.dir, 'selected.txt');
    await writeFile(source, 'CLI selected source.');
    const uploaded = await call('upload', source, '--allowed-node', 'local');
    const run = await call(
      'invoke',
      'agent/research',
      '--input',
      'Create a report.',
      '--file-id',
      uploaded.id,
      '--idempotency-key',
      'cli-report',
    );
    assert.equal((await call('wait', run.id)).status, 'completed');
    assert.match((await call('output', run.id)).text, /Report generated/);
    const files = await call('artifacts', run.id);
    const out = path.join(s.dir, 'report.md');
    await call('download', files.data[0].id, '--out', out);
    assert.match(await readFile(out, 'utf8'), /CLI selected source/);
    await assert.rejects(() => call('download', files.data[0].id, '--out', out));
    assert.match(await readFile(out, 'utf8'), /CLI selected source/);
    assert.equal((await call('get', run.id)).id, run.id);
  } finally {
    await s.cleanup();
  }
});

test('gateway client rejects cross-origin paths and bounds response bodies before parsing', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, {
      'Content-Length': 30 * 1024 * 1024,
      'Content-Type': 'application/json',
    });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new GatewayClient(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token,
    );
    await assert.rejects(
      () => client.request('GET', 'https://example.com/leak'),
      /configured gateway origin/,
    );
    assert.equal(requests, 0);
    await assert.rejects(
      () => client.request('GET', '/too-large'),
      (error) => error instanceof Fault && error.code === 'gateway_response_too_large',
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
