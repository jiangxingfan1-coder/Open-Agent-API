/**
 * 开发者平台：账号、密码散列与门户会话。
 *
 * - 密码用 node:crypto 的 scrypt，每个账号独立随机盐，timingSafeEqual 比较。
 * - 会话令牌形如 `oas_…`，库里只存 sha256；改密码、停用、重置密码时该账号的会话全部作废。
 * - 余额列 `balance` 只由 platform-billing.ts 改动。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { prepared } from './platform-db.js';
import { Fault, id, sha } from '../core/util.js';

export type AccountStatus = 'active' | 'disabled';
export type AccountRecord = {
  id: string;
  email: string;
  name: string;
  status: AccountStatus;
  /** Micro-points. */
  balance: number;
  createdAt: number;
  lastActiveAt: number | null;
  passwordHash: string;
};
type AccountPayload = Omit<AccountRecord, 'id' | 'email' | 'balance'>;

/** Parameters of new hashes (one of OWASP's equivalent scrypt configurations). */
const SCRYPT = { N: 32_768, r: 8, p: 3, keylen: 32 } as const;
/** Hashes written before parameters were stored (`scrypt$<salt>$<hash>`). */
const LEGACY_SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ScryptParams = { N: number; r: number; p: number };
function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      SCRYPT.keylen,
      // OpenSSL needs about 128 * N * r bytes; allow twice that.
      { ...params, maxmem: Math.max(64 * 1024 * 1024, 256 * params.N * params.r) },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
/** A positive decimal integer no larger than `max`, from a stored field. */
function boundedInt(field: string | undefined, max: number): number | undefined {
  if (field === undefined || !/^[1-9][0-9]{0,9}$/.test(field)) return undefined;
  const value = Number(field);
  return value <= max ? value : undefined;
}
function storedParts(
  parts: string[],
): { params: ScryptParams; salt: string; hash: string } | undefined {
  if (parts[0] !== 'scrypt') return undefined;
  if (parts.length === 3) {
    const [, salt, hash] = parts;
    return salt && hash ? { params: LEGACY_SCRYPT, salt, hash } : undefined;
  }
  if (parts.length !== 6) return undefined;
  const [, n, r, p, salt, hash] = parts;
  const N = boundedInt(n, MAX_N);
  const rr = boundedInt(r, MAX_R);
  const pp = boundedInt(p, MAX_P);
  // scrypt needs N to be a power of two greater than 1.
  if (!N || N < 2 || (N & (N - 1)) !== 0 || !rr || !pp || !salt || !hash) return undefined;
  return { params: { N, r: rr, p: pp }, salt, hash };
}
export function checkPassword(password: unknown, field = 'password'): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200)
    throw new Fault('invalid_request', `${field} must contain 8-200 characters.`, 400);
  return password;
}
export function normalizeEmail(email: unknown): string {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!value || value.length > 254 || !EMAIL.test(value))
    throw new Fault('invalid_request', 'email must be a valid email address.', 400);
  return value;
}
/** `scrypt$<N>$<r>$<p>$<salt>$<hash>`: the parameters travel with the hash so they can be raised. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT;
  const key = await derive(password, salt, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = storedParts(stored.split('$'));
  if (!parsed) return false;
  const expected = Buffer.from(parsed.hash, 'base64url');
  const actual = await derive(password, Buffer.from(parsed.salt, 'base64url'), parsed.params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class PlatformAccounts {
  /** Compared against when the email is unknown, so both failures cost one scrypt. */
  private dummyHash?: Promise<string>;
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
    private readonly sessionTtlMs: number,
  ) {}
  private parse(row: Record<string, unknown>): AccountRecord {
    const payload = JSON.parse(String(row.payload)) as AccountPayload;
    return {
      ...payload,
      lastActiveAt: payload.lastActiveAt ?? null,
      id: String(row.id),
      email: String(row.email),
      balance: Number(row.balance),
    };
  }
  find(accountId: string): AccountRecord | undefined {
    const row = prepared(
      this.db,
      'SELECT id,email,balance,payload FROM platform_accounts WHERE id=? AND owner=?',
    ).get(accountId, this.owner);
    return row ? this.parse(row) : undefined;
  }
  get(accountId: string): AccountRecord {
    const account = this.find(accountId);
    if (!account) throw new Fault('account_not_found', 'Account was not found.', 404);
    return account;
  }
  byEmail(email: string): AccountRecord | undefined {
    const row = prepared(
      this.db,
      'SELECT id,email,balance,payload FROM platform_accounts WHERE owner=? AND email=?',
    ).get(this.owner, email);
    return row ? this.parse(row) : undefined;
  }
  /** Inserts an account with balance 0 (credits are posted to the ledger by the caller). */
  insert(email: string, passwordHash: string, name: string): AccountRecord {
    if (this.byEmail(email))
      throw new Fault('email_taken', 'This email is already registered.', 409);
    const now = Date.now();
    const account: AccountRecord = {
      id: id('acct'),
      email,
      name,
      status: 'active',
      balance: 0,
      createdAt: now,
      lastActiveAt: null,
      passwordHash,
    };
    prepared(
      this.db,
      'INSERT INTO platform_accounts(id,owner,email,balance,payload) VALUES(?,?,?,0,?)',
    ).run(account.id, this.owner, email, JSON.stringify(this.payloadOf(account)));
    return account;
  }
  private payloadOf(account: AccountRecord): AccountPayload {
    return {
      name: account.name,
      status: account.status,
      createdAt: account.createdAt,
      lastActiveAt: account.lastActiveAt,
      passwordHash: account.passwordHash,
    };
  }
  private save(account: AccountRecord): void {
    prepared(this.db, 'UPDATE platform_accounts SET payload=? WHERE id=? AND owner=?').run(
      JSON.stringify(this.payloadOf(account)),
      account.id,
      this.owner,
    );
  }
  setStatus(accountId: string, status: AccountStatus): AccountRecord {
    const account = this.get(accountId);
    account.status = status;
    this.save(account);
    if (status === 'disabled') this.dropSessions(accountId);
    return account;
  }
  setPasswordHash(accountId: string, passwordHash: string): void {
    const account = this.get(accountId);
    account.passwordHash = passwordHash;
    this.save(account);
    this.dropSessions(accountId);
  }
  touch(accountId: string, at = Date.now()): void {
    const account = this.find(accountId);
    if (!account) return;
    account.lastActiveAt = at;
    this.save(account);
  }
  /** Verifies email + password; the same error and the same work for every failure. */
  async verify(email: string, password: string): Promise<AccountRecord> {
    const account = this.byEmail(email);
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const ok = await verifyPassword(password, account?.passwordHash ?? (await this.dummyHash));
    if (!account || !ok) throw new Fault('invalid_credentials', 'Email or password is wrong.', 401);
    return account;
  }
  list(
    query: string,
    limit: number,
    cursor?: number,
  ): { rows: AccountRecord[]; next: number | null } {
    const like = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = prepared(
      this.db,
      `SELECT rowid AS seq,id,email,balance,payload FROM platform_accounts
         WHERE owner=? AND email LIKE ? ESCAPE '\\' AND rowid<? ORDER BY rowid DESC LIMIT ?`,
    ).all(this.owner, like, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    return {
      rows: page.map((row) => this.parse(row)),
      next: rows.length > limit ? Number(page.at(-1)!.seq) : null,
    };
  }
  counts(): { total: number; active: number; disabled: number; balance: number } {
    const row = prepared(
      this.db,
      `SELECT count(*) AS total,coalesce(sum(json_extract(payload,'$.status')='active'),0) AS active,
         coalesce(sum(balance),0) AS balance FROM platform_accounts WHERE owner=?`,
    ).get(this.owner)!;
    const total = Number(row.total);
    const active = Number(row.active);
    return { total, active, disabled: total - active, balance: Number(row.balance) };
  }

  createSession(accountId: string): { token: string; expiresAt: number } {
    const token = `oas_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    prepared(this.db, 'DELETE FROM platform_sessions WHERE expires_at<=?').run(now);
    prepared(
      this.db,
      'INSERT INTO platform_sessions(hash,account_id,expires_at,created_at) VALUES(?,?,?,?)',
    ).run(sha(token), accountId, expiresAt, now);
    return { token, expiresAt };
  }
  /** Resolves a session token to its active account. */
  session(token: unknown): AccountRecord {
    if (typeof token !== 'string' || !token.startsWith('oas_') || token.length > 200)
      throw new Fault('session_invalid', 'The portal session is invalid or has expired.', 401);
    const row = prepared(
      this.db,
      'SELECT account_id,expires_at FROM platform_sessions WHERE hash=?',
    ).get(sha(token));
    const account = row ? this.find(String(row.account_id)) : undefined;
    if (!row || !account || Number(row.expires_at) <= Date.now())
      throw new Fault('session_invalid', 'The portal session is invalid or has expired.', 401);
    if (account.status !== 'active')
      throw new Fault('account_disabled', 'This account has been disabled.', 403);
    return account;
  }
  dropSession(token: string): void {
    prepared(this.db, 'DELETE FROM platform_sessions WHERE hash=?').run(sha(token));
  }
  dropSessions(accountId: string): void {
    prepared(this.db, 'DELETE FROM platform_sessions WHERE account_id=?').run(accountId);
  }
}
