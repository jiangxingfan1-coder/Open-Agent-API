import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionFixture } from './local-connection-fixture.js';
import { agent, FixtureModel, principal } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';

for (const mode of ['client', 'hybrid'] as const) {
  test(`DSH ${mode} connections bridge caller tools and continue without OAA-specific headers`, async () => {
    const seen: string[][] = [];
    const s = await connectionFixture(
      new FixtureModel((a, messages) => {
        seen.push(a.tools.map((t) => t.name));
        return messages.some((m) => m.role === 'tool')
          ? { text: 'Client result received.' }
          : {
              calls: [{ id: 'dsh-call', name: 'dsh_edit', arguments: { path: 'fixture.txt' } }],
            };
      }),
    );
    try {
      s.store.publish(
        'owner',
        makeBundle(
          agent({
            tools: [builtin('list_files')],
            access: { modes: [mode], defaultMode: mode, approval: 'auto', trust: 'private' },
          }),
        ),
      );
      const sources = (await s.request('GET', '/v1/local/connections')).json().sources;
      assert.equal(sources[0].default_tool_mode, mode);
      const { preview, result } = await s.configure();
      assert.equal(preview.json().tool_mode, mode);
      assert.equal(preview.json().execution, 'host');
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().tool_mode, mode);
      const credentials = await s.dsh.readCredentials();
      const caller = credentials.refs[`OAA_DSH_${result.json().id.toUpperCase()}`]!;
      const tools = [
        { type: 'function', function: { name: 'dsh_edit', parameters: { type: 'object' } } },
      ];
      const messages = [{ role: 'user', content: 'Offline synthetic tool fixture.' }];
      const reply = await s.request(
        'POST',
        '/v1/chat/completions',
        { model: 'agent/test', messages, tools },
        caller,
      );
      assert.equal(reply.statusCode, 200, reply.body);
      assert.equal(reply.headers['x-oaa-client-tools'], 'bridge');
      const call = reply.json().choices[0].message.tool_calls[0];
      assert.equal(call.function.name, 'dsh_edit');
      assert.equal(seen[0]!.includes('dsh_edit'), true);
      assert.equal(seen[0]!.includes('list_files'), mode === 'hybrid');
      const continued = await s.request(
        'POST',
        '/v1/chat/completions',
        {
          model: 'agent/test',
          tools,
          messages: [
            ...messages,
            { role: 'assistant', content: null, tool_calls: [call] },
            { role: 'tool', tool_call_id: call.id, content: 'synthetic result' },
          ],
        },
        caller,
      );
      assert.equal(continued.statusCode, 200, continued.body);
      assert.equal(continued.json().choices[0].message.content, 'Client result received.');
      assert.equal(s.driver.calls, 2);
    } finally {
      await s.cleanup();
    }
  });
}

test('DSH rejects unsupported tool modes and requires explicit key repair when changing the grant', async () => {
  const s = await connectionFixture();
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          access: {
            modes: ['managed'],
            defaultMode: 'managed',
            approval: 'auto',
            trust: 'private',
          },
        }),
      ),
    );
    const before = s.auth.list(principal).length;
    const refused = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
      tool_mode: 'client',
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(s.auth.list(principal).length, before);
    const initial = (await s.configure()).result.json();
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          access: {
            modes: ['managed', 'client', 'hybrid'],
            defaultMode: 'hybrid',
            approval: 'auto',
            trust: 'private',
          },
        }),
      ),
    );
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
      tool_mode: 'client',
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().action, 'repair');
    assert.equal(preview.json().tool_mode, 'client');
    const result = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.notEqual(result.json().key_id, initial.key_id);
    assert.equal(result.json().tool_mode, 'client');
    assert.equal(
      s.auth.list(principal).some((k) => k.id === initial.key_id),
      false,
    );
    const caller = (await s.dsh.readCredentials()).refs[
      `OAA_DSH_${result.json().id.toUpperCase()}`
    ]!;
    assert.deepEqual(s.auth.revalidate(`Bearer ${caller}`).connection?.allowedModes, ['client']);
    assert.equal((await s.request('GET', '/v1/local/connections')).json().data[0].status, 'active');
  } finally {
    await s.cleanup();
  }
});

test('DSH preserves exact publication modes and refuses unsupported isolation before minting', async () => {
  const s = await connectionFixture();
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          access: { modes: ['hybrid'], defaultMode: 'hybrid', approval: 'auto', trust: 'private' },
        }),
      ),
    );
    const before = s.auth.list(principal).length;
    const modes = (await s.request('GET', '/v1/local/connections')).json().sources[0].tool_modes;
    assert.deepEqual(modes, ['hybrid']);
    const refused = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
      tool_mode: 'client',
    });
    assert.equal(refused.statusCode, 409);
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [{ ...builtin('list_files'), handler: { kind: 'node', reference: 'notes' } }],
          access: {
            modes: ['managed'],
            defaultMode: 'managed',
            approval: 'auto',
            trust: 'isolated',
          },
        }),
      ),
    );
    const isolated = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    assert.equal(isolated.statusCode, 409, isolated.body);
    assert.equal(s.auth.list(principal).length, before);
  } finally {
    await s.cleanup();
  }
});
