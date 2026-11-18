import { JsonSchemas } from '../core/schemas.js';
import { setMaxListeners } from 'node:events';
import type { Principal, Run, TraceContext, WorkContext } from '../core/contracts.js';
import { Store } from '../store/store.js';
import { NodeHub } from '../fabric/network.js';
import { type Invocation, type PreviewRequest } from './invocation.js';
import * as clientTools from './client-tools.js';
import { ModelRouter } from './routing.js';
import { ToolCache } from './tool-cache.js';
import type { DelegateRuntime } from './delegate.js';
import { Admission } from './admission.js';
import type { KernelRuntime } from './runtime.js';
import type { KernelAuth, KernelLimits, QueueInsight } from './types.js';
import { linkWorkflowStage } from '../store/task-workflows.js';
import { keepParkedOnRestart } from '../store/approval-rows.js';
import { authorize, preview, submit } from './submission.js';
import { context } from './model-turn.js';
import { execute } from './execute.js';
import { decide } from './approvals.js';
import { cancel, reconcile, releaseRun, resume, start, wait } from './lifecycle.js';

export type { KernelLimits, QueueInsight } from './types.js';

/**
 * 内核的对外入口。各部分的实现按职责放在同目录的模块里：
 * 准入与运行槽（admission.ts）、提交（submission.ts）、执行主流程（execute.ts）、
 * 模型轮次（model-turn.ts）、外部智能体回合（native-turn.ts）、工具阶段（tool-phase.ts）、
 * 审批（approvals.ts）、生命周期（lifecycle.ts）、委托（delegate.ts）。
 * 它们经 KernelRuntime / AdmissionRuntime / DelegateRuntime 拿到需要的状态与协作者。
 */
export class Kernel {
  readonly router = new ModelRouter();
  private controllers = new Map<string, AbortController>();
  /** 准入队列、运行槽计数、停车表与占用采样。 */
  private readonly admission: Admission;
  /**
   * Caller-supplied provider keys (BYOK) by run ID. Memory only: never written to SQLite, events,
   * checkpoints or logs. Dropped when the run finishes; an interrupted run keeps it for one hour.
   */
  private byokKeys = new Map<string, string>();
  private byokExpiry = new Map<string, NodeJS.Timeout>();
  private closing = false;
  private shutdown = new AbortController();
  private ajv = new JsonSchemas();
  private outputSchemas = new JsonSchemas({ formats: true });
  private cache = new ToolCache();
  private auth?: KernelAuth;
  /** 拆出去的模块用到的内核能力（构造函数里填上）。 */
  private readonly rt: KernelRuntime;
  constructor(
    readonly store: Store,
    readonly hub: NodeHub,
    readonly limits: KernelLimits = { maxActiveRuns: 8, approvalTimeoutMs: 600_000 },
  ) {
    this.admission = new Admission({
      store,
      hub,
      limits,
      closing: () => this.closing,
      execute: (runId, preloaded) => execute(this.rt, runId, preloaded),
      releaseRun: (run) => releaseRun(this.rt, run),
    });
    this.rt = {
      store,
      hub,
      router: this.router,
      limits,
      admission: this.admission,
      controllers: this.controllers,
      byokKeys: this.byokKeys,
      byokExpiry: this.byokExpiry,
      shutdown: this.shutdown,
      ajv: this.ajv,
      outputSchemas: this.outputSchemas,
      cache: this.cache,
      delegation: this.delegation,
      closing: () => this.closing,
      auth: () => this.auth,
      context: (run) => this.context(run),
    };
    setMaxListeners(1000, this.shutdown.signal);
    (this.delegation as { store: Store }).store = store;
    store.recover();
  }
  /** 只读的调度计数（测试与诊断用）。 */
  stats(): {
    active: number;
    queued: number;
    parked: number;
    lent: number;
    executing: number;
    breaches: number;
  } {
    return {
      active: this.admission.active,
      queued: this.admission.queue.length,
      parked: this.admission.parked.size,
      lent: this.admission.lent.size,
      executing: this.admission.tasks.size,
      breaches: this.admission.slotBreaches,
    };
  }
  setAuth(auth: NonNullable<Kernel['auth']>): void {
    this.auth = auth;
  }
  start(): void {
    start(this.rt);
  }
  /** 委托（delegate.ts）用到的内核能力。 */
  private readonly delegation: DelegateRuntime = {
    store: undefined as unknown as Store, // 构造函数里填上（参数属性晚于字段初始化）
    submit: (principal, invocation, idem, key, trace) =>
      this.submit(principal, invocation, idem, key, trace),
    wait: (runId, includeActions, signal) => this.wait(runId, includeActions, signal),
    cancel: (principal, runId) => this.cancel(principal, runId),
    providerKey: (runId) => this.byokKeys.get(runId),
    closing: () => this.closing,
    prioritize: (runId) => {
      const index = this.admission.queue.indexOf(runId);
      if (index > 0) {
        this.admission.queue.splice(index, 1);
        this.admission.queue.unshift(runId);
      }
    },
    lendSlot: (runId) => this.admission.lendSlot(runId),
    reclaimSlot: (runId, signal) => this.admission.reclaimSlot(runId, signal),
  };
  /**
   * Queue transparency for a run that is waiting: kernel admission (queued) or node capacity
   * (in progress but its current work is still queued on the hub). See Admission.queueInsight.
   */
  queueInsight(runId: string, owner: string, status: Run['status']): QueueInsight | undefined {
    return this.admission.queueInsight(runId, owner, status);
  }
  authorize(principal: Principal, agentId: string, scope: string): void {
    authorize(principal, agentId, scope);
  }
  preview(principal: Principal, request: PreviewRequest, byok = false) {
    return preview(this.rt, principal, request, byok);
  }
  submit(
    principal: Principal,
    invocation: Invocation,
    idem?: string,
    providerKey?: string,
    trace?: TraceContext,
  ): Run {
    return submit(this.rt, principal, invocation, idem, providerKey, trace);
  }
  submitWorkflowStage(
    principal: Principal,
    invocation: Invocation,
    execution: string,
    stage: string,
  ): Run {
    return submit(
      this.rt,
      principal,
      invocation,
      `workflow:${execution}:${stage}`,
      undefined,
      undefined,
      (child) => linkWorkflowStage(this.store, execution, stage, child),
    );
  }
  /** 工作区上下文。保留为实例方法：诊断工具（bench/paired/diagnostics.ts）按名字包装它。 */
  private context(run: Run): Promise<WorkContext> {
    return context(this.rt, run);
  }
  /** 测试（test/admission-fallback.test.ts）经类型断言直接触碰的准入内部：保留同名转发。 */
  private get queue(): string[] {
    return this.admission.queue;
  }
  private pump(): void {
    this.admission.pump();
  }
  private enqueue(runId: string): void {
    this.admission.enqueue(runId);
  }
  /** Test/diagnostic view: whether the gateway currently holds a caller key for this run. */
  holdsProviderKey(runId: string): boolean {
    return this.byokKeys.has(runId);
  }
  resolveClientTools(principal: Principal, results: clientTools.ClientResult[]) {
    return clientTools.resolveClientResults(this.store, principal, results, {
      authorize: (agent) => this.authorize(principal, agent, 'invoke'),
      wake: (runId) => (this.admission.scheduleParked(runId), this.admission.pump()),
    });
  }
  decide(
    principal: Principal,
    runId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    response: Record<string, unknown> = {},
  ): void {
    decide(this.rt, principal, runId, approvalId, decision, response);
  }
  cancel(principal: Principal, runId: string): Promise<Run> {
    return cancel(this.rt, principal, runId);
  }
  resume(principal: Principal, runId: string, providerKey?: string): Run {
    return resume(this.rt, principal, runId, providerKey);
  }
  reconcile(
    principal: Principal,
    runId: string,
    stepId: string,
    outcome: 'completed' | 'not_executed',
    value: unknown,
  ): void {
    reconcile(this.rt, principal, runId, stepId, outcome, value);
  }
  wait(runId: string, includeActions = false, signal?: AbortSignal): Promise<Run> {
    return wait(this.rt, runId, includeActions, signal);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled(this.admission.tasks.values());
    for (const runId of this.admission.parked.keys()) {
      const run = this.store.run(runId);
      if (run.status === 'requires_action' && !keepParkedOnRestart(this.store, run))
        this.admission.finishParked(
          run,
          'interrupted',
          'shutting_down',
          'The gateway shut down while awaiting approval. Explicit resume is required.',
        );
      else this.admission.clearParked(runId);
    }
    this.shutdown.abort();
    // Interrupted runs keep their caller key for an hour so they can resume; a closed kernel
    // cannot resume anything, so drop the keys now instead of leaving them in memory.
    for (const timer of this.byokExpiry.values()) clearTimeout(timer);
    this.byokExpiry.clear();
    this.byokKeys.clear();
    await this.hub.close();
  }
}
