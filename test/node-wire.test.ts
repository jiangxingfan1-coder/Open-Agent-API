// 节点上行消息的结构校验：用进程内的替身 socket 直接驱动 RemoteExecutor，
// 注入畸形、超大、越权、重复、乱序的消息，断言网关的反应。不监听端口，不建真实连接。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { NodeAdvertisement, Work, WorkEvent } from '../src/core/contracts.js';
import { RemoteExecutor } from '../src/fabric/network.js';
import { LIMITS } from '../src/core/limits.js';
import { faultOf, sleep } from '../src/core/util.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code: number) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
    setImmediate(() => this.emit('close'));
  }
  terminate() {
    this.close(1006);
  }
  /** 节点发来一条消息（字符串原样，或对象序列化）。 */
  deliver(message: unknown) {
    this.emit(
      'message',
      Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)),
    );
  }
}

const advert: NodeAdvertisement = {
  nodeId: 'n1',
  providers: [],
  natives: [],
  capabilities: [],
  warm: [],
  concurrency: 2,
};
const modelWork = { kind: 'model', agent: { limits: { timeoutMs: 5_000 } } } as unknown as Work;
const toolWork = {
  kind: 'tool',
  binding: { capability: { timeoutMs: 5_000 } },
} as unknown as Work;
const nativeWork = { kind: 'native', agent: { limits: { timeoutMs: 5_000 } } } as unknown as Work;

function harness() {
  const socket = new FakeSocket();
  const executor = new RemoteExecutor(socket as unknown as WebSocket, advert, 60_000, () => {});
  const events: WorkEvent[] = [];
  const start = (work: Work = modelWork) => {
    const controller = new AbortController();
    const outcome = executor
      .execute(work, controller.signal, async (e) => {
        events.push(e);
        return e.type === 'approval' ? { approved: true } : undefined;
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, fault: faultOf(error) }),
      );
    const request = socket.sent.at(-1)!;
    return { outcome, id: String(request.id), leaseId: String(request.leaseId), controller };
  };
  return { socket, executor, events, start };
}
const modelResult = { text: 'hi', calls: [], usage: null, finish: 'stop' };

test('valid results from older nodes are accepted with optional fields missing', async () => {
  const { socket, executor, start } = harness();
  try {
    const model = start(modelWork);
    // 旧版节点：没有 finish、providerItems、providerState，也没有 usage。
    socket.deliver({
      type: 'result',
      id: model.id,
      leaseId: model.leaseId,
      result: { text: 'a', calls: [] },
    });
    const m = await model.outcome;
    assert.equal(m.ok, true);
    assert.deepEqual(m.ok && m.value, { text: 'a', calls: [], usage: null });
    const tool = start(toolWork);
    socket.deliver({ type: 'result', id: tool.id, leaseId: tool.leaseId, result: {} });
    assert.equal((await tool.outcome).ok, true, 'a tool returning undefined has no value field');
    const native = start(nativeWork);
    socket.deliver({
      type: 'result',
      id: native.id,
      leaseId: native.leaseId,
      result: {
        text: 'n',
        nativeState: {},
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        extra: 'newer field',
      },
    });
    const n = await native.outcome;
    assert.equal(n.ok, true);
    assert.equal(
      n.ok && (n.value as { extra?: string }).extra,
      'newer field',
      'newer fields pass through',
    );
    const failed = start();
    socket.deliver({
      type: 'result',
      id: failed.id,
      leaseId: failed.leaseId,
      error: { code: 'provider_rate_limited', message: 'slow down' },
    });
    const f = await failed.outcome;
    assert.equal(f.ok, false);
    assert.equal(!f.ok && f.fault.code, 'provider_rate_limited');
    assert.equal(!f.ok && f.fault.uncertain, false);
    socket.deliver({ type: 'heartbeat', extra: true });
    assert.equal(socket.sent.at(-1)!.type, 'heartbeat_ack');
    assert.equal(socket.closedWith, undefined, 'nothing above closes the connection');
  } finally {
    await executor.close();
  }
});

test('malformed results are refused, recorded and close the connection without throwing', async () => {
  for (const bad of [
    { text: 123, calls: [] },
    { text: 'x' },
    { text: 'x', calls: [{ id: 'c', name: 'n', arguments: 'not-an-object' }] },
    { text: 'x', calls: [], finish: 'exploded' },
    'a string result',
    null,
  ]) {
    const { socket, executor, start } = harness();
    const other = start();
    const work = start();
    socket.deliver({ type: 'result', id: work.id, leaseId: work.leaseId, result: bad });
    const outcome = await work.outcome;
    assert.equal(outcome.ok, false, JSON.stringify(bad));
    assert.equal(!outcome.ok && outcome.fault.code, 'invalid_protocol');
    assert.equal(
      !outcome.ok && outcome.fault.uncertain,
      true,
      'the node claimed it ran: outcome unknown',
    );
    assert.equal(socket.closedWith, 1008);
    assert.match(executor.protocolIssues.at(-1)!, /^closed: invalid model result/);
    const sibling = await other.outcome;
    assert.equal(
      !sibling.ok && sibling.fault.code,
      'node_disconnected',
      'other calls end, not hang',
    );
  }
});

test('malformed, oversized and mistyped frames close the connection; pending calls are released', async () => {
  const frames: unknown[] = [
    'not json',
    '[1,2]',
    '"text"',
    { type: 'event', id: 'x', leaseId: 'y', event: { type: 'explode', data: {} } },
    { type: 'event', id: 5, leaseId: 'y', event: { type: 'text', data: {} } },
    { type: 'result', id: 'x', leaseId: 'y', error: 'boom' },
    { type: 'advertisement', advertisement: { nodeId: 1 } },
    `{"type":"heartbeat","pad":"${'x'.repeat(LIMITS.nodeMessageBytes)}"}`,
  ];
  for (const frame of frames) {
    const { socket, executor, start } = harness();
    const work = start();
    socket.deliver(frame);
    const outcome = await work.outcome;
    assert.equal(socket.closedWith, 1008, String(frame).slice(0, 80));
    assert.equal(!outcome.ok && outcome.fault.code, 'node_disconnected');
    assert.match(executor.protocolIssues.at(-1)!, /^closed: /);
  }
});

test('foreign, late, duplicate and out-of-order messages are ignored; a result commits once', async () => {
  const { socket, executor, events, start } = harness();
  try {
    const work = start();
    // 不属于本节点（未知请求）、租约不符：忽略。
    socket.deliver({
      type: 'result',
      id: 'rpc_someone_else',
      leaseId: work.leaseId,
      result: modelResult,
    });
    socket.deliver({ type: 'result', id: work.id, leaseId: 'lease_wrong', result: modelResult });
    socket.deliver({
      type: 'event',
      id: work.id,
      leaseId: 'lease_wrong',
      event: { type: 'text', data: { t: 1 } },
    });
    // 不认识的消息类型：记录后忽略（向前兼容）。
    socket.deliver({ type: 'telemetry', id: work.id });
    await sleep(5);
    assert.equal(events.length, 0);
    assert.equal(socket.closedWith, undefined);
    socket.deliver({
      type: 'event',
      id: work.id,
      leaseId: work.leaseId,
      event: { type: 'progress', data: { n: 1 } },
    });
    socket.deliver({ type: 'result', id: work.id, leaseId: work.leaseId, result: modelResult });
    // 重复的结果与结果之后才到的事件：忽略，不抛异常、不断开。
    socket.deliver({
      type: 'result',
      id: work.id,
      leaseId: work.leaseId,
      result: { text: 'second', calls: [] },
    });
    socket.deliver({
      type: 'event',
      id: work.id,
      leaseId: work.leaseId,
      event: { type: 'text', data: { late: true } },
    });
    const outcome = await work.outcome;
    assert.equal(outcome.ok, true);
    assert.equal(
      outcome.ok && (outcome.value as { text: string }).text,
      'hi',
      'the first result commits',
    );
    await sleep(5);
    assert.deepEqual(
      events.map((e) => e.type),
      ['progress'],
    );
    assert.equal(socket.closedWith, undefined);
    assert.ok(executor.protocolIssues.some((i) => i.startsWith('ignored message type telemetry')));
    assert.ok(executor.protocolIssues.filter((i) => i.startsWith('ignored result')).length >= 3);
  } finally {
    await executor.close();
  }
});

test('approval events are answered once on the matching lease; unsafe error codes are normalized', async () => {
  const { socket, executor, start } = harness();
  try {
    const work = start();
    socket.deliver({
      type: 'event',
      id: work.id,
      leaseId: work.leaseId,
      actionId: 'act_1',
      event: { type: 'approval', data: { tool: 'x' } },
    });
    await sleep(5);
    const action = socket.sent.find((m) => m.type === 'action')!;
    assert.deepEqual(
      { id: action.id, leaseId: action.leaseId, actionId: action.actionId, answer: action.answer },
      { id: work.id, leaseId: work.leaseId, actionId: 'act_1', answer: { approved: true } },
    );
    socket.deliver({
      type: 'result',
      id: work.id,
      leaseId: work.leaseId,
      error: { code: 'Not A Code; DROP TABLE', message: 'm'.repeat(10_000), uncertain: 'yes' },
    });
    const outcome = await work.outcome;
    assert.equal(!outcome.ok && outcome.fault.code, 'worker_failed');
    assert.equal(!outcome.ok && outcome.fault.message.length, 4000);
    assert.equal(!outcome.ok && outcome.fault.uncertain, false);
  } finally {
    await executor.close();
  }
});

test('a malformed usage report becomes unknown usage instead of failing the call', async () => {
  const { socket, executor, start } = harness();
  try {
    const work = start(nativeWork);
    socket.deliver({
      type: 'result',
      id: work.id,
      leaseId: work.leaseId,
      result: { text: 't', nativeState: {}, usage: { input_tokens: null, output_tokens: -1 } },
    });
    const outcome = await work.outcome;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && (outcome.value as { usage: unknown }).usage, null);
  } finally {
    await executor.close();
  }
});
