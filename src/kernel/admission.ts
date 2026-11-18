/**
 * 准入与运行槽：排队、运行槽计数（含委托借出与领回）、停车表与唤醒定时器、占用采样与排队估计。
 * 由 Kernel 持有；需要的内核能力经 AdmissionRuntime 显式传入。
 */
import type { Run } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import type { NodeHub } from '../fabric/network.js';
import { responseObject } from './response-object.js';
import * as clientTools from './client-tools.js';
import { estimateStart, type Sample } from './queue-estimate.js';
import { terminalEventType } from './run-state.js';
import type { KernelLimits, QueueInsight } from './types.js';

/** 准入需要的内核能力。 */
export interface AdmissionRuntime {
  readonly store: Store;
  readonly hub: NodeHub;
  readonly limits: KernelLimits;
  closing(): boolean;
  /** 启动一次执行（内核主流程）。 */
  execute(runId: string, preloaded?: Run): Promise<void>;
  releaseRun(run: Run): void;
}

export class Admission {
  readonly tasks = new Map<string, Promise<void>>();
  readonly parked = new Map<string, NodeJS.Timeout | undefined>();
  private readonly retrying = new Map<string, boolean>();
  queue: string[] = [];
  /**
   * 占用运行槽的运行数。不变量：执行中的运行数 = active + 借出运行槽的父运行数；
   * 0 <= active <= maxActiveRuns（只在中止拆除时，归还运行槽的父运行可以不等空位，短暂超出）。
   * 一个父运行无论并行多少个委托，最多借出一个运行槽。
   */
  active = 0;
  /** 借出运行槽的父运行：正在等的委托数，以及（全部等完、正在等空位时）领回运行槽的回调。 */
  readonly lent = new Map<string, { count: number; waiter?: () => void }>();
  private reclaimWaiters: (() => void)[] = [];
  slotBreaches = 0;
  /** Runs holding a slot now: when they were admitted and whose occupancy sample they feed. */
  private admitted = new Map<string, { at: number; key: string }>();
  /** Observed slot occupancy (ms) per owner+agent, newest last, at most 50 each. */
  private occupancy = new Map<string, number[]>();
  /** Stored-duration fallback per owner+agent, refreshed at most every 5 s. */
  private storedDurations = new Map<string, { at: number; sample: number[] }>();
  private runKeys = new Map<string, string>();
  constructor(private readonly rt: AdmissionRuntime) {}
  /** 运行槽计数的不变量检查：违反时记数并发出进程警告（测试通过 stats().breaches 断言）。 */
  private checkSlots(): void {
    if (this.active >= 0 && this.active <= this.rt.limits.maxActiveRuns) return;
    this.slotBreaches++;
    process.emitWarning(`Kernel slot invariant violated: active=${this.active}`, 'OAAInvariant');
  }
  /** 父运行开始等子运行：同一父运行的第一个委托（0→1）借出运行槽，让子运行能入场。 */
  lendSlot(runId: string): void {
    const held = this.lent.get(runId);
    if (!held) {
      this.lent.set(runId, { count: 1 });
      this.active--;
      this.checkSlots();
      this.pump();
    } else if (held.waiter) {
      // 正在等空位领回运行槽时又发起了委托：运行槽仍算借出，不必再领回。
      held.count = 1;
      held.waiter();
    } else held.count++;
  }
  /** 最后一个委托等完（1→0）时领回运行槽；没有空位就等，中止或关闭时直接领回。 */
  reclaimSlot(runId: string, signal: AbortSignal): Promise<void> {
    const held = this.lent.get(runId);
    if (!held || --held.count > 0) return Promise.resolve();
    const take = () => {
      this.lent.delete(runId);
      this.active++;
    };
    if (this.active < this.rt.limits.maxActiveRuns || signal.aborted || this.rt.closing()) {
      take();
      if (!signal.aborted && !this.rt.closing()) this.checkSlots();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const settle = (takeSlot: boolean) => {
        signal.removeEventListener('abort', onAbort);
        this.reclaimWaiters = this.reclaimWaiters.filter((w) => w !== grant);
        delete held.waiter;
        if (takeSlot) take();
        resolve();
      };
      const grant = () => settle(true);
      const onAbort = () => settle(true);
      held.waiter = () => settle(false);
      this.reclaimWaiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  /** Owner + agent of a run, memoized (neither changes for a run). */
  private runKey(runId: string, run?: Run): string {
    let key = this.runKeys.get(runId);
    if (key === undefined) {
      const r = run ?? this.rt.store.run(runId);
      key = `${r.owner}\n${r.agentId}`;
      this.runKeys.set(runId, key);
      if (this.runKeys.size > 4096) this.runKeys.delete(this.runKeys.keys().next().value!);
    }
    return key;
  }
  /** A run left its slot (finished, parked or yielded): remember how long it held it. */
  private recordOccupancy(runId: string): void {
    const held = this.admitted.get(runId);
    if (!held) return;
    this.admitted.delete(runId);
    const sample = this.occupancy.get(held.key) ?? [];
    sample.push(Date.now() - held.at);
    if (sample.length > 50) sample.shift();
    this.occupancy.set(held.key, sample);
  }
  /** Observed occupancy when there is enough of it; otherwise recent stored durations. */
  private sampleFor(key: string): Sample {
    const observed = this.occupancy.get(key) ?? [];
    if (observed.length >= 5) return observed;
    const cached = this.storedDurations.get(key);
    if (cached && Date.now() - cached.at < 5_000)
      return cached.sample.length ? cached.sample : observed;
    const [owner, agent] = key.split('\n') as [string, string];
    const stored = this.rt.store.recentDurations(owner, agent);
    this.storedDurations.set(key, { at: Date.now(), sample: stored });
    if (this.storedDurations.size > 1024)
      this.storedDurations.delete(this.storedDurations.keys().next().value!);
    return stored.length ? stored : observed;
  }
  /**
   * Queue transparency for a run that is waiting: kernel admission (queued) or node capacity
   * (in progress but its current work is still queued on the hub). `position` and `ahead` only
   * count the same owner's runs; `estimated_start_ms` is a slot-simulation estimate from now
   * (see queue-estimate.ts) or a node execution estimate, not a commitment.
   */
  queueInsight(runId: string, owner: string, status: Run['status']): QueueInsight | undefined {
    if (status === 'in_progress') return this.rt.hub.waiting(runId, owner);
    if (status !== 'queued') return undefined;
    const index = this.queue.indexOf(runId);
    if (index === -1)
      return { position: null, ahead: null, reason: 'unknown', estimated_start_ms: null };
    let ahead = 0;
    for (let i = 0; i < index; i++) if (this.rt.store.ownerOfRun(this.queue[i]!) === owner) ahead++;
    const recorded = this.rt.store.queueReason(runId);
    const reason =
      recorded === 'fairness'
        ? 'fairness'
        : recorded === 'approval_resolved'
          ? 'approval'
          : 'admission';
    // Slot simulation: running work frees its slot after its expected residual time; each run
    // ahead (any owner: global order decides the wait) takes the earliest slot for its own agent's
    // typical occupancy. Only the resulting duration is exposed, never other owners' counts.
    const now = Date.now();
    const estimate = estimateStart({
      slots: Math.max(1, this.rt.limits.maxActiveRuns),
      active: [...this.admitted.values()].map((a) => ({
        sample: this.sampleFor(a.key),
        elapsed: now - a.at,
      })),
      ahead: this.queue.slice(0, index).map((id) => this.sampleFor(this.runKey(id))),
    });
    return { position: ahead + 1, ahead, reason, estimated_start_ms: estimate };
  }
  pump(): void {
    // 等完委托、等空位领回运行槽的父运行先于排队的新运行。
    while (this.active < this.rt.limits.maxActiveRuns && this.reclaimWaiters.length)
      this.reclaimWaiters.shift()!();
    if (this.rt.closing()) return;
    // 旧任务还没清理完（让出或换人后在 .finally 之前就回到了队列）的运行不启动第二个 execute：
    // 放回队尾，旧任务的 .finally 会再 pump 一次。本轮只看一遍队列，不会忙等。
    const deferred: string[] = [];
    while (this.active < this.rt.limits.maxActiveRuns && this.queue.length) {
      const runId = this.queue.shift()!;
      if (this.tasks.has(runId)) {
        deferred.push(runId);
        continue;
      }
      if (!this.scheduleParked(runId)) {
        deferred.push(runId);
        continue;
      }
      const queuedRun = this.rt.store.run(runId);
      if (queuedRun.status !== 'queued') continue;
      this.clearParked(runId);
      this.active++;
      const key = this.runKey(runId, queuedRun);
      this.admitted.set(runId, { at: Date.now(), key });
      const p = this.rt.execute(runId, queuedRun).finally(() => {
        this.active--;
        if (this.tasks.get(runId) === p) this.tasks.delete(runId);
        this.recordOccupancy(runId);
        this.scheduleParked(runId);
        this.pump();
      });
      this.tasks.set(runId, p);
    }
    for (const runId of deferred) this.enqueue(runId);
  }
  /** 入队；已经在队列里的运行不重复入队。 */
  enqueue(runId: string): void {
    if (!this.queue.includes(runId)) this.queue.push(runId);
  }
  clearParked(runId: string): void {
    clearTimeout(this.parked.get(runId));
    this.parked.delete(runId);
    this.retrying.delete(runId);
  }
  finishParked(
    run: Run,
    status: 'failed' | 'cancelled' | 'interrupted' | 'incomplete',
    code?: string,
    message?: string,
  ): void {
    run.status = status;
    if (code && message) run.error = { code, message };
    delete run.checkpoint.suspension;
    this.rt.store.checkpointActions(
      run,
      'expire',
      [],
      (view) => ({
        type: terminalEventType(status),
        data: { response: responseObject(view) },
      }),
      () => {
        this.clearParked(run.id);
        this.queue = this.queue.filter((id) => id !== run.id);
      },
    );
    this.rt.releaseRun(run);
  }
  scheduleParked(runId: string): boolean {
    if (this.rt.closing() || this.tasks.has(runId) || !this.parked.has(runId)) return true;
    if (this.retrying.get(runId)) return false;
    try {
      this.checkParked(runId);
      this.retrying.delete(runId);
      return true;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR') ||
        !this.parked.has(runId)
      )
        throw error;
      // A committed approval remains authoritative; retry only its scheduling checkpoint.
      if (!this.retrying.has(runId))
        process.emitWarning(
          'A parked decision could not be checkpointed; scheduling will retry.',
          'OAAParkedCheckpoint',
        );
      this.retrying.set(runId, true);
      clearTimeout(this.parked.get(runId));
      this.parked.set(
        runId,
        setTimeout(() => {
          this.retrying.set(runId, false);
          this.scheduleParked(runId);
          this.pump();
        }, 1000).unref(),
      );
      return false;
    }
  }
  private checkParked(runId: string): void {
    const run = this.rt.store.run(runId);
    const deadline = run.checkpoint.deadlineAt ?? Infinity;
    const now = Date.now();
    if (!['requires_action', 'queued'].includes(run.status)) {
      this.clearParked(runId);
      return;
    }
    if (now >= deadline) {
      this.finishParked(
        run,
        'incomplete',
        'run_timeout',
        'The run deadline expired while waiting.',
      );
      return;
    }
    let wakeAt = deadline;
    if (run.checkpoint.suspension) {
      const actions = run.checkpoint.suspension.approvalIds.map((id) =>
        this.rt.store.getApproval(id, run.owner),
      );
      if (actions.some((a) => a.status === 'denied')) {
        this.finishParked(
          run,
          'failed',
          'permission_denied',
          'The API owner denied a pending tool call.',
        );
        return;
      }
      if (
        actions.some(
          (a) => a.status === 'expired' || (a.status === 'pending' && now >= a.expiresAt),
        )
      ) {
        this.finishParked(run, 'failed', ...clientTools.parkedExpiry(actions));
        return;
      }
      if (run.status === 'requires_action' && actions.some((a) => a.status === 'approved')) {
        run.status = 'queued';
        this.rt.store.checkpoint(run, [
          { type: 'run.queued', data: { reason: 'approval_resolved' } },
        ]);
        if (!this.parked.has(runId)) return;
        this.enqueue(run.id);
      }
      wakeAt = Math.min(
        deadline,
        ...actions.filter((a) => a.status === 'pending').map((a) => a.expiresAt),
      );
    }
    clearTimeout(this.parked.get(runId));
    this.parked.set(
      runId,
      setTimeout(
        () => {
          this.scheduleParked(runId);
          this.pump();
        },
        Math.max(1, wakeAt - Date.now()),
      ),
    );
  }
}
