/** 运行的生命周期：启动恢复、结束释放（含 BYOK 密钥）、取消、恢复、核对、等待。 */
import type { Principal, Run } from '../core/contracts.js';
import { terminal, visibleSubject } from '../core/contracts.js';
import { responseObject } from './response-object.js';
import { Fault } from '../core/util.js';
import { isTerminalEvent } from '../core/events.js';
import type { KernelRuntime } from './runtime.js';
import { authorize, checkProviderKey } from './submission.js';
import { expireApprovals } from './approvals.js';

export function start(rt: KernelRuntime): void {
  for (const run of rt.store.allRuns(['queued', 'requires_action'])) {
    const parentId = run.metadata?.['oaa.parent_run_id'];
    if (parentId && !parentActive(rt, parentId)) {
      finishOrphan(rt, run);
      continue;
    }
    rt.admission.queue.push(run.id);
    // 进程内的密钥并发计数不持久化：重启后重新入队的运行重新计入（不增加已用运行次数）。
    rt.auth()?.rejoinKeyRun(run.checkpoint.keyId, run.id);
    if (run.checkpoint.suspension) {
      rt.admission.parked.set(run.id, undefined);
      rt.admission.scheduleParked(run.id);
    }
  }
  rt.admission.pump();
}
export function parentActive(rt: KernelRuntime, parentId: string): boolean {
  try {
    return ['queued', 'in_progress', 'requires_action'].includes(rt.store.run(parentId).status);
  } catch {
    return false;
  }
}
/** 父运行已经不活跃的排队子运行：不再执行（queued 不能直接到 interrupted，以 cancelled 结束）。 */
export function finishOrphan(rt: KernelRuntime, run: Run): void {
  run.status = 'cancelled';
  run.error = {
    code: 'parent_interrupted',
    message: 'The parent run is no longer active; this queued sub-agent run was not started.',
  };
  delete run.checkpoint.suspension;
  expireApprovals(rt, run.id);
  rt.store.checkpoint(run, [], (view) => ({
    type: 'response.cancelled',
    data: { response: responseObject(view) },
  }));
  releaseRun(rt, run);
}
export function releaseRun(rt: KernelRuntime, run: Run): void {
  rt.hub.releaseRun(run.id);
  // 运行已终态却还有等待中的步骤（审批被拒、等待中取消或超时）：它们不会再执行，标为
  // failed 并写明原因。中断的运行可以恢复，步骤保持原样。
  if (terminal(run.status)) {
    const reason = run.error?.code ?? run.status;
    const stale = rt.store.steps(run.id).filter((step) => step.status === 'pending');
    if (stale.length)
      rt.store.batchSteps(
        stale.map((step) => ({
          step: { ...step, status: 'failed' as const, error: `not_executed: ${reason}` },
        })),
      );
  }
  forgetProviderKey(rt, run.id, run.status);
  rt.auth()?.finishKeyRun(
    run.checkpoint.keyId,
    run.owner,
    run.id,
    run.usage?.total_tokens ?? 0,
    run.status,
  );
}
/** Drop a run's caller key when it finishes; an interrupted run keeps it for one hour. */
export function forgetProviderKey(rt: KernelRuntime, runId: string, status: Run['status']): void {
  if (!rt.byokKeys.has(runId)) return;
  clearTimeout(rt.byokExpiry.get(runId));
  rt.byokExpiry.delete(runId);
  if (status !== 'interrupted') {
    rt.byokKeys.delete(runId);
    return;
  }
  const timer = setTimeout(() => {
    rt.byokKeys.delete(runId);
    rt.byokExpiry.delete(runId);
  }, 3_600_000);
  timer.unref();
  rt.byokExpiry.set(runId, timer);
}
export async function cancel(rt: KernelRuntime, principal: Principal, runId: string): Promise<Run> {
  const run = rt.store.run(runId, principal.owner, visibleSubject(principal));
  authorize(principal, run.agentId, 'invoke');
  if (terminal(run.status)) return run;
  if (run.status === 'queued') {
    rt.admission.clearParked(runId);
    run.status = 'cancelled';
    delete run.checkpoint.suspension;
    rt.admission.queue = rt.admission.queue.filter((r) => r !== runId);
    expireApprovals(rt, runId);
    rt.store.checkpoint(run, [], (view) => ({
      type: 'response.cancelled',
      data: { response: responseObject(view) },
    }));
    releaseRun(rt, run);
    return run;
  }
  if (run.checkpoint.suspension && !rt.admission.tasks.has(runId)) {
    rt.admission.finishParked(
      run,
      'cancelled',
      'cancelled',
      'Execution was cancelled while awaiting approval.',
    );
    return run;
  }
  const task = rt.admission.tasks.get(runId);
  const controller = rt.controllers.get(runId);
  // 进行中却不在本进程执行（数据不一致，或别的进程持有它）：明确拒绝，而不是假装已受理。
  if (!task && !controller)
    throw new Fault(
      'run_not_attached',
      'This response is not executing in this gateway process, so it cannot be cancelled here.',
      409,
    );
  controller?.abort();
  await task;
  return rt.store.run(runId, principal.owner, visibleSubject(principal));
}
export function resume(
  rt: KernelRuntime,
  principal: Principal,
  runId: string,
  providerKey?: string,
): Run {
  const run = rt.store.run(runId, principal.owner, visibleSubject(principal));
  authorize(principal, run.agentId, 'invoke');
  if (run.status !== 'interrupted')
    throw new Fault('not_resumable', 'Only interrupted responses can be resumed.', 409);
  if (providerKey !== undefined) {
    checkProviderKey(providerKey);
    if (!run.checkpoint.byok)
      throw new Fault(
        'byok_not_supported',
        'This run does not use a caller-supplied provider key.',
        400,
      );
  } else if (run.checkpoint.byok && !rt.byokKeys.has(runId))
    throw new Fault(
      'byok_key_required',
      'This run uses a caller-supplied provider key; resume it with the X-OAA-Provider-Key header.',
      409,
    );
  if (rt.store.steps(runId).some((s) => s.status === 'uncertain'))
    throw new Fault(
      'reconciliation_required',
      'Resolve uncertain side effects before resuming.',
      409,
    );
  const bundle = rt.store.bundle(run.owner, run.agentId, run.digest);
  if (bundle.agent.engine !== 'kernel')
    throw new Fault(
      'native_resume_unsupported',
      'Interrupted native runs are not automatically replayed.',
      409,
    );
  // 与提交相同的资格检查，针对运行所属的密钥与账号（发起恢复的可能是 owner 的管理员密钥）。
  // 不通过时抛出，运行保持 interrupted，没有任何写入。
  rt.auth()?.checkResume(principal, {
    id: run.id,
    owner: run.owner,
    agentId: run.agentId,
    ...(run.checkpoint.keyId ? { keyId: run.checkpoint.keyId } : {}),
  });
  run.status = 'queued';
  run.error = null;
  delete run.checkpoint.suspension;
  delete run.checkpoint.deadlineAt;
  rt.store.save(run);
  if (providerKey !== undefined) {
    clearTimeout(rt.byokExpiry.get(runId));
    rt.byokExpiry.delete(runId);
    rt.byokKeys.set(runId, providerKey);
  }
  rt.auth()?.rejoinKeyRun(run.checkpoint.keyId, runId);
  rt.admission.queue.push(runId);
  setImmediate(() => rt.admission.pump());
  return run;
}
export function reconcile(
  rt: KernelRuntime,
  principal: Principal,
  runId: string,
  stepId: string,
  outcome: 'completed' | 'not_executed',
  value: unknown,
): void {
  const run = rt.store.run(runId, principal.owner, visibleSubject(principal));
  authorize(principal, run.agentId, 'approve');
  const step = rt.store.getStep(stepId);
  if (!step || step.runId !== runId || step.status !== 'uncertain' || run.status !== 'interrupted')
    throw new Fault(
      'invalid_reconciliation',
      'No uncertain interrupted step matches this request.',
      409,
    );
  step.status = outcome === 'completed' ? 'completed' : 'pending';
  step.result = outcome === 'completed' ? { value } : undefined;
  // 委托步骤核对为「未执行」：不再挂回原来的子运行，恢复时重新委托。
  if (outcome !== 'completed') delete step.childRunId;
  rt.store.step(step, {
    type: 'step.reconciled',
    data: {
      step_id: stepId,
      outcome,
      actor: principal.name,
      evidence: 'operator_assertion',
    },
  });
}
export async function wait(
  rt: KernelRuntime,
  runId: string,
  includeActions = false,
  signal?: AbortSignal,
): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    const cleanup = () => {
      rt.store.events.off(runId, onEvent);
      rt.shutdown.signal.removeEventListener('abort', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const check = () => {
      try {
        const run = rt.store.run(runId);
        if (terminal(run.status) || (includeActions && run.status === 'requires_action')) {
          cleanup();
          resolve(run);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onEvent = (event: { type: string }) => {
      if (isTerminalEvent(event.type) || (includeActions && event.type === 'run.requires_action'))
        check();
    };
    const onClose = () => {
      cleanup();
      reject(new Fault('shutting_down', 'Gateway is shutting down.', 503));
    };
    const onAbort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Fault
          ? signal.reason
          : new Fault(
              'wait_cancelled',
              'Waiting was cancelled; the accepted run was not cancelled.',
              499,
            ),
      );
    };
    rt.store.events.on(runId, onEvent);
    rt.shutdown.signal.addEventListener('abort', onClose, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (rt.shutdown.signal.aborted) onClose();
    else if (signal?.aborted) onAbort();
    else check();
  });
}
