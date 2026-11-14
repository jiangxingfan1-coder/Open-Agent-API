import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { setup, agent, principal, secondToken, token, FixtureModel, waitFor } from './helpers.js';
import { capabilitySchema, type Effect } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { workerSchema } from '../src/config/config.js';
import { WorkerRuntime, type LocalHandler } from '../src/fabric/worker.js';
import { connectWorker } from '../src/fabric/network.js';
import { createGateway } from '../src/gateway/server.js';
import { Store } from '../src/store/store.js';

const exec = promisify(execFile);
const nodeId = 'policy-remote';
const api = (action: string) => `/v1/nodes/${nodeId}/${action}`;
async function start(handler: LocalHandler, configured = false, effect: Effect = 'write') {
  const configuredToken = 'configured-node-policy-fixture-not-a-real-credential';
  process.env.OAA_POLICY_NODE = configuredToken;
  const s = await setup(
    new FixtureModel((_definition, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'Fixture operation completed.' }
        : { calls: [{ id: 'operation', name: 'operation', arguments: {} }] },
    ),
    configured ? { nodeKeys: [{ nodeId, owner: 'owner', tokenEnv: 'OAA_POLICY_NODE' }] } : {},
  );
  const capability = capabilitySchema.parse({
    id: 'fixture/policy-operation',
    version: '1',
    description: 'Controlled node policy fixture',
    placement: 'host-bound',
    nodeId,
    effect,
    inputSchema: { type: 'object' },
  });
  const enrollment = configured
    ? null
    : s.auth.enroll(principal, nodeId, ['agent/test'], [capability.id]);
  if (enrollment) s.hub.credentials.push(enrollment.credential);
  const nodeToken = enrollment?.token ?? configuredToken;
  const tokenFile = path.join(s.dir, 'node.token');
  await writeFile(tokenFile, nodeToken, { mode: 0o600 });
  s.store.publish(
    'owner',
    makeBundle(
      agent({
        tools: [
          {
            name: 'operation',
            required: true,
            capability,
            handler: { kind: 'node', reference: 'operation' },
          },
        ],
      }),
    ),
  );
  const url = await s.listen();
  const config = workerSchema.parse({
    nodeId,
    owner: 'owner',
    dataDir: path.join(s.dir, 'remote'),
    gatewayUrl: url,
    tokenFile,
    concurrency: 1,
    tools: [
      { reference: 'operation', capability, handler: { kind: 'read_directory', root: s.dir } },
    ],
  });
  const runtime = new WorkerRuntime(config, new Map([['operation', handler]]));
  const stop = new AbortController();
  const outcome = connectWorker(config, stop.signal, runtime).then(
    () => null,
    (error: unknown) => error,
  );
  await waitFor(() => s.hub.nodes.has(nodeId));
  return {
    ...s,
    url,
    nodeToken,
    workerConfig: config,
    outcome,
    submit: () =>
      s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/test', input: 'Controlled lifecycle fixture' }),
      ),
    stopWorker: async () => {
      stop.abort();
      await outcome;
    },
    cleanup: async () => {
      stop.abort();
      await outcome;
      await s.cleanup();
    },
  };
}
async function denied(url: string, nodeToken: string) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${nodeToken}`, 'X-OAA-Node-ID': nodeId },
      handshakeTimeout: 1000,
    });
    ws.once('unexpected-response', (_req, response) => {
      resolve(response.statusCode!);
      response.destroy();
      ws.terminate();
    });
    ws.once('open', () => {
      ws.terminate();
      reject(Error('Revoked credential was accepted.'));
    });
    ws.on('error', () => {});
  });
}
test('drain preserves started work, blocks queued/new steps and can be resumed under the same grant', async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0,
    aborted = false;
  const s = await start(async (_args, _context, signal) => {
    calls++;
    signal.addEventListener(
      'abort',
      () => {
        aborted = true;
      },
      { once: true },
    );
    await gate.promise;
    return { value: 'settled' };
  });
  try {
    const first = s.submit();
    await waitFor(() => calls === 1);
    const queued = s.submit();
    await waitFor(() => s.store.steps(queued.id).some((step) => step.status === 'pending'));
    const result = await s.request('POST', api('drain'), { reason: 'fixture maintenance' });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().state, 'draining');
    assert.equal(result.json().drained, false);
    assert.equal(aborted, false);
    assert.equal((await s.kernel.wait(queued.id)).status, 'interrupted');
    assert.equal(calls, 1);
    gate.resolve();
    const checkpoint = await s.kernel.wait(first.id);
    assert.equal(checkpoint.status, 'interrupted');
    assert.equal(checkpoint.error?.code, 'node_draining');
    assert.equal(s.store.steps(first.id)[0]!.status, 'completed');
    await waitFor(() => s.hub.nodes.get(nodeId)?.active === 0);
    const registry = (await s.request('GET', '/v1/nodes/registrations'))
      .json()
      .data.find((node: { nodeId: string }) => node.nodeId === nodeId);
    assert.equal(registry.drained, true);
    const before = s.driver.calls;
    assert.equal(
      (await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'must not start' }))
        .statusCode,
      503,
    );
    assert.equal(s.driver.calls, before);
    assert.equal((await s.request('POST', api('resume'), {})).json().state, 'active');
    s.kernel.resume(principal, first.id);
    assert.equal((await s.kernel.wait(first.id)).status, 'completed');
    assert.equal(calls, 1);
    assert.equal((await s.kernel.wait(s.submit().id)).status, 'completed');
    assert.equal(calls, 2);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('revocation stops trusted input immediately and leaves an in-flight external write uncertain', async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0,
    abortObserved = false;
  const s = await start(async (_args, _context, signal) => {
    calls++;
    signal.addEventListener(
      'abort',
      () => {
        abortObserved = true;
      },
      { once: true },
    );
    await gate.promise;
    return { value: 'late untrusted result' };
  });
  try {
    const run = s.submit();
    await waitFor(() => calls === 1);
    const revoked = await s.request('POST', api('revoke'), { reason: 'fixture trust removed' });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json().connected, false);
    assert.equal(revoked.json().external_effects_stopped, 'not_verified');
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'effect_outcome_unknown');
    assert.equal(s.store.steps(run.id)[0]!.status, 'uncertain');
    assert.equal((await s.request('POST', `/v1/runs/${run.id}/resume`, {})).statusCode, 409);
    await waitFor(() => abortObserved);
    assert.equal(await denied(s.url, s.nodeToken), 401);
    assert.equal((await s.request('POST', api('resume'), {})).statusCode, 409);
    assert.equal((await s.request('POST', api('revoke'), {})).statusCode, 200);
    assert.equal((await s.request('GET', api('history'))).json().data.length, 1);
    gate.resolve();
    const stopped = (await s.outcome) as { code: string };
    assert.equal(stopped.code, 'node_authentication_denied');
    assert.equal(s.store.run(run.id).status, 'interrupted');
    assert.equal(s.store.steps(run.id)[0]!.result, undefined);
    assert.equal(calls, 1);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('policy and audit failures roll back before scheduling authority or the connection changes', async () => {
  const s = await start(async () => ({ value: 'okay' }));
  try {
    s.store.db.exec(
      `CREATE TRIGGER fail_node_policy_audit BEFORE INSERT ON node_policy_events BEGIN SELECT RAISE(ABORT, 'fixture policy audit failure'); END;`,
    );
    const result = await s.request('POST', api('revoke'), {});
    assert.equal(result.statusCode, 500);
    assert.equal(s.auth.nodePolicies().length, 0);
    assert.equal(s.hub.policy(nodeId), 'active');
    assert.ok(s.hub.nodes.has(nodeId));
    s.store.db.exec('DROP TRIGGER fail_node_policy_audit');
    assert.equal((await s.kernel.wait(s.submit().id)).status, 'completed');
    assert.equal((await s.request('POST', api('drain'), {})).statusCode, 200);
    assert.equal((await s.request('POST', api('drain'), {})).statusCode, 200);
    assert.equal((await s.request('GET', api('history'))).json().data.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('node administration is owner-wide, credentials are never listed, and local workers are protected', async () => {
  const s = await start(async () => ({ value: 'okay' }));
  try {
    const limited = String(
      s.auth.create(principal, 'limited-admin', ['agent/test'], ['admin']).token,
    );
    const read = String(s.auth.create(principal, 'read-only', ['*'], ['read']).token);
    for (const key of [limited, read]) {
      assert.equal(
        (await s.request('GET', '/v1/nodes/registrations', undefined, key)).statusCode,
        403,
      );
      assert.equal((await s.request('POST', api('revoke'), {}, key)).statusCode, 403);
      assert.equal((await s.request('GET', '/v1/nodes', undefined, key)).statusCode, 403);
      assert.equal((await s.request('GET', '/v1/local/backends', undefined, key)).statusCode, 403);
      assert.deepEqual((await s.request('GET', '/v1/overview', undefined, key)).json().nodes, []);
    }
    assert.equal((await s.request('POST', api('revoke'), {}, secondToken)).statusCode, 404);
    assert.equal((await s.request('GET', api('history'), undefined, secondToken)).statusCode, 404);
    assert.equal((await s.request('POST', '/v1/nodes/local/revoke', {})).statusCode, 409);
    const registry = await s.request('GET', '/v1/nodes/registrations');
    assert.ok(!registry.body.includes(s.nodeToken));
    assert.ok(!registry.body.includes('sha256:'));
    assert.equal(
      registry.json().data.find((node: { nodeId: string }) => node.nodeId === 'local').manageable,
      false,
    );
    assert.deepEqual(
      (await s.request('GET', '/v1/overview', undefined, limited)).json().principal.agents,
      ['agent/test'],
    );
    assert.equal((await s.request('POST', api('drain'), { unsupported: true })).statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('a revoked credential cannot complete a handshake that was already accepted over HTTP', async () => {
  const s = await setup();
  let ws: WebSocket | undefined;
  try {
    const enrolled = s.auth.enroll(principal, nodeId, ['*'], ['*']);
    s.hub.credentials.push(enrolled.credential);
    const url = await s.listen();
    ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${enrolled.token}`, 'X-OAA-Node-ID': nodeId },
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', resolve);
      ws!.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws!.once('close', () => resolve()));
    const result = await s.request('POST', api('revoke'), {});
    assert.equal(result.statusCode, 200);
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: 'oaa/1',
        advertisement: {
          nodeId,
          providers: ['fixture'],
          natives: [],
          capabilities: [],
          warm: [],
          concurrency: 1,
        },
      }),
      () => {},
    );
    await closed;
    assert.equal(s.hub.nodes.has(nodeId), false);
    assert.equal(await denied(url, enrolled.token), 401);
  } finally {
    ws?.terminate();
    await s.cleanup();
  }
});

test('a drain during bundle preparation cannot start a new execution after the install reply', async () => {
  const s = await setup();
  let ws: WebSocket | undefined;
  let install: { id: string; leaseId: string } | undefined,
    executions = 0;
  try {
    const enrolled = s.auth.enroll(principal, nodeId, ['agent/remote-model'], ['*']);
    s.hub.credentials.push(enrolled.credential);
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/remote-model', provider: 'remote-only', allowedNodes: [nodeId] }),
      ),
    );
    const url = await s.listen();
    ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${enrolled.token}`, 'X-OAA-Node-ID': nodeId },
    });
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'install') install = message;
      if (message.type === 'execute') executions++;
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', resolve);
      ws!.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: 'oaa/1',
        advertisement: {
          nodeId,
          providers: ['remote-only'],
          natives: [],
          capabilities: [],
          warm: [],
          concurrency: 1,
        },
      }),
    );
    await waitFor(() => s.hub.nodes.has(nodeId));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/remote-model', input: 'fixture' }),
    );
    await waitFor(() => !!install);
    assert.equal((await s.request('POST', api('drain'), {})).statusCode, 200);
    ws.send(
      JSON.stringify({
        type: 'result',
        id: install!.id,
        leaseId: install!.leaseId,
        result: { installed: true },
      }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'node_draining');
    assert.equal(executions, 0);
  } finally {
    ws?.terminate();
    await s.cleanup();
  }
});

for (const configured of [false, true])
  test(`${configured ? 'configured' : 'enrolled'} node revocation survives gateway restart and the old worker stops retrying`, async () => {
    const s = await start(async () => ({ value: 'okay' }), configured);
    let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      await s.request('POST', api('revoke'), {});
      assert.equal(((await s.outcome) as { code: string }).code, 'node_authentication_denied');
      await s.app.close();
      replacement = await createGateway(
        s.config,
        new WorkerRuntime(
          s.config.localWorker!,
          new Map(),
          new Map([['fixture', new FixtureModel()]]),
        ),
      );
      const url = await replacement.listen();
      assert.equal(await denied(url, s.nodeToken), 401);
      const registry = await replacement.app.inject({
        method: 'GET',
        url: '/v1/nodes/registrations',
        headers: { Authorization: `Bearer ${token}` },
      });
      const node = registry.json().data.find((node: { nodeId: string }) => node.nodeId === nodeId);
      assert.equal(node.state, 'revoked');
      assert.equal(node.connected, false);
      assert.equal(node.active, null);
      assert.equal(node.source, configured ? 'configured' : 'enrolled');
      assert.throws(
        () => replacement!.auth.enroll(principal, nodeId, ['*'], ['*']),
        /already been enrolled/,
      );
      const worker = new WorkerRuntime({ ...s.workerConfig, gatewayUrl: url }, new Map());
      await assert.rejects(
        connectWorker({ ...s.workerConfig, gatewayUrl: url }, new AbortController().signal, worker),
        (error: unknown) => (error as { code: string }).code === 'node_authentication_denied',
      );
      assert.equal(replacement.auth.nodePolicies()[0]!.state, 'revoked');
    } finally {
      await replacement?.app.close();
      await s.cleanup();
    }
  });

test('schema v2 migration preserves existing publications and credential records while adding durable node policy tables', async () => {
  const s = await setup();
  let store: Store | undefined;
  try {
    const bundle = makeBundle(agent());
    s.store.publish('owner', bundle);
    s.auth.enroll(principal, nodeId, ['agent/test'], ['*']);
    const before = s.auth.nodeCredentials();
    await s.app.close();
    const db = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'));
    db.exec('DROP TABLE node_policy_events; DROP TABLE node_policies; PRAGMA user_version=2');
    db.close();
    store = new Store(s.config.dataDir);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.equal(store.bundle('owner', 'agent/test').digest, bundle.digest);
    assert.deepEqual(
      store.db
        .prepare('SELECT payload FROM node_credentials')
        .all()
        .map((row) => JSON.parse(String(row.payload))),
      before,
    );
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM node_policies').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM node_policy_events').get()!.n, 0);
  } finally {
    store?.close();
    await s.cleanup();
  }
});

test('draining survives reconnect and gateway restart without implicitly admitting new work', async () => {
  const s = await start(async () => ({ value: 'okay' }));
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  const stop = new AbortController();
  let joined: Promise<unknown> | undefined;
  try {
    assert.equal((await s.request('POST', api('drain'), {})).statusCode, 200);
    await s.stopWorker();
    await s.app.close();
    replacement = await createGateway(
      s.config,
      new WorkerRuntime(
        s.config.localWorker!,
        new Map(),
        new Map([['fixture', new FixtureModel()]]),
      ),
    );
    const url = await replacement.listen();
    const workerConfig = { ...s.workerConfig, gatewayUrl: url };
    joined = connectWorker(
      workerConfig,
      stop.signal,
      new WorkerRuntime(workerConfig, new Map([['operation', async () => ({ value: 'okay' })]])),
    ).catch((error: unknown) => error);
    await waitFor(() => replacement!.hub.nodes.has(nodeId));
    assert.equal(replacement.hub.policy(nodeId), 'draining');
    assert.equal(
      replacement.hub.inventory('owner').find((node) => node.nodeId === nodeId)!.drained,
      true,
    );
    const preview = replacement.kernel.preview(principal, {
      agent: 'agent/test',
      model: 'auto',
      file_ids: [],
    });
    assert.equal(preview.selected, null);
    assert.equal(
      (
        await replacement.app.inject({
          method: 'POST',
          url: api('resume'),
          payload: {},
          headers: { Authorization: `Bearer ${token}` },
        })
      ).statusCode,
      200,
    );
    assert.ok(
      replacement.kernel.preview(principal, { agent: 'agent/test', model: 'auto', file_ids: [] })
        .selected,
    );
  } finally {
    stop.abort();
    await joined;
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('a reserved node identity cannot be reassigned to another owner through configuration', async () => {
  const s = await start(async () => ({ value: 'okay' }), true);
  try {
    await s.request('POST', api('revoke'), {});
    await s.outcome;
    await s.app.close();
    const changed = {
      ...s.config,
      nodeKeys: s.config.nodeKeys.map((node) => ({ ...node, owner: 'second' })),
    };
    await assert.rejects(createGateway(changed), /reserved by another owner/);
    const check = new Store(s.config.dataDir);
    assert.equal(
      JSON.parse(
        String(
          check.db.prepare('SELECT payload FROM node_policies WHERE node_id=?').get(nodeId)!
            .payload,
        ),
      ).state,
      'revoked',
    );
    check.close();
  } finally {
    await s.cleanup();
  }
});

test('failed node-policy schema upgrade rolls back the version and gateway lease', async () => {
  const s = await setup();
  try {
    await s.app.close();
    const file = path.join(s.config.dataDir, 'state.sqlite');
    const db = new DatabaseSync(file);
    db.exec(
      'DROP TABLE node_policy_events; DROP TABLE node_policies; CREATE TABLE node_policy_events(wrong_column TEXT); PRAGMA user_version=2',
    );
    db.close();
    assert.throws(() => new Store(s.config.dataDir), /no such column/);
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(check.prepare('SELECT count(*) AS n FROM gateway_owner').get()!.n, 0);
    assert.equal(
      check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='node_policies'").get()!.n,
      0,
    );
    check.close();
  } finally {
    await s.cleanup();
  }
});

test('CLI node lifecycle commands use the authenticated registry and audit', async () => {
  const s = await start(async () => ({ value: 'okay' }));
  try {
    const tokenFile = path.join(s.dir, 'admin.token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    const cli = path.resolve('dist/src/cli.js'),
      common = ['--url', s.url, '--token-file', tokenFile];
    const list = await exec(process.execPath, [cli, 'nodes', ...common]);
    assert.ok(!list.stdout.includes(s.nodeToken));
    const drain = await exec(process.execPath, [
      cli,
      'node',
      'drain',
      nodeId,
      '--reason',
      'fixture maintenance',
      ...common,
    ]);
    assert.equal(JSON.parse(drain.stdout).drained, true);
    await exec(process.execPath, [cli, 'node', 'resume', nodeId, ...common]);
    const revoke = await exec(process.execPath, [cli, 'node', 'revoke', nodeId, ...common]);
    assert.equal(JSON.parse(revoke.stdout).state, 'revoked');
    const audit = await exec(process.execPath, [
      cli,
      'node',
      'history',
      nodeId,
      '--limit',
      '2',
      ...common,
    ]);
    assert.equal(JSON.parse(audit.stdout).data.length, 2);
    assert.ok(JSON.parse(audit.stdout).next_cursor);
    assert.equal(await readFile(tokenFile, 'utf8'), token);
  } finally {
    await s.cleanup();
  }
});
