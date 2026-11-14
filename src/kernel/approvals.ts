/** 审批：等待与复用审批决定、过期未决审批、处理调用方的决定。 */
import type { Principal, Run } from '../core/contracts.js';
import { terminal, visibleSubject } from '../core/contracts.js';
import type { Approval } from '../store/store.js';
import { Fault, canonical, checkAbort, id } from '../core/util.js';
import { ApprovalSuspension } from '../core/suspension.js';
import type { KernelRuntime } from './runtime.js';
import { authorize } from './submission.js';

export async function awaitApproval(
  rt: KernelRuntime,
  run: Run,
  stepId: string,
  kind: Approval['kind'],
  detail: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  checkAbort(signal);
  const existing = rt.store.approvals(run.id).findLast((a) => {
    const { response: _legacyResponse, ...legacyDetail } = a.detail;
    const requested =
      a.kind === 'tool' && a.response === undefined && a.status !== 'pending'
        ? legacyDetail
        : a.detail;
    return (
      a.stepId === stepId &&
      canonical(requested) === canonical(detail) &&
      ['approved', 'denied', 'pending'].includes(a.status)
    );
  });
  if (existing?.status === 'approved')
    return {
      ...(existing.response ?? (existing.detail.response as Record<string, unknown>) ?? {}),
      decision: 'approve',
    };
  if (existing?.status === 'denied') return { decision: 'deny' };
  const a: Approval = existing ?? {
    id: id('approval'),
    runId: run.id,
    owner: run.owner,
    stepId,
    kind,
    detail,
    status: 'pending',
    expiresAt: Date.now() + rt.limits.approvalTimeoutMs,
  };
  if (!existing) {
    rt.store.approval(a);
    run.status = 'requires_action';
    rt.store.checkpoint(run, [{ type: 'run.requires_action', data: { approval: a } }]);
  }
  checkAbort(signal);
  if (kind === 'tool') {
    if (a.status === 'pending' && Date.now() >= a.expiresAt)
      throw new Fault('approval_expired', 'Approval deadline expired.', 409);
    throw new ApprovalSuspension([a.id]);
  }
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        rt.store.events.off(`approval:${a.id}`, check);
        signal.removeEventListener('abort', check);
      };
      const check = () => {
        if (settled) return;
        try {
          checkAbort(signal);
          const current = rt.store.getApproval(a.id, run.owner);
          if (current.status === 'pending' && Date.now() < a.expiresAt) return arm();
          settled = true;
          cleanup();
          if (current.status === 'approved')
            resolve({
              ...(current.response ?? (current.detail.response as Record<string, unknown>) ?? {}),
              decision: 'approve',
            });
          else if (current.status === 'denied') resolve({ decision: 'deny' });
          else {
            current.status = 'expired';
            rt.store.approval(current);
            reject(new Fault('approval_expired', 'Approval deadline expired.', 409));
          }
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      // 计时器可能比 `Date.now()` 早到（单调时钟与墙上时钟不同步）：没到期就重新计时，不能停住。
      let timer: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(check, Math.max(1, a.expiresAt - Date.now()));
      };
      rt.store.events.on(`approval:${a.id}`, check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  } finally {
    const current = rt.store.getApproval(a.id, run.owner);
    if (current.status === 'pending') {
      current.status = 'expired';
      rt.store.approval(current);
    }
    if (!terminal(run.status)) {
      run.status = rt.store.approvals(run.id).some((a) => a.status === 'pending')
        ? 'requires_action'
        : 'in_progress';
      rt.store.save(run);
    }
  }
}
/**
 * 发布策略 `approvals: 'auto'`：外部智能体的权限请求不进入 requires_action、不等待，直接落一条
 * 已批准的审批记录（`response: { auto: true }`）并发出 `approval.resolved`（actor `policy:auto`），
 * 每次自动批准都可在请求详情与事件里追溯。调用方先经 boundApprovalDetail 过滤超大详情。
 */
export function autoApprove(
  rt: KernelRuntime,
  run: Run,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const a: Approval = {
    id: id('approval'),
    runId: run.id,
    owner: run.owner,
    stepId: `native:${id('action')}`,
    kind: 'native',
    detail,
    response: { auto: true },
    status: 'approved',
    expiresAt: Date.now(),
  };
  rt.store.approval(a, {
    type: 'approval.resolved',
    data: { approval_id: a.id, decision: 'approve', actor: 'policy:auto' },
  });
  return { decision: 'approve' };
}
export function expireApprovals(rt: KernelRuntime, runId: string): void {
  for (const action of rt.store.approvals(runId)) {
    if (action.status !== 'pending') continue;
    action.status = 'expired';
    rt.store.approval(action);
  }
}
export function decide(
  rt: KernelRuntime,
  principal: Principal,
  runId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
  response: Record<string, unknown> = {},
): void {
  const run = rt.store.run(runId, principal.owner, visibleSubject(principal));
  authorize(principal, run.agentId, 'approve');
  const a = rt.store.getApproval(approvalId, principal.owner);
  // 调用方工具的待办只能由调用方经桥接续接回传结果（docs/harness.md），任何入口都不能人工批准。
  if (a.runId === runId && a.kind === 'client_tool')
    throw new Fault(
      'action_kind_mismatch',
      'This action waits for the caller to return a tool result; it cannot be approved or denied here.',
      409,
    );
  if (
    a.runId !== runId ||
    terminal(run.status) ||
    a.status !== 'pending' ||
    Date.now() >= a.expiresAt
  )
    throw new Fault('stale_approval', 'Approval is no longer pending.', 409);
  a.status = decision === 'approve' ? 'approved' : 'denied';
  a.response = response;
  rt.store.approval(a, {
    type: 'approval.resolved',
    data: { approval_id: a.id, decision, actor: principal.name },
  });
  rt.admission.scheduleParked(runId);
  rt.admission.pump();
}
