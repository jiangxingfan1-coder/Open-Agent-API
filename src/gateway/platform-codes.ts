/**
 * 开发者平台：兑换码与邀请码。
 *
 * 明文只在生成时返回一次，库里只有散列；同一账号不能重复使用同一张码（platform_code_uses 主键）。
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { prepared } from './platform-db.js';
import { Fault, id, sha } from '../core/util.js';

export type CodeKind = 'credit' | 'invite';
export type CodeRecord = {
  id: string;
  kind: CodeKind;
  /** Micro-points granted on use (invite codes may grant credits on signup too). */
  credits: number;
  maxUses: number;
  used: number;
  expiresAt: number | null;
  note: string;
  revoked: boolean;
  createdAt: number;
};
export type CodeSpec = {
  kind: CodeKind;
  credits: number;
  maxUses: number;
  count: number;
  expiresAt: number | null;
  note: string;
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function plaintext(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `OAA-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}
const normalize = (code: string) => code.trim().toUpperCase();
const invalid = () =>
  new Fault('invalid_code', 'The code is invalid, used up, expired or already used.', 400);

export class PlatformCodes {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
  ) {}
  list(): CodeRecord[] {
    return prepared(this.db, 'SELECT payload FROM platform_codes WHERE owner=? ORDER BY rowid DESC')
      .all(this.owner)
      .map((row) => JSON.parse(String(row.payload)) as CodeRecord);
  }
  generate(spec: CodeSpec): (CodeRecord & { code: string })[] {
    if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 100)
      throw new Fault('invalid_request', 'count must be between 1 and 100.', 400);
    if (!Number.isInteger(spec.maxUses) || spec.maxUses < 1 || spec.maxUses > 1_000_000)
      throw new Fault('invalid_request', 'max_uses must be between 1 and 1000000.', 400);
    if (!Number.isSafeInteger(spec.credits) || spec.credits < 0)
      throw new Fault('invalid_request', 'credits must not be negative.', 400);
    if (spec.kind === 'credit' && spec.credits <= 0)
      throw new Fault('invalid_request', 'A credit code needs credits above 0.', 400);
    if (
      spec.expiresAt !== null &&
      (!Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= Date.now())
    )
      throw new Fault('invalid_request', 'expires_at must be a future timestamp.', 400);
    if (spec.note.length > 200)
      throw new Fault('invalid_request', 'note must be at most 200 characters.', 400);
    const out: (CodeRecord & { code: string })[] = [];
    for (let i = 0; i < spec.count; i++) {
      const code = plaintext();
      const record: CodeRecord = {
        id: id('code'),
        kind: spec.kind,
        credits: spec.credits,
        maxUses: spec.maxUses,
        used: 0,
        expiresAt: spec.expiresAt,
        note: spec.note,
        revoked: false,
        createdAt: Date.now(),
      };
      prepared(this.db, 'INSERT INTO platform_codes(id,owner,hash,payload) VALUES(?,?,?,?)').run(
        record.id,
        this.owner,
        sha(normalize(code)),
        JSON.stringify(record),
      );
      out.push({ ...record, code });
    }
    return out;
  }
  revoke(codeId: string): void {
    const row = prepared(this.db, 'SELECT payload FROM platform_codes WHERE id=? AND owner=?').get(
      codeId,
      this.owner,
    );
    if (!row) throw new Fault('code_not_found', 'Code was not found.', 404);
    const record = JSON.parse(String(row.payload)) as CodeRecord;
    record.revoked = true;
    this.save(record);
  }
  private save(record: CodeRecord): void {
    prepared(this.db, 'UPDATE platform_codes SET payload=? WHERE id=? AND owner=?').run(
      JSON.stringify(record),
      record.id,
      this.owner,
    );
  }
  /** Finds a usable code of `kind` (not consumed yet). */
  check(code: unknown, kind: CodeKind, accountId?: string): CodeRecord {
    if (typeof code !== 'string' || !code.trim() || code.length > 100) throw invalid();
    const row = prepared(
      this.db,
      'SELECT payload FROM platform_codes WHERE owner=? AND hash=?',
    ).get(this.owner, sha(normalize(code)));
    if (!row) throw invalid();
    const record = JSON.parse(String(row.payload)) as CodeRecord;
    if (
      record.kind !== kind ||
      record.revoked ||
      record.used >= record.maxUses ||
      (record.expiresAt !== null && Date.now() >= record.expiresAt)
    )
      throw invalid();
    if (
      accountId &&
      prepared(this.db, 'SELECT 1 FROM platform_code_uses WHERE code_id=? AND account_id=?').get(
        record.id,
        accountId,
      )
    )
      throw invalid();
    return record;
  }
  /** Records one use; call inside the transaction that also credits the account. */
  consume(record: CodeRecord, accountId: string): void {
    prepared(
      this.db,
      'INSERT INTO platform_code_uses(code_id,account_id,used_at) VALUES(?,?,?)',
    ).run(record.id, accountId, Date.now());
    record.used += 1;
    this.save(record);
  }
}
