import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { Fault } from '../core/util.js';
import type { Run } from '../core/contracts.js';

type Db = { prepare(sql: string): StatementSync };
const isPending = "json_valid(payload) AND json_extract(payload,'$.status')='pending'";
const pending = 'run_id=? AND ' + isPending;
export function installApprovalIndexes(db: DatabaseSync) {
  db.exec(`CREATE INDEX IF NOT EXISTS approval_pending_run ON approvals(run_id) WHERE ${isPending};
    CREATE INDEX IF NOT EXISTS approval_step_run ON approvals(run_id,json_extract(payload,'$.stepId')) WHERE json_valid(payload);`);
}
export type Approval = {
  id: string;
  runId: string;
  owner: string;
  stepId: string;
  kind: 'tool' | 'native' | 'reconcile' | 'client_tool';
  detail: Record<string, unknown>;
  response?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: number;
};
export function approvalRows(db: Db, runId: string): Approval[] {
  return db
    .prepare('SELECT payload FROM approvals WHERE run_id=? ORDER BY rowid')
    .all(runId)
    .map((row) => JSON.parse(String(row.payload)));
}
export function approvalRow(db: Db, id: string, owner: string): Approval {
  const row = db.prepare('SELECT payload FROM approvals WHERE id=? AND owner=?').get(id, owner);
  if (!row) throw new Fault('approval_not_found', 'Approval not found.', 404);
  return JSON.parse(String(row.payload));
}
export function pendingApprovals(db: Db, runId: string, kind?: Approval['kind']): Approval[] {
  return db
    .prepare(
      `SELECT payload FROM approvals WHERE ${pending}${kind ? " AND json_extract(payload,'$.kind')=?" : ''} ORDER BY rowid`,
    )
    .all(runId, ...(kind ? [kind] : []))
    .map((row) => JSON.parse(String(row.payload)));
}
export function pendingApprovalIds(db: Db, runId: string, kind?: Approval['kind']): string[] {
  return db
    .prepare(
      `SELECT id FROM approvals WHERE ${pending}${kind ? " AND json_extract(payload,'$.kind')=?" : ''} ORDER BY rowid`,
    )
    .all(runId, ...(kind ? [kind] : []))
    .map((row) => String(row.id));
}
export function findStepApproval(
  db: Db,
  runId: string,
  stepId: string,
  match: (a: Approval) => boolean,
): Approval | undefined {
  for (const row of db
    .prepare(
      "SELECT payload FROM approvals WHERE json_valid(payload) AND run_id=? AND json_extract(payload,'$.stepId')=? ORDER BY rowid DESC",
    )
    .iterate(runId, stepId)) {
    const a = JSON.parse(String(row.payload)) as Approval;
    if (match(a)) return a;
  }
  return undefined;
}
export function selectedApprovals(db: Db, runId: string, ids: string[]): Approval[] {
  if (!ids.length) return [];
  return db
    .prepare(
      'SELECT a.payload FROM json_each(?) i CROSS JOIN approvals a ON a.id=i.value AND a.run_id=? ORDER BY a.rowid',
    )
    .all(JSON.stringify([...new Set(ids)]), runId)
    .map((row) => JSON.parse(String(row.payload)));
}
export function pendingWaiter(db: Db, runId: string): 'owner' | 'caller' | undefined {
  const row = db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM approvals WHERE ${pending} AND json_extract(payload,'$.kind')!='client_tool') AS human,
    EXISTS(SELECT 1 FROM approvals WHERE ${pending}) AS waiting`,
    )
    .get(runId, runId)!;
  return row.human ? 'owner' : row.waiting ? 'caller' : undefined;
}
export function writeApprovalRow(db: Db, a: Approval) {
  const changed = db
    .prepare(
      'INSERT INTO approvals VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE approvals.run_id=excluded.run_id AND approvals.owner=excluded.owner',
    )
    .run(a.id, a.runId, a.owner, JSON.stringify(a));
  if (!changed.changes)
    throw new Fault('approval_not_found', 'Approval does not belong to this run.', 404);
}
/** Called inside the run checkpoint transaction; notifications are published by its caller after commit. */
export function changeApprovalRows(
  db: Db,
  run: { id: string; owner: string },
  actions: 'expire' | Approval[],
): Approval[] {
  if (actions === 'expire')
    return db
      .prepare(
        `UPDATE approvals SET payload=json_set(payload,'$.status','expired')
    WHERE run_id=? AND owner=? AND json_extract(payload,'$.status')='pending' RETURNING payload`,
      )
      .all(run.id, run.owner)
      .map((row) => JSON.parse(String(row.payload)));
  for (const a of actions) {
    if (a.runId !== run.id || a.owner !== run.owner)
      throw new Fault('approval_not_found', 'Approval does not belong to this run.', 404);
    writeApprovalRow(db, a);
  }
  return actions;
}
export function keepParkedOnRestart(db: Db, run: Run): boolean {
  const wait = run.checkpoint.suspension;
  if (run.status !== 'requires_action' || wait?.kind !== 'approval') return false;
  const waiting = pendingWaiter(db, run.id);
  if (waiting) return waiting === 'caller';
  if (!wait.approvalIds.length) return false;
  // Only a confirmed parked boundary with every referenced decision present may escape interruption.
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM approvals a JOIN json_each(?) x ON x.value=a.id
    WHERE a.run_id=? AND a.owner=? AND json_extract(a.payload,'$.status') IN ('approved','denied','expired')`,
    )
    .get(JSON.stringify(wait.approvalIds), run.id, run.owner);
  return Number(row?.n) === wait.approvalIds.length;
}
