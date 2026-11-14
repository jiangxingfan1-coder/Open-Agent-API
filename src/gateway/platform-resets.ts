/**
 * 开发者平台：运营者发给开发者的一次性重置码。
 *
 * - 库里只存码的 sha256（码本身有 120 位随机性），每个账号最多一张有效码，生成新码即替换旧码。
 * - 有效期 24 小时；用掉即删除。设置新密码与作废会话由调用方（门面）完成。
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { prepared } from './platform-db.js';
import { safeEqual, sha } from '../core/util.js';

export const RESET_CODE_TTL_MS = 24 * 3_600_000;

export class PlatformResets {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
  ) {}
  /** A new code for the account; any earlier code of the account stops working. */
  issue(accountId: string, now = Date.now()): { code: string; expiresAt: number } {
    const code = randomBytes(15).toString('base64url');
    const expiresAt = now + RESET_CODE_TTL_MS;
    prepared(
      this.db,
      'INSERT OR REPLACE INTO platform_reset_codes(account_id,owner,hash,expires_at,created_at) VALUES(?,?,?,?,?)',
    ).run(accountId, this.owner, sha(code), expiresAt, now);
    return { code, expiresAt };
  }
  /** Whether `code` is the account's current, unexpired code (does not use it up). */
  matches(accountId: string, code: string, now = Date.now()): boolean {
    const row = prepared(
      this.db,
      'SELECT hash,expires_at FROM platform_reset_codes WHERE account_id=? AND owner=?',
    ).get(accountId, this.owner);
    // The comparison runs even without a row, so both failures cost the same.
    const ok = safeEqual(sha(code), row ? String(row.hash) : '');
    return !!row && ok && Number(row.expires_at) > now;
  }
  /** Uses the code up; false when it is no longer valid. */
  consume(accountId: string, code: string, now = Date.now()): boolean {
    if (!this.matches(accountId, code, now)) return false;
    prepared(this.db, 'DELETE FROM platform_reset_codes WHERE account_id=? AND owner=?').run(
      accountId,
      this.owner,
    );
    return true;
  }
}
