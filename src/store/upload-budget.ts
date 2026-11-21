import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Fault, RetryLaterFault } from '../core/util.js';
import { bi } from '../core/locale.js';
import { isWriteContended, isWriteUnavailable } from './checkpoint.js';
import { tryBeginWrite } from './write-lock.js';
import { fileBytes, uploadUsage, type UsageConnection } from './upload-usage.js';

export type UploadPolicy = { kind: 'inline' | 'upload'; limit?: number; guard?: () => void };
export class UnconfirmedFileCommit extends Fault {
  constructor(readonly fileId: string) {
    super(
      'file_commit_unconfirmed',
      bi(
        `无法确认文件 ${fileId} 的提交结果，请按 ID 核对后再决定是否重传。`,
        `The commit for file ${fileId} could not be confirmed. Check the file before uploading again.`,
      ),
      409,
      true,
    );
  }
}
type Statements = { prepare(sql: string): StatementSync };
const size = fileBytes('payload');
const digest =
  "CASE WHEN json_valid(payload) THEN CASE WHEN json_extract(payload,'$.runId') IS NULL AND json_extract(payload,'$.allowedNodes') IS NULL AND json_type(payload,'$.sha256')='text' AND length(json_extract(payload,'$.sha256'))=64 THEN json_extract(payload,'$.sha256') END END";
export function installUploadBudget(db: DatabaseSync) {
  db.exec(`CREATE INDEX IF NOT EXISTS file_upload_facts ON files(owner,subject,${digest},${size});
    CREATE INDEX IF NOT EXISTS oaa_upload_reservations ON oaa_inline_inputs(owner,subject,bytes) WHERE phase='writing';`);
}
export function storedUploadCopy(
  store: Statements,
  owner: string,
  subject: string,
  hash: string,
  bytes: number,
) {
  const r = store
    .prepare(
      `SELECT id FROM files WHERE owner=? AND subject=? AND ${digest}=? AND ${size}=? ORDER BY rowid LIMIT 1`,
    )
    .get(owner, subject, hash, bytes);
  return r ? String(r.id) : undefined;
}
export function checkUploadRoom(
  store: UsageConnection,
  owner: string,
  subject: string,
  incoming: number,
  limit?: number,
) {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(incoming) || incoming < 0)
    throw new Fault('persistence_failed', 'Cannot verify the requested storage amount.', 500);
  const { used, reserved } = uploadUsage(store, owner, subject);
  if (
    typeof used !== 'number' ||
    typeof reserved !== 'number' ||
    used < 0 ||
    reserved < 0 ||
    !Number.isSafeInteger(used + reserved)
  )
    throw new Fault('persistence_failed', 'Cannot verify stored file usage for this caller.', 500);
  if (incoming > limit - used - reserved)
    throw new Fault(
      'storage_quota_exceeded',
      `This caller may store at most ${limit} bytes of files.`,
      413,
    );
}

const busy = () =>
  new RetryLaterFault(
    'upload_busy',
    'File storage could not admit this upload within its wait budget.',
    503,
    1,
  );
/** Capacity for buffered callers, not a limit on total process memory or on durable files. */
export class UploadWaitBudget {
  private waiting = new Set<{ owner: string; bytes: number }>();
  take(owner: string, bytes: number) {
    let all = bytes,
      own = bytes,
      n = 1;
    for (const w of this.waiting) {
      all += w.bytes;
      if (w.owner === owner) {
        own += w.bytes;
        n++;
      }
    }
    if (this.waiting.size >= 64 || n > 8 || all > 64 * 1024 ** 2 || own > 32 * 1024 ** 2)
      throw busy();
    const held = { owner, bytes };
    this.waiting.add(held);
    return () => this.waiting.delete(held);
  }
}
// Only acquisition is retried, never a write or a quota reservation.
export class UploadWriter {
  private budget = new UploadWaitBudget();
  private stopped = false;
  private timeout?: StatementSync;
  constructor(private db: DatabaseSync) {}
  close() {
    this.stopped = true;
    this.timeout = undefined;
  }
  async run<T>(
    owner: string,
    bytes: number,
    guard: (() => void) | undefined,
    work: () => T,
    confirm?: () => boolean,
  ): Promise<T> {
    if (this.stopped) throw new Fault('shutting_down', 'File storage is shutting down.', 503);
    let release: (() => void) | undefined;
    const timeout = Number(
      (this.timeout ??= this.db.prepare('PRAGMA busy_timeout')).get()!.timeout,
    );
    const until = performance.now() + Math.min(5000, timeout);
    let backoff = 10;
    try {
      for (;;) {
        if (this.stopped) throw new Fault('shutting_down', 'File storage is shutting down.', 503);
        if (this.db.isTransaction)
          throw new Fault('persistence_failed', 'An upload cannot use another transaction.', 500);
        guard?.();
        if (release && performance.now() >= until) throw busy();
        try {
          tryBeginWrite(this.db, release ? Number(this.timeout!.get()!.timeout) : timeout);
          break;
        } catch (e) {
          if (!isWriteContended(e) || this.db.isTransaction) throw e;
          const left = until - performance.now();
          if (left <= 0) throw busy();
          release ??= this.budget.take(owner, bytes);
          await delay(Math.min(backoff, left));
          backoff = Math.min(100, backoff * 2);
        }
      }
      try {
        const result = work();
        try {
          this.db.exec('COMMIT');
        } catch (error) {
          if (this.db.isTransaction || !isWriteUnavailable(error) || !confirm?.()) throw error;
        }
        return result;
      } catch (e) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      release?.();
    }
  }
}
