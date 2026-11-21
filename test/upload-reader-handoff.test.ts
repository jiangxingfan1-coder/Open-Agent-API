import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store/store.js';
import { ColdUploadReads } from '../src/store/upload-cold-reads.js';
import { checkUploadRoom } from '../src/store/upload-budget.js';
import { databaseIdentity, readerProtocol } from '../src/store/upload-read-worker.js';
import { observeReader } from './fixtures/upload-reader-probe.js';
import { setup, waitFor } from './helpers.js';
import { readUsagePage, type UsagePrefix } from '../src/store/upload-usage-page.js';

const n = 5400,
  scope = { owner: 'o', subject: 's' };
test('reader handoff: older gateways receive a terminal legacy reply, never an intermediate frame', async () => {
  const worker = new Worker(new URL('../src/store/upload-read-worker.js', import.meta.url), {
    workerData: { role: 'oaa.upload-usage' },
    execArgv: [],
  });
  try {
    const answer = once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    worker.postMessage({ id: 'legacy-id', ...scope });
    assert.deepEqual((await answer)[0], { id: 'legacy-id' });
  } finally {
    await worker.terminate();
  }
});
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaa-prefix-')),
    s = new Store(root, { cappedUploads: true }),
    other = new DatabaseSync(path.join(root, 'state.sqlite'));
  s.prepare(
    `WITH RECURSIVE nums(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM nums WHERE i<?)
    INSERT INTO files(id,owner,subject,payload) SELECT 'f'||i,'o','s','{"bytes":1}' FROM nums`,
  ).run(n);
  t.after(() => {
    other.close();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { s, other };
}
for (const chargePages of [false, true])
  test(
    'reader handoff: byte-order checkpoints require explicit wire capability (' + chargePages + ')',
    async (t) => {
      const { s } = fixture(t);
      s.db.exec("UPDATE files SET owner='owner'");
      const file = path.join(s.root, 'state.sqlite'),
        probe = observeReader(path.join(s.root, 'unused-gate'), 'exit');
      const worker = new Worker(new URL('../src/store/upload-read-worker.js', import.meta.url), {
        workerData: {
          role: 'oaa.upload-usage',
          protocol: readerProtocol,
          ...(chargePages && { chargePages: true }),
          binding: {
            file,
            identity: databaseIdentity(file),
            lease: s.prepare('SELECT lease_id FROM gateway_owner WHERE slot=1').get()!.lease_id,
          },
        },
        execArgv: [],
      });
      try {
        const done = once(worker, 'exit', { signal: AbortSignal.timeout(15000) });
        worker.postMessage({ id: 'negotiated-prefix', owner: 'owner', subject: 's' });
        await done;
        assert.ok(probe.checkpointRows() > 0);
        assert.equal(probe.checkpointOrder(), chargePages ? 'charge-ties' : 'ties');
      } finally {
        await worker.terminate();
        probe.restore();
      }
    },
  );
for (const mode of ['current', 'local-edit', 'external-edit', 'evicted', 'invalid-prefix'] as const)
  test(
    'reader handoff: resume only under the originating scope ticket (' + mode + ')',
    async (t) => {
      const { s, other } = fixture(t),
        firstPages: boolean[] = [],
        prepare = s.prepare.bind(s);
      t.mock.method(s, 'prepare', (sql: string) => {
        if (sql.startsWith('SELECT count(*) AS rows,'))
          firstPages.push(!sql.includes(':hash') && !sql.includes(':size'));
        return prepare(sql);
      });
      const readers = new ColdUploadReads(s, {
        async read() {
          const p = readUsagePage(other, scope, 512);
          assert.ok(p.next);
          assert.equal(p.bytes, 512);
          if (mode === 'local-edit' || mode === 'external-edit')
            (mode === 'local-edit' ? s.db : other).exec(
              `UPDATE files SET payload='{"bytes":31}' WHERE id='f1'`,
            );
          if (mode === 'evicted') s.db.exec('DELETE FROM temp.oaa_upload_usage');
          return {
            rows: 512,
            bytes: mode === 'invalid-prefix' ? -1 : 512,
            next: p.next,
          } satisfies UsagePrefix;
        },
        async close() {},
      });
      try {
        await readers.warm('o', 's', 1);
        assert.ok(firstPages.length);
        assert.equal(firstPages[0], mode !== 'current');
        const expected = n + (mode === 'local-edit' || mode === 'external-edit' ? 30 : 0);
        checkUploadRoom(s, 'o', 's', 0, expected, true);
        assert.throws(() => checkUploadRoom(s, 'o', 's', 1, expected, true), {
          code: 'storage_quota_exceeded',
        });
        assert.equal(
          prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage WHERE scan IS NOT NULL').get()!
            .n,
          0,
        );
      } finally {
        await readers.close();
      }
    },
  );

test('reader handoff: only the departure of the last subscriber asks the helper to release its work', async (t) => {
  const { s } = fixture(t),
    pending = Promise.withResolvers<undefined>();
  let abandoned = 0;
  const readers = new ColdUploadReads(s, {
    read: () => pending.promise,
    abandon: (o, sub) => {
      assert.deepEqual([o, sub], ['o', 's']);
      abandoned++;
      pending.resolve(undefined);
    },
    async close() {
      pending.resolve(undefined);
    },
  });
  const grant = (ac: AbortController) =>
    Object.assign(
      () => {
        if (ac.signal.aborted) throw Error('gone');
      },
      {
        onDisconnect: (fn: () => void) => {
          ac.signal.addEventListener('abort', fn);
          return () => ac.signal.removeEventListener('abort', fn);
        },
      },
    );
  try {
    const a = new AbortController(),
      b = new AbortController();
    const one = assert.rejects(readers.warm('o', 's', 11, grant(a))!, /gone/);
    const two = assert.rejects(readers.warm('o', 's', 12, grant(b))!, /gone/);
    a.abort();
    await one;
    assert.equal(abandoned, 0);
    b.abort();
    await two;
    assert.equal(abandoned, 1);
  } finally {
    await readers.close();
  }
  assert.equal(
    s.prepare('SELECT count(*) AS n FROM temp.oaa_upload_usage WHERE scan IS NOT NULL').get()!.n,
    0,
  );
});

test(
  'reader handoff: shutdown retains the store lease until a blocked native reader really exits',
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oaa-drain-lease-')),
      gateFile = path.join(dir, 'gate.sqlite');
    const gate = new DatabaseSync(gateFile);
    gate.exec(
      'PRAGMA journal_mode=DELETE; CREATE TABLE pace(n); INSERT INTO pace VALUES(1); BEGIN EXCLUSIVE',
    );
    const probe = observeReader(gateFile, 'blocked');
    try {
      const s = await setup(undefined, { maxStoredBytesPerSubject: n + 1 });
      try {
        s.store
          .prepare(
            `WITH RECURSIVE nums(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM nums WHERE i<?)
        INSERT INTO files(id,owner,subject,payload) SELECT 'f'||i,'owner','config:test','{"bytes":1}' FROM nums`,
          )
          .run(n);
        const lease = s.store.prepare('SELECT lease_id FROM gateway_owner WHERE slot=1').get()!
          .lease_id;
        const upload = s.request('POST', '/v1/files', { filename: 'unpublished', content: 'x' });
        await waitFor(() => probe.inNative());
        let closed = false;
        const stop = s.app.close().then(() => {
          closed = true;
        });
        await waitFor(() => probe.terminationAt() !== undefined);
        // Even after waiting requests are rejected, the original gateway owns the directory.
        const declined = await upload;
        assert.equal(declined.statusCode, 503, declined.body);
        assert.ok(!closed && probe.inNative());
        assert.equal(
          s.store.prepare('SELECT lease_id FROM gateway_owner WHERE slot=1').get()!.lease_id,
          lease,
        );
        gate.exec('COMMIT');
        await stop;
        assert.equal(probe.exited(), 1);
        const reopened = new Store(s.store.root);
        try {
          assert.notEqual(
            reopened.prepare('SELECT lease_id FROM gateway_owner WHERE slot=1').get()!.lease_id,
            lease,
          );
          assert.equal(reopened.prepare('SELECT count(*) AS n FROM files').get()!.n, n);
          assert.equal(reopened.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
        } finally {
          reopened.close();
        }
      } finally {
        if (gate.isTransaction) gate.exec('ROLLBACK');
        await s.cleanup();
      }
    } finally {
      probe.restore();
      gate.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const run = promisify(execFile),
  bench = fileURLToPath(new URL('../bench/upload-reader-handoff.js', import.meta.url));
test(
  'reader handoff: an advancing native scan can finish past five seconds without a second count',
  { timeout: 40000 },
  async () => {
    const { stdout } = await run(process.execPath, [bench, '--scenario', 'progress'], {
      timeout: 33000,
    });
    const r = JSON.parse(stdout);
    assert.equal(r.first.status, 200);
    assert.ok(r.observed_finish_ms >= 5000);
    assert.ok(r.progress_reports > 0);
    assert.equal(r.helper_rows, r.history_rows);
    assert.equal(r.local_queries, 0);
    assert.equal(r.quiet_status, 200);
    assert.equal(r.quiet_before_primary, true);
    assert.equal(r.one_byte_over, 413);
    assert.equal(r.open_reservations, 0);
  },
);
test(
  'reader handoff: a blocked native operation and a retry cannot race a local recount',
  { timeout: 40000 },
  async () => {
    const { stdout } = await run(process.execPath, [bench, '--scenario', 'blocked'], {
      timeout: 33000,
    });
    const r = JSON.parse(stdout);
    assert.equal(r.native_gate_entries, 1);
    assert.ok(r.progress_reports > 0);
    assert.deepEqual(r.first, { status: 503, code: 'upload_busy', retry_after: '1' });
    assert.deepEqual(r.drain_retry, r.first);
    assert.equal(r.files_before_drain_retry, r.history_rows);
    assert.equal(r.local_queries_completed_while_native_read_blocked, 0);
    assert.equal(
      r.first_local_after_rowid,
      null,
      'after a busy response a new request must not reuse the old ticket',
    );
    assert.equal(r.quiet_upload_during_drain, 200);
    assert.equal(r.unrelated_cold_upload_during_drain, 200);
    assert.equal(r.retry_after_release_status, 200);
    assert.equal(r.one_byte_over, 413);
    assert.equal(r.open_reservations, 0);
  },
);
test(
  'reader handoff: the absolute limit releases a proven prefix without counting it twice',
  { timeout: 45000 },
  async () => {
    const { stdout } = await run(process.execPath, [bench, '--scenario', 'ceiling'], {
      timeout: 35000,
    });
    const r = JSON.parse(stdout);
    assert.equal(r.first.status, 200);
    assert.ok(r.observed_finish_ms >= 15000);
    assert.ok(r.handed_off_rows > 0 && r.handed_off_rows < r.history_rows);
    assert.equal(r.first_local_after_rowid, String(r.handed_off_rows));
    const proven =
      r.acknowledged_release_rows || (r.exited_at_first_local ? r.checkpoint_at_first_local : 0);
    assert.equal(r.handed_off_rows, proven);
    assert.ok(r.local_queries > 0);
    assert.equal(r.one_byte_over, 413);
    assert.equal(r.open_reservations, 0);
  },
);
test(
  'reader handoff: an actual thread exit can release its last acknowledged checkpoint without a cancel reply',
  { timeout: 20000 },
  async () => {
    const { stdout } = await run(process.execPath, [bench, '--scenario', 'exit'], {
      timeout: 15000,
    });
    const r = JSON.parse(stdout);
    assert.equal(r.first.status, 200);
    assert.equal(r.acknowledged_release_rows, 0);
    assert.equal(r.exited_at_first_local, 1);
    assert.ok(r.checkpoint_at_first_local > 0 && r.checkpoint_at_first_local < r.history_rows);
    assert.equal(r.first_local_after_rowid, String(r.checkpoint_at_first_local));
    assert.equal(r.one_byte_over, 413);
    assert.equal(r.open_reservations, 0);
  },
);
