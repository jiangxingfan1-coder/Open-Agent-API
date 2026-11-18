/** 内核各模块共用的类型（只含类型）。kernel.ts 再导出其中对外的名字。 */
import type { Principal, RunStatus } from '../core/contracts.js';
import type { ExecutionPool } from './execution-pool.js';

export type KernelLimits = {
  maxActiveRuns: number;
  approvalTimeoutMs: number;
  /** Unfinished requests one caller subject may hold; the owner-wide cap (LIMITS.ownerActiveRuns, 32) still applies. */
  maxActiveRunsPerSubject?: number;
  /** Correction rounds a run with structured output gets when its answer does not fit (default 1). */
  structuredRepairs?: number;
};

export type ExecutionSlice = {
  progressed: boolean;
  tools: ExecutionPool;
  boundary: (pendingApprovals?: string[]) => void;
};

export type QueueInsight = {
  position: number | null;
  ahead: number | null;
  reason: 'admission' | 'fairness' | 'approval' | 'node_busy' | 'cooling_down' | 'unknown';
  estimated_start_ms: number | null;
};

/**
 * 密钥配额与用量记账（由网关通过 Kernel.setAuth 注入）。
 * `agent` 与 `status` 供开发者平台计费：只有带 keyId 的运行（调用方直接提交的根运行）会走到这里，
 * 委托产生的子运行没有 keyId，它们的 token 已经并入父运行的 usage。
 */
export type KernelAuth = {
  checkQuotaForRun(p: Principal, agent?: string): void;
  /** Writes on the run creation transaction. The returned cache update runs only after commit. */
  stageKeyRun(
    keyId: string | undefined,
    owner: string,
    runId: string,
    agent?: string,
  ): (() => void) | undefined;
  /** Throws when the run's own key may not continue it (see Auth.checkResume). */
  checkResume(
    p: Principal,
    run: { id: string; owner: string; agentId: string; keyId?: string },
  ): void;
  /** The run is active again (resumed, or re-queued at startup) without starting a new run. */
  rejoinKeyRun(keyId: string | undefined, runId: string): void;
  finishKeyRun(
    keyId: string | undefined,
    owner: string,
    runId: string,
    usedTokens: number,
    status?: RunStatus,
  ): void;
};
