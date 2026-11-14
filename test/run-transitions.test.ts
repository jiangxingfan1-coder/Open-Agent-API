import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Run, RunStatus } from '../src/core/contracts.js';
import { terminal } from '../src/core/contracts.js';
import { Store } from '../src/store/store.js';
import { Fault } from '../src/core/util.js';
import {
  RUN_TRANSITIONS,
  FINAL_STATUSES,
  assertTransition,
  canTransition,
} from '../src/kernel/run-state.js';

const ALL = Object.keys(RUN_TRANSITIONS) as RunStatus[];

const fixture = (id: string, status: RunStatus): Run => ({
  id,
  owner: 'owner',
  agentId: 'agent/test',
  digest: 'a'.repeat(64),
  sessionId: `session_${id}`,
  previousId: null,
  status,
  createdAt: 1,
  updatedAt: 1,
  input: 'fixture',
  fileIds: [],
  output: [],
  usage: null,
  checkpoint: { messages: [], turn: 1, phase: 'model' },
  error: null,
  artifactIds: [],
  metadata: {},
  route: { id: 'default', provider: 'fixture', model: 'fixture', mode: 'auto' },
});

async function withStore(fn: (store: Store) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-transitions-'));
  const store = new Store(root);
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const dbStatus = (store: Store, id: string) =>
  String(store.db.prepare('SELECT status FROM runs WHERE id=?').get(id)!.status);

const isTransitionFault = (e: unknown) =>
  e instanceof Fault && e.code === 'invalid_run_transition' && e.status === 500;

const EDGES = ALL.flatMap((from) => [...RUN_TRANSITIONS[from]].map((to) => [from, to] as const));

test('run transitions: table shape and terminal rules', () => {
  assert.deepEqual([...FINAL_STATUSES].sort(), ['cancelled', 'completed', 'failed', 'incomplete']);
  assert.deepEqual([...RUN_TRANSITIONS.interrupted], ['queued']);
  for (const s of ALL) assert.equal(canTransition(s, s), true, `${s} -> ${s} is a checkpoint`);
  // 终态不可离开；interrupted 虽被 terminal() 视为结束，但可以经 resume 回到 queued。
  for (const s of FINAL_STATUSES) assert.equal(terminal(s), true);
  assert.equal(terminal('interrupted'), true);
  assert.throws(() => assertTransition('completed', 'queued'), isTransitionFault);
  assert.throws(() => assertTransition('in_progress', 'completed', 'model'), isTransitionFault);
  assertTransition('in_progress', 'completed', 'done');
  assertTransition('completed', 'completed', 'model');
});

test('run transitions: every legal edge is persisted by the store', async () => {
  await withStore((store) => {
    for (const [from, to] of EDGES) {
      const run = fixture(`resp_${from}_${to}`, from);
      store.createRun(run);
      run.status = to;
      if (to === 'completed') run.checkpoint.phase = 'done';
      store.checkpoint(run);
      assert.equal(dbStatus(store, run.id), to, `${from} -> ${to}`);
      assert.equal(store.run(run.id).status, to);
    }
    assert.ok(EDGES.length >= 18);
  });
});

const ILLEGAL: [RunStatus, RunStatus][] = [
  ['queued', 'completed'],
  ['queued', 'requires_action'],
  ['queued', 'interrupted'],
  ['interrupted', 'in_progress'],
  ['interrupted', 'completed'],
  ['interrupted', 'failed'],
  ['completed', 'queued'],
  ['completed', 'in_progress'],
  ['failed', 'queued'],
  ['cancelled', 'in_progress'],
  ['incomplete', 'queued'],
  ['completed', 'failed'],
];

test('run transitions: illegal edges are rejected and leave the stored run untouched', async () => {
  await withStore((store) => {
    for (const [from, to] of ILLEGAL) {
      assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
      const run = fixture(`resp_bad_${from}_${to}`, from);
      store.createRun(run);
      const before = store.db.prepare('SELECT * FROM runs WHERE id=?').get(run.id);
      const summary = store.db.prepare('SELECT * FROM run_summaries WHERE run_id=?').get(run.id);
      const events = store.db
        .prepare('SELECT count(*) AS n FROM events WHERE run_id=?')
        .get(run.id);
      run.status = to;
      if (to === 'completed') run.checkpoint.phase = 'done';
      assert.throws(
        () =>
          store.checkpoint(run, [{ type: 'run.queued', data: { reason: 'test' } }], () => ({
            type: 'response.completed',
            data: {},
          })),
        isTransitionFault,
        `${from} -> ${to}`,
      );
      assert.deepEqual(store.db.prepare('SELECT * FROM runs WHERE id=?').get(run.id), before);
      assert.deepEqual(
        store.db.prepare('SELECT * FROM run_summaries WHERE run_id=?').get(run.id),
        summary,
      );
      assert.deepEqual(
        store.db.prepare('SELECT count(*) AS n FROM events WHERE run_id=?').get(run.id),
        events,
      );
      assert.equal(store.run(run.id).status, from);
    }
  });
});

test('run transitions: final statuses cannot be overwritten through any write entry', async () => {
  await withStore((store) => {
    for (const final of FINAL_STATUSES) {
      for (const to of ALL.filter((s) => s !== final)) {
        const run = fixture(`resp_final_${final}_${to}`, final);
        store.createRun(run);
        run.status = to;
        if (to === 'completed') run.checkpoint.phase = 'done';
        assert.throws(() => store.save(run), isTransitionFault, `save ${final} -> ${to}`);
        assert.throws(
          () => store.checkpointReassigned(run, []),
          isTransitionFault,
          `reassign ${final} -> ${to}`,
        );
        assert.equal(dbStatus(store, run.id), final);
      }
      // 同状态的检查点更新仍然允许。
      const same = fixture(`resp_final_same_${final}`, final);
      store.createRun(same);
      same.metadata = { note: 'updated' };
      store.save(same);
      assert.equal(store.run(same.id).metadata.note, 'updated');
    }
  });
});

test('run transitions: completed requires phase done; recover only moves active runs', async () => {
  await withStore((store) => {
    const run = fixture('resp_phase', 'in_progress');
    store.createRun(run);
    run.status = 'completed';
    run.checkpoint.phase = 'tools';
    assert.throws(() => store.checkpoint(run), isTransitionFault);
    assert.equal(dbStatus(store, run.id), 'in_progress');
    run.checkpoint.phase = 'done';
    store.checkpoint(run);
    assert.equal(dbStatus(store, run.id), 'completed');

    store.createRun(fixture('resp_active', 'requires_action'));
    store.createRun(fixture('resp_done', 'failed'));
    store.recover();
    assert.equal(dbStatus(store, 'resp_active'), 'interrupted');
    assert.equal(dbStatus(store, 'resp_done'), 'failed');
    assert.equal(dbStatus(store, 'resp_phase'), 'completed');
  });
});
