import type { ExecutionStep, Run } from '../core/contracts.js';
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
