import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Run } from '../core/contracts.js';
import { canonical, Fault, RetryLaterFault } from '../core/util.js';
import type { Kernel } from '../kernel/kernel.js';
import { RunWriteDeferred, type RunWriteMode } from '../store/write-lock.js';
import type { Auth } from './auth.js';

type Submitter = Pick<Kernel, 'submit'>;
type Attempt = (kernel: Submitter) => Run;
type Waiter = {
  owner: string;
  bytes: number;
  deadline: number;
  attempt: () => Run;
  done: (error: unknown, run?: Run) => void;
};
const MiB = 1024 * 1024;
const busy = () =>
  new RetryLaterFault(
    'admission_busy',
    'Run creation is waiting for the database writer. Retry this request.',
    503,
    1,
  );
const stopping = () => new Fault('shutting_down', 'Gateway is shutting down.', 503);
const disconnected = () =>
  new Fault('request_cancelled', 'Client disconnected before run creation.', 499);

function weight(req: FastifyRequest) {
  const length = Number(req.headers['content-length']);
  // The HTTP parser enforces Content-Length. Reserve the route's full allowance for
  // chunked, compressed or unknown-length bodies without serializing a second copy.
  return !req.headers['content-encoding'] &&
    !req.headers['transfer-encoding'] &&
    Number.isSafeInteger(length) &&
    length >= 0
    ? Math.max(1, length)
    : req.routeOptions.bodyLimit;
}

/** One FIFO and one timer per gateway. Only the pre-BEGIN contention signal is replayable. */
export class HttpRunAdmission {
  private pending = new Set<Waiter>();
  private timer?: NodeJS.Timeout;
  private wakeAt = Infinity;
  private backoff = 10;
  private closed = false;
  private readonly ready: Submitter;
  private readonly queued: Submitter;
  constructor(
    private readonly auth: Auth,
    kernel: Kernel,
  ) {
    const submitter = (mode: RunWriteMode): Submitter => ({
      submit: (p, i, idem, key, trace) => kernel.submit(p, i, idem, key, trace, mode),
    });
    this.ready = submitter('try');
    this.queued = submitter('defer');
  }
  async run(req: FastifyRequest, reply: FastifyReply, create: Attempt): Promise<Run> {
    if (this.closed) throw stopping();
    const gone = () => reply.raw.destroyed || req.raw.aborted || req.raw.socket?.destroyed === true;
    if (gone()) throw disconnected();
    const grants = canonical(req.principal);
    const checkGrant = () => {
      const current = this.auth.revalidate(req.headers.authorization);
      if (canonical(current) !== grants)
        throw new Fault('authorization_changed', 'Caller grants changed before run creation.', 403);
    };
    checkGrant();
    let timeout: number, files: readonly string[];
    try {
      // Existing idempotent runs remain readable even while another request waits for a writer.
      return create(this.pending.size ? this.queued : this.ready);
    } catch (error) {
      if (!(error instanceof RunWriteDeferred)) throw error;
      timeout = Math.min(5000, error.timeoutMs);
      files = error.fileIds;
    }
    const bytes = weight(req),
      owner = req.principal.owner;
    let total = bytes,
      ownerBytes = bytes,
      ownerCount = 1;
    for (const w of this.pending) {
      total += w.bytes;
      if (w.owner === owner) {
        ownerBytes += w.bytes;
        ownerCount++;
      }
    }
    if (
      timeout <= 0 ||
      this.pending.size >= 64 ||
      ownerCount > 8 ||
      total > 64 * MiB ||
      ownerBytes > 32 * MiB
    )
      throw busy();
    const deadline = performance.now() + timeout;
    const inputs = this.auth.store.provisionalInputs;
    const held = inputs.hold(owner, files);
    const result = new Promise<Run>((resolve, reject) => {
      const onClose = () => w.done(disconnected());
      const w: Waiter = {
        owner,
        bytes,
        deadline,
        attempt: () => {
          if (gone()) throw disconnected();
          checkGrant();
          return create(this.ready);
        },
        done: (error, run) => {
          if (!this.pending.delete(w)) return;
          reply.raw.off('close', onClose);
          if (!this.pending.size) {
            clearTimeout(this.timer);
            this.timer = undefined;
            this.backoff = 10;
          }
          if (error) reject(error);
          else resolve(run!);
        },
      };
      this.pending.add(w);
      reply.raw.once('close', onClose);
      this.arm();
    });
    return held.length ? result.finally(() => inputs.release(held)) : result;
  }
  private arm() {
    if (this.closed || !this.pending.size) return;
    let delay = this.backoff;
    const now = performance.now();
    for (const w of this.pending) delay = Math.min(delay, w.deadline - now);
    const at = now + Math.max(1, Math.ceil(delay));
    if (this.timer && this.wakeAt <= at) return;
    clearTimeout(this.timer);
    this.wakeAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.pump();
      },
      Math.max(1, Math.ceil(delay)),
    );
  }
  private pump() {
    const until = performance.now() + 4;
    for (const w of this.pending) if (w.deadline <= performance.now()) w.done(busy());
    for (const w of this.pending) {
      try {
        if (w.deadline <= performance.now()) {
          w.done(busy());
          continue;
        }
        w.done(null, w.attempt());
        this.backoff = 1;
      } catch (error) {
        if (error instanceof RunWriteDeferred) {
          this.backoff = Math.min(100, Math.max(10, this.backoff * 2));
          break;
        }
        w.done(error);
      }
      if (performance.now() >= until) break;
    }
    if (!this.pending.size) this.backoff = 10;
    this.arm();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const w of this.pending) w.done(stopping());
  }
}
