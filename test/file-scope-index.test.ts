import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, constants } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileIndexCommand, fileIndexOperation } from '../src/client/file-index.js';
import { Store, SCHEMA_VERSION } from '../src/store/store.js';
import {
  FileScopeLayoutChanged,
  fileScopeLayout,
  legacyFileScopeIndex,
} from '../src/store/file-scope-index.js';
import { ColdUploadReads } from '../src/store/upload-cold-reads.js';
import { UploadRecounts } from '../src/store/upload-recount.js';
import { readUsagePage, transferablePrefix } from '../src/store/upload-usage-page.js';
import { checkUploadRoom, storedUploadCopy } from '../src/store/upload-budget.js';
import { setup } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('file-index: fresh gateways only opt in when a storage cap is configured', async () => {
  for (const cap of [undefined, 64]) {
    const s = await setup(undefined, cap === undefined ? {} : { maxStoredBytesPerSubject: cap });
    try {
      assert.equal(fileScopeLayout(s.store), cap === undefined ? 'scope-only' : 'scope-bytes');
    } finally {
      await s.cleanup();
    }
  }
});
function location(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa quota #索引-')),
    dbfile = path.join(root, 'state.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: root,
      keys: [{ name: 'test', owner: 'o', tokenEnv: 'OAA_UNUSED_FILE_INDEX_TEST' }],
    }),
  );
  return {
    root,
    dbfile,
    run: (...args: string[]) =>
      spawnSync(process.execPath, [cli, 'file-index', '--config', config, ...args], {
        encoding: 'utf8',
        timeout: 15000,
      }),
  };
}
function makeLegacy(s: Store) {
  s.db.exec('DROP INDEX file_owner_subject;' + legacyFileScopeIndex);
}
const rows = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT CAST(rowid AS TEXT) AS rid,id,owner,subject,hex(payload) AS payload FROM files ORDER BY rowid',
    )
    .all();
const indexes = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='index' AND name!='file_owner_subject' ORDER BY name",
    )
    .all();

test('file-index: SQLITE_FULL rolls back the replacement and a later retry can succeed', (t) => {
  const { root, dbfile } = location(t),
    s = new Store(root);
  makeLegacy(s);
  s.db.exec(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<20000)
    INSERT INTO files SELECT 'f'||n,'o','{"bytes":9007199254740000}','s' FROM nums; VACUUM`);
  s.close();
  const d = new DatabaseSync(dbfile);
  try {
    const pages = Number(d.prepare('PRAGMA page_count').get()!.page_count);
    d.exec(`PRAGMA max_page_count=${pages}`);
    assert.throws(
      () => fileIndexOperation(d, true),
      (e: unknown) => e instanceof Error && 'errcode' in e && (Number(e.errcode) & 255) === 13,
    );
    assert.equal(d.isTransaction, false);
    assert.equal(fileScopeLayout(d), 'scope-only');
    assert.equal(d.prepare('SELECT count(*) AS n FROM files').get()!.n, 20000);
    assert.equal(d.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    d.exec(`PRAGMA max_page_count=${pages + 2048}`);
    assert.equal(fileIndexOperation(d, true).changed, true);
  } finally {
    d.close();
  }
});

test('file-index: a byte cursor is not silently reinterpreted if its index disappears', (t) => {
  const { root } = location(t),
    s = new Store(root, { cappedUploads: true });
  try {
    s.db.exec(
      `INSERT INTO files VALUES('one','o','{"bytes":1}','s'),('two','o','{"bytes":1}','s')`,
    );
    const scope = { owner: 'o', subject: 's' },
      p = readUsagePage(s, scope, 1);
    assert.ok(p.next);
    assert.equal(p.next.from, 'charge-ties');
    assert.equal(
      transferablePrefix({ rows: 1, bytes: 1, next: { ...p.next, key: ['AB', 1, '1'] } }),
      false,
    );
    makeLegacy(s);
    assert.throws(() => readUsagePage(s, scope, 1, p.next), FileScopeLayoutChanged);
    assert.equal(readUsagePage(s, scope, 4).bytes, 2);
  } finally {
    s.close();
  }
});
test('file-index: a layout change between ticket inspection and a slice restarts with canonical bytes', async (t) => {
  const { root, dbfile } = location(t),
    s = new Store(root, { cappedUploads: true }),
    other = new DatabaseSync(dbfile);
  try {
    s.db.exec(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<5100)
      INSERT INTO files SELECT 'f'||n,'o','{"bytes":1}','s' FROM nums`);
    const prepare = s.prepare.bind(s),
      exec = s.db.exec.bind(s.db);
    let checked = false,
      changed = false;
    t.mock.method(s, 'prepare', (sql: string) => {
      if (
        sql.startsWith('SELECT 1 FROM temp.oaa_upload_usage WHERE owner=? AND subject=? AND scan=?')
      )
        checked = true;
      return prepare(sql);
    });
    t.mock.method(s.db, 'exec', (sql: string) => {
      if (sql === 'SAVEPOINT oaa_change' && checked && !changed) {
        changed = true;
        other.exec(`BEGIN IMMEDIATE; DROP INDEX file_owner_subject; ${legacyFileScopeIndex};
           UPDATE files SET payload='{"bytes":91}' WHERE id='f1'; COMMIT`);
      }
      exec(sql);
    });
    await new UploadRecounts().fill(s, 'o', 's', () => {});
    assert.ok(changed);
    assert.equal(fileScopeLayout(s), 'scope-only');
    checkUploadRoom(s, 'o', 's', 0, 5190, true);
    assert.throws(() => checkUploadRoom(s, 'o', 's', 1, 5190, true), {
      code: 'storage_quota_exceeded',
    });
  } finally {
    other.close();
    s.close();
  }
});
for (const readable of [true, false])
  test(
    'file-index: ambiguous COMMIT never repeats DDL (' +
      (readable ? 'confirmed' : 'unconfirmed') +
      ')',
    (t) => {
      const { root, dbfile } = location(t),
        s = new Store(root);
      makeLegacy(s);
      s.close();
      const d = new DatabaseSync(dbfile),
        exec = d.exec.bind(d);
      let committed = false,
        creates = 0;
      t.mock.method(d, 'exec', (sql: string) => {
        exec(sql);
        if (sql.startsWith('CREATE INDEX')) creates++;
        if (sql === 'COMMIT') {
          committed = true;
          throw Object.assign(new Error('fixture: commit acknowledgement lost'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 10,
          });
        }
      });
      const apply = () =>
        fileIndexOperation(d, true, {
          checkFile: () => {
            if (committed && !readable) throw Error('fixture: unavailable read-back');
          },
        });
      try {
        if (readable) {
          const r = apply();
          assert.ok('confirmed_after_commit_error' in r && r.confirmed_after_commit_error);
        } else assert.throws(apply, { code: 'file_index_commit_unconfirmed', uncertain: true });
        assert.equal(creates, 1);
        assert.equal(fileIndexCommand(root).layout, 'scope-bytes');
      } finally {
        d.close();
      }
    },
  );

test('file-index: preview is read-only; offline replacement preserves rowids, blobs, receipts and all other indexes', async (t) => {
  const { root, dbfile, run } = location(t);
  const s = new Store(root, { cappedUploads: true });
  let fileId: string, hash: string;
  try {
    assert.equal(fileScopeLayout(s), 'scope-bytes');
    makeLegacy(s);
    const file = await s.addFile(
      'o',
      'keep',
      Buffer.from('retained bytes'),
      undefined,
      undefined,
      's',
    );
    fileId = file.id;
    hash = file.sha256;
    s.db.exec(
      `INSERT INTO files(rowid,id,owner,subject,payload) VALUES(-42,'bad','o','other','legacy'),(9007199254740997,'large-rid','o','s','{"bytes":0}')`,
    );
    s.prepare(
      "INSERT INTO oaa_inline_inputs(file_id,owner,subject,bytes,digest,identity,phase) VALUES(?,'o','s',4,'d','i','writing')",
    ).run('file_' + 'a'.repeat(32));
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(
      [
        JSON.parse(preview.stdout).layout,
        JSON.parse(preview.stdout).live_gateway,
        JSON.parse(preview.stdout).changed,
      ],
      ['scope-only', true, false],
    );
    assert.throws(() => fileIndexCommand(root, true), { code: 'gateway_already_running' });
  } finally {
    s.close();
  }
  const inspect = new DatabaseSync(dbfile);
  try {
    const before = rows(inspect),
      oldIndexes = indexes(inspect);
    const revision = () => inspect.prepare('PRAGMA schema_version').get()!.schema_version;
    const initial = revision();
    assert.equal(run('--dry-run').status, 0);
    assert.equal(revision(), initial);
    const result = run('--write');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      [
        JSON.parse(result.stdout).previous_layout,
        JSON.parse(result.stdout).layout,
        JSON.parse(result.stdout).changed,
      ],
      ['scope-only', 'scope-bytes', true],
    );
    const migrated = revision();
    assert.notEqual(migrated, initial);
    assert.equal(fileIndexCommand(root, true).changed, false);
    assert.equal(revision(), migrated);
    assert.deepEqual(rows(inspect), before);
    assert.deepEqual(indexes(inspect), oldIndexes);
    assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
    assert.equal(inspect.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(inspect.prepare('SELECT phase FROM oaa_inline_inputs').get()!.phase, 'writing');
    assert.equal(readFileSync(path.join(root, 'files', fileId!), 'utf8'), 'retained bytes');
    assert.equal(storedUploadCopy(inspect, 'o', 's', hash!, 14), fileId!);
    checkUploadRoom(inspect, 'o', 's', 0, 18);
    assert.throws(() => checkUploadRoom(inspect, 'o', 's', 1, 18), {
      code: 'storage_quota_exceeded',
    });
    const undo = run('scope-only', '--write');
    assert.equal(undo.status, 0, undo.stderr);
    assert.equal(JSON.parse(undo.stdout).layout, 'scope-only');
    assert.deepEqual(rows(inspect), before);
    assert.deepEqual(indexes(inspect), oldIndexes);
    assert.equal(readFileSync(path.join(root, 'files', fileId!), 'utf8'), 'retained bytes');
  } finally {
    inspect.close();
  }
});

test('file-index: missing catalogs are not created and remote or conflicting arguments cannot write locally', (t) => {
  const { root, dbfile, run } = location(t);
  assert.throws(() => fileIndexCommand(root, true), { code: 'invalid_file_catalog' });
  assert.ok(!existsSync(dbfile));
  const s = new Store(root);
  makeLegacy(s);
  s.close();
  for (const args of [
    ['--write', '--dry-run'],
    ['--write', '--url', 'http://127.0.0.1:1'],
    ['--write', '--older-than', '1s'],
    ['extra', '--write'],
  ]) {
    assert.notEqual(run(...args).status, 0);
    assert.equal(fileIndexCommand(root).layout, 'scope-only');
  }
});
test('file-index: a live gateway is not asked for its writer, and a gateway starting after inspection still wins', (t) => {
  const { root, dbfile } = location(t);
  let peer: Store | undefined = new Store(root);
  makeLegacy(peer);
  const d = new DatabaseSync(dbfile),
    exec = d.exec.bind(d);
  let begins = 0;
  t.mock.method(d, 'exec', (sql: string) => {
    if (sql === 'BEGIN IMMEDIATE') {
      begins++;
      peer ??= new Store(root);
    }
    exec(sql);
  });
  try {
    assert.throws(() => fileIndexOperation(d, true), { code: 'gateway_already_running' });
    assert.equal(begins, 0);
    peer.close();
    peer = undefined;
    assert.throws(() => fileIndexOperation(d, true), { code: 'gateway_already_running' });
    assert.equal(begins, 1);
    assert.equal(fileScopeLayout(d), 'scope-only');
    assert.equal(d.isTransaction, false);
  } finally {
    peer?.close();
    d.close();
  }
});
test('file-index: unsupported schema, nonstandard index and contended writer are not altered', (t) => {
  const { root, dbfile } = location(t),
    s = new Store(root);
  makeLegacy(s);
  s.close();
  const other = new DatabaseSync(dbfile);
  try {
    other.exec('BEGIN IMMEDIATE');
    assert.equal(fileIndexCommand(root).layout, 'scope-only');
    assert.throws(() => fileIndexCommand(root, true), { code: 'maintenance_busy' });
    other.exec('ROLLBACK');
    other.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
    assert.throws(() => fileIndexCommand(root, true), { code: 'unsupported_file_catalog' });
    assert.equal(fileScopeLayout(other), 'scope-only');
    other.exec(
      `PRAGMA user_version=${SCHEMA_VERSION}; DROP INDEX file_owner_subject; CREATE INDEX file_owner_subject ON files(subject,owner) WHERE subject IS NOT NULL`,
    );
    assert.equal(fileIndexCommand(root).layout, 'unrecognized');
    assert.throws(() => fileIndexCommand(root, true), { code: 'unrecognized_file_index' });
    assert.equal(fileScopeLayout(other), 'unrecognized');
    other.exec('DROP INDEX file_owner_subject');
    assert.throws(() => fileIndexCommand(root, true), { code: 'unrecognized_file_index' });
  } finally {
    other.close();
  }
});
test('file-index: failed or interrupted CREATE cannot lose the old index after DROP', (t) => {
  const { root, dbfile } = location(t),
    s = new Store(root);
  makeLegacy(s);
  s.db.exec(`INSERT INTO files VALUES('keep','o','{"bytes":7}','s')`);
  s.close();
  const db = new DatabaseSync(dbfile);
  try {
    db.setAuthorizer((op, name) =>
      op === constants.SQLITE_CREATE_INDEX && name === 'file_owner_subject'
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    assert.throws(() => fileIndexOperation(db, true));
    assert.equal(db.isTransaction, false);
    assert.equal(fileScopeLayout(db), 'scope-only');
  } finally {
    db.close();
  }
  const module = new URL('../src/client/file-index.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import{DatabaseSync,constants}from'node:sqlite';
    const {fileIndexOperation}=await import(process.argv[2]),d=new DatabaseSync(process.argv[1]);
    d.setAuthorizer((op,name)=>{if(op===constants.SQLITE_CREATE_INDEX&&name==='file_owner_subject')process.exit(79);return constants.SQLITE_OK;});
    fileIndexOperation(d,true);`,
      dbfile,
      module,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(child.status, 79, child.stderr);
  const reopened = new Store(root);
  try {
    assert.equal(
      fileScopeLayout(reopened),
      'scope-only',
      'normal startup must not rebuild a populated legacy index',
    );
    assert.equal(
      reopened.prepare("SELECT payload FROM files WHERE id='keep'").get()!.payload,
      '{"bytes":7}',
    );
  } finally {
    reopened.close();
  }
  assert.equal(fileIndexCommand(root, true).changed, true);
});
for (const legacy of [false, true])
  test(
    'file-index: a valid ' +
      (legacy ? 'digest' : 'byte') +
      ' cursor resumes in its original order on a compact catalog',
    async (t) => {
      const { root, dbfile } = location(t),
        s = new Store(root, { cappedUploads: true }),
        other = new DatabaseSync(dbfile);
      const scope = { owner: 'o', subject: 's' };
      let total = 0;
      const add = s.prepare('INSERT INTO files(id,owner,subject,payload) VALUES(?,?,?,?)');
      s.db.exec('BEGIN');
      for (let i = 0; i < 5000; i++) {
        const bytes = (i * 17) % 31;
        total += bytes;
        add.run(
          'r' + i,
          'o',
          's',
          JSON.stringify({ bytes, sha256: (4999 - i).toString(16).padStart(64, '0') }),
        );
      }
      s.db.exec('COMMIT');
      const readers = new ColdUploadReads(s, {
        async read() {
          const page = readUsagePage(other, scope, 512, undefined, 'reader', !legacy);
          assert.ok(page.next);
          assert.equal(page.next.from.startsWith('charge'), !legacy);
          const prefix = { rows: 512, bytes: page.bytes!, next: page.next };
          assert.ok(transferablePrefix(prefix));
          return prefix;
        },
        async close() {},
      });
      const prepare = s.prepare.bind(s),
        slices: string[] = [];
      t.mock.method(s, 'prepare', (sql: string) => {
        if (sql.startsWith('SELECT count(*) AS rows,')) slices.push(sql);
        return prepare(sql);
      });
      try {
        await readers.warm('o', 's', 1);
        assert.ok(slices.length > 0);
        assert.ok(
          slices.every((q) =>
            q.includes('INDEXED BY ' + (legacy ? 'file_upload_facts' : 'file_owner_subject')),
          ),
        );
        checkUploadRoom(s, 'o', 's', 0, total, true);
        assert.throws(() => checkUploadRoom(s, 'o', 's', 1, total, true), {
          code: 'storage_quota_exceeded',
        });
      } finally {
        await readers.close();
        other.close();
        s.close();
      }
    },
  );
test('file-index: uncapped catalogs keep the original write path; toggling a cap never rebuilds an existing index', async (t) => {
  const { root } = location(t),
    first = new Store(root);
  try {
    assert.equal(fileScopeLayout(first), 'scope-only');
    await first.addFile('o', 'first', Buffer.from('a'), undefined, undefined, 's');
  } finally {
    first.close();
  }
  const capped = new Store(root, { cappedUploads: true });
  try {
    assert.equal(fileScopeLayout(capped), 'scope-only');
    checkUploadRoom(capped, 'o', 's', 0, 1);
  } finally {
    capped.close();
  }
  assert.equal(fileIndexCommand(root, true).changed, true);
  const uncapped = new Store(root);
  try {
    assert.equal(fileScopeLayout(uncapped), 'scope-bytes');
    assert.equal(uncapped.prepare('SELECT count(*) AS n FROM files').get()!.n, 1);
  } finally {
    uncapped.close();
  }
});
