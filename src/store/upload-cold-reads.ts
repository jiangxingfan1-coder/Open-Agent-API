import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Fault } from '../core/util.js';
import { isWriteUnavailable } from './checkpoint.js';
import type { Store } from './store.js';
import { UploadWaitBudget } from './upload-budget.js';
import {
  acceptColdTotal,
  changingUploadTotal,
  coldReadRows,
  discardColdTotal,
  needsColdTotal,
  startColdTotal,
  UploadRecountRequired,
} from './upload-usage.js';
import { UploadRecounts } from './upload-recount.js';
import {
  databaseIdentity,
  type ReadBinding,
  type ReadRequest,
  type ReadResult,
} from './upload-read-worker.js';

type Total = number | null | undefined;
type Source = { read(request: ReadRequest): Promise<Total>; close(): Promise<void> };
type Guard = (() => void) & { onDisconnect?: (notify: () => void) => () => void };
const stopping = () => new Fault('shutting_down', 'File storage is shutting down.', 503);

class ReadThread implements Source {
  private thread?: Worker;
  private calls = new Map<string, (value: Total | Error) => void>();
  private idle?: NodeJS.Timeout;
  private retiring?: Promise<void>;
  private retryAt = 0;
  private timedOut = false;
  private stopped = false;
  constructor(private binding: ReadBinding) {}
  private retire(w: Worker, failure?: Error) {
    if (this.thread !== w) return;
    this.thread = undefined;
    clearTimeout(this.idle);
    for (const finish of this.calls.values()) finish(failure);
    this.retiring = w
      .terminate()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.retiring = undefined;
        this.timedOut = false;
      });
  }
  private armIdle(w: Worker) {
    clearTimeout(this.idle);
    w.unref();
    this.idle = setTimeout(() => this.retire(w), 30000).unref();
  }
  prime() {
    if (this.stopped || this.retiring || performance.now() < this.retryAt) return;
    if (!this.thread) {
      let w: Worker;
      try {
        w = new Worker(new URL('./upload-read-worker.js', import.meta.url), {
          workerData: { role: 'oaa.upload-usage', binding: this.binding },
          execArgv: [],
        });
      } catch {
        this.retryAt = performance.now() + 30000;
        return;
      }
      this.thread = w;
      w.on('message', (m: ReadResult) => {
        if (this.thread !== w) return;
        const finish = this.calls.get(m.id);
        if (!finish) return;
        finish(m.used);
        if (!this.calls.size) this.armIdle(w);
      });
      const failed = () => {
        if (this.thread === w) {
          this.retryAt = performance.now() + 30000;
          this.retire(w);
        }
      };
      w.on('error', failed);
      w.on('exit', failed);
      this.armIdle(w);
    }
  }
  async read(request: ReadRequest): Promise<Total> {
    if (this.stopped) throw stopping();
    if (this.timedOut && this.retiring) return undefined;
    if (this.retiring) await this.retiring;
    if (this.stopped) throw stopping();
    this.prime();
    const w = this.thread;
    if (!w) return undefined;
    clearTimeout(this.idle);
    w.ref();
    return new Promise<Total>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timedOut = true;
        this.retryAt = performance.now() + 30000;
        this.retire(w);
      }, 5000).unref();
      this.calls.set(request.id, (value) => {
        clearTimeout(timer);
        this.calls.delete(request.id);
        if (value instanceof Error) reject(value);
        else resolve(value);
      });
      try {
        w.postMessage(request);
      } catch {
        this.retire(w);
      }
    });
  }
  async close() {
    this.stopped = true;
    if (this.thread) this.retire(this.thread, stopping());
    await this.retiring;
  }
}

/** Only HTTP cold preflight uses this helper. The synchronous writer still proves capacity
 * from its own SQLite snapshot before inserting the reservation. */
export class ColdUploadReads {
  private pending = new Map<string, { promise: Promise<void>; waiters: number }>();
  private budget = new UploadWaitBudget();
  private jobs = new UploadWaitBudget();
  private stopped = false;
  private recounts = new UploadRecounts();
  private source?: Source;
  constructor(
    private store: Store,
    source?: Source,
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
    // If the reader cannot confirm its snapshot, use the serving connection's paged recount.
    for (let attempt = 0; this.source && attempt < 2; attempt++) {
      const id = randomUUID();
      try {
        startColdTotal(this.store, owner, subject, id);
        let accepted = false;
        try {
          const used = await this.source.read({ id, owner, subject });
          if (this.stopped) throw stopping();
          if (used === undefined) break;
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
    await this.recounts.fill(this.store, owner, subject, () => {
      if (this.stopped) throw stopping();
      if (!wanted())
        throw new Fault('request_cancelled', 'No caller is waiting for this quota check.', 499);
    });
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
    if (!flight && !this.needs(owner, subject)) return;
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
