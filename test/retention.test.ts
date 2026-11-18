import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { makeBundle } from '../src/lang/bundle.js';
import { gatewaySchema } from '../src/config/config.js';
import { prune, parseAge } from '../src/store/retention.js';
import { DatabaseSync } from 'node:sqlite';
import { KEEP_DELIVERIES, MAX_PENDING_DELIVERIES, WebhookDb } from '../src/gateway/webhook-db.js';
import { rotateLog } from '../src/client/onboarding.js';
import { databaseHealth, pruneCommand } from '../src/client/prune.js';
import { coarseDelay, deadlineTimer, sha, sleep } from '../src/core/util.js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setup, agent } from './helpers.js';
import { principal } from './helpers.js';
import { TaskWorkflows, type WorkflowExecution } from '../src/store/task-workflows.js';

// Retention tests: in-process gateway through app.inject; nothing listens on a port.

type Setup = Awaited<ReturnType<typeof setup>>;
async function complete(s: Setup, input: string): Promise<string> {
  const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json() as { id: string; status: string };
  assert.equal(body.status, 'completed');
  return body.id;
}
const count = (s: Setup, sql: string, ...args: string[]) =>
  Number(s.store.db.prepare(sql).get(...args)!.n);
function setStatus(s: Setup, runId: string, status: string) {
  s.store.db
    .prepare(`UPDATE runs SET status=?,payload=json_set(payload,'$.status',?) WHERE id=?`)
    .run(status, status, runId);
}

test('retention: the default configuration has no retention policy', () => {
  const config = gatewaySchema.parse({ dataDir: '/x', keys: [{ name: 'k', owner: 'o' }] });
  assert.equal(config.retention, undefined);
  const set = gatewaySchema.parse({
    dataDir: '/x',
    keys: [{ name: 'k', owner: 'o' }],
    retention: { runsDays: 30 },
  });
  assert.deepEqual(set.retention, { runsDays: 30, intervalMinutes: 60, warnDatabaseMb: 1024 });
  assert.throws(() =>
    gatewaySchema.parse({
      dataDir: '/x',
      keys: [{ name: 'k', owner: 'o' }],
      retention: { runsDays: 30, unknown: 1 },
    }),
  );
});

test('retention: parseAge accepts d/h/m/s units and rejects garbage', () => {
  assert.equal(parseAge('30d'), 30 * 86_400_000);
  assert.equal(parseAge('12h'), 12 * 3_600_000);
  assert.equal(parseAge('45m'), 45 * 60_000);
  assert.equal(parseAge('90s'), 90_000);
  assert.equal(parseAge('2'), 2 * 86_400_000);
  for (const bad of ['', 'abc', '-1d', '0d', '3w']) assert.throws(() => parseAge(bad));
});

test('retention: prune removes old finished runs with their rows and artifacts, keeps everything else', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const old = await complete(s, 'old');
    const waiting = await complete(s, 'waiting');
    const interrupted = await complete(s, 'interrupted');
    const queued = await complete(s, 'queued');
    const inheritor = await complete(s, 'inheritor');
    const artifact = await s.store.addFile('owner', 'old.txt', Buffer.from('a'), undefined, old);
    const inherited = await s.store.addFile('owner', 'kept.txt', Buffer.from('b'), undefined, old);
    const oldUpload = await s.store.addFile('owner', 'upload.txt', Buffer.from('c'));
    await sleep(5);
    const cutoff = Date.now();
    await sleep(5);
    const recent = await complete(s, 'recent');
    setStatus(s, waiting, 'requires_action');
    setStatus(s, interrupted, 'interrupted');
    setStatus(s, queued, 'queued');
    // A continuation inherits files: a kept run listing a file keeps it.
    s.store.db
      .prepare(`UPDATE runs SET payload=json_set(payload,'$.fileIds',json_array(?)) WHERE id=?`)
      .run(inherited.id, recent);
    assert.ok(count(s, 'SELECT count(*) AS n FROM events WHERE run_id=?', old) > 0);

    const olderThanMs = 60_000;
    const now = cutoff + olderThanMs;
    const dry = await prune(s.store, { olderThanMs, now, dryRun: true });
    assert.equal(dry.runs, 2, 'old and inheritor are finished and older than the cutoff');
    assert.equal(dry.files, 2, 'the artifact of the old run and the old upload');
    assert.equal(count(s, 'SELECT count(*) AS n FROM runs'), 6, 'dry run deletes nothing');

    const report = await prune(s.store, { olderThanMs, now, batchSize: 1 });
    assert.equal(report.runs, 2);
    assert.ok(report.events > 0);
    assert.equal(report.files, 2);
    const left = s.store.db
      .prepare('SELECT id FROM runs ORDER BY rowid')
      .all()
      .map((r) => r.id);
    assert.deepEqual(left, [waiting, interrupted, queued, recent]);
    assert.ok(!left.includes(inheritor));
    for (const table of ['events', 'steps', 'approvals', 'run_output_baselines', 'run_summaries'])
      assert.equal(
        count(s, `SELECT count(*) AS n FROM ${table} WHERE run_id=?`, old),
        0,
        `${table} rows of the pruned run are gone`,
      );
    const files = await readdir(path.join(s.config.dataDir, 'files'));
    assert.ok(!files.includes(artifact.id));
    assert.ok(!files.includes(oldUpload.id));
    assert.ok(files.includes(inherited.id), 'a file listed by a kept run stays');
    // The live gateway no longer serves the pruned run, and still serves the kept ones.
    assert.equal((await s.request('GET', `/v1/responses/${old}`)).statusCode, 404);
    assert.equal((await s.request('GET', `/v1/responses/${recent}`)).statusCode, 200);
    // Continuing a kept run still works after the prune.
    const next = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'again',
      previous_response_id: recent,
    });
    assert.equal(next.statusCode, 200, next.body);
    // A second prune with the same cutoff has nothing left to do.
    const again = await prune(s.store, { olderThanMs, now });
    assert.equal(again.runs + again.files, 0);
  } finally {
    await s.cleanup();
  }
});

test('retention: a delegated child is kept while its parent is kept', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const child = await complete(s, 'child');
    await sleep(5);
    const cutoff = Date.now();
    await sleep(5);
    const parent = await complete(s, 'parent');
    s.store.db
      .prepare(
        `UPDATE runs SET payload=json_set(payload,'$.metadata."oaa.parent_run_id"',?) WHERE id=?`,
      )
      .run(parent, child);
    const report = await prune(s.store, { olderThanMs: 1000, now: cutoff + 1000 });
    assert.equal(report.runs, 0);
  } finally {
    await s.cleanup();
  }
});

test('retention protects workflow inputs before their first child and throughout resumable states', async () => {
  const s = await setup();
  try {
    const records = new TaskWorkflows(s.store);
    const statuses: WorkflowExecution<{ id: string }>['status'][] = [
      'queued',
      'running',
      'cancelling',
      'blocked',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const status of statuses) {
      const file = await s.store.addFile('owner', 'source.txt', Buffer.from(status));
      const e = records.create({
        owner: 'owner',
        subject: 'legacy',
        authority: principal,
        revision: '1',
        definition: { id: status },
        input: {},
        fileIds: [file.id],
      });
      e.status = status;
      records.save(e);
    }
    const age = { olderThanMs: 86400000, now: Date.now() + 2 * 86400000 };
    assert.equal((await prune(s.store, { ...age, dryRun: true })).files, 3);
    assert.equal((await prune(s.store, age)).files, 3);
    for (const e of records.executions('owner')) {
      assert.equal(
        !!s.store.prepare('SELECT 1 FROM files WHERE id=?').get(e.fileIds[0]!),
        !['completed', 'failed', 'cancelled'].includes(e.status),
      );
    }
  } finally {
    await s.cleanup();
  }
});

test('retention: unreferenced old session workspaces and orphan blobs are swept', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const kept = await complete(s, 'kept');
    const session = String(
      s.store.db.prepare('SELECT session_id FROM runs WHERE id=?').get(kept)!.session_id,
    );
    const worker = path.join(s.dir, 'worker');
    const base = path.join(worker, 'sessions', sha('owner').slice(0, 16));
    const keptDir = path.join(base, session);
    const goneDir = path.join(base, 'sess_gone');
    const freshDir = path.join(base, 'sess_fresh');
    for (const dir of [keptDir, goneDir, freshDir]) await mkdir(dir, { recursive: true });
    const past = new Date(Date.now() - 3_600_000);
    await utimes(keptDir, past, past);
    await utimes(goneDir, past, past);
    const orphan = path.join(s.config.dataDir, 'files', 'file_orphan');
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, 'x');
    await utimes(orphan, past, past);
    const report = await prune(s.store, { olderThanMs: 60_000, workerDataDir: worker });
    assert.equal(report.workspaces, 1);
    assert.deepEqual((await readdir(base)).sort(), [session, 'sess_fresh'].sort());
    await assert.rejects(stat(orphan));
  } finally {
    await s.cleanup();
  }
});

test('retention: the prune route prunes only the owner of the admin key', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const mine = await complete(s, 'mine');
    // Another owner's finished run, seeded directly (the local worker serves 'owner' only).
    s.store.db
      .prepare(
        `INSERT INTO runs(id,owner,agent_id,session_id,status,payload,subject)
         SELECT 'resp_theirs','second',agent_id,'sess_theirs',status,json_set(payload,'$.id','resp_theirs','$.owner','second'),subject FROM runs WHERE id=?`,
      )
      .run(mine);
    await sleep(70);
    const tooYoung = await s.request('POST', '/v1/maintenance/prune', { older_than_ms: 1000 });
    assert.equal(tooYoung.statusCode, 400, 'the route refuses ages below one minute');
    const dry = await s.request('POST', '/v1/maintenance/prune', {
      older_than_ms: 60_000,
      dry_run: true,
    });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.equal((dry.json() as { runs: number }).runs, 0, 'nothing is a minute old yet');
    // Age every run by two minutes, then prune through the route.
    s.store.db
      .prepare(`UPDATE runs SET payload=json_set(payload,'$.updatedAt',?)`)
      .run(Date.now() - 120_000);
    const done = await s.request('POST', '/v1/maintenance/prune', { older_than_ms: 60_000 });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((done.json() as { runs: number }).runs, 1);
    assert.equal(count(s, `SELECT count(*) AS n FROM runs WHERE owner='second'`), 1);
  } finally {
    await s.cleanup();
  }
});

test('retention: server.log rotates to one previous generation above the limit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-log-'));
  try {
    const log = path.join(dir, 'server.log');
    assert.equal(await rotateLog(log, 10), false, 'a missing log is fine');
    await writeFile(log, 'small');
    assert.equal(await rotateLog(log, 10), false);
    await writeFile(log, 'x'.repeat(20));
    assert.equal(await rotateLog(log, 10), true);
    assert.deepEqual((await readdir(dir)).sort(), ['server.log.1']);
    // A rotation that cannot happen (here server.log.1 is a non-empty directory, as a stand-in
    // for a file locked on Windows) is skipped instead of failing the start.
    await rm(path.join(dir, 'server.log.1'));
    await mkdir(path.join(dir, 'server.log.1', 'x'), { recursive: true });
    await writeFile(log, 'x'.repeat(20));
    assert.equal(await rotateLog(log, 10), false);
    assert.ok((await readdir(dir)).includes('server.log'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retention: oaa prune opens a stopped data directory directly and can VACUUM', async () => {
  const s = await setup();
  const config = s.config;
  try {
    s.store.publish('owner', makeBundle(agent()));
    await complete(s, 'old');
    s.store.db.prepare(`UPDATE runs SET payload=json_set(payload,'$.updatedAt',0)`).run();
  } finally {
    await s.app.close();
  }
  try {
    // Port 0 means no gateway answers, so the data directory is opened directly.
    const report = await pruneCommand({ ...config, port: 0 }, { olderThan: '1d', vacuum: true });
    assert.equal(report.via, 'data_dir');
    assert.equal(report.runs, 1);
    assert.equal(typeof report.database_bytes_after_vacuum, 'number');
    await assert.rejects(pruneCommand(config, { olderThan: 'soon' }), /older-than/);
    const health = await databaseHealth({
      ...config,
      retention: { intervalMinutes: 60, warnDatabaseMb: 1 },
    });
    assert.equal(health.warning, undefined, 'a tiny database is below 1 MB');
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test('stability: runs do not arm uncancellable long AbortSignal.timeout deadlines', async () => {
  // A pending AbortSignal.timeout cannot be cleared and keeps its signal graph alive until it
  // fires; the per-execution deadline (30 minutes by default) made memory grow for 30 minutes.
  const original = AbortSignal.timeout.bind(AbortSignal);
  const armed: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    armed.push(ms);
    return original(ms);
  };
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    for (let i = 0; i < 5; i++) await complete(s, `run ${i}`);
    assert.deepEqual(
      armed.filter((ms) => ms >= 600_000),
      [],
    );
  } finally {
    AbortSignal.timeout = original;
    await s.cleanup();
  }
});

test('stability: deadlineTimer aborts on time and can be cleared', async () => {
  const fired = deadlineTimer(5);
  await sleep(30);
  assert.equal(fired.signal.aborted, true);
  assert.equal((fired.signal.reason as DOMException).name, 'TimeoutError');
  const cleared = deadlineTimer(5);
  cleared.clear();
  await sleep(30);
  assert.equal(cleared.signal.aborted, false);
});

test('retention: webhook announcements go with their run; unsettled ledger rows keep their run', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const announced = await complete(s, 'announced');
    const unsettled = await complete(s, 'unsettled');
    const db = s.store.db;
    db.exec(
      'CREATE TABLE IF NOT EXISTS webhook_announced(run_id TEXT NOT NULL,approval_id TEXT NOT NULL,PRIMARY KEY(run_id,approval_id))',
    );
    db.prepare('INSERT INTO webhook_announced VALUES(?,?)').run(announced, 'appr_1');
    db.exec(
      'CREATE TABLE IF NOT EXISTS platform_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,account_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,balance_after INTEGER NOT NULL,run_id TEXT UNIQUE,agent TEXT,tokens INTEGER NOT NULL DEFAULT 0,status TEXT,note TEXT,payload TEXT NOT NULL,created_at INTEGER NOT NULL)',
    );
    const ledger = db.prepare(
      `INSERT INTO platform_ledger(owner,account_id,kind,amount,balance_after,run_id,status,payload,created_at) VALUES('owner','acct','charge',0,0,?,?,'{}',0)`,
    );
    ledger.run(unsettled, 'in_progress');
    ledger.run(announced, 'completed');
    const report = await prune(s.store, { olderThanMs: 1000, now: Date.now() + 10_000 });
    assert.equal(report.runs, 1, 'only the settled run goes');
    assert.equal(count(s, 'SELECT count(*) AS n FROM webhook_announced'), 0);
    assert.equal(count(s, 'SELECT count(*) AS n FROM runs WHERE id=?', unsettled), 1);
    // The ledger itself is a billing record and stays, including the pruned run's row.
    assert.equal(count(s, 'SELECT count(*) AS n FROM platform_ledger'), 2);
  } finally {
    await s.cleanup();
  }
});

test('retention: stored-file quota usage drops once old uploads and image inputs are pruned', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const used = () =>
      Number(
        s.store.db
          .prepare(
            "SELECT coalesce(sum(json_extract(payload,'$.bytes')),0) AS n FROM files WHERE subject='key_a'",
          )
          .get()!.n,
      );
    // Image inputs are stored as the caller's uploads and listed in the run's fileIds.
    const image = await s.store.addFile(
      'owner',
      'image-1.png',
      Buffer.alloc(100),
      undefined,
      undefined,
      'key_a',
    );
    const kept = await s.store.addFile(
      'owner',
      'image-2.png',
      Buffer.alloc(50),
      undefined,
      undefined,
      'key_a',
    );
    await sleep(5);
    const cutoff = Date.now();
    await sleep(5);
    const later = await complete(s, 'recent');
    s.store.db
      .prepare(`UPDATE runs SET payload=json_set(payload,'$.fileIds',json_array(?)) WHERE id=?`)
      .run(kept.id, later);
    assert.equal(used(), 150);
    // Cut off after both uploads but before the run that lists the second one.
    await prune(s.store, { olderThanMs: 1000, now: cutoff + 1000 });
    assert.equal(used(), 50, 'the unreferenced image went; the one a kept run lists stays');
    assert.throws(() => s.store.file(image.id, 'owner'), /File not found/);
  } finally {
    await s.cleanup();
  }
});

test('stability: coarseDelay rounds up by at most 10% to a small set of durations', () => {
  const seen = new Set<number>();
  for (let ms = 1; ms <= 2_000_000; ms += 7) {
    const d = coarseDelay(ms);
    assert.ok(d >= ms && d <= Math.max(1, ms * 1.1), `${ms} -> ${d}`);
    seen.add(d);
  }
  assert.ok(seen.size < 700, `${seen.size} distinct delays`);
  assert.equal(coarseDelay(0), 1);
  assert.equal(coarseDelay(-5), 1);
});

test('stability: re-armed unref timers with coarse delays do not pile up Node timer lists', () => {
  // Node keeps one internal list per timer duration; clearing an unref'd timer leaves its empty
  // list in place. The gateway re-arms such timers with "deadline - now" durations (overview
  // revisions, node wake-up), which grew the heap by ~0.25 MB/min in the soak test.
  const util = pathToFileURL(path.resolve('dist', 'src', 'core', 'util.js')).href;
  const script = `
    const { timerListMap } = require('internal/timers');
    import(${JSON.stringify(util)}).then(({ coarseDelay }) => {
      const before = Object.keys(timerListMap).length;
      for (let i = 0; i < 5000; i++) { const t = setTimeout(() => {}, coarseDelay(100000 + i * 97)); t.unref(); clearTimeout(t); }
      const coarse = Object.keys(timerListMap).length - before;
      for (let i = 0; i < 2000; i++) { const t = setTimeout(() => {}, 3000000 + i); t.unref(); clearTimeout(t); }
      const exact = Object.keys(timerListMap).length - before - coarse;
      process.stdout.write(JSON.stringify({ coarse, exact }));
    });`;
  const r = spawnSync(process.execPath, ['--expose-internals', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { coarse, exact } = JSON.parse(r.stdout) as { coarse: number; exact: number };
  assert.ok(coarse <= 100, `coarse delays left ${coarse} lists`);
  // Documents the Node behaviour the fix works around (informational if Node changes it).
  if (exact < 1000)
    process.stdout.write(`# note: this Node no longer keeps emptied lists (${exact})\n`);
});

test('retention: the console activity window forgets pruned runs', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    for (let i = 0; i < 3; i++) await complete(s, `run ${i}`);
    const started = async () =>
      ((await s.request('GET', '/v1/overview/activity')).json() as { totals: { started: number } })
        .totals.started;
    assert.equal(await started(), 3);
    // Through the gateway's prune (the live path), with every run aged past the cutoff.
    s.store.db
      .prepare(`UPDATE runs SET payload=json_set(payload,'$.updatedAt',?)`)
      .run(Date.now() - 120_000);
    const r = await s.request('POST', '/v1/maintenance/prune', { older_than_ms: 60_000 });
    assert.equal((r.json() as { runs: number }).runs, 3);
    assert.equal(await started(), 0, 'the cached window was rebuilt after the prune');
  } finally {
    await s.cleanup();
  }
});

test('stability: a failing webhook endpoint cannot queue deliveries without bound', () => {
  // Found by the soak test: an endpoint failing 40% of the time held its serial queue on retries
  // while events kept coming, and 32,704 deliveries piled up in 32 minutes.
  const db = new WebhookDb(new DatabaseSync(':memory:'));
  const enqueue = (i: number) =>
    db.enqueue({
      endpointId: 'wh_1',
      owner: 'owner',
      eventId: `evt_${i}`,
      eventType: 'run.completed',
      runId: `resp_${i}`,
      dedupe: `d_${i}`,
      seed: {},
    });
  const head = enqueue(0)!;
  for (let i = 1; i < MAX_PENDING_DELIVERIES + 50; i++) enqueue(i);
  assert.equal(db.pendingCount('wh_1'), MAX_PENDING_DELIVERIES);
  // The head (possibly in flight) stays queued; the dropped ones are marked failed and then
  // trimmed like other finished deliveries, so the table stays bounded.
  assert.equal(db.delivery(head.id)?.status, 'pending');
  const all = db.deliveries('wh_1', 1_000_000);
  assert.ok(all.length <= MAX_PENDING_DELIVERIES + KEEP_DELIVERIES, String(all.length));
  assert.ok(
    all
      .filter((d) => d.status !== 'pending')
      .every((d) => /queue_overflow/.test(String(d.last_error))),
  );
});
