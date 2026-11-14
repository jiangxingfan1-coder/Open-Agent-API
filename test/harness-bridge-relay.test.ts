import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AcpTimings } from '../src/engines/acp.js';
import { openCallerRelay } from '../src/engines/caller-relay.js';
import type { WorkEvent } from '../src/core/contracts.js';
import { setup, token, waitFor } from './helpers.js';

// 调用方工具中继的稳健性（docs/harness.md「限制」）：等待期间的进度通知，智能体放弃调用后的收尾。
// 起子进程（中继、假智能体），只用 Unix 域套接字，不监听 TCP 端口。

const fixture = path.resolve('test/fixtures/acp-caller-agent.mjs');
const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };
const BRIDGE = { 'x-oaa-client-tools': 'bridge' };
const EDIT = {
  type: 'function',
  function: {
    name: 'edit-file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};

test('mcp-relay: a waiting tools/call with a progressToken receives progress notifications', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-relay-progress-'));
  let answer = Promise.withResolvers<Record<string, unknown>>();
  const events: WorkEvent[] = [];
  const relay = await openCallerRelay(
    dir,
    [{ name: 'lint', parameters: { type: 'object' } }],
    async (event) => {
      events.push(event);
      return await answer.promise;
    },
  );
  const client = new Client({ name: 'progress-test', version: '1.0.0' });
  try {
    const [cli, ...rest] = relay.server.args as [string, ...string[]];
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, ...rest, '--progress-interval-ms', '40'],
        stderr: 'pipe',
      }),
    );
    const progress: { progress: number; message?: string }[] = [];
    const call = client.callTool({ name: 'lint', arguments: {} }, undefined, {
      onprogress: (p) => progress.push(p),
      timeout: 10_000,
    });
    await waitFor(() => progress.length >= 3, 5_000);
    assert.deepEqual(
      progress.slice(0, 3).map((p) => p.progress),
      [1, 2, 3],
    );
    assert.ok(progress.every((p) => typeof p.message === 'string' && p.message.length > 0));
    answer.resolve({ output: 'clean' });
    const result = await call;
    assert.deepEqual(result.content, [{ type: 'text', text: 'clean' }]);
    const after = progress.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(progress.length, after, 'no progress after the call ended');

    // 没有 progressToken（不传 onprogress）时不发进度通知。
    const notifications: unknown[] = [];
    client.fallbackNotificationHandler = async (n) => void notifications.push(n);
    answer = Promise.withResolvers<Record<string, unknown>>();
    const quiet = client.callTool({ name: 'lint', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 150));
    answer.resolve({ output: 'x' });
    assert.deepEqual((await quiet).content, [{ type: 'text', text: 'x' }]);
    assert.equal(events.length, 2);
    assert.equal(notifications.length, 0);
  } finally {
    await client.close().catch(() => {});
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('acp bridge: an agent that abandons a waiting call ends that call, not the run', async () => {
  const s = await setup(undefined, { approvalTimeoutMs: 15_000 });
  try {
    const entry = () => ({
      transport: 'acp' as const,
      command: process.execPath,
      args: [fixture],
      enabled: true,
    });
    s.config.localWorker!.adapters.caller = entry();
    s.runtime.config.adapters.caller = entry();
    s.runtime.acpTimings = fast;
    const published = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/caller',
      engine: 'adapter/caller',
      models: ['default'],
    });
    assert.equal(published.statusCode, 200, published.body);
    const prompt = `Do it.\nSCRIPT:${JSON.stringify({
      groups: [[{ name: 'edit-file', arguments: { path: 'a.ts' } }]],
      abandonAfterMs: 400,
      holdMs: 1_500,
    })}`;
    const chat = (messages: unknown[]) =>
      s.request(
        'POST',
        '/v1/compat/chat/completions',
        { model: 'agent/caller', tools: [EDIT], messages },
        token,
        BRIDGE,
      );
    const first = await chat([{ role: 'user', content: prompt }]);
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const [call] = first.json().choices[0].message.tool_calls;
    assert.equal(s.store.run(runId).status, 'requires_action');

    await waitFor(
      () => s.store.steps(runId).find((x) => x.name === 'edit-file')?.status === 'failed',
      5_000,
    );
    const step = s.store.steps(runId).find((x) => x.name === 'edit-file')!;
    assert.equal(step.error, 'client_tool_abandoned');
    const failed = s.store.history(runId).find((e) => e.type === 'tool.failed')!;
    assert.deepEqual(failed.data, {
      step_id: step.id,
      code: 'client_tool_abandoned',
      uncertain: false,
    });
    assert.equal(s.store.approvals(runId)[0]!.status, 'expired');
    assert.equal(s.store.run(runId).status, 'in_progress', 'the agent keeps working');

    // 回传过期的 call_id 不续接这个运行：按新请求处理。
    const late = await chat([
      { role: 'user', content: 'Do it.\nSCRIPT:{"groups":[]}' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: 'too late' },
    ]);
    assert.equal(late.statusCode, 200, late.body);
    assert.notEqual(late.headers['x-run-id'], runId, 'not continued');

    await s.kernel.wait(runId);
    const final = s.store.run(runId);
    assert.equal(final.status, 'completed', JSON.stringify(final.error));
    assert.match(final.output.map((m) => m.text).join(''), /Gave up on the caller tool/);
  } finally {
    await s.cleanup();
  }
});
