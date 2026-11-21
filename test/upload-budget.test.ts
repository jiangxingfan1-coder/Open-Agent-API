import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { makeBundle } from '../src/lang/bundle.js';
import { principalSubject } from '../src/core/contracts.js';
import { checkUploadRoom, storedUploadCopy, UploadWaitBudget } from '../src/store/upload-budget.js';
import { FixtureModel, agent, setup, token, waitFor } from './helpers.js';

const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const png = Buffer.from(data, 'base64'),
  vision = () => Object.assign(new FixtureModel(), { imageInput: 'url' as const });
type Gateway = Awaited<ReturnType<typeof setup>>;
const stored = (s: Gateway) =>
  Number(
    s.store
      .prepare("SELECT coalesce(sum(json_extract(payload,'$.bytes')),0) AS n FROM files")
      .get()!.n,
  );
const put = (s: Gateway, filename: string, content: string, who = token) =>
  s.request('POST', '/v1/files', { filename, content }, who);
const photo = (s: Gateway, who = token) =>
  s.request(
    'POST',
    '/v1/chat/completions',
    {
      model: 'agent/test',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } }],
        },
      ],
    },
    who,
  );
const journal = (s: Gateway) =>
  Number(s.store.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n);
function lock(s: Gateway) {
  const other = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'));
  other.exec('BEGIN IMMEDIATE');
  let held = true;
  return () => {
    if (held) {
      held = false;
      other.exec('ROLLBACK');
      other.close();
    }
  };
}

test('uploads: JSON and multipart share one atomic byte cap, while another caller has its own room', async () => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: 100 });
  try {
    const base = await s.listen(),
      form = new FormData();
    form.append('file', new Blob(['b'.repeat(70)]), 'b.txt');
    const [one, two] = await Promise.all([
      put(s, 'a.txt', 'a'.repeat(70)),
      fetch(base + '/v1/files', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: form,
      }),
    ]);
    const b = await two.json();
    assert.deepEqual([one.statusCode, two.status].sort(), [200, 413]);
    assert.equal((one.statusCode === 413 ? one.json() : b).error.code, 'storage_quota_exceeded');
    assert.equal(stored(s), 70);
    assert.equal(journal(s), 0);
    const exact = await put(s, 'exact', 'z'.repeat(30));
    assert.equal(exact.statusCode, 200);
    assert.equal((await put(s, 'overflow', 'z')).statusCode, 413);
    const key = s.auth.create(
      s.auth.authenticate('Bearer ' + token),
      'another',
      ['*'],
      ['files', 'read'],
    );
    assert.equal((await put(s, 'separate', 'z'.repeat(100), String(key.token))).statusCode, 200);
    assert.equal(stored(s), 200);
  } finally {
    await s.cleanup();
  }
});
test('uploads: explicit bytes and model input cannot both consume the same remaining budget', async () => {
  const s = await setup(vision(), { maxStoredBytesPerSubject: 100 });
  try {
    s.store.publish('owner', makeBundle(agent()));
    const [upload, image] = await Promise.all([put(s, 'ordinary', 'z'.repeat(70)), photo(s)]);
    assert.deepEqual([upload.statusCode, image.statusCode].sort(), [200, 413]);
    assert.equal(
      (upload.statusCode === 413 ? upload : image).json().error.code,
      'storage_quota_exceeded',
    );
    assert.equal(stored(s), 70);
    assert.equal(s.driver.calls, image.statusCode === 200 ? 1 : 0);
    assert.equal(journal(s), 0);
  } finally {
    await s.cleanup();
  }
});
test('uploads: concurrent identical inline payloads use one file, one byte reservation and independent runs', async () => {
  const s = await setup(vision(), { maxStoredBytesPerSubject: png.length });
  try {
    s.store.publish('owner', makeBundle(agent()));
    const rs = await Promise.all(Array.from({ length: 4 }, () => photo(s)));
    for (const r of rs) assert.equal(r.statusCode, 200, r.body);
    const files = s.store.allRuns().map((r) => r.fileIds[0]);
    assert.equal(files.length, 4);
    assert.equal(new Set(files).size, 1);
    assert.equal(s.driver.calls, 4);
    assert.equal(stored(s), png.length);
    assert.equal(journal(s), 0);
    const key = s.auth.create(
      s.auth.authenticate('Bearer ' + token),
      'other',
      ['agent/test'],
      ['invoke', 'files', 'read'],
    );
    assert.equal((await photo(s, String(key.token))).statusCode, 200);
    assert.equal(stored(s), 2 * png.length);
    assert.equal(new Set(s.store.allRuns().map((r) => r.fileIds[0])).size, 2);
  } finally {
    await s.cleanup();
  }
});
test('uploads: a shared account image survives one waiting key being revoked', async (t) => {
  const s = await setup(vision(), {
    maxStoredBytesPerSubject: png.length,
    platform: { owner: 'owner', registration: 'open' },
  });
  let unlock = () => {};
  try {
    s.store.publish('owner', makeBundle(agent()));
    const platform = s.platform!;
    platform.putListing({ agentId: 'agent/test', price: { perRun: 1 } });
    const acct = await platform.createAccount({
      email: 'upload-fixture@example.test',
      password: 'fixture-only-password',
      credits: 10,
    });
    const a = platform.createKey(acct.id, 'a'),
      b = platform.createKey(acct.id, 'b'),
      k = s.auth.authenticate('Bearer ' + a.token).keyId!;
    let writes = 0,
      checkedB = 0;
    const original = s.store.provisionalInputs.write.bind(s.store.provisionalInputs);
    t.mock.method(s.store.provisionalInputs, 'write', (...args: Parameters<typeof original>) => {
      writes++;
      return original(...args);
    });
    const auth = s.auth.revalidate.bind(s.auth);
    t.mock.method(s.auth, 'revalidate', (header: string | undefined) => {
      if (header === 'Bearer ' + b.token) checkedB++;
      return auth(header);
    });
    unlock = lock(s);
    const one = photo(s, a.token);
    await waitFor(() => writes === 1);
    const two = photo(s, b.token);
    await waitFor(() => checkedB > 0);
    assert.equal((await s.request('GET', '/health')).statusCode, 200);
    unlock();
    s.auth.revoke(s.auth.authenticate('Bearer ' + token), k);
    const [denied, ok] = await Promise.all([one, two]);
    assert.equal(denied.statusCode, 401, denied.body);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(writes, 1);
    assert.equal(s.driver.calls, 1);
    assert.equal(stored(s), png.length);
    assert.equal(platform.account(acct.id).balance, 9);
  } finally {
    unlock();
    await s.cleanup();
  }
});

test('uploads: blocked writes yield to health, expire without a file, and accept a later retry', async (t) => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: 10 }),
    unlock = lock(s);
  try {
    s.store.db.exec('PRAGMA busy_timeout=120');
    const waits: number[] = [],
      exec = s.store.db.exec.bind(s.store.db);
    t.mock.method(s.store.db, 'exec', (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE')
        waits.push(Number(s.store.db.prepare('PRAGMA busy_timeout').get()!.timeout));
      return exec(sql);
    });
    const blocked = put(s, 'tiny', 'hello');
    await waitFor(() => waits.length > 0);
    assert.equal((await s.request('GET', '/health')).statusCode, 200);
    const r = await blocked;
    assert.equal(r.statusCode, 503, r.body);
    assert.equal(r.json().error.code, 'upload_busy');
    assert.equal(r.headers['retry-after'], '1');
    assert.ok(waits.every((n) => n === 0));
    assert.equal(s.store.prepare('PRAGMA busy_timeout').get()!.timeout, 120);
    assert.equal(stored(s), 0);
    assert.equal(journal(s), 0);
    unlock();
    assert.equal((await put(s, 'tiny', 'hello')).statusCode, 200);
    assert.equal(stored(s), 5);
  } finally {
    unlock();
    await s.cleanup();
  }
});

test('uploads: writer waiters are bounded; a disconnected caller gives back its place without a file', async (t) => {
  const s = await setup(),
    base = await s.listen(),
    unlock = lock(s);
  try {
    const take = UploadWaitBudget.prototype.take;
    let waiting = 0;
    t.mock.method(
      UploadWaitBudget.prototype,
      'take',
      function (this: UploadWaitBudget, owner: string, bytes: number) {
        const release = take.call(this, owner, bytes);
        waiting++;
        return () => {
          waiting--;
          return release();
        };
      },
    );
    const stop = new AbortController();
    const aborting = fetch(base + '/v1/files', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'abandoned', content: 'z' }),
      signal: stop.signal,
    }).catch((e: unknown) => e);
    await waitFor(() => waiting === 1);
    const existing = Array.from({ length: 7 }, (_, i) => put(s, 'waiting' + i, 'x'));
    await waitFor(() => waiting === 8);
    const full = await put(s, 'overflow', 'q');
    assert.equal(full.statusCode, 503, full.body);
    assert.equal(full.json().error.code, 'upload_busy');
    stop.abort();
    assert.ok((await aborting) instanceof Error);
    await waitFor(() => waiting === 7);
    const replacement = put(s, 'replacement', 'y');
    await waitFor(() => waiting === 8);
    assert.equal(stored(s), 0);
    unlock();
    for (const r of await Promise.all([...existing, replacement]))
      assert.equal(r.statusCode, 200, r.body);
    assert.equal(stored(s), 8);
    assert.equal(waiting, 0);
    assert.equal(journal(s), 0);
    assert.ok(
      !s.store
        .prepare("SELECT 1 FROM files WHERE json_extract(payload,'$.name')='abandoned'")
        .get(),
    );
  } finally {
    unlock();
    await s.cleanup();
  }
});

test('uploads: revocation after the byte reservation prevents explicit publication', async (t) => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: 10 });
  try {
    const admin = s.auth.authenticate('Bearer ' + token),
      k = s.auth.create(admin, 'temp', ['*'], ['files']);
    const db = s.store.db;
    let armed = false,
      revoked = false;
    db.function('reserved', () => {
      armed = true;
      return 1;
    });
    db.exec(
      'CREATE TEMP TRIGGER revoke_after_reserve AFTER INSERT ON oaa_inline_inputs BEGIN SELECT reserved(); END;',
    );
    const exec = db.exec.bind(db);
    t.mock.method(db, 'exec', (sql: string) => {
      exec(sql);
      if (sql === 'COMMIT' && armed) {
        armed = false;
        s.auth.revoke(admin, String(k.id));
        revoked = true;
      }
    });
    const denied = await put(s, 'private', 'hello', String(k.token));
    assert.equal(denied.statusCode, 401, denied.body);
    assert.ok(revoked);
    await waitFor(() => journal(s) === 0);
    assert.equal(stored(s), 0);
  } finally {
    await s.cleanup();
  }
});
test('uploads: malformed sizes fail quota checks closed; digest seeks exclude other subjects, artifacts and node-bound inputs', async () => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: 1000 });
  try {
    const subject = principalSubject(s.auth.authenticate('Bearer ' + token)),
      same = 'indexed',
      bytes = Buffer.from(same);
    const restricted = await s.store.addFile(
      'owner',
      'restricted',
      bytes,
      ['local'],
      undefined,
      subject,
    );
    await s.store.addFile('owner', 'other', bytes, undefined, undefined, 'other-subject');
    s.store.publish('owner', makeBundle(agent()));
    const run = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'fixture artifact',
    });
    await s.store.addFile('owner', 'artifact', bytes, undefined, run.json().id);
    assert.equal(
      storedUploadCopy(s.store, 'owner', subject, restricted.sha256, bytes.length),
      undefined,
    );
    s.store
      .prepare(
        "INSERT INTO files(id,owner,subject,payload) VALUES('legacy-bad','owner',?,'unreadable')",
      )
      .run(subject);
    assert.equal(
      storedUploadCopy(s.store, 'owner', subject, restricted.sha256, bytes.length),
      undefined,
    );
    const error = await put(s, 'new', 'x');
    assert.equal(error.statusCode, 500, error.body);
    assert.equal(error.json().error.code, 'persistence_failed');
    s.store.prepare("DELETE FROM files WHERE id='legacy-bad'").run();
    const allowed = await s.store.addFile('owner', 'allowed', bytes, undefined, undefined, subject);
    await s.store.addFile('owner', 'second regular copy', bytes, undefined, undefined, subject);
    const sql: string[] = [],
      statements = {
        db: s.store.db,
        prepare: (q: string) => {
          sql.push(q);
          return s.store.prepare(q);
        },
      };
    assert.equal(
      storedUploadCopy(statements, 'owner', subject, allowed.sha256, bytes.length),
      allowed.id,
    );
    checkUploadRoom(statements, 'owner', subject, 0, 1000);
    const lookup = s.store
      .prepare('EXPLAIN QUERY PLAN ' + sql[0])
      .all('owner', subject, allowed.sha256, bytes.length);
    assert.ok(
      lookup.some(
        (p) =>
          String(p.detail).includes('file_upload_facts') && String(p.detail).includes('<expr>='),
      ),
    );
    const plan = (prefix: string) =>
      s.store
        .prepare('EXPLAIN QUERY PLAN ' + sql.find((q) => q.startsWith(prefix))!)
        .all({ owner: 'owner', subject })
        .map((p) => String(p.detail));
    assert.ok(
      plan('INSERT OR REPLACE INTO temp.oaa_upload_usage').some((p) =>
        p.includes('COVERING INDEX file_owner_subject'),
      ),
    );
    const warm = plan('SELECT used,(');
    assert.ok(warm.some((p) => p.includes('oaa_upload_reservations')));
    assert.ok(
      !warm.some((p) => p.includes('file_upload_facts') || p.includes('file_owner_subject')),
    );
  } finally {
    await s.cleanup();
  }
});

for (const mode of ['committed', 'rolled-back', 'unreadable'] as const)
  test(`uploads: ambiguous file publication is reconciled without another write (${mode})`, async (t) => {
    const s = await setup();
    try {
      const db = s.store.db;
      let armed = false,
        lost = false;
      db.function('mark_upload', () => {
        armed = true;
        return 1;
      });
      db.exec(
        'CREATE TEMP TRIGGER track_file AFTER INSERT ON files BEGIN SELECT mark_upload(); END',
      );
      const io = () =>
        Object.assign(new Error('fixture lost acknowledgement'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 10,
        });
      const exec = db.exec.bind(db);
      t.mock.method(db, 'exec', (sql: string) => {
        if (armed && sql === 'COMMIT') {
          armed = false;
          exec(mode === 'rolled-back' ? 'ROLLBACK' : 'COMMIT');
          lost = true;
          throw io();
        }
        return exec(sql);
      });
      const prepare = db.prepare.bind(db);
      t.mock.method(db, 'prepare', (sql: string) => {
        const st = prepare(sql);
        if (
          sql.includes('SELECT 1 FROM files WHERE id=? AND owner=? AND subject=?') &&
          sql.includes('sha256')
        ) {
          const get = st.get.bind(st);
          t.mock.method(st, 'get', (...args: Parameters<StatementSync['get']>) => {
            if (lost && mode === 'unreadable') throw io();
            return get(...args);
          });
        }
        return st;
      });
      const r = await put(s, 'pending', 'data');
      if (mode === 'committed') {
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(s.store.file(r.json().id, 'owner').bytes, 4);
      }
      if (mode === 'rolled-back') {
        assert.equal(r.statusCode, 500, r.body);
        assert.equal(stored(s), 0);
      }
      if (mode === 'unreadable') {
        assert.equal(r.statusCode, 409, r.body);
        assert.equal(r.json().error.code, 'file_commit_unconfirmed');
        assert.equal(r.headers['x-should-retry'], 'false');
        assert.equal(s.store.file(r.json().error.file_id, 'owner').bytes, 4);
      }
      await waitFor(() => journal(s) === 0);
      assert.equal(stored(s), mode === 'rolled-back' ? 0 : 4);
    } finally {
      await s.cleanup();
    }
  });
