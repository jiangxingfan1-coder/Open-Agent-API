/**
 * 开发者平台：门户里的任务记录。
 *
 * 列表来自流水里 `kind: run` 的行；详情来自运行本身，按账号的 subject（`acct:<账号 ID>`）读取，
 * 时间线复用 `GET /v1/runs/:id/timeline` 的计算。运行已被清理时退回流水里有的字段。
 */
import { terminal, type Run, type RunStatus } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import type { Store } from '../store/store.js';
import type { PlatformBilling, RunRecord } from './platform-billing.js';
import { toPoints } from './platform-db.js';
import type { Page, Price, ReconcileResult, RunDetailView, RunItemView } from './platform-types.js';
import { buildTimeline } from './timeline.js';

/** Longest `output_text` returned; longer output is cut and ends with an ellipsis. */
export const MAX_OUTPUT_TEXT = 200_000;
export function clipOutput(text: string): string {
  return text.length > MAX_OUTPUT_TEXT ? `${text.slice(0, MAX_OUTPUT_TEXT)}…` : text;
}

export class PlatformRuns {
  constructor(
    private readonly store: Store,
    private readonly billing: PlatformBilling,
    private readonly owner: string,
  ) {}
  private item(row: RunRecord): RunItemView {
    return {
      id: row.runId ?? '',
      agent: row.agent ?? '',
      status: row.status ?? 'in_progress',
      tokens: row.tokens,
      charge: toPoints(Math.max(0, -row.amount)),
      createdAt: row.createdAt,
    };
  }
  list(
    accountId: string,
    page: { limit: number; cursor?: number; agent?: string },
  ): Page<RunItemView> {
    const { data, next } = this.billing.runs(accountId, page.limit, page.cursor, page.agent);
    return { data: data.map((row) => this.item(row)), nextCursor: next };
  }
  detail(accountId: string, runId: string): RunDetailView {
    const row = this.billing.run(accountId, runId);
    if (!row) throw new Fault('run_not_found', 'Response not found.', 404);
    const price: Price = {
      perRun: toPoints(row.price.perRun),
      per1kTokens: toPoints(row.price.per1kTokens),
    };
    const base = { ...this.item(row), price };
    const run = this.load(runId, `acct:${accountId}`);
    if (!run)
      return {
        ...base,
        completedAt: null,
        usage: null,
        error: null,
        outputText: '',
        timeline: null,
      };
    return {
      ...base,
      completedAt: terminal(run.status as RunStatus) ? run.updatedAt : null,
      usage: run.usage ?? null,
      error: run.error ?? null,
      outputText: clipOutput(run.output.map((item) => item.text).join('\n\n')),
      timeline: buildTimeline({
        ...this.store.timelineSource(run.id, this.owner),
        now: Date.now(),
      }),
    };
  }
  /** The run under the account's subject, or undefined once it has been purged. */
  private load(runId: string, subject: string): Run | undefined {
    try {
      return this.store.run(runId, this.owner, subject);
    } catch (error) {
      if (error instanceof Fault && error.code === 'run_not_found') return undefined;
      throw error;
    }
  }
  /**
   * Settles run rows still marked `in_progress`: a terminal run settles at its status and tokens,
   * a run that no longer exists ends `interrupted` with 0 tokens, a run still queued or waiting
   * is left to settle itself when it finishes. Synchronous and idempotent (settleRun charges only
   * the difference), so it cannot double-charge a run that the kernel settles too.
   */
  reconcile(): ReconcileResult {
    const result: ReconcileResult = { settled: 0, interrupted: 0, pending: 0 };
    for (const runId of this.billing.unsettledRuns()) {
      let run: Run | undefined;
      try {
        run = this.store.run(runId, this.owner);
      } catch (error) {
        if (!(error instanceof Fault && error.code === 'run_not_found')) throw error;
      }
      if (!run) {
        this.billing.settleRun(runId, 'interrupted', 0);
        result.interrupted++;
      } else if (terminal(run.status)) {
        this.billing.settleRun(runId, run.status, run.usage?.total_tokens ?? 0);
        result.settled++;
      } else result.pending++;
    }
    return result;
  }
}
