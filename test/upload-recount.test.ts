import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store/store.js';
import { checkUploadRoom } from '../src/store/upload-budget.js';
import { ColdUploadReads } from '../src/store/upload-cold-reads.js';
import { UploadRecounts } from '../src/store/upload-recount.js';
import { readUsagePage } from '../src/store/upload-usage-page.js';
import { coldReadRows, UploadRecountRequired } from '../src/store/upload-usage.js';
import { principalSubject } from '../src/core/contracts.js';
import { setup, token, waitFor } from './helpers.js';

const scope = { owner: 'o', subject: 's' };
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa-quota-slice-')),
    s = new Store(root),
    other = new DatabaseSync(path.join(root, 'state.sqlite'));
  t.after(() => {
    other.close();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { s, other };
}
function history(s: Store, owner = 'o', subject = 's', n = coldReadRows + 99) {
  s.prepare(
    `WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<?)
    INSERT INTO files(id,owner,subject,payload) SELECT ?||n,?,?,'{"bytes":1}' FROM nums`,
  ).run(n, owner + '-', owner, subject);
  return n;
}
function exact(s: Store, owner: string, subject: string, n: number) {
  checkUploadRoom(s, owner, subject, 0, n, true);
  assert.throws(() => checkUploadRoom(s, owner, subject, 1, n, true), {
    code: 'storage_quota_exceeded',
  });
}

test('quota slices: all continuations seek the existing index and partition nullable, repeated and binary keys exactly', (t) => {
  const { s } = fixture(t),
    ins = s.prepare(
      'INSERT INTO files(rowid,id,owner,subject,payload) VALUES(?,?,?,?,CAST(? AS TEXT))',
    );
  ins.setReadBigInts(true);
  let expected = 0;
  for (let i = 0; i < 139; i++) {
    const rowid = i === 0 ? -(2n ** 63n) : i === 1 ? 2n ** 63n - 1n : 2n ** 53n + BigInt(i);
    const bytes = i % 5,
      sha256 = ['a'.repeat(64), 'x'.repeat(64) + '\u0000tail', 'é'.repeat(64)][i % 3];
    const payload = JSON.stringify({
      bytes,
      sha256,
      ...(i % 6 === 0 ? { allowedNodes: ['local'] } : i % 7 === 0 ? { runId: 'kept' } : {}),
    });
    ins.run(rowid, 'f' + i, 'o', 's', payload);
    expected += bytes;
  }
  // Historical TEXT may contain non-UTF-8 bytes. A resume key must not be normalized by JS.
  for (let i = 0; i < 8; i++) {
    const p = Buffer.concat([
      Buffer.from('{"bytes":7,"sha256":"' + 'z'.repeat(63)),
      Buffer.from([0x90 + i]),
      Buffer.from('"}'),
    ]);
    ins.run(-10 - i, 'b' + i, 'o', 's', p);
    expected += 7;
  }
  ins.run(0, 'foreign', 'o', 'other', '{"bytes":999}');
  ins.run(1, 'foreign2', 'other', 's', 'bad');
  const variants = new Set<string>(),
    prepare = s.prepare.bind(s);
  t.mock.method(s, 'prepare', (sql: string) => {
    if (!variants.has(sql)) {
      variants.add(sql);
      const args = {
        ...scope,
        take: 3,
        ...(sql.includes(':hash') && { hash: null }),
        ...(sql.includes(':size') && { size: 1 }),
        ...(sql.includes(':rid') && { rid: '0' }),
      };
      const plan = prepare('EXPLAIN QUERY PLAN ' + sql)
        .all(args)
        .map((r) => String(r.detail));
      const seeks = plan.filter((d) => d.includes('SEARCH main.files'));
      assert.ok(
        seeks.length > 0 && seeks.every((d) => d.includes('COVERING INDEX file_upload_facts')),
        plan.join('\n'),
      );
      assert.ok(
        !plan.some(
          (d) =>
            (d.includes('TEMP B-TREE') && !d.includes('json_group_array(ORDER BY)')) ||
            d.includes('SCAN main.files'),
        ),
        plan.join('\n'),
      );
      if (sql.includes(':rid')) assert.ok(seeks.every((d) => d.includes('rowid>?')));
      else if (sql.includes(':hash')) assert.ok(seeks.every((d) => d.includes('<expr>>?')));
    }
    return prepare(sql);
  });
  for (const limit of [1, 2, 5, 13, 41, 147, 512]) {
    let after: ReturnType<typeof readUsagePage>['next'],
      sum = 0,
      pages = 0;
    do {
      const page = readUsagePage(s, scope, limit, after);
      assert.notEqual(page.bytes, null);
      sum += page.bytes!;
      after = page.next;
      assert.ok(++pages <= 148, 'a page must advance');
    } while (after);
    assert.equal(sum, expected);
  }
  assert.equal(variants.size, 4);
});

test('quota slices: competing cold callers take turns without holding the writer or exposing partial sums', async (t) => {
  const { s, other } = fixture(t),
    n = history(s);
  history(s, 'b');
  const jobs = new UploadRecounts(),
    visits: string[] = [];
  const check = (owner: string) => () => {
    assert.equal(s.db.isTransaction, false);
    other.exec('BEGIN IMMEDIATE; ROLLBACK');
    visits.push(owner);
    if (visits.filter((v) => v === owner).length === 2)
      assert.throws(() => checkUploadRoom(s, owner, 's', 1, n, true), UploadRecountRequired);
  };
  await Promise.all(['o', 'b'].map((owner) => jobs.fill(s, owner, 's', check(owner))));
  assert.deepEqual(visits.slice(0, 4), ['o', 'b', 'o', 'b']);
  exact(s, 'o', 's', n);
  exact(s, 'b', 's', n);
});

for (const writer of ['same connection', 'external'] as const)
  test('quota slices: discard previously counted pages on edit (' + writer + ')', async (t) => {
    const { s, other } = fixture(t),
      n = history(s),
      db = writer === 'external' ? other : s.db;
    let slices = 0;
    await new UploadRecounts().fill(s, 'o', 's', () => {
      if (++slices === 2) db.exec(`UPDATE files SET payload='{"bytes":72}' WHERE id='o-1'`);
    });
    exact(s, 'o', 's', n + 71);
  });

for (const problem of ['unknown size', 'overflow'] as const)
  test(
    'quota slices: ' +
      problem +
      ' in a later page stays unknown rather than wrapping or granting room',
    async (t) => {
      const { s } = fixture(t);
      history(s);
      s.prepare('INSERT INTO files VALUES(?,?,?,?)').run(
        'bad-tail',
        'o',
        JSON.stringify({
          sha256: 'f'.repeat(64),
          bytes: problem === 'overflow' ? Number.MAX_SAFE_INTEGER : '1',
        }),
        's',
      );
      let slices = 0;
      await new UploadRecounts().fill(s, 'o', 's', () => {
        slices++;
      });
      assert.ok(slices > 1);
      assert.throws(() => checkUploadRoom(s, 'o', 's', 0, Number.MAX_SAFE_INTEGER, true), {
        code: 'persistence_failed',
      });
    },
  );

test('quota slices: closing the gateway during fallback discards its unfinished ticket before another slice', async (t) => {
  const { s } = fixture(t);
  history(s);
  const readers = new ColdUploadReads(s, {
    read: async () => undefined,
    close: async () => {},
  });
  const prepare = s.prepare.bind(s);
  let scheduled = false,
    closed: Promise<void> | undefined;
  t.mock.method(s, 'prepare', (sql: string) => {
    if (!scheduled && sql.startsWith('SELECT count(*) AS rows,')) {
      scheduled = true;
      setImmediate(() => {
        closed = readers.close();
      });
    }
    return prepare(sql);
  });
  try {
    await assert.rejects(readers.warm('o', 's', 1)!, { code: 'shutting_down' });
    assert.ok(closed);
    await closed;
    assert.equal(s.prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage').get()!.n, 0);
    assert.equal(s.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
  } finally {
    await readers.close();
  }
});

test('quota slices: repeated contention returns retryable busy, no ticket or charge, then a clean retry succeeds', async (t) => {
  const { s, other } = fixture(t),
    n = history(s);
  const job = new UploadRecounts();
  let changes = 0;
  await assert.rejects(
    job.fill(s, 'o', 's', () => {
      if (
        s.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name='oaa_upload_usage'").get() &&
        s.prepare('SELECT 1 FROM temp.oaa_upload_usage WHERE scan IS NOT NULL').get()
      ) {
        changes++;
        other.exec(
          `UPDATE files SET payload=json_set(payload,'$.bytes',json_extract(payload,'$.bytes')+1) WHERE id='o-1'`,
        );
      }
    }),
    { code: 'upload_busy', status: 503, retryAfterSeconds: 1 },
  );
  assert.equal(changes, 3);
  assert.equal(
    s.prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage WHERE scan IS NOT NULL').get()!.n,
    0,
  );
  assert.equal(s.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
  await job.fill(s, 'o', 's', () => {});
  exact(s, 'o', 's', n + changes);
});

for (const keep of [false, true])
  test(
    'quota slices: disconnect during fallback (' +
      (keep ? 'one subscriber stays' : 'all subscribers leave') +
      ')',
    async (t) => {
      const { s } = fixture(t),
        n = history(s);
      const readers = new ColdUploadReads(s, {
        read: async () => undefined,
        close: async () => {},
      });
      const a = new AbortController(),
        b = new AbortController();
      const grant = (ac: AbortController) =>
        Object.assign(
          () => {
            if (ac.signal.aborted) throw Error('disconnected');
          },
          {
            onDisconnect: (f: () => void) => {
              ac.signal.addEventListener('abort', f);
              return () => ac.signal.removeEventListener('abort', f);
            },
          },
        );
      const prepare = s.prepare.bind(s);
      let queries = 0;
      t.mock.method(s, 'prepare', (sql: string) => {
        if (sql.startsWith('SELECT count(*) AS rows,') && ++queries === 1)
          setImmediate(() => {
            a.abort();
            if (!keep) b.abort();
          });
        return prepare(sql);
      });
      try {
        const one = assert.rejects(readers.warm('o', 's', 1, grant(a))!, /disconnected/);
        const two = readers.warm('o', 's', 1, grant(b))!;
        await Promise.all([one, keep ? two : assert.rejects(two, /disconnected/)]);
        await waitFor(
          () => !prepare('SELECT 1 FROM temp.oaa_upload_usage WHERE scan IS NOT NULL').get(),
        );
        if (keep) {
          assert.ok(queries > 1);
          exact(s, 'o', 's', n);
        } else {
          assert.equal(queries, 1);
          assert.equal(prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage').get()!.n, 0);
        }
      } finally {
        await readers.close();
      }
    },
  );

test('quota HTTP: a changing degraded catalog returns Retry-After without accepting the file', async (t) => {
  const n = coldReadRows + 10,
    s = await setup(undefined, { maxStoredBytesPerSubject: n + 4 });
  const subject = principalSubject(s.auth.authenticate('Bearer ' + token)),
    other = new DatabaseSync(path.join(s.store.root, 'state.sqlite'));
  try {
    history(s.store, 'owner', subject, n);
    const post = Worker.prototype.postMessage;
    t.mock.method(
      Worker.prototype,
      'postMessage',
      function (this: Worker, ...args: Parameters<typeof post>) {
        if (args[0]?.subject === subject) {
          setImmediate(() => {
            this.emit('message', { ready: 2 });
            this.emit('message', { kind: 'done', id: args[0].id });
          });
          return;
        }
        return post.apply(this, args);
      },
    );
    const prepare = s.store.prepare.bind(s.store);
    let changed = 0;
    t.mock.method(s.store, 'prepare', (sql: string) => {
      if (
        sql.startsWith(
          'SELECT 1 FROM temp.oaa_upload_usage WHERE owner=? AND subject=? AND scan=?',
        ) &&
        changed < 3
      ) {
        changed++;
        other.exec(
          "UPDATE files SET payload=json_set(payload,'$.bytes',json_extract(payload,'$.bytes')+1) WHERE id='owner-1'",
        );
      }
      return prepare(sql);
    });
    const put = () => s.request('POST', '/v1/files', { filename: 'one', content: 'x' });
    const refused = await put();
    assert.equal(changed, 3);
    assert.equal(refused.statusCode, 503, refused.body);
    assert.equal(refused.json().error.code, 'upload_busy');
    assert.equal(refused.headers['retry-after'], '1');
    assert.equal(prepare('SELECT count(*) AS n FROM files').get()!.n, n);
    assert.equal(prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
    const ok = await put();
    assert.equal(ok.statusCode, 200, ok.body);
    exact(s.store, 'owner', subject, n + 4);
  } finally {
    other.close();
    await s.cleanup();
  }
});

for (const over of [false, true])
  test(
    'quota admission: stale preflight releases the writer before rechecking (' +
      (over ? 'denied' : 'accepted') +
      ')',
    async (t) => {
      const n = coldReadRows + 33,
        s = await setup(undefined, { maxStoredBytesPerSubject: n + 10 }),
        subject = principalSubject(s.auth.authenticate('Bearer ' + token));
      const other = new DatabaseSync(path.join(s.store.root, 'state.sqlite'));
      try {
        history(s.store, 'owner', subject, n);
        checkUploadRoom(s.store, 'owner', subject, 1, n + 10);
        const write = s.store.provisionalInputs.write.bind(s.store.provisionalInputs);
        t.mock.method(s.store.provisionalInputs, 'write', (...args: Parameters<typeof write>) => {
          other
            .prepare('INSERT INTO files VALUES(?,?,?,?)')
            .run('arrived', 'owner', JSON.stringify({ bytes: over ? 10 : 9 }), subject);
          return write(...args);
        });
        let retried = 0,
          receipts = 0;
        s.store.db.function('noted_reserve', () => {
          receipts++;
          return 0;
        });
        s.store.db.exec(
          'CREATE TEMP TRIGGER count_reserve AFTER INSERT ON main.oaa_inline_inputs BEGIN SELECT noted_reserve(); END;',
        );
        const retry = ColdUploadReads.prototype.retry;
        t.mock.method(
          ColdUploadReads.prototype,
          'retry',
          function (this: ColdUploadReads, ...args: Parameters<typeof retry>) {
            assert.equal(s.store.db.isTransaction, false);
            other.exec('BEGIN IMMEDIATE; ROLLBACK');
            assert.equal(receipts, 0);
            retried++;
            return retry.apply(this, args);
          },
        );
        const r = await s.request('POST', '/v1/files', { filename: 'one', content: 'x' });
        assert.equal(r.statusCode, over ? 413 : 200, r.body);
        if (over) assert.equal(r.json().error.code, 'storage_quota_exceeded');
        assert.equal(retried, 1);
        assert.equal(receipts, over ? 0 : 1);
        exact(s.store, 'owner', subject, n + 10);
        assert.equal(s.store.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
      } finally {
        other.close();
        await s.cleanup();
      }
    },
  );
