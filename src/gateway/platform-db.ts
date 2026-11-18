/**
 * 开发者平台的共用部分：配置类型、`platform_` 表、金额换算、持久化防爆破限流与事务。
 *
 * 金额在库里与计算中一律是整数微点数（1 点 = 1,000,000 微点）；只在门面的入口换成微点、出口换回点。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { GatewayConfig } from '../config/config.js';
import { isOwnerWide, type Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';

export type PlatformConfig = NonNullable<GatewayConfig['platform']>;

export const MICRO = 1_000_000;
/** Largest amount (in points) accepted anywhere: keeps every micro value a safe integer. */
export const MAX_POINTS = 1_000_000_000;

/** Points (number, up to 6 decimals) to integer micro-points. */
export function toMicro(points: number, field = 'amount'): number {
  if (!Number.isFinite(points) || Math.abs(points) > MAX_POINTS)
    throw new Fault('invalid_request', `${field} must be a finite number of points.`, 400);
  return Math.round(points * MICRO);
}
/** Integer micro-points to points. */
export function toPoints(micro: number): number {
  return micro / MICRO;
}

export function displayName(name: unknown, email: string): string {
  if (name === undefined || name === null || name === '') return email.split('@')[0]!;
  if (typeof name !== 'string' || name.trim().length > 100)
    throw new Fault('invalid_request', 'name must be at most 100 characters.', 400);
  return name.trim() || email.split('@')[0]!;
}

export function pageSize(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 200)
    throw new Fault('invalid_request', 'limit must be between 1 and 200.', 400);
  return value;
}

export function createPlatformLimiters(db: DatabaseSync, owner: string) {
  return {
    signupIp: new RateLimiter(10, 3_600_000, db, `${owner}:signup_ip`),
    loginIp: new RateLimiter(30, 600_000, db, `${owner}:login_ip`),
    loginEmail: new RateLimiter(10, 600_000, db, `${owner}:login_email`),
    resetIp: new RateLimiter(30, 600_000, db, `${owner}:reset_ip`),
    resetEmail: new RateLimiter(10, 600_000, db, `${owner}:reset_email`),
    redeem: new RateLimiter(10, 600_000, db, `${owner}:redeem`),
  };
}

/**
 * 运营者一档的权限（平台运营者接口与 `/v1/platform/setup` 共用）：owner 级管理员密钥（admin、agents 为 `*`）。
 * 管理员密钥只能在控制台域名上使用（onRequest 的 `admin_host_denied`），所以这里也隐含了控制台域名。
 */
export function requireOwnerAdmin(p: Principal): void {
  if (!isOwnerWide(p))
    throw new Fault('scope_denied', 'Platform operations require an owner-wide admin key.', 403);
}

export function ensurePlatformTables(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS platform_accounts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,email TEXT NOT NULL,balance INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL,UNIQUE(owner,email));
CREATE TABLE IF NOT EXISTS platform_sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_sessions_account ON platform_sessions(account_id);
CREATE TABLE IF NOT EXISTS platform_listings(owner TEXT NOT NULL,agent_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,agent_id));
CREATE TABLE IF NOT EXISTS platform_codes(id TEXT PRIMARY KEY,owner TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS platform_code_uses(code_id TEXT NOT NULL,account_id TEXT NOT NULL,used_at INTEGER NOT NULL,PRIMARY KEY(code_id,account_id));
CREATE TABLE IF NOT EXISTS platform_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,account_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,balance_after INTEGER NOT NULL,run_id TEXT UNIQUE,agent TEXT,tokens INTEGER NOT NULL DEFAULT 0,status TEXT,note TEXT,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_ledger_account ON platform_ledger(account_id,id);
CREATE INDEX IF NOT EXISTS platform_ledger_time ON platform_ledger(owner,created_at);
CREATE TABLE IF NOT EXISTS platform_references(owner TEXT NOT NULL,reference TEXT NOT NULL,entry_id INTEGER NOT NULL UNIQUE,created_at INTEGER NOT NULL,PRIMARY KEY(owner,reference));
CREATE TABLE IF NOT EXISTS platform_reset_codes(account_id TEXT PRIMARY KEY,owner TEXT NOT NULL,hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_rate_limits(bucket TEXT NOT NULL,key TEXT NOT NULL,window_start INTEGER NOT NULL,count INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(bucket,key));
CREATE INDEX IF NOT EXISTS platform_rate_limits_exp ON platform_rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS platform_pending_signups(owner TEXT NOT NULL,email TEXT NOT NULL,code_hash TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,email));
CREATE TABLE IF NOT EXISTS platform_verification_secrets(owner TEXT PRIMARY KEY,secret TEXT NOT NULL,created_at INTEGER NOT NULL);`);
}

/** Runs `fn` in one IMMEDIATE transaction (or inside the caller's, if one is open). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** `db.prepare(sql)`, compiled once per connection and reused (platform SQL is a fixed set). */
export function prepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

/**
 * Fixed-window rate limiter. Persists counters into SQLite (`platform_rate_limits`) with automatic
 * expiry cleanup when `db` is supplied so login, signup, reset and redeem brute-force counters
 * survive gateway restarts; falls back to an in-memory map when constructed without `db`.
 */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  private ops = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly db?: DatabaseSync,
    private readonly bucket = 'default',
  ) {}

  private prune(now: number): void {
    if (!this.db) return;
    if (++this.ops % 32 === 1)
      prepared(this.db, 'DELETE FROM platform_rate_limits WHERE expires_at<=?').run(now);
  }

  /** Throw `rate_limited` when `key` has already reached `limit` in the current window. */
  check(key: string, now = Date.now()): void {
    const k = key.slice(0, 320);
    if (!this.db) {
      const entry = this.hits.get(k);
      if (entry && now - entry.start < this.windowMs && entry.count >= this.limit)
        throw new Fault('rate_limited', 'Too many attempts. Try again later.', 429);
      return;
    }
    const row = prepared(
      this.db,
      'SELECT count,expires_at FROM platform_rate_limits WHERE bucket=? AND key=?',
    ).get(this.bucket, k);
    if (row && Number(row.expires_at) > now && Number(row.count) >= this.limit)
      throw new Fault('rate_limited', 'Too many attempts. Try again later.', 429);
  }

  hit(key: string, now = Date.now()): void {
    const k = key.slice(0, 320);
    if (!this.db) {
      if (this.hits.size > 10_000)
        for (const [id, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(id);
      const entry = this.hits.get(k);
      if (!entry || now - entry.start >= this.windowMs) {
        this.hits.set(k, { start: now, count: 1 });
        return;
      }
      if (++entry.count > this.limit)
        throw new Fault('rate_limited', 'Too many attempts. Try again later.', 429);
      return;
    }
    this.prune(now);
    const row = prepared(
      this.db,
      'SELECT window_start,count,expires_at FROM platform_rate_limits WHERE bucket=? AND key=?',
    ).get(this.bucket, k);
    if (!row || Number(row.expires_at) <= now) {
      prepared(
        this.db,
        'INSERT OR REPLACE INTO platform_rate_limits(bucket,key,window_start,count,expires_at) VALUES(?,?,?,1,?)',
      ).run(this.bucket, k, now, now + this.windowMs);
      return;
    }
    const next = Number(row.count) + 1;
    prepared(this.db, 'UPDATE platform_rate_limits SET count=? WHERE bucket=? AND key=?').run(
      next,
      this.bucket,
      k,
    );
    if (next > this.limit)
      throw new Fault('rate_limited', 'Too many attempts. Try again later.', 429);
  }
}
