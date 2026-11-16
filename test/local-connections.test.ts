import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { connectionFixture, dshFixture } from './local-connection-fixture.js';
import { agent, principal, secondToken, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { sha } from '../src/core/util.js';
import { DshClient, type DshOwned, type DshSnapshot } from '../src/config/dsh-client.js';
import { LocalConnections } from '../src/gateway/local-connections.js';
import {
  LocalConnectionState,
  type LocalConnectionRecord,
} from '../src/gateway/local-connection-state.js';
import { connectionSource } from '../src/gateway/local-connection-source.js';
import { visibleAgentsFor } from '../src/gateway/agent-views.js';
import { replaceClientFile, yamlMap } from '../src/config/local-client-files.js';

test('DSH connection previews, scopes its key, is idempotent and preserves existing settings', async () => {
  const s = await connectionFixture();
  try {
    const before = s.auth.list(principal).length;
    const { preview, result } = await s.configure();
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(preview.json().generation_verified, false);
    assert.equal(result.json().status, 'active');
    assert.equal(s.auth.list(principal).length, before + 1);
    const repeated = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(repeated.json().key_id, result.json().key_id);
    assert.equal(s.auth.list(principal).length, before + 1);
    const key = s.auth.list(principal).find((k) => k.id === result.json().key_id)!;
    assert.deepEqual(key.agents, ['agent/test']);
    assert.deepEqual(key.scopes, ['read', 'invoke', 'files']);
    assert.equal(key.localConnectionId, result.json().id);
    const settings = await s.dsh.readSettings();
    assert.deepEqual(settings.appearance, { theme: 'dark' });
    const provider = (
      settings['llm-pi-ai'] as {
        providers: Record<string, { apiKeyEnv: string; models: unknown[]; retryPolicy: unknown }>;
      }
    ).providers[result.json().provider]!;
    assert.equal(provider.models.length, 5);
    assert.deepEqual(provider.retryPolicy, { mode: 'normal', maxRetries: 0 });
    const credentials = await s.dsh.readCredentials();
    assert.equal(credentials.refs.EXISTING_KEY, 'preserve-fixture-secret');
    const caller = credentials.refs[provider.apiKeyEnv]!;
    assert.doesNotMatch(preview.body + result.body + repeated.body, new RegExp(caller));
    assert.doesNotMatch(
      await readFile(
        path.join(s.config.dataDir, 'local-connections', `${result.json().id}.json`),
        'utf8',
      ),
      new RegExp(caller),
    );
    const checked = await s.request('POST', `/v1/local/connections/${result.json().id}/check`, {});
    assert.equal(checked.json().ok, true, checked.body);
    assert.equal(s.driver.calls, 0);
    const reply = await s.request(
      'POST',
      '/v1/chat/completions',
      {
        model: 'agent/test',
        messages: [{ role: 'user', content: 'offline fixture only' }],
        tools: [
          { type: 'function', function: { name: 'client_only', parameters: { type: 'object' } } },
        ],
      },
      caller,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json().choices[0].message.content, 'Fixture response.');
    assert.equal(s.driver.calls, 1);
    assert.equal((await s.request('GET', '/v1/keys', undefined, caller)).statusCode, 403);
    s.store.publish('owner', makeBundle(agent({ id: 'agent/not-granted' })));
    assert.equal(
      (
        await s.request(
          'POST',
          '/v1/chat/completions',
          { model: 'agent/not-granted', messages: [{ role: 'user', content: 'x' }] },
          caller,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      await readFile(path.join(s.dsh.home, 'profiles/desktop/cordis.patch.yml'), 'utf8'),
      s.dsh.profile,
    );
    assert.match(
      await readFile(path.join(s.dsh.home, 'settings.yaml'), 'utf8'),
      /# Retain this comment/,
    );
    if (process.platform !== 'win32')
      assert.equal((await stat(path.join(s.dsh.home, '.credentials.yaml'))).mode & 0o777, 0o600);
    const removed = await s.request('DELETE', `/v1/local/connections/${result.json().id}`);
    assert.equal(removed.json().configuration_removed, true, removed.body);
    assert.equal((await s.request('GET', '/v1/models', undefined, caller)).statusCode, 401);
    assert.equal((await s.dsh.readCredentials()).refs.EXISTING_KEY, 'preserve-fixture-secret');
    assert.deepEqual(await s.dsh.readSettings(), { appearance: { theme: 'dark' } });
  } finally {
    await s.cleanup();
  }
});

test('DSH preview creates no key and refuses changed files without overwriting them', async () => {
  const s = await connectionFixture();
  try {
    const before = s.auth.list(principal).length;
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(s.auth.list(principal).length, before);
    const changed = s.dsh.settings + 'external-change: keep\n';
    await writeFile(path.join(s.dsh.home, 'settings.yaml'), changed);
    const applied = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(applied.statusCode, 409);
    assert.equal(s.auth.list(principal).length, before);
    assert.equal(await readFile(path.join(s.dsh.home, 'settings.yaml'), 'utf8'), changed);
    assert.equal(
      await readFile(path.join(s.dsh.home, '.credentials.yaml'), 'utf8'),
      s.dsh.credentials,
    );
  } finally {
    await s.cleanup();
  }
});

test('disconnect revokes only the dedicated key and preserves an externally changed provider', async () => {
  const s = await connectionFixture();
  try {
    const { result } = await s.configure();
    assert.equal(result.statusCode, 200, result.body);
    const row = result.json();
    const file = path.join(s.dsh.home, 'settings.yaml');
    const data = parse(await readFile(file, 'utf8'));
    data['llm-pi-ai'].providers[row.provider].displayName = 'User edited this';
    await writeFile(file, stringify(data));
    const removed = await s.request('DELETE', `/v1/local/connections/${row.id}`);
    assert.equal(removed.json().key_revoked, true);
    assert.equal(removed.json().configuration_removed, false);
    assert.equal(removed.json().status, 'conflict');
    assert.equal(
      s.auth.list(principal).some((k) => k.id === row.key_id),
      false,
    );
    assert.equal(
      parse(await readFile(file, 'utf8'))['llm-pi-ai'].providers[row.provider].displayName,
      'User edited this',
    );
  } finally {
    await s.cleanup();
  }
});

test('model sync reuses its key; revoked keys can be explicitly repaired', async () => {
  const s = await connectionFixture();
  try {
    const initial = (await s.configure()).result.json();
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          modelPolicy: { mode: 'declared' },
          routes: [{ id: 'second', provider: 'fixture', model: 'second', priority: 1 }],
        }),
      ),
    );
    const sync = (await s.configure('second')).result;
    assert.equal(sync.statusCode, 200, sync.body);
    assert.equal(sync.json().key_id, initial.key_id);
    assert.equal(sync.json().model_count, 5);
    s.auth.revoke(principal, initial.key_id);
    const state = await s.request('GET', '/v1/local/connections');
    assert.equal(state.json().data[0].status, 'key_unavailable');
    const repaired = (await s.configure()).result;
    assert.equal(repaired.statusCode, 200, repaired.body);
    assert.notEqual(repaired.json().key_id, initial.key_id);
    assert.equal(
      s.auth.list(principal).filter((k) => k.localConnectionId === initial.id).length,
      1,
    );
  } finally {
    await s.cleanup();
  }
});

test('local client management rejects remote, forwarded, cross-origin, scoped and foreign callers', async () => {
  const s = await connectionFixture();
  try {
    const key = await s.request('POST', '/v1/keys', {
      name: 'scoped',
      agents: ['agent/test'],
      scopes: ['admin'],
    });
    assert.equal(
      (await s.request('GET', '/v1/local/connections', undefined, key.json().token)).statusCode,
      403,
    );
    assert.equal(
      (await s.request('GET', '/v1/local/connections', undefined, secondToken)).statusCode,
      403,
    );
    const rejectedHeaders: Record<string, string>[] = [
      { 'x-forwarded-for': '127.0.0.1' },
      { origin: 'https://untrusted.invalid' },
    ];
    for (const headers of rejectedHeaders)
      assert.equal(
        (await s.request('GET', '/v1/local/connections', undefined, token, headers)).statusCode,
        403,
      );
    const remote = await s.app.inject({
      method: 'GET',
      url: '/v1/local/connections',
      remoteAddress: '203.0.113.10',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(remote.statusCode, 403);
    const path = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
      path: '/tmp/other',
    });
    assert.equal(path.statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('DSH cannot be wired back into itself through a source or declared delegate', async () => {
  const s = await connectionFixture();
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/dsh', engine: 'dsh', model: 'default' })),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/indirect', delegates: [{ name: 'dsh', agent: 'agent/dsh' }] })),
    );
    for (const id of ['agent/dsh', 'agent/indirect']) {
      const result = await s.request('POST', '/v1/local/connections/preview', { agent: id });
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().error.code, 'local_connection_unavailable');
    }
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
  } finally {
    await s.cleanup();
  }
});

test('invalid YAML, credential permissions, symlinks and existing locks fail closed', async () => {
  const s = await connectionFixture();
  try {
    const creds = path.join(s.dsh.home, '.credentials.yaml');
    await writeFile(creds, 'version: 1\nrefs:\n  SECRET: [private-content-do-not-print\n');
    let result = await s.request('POST', '/v1/local/connections/preview', { agent: 'agent/test' });
    assert.equal(result.statusCode, 400);
    assert.doesNotMatch(result.body, /private-content/);
    await writeFile(creds, s.dsh.credentials, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(creds, 0o644);
      result = await s.request('POST', '/v1/local/connections/preview', { agent: 'agent/test' });
      assert.equal(result.statusCode, 400);
      await chmod(creds, 0o600);
      await unlink(creds);
      await symlink(path.join(s.dsh.home, 'settings.yaml'), creds);
      result = await s.request('POST', '/v1/local/connections/preview', { agent: 'agent/test' });
      assert.equal(result.statusCode, 400);
      await unlink(creds);
      await writeFile(creds, s.dsh.credentials, { mode: 0o600 });
    }
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    await writeFile(`${creds}.lock`, 'another-writer\n');
    result = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(result.statusCode, 409);
    assert.equal(await readFile(`${creds}.lock`, 'utf8'), 'another-writer\n');
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
  } finally {
    await s.cleanup();
  }
});

test('failed writes revoke the new key and roll back only their own client entries', async () => {
  const s = await connectionFixture();
  try {
    class FailedDsh extends DshClient {
      override async install(snapshot: DshSnapshot, owned: DshOwned, token: string) {
        await super.install(snapshot, owned, token);
        throw Error('injected failure after files');
      }
    }
    const manager = new LocalConnections(
      s.auth,
      s.config.dataDir,
      new FailedDsh(s.dsh.home),
      'owner',
      (p, a, m, b) =>
        connectionSource(s.store, s.hub, s.config, p, visibleAgentsFor(s, p), a, m, b),
    );
    const base = `http://127.0.0.1:${(s.app.server.address() as { port: number }).port}/v1`;
    const plan = await manager.preview(principal, 'agent/test', 'auto', base);
    await assert.rejects(manager.apply(principal, plan.plan_id, base), {
      code: 'local_connection_failed',
    });
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
    assert.deepEqual(await s.dsh.readSettings(), { appearance: { theme: 'dark' } });
    assert.deepEqual((await s.dsh.readCredentials()).refs, {
      EXISTING_KEY: 'preserve-fixture-secret',
    });
  } finally {
    await s.cleanup();
  }
});

test('recovery revokes orphan grants and rolls back interrupted installation without secrets in metadata', async () => {
  const s = await connectionFixture();
  try {
    const id = 'a'.repeat(24),
      credentialRef = `OAA_DSH_${id.toUpperCase()}`;
    const key = s.auth.create(
      principal,
      'DSH test',
      ['agent/test'],
      ['read', 'invoke', 'files'],
      undefined,
      'own',
      'workspace',
      undefined,
      id,
    );
    const client = new DshClient(s.dsh.home),
      snapshot = await client.snapshot();
    const record: LocalConnectionRecord = {
      version: 1,
      toolMode: 'managed',
      id,
      owner: 'owner',
      agent: 'agent/test',
      model: 'auto',
      dshHome: snapshot.root,
      baseUrl: 'http://127.0.0.1:8787/v1',
      keyId: String(key.id),
      phase: 'installing',
      sourceRevision: 'fixture',
      createdAt: 1,
      updatedAt: 1,
      owned: {
        providerId: `oaa-${id}`,
        credentialRef,
        tokenHash: sha(String(key.token)),
        createdSettings: false,
        createdCredentials: false,
        provider: {
          api: 'openai-completions',
          apiKeyEnv: credentialRef,
          baseURL: 'http://127.0.0.1:8787/v1',
          displayName: 'Fixture',
          models: [{ id: 'agent/test', name: 'Fixture', input: ['text'] }],
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        },
      },
    };
    await new LocalConnectionState(s.config.dataDir).save(record);
    const doc = yamlMap(snapshot.credentials);
    doc.setIn(['refs', credentialRef], String(key.token));
    await replaceClientFile(snapshot.credentials, doc.toString());
    const orphan = s.auth.create(
      principal,
      'orphan',
      ['agent/test'],
      ['read'],
      undefined,
      'own',
      'workspace',
      undefined,
      'b'.repeat(24),
    );
    const manager = new LocalConnections(s.auth, s.config.dataDir, client, 'owner', () => {
      throw Error('No source lookup during recovery');
    });
    await manager.ready;
    assert.equal(
      s.auth.list(principal).some((k) => k.id === key.id || k.id === orphan.id),
      false,
    );
    assert.equal((await s.dsh.readCredentials()).refs[credentialRef], undefined);
    assert.equal((await new LocalConnectionState(s.config.dataDir).list())[0]?.phase, 'failed');
  } finally {
    await s.cleanup();
  }
});

test('custom DSH stores are not silently replaced', async () => {
  const d = await dshFixture();
  try {
    await writeFile(
      path.join(d.home, 'profiles/desktop/cordis.patch.yml'),
      '- id: credentials\n  config:\n    path: /custom/secrets.yaml\n',
    );
    await assert.rejects(new DshClient(d.home).snapshot(), {
      code: 'local_connection_unavailable',
    });
  } finally {
    await d.cleanup();
  }
});
