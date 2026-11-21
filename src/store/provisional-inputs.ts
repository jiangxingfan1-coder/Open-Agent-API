import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isWriteUnavailable } from './checkpoint.js';
import { tryBeginWrite } from './write-lock.js';

// A newly materialized input may be reused by another request before either run commits.
// Only this connection's own temporary uploads can be removed. Losing the process leaves
// an ordinary private upload for retention; it must never delete a committed run's input.
export class ProvisionalInputs {
  private files = new Map<string, { owner: string; holders: number }>();
  private ready = new Set<string>();
  private timer?: NodeJS.Timeout;
  private delay = 10;
  constructor(
    private db: DatabaseSync,
    private root: string,
  ) {}
  created(owner: string, id: string) {
    this.files.set(id, { owner, holders: 0 });
  }
  hold(owner: string, ids: readonly string[]): string[] {
    if (!this.files.size) return [];
    const held: string[] = [];
    for (const id of new Set(ids)) {
      const f = this.files.get(id);
      if (f?.owner !== owner) continue;
      f.holders++;
      this.ready.delete(id);
      held.push(id);
    }
    return held;
  }
  /** Run only after COMMIT, before observers can abandon another request. */
  adopt(ids: readonly string[]) {
    if (!this.files.size) return;
    for (const id of ids) {
      this.files.delete(id);
      this.ready.delete(id);
    }
  }
  async release(ids: readonly string[]) {
    for (const id of ids) {
      const f = this.files.get(id);
      if (f && --f.holders === 0) this.ready.add(id);
    }
    if (this.ready.size && !this.timer) await this.flush();
  }
  private schedule(ms: number) {
    if (this.timer || !this.ready.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms).unref();
  }
  private async flush() {
    const batch: string[] = [];
    for (const id of this.ready) {
      batch.push(id);
      if (batch.length === 32) break;
    }
    if (!batch.length) return;
    try {
      tryBeginWrite(this.db, Number(this.db.prepare('PRAGMA busy_timeout').get()!.timeout));
      try {
        const del = this.db.prepare('DELETE FROM files WHERE id=? AND owner=?');
        for (const id of batch) del.run(id, this.files.get(id)!.owner);
        this.db.exec('COMMIT');
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (isWriteUnavailable(error)) {
        this.schedule(this.delay);
        this.delay = Math.min(1000, this.delay * 2);
        return;
      }
      // Do not mask a rejected submission or remove a blob without a committed row deletion.
      process.emitWarning(
        'Could not reclaim a provisional input; retained it for normal upload retention.',
        { code: 'OAA_INPUT_CLEANUP' },
      );
      this.adopt(batch);
      this.schedule(1);
      return;
    }
    this.delay = 10;
    this.adopt(batch);
    this.schedule(1);
    await Promise.all(
      batch.map((id) => rm(path.join(this.root, 'files', id), { force: true }).catch(() => {})),
    );
  }
  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.files.clear();
    this.ready.clear();
  }
}
