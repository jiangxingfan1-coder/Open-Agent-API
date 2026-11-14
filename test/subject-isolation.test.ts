import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { Store } from '../src/store/store.js';
import type { ModelMessage, Run } from '../src/core/contracts.js';
import { FixtureModel, agent, researchBundle, researchFixture, setup, waitFor } from './helpers.js';

// Schema v4 caller isolation: API keys of one owner must not see each other's runs, files,
// memories or idempotency keys. Everything runs in-process via inject (no sockets, no models).

type Setup = Awaited<ReturnType<typeof setup>>;
const callerScopes = ['read', 'invoke', 'files', 'approve'];
async function callerKey(s: Setup, name: string, agents = ['*']): Promise<string> {
  const created = await s.request('POST', '/v1/keys', { name, agents, scopes: callerScopes });
  assert.equal(created.statusCode, 200, created.body);
  return created.json().token as string;
}

test('API keys of one owner cannot read, continue or reuse each other’s work', async () => {
  const s = await setup(researchFixture());
  try {
    s.store.publish('owner', researchBundle());
    const a = await callerKey(s, 'caller-a');
    const b = await callerKey(s, 'caller-b');

    const upload = await s.request(
      'POST',
      '/v1/files',
      { filename: 'secret.txt', content: 'A private source' },
      a,
    );
    assert.equal(upload.statusCode, 200, upload.body);
    const fileId = upload.json().id as string;
    const body = {
      model: 'agent/research',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Create a report.' },
            { type: 'input_file', file_id: fileId },
          ],
        },
      ],
    };
    const created = await s.request('POST', '/v1/responses', body, a, {
      'idempotency-key': 'task-1',
    });
    assert.equal(created.json().status, 'completed', created.body);
    const runId = created.json().id as string;
    const artifactId = (await s.request('GET', `/v1/runs/${runId}/artifacts`, undefined, a)).json()
      .data[0]?.id as string;
    assert.ok(artifactId, 'the research fixture writes an artifact');

    // The owner of the data still sees everything it created.
    assert.equal((await s.request('GET', `/v1/responses/${runId}`, undefined, a)).statusCode, 200);
    assert.equal(
      (await s.request('GET', `/v1/files/${fileId}/content`, undefined, a)).statusCode,
      200,
    );

    // Another caller of the same owner sees none of it, and existence is not revealed.
    const listed = (await s.request('GET', '/v1/runs', undefined, b)).json().data as {
      id: string;
    }[];
    assert.equal(listed.length, 0);
    for (const url of [
      `/v1/responses/${runId}`,
      `/v1/runs/${runId}`,
      `/v1/runs/${runId}/state`,
      `/v1/runs/${runId}/timeline`,
      `/v1/runs/${runId}/output`,
      `/v1/runs/${runId}/steps`,
      `/v1/runs/${runId}/artifacts`,
      `/v1/runs/${runId}/events`,
    ]) {
      const r = await s.request('GET', url, undefined, b);
      assert.equal(r.statusCode, 404, `${url}: ${r.body}`);
      assert.equal(r.json().error.code, 'run_not_found', url);
    }
    for (const id of [fileId, artifactId]) {
      const r = await s.request('GET', `/v1/files/${id}/content`, undefined, b);
      assert.equal(r.statusCode, 404, r.body);
      assert.equal(r.json().error.code, 'file_not_found');
    }
    assert.equal(
      (await s.request('POST', `/v1/responses/${runId}/cancel`, undefined, b)).statusCode,
      404,
    );
    assert.equal(
      (await s.request('POST', `/v1/runs/${runId}/resume`, undefined, b)).statusCode,
      404,
    );

    // No continuation of another caller's session, and no use of its files as input.
    const continued = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/research', input: 'Continue.', previous_response_id: runId },
      b,
    );
    assert.equal(continued.statusCode, 404, continued.body);
    const borrowed = await s.request('POST', '/v1/responses', body, b);
    assert.equal(borrowed.statusCode, 404, borrowed.body);
    assert.equal(borrowed.json().error.code, 'file_not_found');

    // The same idempotency key from another caller is a new request, not a replay.
    const ownFile = (
      await s.request('POST', '/v1/files', { filename: 'own.txt', content: 'B source' }, b)
    ).json().id as string;
    const bBody = {
      ...body,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Create a report.' },
            { type: 'input_file', file_id: ownFile },
          ],
        },
      ],
    };
    const bRun = await s.request('POST', '/v1/responses', bBody, b, {
      'idempotency-key': 'task-1',
    });
    assert.equal(bRun.statusCode, 200, bRun.body);
    assert.notEqual(bRun.json().id, runId);
    // ...while each caller still gets its own replay.
    const replayA = await s.request('POST', '/v1/responses', body, a, {
      'idempotency-key': 'task-1',
    });
    assert.equal(replayA.json().id, runId);
    const replayB = await s.request('POST', '/v1/responses', bBody, b, {
      'idempotency-key': 'task-1',
    });
    assert.equal(replayB.json().id, bRun.json().id);

    // Overview metrics and activity only count the caller's own runs.
    assert.equal((await s.request('GET', '/v1/overview', undefined, b)).json().metrics.runs, 1);
    assert.equal((await s.request('GET', '/v1/overview', undefined, a)).json().metrics.runs, 1);
    const pulse = (await s.request('GET', '/v1/overview/activity?window=24h', undefined, b)).json();
    assert.equal(pulse.totals.started, 1, JSON.stringify(pulse.totals));

    // The owner-wide admin key keeps its full operational view.
    const all = (await s.request('GET', '/v1/runs')).json().data as { id: string }[];
    assert.deepEqual(new Set(all.map((r) => r.id)), new Set([runId, bRun.json().id]));
    assert.equal((await s.request('GET', `/v1/responses/${runId}`)).statusCode, 200);
    assert.equal((await s.request('GET', `/v1/files/${fileId}/content`)).statusCode, 200);
    assert.equal((await s.request('GET', '/v1/overview')).json().metrics.runs, 2);
  } finally {
    await s.cleanup();
  }
});

test('memories are partitioned per caller; only owner-wide admins may name another subject', async () => {
  const s = await setup();
  try {
    const a = await callerKey(s, 'mem-a');
    const b = await callerKey(s, 'mem-b');
    const keys = (await s.request('GET', '/v1/keys')).json().data as { id: string; name: string }[];
    const aId = keys.find((k) => k.name === 'mem-a')!.id;

    assert.equal(
      (await s.request('POST', '/v1/memory', { key: 'plan', value: { step: 1 } }, a)).statusCode,
      200,
    );
    assert.deepEqual(
      (await s.request('GET', '/v1/memory?key=plan', undefined, a)).json().entry.value,
      { step: 1 },
    );
    assert.equal((await s.request('GET', '/v1/memory?key=plan', undefined, b)).json().entry, null);
    assert.equal((await s.request('GET', '/v1/memory', undefined, b)).json().data.length, 0);
    // B writing the same key creates its own entry and leaves A's untouched.
    await s.request('POST', '/v1/memory', { key: 'plan', value: 'b' }, b);
    assert.deepEqual(
      (await s.request('GET', '/v1/memory?key=plan', undefined, a)).json().entry.value,
      { step: 1 },
    );
    assert.equal(
      (await s.request('DELETE', '/v1/memory?key=plan', undefined, b)).json().deleted,
      true,
    );
    assert.ok((await s.request('GET', '/v1/memory?key=plan', undefined, a)).json().entry);

    // A caller cannot reach into another partition by naming it.
    const denied = await s.request('GET', `/v1/memory?key=plan&subject=${aId}`, undefined, b);
    assert.equal(denied.statusCode, 403, denied.body);
    // The owner-wide admin can, for audits and legacy rows; by default it uses its own partition.
    assert.equal((await s.request('GET', '/v1/memory?key=plan')).json().entry, null);
    assert.deepEqual(
      (await s.request('GET', `/v1/memory?key=plan&subject=${aId}`)).json().entry.value,
      { step: 1 },
    );
  } finally {
    await s.cleanup();
  }
});

test('agent memory tools and delegated sub-runs stay in the calling subject', async () => {
  const toolTurns = (messages: ModelMessage[]) => messages.filter((m) => m.role === 'tool').length;
  const driver = new FixtureModel((def, messages) => {
    if (def.id === 'agent/child') return { text: 'child done' };
    const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
    if (toolTurns(messages) === 0) {
      if (prompt.startsWith('remember'))
        return {
          calls: [
            { id: 'w1', name: 'memory_write', arguments: { key: 'fact', value: prompt.slice(9) } },
          ],
        };
      if (prompt.startsWith('recall'))
        return { calls: [{ id: 'r1', name: 'memory_read', arguments: { key: 'fact' } }] };
      if (prompt.startsWith('delegate'))
        return { calls: [{ id: 'd1', name: 'ask_child', arguments: { task: 'help' } }] };
    }
    const last = messages.at(-1)!;
    return { text: last.role === 'tool' ? `tool said ${last.content}` : 'ok' };
  });
  const s = await setup(driver);
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/memo',
          tools: [builtin('memory_read'), builtin('memory_write')],
          delegates: [{ name: 'ask_child', agent: 'agent/child' }],
        }),
      ),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/child' })));
    const a = await callerKey(s, 'tool-a');
    const b = await callerKey(s, 'tool-b');
    const ask = async (input: string, key: string) => {
      const r = await s.request('POST', '/v1/responses', { model: 'agent/memo', input }, key);
      assert.equal(r.json().status, 'completed', r.body);
      return r.json() as { id: string; output: { content: { text: string }[] }[] };
    };
    await ask('remember blue', a);
    const recalledByA = await ask('recall', a);
    assert.match(recalledByA.output.at(-1)!.content[0]!.text, /"found":true/);
    assert.match(recalledByA.output.at(-1)!.content[0]!.text, /blue/);
    const recalledByB = await ask('recall', b);
    assert.match(recalledByB.output.at(-1)!.content[0]!.text, /"found":false/);

    // The delegate's run belongs to the caller that started the parent.
    const parent = await ask('delegate', a);
    const child = s.store.allRuns().find((r) => r.metadata['oaa.parent_run_id'] === parent.id) as
      Run | undefined;
    assert.ok(child, 'delegate run created');
    assert.equal(child.subject, s.store.run(parent.id).subject);
    assert.equal(
      (await s.request('GET', `/v1/responses/${child.id}`, undefined, a)).statusCode,
      200,
    );
    assert.equal(
      (await s.request('GET', `/v1/responses/${child.id}`, undefined, b)).statusCode,
      404,
    );
  } finally {
    await s.cleanup();
  }
});

test('maxActiveRunsPerSubject caps one caller without blocking the others', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const s = await setup(
    new FixtureModel(async () => {
      await gate;
      return { text: 'done' };
    }),
    { maxActiveRunsPerSubject: 1 },
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const a = await callerKey(s, 'busy-a');
    const b = await callerKey(s, 'busy-b');
    const submit = (key: string) =>
      s.request(
        'POST',
        '/v1/responses',
        { model: 'agent/test', input: 'x', background: true },
        key,
      );
    const first = await submit(a);
    assert.equal(first.statusCode, 200, first.body);
    const second = await submit(a);
    assert.equal(second.statusCode, 429, second.body);
    assert.equal(second.json().error.code, 'subject_concurrency_limit');
    assert.equal((await submit(b)).statusCode, 200);
    release();
    await waitFor(() => s.store.activeCount('owner') === 0);
    assert.equal((await submit(a)).statusCode, 200);
  } finally {
    release();
    await s.cleanup();
  }
});

// A v3 database as the previous gateway wrote it (only the tables whose shape v4 changes).
const V3_TABLES = `
  CREATE TABLE runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, idem TEXT, fingerprint TEXT, UNIQUE(owner,idem));
  CREATE TABLE run_output_baselines (run_id TEXT PRIMARY KEY REFERENCES runs(id), cursor INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE run_summaries (run_id TEXT PRIMARY KEY REFERENCES runs(id), owner TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, ordinal INTEGER NOT NULL, total_tokens INTEGER NOT NULL, usage_known INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE files (id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE memories (owner TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,run_id TEXT,PRIMARY KEY(owner,namespace,key));
  CREATE INDEX memory_owner_ns ON memories(owner,namespace,updated_at DESC);
  PRAGMA user_version=3;`;
function v3Run(id: string, overrides: Partial<Run> = {}, keyId?: string): Run {
  return {
    id,
    owner: 'owner',
    agentId: 'agent/test',
    digest: 'a'.repeat(64),
    sessionId: `session_${id}`,
    previousId: null,
    status: 'completed',
    createdAt: 1000,
    updatedAt: 2000,
    input: 'input',
    fileIds: [],
    output: [],
    usage: null,
    checkpoint: { messages: [], turn: 0, phase: 'model', ...(keyId ? { keyId } : {}) },
    error: null,
    artifactIds: [],
    metadata: {},
    route: { id: 'default', provider: 'fixture', model: 'fixture', mode: 'auto' },
    ...overrides,
  };
}

test('v3 → v4 migration attributes existing rows, keeps idempotent replays and backs up first', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-subjects-'));
  try {
    const db = new DatabaseSync(path.join(root, 'state.sqlite'));
    db.exec(V3_TABLES);
    const runs: [Run, string | null][] = [
      [v3Run('resp_a', { fileIds: ['file_up'] }, 'key_a'), 'task-1'],
      [v3Run('resp_child', { metadata: { 'oaa.parent_run_id': 'resp_a' } }), null],
      [v3Run('resp_grandchild', { metadata: { 'oaa.parent_run_id': 'resp_child' } }), null],
      [v3Run('resp_b', { fileIds: ['file_shared'] }, 'key_b'), 'task-2'],
      [v3Run('resp_a2', { fileIds: ['file_shared'] }, 'key_a'), null],
      [v3Run('resp_old'), null],
    ];
    for (const [run, idem] of runs) {
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(
        run.id,
        run.owner,
        run.agentId,
        run.sessionId,
        run.status,
        JSON.stringify(run),
        idem,
        idem ? 'fp' : null,
      );
      db.prepare('INSERT INTO run_output_baselines VALUES(?,0,?)').run(run.id, '[]');
      db.prepare(
        "INSERT INTO run_summaries SELECT id,owner,agent_id,status,rowid,0,0,'{}' FROM runs WHERE id=?",
      ).run(run.id);
    }
    const file = (fileId: string, runId?: string) =>
      db
        .prepare('INSERT INTO files VALUES(?,?,?)')
        .run(fileId, 'owner', JSON.stringify({ id: fileId, owner: 'owner', name: 'f', runId }));
    file('file_up'); // uploaded, used only by key_a's run
    file('file_art', 'resp_grandchild'); // artifact of a nested delegate
    file('file_shared'); // used by two callers: cannot be attributed
    file('file_unused');
    const memory = db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?)');
    memory.run('owner', 'agent/test', 'from_run', '1', 1, 'resp_a');
    memory.run('owner', 'default', 'from_api', '2', 1, null);
    db.close();

    const store = new Store(root);
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
      const subject = (id: string) => store.run(id).subject;
      assert.equal(subject('resp_a'), 'key_a');
      assert.equal(subject('resp_child'), 'key_a');
      assert.equal(subject('resp_grandchild'), 'key_a');
      assert.equal(subject('resp_b'), 'key_b');
      assert.equal(subject('resp_old'), 'legacy');
      // Payload and summaries agree with the column.
      assert.equal(
        JSON.parse(
          store.db.prepare("SELECT payload FROM runs WHERE id='resp_a'").get()!.payload as string,
        ).subject,
        'key_a',
      );
      assert.equal(store.summaries('owner', ['*'], 50, 'key_a').length, 4);
      assert.equal(store.summaries('owner', ['*'], 50, 'legacy').length, 1);

      // v3 keys were owner-wide, so they cannot collide yet; each replay stays with its caller.
      assert.equal(store.findIdempotent('owner', 'key_a', 'task-1')?.id, 'resp_a');
      assert.equal(store.findIdempotent('owner', 'key_b', 'task-2')?.id, 'resp_b');
      assert.equal(store.findIdempotent('owner', 'key_b', 'task-1'), undefined);
      assert.equal(store.findIdempotent('owner', 'legacy', 'task-1'), undefined);

      assert.equal(store.file('file_up', 'owner', 'key_a').id, 'file_up');
      assert.equal(store.file('file_art', 'owner', 'key_a').id, 'file_art');
      assert.throws(() => store.file('file_shared', 'owner', 'key_a'), /File not found/);
      assert.equal(store.file('file_shared', 'owner', 'legacy').id, 'file_shared');
      assert.equal(store.file('file_unused', 'owner', 'legacy').id, 'file_unused');

      assert.equal(store.getMemory('owner', 'key_a', 'agent/test', 'from_run')?.value, 1);
      assert.equal(store.getMemory('owner', 'legacy', 'default', 'from_api')?.value, 2);
      assert.equal(store.getMemory('owner', 'key_a', 'default', 'from_api'), undefined);

      const backups = await readdir(path.join(root, 'backups'));
      assert.equal(backups.length, 1);
      assert.match(backups[0]!, /^state-v3-before-subjects-\d+\.sqlite$/);
      const copy = new DatabaseSync(path.join(root, 'backups', backups[0]!), { readOnly: true });
      try {
        assert.equal(copy.prepare('PRAGMA user_version').get()!.user_version, 3);
        assert.equal(copy.prepare('SELECT count(*) AS n FROM runs').get()!.n, runs.length);
      } finally {
        copy.close();
      }
    } finally {
      store.close();
    }
    // Reopening a v4 database neither migrates nor backs up again.
    new Store(root).close();
    assert.equal((await readdir(path.join(root, 'backups'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fresh data directory starts at v4 without a backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-subjects-fresh-'));
  try {
    const store = new Store(root);
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    } finally {
      store.close();
    }
    assert.ok(!(await readdir(root)).includes('backups'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
