import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { LEGACY_SUBJECT, type ExecutionStep, type Run } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';
import type { EventInput } from './output.js';
import { isWriteUnavailable } from './checkpoint.js';

type Statements = { prepare(sql: string): StatementSync };
/** The persisted idempotency key is namespaced by caller inside the owner. */
export const idemKey = (subject: string, key: string) => `${subject}\n${key}`;
export function replayId(
  row: { id: string; fingerprint: string | null } | undefined,
  fingerprint?: string,
) {
  if (row && row.fingerprint !== fingerprint)
    throw new Fault('idempotency_conflict', 'The key was used for different input.', 409);
  return row?.id;
}
export function insertNewRun(
  store: Statements,
  run: Run,
  snapshot: string,
  idem?: string,
  fingerprint?: string,
) {
  store
    .prepare(
      'INSERT INTO runs(id,owner,agent_id,session_id,status,payload,idem,fingerprint,subject) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      run.id,
      run.owner,
      run.agentId,
      run.sessionId,
      run.status,
      snapshot,
      idem ? idemKey(run.subject ?? LEGACY_SUBJECT, idem) : null,
      fingerprint ?? null,
      run.subject ?? LEGACY_SUBJECT,
    );
  store
    .prepare('INSERT INTO run_output_baselines VALUES(?,0,?)')
    .run(run.id, JSON.stringify(run.output));
}

export type ParentStepStart = { step: ExecutionStep; depth: number };
export class UnconfirmedRunCommit extends Fault {
  constructor(
    readonly runId: string,
    readonly parentStep?: ExecutionStep,
  ) {
    super(
      'effect_outcome_unknown',
      bi(
        `无法确认运行 ${runId} 的提交结果，请先按 ID 查询，不要直接重发。`,
        `The commit for run ${runId} could not be confirmed. Check its state before resubmitting.`,
      ),
      409,
      true,
    );
  }
}
/** An I/O failure can arrive after COMMIT. Only a confirmed row permits normal publication. */
export function commitNewRun(
  store: Statements & { db: DatabaseSync },
  run: Run,
  parent?: ParentStepStart,
) {
  try {
    store.db.exec('COMMIT');
  } catch (error) {
    if (store.db.isTransaction || !isWriteUnavailable(error)) throw error;
    let saved;
    try {
      saved = store
        .prepare('SELECT 1 FROM runs WHERE id=? AND owner=? AND subject=?')
        .get(run.id, run.owner, run.subject ?? LEGACY_SUBJECT);
    } catch {
      throw new UnconfirmedRunCommit(
        run.id,
        parent
          ? {
              ...parent.step,
              childRunId: run.id,
              status: 'uncertain',
              error: 'effect_outcome_unknown',
            }
          : undefined,
      );
    }
    if (!saved) throw error;
  }
}
const active = new Set(['queued', 'in_progress', 'requires_action']);
function scopedParent(store: Statements, child: Run, id: string) {
  const parent = store.prepare('SELECT owner,subject,status FROM runs WHERE id=?').get(id);
  return parent?.owner === child.owner &&
    (parent.subject ?? LEGACY_SUBJECT) === (child.subject ?? LEGACY_SUBJECT)
    ? parent
    : undefined;
}
/** Link a freshly created child without publishing the provisional step to observers. */
export function linkDelegateStart(
  store: Statements & {
    getStep(id: string): ExecutionStep | undefined;
    step(value: ExecutionStep): void;
  },
  child: Run,
  { step, depth }: ParentStepStart,
): EventInput {
  const parent = scopedParent(store, child, step.runId);
  const current = store.getStep(step.id);
  if (
    !parent ||
    !active.has(String(parent.status)) ||
    child.metadata['oaa.parent_run_id'] !== step.runId ||
    child.metadata['oaa.delegate_name'] !== step.name ||
    step.id !== child.checkpoint.parentStepId ||
    depth !== child.checkpoint.delegationDepth ||
    current?.childRunId !== step.childRunId ||
    (current && (current.name !== step.name || current.callId !== step.callId)) ||
    current?.status === 'completed' ||
    current?.status === 'uncertain'
  )
    throw new Fault(
      'invalid_step_checkpoint',
      'The delegate no longer matches its active parent step.',
      409,
    );
  store.step({ ...step, status: 'running', childRunId: child.id });
  return {
    type: 'subagent.started',
    data: {
      step_id: step.id,
      delegate: step.name,
      target_agent: child.agentId,
      depth,
      child_run_id: child.id,
    },
  };
}

/** Legacy queues have no parentStepId. Search only that parent's steps, never guess from an agent name. */
export function delegateRecoveryBlock(
  store: Statements,
  child: Run,
  requireActive = true,
): 'inactive' | 'unlinked' | undefined {
  const parentId = child.metadata['oaa.parent_run_id'],
    stepId = child.checkpoint.parentStepId;
  if (!parentId) return stepId ? 'unlinked' : undefined;
  const parent = scopedParent(store, child, parentId);
  if (!parent || (requireActive && !active.has(String(parent.status)))) return 'inactive';
  const name = child.metadata['oaa.delegate_name'];
  if (!stepId && !name) return undefined;
  if (!name) return 'unlinked';
  const match =
    "json_extract(payload,'$.childRunId')=? AND json_extract(payload,'$.name')=? AND json_extract(payload,'$.status') IN ('pending','running')";
  const found = stepId
    ? store
        .prepare(`SELECT 1 FROM steps WHERE id=? AND run_id=? AND ${match}`)
        .get(stepId, parentId, child.id, name)
    : store
        .prepare(`SELECT 1 FROM steps WHERE run_id=? AND ${match} LIMIT 1`)
        .get(parentId, child.id, name);
  return found ? undefined : 'unlinked';
}
