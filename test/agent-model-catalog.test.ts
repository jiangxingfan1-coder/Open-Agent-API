import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyModels, parseAcpModels, ModelCatalogCache } from '../src/engines/model-catalog.js';
import path from 'node:path';
import { setup, agent, principal, waitFor } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { workerSchema } from '../src/config/config.js';
import { runAcp } from '../src/engines/acp.js';
import { createGateway } from '../src/gateway/server.js';
import { gatewaySchema } from '../src/config/config.js';
import { discoverAgentModels } from '../src/engines/model-discovery.js';
import { MAX_AGENT_MODELS, modelCatalogSchema } from '../src/core/model-catalog.js';

test('large real-world ACP catalogs are complete and oversized catalogs explicitly report truncation', async () => {
  const session = {
    configOptions: [
      {
        id: 'model',
        type: 'select',
        category: 'model',
        currentValue: 'model-0',
        options: Array.from({ length: 404 }, (_, i) => ({
          value: `model-${i}`,
          name: `Model ${i}`,
        })),
      },
    ],
  };
  assert.equal(parseAcpModels(session).length, 404);
  const all = Array.from({ length: MAX_AGENT_MODELS + 1 }, (_, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
    verification: 'discovered' as const,
  }));
  let fail = false;
  const cache = new ModelCatalogCache(async () => {
    if (fail) throw Error('offline');
    return { source: 'fixture', models: all };
  });
  const catalog = await cache.refresh('large');
  assert.equal(catalog.models.length, MAX_AGENT_MODELS);
  assert.equal(catalog.truncated, true);
  assert.equal(modelCatalogSchema.safeParse(catalog).success, true);
  fail = true;
  assert.equal((await cache.refresh('large', true)).truncated, true);
});

test('Codex RPC server errors do not inherit ACP-specific authentication meanings', async () => {
  const s = await setup();
  try {
    const config = workerSchema.parse({
      nodeId: 'rpc-error',
      dataDir: s.dir,
      native: {
        codex: {
          enabled: true,
          executable: process.execPath,
          args: [path.resolve('test/fixtures/discovery-errors.mjs')],
        },
      },
    });
    const cache = new ModelCatalogCache(() => discoverAgentModels(config, 'codex'));
    const catalog = await cache.refresh('codex');
    assert.equal(catalog.error, 'model_discovery_failed');
    assert.equal(catalog.status, 'unavailable');
  } finally {
    await s.cleanup();
  }
});

test('ACP discovery identifies authentication failure without exposing upstream detail', async () => {
  const s = await setup();
  try {
    const config = workerSchema.parse({
      nodeId: 'auth-check',
      dataDir: s.dir,
      adapters: {
        auth: {
          enabled: true,
          transport: 'acp',
          command: process.execPath,
          args: [path.resolve('test/fixtures/acp-agent.mjs'), 'auth'],
        },
      },
    });
    const cache = new ModelCatalogCache(() => discoverAgentModels(config, 'adapter/auth'));
    const catalog = await cache.refresh('auth');
    assert.equal(catalog.status, 'unavailable');
    assert.equal(catalog.error, 'adapter_auth_required');
    assert.equal(catalog.models.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('native publication accepts a full discovered catalog, with bounded priorities', async () => {
  const s = await setup();
  try {
    const models = Array.from({ length: MAX_AGENT_MODELS }, (_, i) => `model-${i}`);
    const response = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/large-catalog',
      engine: 'codex',
      models,
    });
    assert.equal(response.statusCode, 200, response.body);
    const published = s.store.bundle('owner', 'agent/large-catalog');
    assert.equal(published.agent.routes.length, MAX_AGENT_MODELS);
    assert.ok(published.agent.routes.every((r) => r.priority <= 100));
    const tooMany = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/too-large',
      engine: 'codex',
      models: [...models, 'overflow'],
    });
    assert.equal(tooMany.statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('model discovery parses real CLI ids without inventing suggestions or availability', () => {
  const models = parseAgyModels(
    'Fetching available models...\nactual-model\tActual Model\nother\tOther\nactual-model\tDuplicate\n',
  );
  assert.deepEqual(
    models.map((m) => m.id),
    ['actual-model', 'other'],
  );
  assert.equal(models[0]?.name, 'Actual Model');
  assert.equal(models[0]?.verification, 'discovered');
  assert.deepEqual(parseAgyModels('Authentication required\n'), []);
});

test('first-run publication guard cannot replace an existing agent definition', async () => {
  const s = await setup();
  try {
    const original = makeBundle(agent({ instructions: 'Preserve user instructions.' }));
    s.store.publish('owner', original);
    const replacement = makeBundle(agent({ instructions: 'Seed defaults.' }));
    const response = await s.request('POST', '/v1/agents/publish', replacement, undefined, {
      'if-none-match': '*',
    });
    assert.equal(response.statusCode, 409);
    assert.equal(s.store.bundle('owner', original.agent.id).digest, original.digest);
  } finally {
    await s.cleanup();
  }
});

test('create-only publication rechecks after asynchronous model discovery', async () => {
  const s = await setup();
  let release!: () => void;
  let discovering = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    s.runtime.modelCatalogs.refresh = async () => {
      discovering = true;
      await barrier;
      return { status: 'unsupported', source: 'fixture', models: [], checkedAt: 0, expiresAt: 0 };
    };
    const original = makeBundle(agent({ id: 'agent/race', instructions: 'User publication.' }));
    const seed = makeBundle(agent({ id: 'agent/race', modelPolicy: { mode: 'discover' } }));
    const pending = s.request('POST', '/v1/agents/publish', seed, undefined, {
      'if-none-match': '*',
    });
    await waitFor(() => discovering);
    s.store.publish('owner', original);
    release();
    assert.equal((await pending).statusCode, 409);
    assert.equal(s.store.bundle('owner', 'agent/race').digest, original.digest);
  } finally {
    release();
    await s.cleanup();
  }
});

test('discovered models reach standard client lists and execute without rewriting the bundle', async () => {
  const s = await setup();
  try {
    const native = {
      enabled: true,
      executable: process.execPath,
      args: [path.resolve('test/fixtures/model-catalog.mjs')],
    };
    s.runtime.config.native.antigravity = native;
    s.config.localWorker!.native.antigravity = native;
    const catalog = await s.request('GET', '/v1/local/backends/antigravity/models');
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.equal(catalog.json().models.length, 2);
    const bundle = makeBundle(
      agent({
        id: 'agent/catalog',
        engine: 'antigravity',
        model: 'default',
        provider: 'native',
        modelPolicy: { mode: 'discover' },
      }),
    );
    s.store.publish('owner', bundle);
    const list = await s.request('GET', '/v1/models');
    assert.ok(
      list.json().data.some((m: { id: string }) => m.id === 'agent/catalog@discovered-one'),
    );
    const claude = await s.request('GET', '/v1/models', undefined, undefined, {
      'anthropic-version': '2023-06-01',
    });
    assert.ok(
      claude.json().data.some((m: { id: string }) => m.id === 'agent/catalog@discovered-one'),
    );
    const gemini = await s.request('GET', '/v1beta/models');
    assert.ok(
      gemini
        .json()
        .models.some((m: { name: string }) => m.name === 'models/agent/catalog@discovered-one'),
    );
    const detail = await s.request('GET', '/v1/models/agent%2Fcatalog%40discovered-one');
    assert.equal(detail.statusCode, 200, detail.body);
    const run = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: 'agent/catalog',
      model: 'discovered-one',
      input: 'fixture only',
      file_ids: [],
      metadata: {},
      stream: false,
      background: false,
    });
    const completed = await s.kernel.wait(run.id);
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
    assert.equal(s.store.bundle('owner', bundle.agent.id).digest, bundle.digest);
  } finally {
    await s.cleanup();
  }
});

test('a discovered model beyond 256 entries can be invoked through the standard Chat API', async () => {
  const s = await setup();
  try {
    const native = {
      enabled: true,
      executable: process.execPath,
      args: [path.resolve('test/fixtures/model-catalog.mjs'), 'many'],
    };
    s.runtime.config.native.antigravity = native;
    s.config.localWorker!.native.antigravity = native;
    const catalog = await s.request('GET', '/v1/local/backends/antigravity/models');
    assert.equal(catalog.json().models.length, 404);
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/large',
          engine: 'antigravity',
          provider: 'native',
          model: 'default',
          modelPolicy: { mode: 'discover' },
        }),
      ),
    );
    const detail = await s.request('GET', '/v1/models/agent%2Flarge%40catalog-403');
    assert.equal(detail.statusCode, 200, detail.body);
    const response = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/large@catalog-403',
      messages: [{ role: 'user', content: 'fixture only' }],
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].message.content, 'discovered model executed');
  } finally {
    await s.cleanup();
  }
});

test('ACP model discovery supports current grouped configuration and legacy lists', () => {
  assert.deepEqual(
    parseAcpModels({
      configOptions: [
        {
          id: 'model',
          type: 'select',
          category: 'model',
          currentValue: 'b',
          options: [
            {
              group: 'Family',
              options: [
                { value: 'a', name: 'A' },
                { value: 'b', name: 'B' },
              ],
            },
          ],
        },
      ],
    }).map((m) => [m.id, m.isDefault]),
    [
      ['a', false],
      ['b', true],
    ],
  );
  assert.deepEqual(
    parseAcpModels({
      models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'A' }] },
    }).map((m) => m.id),
    ['a'],
  );
});

test('catalog cache coalesces refresh, retains stale truth on failure and invalidates changed identities', async () => {
  let now = 100;
  let calls = 0;
  let fail = false;
  const cache = new ModelCatalogCache(
    async () => {
      calls++;
      if (fail) throw new Error('private upstream error');
      return { source: 'agent-cli', models: parseAgyModels('a\tModel A\n') };
    },
    { now: () => now, ttlMs: 50 },
  );
  const results = await Promise.all([cache.refresh('one'), cache.refresh('one')]);
  assert.equal(calls, 1);
  assert.equal(results[0]?.status, 'ready');
  await cache.refresh('one');
  assert.equal(calls, 1);
  now = 151;
  fail = true;
  const stale = await cache.refresh('one');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.models[0]?.id, 'a');
  assert.equal(JSON.stringify(stale).includes('private upstream error'), false);
  const changed = await cache.refresh('two');
  assert.equal(changed.models.length, 0);
  assert.equal(changed.status, 'unavailable');
});

test('ACP concrete variants remain selectable when config options expose only model families', async () => {
  const s = await setup();
  try {
    const config = workerSchema.parse({
      nodeId: 'dual',
      dataDir: s.dir,
      adapters: {
        dual: {
          transport: 'acp',
          enabled: true,
          command: process.execPath,
          args: [path.resolve('test/fixtures/acp-dual-models.mjs')],
        },
      },
    });
    const result = await runAcp(
      agent({ engine: 'adapter/dual', model: 'family-low' }),
      config,
      s.dir,
      'metadata fixture only',
      new AbortController().signal,
      async () => {},
    );
    assert.equal(result.text, 'Selected family-low');
    const list = parseAcpModels({
      models: {
        currentModelId: 'family-low',
        availableModels: [{ modelId: 'family-low', name: 'Family Low' }],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'family',
          options: [{ value: 'family', name: 'Family' }],
        },
      ],
    });
    assert.deepEqual(
      list.map((m) => m.id),
      ['family-low'],
    );
  } finally {
    await s.cleanup();
  }
});

test('normal gateway startup exposes model discovery without an injected executor', async () => {
  const s = await setup();
  let app: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    const config = gatewaySchema.parse({
      ...s.config,
      dataDir: path.join(s.dir, 'standard-gateway'),
      localWorker: {
        ...s.config.localWorker,
        dataDir: path.join(s.dir, 'standard-worker'),
        native: {
          antigravity: {
            enabled: true,
            executable: process.execPath,
            args: [path.resolve('test/fixtures/model-catalog.mjs')],
          },
        },
      },
    });
    app = await createGateway(config);
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/local/backends/antigravity/models',
      headers: { authorization: `Bearer ${process.env.OAA_TEST_TOKEN}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().models.length, 2);
  } finally {
    await app?.app.close();
    await s.cleanup();
  }
});
