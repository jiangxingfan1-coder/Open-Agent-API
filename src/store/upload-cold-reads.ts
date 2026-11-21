import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault } from '../core/util.js';
import { isWriteUnavailable } from './checkpoint.js';
import type { Store } from './store.js';
import { UploadWaitBudget } from './upload-budget.js';
import {
  acceptColdTotal,
  changingUploadTotal,
  currentColdTotal,
  coldReadRows,
  discardColdTotal,
  needsColdTotal,
  startColdTotal,
  UploadRecountRequired,
} from './upload-usage.js';
import { UploadRecounts } from './upload-recount.js';
import { databaseIdentity } from './upload-read-worker.js';
import { ReadThread, type ReadSource } from './upload-read-thread.js';
import { transferablePrefix } from './upload-usage-page.js';

type Guard = (() => void) & { onDisconnect?: (notify: () => void) => () => void };
const stopping = () => new Fault('shutting_down', 'File storage is shutting down.', 503);

/** Only HTTP cold preflight uses this helper. The synchronous writer still proves capacity
 * from its own SQLite snapshot before inserting the reservation. */
export class ColdUploadReads {
  private pending = new Map<string, { promise: Promise<void>; waiters: number }>();
  private budget = new UploadWaitBudget();
  private jobs = new UploadWaitBudget();
  private stopped = false;
  private recounts = new UploadRecounts();
  private source?: ReadSource;
  constructor(
    private store: Store,
    source?: ReadSource,
  ) {
    if (source) {
      this.source = source;
      return;
    }
    const file = path.join(store.root, 'state.sqlite');
    let identity: string;
    try {
      identity = databaseIdentity(file);
    } catch {
      return;
    }
    const lease = store.prepare('SELECT lease_id FROM gateway_owner WHERE slot=1').get()?.lease_id;
    if (typeof lease !== 'string') return;
    const reader = new ReadThread({
      file,
      identity,
      lease,
    });
    this.source = reader;
    // Boot the helper, not the totals. This bounded index probe never enumerates callers.
    if (
      store
        .prepare(
          `SELECT 1 FROM main.files INDEXED BY file_owner_subject LIMIT 1 OFFSET ${coldReadRows - 1}`,
        )
        .get()
    )
      reader.prime();
  }
  private needs(owner: string, subject: string) {
    try {
      return needsColdTotal(this.store, owner, subject);
    } catch (error) {
      if (!isWriteUnavailable(error)) throw error;
      return false;
    }
  }
  private async fill(owner: string, subject: string, wanted: () => boolean) {
    const guard = () => {
      if (this.stopped) throw stopping();
      if (!wanted())
        throw new Fault('request_cancelled', 'No caller is waiting for this quota check.', 499);
    };
    // If the reader cannot confirm its snapshot, use the serving connection's paged recount.
    for (let attempt = 0; this.source && attempt < 2; attempt++) {
      const id = randomUUID();
      try {
        startColdTotal(this.store, owner, subject, id);
        let accepted = false;
        try {
          const used = await this.source.read(
            { id, owner, subject },
            () => wanted() && currentColdTotal(this.store, owner, subject, id),
          );
          if (this.stopped) throw stopping();
          if (used === undefined) break;
          if (used !== null && typeof used === 'object') {
            if (!transferablePrefix(used)) break;
            // Keep the original ticket until the serving connection has either verified
            // this prefix or discarded it. A prefix alone can never grant room.
            await this.recounts.fill(this.store, owner, subject, guard, { scan: id, prefix: used });
            return;
          }
          accepted = acceptColdTotal(this.store, owner, subject, id, used);
          if (accepted) return;
        } finally {
          if (!accepted) discardColdTotal(this.store, owner, subject, id);
        }
      } catch (error) {
        if (!isWriteUnavailable(error)) throw error;
        return;
      }
      if (!wanted() || !this.needs(owner, subject)) return;
    }
    await this.recounts.fill(this.store, owner, subject, guard);
  }
  warm(
    owner: string,
    subject: string,
    retainedBytes: number,
    guard?: Guard,
  ): Promise<void> | undefined {
    if (this.stopped) throw stopping();
    const key = JSON.stringify([owner, subject]);
    let flight = this.pending.get(key);
    if (!flight) {
      this.source?.beforeProbe?.(owner, subject);
      if (!this.needs(owner, subject)) return;
    }
    guard?.();
    const release = this.budget.take(owner, retainedBytes);
    try {
      if (!flight) {
        // A disconnected subscriber releases its buffer immediately. Its already-started
        // read still occupies a separate job slot until completion.
        const releaseJob = this.jobs.take(owner, 0);
        const promise = this.fill(owner, subject, () => !!this.pending.get(key)?.waiters).finally(
          () => {
            this.pending.delete(key);
            releaseJob();
          },
        );
        flight = { promise, waiters: 0 };
        this.pending.set(key, flight);
      }
    } catch (e) {
      release();
      throw e;
    }
    const joined = flight;
    joined.waiters++;
    const cancelled = Promise.withResolvers<never>();
    const unsubscribe = guard?.onDisconnect?.(() => {
      try {
        guard();
      } catch (error) {
        cancelled.reject(error);
      }
    });
    return (unsubscribe ? Promise.race([joined.promise, cancelled.promise]) : joined.promise)
      .then(() => {
        if (this.stopped) throw stopping();
        guard?.();
      })
      .finally(() => {
        unsubscribe?.();
        joined.waiters--;
        if (!joined.waiters && this.pending.get(key) === joined)
          this.source?.abandon?.(owner, subject);
        release();
      });
  }
  async close() {
    this.stopped = true;
    await this.source?.close();
    await Promise.allSettled([...this.pending.values()].map((job) => job.promise));
  }
  /** Only before a reservation: repeat a check whose cache entry went stale after preflight. */
  async retry<T>(
    owner: string,
    subject: string,
    retainedBytes: number,
    guard: Guard | undefined,
    check: () => T,
  ): Promise<Awaited<T>> {
    for (let i = 0; i < 2; i++) {
      await this.warm(owner, subject, retainedBytes, guard);
      try {
        return await check();
      } catch (e) {
        if (!(e instanceof UploadRecountRequired)) throw e;
      }
    }
    throw changingUploadTotal();
  }
}
