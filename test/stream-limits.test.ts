// 运行事件流的数量上限：按调用方与 owner 计数，超限 429 too_many_streams
// 并带 Retry-After，断开后计数回落。全部进程内，不监听端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { invocationSchema } from '../src/gateway/protocol.js';
import { makeBundle } from '../src/lang/bundle.js';
import { streamSlots } from '../src/gateway/stream-slots.js';
import { setup, agent, FixtureModel, principal, token, waitFor } from './helpers.js';

type Injected = { stream(): NodeJS.ReadableStream & { destroy(): void }; statusCode: number };

async function gated() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
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
  return { s, run, open };
}

async function hold(s: Awaited<ReturnType<typeof setup>>, url: string, bearer = token) {
  const controller = new AbortController();
  const response = (await s.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${bearer}` },
    payloadAsStream: true,
    signal: controller.signal,
  })) as unknown as Injected;
  const stream = response.stream();
  stream.on('data', () => {});
  stream.on('error', () => {});
  return {
    status: response.statusCode,
    close: () => {
      controller.abort();
      stream.destroy();
    },
  };
}

test('run event streams are limited per caller; /wait and compatibility streams share the limit', async () => {
  const { s, run, open } = await gated();
  try {
    const slots = streamSlots(s.store);
    slots.limits = { perSubject: 2, perOwner: 10 };
    const a = await hold(s, `/v1/runs/${run.id}/events`);
    const b = await hold(s, `/v1/responses/${run.id}?stream=true`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const p = s.auth.authenticate(`Bearer ${token}`);
    assert.deepEqual(slots.count(p), { subject: 2, owner: 2 });
    const third = await s.request('GET', `/v1/runs/${run.id}/events`);
    assert.equal(third.statusCode, 429);
    assert.equal(third.json().error.code, 'too_many_streams');
    assert.ok(Number(third.headers['retry-after']) > 0, 'Retry-After is set');
    const wait = await s.request('GET', `/v1/runs/${run.id}/wait?timeout_ms=0`);
    assert.equal(wait.statusCode, 429);
    const before = s.store.summaries('owner', ['*'], 200).length;
    const chat = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(chat.statusCode, 429);
    assert.equal(chat.json().error.code, 'too_many_streams');
    assert.equal(
      s.store.summaries('owner', ['*'], 200).length,
      before,
      'a refused streaming request creates no run',
    );
    a.close();
    b.close();
    await waitFor(() => slots.count(p).subject === 0, 2_000);
    assert.deepEqual(slots.count(p), { subject: 0, owner: 0 });
    // /wait 释放名额：超时返回之后计数回到 0。
    const waited = await s.request('GET', `/v1/runs/${run.id}/wait?timeout_ms=10`);
    assert.equal(waited.statusCode, 200);
    assert.equal(waited.json().timed_out, true);
    assert.equal(slots.count(p).subject, 0);
    open();
    await s.kernel.wait(run.id);
    // 已终态的运行：补发完关闭，名额随之释放。
    const replay = await s.request('GET', `/v1/runs/${run.id}/events`);
    assert.equal(replay.statusCode, 200);
    await waitFor(() => slots.count(p).subject === 0, 2_000);
  } finally {
    open();
    await s.cleanup();
  }
});

test('run event streams are limited per owner across its keys', async () => {
  const { s, run, open } = await gated();
  try {
    const slots = streamSlots(s.store);
    slots.limits = { perSubject: 10, perOwner: 2 };
    const key = (
      await s.request('POST', '/v1/keys', {
        name: 'reader',
        agents: ['*'],
        scopes: ['read'],
        dataScope: 'owner',
      })
    ).json() as { token: string };
    const a = await hold(s, `/v1/runs/${run.id}/events`);
    const b = await hold(s, `/v1/runs/${run.id}/events`, key.token);
    assert.equal(b.status, 200);
    const refused = await s.request('GET', `/v1/runs/${run.id}/events`, undefined, key.token);
    assert.equal(refused.statusCode, 429);
    assert.match(refused.json().error.message, /owner/);
    a.close();
    await waitFor(() => slots.count(principal as never).owner === 1, 2_000);
    const again = await hold(s, `/v1/runs/${run.id}/events`, key.token);
    assert.equal(again.status, 200);
    b.close();
    again.close();
    await waitFor(() => slots.count(principal as never).owner === 0, 2_000);
  } finally {
    open();
    await s.cleanup();
  }
});
