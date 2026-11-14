/**
 * 密钥用量记账：已用 token 与运行次数（持久化在 api_key_usage），以及进行中的运行（只在内存）。
 *
 * 一个运行可能多次收尾（中断、恢复后再结束），每次带来的是它的累计 token。api_key_run_tokens
 * 记住每个运行已经计入密钥的数，只累加差额，所以同一运行的 token 只计一次。
 */
import type { Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import type { Store } from '../store/store.js';

export type KeyUsageView = { usedTokens: number; usedRuns: number; activeRuns: number };

export class KeyUsage {
  private usageCache = new Map<string, { usedTokens: number; usedRuns: number }>();
  private activeByKey = new Map<string, Set<string>>();
  constructor(private readonly store: Store) {
    const seeded = !!store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_key_run_tokens'")
      .get();
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS api_key_usage(key_id TEXT PRIMARY KEY,owner TEXT NOT NULL,used_tokens INTEGER NOT NULL DEFAULT 0,used_runs INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS api_key_run_tokens(run_id TEXT PRIMARY KEY,key_id TEXT NOT NULL,tokens INTEGER NOT NULL)',
    );
    // 升级前的版本在运行中断时已经把它的累计 token 整体计入密钥：第一次建表时据此补记，
    // 这些运行之后恢复并结束，只再计差额。终态的运行不会再收尾，不需要补记。
    if (!seeded)
      for (const run of store.allRuns(['interrupted'])) {
        const keyId = run.checkpoint.keyId;
        const tokens = Math.max(0, Math.floor(run.usage?.total_tokens ?? 0));
        if (keyId && tokens > 0)
          store
            .prepare('INSERT OR IGNORE INTO api_key_run_tokens(run_id,key_id,tokens) VALUES(?,?,?)')
            .run(run.id, keyId, tokens);
      }
    for (const row of this.store
      .prepare('SELECT key_id,used_tokens,used_runs FROM api_key_usage')
      .all()) {
      this.usageCache.set(String(row.key_id), {
        usedTokens: Number(row.used_tokens ?? 0),
        usedRuns: Number(row.used_runs ?? 0),
      });
    }
  }
  keyUsage(keyId: string | undefined): KeyUsageView {
    if (!keyId) return { usedTokens: 0, usedRuns: 0, activeRuns: 0 };
    const cached = this.usageCache.get(keyId) ?? { usedTokens: 0, usedRuns: 0 };
    const activeRuns = this.activeByKey.get(keyId)?.size ?? 0;
    return { ...cached, activeRuns };
  }
  /**
   * The key's own quota (concurrency, token budget, run count). `resuming` is a run of this key
   * that is resumed: it is not counted among the active runs, and it has already been counted
   * among the used runs, so the run count refuses it only when more runs than allowed were used.
   */
  checkQuota(p: Principal, resuming?: string): void {
    if (!p.quota || !p.keyId) return;
    const usage = this.keyUsage(p.keyId);
    const active = this.activeByKey.get(p.keyId);
    const activeRuns =
      resuming !== undefined && active?.has(resuming) ? usage.activeRuns - 1 : usage.activeRuns;
    const usedRuns = resuming !== undefined ? usage.usedRuns - 1 : usage.usedRuns;
    if (p.quota.maxConcurrentRuns !== undefined && activeRuns >= p.quota.maxConcurrentRuns) {
      throw new Fault(
        'key_concurrency_limit',
        `API key concurrent run limit (${p.quota.maxConcurrentRuns}) reached.`,
        429,
      );
    }
    if (p.quota.maxTotalTokens !== undefined && usage.usedTokens >= p.quota.maxTotalTokens) {
      throw new Fault(
        'token_quota_exceeded',
        `API key token budget (${p.quota.maxTotalTokens}) exhausted.`,
        429,
      );
    }
    if (p.quota.maxRuns !== undefined && usedRuns >= p.quota.maxRuns) {
      throw new Fault(
        'run_quota_exceeded',
        `API key run quota (${p.quota.maxRuns}) exhausted.`,
        429,
      );
    }
  }
  begin(keyId: string, owner: string, runId: string): void {
    let active = this.activeByKey.get(keyId);
    if (!active) {
      active = new Set();
      this.activeByKey.set(keyId, active);
    }
    if (active.has(runId)) return;
    active.add(runId);
    const current = this.usageCache.get(keyId) ?? { usedTokens: 0, usedRuns: 0 };
    const next = { usedTokens: current.usedTokens, usedRuns: current.usedRuns + 1 };
    this.usageCache.set(keyId, next);
    this.store
      .prepare(
        'INSERT INTO api_key_usage(key_id,owner,used_tokens,used_runs,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET used_runs=excluded.used_runs,updated_at=excluded.updated_at',
      )
      .run(keyId, owner, next.usedTokens, next.usedRuns, Date.now());
  }
  /** Counts a resumed or re-queued run as active again; its run was counted when it started. */
  rejoin(keyId: string, runId: string): void {
    let active = this.activeByKey.get(keyId);
    if (!active) {
      active = new Set();
      this.activeByKey.set(keyId, active);
    }
    active.add(runId);
  }
  /** `totalTokens` is the run's cumulative usage; only what was not counted before is added. */
  finish(keyId: string, owner: string, runId: string, totalTokens: number): void {
    this.activeByKey.get(keyId)?.delete(runId);
    const total = Math.max(0, Math.floor(totalTokens));
    const row = this.store
      .prepare('SELECT tokens FROM api_key_run_tokens WHERE run_id=?')
      .get(runId);
    const counted = Number(row?.tokens ?? 0);
    const delta = total - counted;
    if (delta <= 0) return;
    this.store
      .prepare(
        'INSERT INTO api_key_run_tokens(run_id,key_id,tokens) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET tokens=excluded.tokens',
      )
      .run(runId, keyId, total);
    const current = this.usageCache.get(keyId) ?? { usedTokens: 0, usedRuns: 0 };
    const next = { usedTokens: current.usedTokens + delta, usedRuns: current.usedRuns };
    this.usageCache.set(keyId, next);
    this.store
      .prepare(
        'INSERT INTO api_key_usage(key_id,owner,used_tokens,used_runs,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET used_tokens=excluded.used_tokens,updated_at=excluded.updated_at',
      )
      .run(keyId, owner, next.usedTokens, next.usedRuns, Date.now());
  }
  reset(keyId: string, owner: string): void {
    this.usageCache.set(keyId, { usedTokens: 0, usedRuns: 0 });
    this.store
      .prepare(
        'INSERT INTO api_key_usage(key_id,owner,used_tokens,used_runs,updated_at) VALUES(?,?,0,0,?) ON CONFLICT(key_id) DO UPDATE SET used_tokens=0,used_runs=0,updated_at=excluded.updated_at',
      )
      .run(keyId, owner, Date.now());
  }
}
