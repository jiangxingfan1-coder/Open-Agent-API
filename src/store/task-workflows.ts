import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Principal, Run, RunStatus } from '../core/contracts.js';
import { Fault, canonical, sha, id } from '../core/util.js';
import { withSavepoint } from './savepoint.js';

type Database = { db: DatabaseSync; prepare(sql: string): StatementSync };
export const RECOVERABLE_WORKFLOW_STATES = "('queued','running','cancelling','blocked')";
export type WorkflowRecord<T> = {
  definition: T;
  revision: string;
  authority: Principal;
  archivedAt?: number;
  triggerStatus?: { attemptedAt: number; error?: string };
};
export type WorkflowExecution<T> = {
  id: string;
  owner: string;
  subject: string;
  definition: T;
  revision: string;
  authority: Principal;
  input: unknown;
  fileIds: string[];
  status: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  cancellation?: Principal;
  nodes: Record<string, string>;
  output?: unknown;
  error?: string;
  createdAt: number;
};
export type WorkflowStage = {
  stage: string;
  run_id: string;
  status: RunStatus | 'unavailable';
  waiting_on?: 'owner' | 'caller';
};
const revisionOf = <T>(record: Omit<WorkflowRecord<T>, 'revision'>) =>
  sha(
    canonical({
      definition: record.definition,
      authority: record.authority,
      archivedAt: record.archivedAt ?? null,
    }),
  );
export function workflowAllowsChildRecovery(
  store: Database,
  run: Pick<Run, 'id' | 'owner' | 'subject' | 'metadata'>,
) {
  const workflow = run.metadata['oaa.workflow_execution'];
  if (!workflow) return true;
  if (run.subject === undefined) return false;
  if (
    !store
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workflow_executions'")
      .get()
  )
    return false;
  const parent = store
    .prepare(
      `SELECT status,json_extract(payload,'$.cancellation') IS NOT NULL AS cancelling,
    EXISTS(SELECT 1 FROM json_each(workflow_executions.payload,'$.nodes') WHERE value=?) AS linked
    FROM workflow_executions WHERE id=? AND owner=? AND subject=?`,
    )
    .get(run.id, workflow, run.owner, run.subject);
  return (
    !!parent &&
    parent.linked === 1 &&
    parent.cancelling === 0 &&
    ['queued', 'running'].includes(String(parent.status))
  );
}
/** Called within child admission, before a child (or its key usage) can become visible. */
export function linkWorkflowStage(store: Database, execution: string, stage: string, child: Run) {
  const field = '$.nodes.' + JSON.stringify(stage);
  if (
    child.metadata['oaa.workflow_execution'] !== execution ||
    !child.subject ||
    !store
      .prepare(
        `UPDATE workflow_executions SET payload=json_set(payload,?,?) WHERE id=? AND owner=? AND subject=?
        AND status='running' AND json_extract(payload,'$.cancellation') IS NULL
        AND (json_type(payload,?) IS NULL OR json_extract(payload,?)=?)`,
      )
      .run(field, child.id, execution, child.owner, child.subject, field, field, child.id).changes
  )
    throw new Fault('not_resumable', 'Workflow is no longer accepting this stage.', 409);
}
export class TaskWorkflows<T extends { id: string }> {
  constructor(private readonly store: Database) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS task_workflows(owner TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS workflow_executions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_execution_owner ON workflow_executions(owner,subject,created_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_trigger_receipts(owner TEXT NOT NULL,workflow TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(owner,workflow,event));
      CREATE TABLE IF NOT EXISTS workflow_pending_events(owner TEXT NOT NULL,workflow TEXT NOT NULL,event TEXT NOT NULL,revision TEXT NOT NULL,input TEXT NOT NULL,PRIMARY KEY(owner,workflow,event));
      CREATE INDEX IF NOT EXISTS workflow_active_owner ON workflow_executions(owner,status);
    `);
  }
  list(owner?: string): WorkflowRecord<T>[] {
    return this.store
      .prepare(`SELECT payload FROM task_workflows${owner ? ' WHERE owner=?' : ''}`)
      .all(...(owner ? [owner] : []))
      .map((row) => JSON.parse(String(row.payload)) as WorkflowRecord<T>);
  }
  get(owner: string, key: string): WorkflowRecord<T> {
    const row = this.store
      .prepare('SELECT payload FROM task_workflows WHERE owner=? AND id=?')
      .get(owner, key);
    if (!row) throw new Fault('scope_denied', 'Workflow not available.', 403);
    return JSON.parse(String(row.payload)) as WorkflowRecord<T>;
  }
  put(owner: string, definition: T, authority: Principal, previous: string) {
    const row = this.store
      .prepare('SELECT revision,payload FROM task_workflows WHERE owner=? AND id=?')
      .get(owner, definition.id);
    if (previous !== (row?.revision ?? 'new'))
      throw new Fault('version_conflict', 'Workflow changed. Refresh before saving.', 409);
    if (row && (JSON.parse(String(row.payload)) as WorkflowRecord<T>).archivedAt)
      throw new Fault('invalid_request', 'Restore the archived workflow before editing it.');
    const record = { definition, authority, revision: revisionOf({ definition, authority }) };
    const changed = this.store
      .prepare(
        'INSERT INTO task_workflows VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload WHERE task_workflows.revision=?',
      )
      .run(owner, definition.id, record.revision, JSON.stringify(record), previous).changes;
    if (!changed)
      throw new Fault('version_conflict', 'Workflow changed. Refresh before saving.', 409);
    return record;
  }
  archive(owner: string, key: string, previous: string, archived: boolean, definition: T) {
    const record = this.get(owner, key);
    if (record.revision !== previous)
      throw new Fault('version_conflict', 'Workflow changed. Refresh before saving.', 409);
    if (definition.id !== key)
      throw new Fault('invalid_request', 'Workflow identity cannot change.');
    if (!!record.archivedAt === archived) return record;
    record.definition = definition;
    if (archived) record.archivedAt = Date.now();
    else delete record.archivedAt;
    delete record.triggerStatus;
    record.revision = revisionOf(record);
    if (
      !this.store
        .prepare(
          'UPDATE task_workflows SET revision=?,payload=? WHERE owner=? AND id=? AND revision=?',
        )
        .run(record.revision, JSON.stringify(record), owner, key, previous).changes
    )
      throw new Fault('version_conflict', 'Workflow changed. Refresh before saving.', 409);
    return record;
  }
  create(value: Omit<WorkflowExecution<T>, 'id' | 'status' | 'nodes' | 'createdAt'>) {
    const count = Number(
      this.store
        .prepare(
          "SELECT count(*) AS n FROM workflow_executions WHERE owner=? AND status IN ('queued','running','cancelling')",
        )
        .get(value.owner)!.n,
    );
    if (count >= 32)
      throw new Fault(
        'concurrency_limit',
        'The owner has too many active workflow executions.',
        429,
      );
    const execution: WorkflowExecution<T> = {
      ...value,
      id: id('workflow'),
      status: 'queued',
      nodes: {},
      createdAt: Date.now(),
    };
    this.store
      .prepare('INSERT INTO workflow_executions VALUES(?,?,?,?,?,?)')
      .run(
        execution.id,
        execution.owner,
        execution.subject,
        execution.status,
        JSON.stringify(execution),
        execution.createdAt,
      );
    return execution;
  }
  noteTrigger(owner: string, key: string, revision: string, error?: string) {
    const current = this.get(owner, key);
    if (current.revision !== revision) return;
    current.triggerStatus = { attemptedAt: Date.now(), ...(error ? { error } : {}) };
    this.store
      .prepare('UPDATE task_workflows SET payload=? WHERE owner=? AND id=? AND revision=?')
      .run(JSON.stringify(current), owner, key, revision);
  }
  save(execution: WorkflowExecution<T>) {
    this.store
      .prepare('UPDATE workflow_executions SET status=?,payload=? WHERE id=? AND owner=?')
      .run(execution.status, JSON.stringify(execution), execution.id, execution.owner);
  }
  execution(owner: string, key: string): WorkflowExecution<T> {
    const row = this.store
      .prepare('SELECT payload FROM workflow_executions WHERE owner=? AND id=?')
      .get(owner, key);
    if (!row) throw new Fault('scope_denied', 'Workflow execution not available.', 403);
    return JSON.parse(String(row.payload)) as WorkflowExecution<T>;
  }
  executions(owner?: string, active = false): WorkflowExecution<T>[] {
    return this.store
      .prepare(
        `SELECT payload FROM workflow_executions WHERE ${owner ? 'owner=?' : '1=1'}${active ? " AND status IN ('queued','running','cancelling') ORDER BY (status='cancelling') DESC,created_at ASC,id ASC" : ' ORDER BY created_at DESC,id DESC'} LIMIT 200`,
      )
      .all(...(owner ? [owner] : []))
      .map((row) => JSON.parse(String(row.payload)) as WorkflowExecution<T>);
  }
  stages(execution: WorkflowExecution<T>): WorkflowStage[] {
    const nodes = Object.entries(execution.nodes).slice(0, 64);
    if (!nodes.length) return [];
    const rows = this.store
      .prepare(
        `SELECT run_id,status,json_extract(payload,'$.waiting_on') AS waiting FROM run_summaries WHERE owner=? AND subject=? AND run_id IN (${nodes.map(() => '?').join(',')})`,
      )
      .all(execution.owner, execution.subject, ...nodes.map(([, runId]) => runId));
    const byId = new Map(rows.map((row) => [String(row.run_id), row]));
    return nodes.map(([stage, run_id]) => {
      const row = byId.get(run_id);
      return {
        stage,
        run_id,
        status: row ? (row.status as RunStatus) : 'unavailable',
        ...(row?.waiting === 'owner' || row?.waiting === 'caller'
          ? { waiting_on: row.waiting }
          : {}),
      };
    });
  }
  admitTrigger(value: Parameters<TaskWorkflows<T>['create']>[0], event: string) {
    const { owner, definition } = value;
    const args = [owner, definition.id, event];
    const admitted = withSavepoint(this.store.db, () => {
      if (
        this.store
          .prepare(
            'SELECT 1 FROM workflow_trigger_receipts WHERE owner=? AND workflow=? AND event=?',
          )
          .get(...args)
      ) {
        this.dropPending(owner, definition.id, event);
        return;
      }
      let execution: WorkflowExecution<T>;
      try {
        execution = this.create(value);
      } catch (error) {
        if (!(
          error instanceof Fault &&
          error.code === 'concurrency_limit' &&
          event.startsWith('event:')
        ))
          throw error;
        this.deferEvent(value, event, value.input);
        return error; // Commit the pending event, but never a receipt for work that was not admitted.
      }
      this.store.prepare('INSERT INTO workflow_trigger_receipts VALUES(?,?,?)').run(...args);
      this.dropPending(owner, definition.id, event);
      return execution;
    });
    if (admitted instanceof Fault) throw admitted;
    return admitted;
  }
  private deferEvent(record: WorkflowRecord<T>, event: string, input: unknown) {
    const owner = record.authority.owner;
    const args = [owner, record.definition.id, event];
    if (
      this.store
        .prepare('SELECT 1 FROM workflow_pending_events WHERE owner=? AND workflow=? AND event=?')
        .get(...args)
    )
      return;
    const count = this.store
      .prepare('SELECT count(*) AS n FROM workflow_pending_events WHERE owner=?')
      .get(owner);
    if (Number(count?.n) >= 256)
      throw new Fault('queue_full', 'The workflow trigger backlog is full.', 429);
    this.store
      .prepare('INSERT INTO workflow_pending_events VALUES(?,?,?,?,?)')
      .run(...args, record.revision, JSON.stringify(input));
  }
  pendingEvents() {
    return this.store
      .prepare(
        `SELECT p.* FROM workflow_pending_events p WHERE
      (SELECT count(*) FROM workflow_executions e WHERE e.owner=p.owner AND e.status IN ('queued','running','cancelling')) < 32
      ORDER BY p.rowid LIMIT 32`,
      )
      .all();
  }
  dropPending(owner: string, workflow: string, event: string) {
    this.store
      .prepare('DELETE FROM workflow_pending_events WHERE owner=? AND workflow=? AND event=?')
      .run(owner, workflow, event);
  }
}
