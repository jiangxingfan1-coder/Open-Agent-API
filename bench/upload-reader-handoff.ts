import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { observeReader, type ReaderScenario } from '../test/fixtures/upload-reader-probe.js';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'progress' },
    dist: { type: 'string' },
    'worker-dist': { type: 'string' },
    out: { type: 'string' },
  },
});
assert.ok(['progress', 'blocked', 'ceiling', 'steady'].includes(values.scenario!));
const scenario = values.scenario as ReaderScenario,
  n = 16384;
const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-reader-handoff-')),
  file = path.join(root, 'gate.sqlite');
const gate = new DatabaseSync(file);
gate.exec('PRAGMA journal_mode=DELETE; CREATE TABLE pace(n); INSERT INTO pace VALUES(1)');
const observe = observeReader(
  file,
  scenario,
  values['worker-dist']
    ? pathToFileURL(path.resolve(values['worker-dist'], 'src/store/upload-read-worker.js')).href
    : undefined,
);
try {
  const { setup, token, secondToken, waitFor }: typeof import('../test/helpers.js') = values.dist
    ? await import(pathToFileURL(path.resolve(values.dist, 'test/helpers.js')).href)
    : await import('../test/helpers.js');
  const s = await setup(undefined, { maxStoredBytesPerSubject: n + 1 });
  let locked = false;
  try {
    let separateKey: string | undefined;
    const seed = s.store
      .prepare(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<?)
      INSERT INTO files(id,owner,subject,payload) SELECT ?||n,?,?,'{"bytes":1}' FROM nums`);
    seed.run(n, 'h', 'owner', 'config:test');
    if (scenario === 'progress') seed.run(5000, 'peer', 'second', 'config:second');
    if (scenario === 'blocked') {
      const key = s.auth.create(
        s.auth.authenticate('Bearer ' + token),
        'separate',
        ['*'],
        ['files'],
      );
      separateKey = String(key.token);
      const p = s.auth.authenticate('Bearer ' + separateKey);
      seed.run(5000, 'other', p.owner, p.subject ?? p.keyId!);
    }
    const base = await s.listen(),
      prepare = s.store.prepare.bind(s.store);
    let localQueries = 0,
      firstLocalRowid: string | null = null,
      completedDuringNative = 0,
      rowsAtFirstLocal: number | null = null;
    const seen = new WeakSet<object>();
    s.store.prepare = (sql) => {
      const stmt = prepare(sql);
      if (sql.startsWith('SELECT count(*) AS rows,') && !seen.has(stmt)) {
        seen.add(stmt);
        stmt.get = new Proxy(stmt.get, {
          apply(get, receiver, args) {
            if (args[0]?.subject !== 'config:test') return Reflect.apply(get, receiver, args);
            if (!localQueries) firstLocalRowid = args[0]?.rid ?? null;
            localQueries++;
            rowsAtFirstLocal ??= observe.rows();
            const overlap = locked && observe.inNative(),
              result = Reflect.apply(get, receiver, args);
            if (overlap && locked && observe.inNative()) completedDuringNative++;
            return result;
          },
        });
      }
      return stmt;
    };
    if (scenario === 'blocked') {
      gate.exec('BEGIN EXCLUSIVE');
      locked = true;
    }
    const put = async (key: string) => {
      const r = await fetch(base + '/v1/files', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'one', content: 'x' }),
        signal: AbortSignal.timeout(25000),
      });
      const body = await r.json();
      return {
        status: r.status,
        code: body.error?.code ?? null,
        retry_after: r.headers.get('retry-after'),
      };
    };
    let firstMs = 0;
    const start = performance.now(),
      upload = put(token).then((reply) => {
        firstMs = performance.now() - start;
        return reply;
      });
    await waitFor(() => (scenario === 'steady' ? observe.opened() > 0 : observe.rows() > 0), 5000);
    const quietUpload = put(secondToken).then((reply) => ({
      reply,
      at: performance.now() - start,
    }));
    let atDeadline: number | null = null,
      later: number | null = null;
    if (scenario !== 'steady') {
      await delay(Math.max(0, start + 4800 - performance.now()));
      atDeadline = observe.rows();
      await delay(Math.max(0, start + 5650 - performance.now()));
      later = observe.rows();
    }
    let drainRetry: Awaited<ReturnType<typeof put>> | undefined,
      quietDuringDrain: number | undefined,
      separateDuringDrain: number | undefined,
      rowsBeforeRetry: number | undefined,
      recovered: number | undefined;
    const first = await upload;
    const quiet = await quietUpload;
    assert.equal(quiet.reply.status, 200);
    if (locked) {
      // Hold past the normal no-progress timeout; do not let a retry create overlapping I/O.
      assert.ok(observe.inNative());
      rowsBeforeRetry = Number(
        prepare(
          "SELECT count(*) AS n FROM files WHERE owner='owner' AND subject='config:test'",
        ).get()!.n,
      );
      drainRetry = await put(token);
      quietDuringDrain = (await put(secondToken)).status;
      assert.equal(quietDuringDrain, 200);
      separateDuringDrain = (await put(separateKey!)).status;
      assert.equal(separateDuringDrain, 200);
      assert.ok(observe.inNative());
      gate.exec('COMMIT');
      locked = false;
    }
    assert.ok([200, 503].includes(first.status));
    if (first.status !== 200 && drainRetry?.status !== 200) {
      await waitFor(() => observe.exited() > 0, 5000);
      recovered = (await put(token)).status;
      assert.equal(recovered, 200);
    }
    const over = await put(token);
    assert.equal(over.status, 413);
    assert.equal(over.code, 'storage_quota_exceeded');
    assert.equal(
      s.store
        .prepare(
          "SELECT sum(json_extract(payload,'$.bytes')) AS n FROM files WHERE owner='owner' AND subject='config:test'",
        )
        .get()!.n,
      n + 1,
    );
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
    const report = {
      scenario,
      scope:
        'Isolated loopback gateway, real indexed SQLite file scan and upload. The fixture paces visited rows or blocks a native SQLite read on a separate locked database. Not a physical disk fault or production latency measurement.',
      node: process.version,
      history_rows: n,
      helper_rows: observe.rows(),
      rows_near_4_8s: atDeadline,
      rows_near_5_65s: later,
      native_gate_entries: observe.entries(),
      progress_reports: observe.reports(),
      handed_off_rows: observe.releasedRows(),
      first_local_after_rowid: firstLocalRowid,
      local_queries: localQueries,
      rows_at_first_local_query: rowsAtFirstLocal,
      local_queries_completed_while_native_read_blocked: completedDuringNative,
      first,
      drain_retry: drainRetry,
      files_before_drain_retry: rowsBeforeRetry,
      retry_after_release_status: recovered,
      quiet_upload_during_drain: quietDuringDrain,
      unrelated_cold_upload_during_drain: separateDuringDrain,
      observed_finish_ms: +firstMs.toFixed(2),
      quiet_status: quiet.reply.status,
      quiet_before_primary: quiet.at < firstMs,
      quiet_completed_at_ms: +quiet.at.toFixed(2),
      one_byte_over: over.status,
      charged_bytes: n + 1,
      open_reservations: 0,
      real_model_calls: 0,
    };
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.out) await writeFile(values.out, output, { flag: 'wx' });
    process.stdout.write(output);
  } finally {
    if (locked) gate.exec('ROLLBACK');
    await s.cleanup();
  }
} finally {
  observe.restore();
  gate.close();
  await rm(root, { recursive: true, force: true });
}
