import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeBundle } from '../src/lang/bundle.js';
import {
  executionCapabilitiesSchema,
  type AgentDefinition,
  type ModelMessage,
} from '../src/core/contracts.js';
import { workerSchema } from '../src/config/config.js';
import type { ModelDriver } from '../src/providers/models.js';
import { advertisedExecution } from '../src/fabric/network.js';
import { modelPlacement } from '../src/fabric/placement.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { faultOf } from '../src/core/util.js';
import { FixtureModel, agent, setup, waitFor } from './helpers.js';

// P1 BYOK: a caller's own provider key reaches the model call through memory only, never falls
// back to the publisher's key, and never lands in SQLite, files, events or responses. No sockets:
// the "provider" is an injected driver that records which key each call used.

const CALLER_KEY = 'sk-caller-BYOK-0123456789-unique-marker';

/** An injected provider that accepts caller keys and records them (`null` = the node's own key). */
class KeyedModel extends FixtureModel implements ModelDriver {
  keys: (string | null)[] = [];
  override async call(...args: Parameters<FixtureModel['call']>) {
    this.keys.push(null);
    return super.call(...args);
  }
  withApiKey(apiKey: string): ModelDriver {
    return {
      call: async (...args: Parameters<FixtureModel['call']>) => {
        this.keys.push(apiKey);
        return super.call(...args);
      },
    };
  }
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if ((await readFile(full)).includes(needle)) hits.push(full);
    }
  };
  await walk(root);
  return hits;
}

test('a caller key is used for the run’s model calls and never persisted', async () => {
  const toolTurns = (m: ModelMessage[]) => m.filter((x) => x.role === 'tool').length;
  const driver = new KeyedModel((def, messages) =>
    def.id === 'agent/parent' && toolTurns(messages) === 0
      ? { calls: [{ id: 'd1', name: 'ask_child', arguments: { task: 'help' } }] }
      : { text: 'done' },
  );
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/parent', delegates: [{ name: 'ask_child', agent: 'agent/test' }] }),
      ),
    );
    const byok = { 'x-oaa-provider-key': CALLER_KEY };

    const r = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'hi' },
      undefined,
      byok,
    );
    assert.equal(r.json().status, 'completed', r.body);
    assert.deepEqual(driver.keys, [CALLER_KEY]);
    assert.equal(s.kernel.holdsProviderKey(r.json().id), false, 'dropped once the run finished');
    assert.ok(!r.body.includes(CALLER_KEY));

    // Without the header the node's own configuration is used, as before.
    const plain = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    assert.equal(plain.json().status, 'completed');
    assert.deepEqual(driver.keys, [CALLER_KEY, null]);

    // Kernel delegates are funded by the same caller key.
    driver.keys = [];
    const parent = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/parent', input: 'delegate' },
      undefined,
      byok,
    );
    assert.equal(parent.json().status, 'completed', parent.body);
    assert.ok(driver.keys.length >= 3, `parent, child and parent again: ${driver.keys.length}`);
    assert.ok(
      driver.keys.every((k) => k === CALLER_KEY),
      JSON.stringify(driver.keys),
    );

    // Rejections happen before any model call.
    const before = driver.keys.length;
    const native = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/native', input: 'x' },
      undefined,
      byok,
    );
    assert.equal(native.statusCode, 400, native.body);
    assert.equal(native.json().error.code, 'byok_not_supported');
    const malformed = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'x' },
      undefined,
      {
        'x-oaa-provider-key': 'has a space',
      },
    );
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'invalid_provider_key');
    assert.equal(driver.keys.length, before);

    // The key never reached SQLite (including the WAL), bundles, workspaces or any other file.
    assert.deepEqual(await filesContaining(s.dir, CALLER_KEY), []);
    for (const url of [
      `/v1/runs/${parent.json().id}`,
      `/v1/runs/${parent.json().id}/steps`,
      '/v1/runs',
    ]) {
      assert.ok(!(await s.request('GET', url)).body.includes(CALLER_KEY), url);
    }
  } finally {
    await s.cleanup();
  }
});

test('no node accepting caller keys means no execution, never the publisher’s key', async () => {
  const driver = new FixtureModel(); // injected driver without withApiKey: BYOK unsupported
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const headers = { 'x-oaa-provider-key': CALLER_KEY };
    const r = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'x' },
      undefined,
      headers,
    );
    assert.equal(r.statusCode, 503, r.body);
    assert.equal(r.json().error.code, 'model_unavailable');
    assert.equal(driver.calls, 0);
    const preview = await s.request(
      'POST',
      '/v1/agents/preview',
      { agent: 'agent/test', model: 'auto' },
      undefined,
      headers,
    );
    assert.ok(preview.body.includes('byok_unsupported'), preview.body);
    // Same agent without a caller key still works with the node's own provider.
    assert.equal(
      (await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'x' })).json().status,
      'completed',
    );
  } finally {
    await s.cleanup();
  }
});

test('after a gateway restart a BYOK run resumes only when the caller supplies the key again', async () => {
  // Blocks until shutdown aborts the call, like a long upstream request cut off by a restart.
  const blocked = new KeyedModel(
    (_agent, _messages, signal) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const s = await setup(blocked);
  let second: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const started = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'long', background: true },
      undefined,
      { 'x-oaa-provider-key': CALLER_KEY },
    );
    const id = started.json().id as string;
    await waitFor(() => blocked.keys.length === 1);
    await s.app.close();
    assert.equal(s.kernel.holdsProviderKey(id), false, 'a closed gateway keeps no caller key');

    const fresh = new KeyedModel();
    second = await createGateway(
      s.config,
      new WorkerRuntime(s.runtime.config, new Map(), new Map([['fixture', fresh]])),
    );
    await second.app.ready();
    const call = (url: string, headers: Record<string, string> = {}) =>
      second!.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${process.env.OAA_TEST_TOKEN}`, ...headers },
      });
    assert.equal(second.store.run(id).status, 'interrupted');
    const refused = await call(`/v1/runs/${id}/resume`);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error.code, 'byok_key_required');
    assert.equal(fresh.keys.length, 0, 'never resumed with the node’s own key');

    const resumed = await call(`/v1/runs/${id}/resume`, { 'x-oaa-provider-key': CALLER_KEY });
    assert.equal(resumed.statusCode, 200, resumed.body);
    const final = await second.kernel.wait(id);
    assert.equal(final.status, 'completed', JSON.stringify(final.error));
    assert.deepEqual(fresh.keys, [CALLER_KEY]);
    assert.deepEqual(await filesContaining(s.dir, CALLER_KEY), []);
  } finally {
    await second?.app.close();
    await rm(s.dir, { recursive: true, force: true });
  }
});

test('workers advertise BYOK only for opted-in providers and never substitute their own key', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-byok-worker-'));
  const config = workerSchema.parse({
    nodeId: 'w',
    dataDir,
    providers: {
      open: {
        kind: 'openai-chat',
        baseUrl: 'https://provider.example/v1',
        apiKeyEnv: 'OAA_UNSET_KEY_A',
        byok: true,
      },
      closed: {
        kind: 'openai-chat',
        baseUrl: 'https://provider.example/v1',
        apiKeyEnv: 'OAA_UNSET_KEY_B',
      },
    },
  });
  const runtime = new WorkerRuntime(
    config,
    new Map(),
    new Map([
      ['keyed', new KeyedModel()],
      ['plain', new FixtureModel()],
    ]),
  );
  const advert = runtime.advertisement();
  assert.deepEqual(new Set(advert.execution?.byokProviders), new Set(['open', 'keyed']));
  assert.ok(
    !advert.providers.includes('open'),
    'a BYOK-only provider is not offered without a caller key',
  );

  // Placement: a BYOK call needs byokProviders; having the node's own key is not enough.
  const node = {
    credential: { nodeId: 'w', owner: 'o', token: 't', capabilities: ['*'], agents: ['*'] },
    advertisement: { ...advert, providers: [...advert.providers, 'closed'] },
  };
  const request = (provider: string, byok: boolean) => ({
    owner: 'o',
    agent: agent({ provider }) as AgentDefinition,
    files: [],
    byok,
  });
  assert.deepEqual(modelPlacement(request('open', true), node), []);
  assert.deepEqual(modelPlacement(request('closed', false), node), []);
  assert.deepEqual(
    modelPlacement(request('closed', true), node).map((r) => r.code),
    ['byok_unsupported'],
  );

  // Execution: a caller key for a provider that did not opt in is refused, not swapped.
  const bundle = makeBundle(agent({ id: 'agent/closed', provider: 'plain' }));
  await runtime.install(bundle);
  await assert.rejects(
    () =>
      runtime.execute(
        {
          kind: 'model',
          agent: bundle.agent,
          messages: [{ role: 'user', content: 'x' }],
          context: { runId: 'r', sessionId: 's', owner: 'owner', digest: bundle.digest, files: [] },
          credential: { apiKey: CALLER_KEY },
        },
        new AbortController().signal,
        async () => {},
      ),
    (e) => faultOf(e).code === 'byok_not_supported' && !String(e).includes(CALLER_KEY),
  );
  await runtime.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('BYOK metadata is sent to a gateway only after byok-v1 negotiation', () => {
  const execution = executionCapabilitiesSchema.parse({
    builtins: [],
    scripts: [],
    toolSelection: true,
    nativeModels: {},
    byokProviders: ['open'],
  });
  const legacy = advertisedExecution(execution, { byok: false, sandbox: false })!;
  assert.equal('byokProviders' in legacy, false);
  // What an older gateway receives is accepted by the pre-BYOK schema shape.
  assert.deepEqual(Object.keys(legacy).sort(), [
    'builtins',
    'nativeModels',
    'scripts',
    'toolSelection',
  ]);
  assert.deepEqual(advertisedExecution(execution, { byok: true, sandbox: false })?.byokProviders, [
    'open',
  ]);
});

test('the idempotency fingerprint tells BYOK and non-BYOK requests apart without storing the key', async () => {
  const driver = new KeyedModel();
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const body = { model: 'agent/test', input: 'hi' };
    const idem = (k: string) => ({ 'idempotency-key': k });
    const withKey = await s.request('POST', '/v1/responses', body, undefined, {
      ...idem('same'),
      'x-oaa-provider-key': CALLER_KEY,
    });
    assert.equal(withKey.statusCode, 200, withKey.body);
    const without = await s.request('POST', '/v1/responses', body, undefined, idem('same'));
    assert.equal(without.statusCode, 409);
    assert.equal(without.json().error.code, 'idempotency_conflict');
    const otherKey = await s.request('POST', '/v1/responses', body, undefined, {
      ...idem('same'),
      'x-oaa-provider-key': `${CALLER_KEY}-other`,
    });
    assert.equal(otherKey.statusCode, 409, 'a different provider key is a different request');
    const replay = await s.request('POST', '/v1/responses', body, undefined, {
      ...idem('same'),
      'x-oaa-provider-key': CALLER_KEY,
    });
    assert.equal(replay.json().id, withKey.json().id, 'the same key replays the run');
    assert.deepEqual(driver.keys, [CALLER_KEY], 'the replay made no model call');
    // Without BYOK the fingerprint is unchanged: a plain key still replays its own run.
    const plain = await s.request('POST', '/v1/responses', body, undefined, idem('plain'));
    const plainAgain = await s.request('POST', '/v1/responses', body, undefined, idem('plain'));
    assert.equal(plainAgain.json().id, plain.json().id);
    await s.app.close();
    assert.deepEqual(await filesContaining(s.dir, CALLER_KEY), [], 'the key never reaches disk');
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});
