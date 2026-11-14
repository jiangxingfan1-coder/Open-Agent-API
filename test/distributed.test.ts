import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { workerSchema } from '../src/config/config.js';
import { capabilitySchema, type ToolBinding } from '../src/core/contracts.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { connectWorker } from '../src/fabric/network.js';
import { makeBundle } from '../src/lang/bundle.js';
import { FixtureModel, setup, agent, principal, waitFor } from './helpers.js';
import { sleep } from '../src/core/util.js';

const nodeToken = 'node-test-credential-not-a-model-key-123456789';
const remoteCapability = () =>
  capabilitySchema.parse({
    id: 'private/lookup',
    version: '1',
    description: 'Read an authorized source on its owning node.',
    placement: 'host-bound',
    nodeId: 'remote',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  });
const binding = (): ToolBinding => ({
  name: 'private_lookup',
  capability: remoteCapability(),
  handler: { kind: 'node', reference: 'lookup' },
});
test('an unresponsive worker loses its lease and cannot keep a task pending forever', async () => {
  process.env.OAA_NODE_TEST = nodeToken;
  const s = await setup(
    new FixtureModel(() => ({
      calls: [{ id: 'lookup', name: 'private_lookup', arguments: { path: 'x' } }],
    })),
    { leaseMs: 150, nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_NODE_TEST' }] },
  );
  let peer: WebSocket | undefined;
  try {
    const url = await s.listen();
    peer = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${nodeToken}`, 'x-oaa-node-id': 'remote' },
    });
    peer.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'install')
        peer!.send(
          JSON.stringify({
            type: 'result',
            id: m.id,
            leaseId: m.leaseId,
            result: { installed: true },
          }),
        );
    });
    await new Promise<void>((resolve, reject) => {
      peer!.once('open', () => {
        peer!.send(
          JSON.stringify({
            protocol: 'oaa/1',
            type: 'hello',
            advertisement: {
              nodeId: 'remote',
              providers: [],
              natives: [],
              capabilities: [remoteCapability()],
              warm: [],
              concurrency: 1,
            },
          }),
        );
        resolve();
      });
      peer!.once('error', reject);
    });
    await waitFor(() => s.hub.nodes.has('remote'));
    s.store.publish('owner', makeBundle(agent({ tools: [binding()] })));
    const response = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'read',
      background: true,
    });
    await waitFor(() => s.store.run(response.json().id).status === 'failed', 3000);
    assert.equal(s.hub.nodes.has('remote'), false);
    assert.equal(s.store.run(response.json().id).error?.code, 'capability_unavailable');
  } finally {
    peer?.terminate();
    await s.cleanup();
  }
});
test('read-result cache reuses same-session results but does not cross session boundaries', async () => {
  let executions = 0;
  const capability = capabilitySchema.parse({
    ...remoteCapability(),
    id: 'cache/read',
    nodeId: 'local',
    cacheTtlMs: 60000,
  });
  const s = await setup(
    new FixtureModel((_a, m) => {
      const turn = m.filter((x) => x.role === 'assistant').length;
      return turn < 2
        ? { calls: [{ id: `lookup-${turn}`, name: 'lookup', arguments: { path: 'x' } }] }
        : { text: 'done' };
    }),
  );
  try {
    s.runtime.config.tools.push({
      reference: 'cache',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('cache', async () => ({ value: { count: ++executions } }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [{ name: 'lookup', capability, handler: { kind: 'node', reference: 'cache' } }],
        }),
      ),
    );
    const a = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'one' });
    assert.equal(a.json().status, 'completed');
    assert.equal(executions, 1);
    assert.ok(s.store.history(a.json().id).some((e) => e.type === 'tool.cached'));
    const b = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'two' });
    assert.equal(b.json().status, 'completed');
    assert.equal(executions, 2);
  } finally {
    await s.cleanup();
  }
});
test('one invocation uses the local model and a remote host-bound tool over authenticated WebSocket', async () => {
  process.env.OAA_NODE_TEST = nodeToken;
  const model = new FixtureModel((_a, m) => {
    const result = m.find((x) => x.role === 'tool');
    return result
      ? { text: `Result: ${JSON.parse(result.content).text}` }
      : { calls: [{ id: 'lookup', name: 'private_lookup', arguments: { path: 'source.txt' } }] };
  });
  const s = await setup(model, {
    nodeKeys: [
      {
        nodeId: 'remote',
        owner: 'owner',
        tokenEnv: 'OAA_NODE_TEST',
        agents: ['agent/test'],
        capabilities: ['private/lookup'],
      },
    ],
  });
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const address = await s.listen();
    await writeFile(
      path.join(s.dir, 'source.txt'),
      'Data stays on its registered host until this approved result is returned.',
    );
    await writeFile(path.join(s.dir, 'node.token'), nodeToken, { mode: 0o600 });
    const cfg = workerSchema.parse({
      nodeId: 'remote',
      dataDir: path.join(s.dir, 'remote'),
      gatewayUrl: address,
      tokenFile: path.join(s.dir, 'node.token'),
      tools: [
        {
          reference: 'lookup',
          capability: remoteCapability(),
          handler: { kind: 'read_directory', root: s.dir },
        },
      ],
    });
    running = connectWorker(cfg, stop.signal);
    await waitFor(() => s.hub.nodes.has('remote'));
    s.store.publish('owner', makeBundle(agent({ tools: [binding()] })));
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Look up the private source.',
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'completed', r.body);
    assert.match(r.json().output.at(-1).content[0].text, /registered host/);
    assert.equal(s.store.steps(r.json().id)[0]!.nodeId, 'remote');
    assert.equal(s.hub.inventory('owner').length, 2);
  } finally {
    stop.abort();
    await running;
    await s.cleanup();
  }
});
test('declared input data placement prevents transfer to an otherwise capable remote node', async () => {
  process.env.OAA_NODE_TEST = nodeToken;
  const s = await setup(
    new FixtureModel(() => ({
      calls: [{ id: 'lookup', name: 'private_lookup', arguments: { path: 'source.txt' } }],
    })),
    { nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_NODE_TEST' }] },
  );
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const address = await s.listen();
    await writeFile(path.join(s.dir, 'node.token'), nodeToken);
    const cfg = workerSchema.parse({
      nodeId: 'remote',
      dataDir: path.join(s.dir, 'remote'),
      gatewayUrl: address,
      tokenFile: path.join(s.dir, 'node.token'),
      tools: [
        {
          reference: 'lookup',
          capability: remoteCapability(),
          handler: { kind: 'read_directory', root: s.dir },
        },
      ],
    });
    running = connectWorker(cfg, stop.signal);
    await waitFor(() => s.hub.nodes.has('remote'));
    s.store.publish('owner', makeBundle(agent({ tools: [binding()] })));
    const file = await s.store.addFile('owner', 'secret.txt', Buffer.from('private'), ['local']);
    const r = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'read',
      file_ids: [file.id],
    });
    assert.equal(r.json().status, 'failed');
    assert.equal(r.json().error.code, 'capability_unavailable');
    assert.equal(s.hub.nodes.get('remote')!.successes, 0);
  } finally {
    stop.abort();
    await running;
    await s.cleanup();
  }
});
test('node identity and capability grants are enforced at registration', async () => {
  process.env.OAA_NODE_TEST = nodeToken;
  const s = await setup(undefined, {
    nodeKeys: [
      { nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_NODE_TEST', capabilities: ['allowed'] },
    ],
  });
  try {
    const address = await s.listen();
    const ws = new WebSocket(address.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${nodeToken}`, 'x-oaa-node-id': 'remote' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(
          JSON.stringify({
            protocol: 'oaa/1',
            type: 'hello',
            advertisement: {
              nodeId: 'remote',
              providers: [],
              natives: [],
              capabilities: [remoteCapability()],
              warm: [],
              concurrency: 1,
            },
          }),
        );
      });
      ws.once('close', () => resolve());
      ws.once('error', reject);
    });
    assert.equal(s.hub.nodes.has('remote'), false);
  } finally {
    await s.cleanup();
  }
});
test('remote disconnection makes a non-idempotent side effect uncertain and blocks replay', async () => {
  process.env.OAA_NODE_TEST = nodeToken;
  const cap = capabilitySchema.parse({
    ...remoteCapability(),
    id: 'private/write',
    effect: 'write',
  });
  let writes = 0;
  const s = await setup(
    new FixtureModel(() => ({
      calls: [{ id: 'external', name: 'external_write', arguments: { path: 'x' } }],
    })),
    { nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_NODE_TEST' }] },
  );
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const address = await s.listen();
    await writeFile(path.join(s.dir, 'node.token'), nodeToken);
    const cfg = workerSchema.parse({
      nodeId: 'remote',
      dataDir: path.join(s.dir, 'remote'),
      gatewayUrl: address,
      tokenFile: path.join(s.dir, 'node.token'),
      tools: [
        { reference: 'write', capability: cap, handler: { kind: 'read_directory', root: s.dir } },
      ],
    });
    const runtime = new WorkerRuntime(
      cfg,
      new Map([
        [
          'write',
          async (_args, _context, signal) => {
            writes++;
            await sleep(5000, signal);
            return { value: { ok: true } };
          },
        ],
      ]),
    );
    running = connectWorker(cfg, stop.signal, runtime);
    await waitFor(() => s.hub.nodes.has('remote'));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [
            {
              name: 'external_write',
              capability: cap,
              handler: { kind: 'node', reference: 'write' },
            },
          ],
        }),
      ),
    );
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'write',
      background: true,
    });
    await waitFor(() => writes === 1);
    stop.abort();
    await running;
    const done = await s.kernel.wait(r.json().id);
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'effect_outcome_unknown');
    assert.equal(s.store.steps(done.id)[0]?.status, 'uncertain');
    assert.equal((await s.request('POST', `/v1/runs/${done.id}/resume`, {})).statusCode, 409);
    assert.equal(writes, 1);
  } finally {
    stop.abort();
    await running;
    await s.cleanup();
  }
});
test('the same side-effect resource is serialized even with parallel tool calls', async () => {
  let active = 0,
    max = 0;
  const cap = capabilitySchema.parse({
    id: 'private/write',
    version: '1',
    description: 'Controlled write',
    placement: 'host-bound',
    nodeId: 'local',
    effect: 'write',
    inputSchema: { type: 'object' },
    resourceKey: 'shared-resource',
  });
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : {
            calls: [
              { id: 'a', name: 'write', arguments: {} },
              { id: 'b', name: 'write', arguments: {} },
            ],
          },
    ),
  );
  try {
    s.runtime.config.tools.push({
      reference: 'write',
      capability: cap,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('write', async () => {
      active++;
      max = Math.max(max, active);
      await sleep(25);
      active--;
      return { value: 'ok' };
    });
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [
            { name: 'write', capability: cap, handler: { kind: 'node', reference: 'write' } },
          ],
        }),
      ),
    );
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'write twice',
    });
    assert.equal(r.json().status, 'completed');
    assert.equal(max, 1);
  } finally {
    await s.cleanup();
  }
});
