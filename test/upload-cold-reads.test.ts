import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as turn } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store/store.js';
import { ColdUploadReads } from '../src/store/upload-cold-reads.js';
import {
  databaseIdentity,
  readCommittedBatch,
  type ReadRequest,
} from '../src/store/upload-read-worker.js';
import { assertUploadRoom } from '../src/gateway/upload-quota.js';
import { principalSubject } from '../src/core/contracts.js';
import { setup, token, secondToken, waitFor } from './helpers.js';

const count = 4200;
function seed(s: Store, owner: string, subject: string, prefix = owner + '-history-') {
  s.prepare(
    `WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<?)
    INSERT INTO files(id,owner,subject,payload) SELECT ?||n,?,?,'{"bytes":1}' FROM nums`,
  ).run(count, prefix, owner, subject);
}
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa-cold-read-'));
  const s = new Store(root),
    file = path.join(root, 'state.sqlite');
  const other = new DatabaseSync(file);
  const bind = {
    file,
    identity: databaseIdentity(file),
    lease: String(s.prepare('SELECT lease_id FROM gateway_owner').get()!.lease_id),
  };
  const calls: { request: ReadRequest; finish: () => void }[] = [];
  const readers = new ColdUploadReads(s, {
    read(request) {
      const used = readCommittedBatch(bind, [request])[0]!.used,
        p = Promise.withResolvers<typeof used>();
      calls.push({ request, finish: () => p.resolve(used) });
      return p.promise;
    },
    async close() {
      for (const call of calls) call.finish();
    },
  });
  t.after(async () => {
    await readers.close();
    other.close();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const principal = {
    owner: 'big',
    name: 'key',
    scopes: ['files' as const],
    agents: ['*'],
    subject: 's',
  };
  const check = (incoming: number, limit: number, guard?: () => void, retained = incoming) =>
    assertUploadRoom(
      s,
      { maxStoredBytesPerSubject: limit },
      principal,
      incoming,
      readers,
      guard,
      retained,
    );
  return { s, other, bind, readers, calls, check };
}

test('cold quota: share only the read, not the grant or byte decision; small and hot callers need no thread', async (t) => {
  const { s, check, calls } = fixture(t);
  assert.equal(check(0, 0), undefined);
  seed(s, 'big', 's');
  // A new connection has no learned total, just as after a gateway restart.
  s.db.exec('DELETE FROM temp.oaa_upload_usage');
  let revoked = false;
  const a = check(1, count + 1, () => {
    if (revoked) throw Error('grant revoked');
  })!;
  const denied = check(2, count + 1)!;
  const admitted = check(1, count + 1)!;
  assert.equal(calls.length, 1);
  revoked = true;
  calls[0]!.finish();
  await Promise.all([
    assert.rejects(a, /grant revoked/),
    assert.rejects(denied, { code: 'storage_quota_exceeded' }),
    admitted,
  ]);
  assert.equal(check(0, count), undefined);
  assert.equal(calls.length, 1);
});
for (const changed of ['same-owner', 'external', 'replace', 'invalid'] as const)
  test('cold quota: stale result discarded after ' + changed + ' write', async (t) => {
    const { s, other, calls, check } = fixture(t);
    seed(s, 'big', 's');
    const checking = check(0, count)!;
    const observed = assert.rejects(checking, {
      code: changed === 'invalid' ? 'persistence_failed' : 'storage_quota_exceeded',
    });
    if (changed === 'replace')
      s.db.exec(
        `INSERT OR REPLACE INTO files(id,owner,subject,payload) VALUES('big-history-1','big','s','{"bytes":67}')`,
      );
    else
      (changed === 'external' ? other : s.db)
        .prepare("INSERT INTO files VALUES('late','big',?,'s')")
        .run(changed === 'invalid' ? 'bad' : '{"bytes":66}');
    calls[0]!.finish();
    await turn();
    assert.equal(calls.length, 2);
    calls[1]!.finish();
    await observed;
    assert.equal(
      s.prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage WHERE scan IS NOT NULL').get()!.n,
      0,
    );
  });
test('cold quota: reservations stay live; a rolled-back change or another local owner does not restart the scan', async (t) => {
  const { s, check, calls } = fixture(t);
  seed(s, 'big', 's');
  const observed = assert.rejects(check(1, count + 1)!, { code: 'storage_quota_exceeded' });
  s.db.exec(`BEGIN; DELETE FROM files WHERE id='big-history-1'; ROLLBACK;
    INSERT INTO files VALUES('else','other','{"bytes":99}','s');`);
  s.prepare(
    `INSERT INTO oaa_inline_inputs(file_id,owner,subject,bytes,digest,identity,phase)
    VALUES(?,'big','s',1,'d','i','writing')`,
  ).run('file_' + '0'.repeat(32));
  calls[0]!.finish();
  await observed;
  assert.equal(calls.length, 1);
  s.db.exec('DELETE FROM oaa_inline_inputs');
  assert.equal(check(1, count + 1), undefined);
});
test('cold quota: sustained invalidation falls back to original records, never to a stale total', async (t) => {
  const { s, calls, check } = fixture(t);
  seed(s, 'big', 's');
  const observed = assert.rejects(check(1, count + 1)!, { code: 'storage_quota_exceeded' });
  for (let i = 0; i < 2; i++) {
    s.prepare("INSERT INTO files VALUES(?,'big','{\"bytes\":1}','s')").run('extra' + i);
    calls[i]!.finish();
    await turn();
  }
  await observed;
  assert.equal(calls.length, 2);
  assert.equal(check(0, count + 2), undefined);
});
test('cold quota: the retained buffer and subscriber count are bounded; shutdown rejects pending callers', async (t) => {
  const { s, calls, check, readers } = fixture(t);
  seed(s, 'big', 's');
  const blocked = Array.from({ length: 8 }, () =>
    assert.rejects(check(0, count, undefined, 4 * 1024 ** 2)!, { code: 'shutting_down' }),
  );
  assert.throws(() => check(0, count), { code: 'upload_busy' });
  assert.equal(calls.length, 1);
  await readers.close();
  await Promise.all(blocked);
  assert.equal(s.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
  assert.throws(() => check(0, count), { code: 'shutting_down' });
});
test('cold quota: a reader needs both the original file identity and live lease', (t) => {
  const { s, bind } = fixture(t);
  seed(s, 'big', 's');
  const req = { id: 'fixture', owner: 'big', subject: 's' };
  assert.equal(readCommittedBatch(bind, [req])[0]!.used, count);
  assert.equal(readCommittedBatch({ ...bind, identity: 'different' }, [req])[0]!.used, undefined);
  assert.equal(readCommittedBatch({ ...bind, lease: 'different' }, [req])[0]!.used, undefined);
});
test('cold quota: disconnect releases the buffered request, not unbounded extra jobs', async (t) => {
  const { s, calls, readers } = fixture(t);
  for (let i = 0; i < 9; i++) seed(s, 'big', String(i), 'subject-' + i + '-');
  for (let i = 0; i < 8; i++) {
    let closed = false,
      notify = () => {},
      removed = false;
    const guard = Object.assign(
      () => {
        if (closed) throw Error('client disconnected');
      },
      {
        onDisconnect: (f: () => void) => {
          notify = f;
          return () => {
            removed = true;
          };
        },
      },
    );
    const wait = readers.warm('big', String(i), 32 * 1024 ** 2, guard)!;
    const denied = assert.rejects(wait, /client disconnected/);
    closed = true;
    notify();
    await denied;
    assert.ok(removed);
  }
  assert.equal(calls.length, 8);
  assert.throws(() => readers.warm('big', '8', 1), { code: 'upload_busy' });
  calls[0]!.finish();
  await turn();
  const ninth = readers.warm('big', '8', 1)!;
  assert.equal(calls.length, 9);
  for (const call of calls) call.finish();
  await ninth;
});

test(
  'cold quota: an unresponsive helper cannot deny an otherwise valid upload or admit an extra byte',
  { timeout: 20000 },
  async (t) => {
    const s = await setup(undefined, { maxStoredBytesPerSubject: count + 1 });
    try {
      seed(s.store, 'owner', principalSubject(s.auth.authenticate('Bearer ' + token)));
      const post = Worker.prototype.postMessage;
      let dropped = 0;
      t.mock.method(
        Worker.prototype,
        'postMessage',
        function (this: Worker, ...args: Parameters<typeof post>) {
          if (args[0]?.owner === 'owner') {
            dropped++;
            return;
          }
          return post.apply(this, args);
        },
      );
      const one = s.request('POST', '/v1/files', { filename: 'one', content: 'a' });
      await waitFor(() => dropped === 1);
      assert.equal((await s.request('GET', '/health')).statusCode, 200);
      const ok = await one;
      assert.equal(ok.statusCode, 200, ok.body);
      const overflow = await s.request('POST', '/v1/files', { filename: 'over', content: 'b' });
      assert.equal(overflow.statusCode, 413, overflow.body);
      assert.equal(dropped, 1);
      assert.equal(
        s.store
          .prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage WHERE scan IS NOT NULL')
          .get()!.n,
        0,
      );
    } finally {
      await s.cleanup();
    }
  },
);
test('cold quota: an unrelated HTTP upload finishes while a slow caller waits; revocation prevents publication', async (t) => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: count + 70 });
  let resume: (() => void) | undefined;
  try {
    const admin = s.auth.authenticate('Bearer ' + token);
    const key = s.auth.create(admin, 'slow', ['*'], ['files']);
    const p = s.auth.authenticate('Bearer ' + key.token),
      subject = principalSubject(p);
    seed(s.store, p.owner, subject);
    const post = Worker.prototype.postMessage;
    t.mock.method(
      Worker.prototype,
      'postMessage',
      function (this: Worker, ...args: Parameters<typeof post>) {
        if (args[0]?.subject === subject && !resume) {
          resume = () => post.apply(this, args);
          return;
        }
        return post.apply(this, args);
      },
    );
    const pending = s.request(
      'POST',
      '/v1/files',
      { filename: 'no-publish', content: 'private' },
      String(key.token),
    );
    await waitFor(() => !!resume);
    const quiet = await s.request(
      'POST',
      '/v1/files',
      { filename: 'quiet', content: 'keep' },
      secondToken,
    );
    assert.equal(quiet.statusCode, 200, quiet.body);
    s.auth.revoke(admin, String(key.id));
    resume!();
    const denied = await pending;
    assert.equal(denied.statusCode, 401, denied.body);
    assert.equal(
      s.store
        .prepare('SELECT count(*) AS n FROM files WHERE owner=? AND subject=?')
        .get(p.owner, subject)!.n,
      count,
    );
    assert.equal(
      (await s.request('GET', '/v1/files/' + quiet.json().id + '/content', undefined, secondToken))
        .body,
      'keep',
    );
  } finally {
    await s.cleanup();
  }
});
test('cold quota: real multipart and JSON first uploads compete for the same last bytes', async () => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: count + 70 });
  try {
    const subject = principalSubject(s.auth.authenticate('Bearer ' + token));
    seed(s.store, 'owner', subject);
    const base = await s.listen(),
      form = new FormData();
    form.append('file', new Blob(['y'.repeat(70)]), 'b');
    const [a, b] = await Promise.all([
      s.request('POST', '/v1/files', { filename: 'a', content: 'x'.repeat(70) }),
      fetch(base + '/v1/files', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: form,
      }),
    ]);
    const j = await b.json();
    assert.deepEqual([a.statusCode, b.status].sort(), [200, 413]);
    assert.equal((a.statusCode === 413 ? a.json() : j).error.code, 'storage_quota_exceeded');
    assert.equal(
      s.store.prepare("SELECT sum(json_extract(payload,'$.bytes')) AS n FROM files").get()!.n,
      count + 70,
    );
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
  } finally {
    await s.cleanup();
  }
});
