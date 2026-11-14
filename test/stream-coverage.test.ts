// 补充的动态测试：/wait 的超时与提前返回、目录与概览事件流的断线
// 重连与订阅上限、桥接续接时并发回传同一个工具结果。全部进程内（app.inject），不监听端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from '../src/core/contracts.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { setup, agent, FixtureModel, principal, token, waitFor } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof setup>>;
type Injected = {
  stream(): NodeJS.ReadableStream & { destroy(): void };
  statusCode: number;
  headers: Record<string, unknown>;
  body?: string;
};

/** 打开一条 SSE（进程内）；`close` 销毁响应流模拟断线。 */
async function open(s: Fixture, url: string, headers: Record<string, string> = {}, bearer = token) {
  const controller = new AbortController();
  const response = (await s.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${bearer}`, ...headers },
    payloadAsStream: true,
    signal: controller.signal,
  })) as unknown as Injected;
  let text = '';
  const stream = response.stream();
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  stream.on('error', () => {});
  return {
    status: response.statusCode,
    headers: response.headers,
    text: () => text,
    until: (pattern: RegExp, timeout = 3_000) => waitFor(() => pattern.test(text), timeout),
    close: () => {
      controller.abort();
      stream.destroy();
    },
  };
}
const ids = (text: string, event: string) =>
  [...text.matchAll(new RegExp(`id: ([^\\n]+)\\nevent: ${event.replace('.', '\\.')}\\n`, 'g'))].map(
    (m) => m[1]!,
  );

async function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const s = await setup(
    new FixtureModel(async () => {
      await gate;
      return { text: 'done' };
    }),
  );
  s.store.publish('owner', makeBundle(agent()));
  const run = s.kernel.submit(
    principal,
    invocationSchema.parse({ agent: 'agent/test', input: 'x', background: true }),
  );
  return { s, runId: run.id, release };
}

test('/wait times out with timed_out, returns early on completion, and answers terminal runs at once', async () => {
  const { s, runId, release } = await gated();
  try {
    let t = Date.now();
    const timedOut = await s.request('GET', `/v1/runs/${runId}/wait?timeout_ms=150`);
    const waited = Date.now() - t;
    assert.equal(timedOut.statusCode, 200);
    assert.equal(timedOut.json().timed_out, true);
    assert.equal(timedOut.json().status, 'in_progress');
    assert.ok(waited >= 140 && waited < 2_000, `waited ${waited} ms`);
    t = Date.now();
    const early = s.request('GET', `/v1/runs/${runId}/wait?timeout_ms=10000`);
    setTimeout(release, 50);
    const done = await early;
    assert.equal(done.json().timed_out, false);
    assert.equal(done.json().status, 'completed');
    assert.ok(Date.now() - t < 5_000, 'returned when the run finished, not at the deadline');
    t = Date.now();
    const terminal = await s.request('GET', `/v1/runs/${runId}/wait?timeout_ms=25000`);
    assert.equal(terminal.json().status, 'completed');
    assert.equal(terminal.json().timed_out, false);
    assert.ok(Date.now() - t < 1_000, 'a terminal run is answered immediately');
    const zero = await s.request('GET', `/v1/runs/${runId}/wait?timeout_ms=0`);
    assert.equal(zero.json().timed_out, false);
    assert.equal(
      (await s.request('GET', `/v1/runs/${runId}/wait?timeout_ms=25001`)).statusCode,
      400,
    );
    // 别的 owner 看不到这个运行。
    const foreign = await s.request(
      'GET',
      `/v1/runs/${runId}/wait?timeout_ms=0`,
      undefined,
      'test-second-owner-key-not-a-provider-key-000001',
    );
    assert.equal(foreign.statusCode, 404);
  } finally {
    release();
    await s.cleanup();
  }
});

test('concurrent /wait calls all return when the run finishes', async () => {
  const { s, runId, release } = await gated();
  try {
    const waits = Array.from({ length: 5 }, () =>
      s.request('GET', `/v1/runs/${runId}/wait?timeout_ms=10000`),
    );
    setTimeout(release, 30);
    for (const r of await Promise.all(waits)) {
      assert.equal(r.json().status, 'completed');
      assert.equal(r.json().timed_out, false);
    }
  } finally {
    release();
    await s.cleanup();
  }
});

test('catalog events resume from Last-Event-ID without a reset or duplicates', async () => {
  const s = await setup();
  try {
    const first = await open(s, '/v1/catalog/events');
    assert.equal(first.status, 200);
    await first.until(/event: catalog\.reset/);
    s.store.publish('owner', makeBundle(agent({ id: 'agent/one' })));
    await first.until(/event: catalog\.changed/, 5_000);
    const seen = ids(first.text(), 'catalog.changed');
    const last = seen.at(-1)!;
    first.close();
    // 断线期间发生的变化：重连后补发，且只补发游标之后的。
    s.store.publish('owner', makeBundle(agent({ id: 'agent/two' })));
    const again = await open(s, '/v1/catalog/events', { 'last-event-id': last });
    assert.equal(again.status, 200);
    await again.until(/agent\/two/, 5_000);
    assert.doesNotMatch(again.text(), /event: catalog\.reset/);
    const resumed = ids(again.text(), 'catalog.changed');
    assert.ok(
      resumed.every((id) => !seen.includes(id)),
      'no change is delivered twice',
    );
    again.close();
    const conflicting = await s.request(
      'GET',
      `/v1/catalog/events?cursor=${encodeURIComponent(last)}`,
      undefined,
      token,
      {
        'last-event-id': `${last}x`,
      },
    );
    assert.equal(conflicting.statusCode, 400);
    assert.equal(conflicting.json().error.code, 'invalid_catalog_cursor');
  } finally {
    await s.cleanup();
  }
});

test('catalog event subscriptions are capped per owner and released on disconnect', async () => {
  const s = await setup();
  try {
    const held = [];
    for (let i = 0; i < 64; i++) {
      const stream = await open(s, '/v1/catalog/events');
      assert.equal(stream.status, 200, `stream ${i}`);
      held.push(stream);
    }
    const refused = await s.request('GET', '/v1/catalog/events');
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().error.code, 'catalog_capacity');
    assert.equal(refused.headers['retry-after'], '10');
    for (const stream of held) stream.close();
    await waitFor(async () => {
      const probe = await open(s, '/v1/catalog/events');
      probe.close();
      return probe.status === 200;
    }, 3_000);
  } finally {
    await s.cleanup();
  }
});

test('overview events: a reconnect starts at the current revision; streams per key are capped', async () => {
  const s = await setup();
  try {
    const first = await open(s, '/v1/overview/events');
    await first.until(/event: ready/);
    const revision = (text: string) =>
      (JSON.parse(/event: ready\ndata: (\{[^\n]+\})/.exec(text)![1]!) as { revision: number })
        .revision;
    const before = revision(first.text());
    first.close();
    s.store.publish('owner', makeBundle(agent({ id: 'agent/changed' })));
    await waitFor(async () => {
      const current = (await s.request('GET', '/v1/overview')).json().revision as number;
      return current > before;
    }, 5_000);
    const held = [];
    for (let i = 0; i < 4; i++) {
      const stream = await open(s, '/v1/overview/events');
      await stream.until(/event: ready/);
      held.push(stream);
    }
    assert.ok(revision(held[0]!.text()) > before, 'the reconnect sees the newer revision');
    const refused = await s.request('GET', '/v1/overview/events');
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().error.code, 'too_many_streams');
    assert.equal(refused.headers['retry-after'], '10');
    held.pop()!.close();
    await waitFor(async () => {
      const probe = await open(s, '/v1/overview/events');
      probe.close();
      return probe.status === 200;
    }, 3_000);
    for (const stream of held) stream.close();
  } finally {
    await s.cleanup();
  }
});

test('bridge: the same tool result sent twice at once takes effect once; both get the same answer', async () => {
  let calls = 0;
  const model = new FixtureModel((_a, messages: ModelMessage[]) => {
    calls++;
    const results = messages.filter((m) => m.role === 'tool');
    if (!results.length)
      return {
        text: 'Editing.',
        calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }],
      };
    return { text: `Done: ${results.map((r) => r.content).join(',')}` };
  });
  const s = await setup(model);
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
    );
    const EDIT = {
      type: 'function',
      function: {
        name: 'edit-file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    };
    const USER = { role: 'user', content: 'Fix the bug.' };
    const chat = (messages: unknown[]) =>
      s.request(
        'POST',
        '/v1/compat/chat/completions',
        { model: 'agent/bridge', tools: [EDIT], messages },
        token,
        { 'x-oaa-client-tools': 'bridge' },
      );
    const first = await chat([USER]);
    const runId = String(first.headers['x-run-id']);
    const call = first.json().choices[0].message.tool_calls[0];
    const reply = (value: string) => [
      USER,
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: value },
    ];
    const [a, b] = await Promise.all([chat(reply('v1')), chat(reply('v2'))]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.headers['x-run-id'], runId);
    assert.equal(b.headers['x-run-id'], runId);
    const committed = s.store.getApproval(call.id, 'owner').response?.output;
    assert.ok(committed === 'v1' || committed === 'v2');
    assert.equal(a.json().choices[0].message.content, `Done: ${committed}`);
    assert.equal(b.json().choices[0].message.content, `Done: ${committed}`);
    assert.equal(calls, 2, 'the model continued once');
    assert.equal(s.store.allRuns().length, 1);
    const steps = s.store.steps(runId).filter((x) => x.name === 'edit-file');
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.status, 'completed');
  } finally {
    await s.cleanup();
  }
});
