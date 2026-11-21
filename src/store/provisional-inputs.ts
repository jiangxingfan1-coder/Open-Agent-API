import { lstat, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { Fault, writePrivate } from '../core/util.js';
import { LIMITS } from '../core/limits.js';
import { hashFileStreaming } from './large-artifacts.js';
import { isWriteUnavailable } from './checkpoint.js';
import { tryBeginWrite } from './write-lock.js';
import { withSavepoint } from './savepoint.js';
import {
  checkUploadRoom,
  UploadWriter,
  UnconfirmedFileCommit,
  type UploadPolicy,
} from './upload-budget.js';

type Input = {
  id: string;
  owner: string;
  bytes: number;
  sha256: string;
  runId?: string;
  allowedNodes?: string[];
};
type Ticket = {
  seq: number;
  file_id: string;
  owner: string;
  subject: string;
  bytes: number;
  digest: string;
  identity: string;
  phase: 'writing' | 'ready' | 'unlink';
};
type Observation = { stamp: string } | 'absent' | 'foreign' | 'retry';
const BATCH = 16;
const validId = (id: string) => id.length === 37 && /^file_[0-9a-f]{32}$/.test(id);
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const stamp = (s: BigIntStats) => `${identity(s)}:${s.size}:${s.mtimeNs}`;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/** The journal owns deletion rights, not filenames. In-memory holders only delay their use. */
export class ProvisionalInputs {
  private files = new Map<string, { owner: string; holders: number }>();
  private released = new Set<string>();
  private statements = new Map<string, StatementSync>();
  private upper = 0;
  private cursor = 0;
  private timer?: NodeJS.Timeout;
  private wakeAt = Infinity;
  private running?: Promise<void>;
  private closed = false;
  private delay = 10;
  private warnedAt = -Infinity;
  private writer: UploadWriter;
  constructor(
    private db: DatabaseSync,
    private root: string,
  ) {
    this.writer = new UploadWriter(db);
  }
  private q(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }
  start(previousUpper: number) {
    // Acquiring the exclusive store lease makes the pre-existing prefix stale. New
    // uploads have higher sequence numbers and are never swept as abandoned writers.
    this.upper = previousUpper;
    if (this.upper) this.schedule(Date.now());
  }
  async write(
    file: Input,
    subject: string,
    bytes: Buffer,
    publish: () => { changes: number | bigint },
    policy: UploadPolicy,
  ) {
    if (
      !validId(file.id) ||
      file.runId !== undefined ||
      (policy.kind === 'inline' && file.allowedNodes !== undefined)
    )
      throw new Fault('invalid_file', 'Only a new input upload can be staged.', 400);
    this.requireWriter();
    policy.guard?.();
    const dir = path.join(this.root, 'files');
    const parent = await lstat(dir).catch((error) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (parent && !parent.isDirectory())
      throw new Fault('invalid_path', 'Input storage must be a directory.', 400);
    let bound: string | undefined,
      registered = false,
      attempted = false;
    try {
      await writePrivate(dir, file.id, bytes, true, async (handle) => {
        bound = identity(await handle.stat({ bigint: true }));
        this.requireWriter();
        await this.writer.run(file.owner, file.bytes, policy.guard, () => {
          checkUploadRoom(
            { prepare: (sql) => this.q(sql) },
            file.owner,
            subject,
            file.bytes,
            policy.limit,
          );
          attempted = true;
          const r = this.q(
            `INSERT INTO oaa_inline_inputs(file_id,owner,subject,digest,bytes,identity,phase)
          SELECT ?,?,?,?,?,?,'writing' WHERE NOT EXISTS(SELECT 1 FROM files WHERE id=?)`,
          ).run(file.id, file.owner, subject, file.sha256, file.bytes, bound!, file.id);
          if (!r.changes)
            throw new Fault('persistence_failed', 'Could not reserve the inline input.', 500);
        });
        registered = true;
      });
      this.requireWriter();
      // Explicit upload acceptance is the claim. Inline inputs keep their receipt until run admission.
      const published = () =>
        !!this.q(
          "SELECT 1 FROM files WHERE id=? AND owner=? AND subject=? AND json_extract(payload,'$.sha256')=? AND json_extract(payload,'$.bytes')=?",
        ).get(file.id, file.owner, subject, file.sha256, file.bytes);
      await this.writer.run(
        file.owner,
        file.bytes,
        policy.guard,
        () => {
          if (
            policy.kind === 'upload' &&
            !this.q(
              "DELETE FROM oaa_inline_inputs WHERE file_id=? AND owner=? AND subject=? AND phase='writing'",
            ).run(file.id, file.owner, subject).changes
          )
            throw new Fault('persistence_failed', 'Could not claim the explicit upload.', 500);
          if (
            !publish().changes ||
            !published() ||
            this.q('SELECT phase FROM oaa_inline_inputs WHERE file_id=?').get(file.id)?.phase !==
              (policy.kind === 'inline' ? 'ready' : undefined)
          )
            throw new Fault('persistence_failed', 'Could not publish the uploaded file.', 500);
        },
        () => {
          try {
            return published();
          } catch {
            throw new UnconfirmedFileCommit(file.id);
          }
        },
      );
      if (policy.kind === 'inline') this.files.set(file.id, { owner: file.owner, holders: 0 });
    } catch (error) {
      if (attempted && !this.closed) {
        this.released.add(file.id);
        this.schedule(Date.now());
      }
      if (!registered && bound) {
        // The exclusive handle opened, but no user bytes were written before registration.
        const target = path.join(dir, file.id);
        const s = await lstat(target, { bigint: true }).catch(() => undefined);
        if (s?.isFile() && s.size === 0n && identity(s) === bound)
          await unlink(target).catch(() => {});
      }
      if (error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR')
        throw new Fault('persistence_failed', 'Could not persist the uploaded file.', 500);
      throw error;
    }
  }
  private requireWriter() {
    if (this.closed) throw new Fault('shutting_down', 'Input storage has closed.', 503);
    if (this.db.isTransaction)
      throw new Fault(
        'persistence_failed',
        'Inline input bytes cannot be written under a caller-owned transaction.',
        500,
      );
  }
  hold(owner: string, ids: readonly string[]): string[] {
    const held: string[] = [];
    for (const id of new Set(ids)) {
      let slot = this.files.get(id);
      if (
        !slot &&
        this.q("SELECT 1 FROM oaa_inline_inputs WHERE file_id=? AND owner=? AND phase='ready'").get(
          id,
          owner,
        )
      ) {
        slot = { owner, holders: 0 };
        this.files.set(id, slot);
      }
      if (slot?.owner !== owner) continue;
      slot.holders++;
      this.released.delete(id);
      held.push(id);
    }
    return held;
  }
  /** Post-commit memory bookkeeping only; SQLite triggers already protected the durable inputs. */
  adopt(ids: readonly string[]) {
    if (!this.files.size && !this.released.size) return;
    for (const id of ids) {
      this.files.delete(id);
      this.released.delete(id);
    }
  }
  async release(ids: readonly string[]) {
    for (const id of ids) {
      const f = this.files.get(id);
      if (f && --f.holders === 0) this.released.add(id);
    }
    if (!this.closed && this.released.size) {
      if (this.running) await this.running;
      if (!this.closed && this.released.size) await this.pump();
    }
  }
  private warn(message: string) {
    if (Date.now() - this.warnedAt < 60000) return;
    this.warnedAt = Date.now();
    process.emitWarning(message, { code: 'OAA_INPUT_CLEANUP' });
  }
  private schedule(at: number) {
    if (this.closed || (this.timer && this.wakeAt <= at)) return;
    clearTimeout(this.timer);
    this.wakeAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wakeAt = Infinity;
        void this.pump();
      },
      Math.min(60000, Math.max(1, at - Date.now())),
    ).unref();
  }
  private transaction<T>(work: () => T) {
    tryBeginWrite(this.db, Number(this.q('PRAGMA busy_timeout').get()!.timeout));
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private enqueue() {
    const stale =
      this.cursor < this.upper
        ? this.q(
            'SELECT seq,file_id FROM oaa_inline_inputs WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',
          ).all(this.cursor, this.upper, BATCH)
        : [];
    const fresh: string[] = [];
    for (const id of this.released) {
      fresh.push(id);
      if (fresh.length === BATCH) break;
    }
    const noMarker: string[] = [];
    if (stale.length || fresh.length)
      this.transaction(() => {
        const mark = this.q('UPDATE oaa_inline_inputs SET due=0 WHERE file_id=?');
        for (const id of [...fresh, ...stale.map((r) => String(r.file_id))])
          if (!this.files.get(id)?.holders && !mark.run(id).changes) {
            if (this.q('SELECT 1 FROM oaa_inline_inputs WHERE file_id=?').get(id))
              throw new Fault(
                'persistence_failed',
                'Inline input cleanup could not be scheduled.',
                500,
              );
            noMarker.push(id);
          }
      });
    this.cursor = stale.length === BATCH ? Number(stale.at(-1)!.seq) : this.upper;
    for (const id of fresh) this.released.delete(id);
    for (const id of noMarker) this.files.delete(id);
    return fresh;
  }
  private async observe(r: Ticket): Promise<Observation> {
    if (
      !validId(r.file_id) ||
      !Number.isSafeInteger(r.bytes) ||
      r.bytes < 0 ||
      r.bytes > LIMITS.fileBytes
    )
      return 'foreign';
    try {
      const dir = path.join(this.root, 'files');
      if (!(await lstat(dir)).isDirectory()) return 'foreign';
      const target = path.join(dir, r.file_id),
        s = await lstat(target, { bigint: true });
      const verified = stamp(s);
      if (
        !s.isFile() ||
        (r.phase === 'unlink' ? verified : identity(s)) !== r.identity ||
        s.size > BigInt(r.bytes)
      )
        return 'foreign';
      if (r.phase === 'unlink' && s.ino !== 0n) return { stamp: verified };
      if (s.size !== BigInt(r.bytes))
        return r.phase === 'writing' && s.ino !== 0n ? { stamp: verified } : 'foreign';
      const actual = await hashFileStreaming(target, r.bytes);
      return actual.sha256 === r.digest && stamp(await lstat(target, { bigint: true })) === verified
        ? { stamp: verified }
        : 'foreign';
    } catch (error) {
      return missing(error) ? 'absent' : 'retry';
    }
  }
  private async remove(r: Ticket): Promise<Observation> {
    const observed = await this.observe(r);
    if (this.closed || typeof observed === 'string') return observed;
    if (
      !this.q(
        "SELECT 1 FROM oaa_inline_inputs WHERE seq=? AND file_id=? AND phase='unlink' AND NOT EXISTS(SELECT 1 FROM files WHERE id=?)",
      ).get(r.seq, r.file_id, r.file_id)
    )
      return 'foreign';
    try {
      await unlink(path.join(this.root, 'files', r.file_id));
      return 'absent';
    } catch (error) {
      return missing(error) ? 'absent' : 'retry';
    }
  }
  private prepareRemoval(r: Ticket, observed: Observation, now: number) {
    const id = r.file_id;
    const active = this.q(
      'SELECT phase,identity FROM oaa_inline_inputs WHERE seq=? AND file_id=? AND due IS NOT NULL',
    ).get(r.seq, id);
    if (!active) return false; // Claimed while we were inspecting the blob.
    if (active.phase !== r.phase || active.identity !== r.identity) return false;
    if (this.files.get(id)?.holders) {
      this.q('UPDATE oaa_inline_inputs SET due=NULL WHERE seq=?').run(r.seq);
      return false;
    }
    if (observed === 'retry') {
      this.defer(r, now);
      this.warn('Upload cleanup is waiting for filesystem access; its receipt was retained.');
      return false;
    }
    const file = this.q('SELECT owner,subject,payload FROM files WHERE id=?').get(id);
    let matches = !file;
    if (file && active.phase === 'ready' && file.owner === r.owner && file.subject === r.subject) {
      try {
        const value = JSON.parse(String(file.payload)) as Input;
        matches =
          value.id === id &&
          value.owner === r.owner &&
          value.bytes === r.bytes &&
          value.sha256 === r.digest &&
          value.runId === undefined &&
          value.allowedNodes === undefined;
      } catch {
        matches = false;
      }
    }
    if (!matches || observed === 'foreign') {
      this.disarm(r);
      this.warn('Retained an inline input whose ownership could not be verified.');
      return false;
    }
    if (
      file &&
      !this.q('DELETE FROM files WHERE id=? AND owner=? AND subject=?').run(id, r.owner, r.subject)
        .changes
    )
      throw new Fault('persistence_failed', 'Could not retire the inline input.', 500);
    if (active.phase !== 'unlink') {
      const token = observed === 'absent' ? 'absent' : observed.stamp;
      if (
        !this.q("UPDATE oaa_inline_inputs SET phase='unlink',identity=? WHERE seq=?").run(
          token,
          r.seq,
        ).changes
      )
        throw new Fault(
          'persistence_failed',
          'Could not reserve the inline input for removal.',
          500,
        );
      r.phase = 'unlink';
      r.identity = token;
    }
    if (this.q('SELECT 1 FROM files WHERE id=?').get(id))
      throw new Fault('persistence_failed', 'Could not reserve the inline input for removal.', 500);
    return true;
  }
  private defer(r: Ticket, now: number) {
    this.q('UPDATE oaa_inline_inputs SET due=? WHERE seq=?').run(now + 1000, r.seq);
  }
  private disarm(r: Ticket) {
    if (
      !this.q('DELETE FROM oaa_inline_inputs WHERE seq=?').run(r.seq).changes &&
      this.q('SELECT 1 FROM oaa_inline_inputs WHERE seq=?').get(r.seq)
    )
      throw new Fault('persistence_failed', 'Could not clear the inline input receipt.', 500);
  }
  private attempt<T>(r: Ticket, now: number, change: () => T, fallback: T): T {
    try {
      return withSavepoint(this.db, change);
    } catch (error) {
      if (!this.db.isTransaction || isWriteUnavailable(error)) throw error;
      this.defer(r, now);
      this.warn('Inline input cleanup deferred a metadata change.');
      return fallback;
    }
  }
  private async drain() {
    if (this.closed) return;
    const fresh = this.enqueue(),
      now = Date.now();
    const batch = new Map<number, Ticket>();
    // Do not make a newly refused upload wait behind the entire recovery backlog.
    for (const id of fresh.slice(0, BATCH / 2)) {
      const r = this.q('SELECT * FROM oaa_inline_inputs WHERE file_id=? AND due<=?').get(
        id,
        now,
      ) as Ticket | undefined;
      if (r) batch.set(r.seq, r);
    }
    for (const r of this.q(
      'SELECT * FROM oaa_inline_inputs WHERE due<=? ORDER BY due,seq LIMIT ?',
    ).all(now, BATCH) as unknown as Ticket[]) {
      if (batch.size >= BATCH) break;
      batch.set(r.seq, r);
    }
    const rows = [...batch.values()];
    if (rows.length) {
      const seen = await Promise.all(rows.map((r) => this.observe(r)));
      if (this.closed) return;
      const unlinkable = this.transaction(() =>
        rows.filter((r, i) =>
          this.attempt(r, now, () => this.prepareRemoval(r, seen[i]!, now), false),
        ),
      );
      // An unlink is authorized only by the committed tombstone. It remains durable until
      // the blob is absent. No transaction or writer lock spans a filesystem await.
      const outcomes = await Promise.all(unlinkable.map((r) => this.remove(r)));
      if (this.closed) return;
      if (unlinkable.length)
        this.transaction(() =>
          unlinkable.forEach((r, i) =>
            this.attempt(
              r,
              Date.now(),
              () => {
                if (outcomes[i] === 'retry') {
                  this.defer(r, Date.now());
                  this.warn(
                    'Upload cleanup is waiting to unlink a blob; its receipt was retained.',
                  );
                } else {
                  if (outcomes[i] === 'foreign')
                    this.warn('A replacement blob was retained during inline input cleanup.');
                  this.disarm(r);
                }
              },
              undefined,
            ),
          ),
        );
      for (const r of rows)
        if (
          !this.files.get(r.file_id)?.holders &&
          !this.q("SELECT 1 FROM oaa_inline_inputs WHERE file_id=? AND phase='ready'").get(
            r.file_id,
          )
        )
          this.files.delete(r.file_id);
    }
    this.delay = 10;
    if (this.cursor < this.upper || this.released.size) {
      this.schedule(Date.now());
      return;
    }
    if (
      this.upper &&
      !this.q('SELECT 1 FROM oaa_inline_inputs WHERE seq<=? LIMIT 1').get(this.upper)
    )
      this.upper = this.cursor = 0;
    const due = this.q(
      'SELECT due FROM oaa_inline_inputs WHERE due IS NOT NULL ORDER BY due,seq LIMIT 1',
    ).get();
    if (due) this.schedule(Number(due.due));
  }
  private pump() {
    if (this.running) return this.running;
    const work = this.drain()
      .catch((error) => {
        if (this.closed) return;
        if (!isWriteUnavailable(error))
          this.warn('Inline input recovery is waiting for the store.');
        this.schedule(Date.now() + this.delay);
        this.delay = Math.min(1000, this.delay * 2);
      })
      .finally(() => {
        this.running = undefined;
        if (!this.closed && this.released.size && !this.timer) this.schedule(Date.now());
      });
    this.running = work;
    return work;
  }
  close() {
    this.stopAccepting();
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.files.clear();
    this.released.clear();
    this.statements.clear();
  }
  stopAccepting() {
    this.writer.close();
  }
}
