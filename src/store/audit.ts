import type { Store } from './store.js';
import { Fault } from '../core/util.js';
import { withSavepoint } from './savepoint.js';

/**
 * Durable audit trail of *authenticated* denials: scope, host, isolation, concurrency and quota
 * refusals. Unauthenticated failures (401, invalid host/origin) and `rate_limited` are not written:
 * an attacker could otherwise turn every rejected request into a database write. Bursts of the
 * same denial (owner, key, code, path) within one minute are coalesced into one row whose
 * `suppressed` field counts the repeats seen since the previous row. Every PRUNE_EVERY committed
 * records per owner (denials or operator notes), older rows beyond RETAIN are pruned.
 */
export const AUDITED_CODES = new Set([
  'scope_denied',
  'admin_host_denied',
  'isolation_required',
  'concurrency_limit',
  'subject_concurrency_limit',
  'key_concurrency_limit',
  'run_quota_exceeded',
  'token_quota_exceeded',
]);
/** 运营者对开发者平台账号的主动操作（不是拒绝）：只写一条记录，内容里没有密码或兑换码。 */
export const PLATFORM_AUDIT_CODES = [
  'platform_credit_adjusted',
  'platform_account_status',
  'platform_password_reset',
] as const;
export type PlatformAuditCode = (typeof PLATFORM_AUDIT_CODES)[number];
const WINDOW_MS = 60_000;
const RETAIN = 10_000;
const PRUNE_EVERY = 100;
const MAX_TRACKED = 10_000;

export type AuditInput = {
  owner: string;
  code: string;
  keyId?: string;
  subject?: string;
  method: string;
  path: string;
  ip?: string;
  /** 只在策略记录（如 approval_policy_auto）上出现：被设置的智能体。 */
  agentId?: string;
};
/** `note` 接受的两类记录：智能体策略变更，与运营者对平台账号的操作。 */
export type AuditNote =
  | (AuditInput & { code: 'approval_policy_auto'; agentId: string })
  // 上架项「允许平台账号以本机权限运行」的打开与关闭：detail 为 `on` 或 `off`。
  | (AuditInput & { code: 'platform_listing_host_execution'; agentId: string; detail: string })
  | (AuditInput & { code: PlatformAuditCode; accountId: string; detail?: string })
  | (AuditInput & { code: 'platform_setup'; detail: string });
export type AuditEvent = {
  id: number;
  time: number;
  code: string;
  key_id: string | null;
  subject: string | null;
  method: string;
  path: string;
  ip: string | null;
  suppressed: number;
  agent_id?: string;
  /** 平台操作记录：被操作的账号，与一句不含机密的说明（如 `amount=-5`）。 */
  account_id?: string;
  detail?: string;
};

export class AuditLog {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, time INTEGER NOT NULL, code TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_owner ON audit_events(owner,id);
      CREATE TEMP TABLE IF NOT EXISTS oaa_audit_windows(bucket TEXT PRIMARY KEY,owner TEXT NOT NULL,anchor INTEGER NOT NULL UNIQUE,at INTEGER NOT NULL,suppressed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_retention_progress(owner TEXT PRIMARY KEY,n INTEGER NOT NULL);`);
  }
  /** Record one denial. Returns false when it was coalesced into a recent identical row. */
  record(input: AuditInput): boolean {
    if (!AUDITED_CODES.has(input.code)) return false;
    const now = this.now();
    const key = JSON.stringify([input.owner, input.keyId ?? null, input.code, input.path]);
    // The common repeat touches connection-local memory only. SQLite rolls the window
    // back with its audit receipt, including when a caller owns the surrounding transaction.
    const repeated = this.store
      .prepare('UPDATE temp.oaa_audit_windows SET suppressed=suppressed+1 WHERE bucket=? AND at>?')
      .run(key, now - WINDOW_MS);
    if (repeated.changes) return false;
    const last = this.store
      .prepare('SELECT suppressed FROM temp.oaa_audit_windows WHERE bucket=?')
      .get(key);
    const payload = {
      key_id: input.keyId ?? null,
      subject: input.subject ?? null,
      method: input.method,
      path: input.path.slice(0, 200),
      ip: input.ip ?? null,
      suppressed: Number(last?.suppressed ?? 0),
    };
    this.append(input, now, payload, key);
    return true;
  }
  /**
   * 记一条所有者主动作出的策略变更（不是拒绝，不合并）：目前只有把智能体设为自动批准
   * （`approval_policy_auto`），运营者对开发者平台账号的操作（`PLATFORM_AUDIT_CODES`），
   * 以及在控制台里保存开发者平台的启用与设置（`platform_setup`）。
   * 字段与拒绝记录相同，另带 `agent_id`，或 `account_id` 与可选的 `detail`。
   */
  note(input: AuditNote): void {
    const payload = {
      key_id: input.keyId ?? null,
      subject: input.subject ?? null,
      method: input.method,
      path: input.path.slice(0, 200),
      ip: input.ip ?? null,
      suppressed: 0,
      ...(input.code === 'approval_policy_auto'
        ? { agent_id: input.agentId }
        : input.code === 'platform_listing_host_execution'
          ? { agent_id: input.agentId, detail: input.detail.slice(0, 200) }
          : input.code === 'platform_setup'
            ? { detail: input.detail.slice(0, 200) }
            : {
                account_id: input.accountId,
                ...(input.detail ? { detail: input.detail.slice(0, 200) } : {}),
              }),
    };
    this.append(input, this.now(), payload);
  }
  private append(
    input: AuditInput,
    now: number,
    payload: Record<string, unknown>,
    bucket?: string,
  ) {
    withSavepoint(this.store.db, () => {
      const row = this.store
        .prepare('INSERT INTO audit_events(owner,time,code,payload) VALUES(?,?,?,?)')
        .run(input.owner, now, input.code, JSON.stringify(payload));
      if (!row.changes)
        throw new Fault('persistence_failed', 'The audit event could not be recorded.', 500);
      const id = Number(row.lastInsertRowid);
      if (bucket !== undefined)
        this.store
          .prepare(
            `INSERT INTO temp.oaa_audit_windows VALUES(?,?,?,?,0) ON CONFLICT(bucket) DO UPDATE SET anchor=excluded.anchor,at=excluded.at,suppressed=0`,
          )
          .run(bucket, input.owner, id, now);
      if (id > MAX_TRACKED)
        this.store
          .prepare('DELETE FROM temp.oaa_audit_windows WHERE anchor<=?')
          .run(id - MAX_TRACKED);
      const count = this.store
        .prepare(
          'INSERT INTO audit_retention_progress VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET n=n+1 RETURNING n',
        )
        .get(input.owner)!;
      if (Number(count.n) >= PRUNE_EVERY) {
        this.prune(input.owner);
        this.store.prepare('DELETE FROM audit_retention_progress WHERE owner=?').run(input.owner);
      }
    });
  }
  prune(owner: string): void {
    const cutoff = this.store
      .prepare('SELECT id FROM audit_events WHERE owner=? ORDER BY id DESC LIMIT 1 OFFSET ?')
      .get(owner, RETAIN);
    if (cutoff)
      withSavepoint(this.store.db, () => {
        this.store
          .prepare('DELETE FROM audit_events WHERE owner=? AND id<=?')
          .run(owner, Number(cutoff.id));
        this.store
          .prepare('DELETE FROM temp.oaa_audit_windows WHERE owner=? AND anchor<=?')
          .run(owner, Number(cutoff.id));
      });
  }
  /** Oldest-first page of an owner's audit rows after `after` (an event ID). */
  page(owner: string, after = 0, limit = 50): { data: AuditEvent[]; next_after: number | null } {
    const rows = this.store
      .prepare(
        'SELECT id,time,code,payload FROM audit_events WHERE owner=? AND id>? ORDER BY id LIMIT ?',
      )
      .all(owner, after, limit + 1);
    const data = rows.slice(0, limit).map((row) => ({
      id: Number(row.id),
      time: Number(row.time),
      code: String(row.code),
      ...(JSON.parse(String(row.payload)) as Omit<AuditEvent, 'id' | 'time' | 'code'>),
    }));
    return { data, next_after: rows.length > limit ? data.at(-1)!.id : null };
  }
}
