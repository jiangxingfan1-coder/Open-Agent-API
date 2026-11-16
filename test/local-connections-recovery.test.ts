import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { stringify } from 'yaml';
import { connectionFixture, dshFixture } from './local-connection-fixture.js';
import { agent, principal, waitFor } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { canonical, sha } from '../src/core/util.js';
import { DshClient } from '../src/config/dsh-client.js';
import { Auth } from '../src/gateway/auth.js';
import { LocalConnections } from '../src/gateway/local-connections.js';
import { LocalConnectionState } from '../src/gateway/local-connection-state.js';
import { checkLocalModel } from '../src/gateway/local-connection-check.js';

test('concurrent application of one preview creates only one dedicated grant', async () => {
  const s = await connectionFixture();
  try {
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    const body = { plan_id: preview.json().plan_id };
    const responses = await Promise.all([
      s.request('POST', '/v1/local/connections/apply', body),
      s.request('POST', '/v1/local/connections/apply', body),
    ]);
    assert.ok(responses.every((r) => r.statusCode === 200));
    assert.equal(responses[0]!.json().key_id, responses[1]!.json().key_id);
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 1);
  } finally {
    await s.cleanup();
  }
});

test('publication changes and a different administrator invalidate an existing preview', async () => {
  const s = await connectionFixture();
  try {
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    const admin = s.auth.create(principal, 'other admin', ['*'], ['admin']);
    const denied = await s.request(
      'POST',
      '/v1/local/connections/apply',
      { plan_id: preview.json().plan_id },
      String(admin.token),
    );
    assert.equal(denied.statusCode, 409);
    s.store.publish(
      'owner',
      makeBundle(
        agent({ instructions: 'New publisher policy.', modelPolicy: { mode: 'declared' } }),
      ),
    );
    const stale = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
  } finally {
    await s.cleanup();
  }
});

test('an existing provider collision is not adopted or overwritten', async () => {
  const s = await connectionFixture();
  try {
    const id = sha(canonical(['owner', await realpath(s.dsh.home), 'agent/test'])).slice(0, 24);
    const text = stringify({
      'llm-pi-ai': { providers: { [`oaa-${id}`]: { displayName: 'Externally owned' } } },
    });
    await writeFile(path.join(s.dsh.home, 'settings.yaml'), text);
    const result = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    assert.equal(result.statusCode, 409);
    assert.equal(await readFile(path.join(s.dsh.home, 'settings.yaml'), 'utf8'), text);
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
  } finally {
    await s.cleanup();
  }
});

test('files created solely for a connection disappear on clean rollback', async () => {
  const s = await connectionFixture();
  try {
    await unlink(path.join(s.dsh.home, 'settings.yaml'));
    await unlink(path.join(s.dsh.home, '.credentials.yaml'));
    const result = (await s.configure()).result;
    assert.equal(result.statusCode, 200, result.body);
    const backup = new LocalConnectionState(s.config.dataDir).backupDirectory(result.json().id);
    const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files['settings.yaml'], null);
    assert.equal(manifest.files['credentials.yaml'], null);
    assert.equal((await s.configure('fast')).result.statusCode, 200);
    await assert.rejects(stat(path.join(backup, 'settings.yaml')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(backup, 'credentials.yaml')), { code: 'ENOENT' });
    const removed = await s.request('DELETE', `/v1/local/connections/${result.json().id}`);
    assert.equal(removed.json().configuration_removed, true);
    await assert.rejects(stat(path.join(s.dsh.home, 'settings.yaml')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(s.dsh.home, '.credentials.yaml')), { code: 'ENOENT' });
    assert.equal(
      await readFile(path.join(s.dsh.home, 'profiles/desktop/cordis.patch.yml'), 'utf8'),
      s.dsh.profile,
    );
  } finally {
    await s.cleanup();
  }
});

test('recovery finalizes a committed installation rather than revoking its usable key', async () => {
  const s = await connectionFixture();
  try {
    const created = (await s.configure()).result.json();
    const state = new LocalConnectionState(s.config.dataDir);
    const row = (await state.list()).find((r) => r.id === created.id)!;
    row.phase = 'installing';
    await state.save(row);
    const auth = new Auth(s.store);
    await auth.load(s.config);
    const manager = new LocalConnections(
      auth,
      s.config.dataDir,
      new DshClient(s.dsh.home),
      'owner',
      () => {
        throw Error('No source check during recovery');
      },
    );
    await manager.ready;
    const token = (await s.dsh.readCredentials()).refs[row.owned.credentialRef]!;
    assert.equal(auth.revalidate(`Bearer ${token}`).keyId, row.keyId);
    assert.equal((await state.list())[0]?.phase, 'active');
  } finally {
    await s.cleanup();
  }
});

test(
  'known DSH-home symlinks resolve without permitting symlinked credential files',
  { skip: process.platform === 'win32' },
  async () => {
    const d = await dshFixture(),
      link = d.home + '-alias';
    try {
      await symlink(d.home, link);
      assert.equal((await new DshClient(link).snapshot()).root, await realpath(d.home));
    } finally {
      await unlink(link).catch(() => {});
      await d.cleanup();
    }
  },
);

test('connection checks refuse external destinations and do not follow redirects', async () => {
  assert.equal((await checkLocalModel('http://example.invalid/v1', 'model', 'test')).ok, false);
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(302, { location: 'https://example.invalid/steal' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await checkLocalModel(`http://127.0.0.1:${port}/v1`, 'model', 'fixture-token');
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('unrelated YAML anchors survive; shared mutable paths and invalid grant payloads are refused', async () => {
  const s = await connectionFixture();
  try {
    const file = path.join(s.dsh.home, 'settings.yaml');
    await writeFile(file, 'appearance: &palette\n  color: blue\nother: *palette\n');
    const configured = (await s.configure()).result;
    assert.equal(configured.statusCode, 200, configured.body);
    assert.match(await readFile(file, 'utf8'), /&palette/);
    assert.match(await readFile(file, 'utf8'), /\*palette/);
    await s.request('DELETE', `/v1/local/connections/${configured.json().id}`);
    const shared = 'llm-pi-ai: &shared\n  providers: {}\nother: *shared\n';
    await writeFile(file, shared);
    let preview = await s.request('POST', '/v1/local/connections/preview', { agent: 'agent/test' });
    assert.equal(preview.statusCode, 400);
    assert.equal(await readFile(file, 'utf8'), shared);
    await writeFile(file, s.dsh.settings);
    await writeFile(
      path.join(s.dsh.home, '.credentials.yaml'),
      'version: 1\nrecords:\n  llm-pi-ai/example:\n    kind: grant\n    payload: .nan\n',
    );
    preview = await s.request('POST', '/v1/local/connections/preview', { agent: 'agent/test' });
    assert.equal(preview.statusCode, 400);
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
  } finally {
    await s.cleanup();
  }
});

test('annotations added to an owned entry are preserved rather than silently replaced', async () => {
  const s = await connectionFixture();
  try {
    const row = (await s.configure()).result.json();
    const file = path.join(s.dsh.home, 'settings.yaml');
    const current = await readFile(file, 'utf8');
    const annotated = current.replace(`${row.provider}:`, `${row.provider}: # Preserve my note`);
    assert.notEqual(annotated, current);
    await writeFile(file, annotated);
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    assert.equal(preview.statusCode, 409);
    const removed = await s.request('DELETE', `/v1/local/connections/${row.id}`);
    assert.equal(removed.json().key_revoked, true);
    assert.equal(removed.json().configuration_removed, false);
    assert.equal(await readFile(file, 'utf8'), annotated);
  } finally {
    await s.cleanup();
  }
});

test('an explicitly removed provider is repairable, but sync never silently becomes a new grant', async () => {
  const s = await connectionFixture();
  try {
    const row = (await s.configure()).result.json();
    const sync = await s.request('POST', '/v1/local/connections/preview', { agent: 'agent/test' });
    assert.equal(sync.json().action, 'sync');
    s.auth.revoke(principal, row.key_id);
    const changed = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: sync.json().plan_id,
    });
    assert.equal(changed.statusCode, 409);
    const repaired = (await s.configure()).result.json();
    await writeFile(path.join(s.dsh.home, 'settings.yaml'), s.dsh.settings);
    const missing = await s.request('GET', '/v1/local/connections');
    assert.equal(missing.json().data[0].status, 'missing');
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
    });
    assert.equal(preview.json().action, 'repair');
    const restored = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.notEqual(restored.json().key_id, repaired.key_id);
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId === row.id).length, 1);
  } finally {
    await s.cleanup();
  }
});

test('administrator revocation while waiting for a client lock prevents minting a grant', async () => {
  const s = await connectionFixture();
  try {
    const admin = s.auth.create(principal, 'temporary admin', ['*'], ['admin']);
    const preview = await s.request(
      'POST',
      '/v1/local/connections/preview',
      { agent: 'agent/test' },
      String(admin.token),
    );
    const lock = path.join(s.dsh.home, '.credentials.yaml.lock');
    await writeFile(lock, 'other writer\n');
    let authenticated = false;
    const authenticate = s.auth.authenticate.bind(s.auth);
    s.auth.authenticate = (header) => {
      const p = authenticate(header);
      if (p.keyId === admin.id) authenticated = true;
      return p;
    };
    const pending = Promise.resolve(
      s.request(
        'POST',
        '/v1/local/connections/apply',
        { plan_id: preview.json().plan_id },
        String(admin.token),
      ),
    );
    await waitFor(() => authenticated);
    s.auth.revoke(principal, String(admin.id));
    await unlink(lock);
    const denied = await pending;
    assert.equal(denied.statusCode, 401, denied.body);
    assert.equal(s.auth.list(principal).filter((k) => k.localConnectionId).length, 0);
    assert.equal(await readFile(path.join(s.dsh.home, 'settings.yaml'), 'utf8'), s.dsh.settings);
  } finally {
    await s.cleanup();
  }
});

test('zero-run validation authority creates a metadata-only connection that cannot invoke a model', async () => {
  const s = await connectionFixture();
  try {
    const admin = s.auth.create(principal, 'metadata-only admin', ['*'], ['admin'], { maxRuns: 0 });
    const preview = await s.request(
      'POST',
      '/v1/local/connections/preview',
      { agent: 'agent/test' },
      String(admin.token),
    );
    assert.equal(preview.statusCode, 200, preview.body);
    const applied = await s.request(
      'POST',
      '/v1/local/connections/apply',
      { plan_id: preview.json().plan_id },
      String(admin.token),
    );
    assert.equal(applied.statusCode, 200, applied.body);
    const key = s.auth.list(principal).find((k) => k.id === applied.json().key_id)!;
    assert.deepEqual(key.quota, { maxRuns: 0 });
    const credentials = await s.dsh.readCredentials();
    const caller = credentials.refs[`OAA_DSH_${String(applied.json().id).toUpperCase()}`]!;
    const refused = await s.request(
      'POST',
      '/v1/chat/completions',
      { model: 'agent/test', messages: [{ role: 'user', content: 'Must not execute' }] },
      caller,
    );
    assert.equal(refused.statusCode, 429, refused.body);
    assert.equal(s.driver.calls, 0);
    const checked = await s.request(
      'POST',
      `/v1/local/connections/${applied.json().id}/check`,
      {},
      String(admin.token),
    );
    assert.equal(checked.json().ok, true, checked.body);
    assert.equal(checked.json().generation_verified, false);
  } finally {
    await s.cleanup();
  }
});
