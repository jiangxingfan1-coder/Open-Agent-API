import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { setup, agent, FixtureModel, token, secondToken, waitFor } from './helpers.js';
import {
  agentSchema,
  capabilitySchema,
  type ToolBinding,
  type Run,
} from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { workerSchema, providerSchema } from '../src/config/config.js';
import { WorkerRuntime, type Executor } from '../src/fabric/worker.js';
import { connectWorker } from '../src/fabric/network.js';
import { ModelRouter } from '../src/gateway/protocol.js';
import { Fault, sleep } from '../src/core/util.js';

const scriptBinding = (required = false): ToolBinding => ({
  name: 'convert',
  required,
  capability: capabilitySchema.parse({
    id: 'portable/convert',
    version: '1',
    description: 'Owner-selected script',
    placement: 'portable',
    effect: 'read',
    inputSchema: { type: 'object' },
  }),
  handler: { kind: 'script', runtime: 'python3', path: 'convert.py' },
});
const hostBinding = (required = false): ToolBinding => ({
  name: 'private_lookup',
  required,
  capability: capabilitySchema.parse({
    id: 'private/source',
    version: '1',
    description: 'Private source lookup',
    placement: 'host-bound',
    nodeId: 'offline',
    effect: 'read',
    inputSchema: { type: 'object' },
  }),
  handler: { kind: 'node', reference: 'source' },
});
function nativeFixture(s: Awaited<ReturnType<typeof setup>>, execute: Executor['execute']) {
  const engine = 'adapter/review';
  s.hub.addLocal(
    {
      nodeId: 'native-fixture',
      owner: 'owner',
      token: 'test',
      agents: ['agent/test'],
      capabilities: [`native/${engine}`],
    },
    {
      advertisement: () => ({
        nodeId: 'native-fixture',
        providers: [],
        natives: [engine],
        capabilities: [],
        warm: [],
        concurrency: 4,
        execution: {
          builtins: [],
          scripts: [],
          toolSelection: false,
          nativeModels: { [engine]: { mode: 'declared' } },
        },
      }),
      install: async () => {},
      execute,
      close: async () => {},
    },
  );
  s.store.publish('owner', makeBundle(agent({ engine })));
}
test('overlapping native approvals are subtracted as a union, not counted twice', async () => {
  const s = await setup();
  try {
    nativeFixture(s, async (_work, signal, emit) => {
      await sleep(60, signal);
      await Promise.all([
        emit({ type: 'approval', data: { tool: 'first' } }),
        emit({ type: 'approval', data: { tool: 'second' } }),
      ]);
      return { text: 'Fixture completed after approvals.', nativeState: {}, usage: null };
    });
    const response = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'Native approval fixture',
      background: true,
    });
    const id = response.json().id;
    await waitFor(() => s.store.approvals(id).length === 2);
    await sleep(120);
    for (const action of s.store.approvals(id))
      await s.request('POST', `/v1/runs/${id}/actions/${action.id}`, { decision: 'approve' });
    const run = await s.kernel.wait(id);
    assert.equal(run.status, 'completed');
    const health = s.kernel.router.stats(run.owner, run.digest, run.route.id)!;
    assert.ok(
      health.averageMs >= 40,
      'The sixty milliseconds of execution must not disappear through double-subtracted waits.',
    );
  } finally {
    await s.cleanup();
  }
});
test('late native approval cleanup cannot resurrect a failed terminal response', async () => {
  const s = await setup();
  try {
    nativeFixture(s, async (_work, _signal, emit) => {
      void emit({ type: 'approval', data: { tool: 'abandoned' } }).catch(() => {});
      throw new Fault('native_incomplete', 'Fixture terminated before answering its prompt.', 502);
    });
    const response = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'Fail before resolving an approval.',
      background: true,
    });
    const id = response.json().id;
    await waitFor(() => s.store.history(id).some((e) => e.type === 'response.failed'));
    await sleep(30);
    assert.equal(s.store.run(id).status, 'failed');
    assert.equal(s.store.approvals(id)[0]!.status, 'expired');
  } finally {
    await s.cleanup();
  }
});

test('route preview is read-only, scoped, and explains selection without executing a model', async () => {
  const s = await setup();
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          routes: [
            { id: 'fast', provider: 'fixture', model: 'fast-model', priority: 0 },
            { id: 'quality', provider: 'fixture', model: 'quality-model', priority: 1 },
          ],
        }),
      ),
    );
    const response = await s.request('POST', '/v1/agents/preview', {
      agent: 'agent/test',
      model: 'quality',
    });
    assert.equal(response.statusCode, 200, response.body);
    const plan = response.json();
    assert.equal(plan.selected.model, 'quality-model');
    assert.equal(plan.executes_model, false);
    assert.equal(plan.reserves_capacity, false);
    assert.equal(plan.candidates[0].latency_evidence, 'default_estimate');
    assert.equal(plan.candidates[0].placement.candidates[0].node_id, 'local');
    assert.equal(s.driver.calls, 0);
    assert.equal(s.store.allRuns().length, 0);
    assert.equal(
      (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' }, secondToken))
        .statusCode,
      404,
    );
  } finally {
    await s.cleanup();
  }
});

test('missing required capabilities block execution before any provider call', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [hostBinding(true)] })));
    const plan = (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' })).json();
    assert.equal(plan.selected, null);
    assert.ok(
      plan.candidates[0].placement.reasons.some(
        (r: { code: string }) => r.code === 'required_tool_unavailable',
      ),
    );
    const response = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Needs a private tool.',
    });
    assert.equal(response.statusCode, 503);
    assert.equal(s.driver.calls, 0);
    assert.equal(s.store.allRuns().length, 0);
  } finally {
    await s.cleanup();
  }
});

test('unavailable optional tools are omitted from model requests and reported as degraded', async () => {
  let offered: string[] = [];
  const s = await setup(
    new FixtureModel((a) => {
      offered = a.tools.map((t) => t.name);
      return { text: 'No optional tool was used.' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [hostBinding()] })));
    const catalog = (await s.request('GET', '/v1/agents')).json().data[0];
    assert.equal(catalog.status, 'degraded');
    assert.equal(catalog.ready, false);
    assert.equal(catalog.dispatchable, true);
    const response = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Answer without external tools.',
    });
    assert.equal(response.json().status, 'completed');
    assert.deepEqual(offered, []);
    assert.ok(s.store.history(response.json().id).some((e) => e.type === 'tools.unavailable'));
  } finally {
    await s.cleanup();
  }
});

test('file locality participates in automatic model selection instead of failing after dispatch', async () => {
  const s = await setup();
  const remoteDriver = new FixtureModel((a) => ({ text: `served by ${a.provider}` }));
  try {
    const worker = new WorkerRuntime(
      workerSchema.parse({ nodeId: 'data-host', dataDir: path.join(s.dir, 'data-host') }),
      new Map(),
      new Map([['other', remoteDriver]]),
    );
    s.hub.addLocal(
      {
        nodeId: 'data-host',
        owner: 'owner',
        token: 'test',
        agents: ['agent/test'],
        capabilities: ['*'],
      },
      worker,
    );
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          routes: [
            { id: 'preferred', provider: 'fixture', model: 'same-model', priority: 0 },
            { id: 'data-local', provider: 'other', model: 'same-model', priority: 1 },
          ],
        }),
      ),
    );
    const file = await s.store.addFile(
      'owner',
      'source.txt',
      Buffer.from('locality-bound fixture'),
      ['data-host'],
    );
    const plan = (
      await s.request('POST', '/v1/agents/preview', { agent: 'agent/test', file_ids: [file.id] })
    ).json();
    assert.equal(plan.selected.id, 'data-local');
    assert.ok(
      plan.candidates
        .find((r: { id: string }) => r.id === 'preferred')
        .placement.candidates.some((n: { reasons: { code: string }[] }) =>
          n.reasons.some((r) => r.code === 'file_node_restriction'),
        ),
    );
    const response = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'Use the supplied file.',
      file_ids: [file.id],
    });
    assert.equal(response.json().status, 'completed');
    assert.equal(s.driver.calls, 0);
    assert.equal(remoteDriver.calls, 1);
  } finally {
    await s.cleanup();
  }
});

test('DSH model mappings are checked without spawning the native agent', async () => {
  const s = await setup();
  try {
    s.runtime.config.native.dsh = { executable: process.execPath, enabled: true, args: [] };
    s.store.publish(
      'owner',
      makeBundle(agent({ engine: 'dsh', model: 'unmapped', provider: 'native' })),
    );
    const plan = (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' })).json();
    assert.equal(plan.selected, null);
    assert.ok(
      plan.candidates[0].placement.candidates[0].reasons.some(
        (r: { code: string }) => r.code === 'native_model_unsupported',
      ),
    );
    assert.equal(
      (
        await s.request('POST', '/v1/invoke', {
          agent: 'agent/test',
          input: 'No native process may start.',
        })
      ).statusCode,
      503,
    );
    assert.equal(s.store.allRuns().length, 0);
  } finally {
    await s.cleanup();
  }
});

test('a throttled model does not stall another model on the same worker', async () => {
  const s = await setup(
    new FixtureModel((a) => {
      if (a.model === 'hot') throw new Fault('upstream_rate_limited', 'Fixture throttle', 429);
      return { text: 'healthy' };
    }),
  );
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          routes: [
            { id: 'hot', provider: 'fixture', model: 'hot', priority: 0 },
            { id: 'healthy', provider: 'fixture', model: 'healthy', priority: 1 },
          ],
        }),
      ),
    );
    const failed = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      model: 'hot',
      input: 'throttle',
    });
    assert.equal(failed.json().error.code, 'upstream_rate_limited');
    const plan = (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' })).json();
    assert.equal(plan.selected.model, 'healthy');
    assert.equal(
      plan.candidates.find((c: { id: string }) => c.id === 'hot').placement.status,
      'cooling_down',
    );
    const started = Date.now();
    const good = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      model: 'healthy',
      input: 'do not wait for the other model',
    });
    assert.equal(good.json().status, 'completed');
    assert.ok(
      Date.now() - started < 1000,
      'Unrelated model must not inherit the five-second cooldown.',
    );
  } finally {
    await s.cleanup();
  }
});

test('late successes cannot erase a newer throttle cooldown', () => {
  const router = new ModelRouter();
  const run = { owner: 'owner', digest: 'version', route: { id: 'route' } } as Run;
  router.record(run, 10);
  router.record(run, 1, 'upstream_rate_limited');
  const until = router.stats('owner', 'version', 'route')!.cooldownUntil;
  router.record(run, 20);
  assert.equal(router.stats('owner', 'version', 'route')!.cooldownUntil, until);
  assert.ok(until > Date.now());
  const fresh = new ModelRouter();
  fresh.record(run, 10000, 'cancelled');
  assert.equal(fresh.stats('owner', 'version', 'route'), undefined);
});

test('human approvals and tool failures do not become model-latency samples', async () => {
  const binding = hostBinding();
  binding.capability.nodeId = 'local';
  binding.capability.requiresApproval = true;
  const s = await setup(
    new FixtureModel(() => ({ calls: [{ id: 'ask', name: 'private_lookup', arguments: {} }] })),
  );
  try {
    s.runtime.config.tools.push({
      reference: 'source',
      capability: binding.capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.store.publish('owner', makeBundle(agent({ tools: [binding] })));
    const response = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'Request approval.',
      background: true,
    });
    const id = response.json().id;
    await waitFor(() => s.store.run(id).status === 'requires_action');
    await sleep(80);
    const action = s.store.approvals(id)[0]!;
    await s.request('POST', `/v1/runs/${id}/actions/${action.id}`, { decision: 'deny' });
    assert.equal((await s.kernel.wait(id)).status, 'failed');
    const run = s.store.run(id),
      health = s.kernel.router.stats('owner', run.digest, run.route.id)!;
    assert.equal(health.calls, 1);
    assert.equal(health.successfulCalls, 1);
    assert.equal(health.failures, 0);
    assert.equal(health.cooldownUntil, 0);
  } finally {
    await s.cleanup();
  }
});

test('idle remote workers are removed after heartbeat expiry even without active jobs', async () => {
  process.env.OAA_ROUTE_NODE = 'routing-node-credential-01234567890123456789';
  const s = await setup(undefined, {
    leaseMs: 120,
    nodeKeys: [{ nodeId: 'idle', owner: 'owner', tokenEnv: 'OAA_ROUTE_NODE' }],
  });
  let ws: WebSocket | undefined;
  try {
    const url = await s.listen();
    ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${process.env.OAA_ROUTE_NODE}`, 'x-oaa-node-id': 'idle' },
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => {
        ws!.send(
          JSON.stringify({
            type: 'hello',
            protocol: 'oaa/1',
            advertisement: {
              nodeId: 'idle',
              providers: [],
              natives: [],
              capabilities: [],
              warm: [],
              concurrency: 1,
            },
          }),
        );
        resolve();
      });
      ws!.once('error', reject);
    });
    await waitFor(() => s.hub.nodes.has('idle'));
    await waitFor(() => !s.hub.nodes.has('idle'), 1000);
  } finally {
    ws?.terminate();
    await s.cleanup();
  }
});

test('negotiated capability updates make runtime changes visible without reconnecting', async () => {
  process.env.OAA_ROUTE_NODE = 'routing-node-credential-01234567890123456789';
  const s = await setup(undefined, {
    leaseMs: 300,
    nodeKeys: [{ nodeId: 'remote', owner: 'owner', tokenEnv: 'OAA_ROUTE_NODE' }],
  });
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const url = await s.listen();
    await writeFile(path.join(s.dir, 'node.token'), process.env.OAA_ROUTE_NODE);
    const config = workerSchema.parse({
      nodeId: 'remote',
      dataDir: path.join(s.dir, 'remote'),
      gatewayUrl: url,
      tokenFile: path.join(s.dir, 'node.token'),
    });
    const runtime = new WorkerRuntime(config);
    running = connectWorker(config, stop.signal, runtime);
    await waitFor(() => s.hub.nodes.has('remote'));
    assert.deepEqual(s.hub.nodes.get('remote')!.executor.advertisement().execution!.scripts, []);
    runtime.config.scripts.push('node');
    await waitFor(
      () =>
        s.hub.nodes.get('remote')?.executor.advertisement().execution?.scripts.includes('node') ===
        true,
      1500,
    );
    assert.ok(s.hub.nodes.has('remote'));
  } finally {
    stop.abort();
    await running;
    await s.cleanup();
  }
});

test('optional contract fields preserve an existing v0.1 native bundle digest', () => {
  const native = agentSchema.parse({
    id: 'agent/codex',
    description: 'Native codex agent',
    instructions: '',
    engine: 'codex',
    provider: 'native',
    model: 'default',
    routes: [{ id: 'default', model: 'default', provider: 'native', priority: 0 }],
    tools: [],
    allowGraph: false,
  });
  assert.equal(
    makeBundle(native).digest,
    '086160092d152be7f76dca1b8e2e12440e07c7a3d8314025c965489c2b5b3d91',
  );
});
test('preview and invocation can pin a published version even after the alias changes', async () => {
  const s = await setup(new FixtureModel((a) => ({ text: a.instructions })));
  try {
    const original = makeBundle(agent({ instructions: 'Original immutable definition.' }));
    s.store.publish('owner', original);
    const plan = (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' })).json();
    const updated = makeBundle(agent({ instructions: 'New definition.' }));
    s.store.publish('owner', updated);
    const pinned = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Use the reviewed version.',
      metadata: { 'oaa.agent_version': plan.version },
    });
    assert.equal(pinned.json().status, 'completed');
    assert.equal(pinned.json().output[0].content[0].text, 'Original immutable definition.');
    assert.equal(pinned.json().metadata['oaa.agent_version'], original.digest);
    const conflict = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      input: 'Do not silently switch the session.',
      agent_version: updated.digest,
      previous_response_id: pinned.json().id,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'version_conflict');
    assert.equal(
      (
        await s.request('POST', '/v1/agents/preview', {
          agent: 'agent/test',
          agent_version: 'f'.repeat(64),
        })
      ).statusCode,
      404,
    );
  } finally {
    await s.cleanup();
  }
});
test('native executor grants are not implied by permission to invoke the agent alias', async () => {
  const s = await setup();
  try {
    s.runtime.config.native.codex = { executable: process.execPath, enabled: true, args: [] };
    s.hub.nodes.get('local')!.credential.capabilities = ['oaa/read_file'];
    s.store.publish(
      'owner',
      makeBundle(agent({ engine: 'codex', provider: 'native', model: 'default' })),
    );
    const plan = (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' })).json();
    assert.equal(plan.selected, null);
    assert.ok(
      plan.candidates[0].placement.reasons.some(
        (r: { code: string }) => r.code === 'capability_scope',
      ),
    );
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});
test('an enabled but missing native executable is not advertised as callable', async () => {
  const s = await setup();
  try {
    s.runtime.config.native.codex = {
      executable: '/nonexistent-oaa-fixture/codex',
      enabled: true,
      args: [],
    };
    assert.equal(s.runtime.advertisement().natives.includes('codex'), false);
  } finally {
    await s.cleanup();
  }
});

test('route inspection does not expose nodes outside the requested agent grant', async () => {
  const s = await setup();
  try {
    const worker = new WorkerRuntime(
      workerSchema.parse({ nodeId: 'unrelated-private-node', dataDir: path.join(s.dir, 'hidden') }),
      new Map(),
      new Map([['fixture', new FixtureModel()]]),
    );
    s.hub.addLocal(
      {
        nodeId: 'unrelated-private-node',
        owner: 'owner',
        token: 'test',
        agents: ['agent/other'],
        capabilities: ['*'],
      },
      worker,
    );
    s.store.publish('owner', makeBundle(agent()));
    const key = (
      await s.request('POST', '/v1/keys', {
        name: 'reader',
        agents: ['agent/test'],
        scopes: ['read'],
      })
    ).json().token;
    const result = await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' }, key);
    assert.equal(result.statusCode, 200);
    assert.ok(!result.body.includes('unrelated-private-node'));
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});
test('disabled portable script runtimes are reported before dispatch', async () => {
  const s = await setup();
  try {
    const binding = scriptBinding(true);
    const report = s.hub.availability('owner', agent({ tools: [binding] }));
    assert.equal(report.available, false);
    assert.ok(report.tools[0]!.reasons.some((r) => r.code === 'script_runtime_disabled'));
  } finally {
    await s.cleanup();
  }
});
test('new workers retain the legacy hello shape and do not send unnegotiated updates', async () => {
  const s = await setup();
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const messages: Record<string, unknown>[] = [];
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    server.on('connection', (ws) =>
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        messages.push(m);
        if (m.type === 'hello')
          ws.send(JSON.stringify({ type: 'welcome', protocol: 'oaa/1', leaseMs: 300 }));
        if (m.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      }),
    );
    await writeFile(
      path.join(s.dir, 'legacy.token'),
      'legacy-node-credential-01234567890123456789',
    );
    const port = (server.address() as { port: number }).port;
    const config = workerSchema.parse({
      nodeId: 'legacy-client',
      dataDir: path.join(s.dir, 'legacy'),
      gatewayUrl: `http://127.0.0.1:${port}`,
      tokenFile: path.join(s.dir, 'legacy.token'),
    });
    const runtime = new WorkerRuntime(config);
    running = connectWorker(config, stop.signal, runtime);
    await waitFor(() => messages.some((m) => m.type === 'hello'));
    runtime.config.scripts.push('node');
    await waitFor(() => messages.filter((m) => m.type === 'heartbeat').length >= 2);
    const hello = messages.find((m) => m.type === 'hello')!;
    assert.equal('execution' in (hello.advertisement as object), false);
    assert.ok(hello.execution);
    assert.equal(
      messages.some((m) => m.type === 'advertisement'),
      false,
    );
  } finally {
    stop.abort();
    await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((r) => server.close(() => r()));
    await s.cleanup();
  }
});
test('capability updates cannot expand a worker credential grant', async () => {
  process.env.OAA_ROUTE_NODE = 'routing-node-credential-01234567890123456789';
  const s = await setup(undefined, {
    nodeKeys: [
      {
        nodeId: 'restricted',
        owner: 'owner',
        tokenEnv: 'OAA_ROUTE_NODE',
        capabilities: ['permitted'],
      },
    ],
  });
  let ws: WebSocket | undefined;
  try {
    const url = await s.listen();
    ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: {
        Authorization: `Bearer ${process.env.OAA_ROUTE_NODE}`,
        'x-oaa-node-id': 'restricted',
      },
    });
    const base = {
      nodeId: 'restricted',
      providers: [],
      natives: [],
      capabilities: [],
      warm: [],
      concurrency: 1,
    };
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => {
        ws!.send(JSON.stringify({ type: 'hello', protocol: 'oaa/1', advertisement: base }));
        resolve();
      });
      ws!.once('error', reject);
    });
    await waitFor(() => s.hub.nodes.has('restricted'));
    const forbidden = capabilitySchema.parse({
      id: 'forbidden',
      version: '1',
      description: 'Not granted',
      placement: 'portable',
      effect: 'read',
      inputSchema: { type: 'object' },
    });
    ws.send(
      JSON.stringify({
        type: 'advertisement',
        advertisement: { ...base, capabilities: [forbidden] },
      }),
    );
    await waitFor(() => !s.hub.nodes.has('restricted'), 1000);
  } finally {
    ws?.terminate();
    await s.cleanup();
  }
});
test('provider credential changes replace warm clients and removed credentials disappear from discovery', async () => {
  const seen: string[] = [];
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    seen.push(String(req.headers.authorization));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const s = await setup();
  try {
    const port = (upstream.address() as { port: number }).port;
    s.runtime.config.providers.rotating = providerSchema.parse({
      kind: 'openai-chat',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: 'OAA_ROTATION_FIXTURE',
    });
    s.store.publish('owner', makeBundle(agent({ provider: 'rotating' })));
    process.env.OAA_ROTATION_FIXTURE = 'fixture-credential-one';
    assert.equal(
      (await s.request('POST', '/v1/invoke', { agent: 'agent/test', input: 'one' })).json().status,
      'completed',
    );
    process.env.OAA_ROTATION_FIXTURE = 'fixture-credential-two';
    assert.equal(
      (await s.request('POST', '/v1/invoke', { agent: 'agent/test', input: 'two' })).json().status,
      'completed',
    );
    delete process.env.OAA_ROTATION_FIXTURE;
    assert.equal(
      (await s.request('POST', '/v1/agents/preview', { agent: 'agent/test' })).json().selected,
      null,
    );
    assert.deepEqual(seen, ['Bearer fixture-credential-one', 'Bearer fixture-credential-two']);
  } finally {
    delete process.env.OAA_ROTATION_FIXTURE;
    await s.cleanup();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
