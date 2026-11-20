import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  approvalRows,
  findStepApproval,
  pendingApprovalIds,
  pendingWaiter,
  installApprovalIndexes,
  type Approval,
} from '../src/store/approval-rows.js';

function fixture(history: number, indexed: boolean) {
  const db = new DatabaseSync(':memory:'),
    statements = new Map<string, StatementSync>();
  db.exec(
    'CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX approval_run ON approvals(run_id)',
  );
  if (indexed) installApprovalIndexes(db);
  const put = db.prepare('INSERT INTO approvals VALUES(?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < history + 4; i++) {
    const a: Approval = {
      id: 'a' + i,
      runId: 'r',
      owner: 'o',
      stepId: 'step' + i,
      kind: i % 2 ? 'tool' : 'client_tool',
      status: i >= history ? 'pending' : 'approved',
      detail: { note: 'x'.repeat(512) },
      expiresAt: 0,
    };
    put.run(a.id, a.runId, a.owner, JSON.stringify(a));
  }
  db.exec('COMMIT');
  const store = {
    prepare(sql: string) {
      let s = statements.get(sql);
      if (!s) statements.set(sql, (s = db.prepare(sql)));
      return s;
    },
  };
  return {
    db,
    statements,
    read: indexed
      ? () => [
          pendingApprovalIds(store, 'r', 'client_tool'),
          findStepApproval(store, 'r', 'step5', () => true)?.id,
          pendingWaiter(store, 'r'),
        ]
      : () => [
          approvalRows(store, 'r')
            .filter((a) => a.kind === 'client_tool' && a.status === 'pending')
            .map((a) => a.id),
          approvalRows(store, 'r').findLast((a) => a.stepId === 'step5')?.id,
          approvalRows(store, 'r')
            .filter((a) => a.status === 'pending')
            .some((a) => a.kind !== 'client_tool')
            ? 'owner'
            : 'caller',
        ],
  };
}
for (const history of [64, 4096]) {
  const old = fixture(history, false),
    current = fixture(history, true),
    samples = [[] as number[], [] as number[]];
  try {
    const expected = old.read();
    for (let i = 0; i < 30; i++)
      for (const index of i % 2 ? [1, 0] : [0, 1]) {
        const t = performance.now(),
          result = (index ? current : old).read(),
          ms = performance.now() - t;
        assert.deepEqual(result, expected);
        if (i >= 6) samples[index]!.push(ms);
      }
    const metrics = samples.map((s) => {
      s.sort((a, b) => a - b);
      return { medianMs: +((s[11]! + s[12]!) / 2).toFixed(4), p95Ms: +s[22]!.toFixed(4) };
    });
    const plan = Array.from(current.statements.keys()).flatMap((sql) =>
      current.db
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .all(...Array((sql.match(/\?/g) ?? []).length).fill('r'))
        .map((row) => String(row.detail)),
    );
    console.log(
      JSON.stringify({
        history,
        pending: 4,
        warmSamples: 24,
        baseline: metrics[0],
        indexed: metrics[1],
        plan,
      }),
    );
  } finally {
    old.db.close();
    current.db.close();
  }
}
