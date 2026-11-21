import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store/store.js';
import { prune } from '../src/store/retention.js';
import { checkUploadRoom } from '../src/store/upload-budget.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa-quota-totals-'));
  const s = new Store(root),
    other = new DatabaseSync(path.join(root, 'state.sqlite'));
  const insert = s.prepare('INSERT INTO files(id,owner,subject,payload) VALUES(?,?,?,?)');
  t.after(() => {
    other.close();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const file = (id: string, o: string, sub: string, bytes: number) =>
    insert.run(id, o, sub, JSON.stringify({ bytes }));
  const exact = (o: string, sub: string, used: number) => {
    checkUploadRoom(s, o, sub, 0, used);
    assert.throws(() => checkUploadRoom(s, o, sub, 1, used), { code: 'storage_quota_exceeded' });
  };
  const invalid = (o: string, sub: string) =>
    assert.throws(() => checkUploadRoom(s, o, sub, 0, Number.MAX_SAFE_INTEGER), {
      code: 'persistence_failed',
    });
  const hasCache = () =>
    !!s.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name='oaa_upload_usage'").get();
  return { s, other, file, exact, invalid, hasCache };
}

test('upload usage: warm totals follow file edits, retention and implicit REPLACE deletes across scopes', (t) => {
  const { s, file, exact } = fixture(t);
  s.db.exec('PRAGMA recursive_triggers=OFF');
  file('a', 'first', 'shared', 11);
  file('b', 'second', 'shared', 17);
  file('c', 'first', 'else', 31);
  exact('first', 'shared', 11);
  exact('second', 'shared', 17);
  exact('first', 'else', 31);
  s.db.exec(`INSERT OR REPLACE INTO files(rowid,id,owner,subject,payload)
    SELECT rowid,'a','third','shared','{"bytes":13}' FROM files WHERE id='b'`);
  exact('first', 'shared', 0);
  exact('second', 'shared', 0);
  exact('third', 'shared', 13);
  file('d', 'second', 'else', 23);
  exact('second', 'else', 23);
  s.db.exec(`UPDATE OR REPLACE files SET id='c',rowid=(SELECT rowid FROM files WHERE id='d'),
    owner='first',subject='new',payload='{"bytes":19}' WHERE id='a'`);
  exact('first', 'else', 0);
  exact('second', 'else', 0);
  exact('third', 'shared', 0);
  exact('first', 'new', 19);
  s.db.exec('BEGIN');
  file('e', 'first', 'new', 7);
  exact('first', 'new', 26);
  s.db.exec("DELETE FROM files WHERE id='c'");
  exact('first', 'new', 7);
  s.db.exec('ROLLBACK');
  exact('first', 'new', 19);
});

test('upload usage: live retention releases bytes without rescanning the subject after each page', async (t) => {
  const { s, exact } = fixture(t);
  const expired: string[] = [],
    kept: string[] = [];
  for (let i = 0; i < 12; i++) {
    const { id } = await s.addFile('o', 'fixture', Buffer.alloc(7), undefined, undefined, 's');
    if (i % 2 === 0) {
      expired.push(id);
      s.prepare("UPDATE files SET payload=json_set(payload,'$.createdAt',1) WHERE id=?").run(id);
    } else kept.push(id);
  }
  const other = await s.addFile('other', 'fixture', Buffer.alloc(7), undefined, undefined, 's');
  exact('o', 's', 84);
  exact('other', 's', 7);
  const stored = s.prepare(
    "SELECT sum(json_extract(payload,'$.bytes')) AS n FROM files WHERE owner='o' AND subject='s'",
  );
  const prepare = s.prepare.bind(s);
  let fills = 0,
    pages = 0;
  t.mock.method(s, 'prepare', (sql: string) => {
    if (sql.startsWith('INSERT OR REPLACE INTO temp.oaa_upload_usage')) fills++;
    return prepare(sql);
  });
  const report = await prune(s, {
    owner: 'o',
    olderThanMs: 60000,
    batchSize: 2,
    live: true,
    pause: async () => {
      pages++;
      exact('o', 's', Number(stored.get()!.n));
    },
  });
  assert.ok(pages >= 5);
  assert.equal(report.files, 6);
  assert.equal(report.file_bytes, 42);
  exact('o', 's', 42);
  exact('other', 's', 7);
  assert.equal(fills, 0, 'known committed deletes must not make the next upload scan all files');
  const present = (id: string) => existsSync(path.join(s.root, 'files', id));
  assert.ok(expired.every((id) => !present(id)));
  assert.ok([...kept, other.id].every(present));
});

test('upload usage: a concurrent writer neither blocks cold preflight nor supplies an uncommitted total', (t) => {
  const { s, other, file, exact, hasCache } = fixture(t);
  file('a', 'o', 's', 9);
  s.db.exec('PRAGMA busy_timeout=0');
  other.exec(`BEGIN IMMEDIATE; UPDATE files SET payload='{"bytes":22}' WHERE id='a'`);
  exact('o', 's', 9);
  assert.ok(hasCache());
  other.exec('COMMIT');
  exact('o', 's', 22);
  s.db.exec('BEGIN');
  exact('o', 's', 22);
  other.exec("UPDATE files SET payload='bad' WHERE id='a'");
  exact('o', 's', 22);
  s.db.exec('ROLLBACK');
  assert.throws(() => checkUploadRoom(s, 'o', 's', 0, 1000), { code: 'persistence_failed' });
  other.exec("DELETE FROM files WHERE id='a'");
  exact('o', 's', 0);
  assert.equal(
    other.prepare("SELECT 1 FROM sqlite_schema WHERE name='oaa_upload_usage'").get(),
    undefined,
  );
});

test('upload usage: malformed, overflowing and in-flight amounts cannot grant space; deletion repairs the total', (t) => {
  const { s, file, exact, invalid } = fixture(t);
  const max = Number.MAX_SAFE_INTEGER;
  file('big', 'o', 's', max);
  exact('o', 's', max);
  file('more', 'o', 's', 1);
  invalid('o', 's');
  s.db.exec("DELETE FROM files WHERE id='more'");
  exact('o', 's', max);
  const ticket = 'file_' + '0'.repeat(32);
  s.prepare(
    `INSERT INTO oaa_inline_inputs(file_id,owner,subject,bytes,digest,identity,phase)
    VALUES(?,'o','s',1,'d','i','writing')`,
  ).run(ticket);
  invalid('o', 's');
  s.db.exec("UPDATE oaa_inline_inputs SET phase='unlink'");
  exact('o', 's', max);
  s.db.exec("DELETE FROM files; UPDATE oaa_inline_inputs SET phase='writing',bytes=-1");
  invalid('o', 's');
  s.db.exec('DELETE FROM oaa_inline_inputs');
  exact('o', 's', 0);
  for (const payload of [
    'bad',
    '{}',
    '{"bytes":null}',
    '{"bytes":"7"}',
    '{"bytes":1.5}',
    '{"bytes":-1}',
    '{"bytes":9007199254740992}',
  ]) {
    s.prepare("INSERT INTO files(id,owner,subject,payload) VALUES('bad','o','s',?)").run(payload);
    invalid('o', 's');
    exact('other', 's', 0);
    s.db.exec("UPDATE files SET payload='{\"bytes\":7}' WHERE id='bad'");
    exact('o', 's', 7);
    s.db.exec("DELETE FROM files WHERE id='bad'");
    exact('o', 's', 0);
  }
});

test('upload usage: rejected callers warm a bounded cache; uncapped and read-only checks need no shadow state', (t) => {
  const { s, file, exact, hasCache } = fixture(t);
  file('a', 'o', 'busy', 41);
  checkUploadRoom(s, 'o', 'busy', 100);
  assert.ok(!hasCache());
  s.db.exec('PRAGMA query_only=ON');
  exact('o', 'busy', 41);
  assert.ok(!hasCache());
  s.db.exec('PRAGMA query_only=OFF; BEGIN');
  exact('o', 'busy', 41);
  assert.ok(hasCache());
  s.db.exec('ROLLBACK');
  assert.ok(!hasCache());
  assert.throws(() => checkUploadRoom(s, 'o', 'busy', 1, 1), { code: 'storage_quota_exceeded' });
  assert.equal(
    s.prepare("SELECT used FROM temp.oaa_upload_usage WHERE subject='busy'").get()?.used,
    41,
  );
  for (let i = 0; i < 320; i++) checkUploadRoom(s, 'o', String(i), 0, 1);
  assert.equal(s.prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage').get()?.n, 256);
  assert.equal(
    s.prepare("SELECT used FROM temp.oaa_upload_usage WHERE subject='busy'").get(),
    undefined,
  );
  exact('o', 'busy', 41);
});

test('upload usage: losing the outer writer cannot turn a failed cache fill into an unlocked reservation', (t) => {
  const { s, file, exact } = fixture(t);
  exact('o', 'known', 0);
  const failure = Object.assign(new Error('fixture: storage full'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 13,
  });
  const connection = {
    db: s.db,
    prepare(sql: string) {
      if (sql.startsWith('INSERT OR REPLACE INTO temp.oaa_upload_usage')) {
        s.db.exec('ROLLBACK');
        throw failure;
      }
      return s.prepare(sql);
    },
  };
  s.db.exec('BEGIN IMMEDIATE');
  file('tentative', 'o', 'uncached', 3);
  assert.throws(
    () => checkUploadRoom(connection, 'o', 'uncached', 1, 10),
    (error) => error === failure,
  );
  assert.ok(!s.db.isTransaction);
  exact('o', 'uncached', 0);
});
