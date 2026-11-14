import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { workerSchema } from '../src/config/config.js';
import { capabilitySchema, type ToolBinding, type Work } from '../src/core/contracts.js';
import { WorkerRuntime, type LocalHandler } from '../src/fabric/worker.js';
import { connectWorker } from '../src/fabric/network.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { sleep } from '../src/core/util.js';
import { setup, agent, FixtureModel, principal, waitFor } from './helpers.js';

const nodeToken = 'drain-fixture-node-credential-not-a-model-key-00001';
const tool: ToolBinding = {
  name: 'write',
  capability: capabilitySchema.parse({
    id: 'fixture/write',
    version: '1',
    description: 'Controlled side effect fixture',
    effect: 'write',
    placement: 'host-bound',
    nodeId: 'remote',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    resourceKey: 'fixture-shared-resource',
  }),
  handler: { kind: 'node', reference: 'write' },
};

async function remoteSetup(handler: LocalHandler, leaseMs = 1200, timeoutMs = 60_000) {
  const binding = structuredClone(tool);
  binding.capability.timeoutMs = timeoutMs;
  process.env.OAA_DRAIN_FIXTURE_TOKEN = nodeToken;
  const driver = new FixtureModel((_a, messages) =>
    messages.some((m) => m.role === 'tool')
      ? { text: 'Fixture completed.' }
      : { calls: [{ id: 'write', name: 'write', arguments: { label: messages.at(-1)!.content } }] },
  );
  const s = await setup(driver, {
    leaseMs,
    nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_DRAIN_FIXTURE_TOKEN' }],
  });
  const stop = new AbortController();
  await writeFile(path.join(s.dir, 'node.token'), nodeToken, { mode: 0o600 });
  const config = workerSchema.parse({
    nodeId: 'remote',
    concurrency: 1,
    gatewayUrl: await s.listen(),
    tokenFile: path.join(s.dir, 'node.token'),
    dataDir: path.join(s.dir, 'remote'),
    tools: [
      {
        reference: 'write',
        capability: binding.capability,
        handler: { kind: 'read_directory', root: s.dir },
      },
    ],
  });
  const runtime = new WorkerRuntime(config, new Map([['write', handler]]));
  const running = connectWorker(config, stop.signal, runtime);
  await waitFor(() => s.hub.nodes.has('remote'));
  s.store.publish('owner', makeBundle(agent({ tools: [binding] })));
  return {
    ...s,
    stop,
    running,
    remote: runtime,
    submit: (input: string) =>
      s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/test', input, background: true }),
      ),
    cleanup: async () => {
      stop.abort();
      await running;
      await s.cleanup();
      delete process.env.OAA_DRAIN_FIXTURE_TOKEN;
    },
  };
}

test('remote cancellation retains the occupied slot until the tool has actually exited', async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  let firstSignal: AbortSignal | undefined;
  const s = await remoteSetup(async (args, _ctx, signal) => {
    active++;
    maximum = Math.max(maximum, active);
    started.push(String(args.label));
    try {
      if (args.label === 'first') {
        firstSignal = signal;
        await gate.promise;
      }
      return { value: { label: args.label } };
    } finally {
      active--;
    }
  });
  try {
    const first = s.submit('first');
    await waitFor(() => started.length === 1);
    let cancellationSettled = false;
    const cancellation = s.kernel.cancel(principal, first.id).then((r) => {
      cancellationSettled = true;
      return r;
    });
    await waitFor(() => firstSignal?.aborted === true);
    const second = s.submit('second');
    await waitFor(() => s.store.steps(second.id).some((step) => step.status === 'pending'));
    await sleep(40);
    assert.equal(cancellationSettled, false);
    assert.equal(s.hub.nodes.get('remote')!.active, 1);
    assert.deepEqual(started, ['first']);
    gate.resolve();
    const cancelled = await cancellation;
    assert.equal(cancelled.status, 'interrupted');
    assert.equal(cancelled.error?.code, 'effect_outcome_unknown');
    assert.equal(s.store.steps(first.id)[0]!.status, 'uncertain');
    assert.equal((await s.kernel.wait(second.id)).status, 'completed');
    assert.deepEqual(started, ['first', 'second']);
    assert.equal(maximum, 1);
    assert.ok(s.hub.nodes.has('remote'));
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('an unacknowledged cancellation disconnects the node, which cannot reconnect while old work drains', async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const s = await remoteSetup(async () => {
    calls++;
    if (calls === 1) await gate.promise;
    return { value: 'done' };
  }, 200);
  try {
    const first = s.submit('first');
    await waitFor(() => calls === 1);
    const cancellation = await s.kernel.cancel(principal, first.id);
    assert.equal(cancellation.error?.code, 'effect_outcome_unknown');
    await waitFor(() => !s.hub.nodes.has('remote'));
    await sleep(350);
    assert.equal(
      s.hub.nodes.has('remote'),
      false,
      'A disconnected worker must not reconnect over an unfinished old execution.',
    );
    assert.equal(calls, 1);
    assert.throws(() => s.kernel.resume(principal, first.id), /Resolve uncertain side effects/);
    gate.resolve();
    await waitFor(() => s.hub.nodes.has('remote'));
    const next = s.submit('after-drain');
    assert.equal((await s.kernel.wait(next.id)).status, 'completed');
    assert.equal(calls, 2);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('stopping a worker waits for owned work before closing reusable runtime clients', async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let closes = 0;
  let closedWhileActive = false;
  const s = await remoteSetup(async () => {
    active++;
    try {
      await gate.promise;
      return { value: 'done' };
    } finally {
      active--;
    }
  });
  const originalClose = s.remote.close.bind(s.remote);
  s.remote.close = async () => {
    closes++;
    closedWhileActive = active !== 0;
    await originalClose();
  };
  try {
    const run = s.submit('stop');
    await waitFor(() => active === 1);
    let stopped = false;
    void s.running.then(() => {
      stopped = true;
    });
    s.stop.abort();
    await waitFor(() => !s.hub.nodes.has('remote'));
    await sleep(40);
    assert.equal(stopped, false);
    assert.equal(closes, 0);
    gate.resolve();
    await s.running;
    assert.equal(closes, 1);
    assert.equal(closedWhileActive, false);
    assert.equal((await s.kernel.wait(run.id)).status, 'interrupted');
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('cancellation during remote bundle installation cannot start the queued side effect', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  let installSignal: AbortSignal | undefined;
  let installing = false;
  const s = await remoteSetup(async () => {
    writes++;
    return { value: 'done' };
  });
  const originalInstall = s.remote.install.bind(s.remote);
  s.remote.install = async (bundle, signal) => {
    installing = true;
    installSignal = signal;
    await gate.promise;
    await originalInstall(bundle, signal);
  };
  try {
    const run = s.submit('cancel-install');
    await waitFor(() => installing);
    const cancellation = s.kernel.cancel(principal, run.id);
    await waitFor(() => installSignal?.aborted === true);
    assert.equal(writes, 0);
    assert.equal(s.store.steps(run.id)[0]!.status, 'pending');
    gate.resolve();
    const result = await cancellation;
    assert.equal(result.status, 'cancelled');
    assert.equal(writes, 0);
    assert.equal(
      s.store.steps(run.id).some((step) => step.status === 'uncertain'),
      false,
    );
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('a worker rejects oversubscription from an older gateway and ignores stale lease controls', async () => {
  const s = await setup();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const messages: Record<string, any>[] = [];
  let peer: WebSocket | undefined;
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  const gate = Promise.withResolvers<void>();
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    server.on('connection', (ws) => {
      peer = ws;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.type === 'hello')
          ws.send(JSON.stringify({ type: 'welcome', protocol: 'oaa/1', leaseMs: 2000 }));
        if (message.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      });
    });
    await writeFile(path.join(s.dir, 'legacy.token'), nodeToken, { mode: 0o600 });
    const config = workerSchema.parse({
      nodeId: 'remote',
      dataDir: path.join(s.dir, 'remote'),
      concurrency: 1,
      gatewayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      tokenFile: path.join(s.dir, 'legacy.token'),
    });
    const runtime = new WorkerRuntime(config);
    runtime.execute = async (_work, signal, emit) => {
      calls++;
      if (calls === 1) {
        firstSignal = signal;
        await gate.promise;
        await emit({ type: 'text', data: { delta: 'late output must be discarded' } });
      }
      return { value: 'done' };
    };
    running = connectWorker(config, stop.signal, runtime);
    await waitFor(() => messages.some((m) => m.type === 'hello'));
    const dispatch = (id: string) =>
      peer!.send(
        JSON.stringify({
          protocol: 'oaa/1',
          type: 'execute',
          id,
          leaseId: `lease-${id}`,
          payload: {} as Work,
        }),
      );
    dispatch('first');
    await waitFor(() => calls === 1);
    peer!.send(JSON.stringify({ type: 'cancel', id: 'first', leaseId: 'wrong-lease' }));
    peer!.send(JSON.stringify({ type: 'renew', id: 'missing', leaseId: 'stale-lease' }));
    peer!.send(
      JSON.stringify({
        type: 'action',
        id: 'missing',
        leaseId: 'stale-lease',
        actionId: 'old',
        answer: { decision: 'approve' },
      }),
    );
    await sleep(20);
    assert.equal(firstSignal?.aborted, false);
    assert.equal(peer!.readyState, WebSocket.OPEN);
    peer!.send(JSON.stringify({ type: 'cancel', id: 'first', leaseId: 'lease-first' }));
    await waitFor(() => firstSignal?.aborted === true);
    dispatch('second');
    await waitFor(() => messages.some((m) => m.type === 'result' && m.id === 'second'));
    assert.equal(
      messages.find((m) => m.type === 'result' && m.id === 'second')!.error.code,
      'worker_capacity_exceeded',
    );
    assert.equal(calls, 1);
    gate.resolve();
    await waitFor(() => messages.some((m) => m.type === 'result' && m.id === 'first'));
    assert.equal(
      messages.find((m) => m.type === 'result' && m.id === 'first')!.error.code,
      'cancelled',
    );
    peer!.send(JSON.stringify({ type: 'cancel', id: 'first', leaseId: 'lease-first' }));
    dispatch('third');
    await waitFor(() => messages.some((m) => m.type === 'result' && m.id === 'third'));
    assert.equal(calls, 2);
    assert.equal(
      messages.some((m) => m.type === 'event'),
      false,
    );
    assert.equal(peer!.readyState, WebSocket.OPEN);
  } finally {
    gate.resolve();
    stop.abort();
    await running;
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.cleanup();
  }
});

test('a timed-out write retains its slot until acknowledgement and is not retried', async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const s = await remoteSetup(
    async (_args, _context, workSignal) => {
      calls++;
      signal = workSignal;
      await gate.promise;
      return { value: 'finished too late' };
    },
    1200,
    50,
  );
  try {
    const run = s.submit('timeout');
    await waitFor(() => signal?.aborted === true);
    assert.equal(s.hub.nodes.get('remote')!.active, 1);
    assert.equal(s.store.run(run.id).status, 'in_progress');
    gate.resolve();
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.error?.code, 'effect_outcome_unknown');
    assert.equal(s.store.steps(run.id)[0]!.status, 'uncertain');
    assert.equal(calls, 1);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('a wrong-lease result cannot acknowledge cancellation or release the remote slot', async () => {
  process.env.OAA_DRAIN_FIXTURE_TOKEN = nodeToken;
  const s = await setup(undefined, {
    leaseMs: 1500,
    nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_DRAIN_FIXTURE_TOKEN' }],
  });
  let peer: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let execute: { id: string; leaseId: string } | undefined;
  let cancelReceived = false;
  try {
    const url = await s.listen();
    peer = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${nodeToken}`, 'x-oaa-node-id': 'remote' },
    });
    peer.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'install')
        peer!.send(
          JSON.stringify({
            type: 'result',
            id: message.id,
            leaseId: message.leaseId,
            result: { installed: true },
          }),
        );
      if (message.type === 'execute') execute = message;
      if (message.type === 'cancel') cancelReceived = true;
    });
    await new Promise<void>((resolve, reject) => {
      peer!.once('error', reject);
      peer!.once('open', () => {
        peer!.send(
          JSON.stringify({
            type: 'hello',
            protocol: 'oaa/1',
            advertisement: {
              nodeId: 'remote',
              providers: [],
              natives: ['codex'],
              capabilities: [],
              concurrency: 1,
              warm: [],
            },
          }),
        );
        resolve();
      });
    });
    heartbeat = setInterval(() => {
      if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'heartbeat' }));
    }, 200);
    await waitFor(() => s.hub.nodes.has('remote'));
    s.store.publish(
      'owner',
      makeBundle(agent({ engine: 'codex', provider: 'native', model: 'default' })),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({
        agent: 'agent/test',
        input: 'Protocol fixture; no native program is launched.',
      }),
    );
    await waitFor(() => !!execute);
    let finished = false;
    const cancelling = s.kernel.cancel(principal, run.id).then((r) => {
      finished = true;
      return r;
    });
    await waitFor(() => cancelReceived);
    peer.send(
      JSON.stringify({
        type: 'result',
        id: execute!.id,
        leaseId: 'wrong',
        result: { text: 'must not commit', nativeState: {}, usage: null },
      }),
    );
    await sleep(35);
    assert.equal(finished, false);
    assert.equal(s.hub.nodes.get('remote')!.active, 1);
    assert.deepEqual(s.store.run(run.id).output, []);
    peer.send(
      JSON.stringify({
        type: 'result',
        id: execute!.id,
        leaseId: execute!.leaseId,
        error: { code: 'cancelled', message: 'Fixture execution stopped.' },
      }),
    );
    assert.equal((await cancelling).error?.code, 'effect_outcome_unknown');
    assert.deepEqual(s.store.run(run.id).output, []);
    assert.equal(s.driver.calls, 0);
  } finally {
    clearInterval(heartbeat);
    peer?.terminate();
    await s.cleanup();
    delete process.env.OAA_DRAIN_FIXTURE_TOKEN;
  }
});
