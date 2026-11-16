import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { compileOaaLang, decompileToOaaLang } from '../src/lang/lang.js';
import { setup, agent, FixtureModel, principal } from './helpers.js';
import { checkAccessPolicy } from '../src/kernel/access-policy.js';

test('connection defaults are persisted preferences, not a fixed-model restriction', async () => {
  const seen: string[] = [];
  const s = await setup(
    new FixtureModel((a) => {
      seen.push(a.model);
      return { text: a.model };
    }),
  );
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          routes: [
            { id: 'one', provider: 'fixture', model: 'one', priority: 0 },
            { id: 'two', provider: 'fixture', model: 'two', priority: 1 },
          ],
        }),
      ),
    );
    const created = await s.request('POST', '/v1/keys', {
      name: 'connection',
      agents: ['agent/test'],
      scopes: ['invoke', 'read'],
      connection: { toolMode: 'managed', models: { 'agent/test': 'two' } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const token = created.json().token;
    for (const model of ['agent/test', 'agent/test@one', 'agent/test@auto']) {
      const response = await s.request(
        'POST',
        '/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [
            { type: 'function', function: { name: 'client_tool', parameters: { type: 'object' } } },
          ],
        },
        token,
      );
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['x-oaa-client-tools'], 'ignored');
    }
    assert.deepEqual(seen, ['two', 'one', 'one']);
  } finally {
    await s.cleanup();
  }
});

test('client-only mode exposes only caller tools and cannot execute a server tool', async () => {
  let tools: string[] = [];
  const s = await setup(
    new FixtureModel((a, messages) => {
      tools = a.tools.map((t) => t.name);
      if (!messages.some((m) => m.role === 'tool'))
        return {
          calls: [
            {
              id: 'forbidden',
              name: 'write_file',
              arguments: { path: 'forbidden.txt', content: 'no' },
            },
          ],
        };
      return { text: 'The server write was refused.' };
    }),
  );
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [builtin('write_file')],
          access: { modes: ['client'], defaultMode: 'client', approval: 'auto', trust: 'private' },
        }),
      ),
    );
    const result = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'Try a server tool.' }],
      tools: [
        { type: 'function', function: { name: 'client_tool', parameters: { type: 'object' } } },
      ],
    });
    assert.equal(result.statusCode, 422, result.body);
    assert.equal(result.json().error.code, 'tool_denied');
    assert.deepEqual(tools, ['client_tool']);
    const runId = result.json().error.run_id;
    assert.equal(s.store.run(runId).artifactIds.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('publication permission ceilings cannot be widened by a caller', () => {
  const a = agent({
    access: { modes: ['managed'], defaultMode: 'managed', approval: 'owner', trust: 'private' },
  });
  assert.throws(() => checkAccessPolicy(a, principal, { 'oaa.tool_boundary': 'hybrid' }), {
    code: 'scope_denied',
  });
  assert.throws(() => checkAccessPolicy(a, { ...principal, accountId: 'external' }, {}), {
    code: 'isolation_required',
  });
  assert.throws(() => checkAccessPolicy(a, { ...principal, externalCaller: true }, {}), {
    code: 'isolation_required',
  });
  assert.throws(
    () =>
      checkAccessPolicy(
        agent(),
        { ...principal, connection: { allowedModes: ['client'] } },
        { 'oaa.tool_boundary': 'managed' },
      ),
    { code: 'scope_denied' },
  );
  const external = agent({ engine: 'antigravity' });
  assert.throws(() => checkAccessPolicy(external, principal, { 'oaa.tool_boundary': 'client' }), {
    code: 'client_tools_bridge_unsupported',
  });
});

test('new runtime policies and evidence-based route ratings survive OAA-Lang export', () => {
  const a = agent({
    model: 'one',
    routes: [{ id: 'one', provider: 'fixture', model: 'one', qualityTier: 5 }],
    modelPolicy: { mode: 'discover', allow: ['one'] },
    access: { modes: ['managed'], defaultMode: 'managed', approval: 'owner', trust: 'private' },
    orchestration: { enabled: true, helpers: [] },
  });
  assert.deepEqual(compileOaaLang(decompileToOaaLang(a)).agent, a);
});

test('new publications change explicit models with portable context while legacy pinning stays separate', async () => {
  const s = await setup(
    new FixtureModel((a, messages) => ({
      text: `${a.model}: ${messages.map((m) => m.content).join(' ')}`,
    })),
  );
  try {
    const a = agent({
      model: 'one',
      modelPolicy: { mode: 'declared' },
      routes: [
        { id: 'one', provider: 'fixture', model: 'one' },
        { id: 'two', provider: 'fixture', model: 'two' },
      ],
    });
    s.store.publish('owner', makeBundle(a));
    const first = await s.request('POST', '/v1/responses', {
      model: 'agent/test@one',
      input: 'Remember ALPHA.',
    });
    const next = await s.request('POST', '/v1/responses', {
      model: 'agent/test@two',
      input: 'Continue.',
      previous_response_id: first.json().id,
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.match(JSON.stringify(next.json().output), /ALPHA/);
    assert.equal(s.store.run(next.json().id).route.model, 'two');
  } finally {
    await s.cleanup();
  }
});
