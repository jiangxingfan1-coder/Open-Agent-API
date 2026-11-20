import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  approvalRows,
  findStepApproval,
  installApprovalIndexes,
  pendingApprovals,
  pendingApprovalIds,
  pendingWaiter,
  selectedApprovals,
  writeApprovalRow,
  type Approval,
} from '../src/store/approval-rows.js';

test('indexed approval reads preserve per-run order, legacy step matching and pending transitions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL)',
    );
    const row = (
      id: string,
      stepId: string,
      status: Approval['status'],
      kind: Approval['kind'] = 'tool',
    ): Approval => ({
      id,
      stepId,
      status,
      kind,
      runId: 'r',
      owner: 'owner',
      detail: { note: id },
      expiresAt: 10,
    });
    const first = row('older', 'a', 'approved'),
      recent = row('recent', 'a', 'expired'),
      caller = row('caller', 'b', 'pending', 'client_tool'),
      human = row('human', 'c', 'pending');
    for (const a of [first, recent, caller, human, { ...first, id: 'other', runId: 'other' }])
      writeApprovalRow(db, a);
    db.prepare('INSERT INTO approvals VALUES(?,?,?,?)').run(
      'unreadable',
      'legacy',
      'owner',
      'not-json',
    );
    installApprovalIndexes(db);
    assert.equal(
      db.prepare("SELECT payload FROM approvals WHERE id='unreadable'").get()?.payload,
      'not-json',
    );
    assert.equal(findStepApproval(db, 'r', 'a', (a) => a.status === 'approved')?.id, 'older');
    assert.deepEqual(pendingApprovalIds(db, 'r'), ['caller', 'human']);
    assert.deepEqual(pendingApprovals(db, 'r', 'client_tool'), [caller]);
    assert.deepEqual(selectedApprovals(db, 'r', ['human', 'older', 'other', 'older']), [
      first,
      human,
    ]);
    assert.equal(pendingWaiter(db, 'r'), 'owner');
    writeApprovalRow(db, { ...human, status: 'denied' });
    assert.equal(pendingWaiter(db, 'r'), 'caller');
    writeApprovalRow(db, { ...caller, status: 'approved' });
    assert.equal(pendingWaiter(db, 'r'), undefined);
    assert.equal(approvalRows(db, 'r').length, 4);
  } finally {
    db.close();
  }
});
