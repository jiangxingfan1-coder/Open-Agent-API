import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { Fault } from '../core/util.js';
import { isWriteUnavailable } from './checkpoint.js';
import type { Store } from './store.js';
import { UploadWaitBudget } from './upload-budget.js';
import {
  acceptColdTotal,
  coldReadRows,
  discardColdTotal,
  needsColdTotal,
  startColdTotal,
  uploadUsage,
} from './upload-usage.js';
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
  private pending = new Map<string, Promise<void>>();
  private budget = new UploadWaitBudget();
  private jobs = new UploadWaitBudget();
  private stopped = false;
  private localLane: Promise<void> = Promise.resolve();
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
  private async fill(owner: string, subject: string) {
    // Under continuing churn leave the decision to the original, authoritative path.
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = randomUUID();
      try {
        startColdTotal(this.store, owner, subject, id);
        let accepted = false;
        try {
          const used = await this.source!.read({ id, owner, subject });
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
      if (!this.needs(owner, subject)) return;
    }
    // If the optional reader is unavailable, recover the original behavior without
    // dispatching all fallback scans in one turn. A cached total is always rechecked.
    const fill = this.localLane.then(async () => {
      await yieldTurn();
      if (this.stopped) throw stopping();
      uploadUsage(this.store, owner, subject);
    });
    this.localLane = fill.catch(() => {});
    await fill;
  }
  warm(
    owner: string,
    subject: string,
    retainedBytes: number,
    guard?: Guard,
  ): Promise<void> | undefined {
    if (this.stopped) throw stopping();
    if (!this.source) return;
    const key = JSON.stringify([owner, subject]);
    let p = this.pending.get(key);
    if (!p && !this.needs(owner, subject)) return;
    guard?.();
    const release = this.budget.take(owner, retainedBytes);
    try {
      if (!p) {
        // A disconnected subscriber releases its buffer immediately. Its already-started
        // read still occupies a separate job slot until completion.
        const releaseJob = this.jobs.take(owner, 0);
        p = this.fill(owner, subject).finally(() => {
          this.pending.delete(key);
          releaseJob();
        });
        this.pending.set(key, p);
      }
    } catch (e) {
      release();
      throw e;
    }
    const cancelled = Promise.withResolvers<never>();
    const unsubscribe = guard?.onDisconnect?.(() => {
      try {
        guard();
      } catch (error) {
        cancelled.reject(error);
      }
    });
    return (unsubscribe ? Promise.race([p, cancelled.promise]) : p)
      .then(() => {
        if (this.stopped) throw stopping();
        guard?.();
      })
      .finally(() => {
        unsubscribe?.();
        release();
      });
  }
  async close() {
    this.stopped = true;
    await this.source?.close();
    await Promise.allSettled(this.pending.values());
  }
}
