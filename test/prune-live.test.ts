import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdir, stat, utimes } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { agent, FixtureModel, setup, secondToken } from './helpers.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { prune } from '../src/store/retention.js';
import { pruneChannel } from '../src/store/prune-profile.js';
import { prepareArtifactOrigins } from '../src/store/artifact-origin.js';

type Fixture = Awaited<ReturnType<typeof setup>>;

test('workspace sweep uses the session index and leaves unknown directory layouts untouched', async () => {
  const s = await setup();
  try {
    const plans = s.store.db
      .prepare('EXPLAIN QUERY PLAN SELECT DISTINCT owner FROM runs WHERE session_id=?')
      .all('fixture-session');
    assert.ok(plans.some((r) => String(r.detail).includes('run_retention_session')));
    const worker = path.join(s.dir, 'worker-clean-test'),
      userDir = path.join(worker, 'sessions', 'other-layout', 'notes');
    await mkdir(userDir, { recursive: true });
    const old = new Date(Date.now() - 300000);
    await utimes(userDir, old, old);
    assert.equal(
      (await prune(s.store, { olderThanMs: 60000, workerDataDir: worker })).workspaces,
      0,
    );
    assert.ok((await stat(userDir)).isDirectory());
  } finally {
    await s.cleanup();
  }
});
async function finished(s: Fixture, body: Record<string, unknown> = {}) {
  const r = await s.request('POST', '/v1/responses', {
    model: 'agent/test',
    input: 'fixture',
    ...body,
  });
  assert.equal(r.json().status, 'completed', r.body);
  return r.json().id as string;
}
function age(s: Fixture, id: string) {
  s.store
    .prepare("UPDATE runs SET payload=json_set(payload,'$.updatedAt',?) WHERE id=?")
    .run(Date.now() - 300000, id);
}
const request = (s: Fixture) =>
  s.request('POST', '/v1/maintenance/prune', { older_than_ms: 60000 });

test('origin retention seeks by producer ID and records only matching same-owner artifact grants', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const producer = await finished(s),
      other = await finished(s);
    const insert = s.store.prepare('INSERT INTO files(id,owner,payload,subject) VALUES(?,?,?,?)');
    for (const [id, owner, runId] of [
      ['first', 'owner', producer],
      ['second', 'owner', producer],
      ['other-run', 'owner', other],
      ['foreign-owner', 'foreign', producer],
      ['upload', 'owner', undefined],
    ] as const)
      insert.run(id, owner, JSON.stringify({ runId }), 'fixture');

    const keep = prepareArtifactOrigins(s.store.db);
    const ids = JSON.stringify([producer, producer, 'not-a-run']);
    const plan = s.store.prepare('EXPLAIN QUERY PLAN ' + keep.sourceSQL).all(ids);
    assert.ok(
      plan.some((row) =>
        /SEARCH f USING (?:COVERING )?INDEX file_artifact_run\b/.test(String(row.detail)),
      ),
      JSON.stringify(plan),
    );
    assert.equal(keep.run(ids).changes, 2);
    assert.equal(keep.run(ids).changes, 0);
    const grants = s.store
      .prepare(
        'SELECT file_id,owner,run_id,agent_id FROM retained_artifact_origins ORDER BY file_id',
      )
      .all();
    assert.deepEqual(
      grants.map((r) => [r.file_id, r.owner, r.run_id, r.agent_id]),
      [
        ['first', 'owner', producer, 'agent/test'],
        ['second', 'owner', producer, 'agent/test'],
      ],
    );
  } finally {
    await s.cleanup();
  }
});

test('live deletion commits without waiting for an older WAL reader; offline checkpoint still truncates', async () => {
  const s = await setup();
  let reader: DatabaseSync | undefined;
  const profiles: { checkpoint?: { mode: string; log: number; checkpointed: number } }[] = [];
  const observe = (m: unknown) => profiles.push(m as (typeof profiles)[number]);
  pruneChannel.subscribe(observe);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const id = await finished(s);
    age(s, id);
    reader = new DatabaseSync(path.join(s.store.root, 'state.sqlite'), { readOnly: true });
    reader.exec('BEGIN');
    assert.ok(reader.prepare('SELECT 1 FROM runs WHERE id=?').get(id));
    const response = await request(s);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().runs, 1);
    assert.ok(
      reader.prepare('SELECT 1 FROM runs WHERE id=?').get(id),
      'reader retains its older snapshot',
    );
    assert.equal(s.store.prepare('SELECT 1 FROM runs WHERE id=?').get(id), undefined);
    const cp = profiles.at(-1)?.checkpoint;
    assert.equal(cp?.mode, 'PASSIVE');
    assert.ok(cp && cp.log > cp.checkpointed);
    reader.close();
    reader = undefined;
    const other = await finished(s);
    age(s, other);
    await prune(s.store, { olderThanMs: 60000 });
    assert.deepEqual(profiles.at(-1)?.checkpoint, {
      mode: 'TRUNCATE',
      busy: 0,
      log: 0,
      checkpointed: 0,
    });
  } finally {
    reader?.close();
    pruneChannel.unsubscribe(observe);
    await s.cleanup();
  }
});

test('online writer waits yield the gateway thread, restore its timeout and recheck eligibility', async () => {
  const s = await setup();
  let writer: DatabaseSync | undefined;
  const profiles: { lock_retries: number; queue_ms: number }[] = [];
  const observe = (m: unknown) => profiles.push(m as (typeof profiles)[number]);
  pruneChannel.subscribe(observe);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const id = await finished(s);
    age(s, id);
    writer = new DatabaseSync(path.join(s.store.root, 'state.sqlite'));
    writer.exec('BEGIN IMMEDIATE');
    const queued = request(s);
    const follower = request(s);
    await delay(90);
    assert.equal((await s.request('GET', '/health')).statusCode, 200);
    assert.equal(s.store.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    writer
      .prepare("UPDATE runs SET payload=json_set(payload,'$.updatedAt',?) WHERE id=?")
      .run(Date.now(), id);
    writer.exec('COMMIT');
    const r = await queued;
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().runs, 0);
    assert.equal((await follower).statusCode, 200);
    assert.equal(profiles.length, 2);
    assert.ok(profiles[0]!.lock_retries > 0);
    assert.ok(profiles[1]!.queue_ms > 0);
    assert.ok(s.store.prepare('SELECT id FROM runs WHERE id=?').get(id));
  } finally {
    writer?.close();
    pruneChannel.unsubscribe(observe);
    await s.cleanup();
  }
});

test('file pages recheck references committed by another connection between batches', async () => {
  const s = await setup();
  let writer: DatabaseSync | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const kept = await finished(s);
    const first = await s.store.addFile('owner', 'first.txt', Buffer.from('discard')),
      last = await s.store.addFile('owner', 'last.txt', Buffer.from('keep'));
    s.store.db
      .prepare("UPDATE files SET payload=json_set(payload,'$.createdAt',?)")
      .run(Date.now() - 300000);
    writer = new DatabaseSync(path.join(s.store.root, 'state.sqlite'));
    let changed = false;
    const report = await prune(s.store, {
      olderThanMs: 60000,
      batchSize: 1,
      live: true,
      pause: async () => {
        if (changed || s.store.prepare('SELECT 1 FROM files WHERE id=?').get(first.id)) return;
        writer!
          .prepare("UPDATE runs SET payload=json_set(payload,'$.fileIds',json_array(?)) WHERE id=?")
          .run(last.id, kept);
        changed = true;
      },
    });
    assert.equal(changed, true);
    assert.equal(report.files, 1);
    assert.equal((await s.request('GET', `/v1/files/${last.id}/content`)).body, 'keep');
  } finally {
    writer?.close();
    await s.cleanup();
  }
});

test('a rejected manual prune releases the maintenance queue without an orphan rejection', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const id = await finished(s);
    age(s, id);
    s.store.db.exec(
      "CREATE TEMP TRIGGER reject_prune BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'fixture prune write'); END",
    );
    const r = await request(s);
    assert.equal(r.statusCode, 500);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(s.store.run(id).status, 'completed');
    s.store.db.exec('DROP TRIGGER reject_prune');
    const recovered = await request(s);
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().runs, 1);
  } finally {
    await s.cleanup();
  }
});

test('inherited artifacts keep their producer grant and bytes until the last referencing run expires', async () => {
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : {
            calls: [
              {
                id: 'write',
                name: 'write_file',
                arguments: { path: 'retained.txt', content: 'kept artifact' },
              },
            ],
          },
    ),
  );
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [builtin('write_file')] })));
    const src = await finished(s);
    const kept = await finished(s, { previous_response_id: src });
    const id = s.store.run(src).artifactIds[0]!;
    assert.ok(id && s.store.run(kept).artifactIds.includes(id));
    age(s, src);
    const dry = await prune(s.store, { olderThanMs: 60000, dryRun: true });
    assert.equal(dry.files, 0);
    assert.equal(
      s.store.prepare('SELECT count(*) AS n FROM retained_artifact_origins').get()?.n,
      0,
    );
    const r = await request(s);
    assert.equal(r.json().runs, 1);
    assert.equal(r.json().files, 0);
    assert.throws(() => s.store.run(src), { code: 'run_not_found' });
    const endpoint = `/v1/files/${id}/content`;
    const downloaded = await s.request('GET', endpoint);
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    assert.equal(downloaded.body, 'kept artifact');
    assert.equal((await s.request('GET', endpoint, undefined, secondToken)).statusCode, 404);
    const restricted = (
      await s.request('POST', '/v1/keys', {
        name: 'reader',
        agents: ['agent/other'],
        scopes: ['files', 'read'],
        data_scope: 'owner',
      })
    ).json().token;
    assert.equal((await s.request('GET', endpoint, undefined, restricted)).statusCode, 403);
    age(s, kept);
    await request(s);
    assert.equal((await s.request('GET', endpoint)).statusCode, 404);
    assert.equal(
      s.store.prepare('SELECT count(*) AS n FROM retained_artifact_origins').get()?.n,
      0,
    );
  } finally {
    await s.cleanup();
  }
});

test('a recent grandparent or an unsettled old ancestor protects every delegated descendant', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const root = await finished(s),
      child = await finished(s),
      leaf = await finished(s);
    const parent = s.store.prepare('UPDATE runs SET payload=json_set(payload,?,?) WHERE id=?');
    parent.run('$.metadata."oaa.parent_run_id"', root, child);
    parent.run('$.metadata."oaa.parent_run_id"', child, leaf);
    age(s, child);
    age(s, leaf);
    assert.equal((await prune(s.store, { olderThanMs: 60000, dryRun: true })).runs, 0);
    assert.equal((await request(s)).json().runs, 0);
    age(s, root);
    s.store.prepare('INSERT INTO api_key_pending_runs VALUES(?,?,?)').run(root, 'owner', 'pending');
    assert.equal((await request(s)).json().runs, 0);
    s.store.prepare('DELETE FROM api_key_pending_runs WHERE run_id=?').run(root);
    assert.equal((await prune(s.store, { olderThanMs: 60000, batchSize: 1 })).runs, 3);
  } finally {
    await s.cleanup();
  }
});
