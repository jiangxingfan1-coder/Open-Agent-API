import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  localModelEndpoint,
  restoreLocalModelProviders,
} from '../src/gateway/local-model-routes.js';
import { setup, secondToken, agent } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { probeProvider } from '../src/providers/provider-status.js';

async function service() {
  let modelList: unknown = { data: [{ id: 'tiny-local' }] };
  let status = 200;
  let calls = 0;
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    if (req.url === '/v1/models') {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(modelList));
    } else if (req.url === '/v1/chat/completions') {
      calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"LOCAL_OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\ndata: [DONE]\n\n',
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base_url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return {
    base_url,
    get calls() {
      return calls;
    },
    get auth() {
      return auth;
    },
    setList: (value: unknown, code = 200) => {
      modelList = value;
      status = code;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test('local model endpoints reject remote, credential, query and non-model paths', () => {
  assert.equal(localModelEndpoint('http://localhost:1234/v1/'), 'http://127.0.0.1:1234/v1');
  assert.equal(localModelEndpoint('http://[::1]:1234/v1'), 'http://[::1]:1234/v1');
  for (const url of [
    'http://example.com/v1',
    'https://127.0.0.1.evil/v1',
    'http://u:p@localhost/v1',
    'http://localhost/v1?token=x',
    'http://localhost/v1#x',
    'file:///v1',
    'http://localhost/admin',
  ])
    assert.throws(() => localModelEndpoint(url));
});

test('model connection probes, publishes, invokes and restores without changing external configuration', async () => {
  const svc = await service();
  const s = await setup();
  try {
    const body = { runtime: 'ollama', base_url: svc.base_url, model: 'tiny-local' };
    const probe = await s.request('POST', '/v1/local/model-runtimes/probe', {
      runtime: body.runtime,
      base_url: body.base_url,
    });
    assert.equal(probe.json().status, 'ready', probe.body);
    assert.equal(svc.calls, 0);
    assert.equal(svc.auth, undefined, 'no synthetic API key is sent to a keyless server');
    const connected = await s.request('POST', '/v1/local/model-runtimes/connect', body);
    assert.equal(connected.statusCode, 200, connected.body);
    assert.equal(connected.json().validation, 'model_list_only');
    const repeat = await s.request('POST', '/v1/local/model-runtimes/connect', body);
    assert.equal(repeat.json().version, connected.json().version);
    assert.equal(svc.calls, 0, 'connecting never generates a prompt');
    const call = await s.request('POST', '/v1/chat/completions', {
      model: connected.json().agent,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(call.statusCode, 200, call.body);
    assert.equal(call.json().choices[0].message.content, 'LOCAL_OK');
    assert.equal(svc.calls, 1);
    assert.equal(s.store.agentDefinition('owner', connected.json().agent).agent.tools.length, 0);
    const clean = gatewaySchema.parse({
      ...s.config,
      localWorker: { ...s.config.localWorker, providers: {} },
    });
    const runtime = new WorkerRuntime(workerSchema.parse(clean.localWorker));
    try {
      restoreLocalModelProviders(s.store, clean, runtime);
      assert.equal(runtime.config.providers['local-ollama']!.baseUrl, svc.base_url);
      assert.equal(clean.localWorker!.providers['local-ollama']!.noApiKey, true);
    } finally {
      await runtime.close();
    }
    const conflict = await s.request('POST', '/v1/local/model-runtimes/connect', {
      ...body,
      base_url: 'http://127.0.0.1:1/v1',
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'provider_conflict');
  } finally {
    await s.cleanup();
    await svc.close();
  }
});

test('probe failures, auth, model changes and scope checks cannot publish a local model', async () => {
  const svc = await service();
  const s = await setup();
  try {
    const body = { runtime: 'lmstudio', base_url: svc.base_url };
    svc.setList({ data: [] });
    assert.equal(
      (await s.request('POST', '/v1/local/model-runtimes/probe', body)).json().status,
      'empty',
    );
    svc.setList({ error: 'private error details' }, 401);
    const unauthorized = await s.request('POST', '/v1/local/model-runtimes/probe', body);
    assert.equal(unauthorized.json().status, 'authentication_required');
    assert.doesNotMatch(unauthorized.body, /private error details/);
    svc.setList({ data: 'malformed' });
    assert.equal(
      (await s.request('POST', '/v1/local/model-runtimes/probe', body)).json().status,
      'unavailable',
    );
    svc.setList({ data: [{ id: 'different' }] });
    const missing = await s.request('POST', '/v1/local/model-runtimes/connect', {
      ...body,
      model: 'tiny-local',
    });
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.json().error.code, 'model_unavailable');
    for (const [token, headers] of [
      [secondToken, {}],
      [undefined, { origin: 'https://other.example' }],
    ] as const) {
      const denied = await s.request(
        'POST',
        '/v1/local/model-runtimes/probe',
        body,
        token,
        headers,
      );
      assert.equal(denied.statusCode, 403, denied.body);
    }
    assert.equal(
      (
        await s.request('POST', '/v1/local/model-runtimes/probe', {
          ...body,
          key_env: 'OAA_TEST_TOKEN',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await s.request('POST', '/v1/local/model-runtimes/probe', {
          ...body,
          key_env: 'OAA_MISSING_LOCAL_MODEL_KEY',
        })
      ).statusCode,
      400,
    );
    assert.equal(s.store.agentIndex('owner', ['*']).length, 0);
    assert.equal(svc.calls, 0);
  } finally {
    await s.cleanup();
    await svc.close();
  }
});

test('provider model-list parsing is bounded, deduplicated and discards invalid identifiers', async () => {
  const svc = await service();
  try {
    const config = workerSchema.parse({
      nodeId: 'test',
      dataDir: '/tmp',
      providers: { local: { kind: 'openai-chat', baseUrl: svc.base_url, noApiKey: true } },
    }).providers.local!;
    svc.setList({
      data: [
        { id: 'one' },
        { id: 'one' },
        null,
        { id: '' },
        { id: '\u0000' },
        { id: 'x'.repeat(201) },
      ],
    });
    const result = await probeProvider(config);
    assert.ok(result.reachable);
    assert.deepEqual(result.models, ['one']);
    svc.setList({ data: [{ id: 'x'.repeat(1_048_576) }] });
    assert.equal((await probeProvider(config)).reachable, false);
  } finally {
    await svc.close();
  }
});

test('publication and provider metadata roll back together when the metadata write fails', async () => {
  const s = await setup();
  try {
    assert.throws(
      () =>
        s.store.publish('owner', makeBundle(agent()), () => {
          s.store
            .prepare('INSERT INTO local_model_providers VALUES(?,?,?)')
            .run('owner', 'rollback', '{}');
          throw new Error('disk write failed');
        }),
      /disk write failed/,
    );
    assert.equal(s.store.agentIndex('owner', ['*']).length, 0);
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM local_model_providers').get()!.n, 0);
  } finally {
    await s.cleanup();
  }
});

test('a local model provider cannot recursively point back to the same gateway', async () => {
  const s = await setup();
  try {
    const base = await s.listen();
    const result = await s.request('POST', '/v1/local/model-runtimes/probe', {
      runtime: 'ollama',
      base_url: `${base}/v1`,
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error.code, 'invalid_request');
  } finally {
    await s.cleanup();
  }
});

test('local model authentication stores only its key reference and concurrent conflicting imports cannot overwrite', async () => {
  const a = await service();
  const b = await service();
  const s = await setup();
  const old = process.env.LOCAL_RUNTIME_TEST_KEY;
  process.env.LOCAL_RUNTIME_TEST_KEY = 'synthetic-provider-test-secret';
  try {
    const missing = await s.request('POST', '/v1/local/model-runtimes/probe', {
      runtime: 'jan',
      base_url: a.base_url,
      key_env: 'LOCAL_RUNTIME_UNSET_TEST_KEY',
    });
    assert.equal(missing.json().status, 'key_missing');
    const probe = await s.request('POST', '/v1/local/model-runtimes/probe', {
      runtime: 'jan',
      base_url: a.base_url,
      key_env: 'LOCAL_RUNTIME_TEST_KEY',
    });
    assert.equal(probe.json().status, 'ready');
    assert.equal(a.auth, 'Bearer synthetic-provider-test-secret');
    const results = await Promise.all(
      [a, b].map((svc) =>
        s.request('POST', '/v1/local/model-runtimes/connect', {
          runtime: 'jan',
          base_url: svc.base_url,
          key_env: 'LOCAL_RUNTIME_TEST_KEY',
          model: 'tiny-local',
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const stored = s.store.prepare('SELECT payload FROM local_model_providers').get()!;
    assert.doesNotMatch(String(stored.payload), /synthetic-provider-test-secret/);
    assert.equal(JSON.parse(String(stored.payload)).apiKeyEnv, 'LOCAL_RUNTIME_TEST_KEY');
    assert.equal(s.store.agentIndex('owner', ['*']).length, 1);
  } finally {
    if (old === undefined) delete process.env.LOCAL_RUNTIME_TEST_KEY;
    else process.env.LOCAL_RUNTIME_TEST_KEY = old;
    await s.cleanup();
    await a.close();
    await b.close();
  }
});
