import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { principalSubject } from '../src/core/contracts.js';
import { createGateway } from '../src/gateway/server.js';
import { makeBundle } from '../src/lang/bundle.js';
import { Store } from '../src/store/store.js';
import { TaskWorkflows } from '../src/store/task-workflows.js';
import { prune } from '../src/store/retention.js';
import { checkUploadRoom } from '../src/store/upload-budget.js';
import { FixtureModel, agent, setup, token, waitFor } from './helpers.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const fixture = path.resolve('dist/test/fixtures/provisional-input-crash.js');
for (const [mode, phase, fileRow, diskBytes] of [
  ['partial', 'writing', false, 5],
  ['before-metadata', 'writing', false, png.length],
  ['before-run', 'ready', true, png.length],
  ['before-cache', null, true, png.length],
  ['after-run', null, true, png.length],
  ['before-unlink', 'unlink', false, png.length],
  ['before-ack', 'unlink', false, 0],
  ['explicit-partial', 'writing', false, 5],
  ['explicit-before-metadata', 'writing', false, png.length],
  ['explicit-file-commit', null, true, png.length],
] as const)
  test(`inline uploads: exit ${mode} keeps explicit files and reclaims only unclaimed input bytes`, async () => {
    const s = await setup(Object.assign(new FixtureModel(), { imageInput: 'url' as const }));
    let again: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      s.store.publish('owner', makeBundle(agent()));
      const subject = principalSubject(s.auth.authenticate('Bearer ' + token));
      const explicit = await s.store.addFile(
        'owner',
        'image-1.png',
        Buffer.from('intentionally uploaded'),
        undefined,
        undefined,
        subject,
      );
      const legacy = await s.store.addFile(
        'owner',
        'image-1.png',
        png,
        undefined,
        undefined,
        'other-caller',
      );
      const config = path.join(s.dir, 'fixture.json');
      await writeFile(config, JSON.stringify(s.config));
      await s.app.close();
      const crashed = spawnSync(process.execPath, [fixture, config, mode], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(crashed.status, 79, crashed.stderr);
      const before = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'), {
        readOnly: true,
      });
      let input: string;
      const blob = (id: string) => path.join(s.config.dataDir, 'files', id);
      try {
        const files = before
          .prepare('SELECT id FROM files WHERE owner=? AND subject=? AND id<>?')
          .all('owner', subject, explicit.id);
        const markers = before.prepare('SELECT file_id,phase FROM oaa_inline_inputs').all();
        assert.equal(files.length, Number(fileRow));
        assert.deepEqual(
          markers.map((m) => m.phase),
          phase ? [phase] : [],
        );
        const charged = explicit.bytes + (fileRow || phase === 'writing' ? png.length : 0);
        checkUploadRoom(before, 'owner', subject, 0, charged);
        assert.throws(() => checkUploadRoom(before, 'owner', subject, 1, charged), {
          code: 'storage_quota_exceeded',
        });
        input = String(files[0]?.id ?? markers[0]!.file_id);
        if (diskBytes) assert.deepEqual(await readFile(blob(input)), png.subarray(0, diskBytes));
        else await assert.rejects(readFile(blob(input)), { code: 'ENOENT' });
        assert.equal(
          before.prepare('SELECT count(*) AS n FROM runs').get()!.n,
          phase === null && mode !== 'explicit-file-commit' ? 1 : 0,
        );
      } finally {
        before.close();
      }
      again = await createGateway(s.config, s.runtime);
      await again.app.ready();
      if (phase !== null) {
        await waitFor(
          async () =>
            !again!.store.prepare('SELECT 1 FROM oaa_inline_inputs').get() &&
            !again!.store.prepare('SELECT 1 FROM files WHERE id=?').get(input) &&
            (await readFile(blob(input)).then(
              () => false,
              (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
            )),
          7000,
        );
      } else {
        if (mode === 'explicit-file-commit')
          assert.deepEqual(again.store.file(input, 'owner', subject).allowedNodes, ['local']);
        else assert.deepEqual(again.store.allRuns()[0]!.fileIds, [input]);
        assert.deepEqual(await readFile(blob(input)), png);
      }
      assert.equal(again.store.file(explicit.id, 'owner', subject).name, 'image-1.png');
      assert.equal((await readFile(blob(explicit.id))).toString(), 'intentionally uploaded');
      assert.equal(again.store.file(legacy.id, 'owner', 'other-caller').sha256, legacy.sha256);
      assert.deepEqual(await readFile(blob(legacy.id)), png);
    } finally {
      await again?.app.close();
      await s.cleanup();
    }
  });

const marker = (s: Store, id: string) =>
  s.prepare('SELECT phase,due FROM oaa_inline_inputs WHERE file_id=?').get(id);
const inline = (s: Store, tag: string, owner = 'owner') =>
  s.addFile(owner, 'image-1.png', Buffer.from(tag), undefined, undefined, 'subject', 'inline');
const count = (s: Store) =>
  Number(s.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n);
async function tempStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-upload-journal-'));
  let db = new Store(root);
  return {
    get s() {
      return db;
    },
    reopen() {
      db.close();
      db = new Store(root);
      return db;
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('inline uploads: workflow admission claims the exact owner and rolls back with the caller transaction', async () => {
  const f = await tempStore(),
    s = f.s;
  try {
    const records = new TaskWorkflows(s);
    const a = await inline(s, 'unclaimed'),
      b = await inline(s, 'claimed'),
      owner = 'owner';
    const holds = s.provisionalInputs.hold(owner, [a.id, b.id]);
    const create = (owner: string, file: string) =>
      records.create({
        owner,
        subject: 'subject',
        definition: { id: 'test' },
        revision: 'fixture',
        authority: { owner, name: 'test', agents: ['*'], scopes: ['invoke'] },
        input: { nested: [file] },
        fileIds: [],
      });
    s.db.exec('BEGIN IMMEDIATE');
    create(owner, a.id);
    assert.equal(marker(s, a.id), undefined);
    s.db.exec('ROLLBACK');
    assert.equal(marker(s, a.id)?.phase, 'ready');
    create('other', a.id);
    assert.ok(marker(s, a.id), 'a different owner does not adopt this input');
    create(owner, b.id);
    assert.equal(marker(s, b.id), undefined);
    const result = await prune(s, { olderThanMs: 1, now: Date.now() + 1000, live: true, owner });
    assert.equal(
      result.files,
      0,
      'live provisional and workflow inputs have independent protection',
    );
    await s.provisionalInputs.release(holds);
    assert.equal(marker(s, a.id), undefined);
    assert.throws(() => s.file(a.id, owner), { code: 'file_not_found' });
    const again = f.reopen();
    assert.equal(again.file(b.id, owner).id, b.id);
    assert.equal((await readFile(path.join(again.root, 'files', b.id))).toString(), 'claimed');
  } finally {
    await f.close();
  }
});

test('inline uploads: missing claim protection is not evidence to delete historical data', async () => {
  const f = await tempStore(),
    s = f.s;
  try {
    const file = await inline(s, 'historic');
    s.db.exec('DROP TRIGGER oaa_inline_run_insert');
    s.prepare(
      "INSERT INTO runs(id,owner,agent_id,session_id,status,payload,subject) VALUES('legacy','owner','agent/test','s','completed',?,'subject')",
    ).run(JSON.stringify({ fileIds: [file.id] }));
    const again = f.reopen();
    assert.equal(
      count(again),
      0,
      'an unprotected historical owner is retained, not retroactively classified',
    );
    assert.equal(again.file(file.id, 'owner').sha256, file.sha256);
    assert.equal((await readFile(path.join(again.root, 'files', file.id))).toString(), 'historic');
  } finally {
    await f.close();
  }
});

test('inline uploads: a mismatched catalog row or replaced blob is preserved without guessing from its name', async () => {
  const f = await tempStore(),
    s = f.s;
  try {
    const a = await inline(s, 'known'),
      b = await inline(s, 'original'),
      c = await inline(s, 'aaaa');
    const holds = s.provisionalInputs.hold('owner', [a.id, b.id, c.id]);
    s.prepare("UPDATE files SET subject='other-subject' WHERE id=?").run(a.id);
    const blob = path.join(s.root, 'files', b.id);
    await rename(blob, blob + '.test-original');
    await writeFile(blob, 'replacement', { flag: 'wx' });
    const changed = path.join(s.root, 'files', c.id);
    await writeFile(changed, 'bbbb');
    await s.provisionalInputs.release(holds);
    assert.equal(count(s), 0);
    assert.equal(s.file(a.id, 'owner', 'other-subject').id, a.id);
    assert.equal(s.file(b.id, 'owner').id, b.id);
    assert.equal((await readFile(blob)).toString(), 'replacement');
    assert.equal((await readFile(blob + '.test-original')).toString(), 'original');
    assert.equal(s.file(c.id, 'owner').id, c.id);
    assert.equal((await readFile(changed)).toString(), 'bbbb');
  } finally {
    await f.close();
  }
});

for (const phase of ['detach', 'ack'] as const)
  test(`inline uploads: an ignored ${phase} cannot falsely complete cleanup`, async () => {
    const f = await tempStore(),
      s = f.s;
    try {
      const file = await inline(s, 'retry'),
        holds = s.provisionalInputs.hold('owner', [file.id]);
      const hook =
        phase === 'detach'
          ? "BEFORE UPDATE OF phase ON oaa_inline_inputs WHEN NEW.phase='unlink'"
          : "BEFORE DELETE ON oaa_inline_inputs WHEN OLD.phase='unlink'";
      s.db.exec(`CREATE TEMP TRIGGER deny ${hook} BEGIN SELECT RAISE(IGNORE); END;`);
      await s.provisionalInputs.release(holds);
      const blob = path.join(s.root, 'files', file.id);
      assert.equal(marker(s, file.id)?.phase, phase === 'detach' ? 'ready' : 'unlink');
      if (phase === 'detach') {
        assert.equal(s.file(file.id, 'owner').id, file.id);
        assert.equal((await readFile(blob)).toString(), 'retry');
      } else {
        assert.throws(() => s.file(file.id, 'owner'), { code: 'file_not_found' });
        await assert.rejects(readFile(blob), { code: 'ENOENT' });
      }
      s.db.exec('DROP TRIGGER deny');
      await waitFor(() => !marker(s, file.id), 7000);
      await assert.rejects(readFile(blob), { code: 'ENOENT' });
    } finally {
      await f.close();
    }
  });

test('inline uploads: a recovered input can be held by a new request while the writer is busy', async (t) => {
  const f = await tempStore();
  let other: DatabaseSync | undefined;
  try {
    const file = await inline(f.s, 'racing request');
    assert.throws(() => new Store(f.s.root), { code: 'gateway_already_running' });
    const s = f.reopen();
    other = new DatabaseSync(path.join(s.root, 'state.sqlite'));
    other.exec('BEGIN IMMEDIATE');
    let attempts = 0;
    const exec = s.db.exec.bind(s.db);
    t.mock.method(s.db, 'exec', (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') {
        attempts++;
        assert.equal(s.db.prepare('PRAGMA busy_timeout').get()!.timeout, 0);
      }
      return exec(sql);
    });
    await waitFor(() => attempts > 0);
    assert.deepEqual(s.provisionalInputs.hold('other-owner', [file.id]), []);
    const held = s.provisionalInputs.hold('owner', [file.id]);
    assert.deepEqual(held, [file.id]);
    other.exec('ROLLBACK');
    other.close();
    other = undefined;
    const next = await inline(s, 'unrelated');
    await s.provisionalInputs.release(s.provisionalInputs.hold('owner', [next.id]));
    assert.ok(marker(s, file.id));
    assert.ok(s.file(file.id, 'owner'));
    await s.provisionalInputs.release(held);
    await waitFor(() => !marker(s, file.id));
    assert.throws(() => s.file(file.id, 'owner'), { code: 'file_not_found' });
  } finally {
    other?.close();
    await f.close();
  }
});

test('inline uploads: indexed batches recover an old backlog without fencing off a new refusal', async (t) => {
  const f = await tempStore();
  try {
    const n = 256;
    f.s.db.exec('BEGIN IMMEDIATE');
    const add = f.s.prepare(
      "INSERT INTO oaa_inline_inputs(file_id,owner,subject,digest,bytes,identity,phase) VALUES(?,'bulk','s','fixture',0,'absent','unlink')",
    );
    for (let i = 0; i < n; i++) add.run('file_' + i.toString(16).padStart(32, '0'));
    f.s.db.exec('COMMIT');
    const s = f.reopen();
    let locked = true,
      removed = 0,
      perCommit = 0;
    const batches: number[] = [];
    s.db.function('blocked', () => Number(locked));
    s.db.function('removed', () => {
      removed++;
      perCommit++;
      return 1;
    });
    s.db.exec(
      "CREATE TEMP TRIGGER pause_bulk BEFORE DELETE ON oaa_inline_inputs WHEN OLD.owner='bulk' AND blocked()=1 BEGIN SELECT RAISE(ABORT,'fixture busy row'); END; CREATE TEMP TRIGGER count_bulk AFTER DELETE ON oaa_inline_inputs WHEN OLD.owner='bulk' BEGIN SELECT removed(); END;",
    );
    const exec = s.db.exec.bind(s.db);
    t.mock.method(s.db, 'exec', (sql: string) => {
      const v = exec(sql);
      if (sql === 'COMMIT' && perCommit) {
        batches.push(perCommit);
        perCommit = 0;
      }
      return v;
    });
    const file = await inline(s, 'live');
    await s.provisionalInputs.release(s.provisionalInputs.hold('owner', [file.id]));
    await waitFor(() => !marker(s, file.id));
    assert.equal(removed, 0);
    assert.equal(count(s), n);
    const plans = [
      s
        .prepare(
          'EXPLAIN QUERY PLAN SELECT seq FROM oaa_inline_inputs WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',
        )
        .all(0, n, 16),
      s
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM oaa_inline_inputs WHERE due<=? ORDER BY due,seq LIMIT ?',
        )
        .all(0, 16),
    ];
    assert.ok(plans[0]!.some((r) => String(r.detail).includes('INTEGER PRIMARY KEY')));
    assert.ok(plans[1]!.some((r) => String(r.detail).includes('oaa_inline_due')));
    locked = false;
    await waitFor(() => count(s) === 0, 10000);
    assert.equal(removed, n);
    assert.ok(batches.length > 1 && batches.every((size) => size <= 16));
  } finally {
    await f.close();
  }
});

test('inline uploads: ignored adoption rolls back the run; successful retry keeps a single claim and charge', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const who = s.auth.authenticate('Bearer ' + token),
      subject = principalSubject(who);
    const file = await s.store.addFile(
      'owner',
      'image-1.png',
      png,
      undefined,
      undefined,
      subject,
      'inline',
    );
    const held = s.store.provisionalInputs.hold('owner', [file.id]);
    s.store.db.exec(
      "CREATE TEMP TRIGGER deny BEFORE DELETE ON oaa_inline_inputs WHEN OLD.phase='ready' BEGIN SELECT RAISE(IGNORE); END",
    );
    const submit = () =>
      s.request(
        'POST',
        '/v1/invoke',
        { agent: 'agent/test', input: 'hello', file_ids: [file.id], background: true },
        token,
        { 'idempotency-key': 'input-claim' },
      );
    const no = await submit();
    assert.equal(no.statusCode, 500, no.body);
    assert.equal(s.store.allRuns().length, 0);
    assert.equal(s.auth.keyUsage(who.keyId).usedRuns, 0);
    assert.equal(marker(s.store, file.id)?.phase, 'ready');
    s.store.db.exec('DROP TRIGGER deny');
    const yes = await submit();
    assert.equal(yes.statusCode, 200, yes.body);
    await s.kernel.wait(yes.json().id);
    await s.store.provisionalInputs.release(held);
    assert.equal(marker(s.store, file.id), undefined);
    assert.equal(s.store.file(file.id, 'owner').id, file.id);
    assert.equal((await submit()).json().id, yes.json().id);
    assert.equal(s.auth.keyUsage(who.keyId).usedRuns, 1);
  } finally {
    await s.cleanup();
  }
});
