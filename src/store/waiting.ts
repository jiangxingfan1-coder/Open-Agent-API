/**
 * 请求列表与概览 runs 行的 `waiting_on`（docs/protocol.md）：只在 `requires_action` 且有待处理待办
 * 时出现，`caller`＝待办全是调用方工具（只在等调用方回传），`owner`＝有需要人工处理的待办。
 * 写入运行摘要时计算；待办创建或解决时由 `refreshWaiting` 刷新，列表查询不再逐行查待办表。
 */
import type { StatementSync } from 'node:sqlite';
import type { RunStatus } from '../core/contracts.js';
import { pendingWaiter } from './approval-rows.js';

type Db = { prepare(sql: string): StatementSync };
type Row = Record<string, unknown>;

/** 一条按 approval_run 索引的查询，只在 requires_action 时做。 */
export function waitingOn(
  db: Db,
  runId: string,
  status: RunStatus,
): { waiting_on?: 'caller' | 'owner' } {
  if (status !== 'requires_action') return {};
  const waiting = pendingWaiter(db, runId);
  return waiting ? { waiting_on: waiting } : {};
}

/**
 * 待办创建或解决后刷新摘要里的 `waiting_on`（运行状态不变时 checkpoint 不会重写摘要）。有变化
 * 才写，并返回要发出的 summary 通知（推进概览修订号，使 ETag 失效）。
 */
export function refreshWaiting(db: Db, runId: string): { name: string; value: unknown }[] {
  const row = db
    .prepare('SELECT owner,agent_id,status,payload FROM run_summaries WHERE run_id=?')
    .get(runId) as Row | undefined;
  if (!row) return [];
  const summary = JSON.parse(row.payload as string) as { waiting_on?: string };
  const next = waitingOn(db, runId, row.status as RunStatus).waiting_on;
  if (summary.waiting_on === next) return [];
  if (next) summary.waiting_on = next;
  else delete summary.waiting_on;
  db.prepare('UPDATE run_summaries SET payload=? WHERE run_id=?').run(
    JSON.stringify(summary),
    runId,
  );
  const value = { owner: row.owner, runId, agentId: row.agent_id, status: row.status };
  return [{ name: 'summary', value }];
}
