import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Run } from '../core/contracts.js';

type Database = { db: DatabaseSync; prepare(sql: string): StatementSync };
export type PendingWorkflowEvent = {
  owner: string;
  workflow: string;
  revision: string;
  event: string;
  input: string;
};
export type WorkflowEventKey = Pick<PendingWorkflowEvent, 'owner' | 'workflow' | 'event'>;
// Internal store notification, not a public run event.
export const WORKFLOW_EVENT_READY = 'workflow:delivery-ready';
const enabled = new WeakSet<DatabaseSync>();
const subscribed = `json_valid(payload) AND json_extract(payload,'$.definition.trigger.kind')='event'
  AND json_extract(payload,'$.definition.enabled')=1 AND json_extract(payload,'$.archivedAt') IS NULL`;
const agent = "json_extract(payload,'$.definition.trigger.agent')";
const matchesSource = `owner=? AND ${subscribed} AND ${agent}=?
  AND coalesce(json_extract(payload,'$.definition.trigger.subject'),json_extract(payload,'$.authority.subject'),
               json_extract(payload,'$.authority.keyId'),'owner:'||owner)=?`;
const sameEvent = "owner=w.owner AND workflow=w.id AND event='event:'||w.revision||':'||?";
const uncaptured = `${matchesSource}
  AND NOT EXISTS (SELECT 1 FROM workflow_trigger_receipts WHERE ${sameEvent})
  AND NOT EXISTS (SELECT 1 FROM workflow_pending_events WHERE ${sameEvent})`;

export function enableWorkflowEvents(db: DatabaseSync) {
  if (enabled.has(db)) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS workflow_event_source ON task_workflows(owner,${agent},id) WHERE ${subscribed}`,
  );
  enabled.add(db);
}

/** Called in the final source checkpoint. Never launch work or notify observers here. */
export function stageWorkflowCompletion(store: Database, run: Run): WorkflowEventKey[] {
  const queued: WorkflowEventKey[] = [];
  if (
    run.status !== 'completed' ||
    !run.subject ||
    run.metadata['oaa.workflow_execution'] ||
    run.metadata['oaa.evaluation']
  )
    return queued;
  // A reopened store may commit a checkpoint before its in-process runner is attached.
  if (
    !enabled.has(store.db) &&
    !store
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workflow_pending_events'")
      .get()
  )
    return queued;
  const scope = [run.owner, run.agentId, run.subject];
  if (!store.prepare(`SELECT 1 FROM task_workflows WHERE ${matchesSource} LIMIT 1`).get(...scope))
    return queued;
  const room = Math.max(
    0,
    256 -
      Number(
        store
          .prepare('SELECT count(*) AS n FROM workflow_pending_events WHERE owner=?')
          .get(run.owner)!.n,
      ),
  );
  const args = [...scope, run.id, run.id];
  const matches = store
    .prepare(`SELECT id,revision FROM task_workflows AS w WHERE ${uncaptured} ORDER BY id LIMIT ?`)
    .all(...args, room + 1);
  if (!matches.length) return queued;
  let output = '';
  for (const [i, m] of run.output.entries()) {
    if (i) output += '\n';
    output += m.text.slice(0, 12000 - output.length);
    if (output.length >= 12000) break;
  }
  const input = JSON.stringify({ run_id: run.id, agent: run.agentId, output });
  for (const r of matches.slice(0, room)) {
    const workflow = String(r.id),
      revision = String(r.revision),
      event = `event:${revision}:${run.id}`;
    store
      .prepare(
        'INSERT INTO workflow_pending_events(owner,workflow,event,revision,input) VALUES(?,?,?,?,?)',
      )
      .run(run.owner, workflow, event, revision, input);
    queued.push({ owner: run.owner, workflow, event });
  }
  if (matches.length > room)
    store
      .prepare(
        `UPDATE task_workflows AS w SET payload=json_set(payload,'$.triggerStatus',
      json_object('attemptedAt',?,'error','queue_full')) WHERE ${uncaptured}`,
      )
      .run(run.updatedAt, ...args);
  return queued;
}
