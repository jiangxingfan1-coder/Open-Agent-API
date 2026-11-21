import type { ExecutionStep, Run } from '../core/contracts.js';
import { terminal } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import type { Approval } from './approval-rows.js';
import type { EventInput } from './output.js';

export type CheckpointOptions = {
  final?: (view: Run) => EventInput;
  completion?: { step: ExecutionStep; artifactIds: string[] };
  reassign?: boolean;
  stageAdmission?: () => () => void;
  actions?: Approval[] | 'expire';
  committed?: () => void;
  failedStep?: ExecutionStep;
  tryLock?: boolean;
};

/** No durable record of the required delivery could be written with this checkpoint. */
export class WebhookCaptureUnavailable extends Fault {
  constructor() {
    super(
      'persistence_failed',
      'The source checkpoint could not preserve its webhook notifications.',
      500,
    );
  }
}

// SQLite extended result codes retain the primary code in their low byte. Restrict retries
// to storage availability, not constraint, corruption, or application programming errors.
const storageUnavailable = new Set([5, 6, 8, 10, 13, 14]); // BUSY, LOCKED, READONLY, IOERR, FULL, CANTOPEN
function sqlitePrimary(error: unknown) {
  return error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    'errcode' in error &&
    typeof error.errcode === 'number'
    ? error.errcode & 255
    : -1;
}
export const isWriteUnavailable = (error: unknown) => storageUnavailable.has(sqlitePrimary(error));
export function isWriteContended(error: unknown) {
  const primary = sqlitePrimary(error);
  return primary === 5 || primary === 6;
}
export const isCheckpointUnavailable = (error: unknown) =>
  error instanceof WebhookCaptureUnavailable || isWriteUnavailable(error);

export function terminalOptions(
  run: Run,
  final: (view: Run) => EventInput,
  failure?: { step?: ExecutionStep },
): CheckpointOptions {
  if (!terminal(run.status))
    throw new Fault(
      'invalid_run_transition',
      'A terminal checkpoint requires a final run status.',
      500,
    );
  const step = failure?.step;
  if (step && (step.runId !== run.id || !['failed', 'uncertain'].includes(step.status)))
    throw new Fault(
      'invalid_step_checkpoint',
      'Failure step must belong to the checkpointed run.',
      409,
    );
  return {
    final,
    tryLock: true,
    ...(failure ? { actions: 'expire' as const, failedStep: step } : {}),
  };
}

export function validateStepCompletion(
  store: { file(id: string, owner: string): { runId?: string } },
  run: Run,
  step: ExecutionStep,
  artifactIds: string[],
  event?: EventInput,
) {
  if (step.runId !== run.id || step.status !== 'completed')
    throw new Fault(
      'invalid_step_checkpoint',
      'A completed step must belong to its checkpointed run.',
      409,
    );
  if (
    event &&
    (!['tool.completed', 'subagent.completed'].includes(event.type) ||
      event.data.step_id !== step.id)
  )
    throw new Fault(
      'invalid_step_checkpoint',
      'The completion event must identify the checkpointed step.',
      409,
    );
  for (const id of artifactIds)
    if (store.file(id, run.owner).runId !== run.id)
      throw new Fault('invalid_step_artifact', 'A step artifact must belong to this run.', 403);
}
