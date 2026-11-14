/**
 * 运行状态机：`Run.status` 的合法转移表。存储层在落盘前按这张表校验（见 store.ts `record`），
 * 内核与测试也可以直接用 `canTransition` / `assertTransition`。
 *
 * - 相同状态的重复写入（from === to）总是合法：那是检查点更新，不是状态转移。
 * - 终态 completed / failed / cancelled / incomplete 不可离开；interrupted 只能经恢复回到 queued。
 * - 新建运行（createRun）不经过这张表：内核只以 queued 新建，测试夹具可以直接种下任意状态。
 *
 * 这张表由全量测试实测得出（docs/architecture.md「运行状态机（0.2.0）」）。放在 core/ 是因为
 * store 是低层，不能引用 kernel；kernel/run-state.ts 再导出。
 */
import type { Checkpoint, RunStatus } from './contracts.js';
import { Fault } from './util.js';

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set<RunStatus>([
    'in_progress', // 拿到运行槽，开始执行（execute）
    'cancelled', // 排队或因调度挂起时被取消（cancel / finishParked）
    'failed', // 调度挂起期间审批被拒或过期（finishParked）
    'incomplete', // 调度挂起期间到达截止时间（finishParked）
  ]),
  in_progress: new Set<RunStatus>([
    'completed', // 正常结束（phase 同时置为 done）
    'queued', // 让出运行槽（调度挂起），或换用备选智能体重新排队
    'requires_action', // 发起审批（含挂起等待审批）
    'failed', // classifyFailure
    'cancelled', // classifyFailure：调用方取消
    'incomplete', // classifyFailure：超时、轮次或预算上限
    'interrupted', // classifyFailure（副作用未确认、节点关闭）或启动时 recover
  ]),
  requires_action: new Set<RunStatus>([
    'in_progress', // 外部智能体在进程内等完审批后继续
    'queued', // 挂起的运行发现审批已批准，重新入场（scheduleParked）
    'failed', // 审批被拒或过期（finishParked），或进程内等待后执行失败（classifyFailure）
    'cancelled', // 挂起期间被取消（finishParked），或进程内等待时被取消
    'incomplete', // 挂起期间到达截止时间（finishParked）
    'interrupted', // 关机时仍在等审批（finishParked），或启动时 recover
  ]),
  interrupted: new Set<RunStatus>([
    'queued', // 操作员显式恢复（resume）
  ]),
  completed: new Set<RunStatus>(),
  failed: new Set<RunStatus>(),
  cancelled: new Set<RunStatus>(),
  incomplete: new Set<RunStatus>(),
};

export const RUN_STATUSES = Object.keys(RUN_TRANSITIONS) as RunStatus[];

/** 不可离开的终态（interrupted 不在其中：它可以经恢复回到 queued）。 */
export const FINAL_STATUSES: readonly RunStatus[] = RUN_STATUSES.filter(
  (s) => RUN_TRANSITIONS[s].size === 0,
);

export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  from === to || RUN_TRANSITIONS[from]?.has(to) === true;

/** phase 与 status 的一致性：进入 completed 时 phase 必须是 done。 */
export const phaseConsistent = (to: RunStatus, phase: Checkpoint['phase']): boolean =>
  to !== 'completed' || phase === 'done';

/** 能转移到 `to` 的全部来源状态（含 `to` 自己）；`phase` 不一致时只剩 `to` 自己（检查点更新）。 */
export const sourcesOf = (to: RunStatus, phase: Checkpoint['phase']): RunStatus[] =>
  phaseConsistent(to, phase) ? RUN_STATUSES.filter((from) => canTransition(from, to)) : [to];

export const transitionFault = (from: string, to: string, phase?: string): Fault =>
  new Fault(
    'invalid_run_transition',
    `Run status cannot change from ${from} to ${to}${phase ? ` (phase ${phase})` : ''}.`,
    500,
  );

export function assertTransition(
  from: RunStatus,
  to: RunStatus,
  phase?: Checkpoint['phase'],
): void {
  if (
    !canTransition(from, to) ||
    (from !== to && phase !== undefined && !phaseConsistent(to, phase))
  )
    throw transitionFault(from, to, phase);
}
