import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { gatewaySchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { Store } from '../src/store/store.js';
import { BACKUP_KEEP, backupBeforeMigration } from '../src/store/backup.js';
import { sleep } from '../src/core/util.js';

// Upgrade from a database written by the released 0.0.64 (test/fixtures/upgrade-0.0.64.sqlite,
// produced by `npm run upgrade-check -- --fixture-out ...` with the offline sample agent only).
// In-process: nothing listens on a port and no agent process is started.

const FIXTURE = path.resolve('test', 'fixtures', 'upgrade-0.0.64.sqlite');
const token = 'test-upgrade-admin-key-not-a-credential-000000001';

async function dataDirFromFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-upgrade-'));
  await mkdir(path.join(dir, 'gateway'), { mode: 0o700 });
  await copyFile(FIXTURE, path.join(dir, 'gateway', 'state.sqlite'));
  return dir;
}
function rows(file: string, sql: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

test('upgrade: the 0.0.64 fixture contains no local paths or credentials', async () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      assert.doesNotMatch(text, /\/Users\/|\/private\/|\/home\/|\/tmp\/|[A-Z]:\\\\/, name);
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}/, name);
    }
  } finally {
    db.close();
  }
});

test('upgrade: a 0.0.64 database opens unchanged under the current schema, without a backup', async () => {
  const dir = await dataDirFromFixture();
  const file = path.join(dir, 'gateway', 'state.sqlite');
  const before = rows(file, 'SELECT id,status FROM runs ORDER BY rowid');
  assert.ok(before.length >= 3, 'the fixture has completed and interrupted runs');
  try {
    const store = new Store(path.join(dir, 'gateway'));
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
      const after = store.db.prepare('SELECT id,status FROM runs ORDER BY rowid').all();
      assert.deepEqual(after, before);
      // Every finished run still renders its timeline and output.
      for (const row of after) {
        const run = store.run(String(row.id), 'owner');
        assert.equal(run.status, row.status);
        assert.ok(store.history(run.id).length > 0);
      }
    } finally {
      store.close();
    }
    assert.ok(!(await readdir(path.join(dir, 'gateway'))).includes('backups'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upgrade: the current gateway serves 0.0.64 data, keys and portal accounts', async () => {
  const dir = await dataDirFromFixture();
  process.env.OAA_UPGRADE_TOKEN = token;
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    keys: [
      {
        name: 'owner',
        owner: 'owner',
        tokenEnv: 'OAA_UPGRADE_TOKEN',
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
    ],
    platform: { owner: 'owner', registration: 'open' },
  });
  const gateway = await createGateway(config);
  try {
    await gateway.app.ready();
    const get = (url: string) =>
      gateway.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    const list = await get('/v1/runs?limit=50');
    assert.equal(list.statusCode, 200);
    const runs = (list.json() as { data: { id: string; status: string }[] }).data;
    assert.ok(runs.some((r) => r.status === 'completed'));
    assert.ok(
      runs.some((r) => r.status === 'interrupted'),
      'the pending approval became interrupted',
    );
    for (const url of ['/v1/overview', '/v1/overview/activity', `/v1/runs/${runs[0]!.id}/timeline`])
      assert.equal((await get(url)).statusCode, 200, url);
    // Managed keys created by 0.0.64 are still listed (their hashes are unchanged).
    const keys = (await get('/v1/keys')).json() as { data: { name: string }[] };
    assert.ok(keys.data.some((k) => k.name === 'upgrade-check'));
    // Portal accounts survive; a wrong password is refused the same way as before.
    const accounts = (await get('/v1/platform/accounts')).json() as { data: unknown[] };
    assert.equal(accounts.data.length, 1);
    // The interrupted run can be inspected; resuming needs its agent, which is not configured here.
    const interrupted = runs.find((r) => r.status === 'interrupted')!;
    const state = await get(`/v1/runs/${interrupted.id}`);
    // 0.0.64 stopped while the sample agent waited for approval: an external agent's started turn
    // cannot rule out side effects, so it is interrupted with effect_outcome_unknown.
    assert.equal(
      (state.json() as { error: { code: string } }).error.code,
      'effect_outcome_unknown',
    );
  } finally {
    await gateway.app.close();
    delete process.env.OAA_UPGRADE_TOKEN;
    await rm(dir, { recursive: true, force: true });
  }
});

test('upgrade: repeated migration attempts keep only the newest pre-migration backups', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-backups-'));
  const db = new DatabaseSync(path.join(root, 'state.sqlite'));
  try {
    db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY); PRAGMA user_version=3');
    const made: string[] = [];
    for (let i = 0; i < BACKUP_KEEP + 2; i++) {
      made.push(path.basename(backupBeforeMigration(db, root, 4, () => false)!));
      await sleep(3);
    }
    const kept = (await readdir(path.join(root, 'backups'))).sort();
    assert.deepEqual(kept, made.slice(-BACKUP_KEEP).sort());
    // Current-version and fresh databases are never copied.
    assert.equal(
      backupBeforeMigration(db, root, 3, () => false),
      undefined,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
