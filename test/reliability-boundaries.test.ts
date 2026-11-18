import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sha } from '../src/core/util.js';
import { IncomingArtifacts, sendArtifacts } from '../src/fabric/artifact-transfer.js';
import { makeBundle } from '../src/lang/bundle.js';
import { memoryFts } from '../src/store/project-fts.js';
import { projects } from '../src/store/projects.js';
import { prune } from '../src/store/retention.js';
import { Store } from '../src/store/store.js';
import { agent, FixtureModel, principal, setup, waitFor } from './helpers.js';

test('legacy FTS backfill yields between committed pages and retries a failed page without restarting', async (t) => {
  const s = await setup();
  try {
    const fts = memoryFts(s.store);
    if (!fts.ftsAvailable) {
      t.skip('SQLite was built without FTS5');
      return;
    }
    const p = projects(s.store);
    p.create(principal, 'legacy', 'Legacy');
    p.create(principal, 'other', 'Other');
    const db = s.store.db,
      stmt = db.prepare('INSERT INTO project_memories VALUES(?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 0; i < 131; i++)
      stmt.run(
        'owner',
        'legacy',
        'notes',
        String(i).padStart(3, '0'),
        JSON.stringify(i === 130 ? 'findneedle' : 'regular'),
        '1',
        i,
      );
    stmt.run('owner', 'other', 'notes', 'unrelated', '"another"', '1', 0);
    db.exec('COMMIT');
    db.exec(
      "CREATE TEMP TRIGGER fail_fts BEFORE INSERT ON memory_fts_map WHEN NEW.key='080' BEGIN SELECT RAISE(ABORT,'temporary index failure'); END;",
    );
    let nextTurn = false;
    setImmediate(() => {
      nextTurn = true;
    });
    await assert.rejects(p.warmSearch(principal, 'legacy'), /temporary index failure/);
    assert.equal(nextTurn, true);
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM memory_fts_map').get()?.n, 64);
    assert.equal(s.store.prepare('SELECT done FROM memory_fts_scopes').get()?.done, 0);
    db.exec('DROP TRIGGER fail_fts');
    await p.warmSearch(principal, 'legacy');
    assert.equal(p.search(principal, 'legacy', 'findneedle')[0]?.key, '130');
    assert.equal(s.store.prepare('SELECT count(*) AS n FROM memory_fts_map').get()?.n, 131);
    db.exec(
      "CREATE TEMP TRIGGER fail_update BEFORE INSERT ON memory_fts_map BEGIN SELECT RAISE(ABORT,'index write failed'); END;",
    );
    assert.throws(() => p.put(principal, 'legacy', 'notes', '130', 'wrong'), /index write failed/);
    assert.equal(p.get(principal, 'legacy', 'notes', '130')?.value, 'findneedle');
    assert.throws(
      () => s.store.putMemory('owner', 'legacy', 'notes', 'x', 'test'),
      /index write failed/,
    );
    assert.equal(s.store.getMemory('owner', 'legacy', 'notes', 'x'), undefined);
    assert.equal(p.search(principal, 'legacy', 'findneedle')[0]?.key, '130');
  } finally {
    await s.cleanup();
  }
});

test('metrics expose a falling state as a gauge; outcome counters survive prune and restart', async () => {
  const a = Promise.withResolvers<void>(),
    b = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (_agent, messages) => {
      await (messages.at(-1)?.content.includes('first-case') ? a : b).promise;
      return { text: 'done' };
    }),
  );
  const metrics = async () => (await s.request('GET', '/metrics')).body;
  try {
    s.store.publish('owner', makeBundle(agent()));
    for (const input of ['first-case', 'second-case'])
      await s.request('POST', '/v1/responses', { model: 'agent/test', input, background: true });
    await waitFor(async () =>
      /oaa_runs_total\{agent="agent\/test",status="in_progress"\} 2/.test(await metrics()),
    );
    a.resolve();
    await waitFor(async () =>
      /oaa_runs_total\{agent="agent\/test",status="in_progress"\} 1/.test(await metrics()),
    );
    assert.match(await metrics(), /# TYPE oaa_runs_total gauge/);
    b.resolve();
    const both = /oaa_run_outcomes_total\{agent="agent\/test",status="completed"\} 2/;
    await waitFor(async () => both.test(await metrics()));
    await prune(s.store, { olderThanMs: 60000, now: Date.now() + 120000 });
    const after = await metrics();
    assert.match(after, /# TYPE oaa_run_outcomes_total counter/);
    assert.match(after, both);
    assert.doesNotMatch(after, /oaa_runs_total\{agent=/);
    await s.app.close();
    const reopened = new Store(s.config.dataDir);
    try {
      assert.equal(
        reopened.prepare("SELECT sum(n) AS n FROM run_outcomes WHERE status='completed'").get()?.n,
        2,
      );
    } finally {
      reopened.close();
    }
  } finally {
    a.resolve();
    b.resolve();
    await s.cleanup();
  }
});

test('incomplete, corrupt or abandoned artifact uploads leave no published row or partial blob', async () => {
  const s = await setup();
  try {
    const db = s.store.db;
    const unit = {
      type: 'artifact_chunk' as const,
      id: 'rpc',
      leaseId: 'lease',
      index: 0,
      offset: 0,
      name: 'file.bin',
      sha256: sha('abcdef'),
      bytes: 6,
      data: Buffer.from('abc').toString('base64'),
    };
    for (const mode of ['abandon', 'bad-digest', 'missing-manifest', 'duplicate-offset']) {
      const transfer = new IncomingArtifacts(s.store, 'owner', 'fixture-run');
      await transfer.accept(unit);
      assert.equal(db.prepare('SELECT count(*) AS n FROM files').get()?.n, 0);
      if (mode === 'duplicate-offset') await assert.rejects(transfer.accept(unit));
      if (mode === 'bad-digest')
        await assert.rejects(
          transfer.accept({ ...unit, offset: 3, data: Buffer.from('xxx').toString('base64') }),
        );
      if (mode === 'missing-manifest') {
        await transfer.accept({ ...unit, offset: 3, data: Buffer.from('def').toString('base64') });
        await prune(s.store, { olderThanMs: 60000, now: Date.now() + 120000 });
        assert.equal(
          (await readdir(path.join(s.store.root, 'files'))).length,
          1,
          'a live transfer is not an orphan',
        );
        assert.throws(() => transfer.finish({ artifacts: [] }));
      }
      await transfer.discard();
      assert.equal(db.prepare('SELECT count(*) AS n FROM files').get()?.n, 0);
      assert.deepEqual(await readdir(path.join(s.store.root, 'files')), []);
    }
  } finally {
    await s.cleanup();
  }
});

test('remote file batches use acknowledged chunks when their combined inline result would exceed a frame', async () => {
  const file = Buffer.alloc(7 * 1024 * 1024, 55),
    content = file.toString('base64'),
    sha256 = sha(file);
  const result = {
    value: 'ok',
    artifacts: ['a', 'b', 'c'].map((name) => ({ name, content, sha256 })),
  };
  let bytes = 0;
  const out = await sendArtifacts(result, true, new AbortController().signal, async (chunk) => {
    bytes += Buffer.byteLength(chunk.data, 'base64');
  });
  assert.equal(bytes, file.length * 3);
  assert.ok('artifacts' in out && out.artifacts?.every((a) => a.content === ''));
  const single = { value: 'ok', artifacts: [result.artifacts[0]!] };
  assert.equal(
    await sendArtifacts(single, false, new AbortController().signal, async () => assert.fail()),
    single,
  );
});
