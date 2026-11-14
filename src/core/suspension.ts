import { Fault } from './util.js';

export class ApprovalSuspension extends Error {
  readonly approvalIds: string[];
  constructor(ids: string[]) {
    super('Execution is waiting for approval.');
    this.approvalIds = [...new Set(ids)];
  }
}

export class SchedulingSuspension extends Error {
  readonly approvalIds: string[];
  constructor(ids: string[] = []) {
    super('Execution is yielding at a confirmed checkpoint.');
    this.approvalIds = [...new Set(ids)];
  }
}

// Waiting cannot hide a failed parallel step, especially an uncertain external effect.
export function collectSuspensions(
  outcomes: PromiseSettledResult<unknown>[],
  priorApprovals: string[] = [],
): string[] {
  const errors = outcomes.filter((o) => o.status === 'rejected').map((o) => o.reason as unknown);
  const hard = errors.filter(
    (e) => !(e instanceof ApprovalSuspension) && !(e instanceof SchedulingSuspension),
  );
  if (hard.length) throw hard.find((e) => e instanceof Fault && e.uncertain) ?? hard[0];
  const approvals = [
    ...new Set([
      ...priorApprovals,
      ...errors.flatMap((e) => (e as ApprovalSuspension | SchedulingSuspension).approvalIds),
    ]),
  ];
  if (errors.some((e) => e instanceof SchedulingSuspension))
    throw new SchedulingSuspension(approvals);
  return approvals;
}
