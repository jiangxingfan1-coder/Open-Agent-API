import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/store/audit.js';
import { Store } from '../src/store/store.js';

const denial = {
  owner: 'fixture',
  keyId: 'key',
  code: 'scope_denied',
  method: 'POST',
  path: '/fixture',
};
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa-audit-recovery-')),
    store = new Store(root);
  let time = 1000000;
  return {
    store,
    log: new AuditLog(store, () => time),
    next: () => (time += 60000),
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
for (const mode of ['ABORT', 'ROLLBACK', 'IGNORE'])
  test(`audit: ${mode} cannot create a phantom suppression window`, () => {
    const { store, log, next, close } = fixture();
    const deny = () =>
      store.db.exec(
        `CREATE TEMP TRIGGER refuse BEFORE INSERT ON audit_events BEGIN SELECT RAISE(${mode}${mode === 'IGNORE' ? '' : ",'fixture audit failure'"}); END`,
      );
    try {
      deny();
      assert.throws(() => log.record(denial));
      assert.equal(log.page('fixture').data.length, 0);
      store.db.exec('DROP TRIGGER refuse');
      assert.equal(log.record(denial), true);
      assert.equal(log.record(denial), false);
      assert.equal(log.record(denial), false);
      next();
      deny();
      assert.throws(() => log.record(denial));
      store.db.exec('DROP TRIGGER refuse');
      assert.equal(log.record(denial), true);
      assert.deepEqual(
        log.page('fixture').data.map((r) => r.suppressed),
        [0, 2],
      );
    } finally {
      close();
    }
  });
test('audit: rolling back the caller transaction restores the old window and its true repeat count', () => {
  const { store, log, next, close } = fixture();
  try {
    log.record(denial);
    log.record(denial);
    next();
    store.db.exec('BEGIN IMMEDIATE');
    assert.equal(log.record(denial), true);
    assert.equal(log.record(denial), false);
    assert.equal(log.record({ ...denial, path: '/never-committed' }), true);
    store.db.exec('ROLLBACK');
    assert.equal(
      log.record({ ...denial, path: '/never-committed' }),
      true,
      'no receipt survived the rollback',
    );
    assert.equal(log.record(denial), true);
    assert.deepEqual(
      log
        .page('fixture')
        .data.filter((e) => e.path === '/fixture')
        .map((e) => e.suppressed),
      [0, 1],
    );
  } finally {
    close();
  }
});
test('audit: repeats need no main writer and do not change the on-disk database', () => {
  const { store, log, next, close } = fixture(),
    other = new DatabaseSync(path.join(store.root, 'state.sqlite'));
  try {
    assert.equal(log.record(denial), true);
    store.db.exec('PRAGMA busy_timeout=0');
    const version = () => other.prepare('PRAGMA data_version').get()!.data_version;
    const before = version();
    other.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 100; i++) assert.equal(log.record(denial), false);
    assert.throws(() => log.record({ ...denial, path: '/new' }), { code: 'ERR_SQLITE_ERROR' });
    other.exec('ROLLBACK');
    assert.equal(version(), before);
    assert.equal(log.record({ ...denial, path: '/new' }), true);
    next();
    log.record(denial);
    assert.equal(log.page('fixture').data.at(-1)?.suppressed, 100);
  } finally {
    other.close();
    close();
  }
});
test('audit: operator notes count toward retention across restart and a pruned denial no longer suppresses', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa-audit-cadence-'));
  let store = new Store(root),
    log = new AuditLog(store, () => 1000000);
  try {
    log.note({ ...denial, owner: 'other', code: 'platform_setup', detail: 'fixture' });
    store.db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 51; i++)
      log.note({ ...denial, path: '/setup/' + i, code: 'platform_setup', detail: 'fixture' });
    store.db.exec('COMMIT');
    store.close();
    store = new Store(root);
    log = new AuditLog(store, () => 1000000);
    log.record(denial);
    store.db.exec('BEGIN IMMEDIATE');
    for (let i = 51; i < 10099; i++)
      log.note({ ...denial, path: '/setup/' + i, code: 'platform_setup', detail: 'fixture' });
    store.db.exec('COMMIT');
    assert.equal(
      store.prepare('SELECT count(*) AS n FROM audit_events WHERE owner=?').get('fixture')!.n,
      10000,
    );
    assert.equal(log.page('fixture', 0, 1).data[0]?.path, '/setup/99');
    assert.equal(log.page('other').data.length, 1);
    assert.equal(log.record(denial), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
