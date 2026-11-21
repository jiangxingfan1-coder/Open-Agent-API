import { Worker } from 'node:worker_threads';
import { Fault, RetryLaterFault } from '../core/util.js';
import {
  readerProtocol,
  type ReadBinding,
  type ReadMessage,
  type ReadRequest,
  type ReadResult,
} from './upload-read-worker.js';
import { transferablePrefix, type UsagePrefix } from './upload-usage-page.js';

export type ReadOutcome = number | null | undefined | UsagePrefix;
export type ReadSource = {
  read(request: ReadRequest, current?: () => boolean): Promise<ReadOutcome>;
  beforeProbe?(owner: string, subject: string): void;
  abandon?(owner: string, subject: string): void;
  close(): Promise<void>;
};
const inactiveMs = 5000,
  absoluteMs = 15000,
  releaseMs = 400,
  retireMs = 400;
const stopping = () => new Fault('shutting_down', 'File storage is shutting down.', 503);
const busy = () =>
  new RetryLaterFault(
    'upload_busy',
    'The previous quota reader has not released file storage.',
    503,
    1,
  );

type Call = {
  abandonOnReady?: boolean;
  request: ReadRequest;
  current?: () => boolean;
  rows: number;
  last: number;
  deadline: number;
  cancelling: boolean;
  timer?: NodeJS.Timeout;
  finish: (value: ReadOutcome | Error) => void;
};
type Generation = {
  cooperative: boolean;
  worker: Worker;
  exited: Promise<void>;
  calls: Map<string, Call>;
  idle?: NodeJS.Timeout;
};

/** A local recount may begin only after a final result, a per-request release, or the
 * old thread's actual exit. Calling terminate() alone is not evidence of quiescence. */
export class ReadThread implements ReadSource {
  private live?: Generation;
  private retiring?: {
    exited: Promise<void>;
    ready: Promise<boolean>;
    held: Set<string>;
    blocked: boolean;
  };
  private retryAt = 0;
  private stopped = false;
  constructor(private binding: ReadBinding) {}
  private idle(g: Generation) {
    clearTimeout(g.idle);
    g.worker.unref();
    g.idle = setTimeout(() => this.retire(g, false), 30000).unref();
  }
  private retire(g: Generation, cooldown: boolean) {
    if (this.live !== g) return;
    this.live = undefined;
    clearTimeout(g.idle);
    if (cooldown) this.retryAt = performance.now() + 30000;
    const calls = [...g.calls.values()];
    const ready = Promise.withResolvers<boolean>(),
      retiring = {
        exited: g.exited,
        ready: ready.promise,
        held: new Set(calls.map((c) => JSON.stringify([c.request.owner, c.request.subject]))),
        blocked: false,
      };
    this.retiring = retiring;
    const grace = setTimeout(() => {
      retiring.blocked = true;
      ready.resolve(false);
    }, retireMs).unref();
    void g.exited.then(() => {
      clearTimeout(grace);
      if (this.retiring === retiring) this.retiring = undefined;
      ready.resolve(true);
    });
    g.calls.clear();
    for (const c of calls) clearTimeout(c.timer);
    void g.worker.terminate().catch(() => {}); // Only the exit event above releases ownership.
    void ready.promise.then((clear) => {
      for (const c of calls.splice(0))
        c.finish(this.stopped ? stopping() : clear ? undefined : busy());
    });
  }
  private message(g: Generation, m: ReadMessage | ReadResult | { ready: number }) {
    if (this.live !== g || !m || typeof m !== 'object') return;
    if ('ready' in m) {
      if (m.ready === readerProtocol && !g.cooperative) {
        g.cooperative = true;
        for (const c of g.calls.values()) if (c.abandonOnReady) this.release(g, c, inactiveMs);
      }
      return;
    }
    const c = g.calls.get(m.id);
    if (!c) return;
    if ('kind' in m) {
      if (!g.cooperative) return;
    } else {
      if (g.cooperative || !Object.keys(m).every((k) => k === 'id' || k === 'used')) return;
      m = { id: m.id, kind: 'done', used: m.used }; // A legacy helper sends only terminal replies.
    }
    if (m.kind === 'progress') {
      if (!c.cancelling && Number.isSafeInteger(m.rows) && m.rows > c.rows) {
        if (c.current) {
          let valid = false;
          try {
            valid = c.current();
          } catch {
            /* An unreadable ticket cannot validate a prefix. */
          }
          if (!valid) {
            this.release(g, c, inactiveMs);
            return;
          }
        }
        c.rows = m.rows;
        c.last = performance.now();
      }
      return;
    }
    let value: ReadOutcome;
    if (m.kind === 'released') {
      if (!c.cancelling) return;
      if (transferablePrefix(m.prefix) && m.prefix.rows >= c.rows) value = m.prefix;
    } else if (m.kind === 'done') {
      if (
        m.used === null ||
        (typeof m.used === 'number' && Number.isSafeInteger(m.used) && m.used >= 0)
      )
        value = m.used;
    } else return;
    g.calls.delete(m.id);
    clearTimeout(c.timer);
    c.finish(value);
    if (!g.calls.size) this.idle(g);
  }
  prime() {
    if (this.live || this.stopped || this.retiring || performance.now() < this.retryAt) return;
    let w: Worker;
    try {
      w = new Worker(new URL('./upload-read-worker.js', import.meta.url), {
        workerData: { role: 'oaa.upload-usage', protocol: readerProtocol, binding: this.binding },
        execArgv: [],
      });
    } catch {
      this.retryAt = performance.now() + 30000;
      return;
    }
    const exit = Promise.withResolvers<void>(),
      g: Generation = { worker: w, exited: exit.promise, calls: new Map(), cooperative: false };
    this.live = g;
    w.on('message', (m: ReadMessage) => this.message(g, m));
    w.on('error', () => this.retire(g, true));
    w.once('exit', () => {
      exit.resolve();
      this.retire(g, true);
    });
    this.idle(g);
  }
  private release(g: Generation, c: Call, grace: number) {
    if (c.cancelling) return;
    if (!g.cooperative) {
      this.retire(g, true);
      return;
    }
    c.cancelling = true;
    clearTimeout(c.timer);
    c.timer = setTimeout(
      () => this.retire(g, true),
      Math.min(grace, Math.max(0, c.deadline - performance.now()) + releaseMs),
    ).unref();
    try {
      g.worker.postMessage({ cancel: c.request.id });
    } catch {
      this.retire(g, true);
    }
  }
  abandon(owner: string, subject: string) {
    const g = this.live;
    if (!g) return;
    for (const c of g.calls.values())
      if (c.request.owner === owner && c.request.subject === subject) {
        if (g.cooperative) this.release(g, c, inactiveMs);
        else c.abandonOnReady = true;
      }
  }
  beforeProbe(owner: string, subject: string) {
    if (this.retiring?.blocked && this.retiring.held.has(JSON.stringify([owner, subject])))
      throw busy();
  }
  async read(req: ReadRequest, current?: () => boolean): Promise<ReadOutcome> {
    if (this.stopped) throw stopping();
    while (this.retiring) {
      if (!this.retiring.held.has(JSON.stringify([req.owner, req.subject]))) return undefined;
      if (!(await this.retiring.ready)) throw this.stopped ? stopping() : busy();
    }
    if (this.stopped) throw stopping();
    this.prime();
    const g = this.live;
    if (!g) return undefined;
    clearTimeout(g.idle);
    g.worker.ref();
    const p = Promise.withResolvers<ReadOutcome>(),
      now = performance.now();
    const c: Call = {
      request: req,
      current,
      rows: 0,
      last: now,
      deadline: now + absoluteMs,
      cancelling: false,
      finish: (value) => (value instanceof Error ? p.reject(value) : p.resolve(value)),
    };
    const check = () => {
      if (this.live !== g || g.calls.get(req.id) !== c) return;
      const left = Math.min(c.deadline, c.last + inactiveMs) - performance.now();
      if (left > 0) {
        c.timer = setTimeout(check, Math.ceil(left)).unref();
        return;
      }
      this.release(g, c, releaseMs);
    };
    g.calls.set(req.id, c);
    c.timer = setTimeout(check, inactiveMs).unref();
    try {
      g.worker.postMessage(req);
    } catch {
      this.retire(g, true);
    }
    return p.promise;
  }
  async close() {
    this.stopped = true;
    if (this.live) this.retire(this.live, false);
    await this.retiring?.exited;
  }
}
