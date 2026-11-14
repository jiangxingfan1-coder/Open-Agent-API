// 大运行的事件流续传：单帧超过每条连接的缓冲上限、补发的历史超过
// 上限时，客户端断线重连若干次之后一定能收到终态帧；补发按背压分批写。全部进程内，不监听端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, RunEvent } from '../src/core/contracts.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { makeBundle } from '../src/lang/bundle.js';
import { setup, agent, FixtureModel, principal, token } from './helpers.js';

type Injected = {
  stream(): NodeJS.ReadableStream & { destroy(): void };
  statusCode: number;
  headers: Record<string, unknown>;
};
type Frame = { id?: string; event?: string; data: string };

function frames(text: string): { frames: Frame[]; rest: string } {
  const blocks = text.split('\n\n');
  const rest = blocks.pop() ?? '';
  return {
    rest,
    frames: blocks
      .filter((b) => b.trim() && !b.startsWith(':'))
      .map((block) => {
        const frame: Frame = { data: '' };
        for (const line of block.split('\n')) {
          const at = line.indexOf(': ');
          const key = line.slice(0, at);
          const value = line.slice(at + 2);
          if (key === 'id') frame.id = value;
          else if (key === 'event') frame.event = value;
          else if (key === 'data') frame.data += value;
        }
        return frame;
      }),
  };
}

/** 读到 `stopAfterBytes` 字节（或流结束）为止；提前停时销毁响应流，模拟客户端断线。 */
async function read(
  s: Awaited<ReturnType<typeof setup>>,
  url: string,
  headers: Record<string, string>,
  stopAfterBytes = Infinity,
): Promise<{ text: string; ended: boolean; status: number }> {
  const controller = new AbortController();
  const response = (await s.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payloadAsStream: true,
    signal: controller.signal,
  })) as unknown as Injected;
  const stream = response.stream();
  const chunks: Buffer[] = [];
  let bytes = 0;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ended: boolean) => {
      if (done) return;
      done = true;
      resolve({ text: Buffer.concat(chunks).toString('utf8'), ended, status: response.statusCode });
    };
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= stopAfterBytes && !done) {
        finish(false);
        controller.abort();
        stream.destroy();
      }
    });
    stream.on('end', () => finish(true));
    stream.on('error', () => finish(false));
    stream.on('close', () => finish(false));
  });
}

async function bigRun(chars: number) {
  const text = '中'.repeat(chars);
  const s = await setup(new FixtureModel(() => ({ text })));
  s.store.publish('owner', makeBundle(agent()));
  const run = s.kernel.submit(
    principal,
    invocationSchema.parse({ agent: 'agent/test', input: 'x', background: true }),
  );
  const finished: Run = await s.kernel.wait(run.id);
  assert.equal(finished.status, 'completed');
  return { s, run: finished, text };
}

test('a 700k-character run reaches its terminal frame across repeated disconnects (native SSE)', async () => {
  const { s, run, text } = await bigRun(700_000);
  try {
    const all: RunEvent[] = s.store.history(run.id, 0, 1e6);
    const terminal = all.at(-1)!;
    assert.equal(terminal.type, 'response.completed');
    assert.ok(
      Buffer.byteLength(JSON.stringify(terminal)) > 2 * 1024 * 1024,
      'the terminal frame alone exceeds the per-connection buffer',
    );
    let after = 0;
    const seen: number[] = [];
    let deltas = '';
    let terminalFrame: Frame | undefined;
    let attempts = 0;
    // 前几次连接只读一部分就断开，之后读到流结束。
    for (const stop of [400_000, 3_000_000, 1_500_000, Infinity, Infinity]) {
      attempts++;
      const r = await read(
        s,
        `/v1/runs/${run.id}/events`,
        after ? { 'last-event-id': String(after) } : {},
        stop,
      );
      assert.equal(r.status, 200);
      for (const f of frames(r.text).frames) {
        const id = Number(f.id);
        assert.ok(id > after, 'ids strictly increase across reconnects');
        seen.push(id);
        after = id;
        const e = JSON.parse(f.data) as RunEvent;
        if (e.type === 'response.output_text.delta') deltas += String(e.data.delta);
        if (f.event === 'response.completed') terminalFrame = f;
      }
      if (terminalFrame) break;
    }
    assert.ok(terminalFrame, 'the terminal frame arrives');
    assert.ok(attempts >= 4, 'the first connections were cut short');
    assert.equal(new Set(seen).size, seen.length, 'no duplicates');
    assert.deepEqual(
      seen,
      all.map((e) => e.id),
      'no gaps',
    );
    assert.equal(deltas, text);
    const response = (JSON.parse(terminalFrame.data) as RunEvent).data.response as {
      output: { content: { text: string }[] }[];
    };
    assert.equal(response.output[0]!.content[0]!.text, text, 'the terminal frame keeps the output');
    // 一次连接从 0 读到底也能完整收到（补发按背压分批写，不因超过缓冲上限而中止）。
    const whole = await read(s, `/v1/runs/${run.id}/events`, {});
    assert.ok(whole.ended);
    const parsed = frames(whole.text).frames;
    assert.equal(parsed.length, all.length);
    assert.equal(parsed.at(-1)!.event, 'response.completed');
  } finally {
    await s.cleanup();
  }
});

test('a large run streams completely through the Responses replay and plain (non-stream) reads', async () => {
  const { s, run, text } = await bigRun(700_000);
  try {
    const replay = await read(s, `/v1/responses/${run.id}?stream=true`, {});
    assert.ok(replay.ended);
    const last = frames(replay.text).frames.at(-1)!;
    assert.equal(last.event, 'response.completed');
    const body = JSON.parse(last.data) as {
      type: string;
      response: { status: string; output: { type: string; content: { text: string }[] }[] };
    };
    assert.equal(body.response.status, 'completed');
    const message = body.response.output.find((item) => item.type === 'message')!;
    assert.equal(message.content[0]!.text, text);
    const plain = await s.request('GET', `/v1/runs/${run.id}/events`);
    assert.equal(plain.statusCode, 200);
    assert.match(plain.body.slice(-2_500_000), /event: response\.completed/);
  } finally {
    await s.cleanup();
  }
});

test('compatibility streams of a large run end with their protocol terminators', async () => {
  const text = '中'.repeat(700_000);
  const s = await setup(new FixtureModel(() => ({ text })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    const chat = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(chat.statusCode, 200);
    assert.ok(chat.body.endsWith('data: [DONE]\n\n'));
    const claude = await s.request('POST', '/v1/messages', {
      model: 'agent/test',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(claude.statusCode, 200);
    assert.match(claude.body.slice(-400), /event: message_stop/);
    let joined = '';
    for (const f of frames(claude.body).frames)
      if (f.event === 'content_block_delta')
        joined += (JSON.parse(f.data) as { delta: { text: string } }).delta.text;
    assert.equal(joined, text);
  } finally {
    await s.cleanup();
  }
});
