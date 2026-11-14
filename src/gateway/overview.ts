/**
 * Read model support for GET /v1/overview and its change feed.
 *
 * - OverviewRevisions: a per-owner monotonic revision that advances whenever anything the overview
 *   reports may have changed (runs/metrics, catalog, nodes). It starts from a microsecond-scale
 *   clock so revisions keep increasing across gateway restarts and old ETags cannot collide.
 * - RevisionCache: memoizes expensive projections per revision. Inputs that have no change events
 *   (file system, environment, direct configuration edits) are re-checked after a short max-age;
 *   the revision advances only when the recomputed content differs.
 * - OverviewStreams: the `GET /v1/overview/events` SSE feed (ready / coalesced changed / ping).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import type { Principal } from '../core/contracts.js';
import { visibleSubject } from '../core/contracts.js';
import { openEventStream } from './streams.js';
import { Fault, canonical, coarseDelay, sha } from '../core/util.js';

export type OverviewReason = 'runs' | 'catalog' | 'nodes';
const reasonOrder: OverviewReason[] = ['runs', 'catalog', 'nodes'];
type Listener = (reason: OverviewReason) => void;

export class OverviewRevisions {
  private readonly base = Date.now() * 1000;
  /** Broadcast changes (e.g. the public base URL) advance every owner's revision. */
  private epoch = 0;
  private readonly counts = new Map<string, number>();
  /** The same counters split by reason, so a projection can follow only the inputs it reads. */
  private readonly reasonEpoch: Record<OverviewReason, number> = { runs: 0, catalog: 0, nodes: 0 };
  private readonly reasonCounts = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  private closed = false;

  revision(owner: string): number {
    return this.base + this.epoch + (this.counts.get(owner) ?? 0);
  }
  /**
   * Revision of one input family. Run-derived projections (metrics, activity) follow `runs`, so
   * node load and catalog churn neither recompute them nor change their ETags. Never exceeds
   * `revision(owner)`, and shares its restart-safe base.
   */
  revisionOf(owner: string, reason: OverviewReason): number {
    return (
      this.base + this.reasonEpoch[reason] + (this.reasonCounts.get(`${owner}\n${reason}`) ?? 0)
    );
  }
  /** `owner` undefined means the change can affect any owner. */
  bump(owner: string | undefined, reason: OverviewReason): void {
    if (this.closed) return;
    if (owner === undefined) {
      this.epoch++;
      this.reasonEpoch[reason]++;
    } else {
      this.counts.set(owner, (this.counts.get(owner) ?? 0) + 1);
      const key = `${owner}\n${reason}`;
      this.reasonCounts.set(key, (this.reasonCounts.get(key) ?? 0) + 1);
    }
    const targets =
      owner === undefined ? [...this.listeners.values()] : [this.listeners.get(owner)];
    for (const listeners of targets)
      for (const listener of [...(listeners ?? [])])
        try {
          listener(reason);
        } catch {
          // One faulty listener must not starve the others.
        }
  }
  subscribe(owner: string, listener: Listener): () => void {
    let listeners = this.listeners.get(owner);
    if (!listeners) this.listeners.set(owner, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(owner) === listeners) this.listeners.delete(owner);
    };
  }
  listenerCount(owner: string): number {
    return this.listeners.get(owner)?.size ?? 0;
  }
  /** Advance the revision when time alone changes reported state (a cooldown ending). */
  expireAt(owner: string, at: number, reason: OverviewReason): void {
    if (this.closed || !Number.isFinite(at)) return;
    const key = `${owner}\n${reason}`;
    const existing = this.timers.get(key);
    if (existing && existing.at <= at) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        this.bump(owner, reason);
      },
      // Rounded: an unref'd timer re-armed with exact durations leaks a Node timer list each time.
      coarseDelay(at - Date.now() + 5),
    );
    timer.unref();
    this.timers.set(key, { at, timer });
  }
  close(): void {
    this.closed = true;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}

type Entry<T> = { revision: number; computedAt: number; value: T; stable?: string };
export type RevisionCacheOptions<T> = {
  limit?: number;
  /** Re-check untracked inputs after this age; omit for values fully covered by revisions. */
  maxAgeMs?: number;
  /** Stable content fingerprint used when a max-age recheck must decide whether anything changed. */
  stable?: (value: T) => string;
  reason?: OverviewReason;
  /** Key entries on this reason's revision only (the value must depend on nothing else). */
  track?: OverviewReason;
  /** Called after each computation, e.g. to schedule cooldown expiry. */
  observe?: (owner: string, value: T) => void;
};

export class RevisionCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(
    private readonly revisions: OverviewRevisions,
    private readonly options: RevisionCacheOptions<T> = {},
  ) {}
  private current(owner: string): number {
    const track = this.options.track;
    return track ? this.revisions.revisionOf(owner, track) : this.revisions.revision(owner);
  }
  get(owner: string, key: string, compute: () => T): T {
    const now = Date.now();
    const revision = this.current(owner);
    const entry = this.entries.get(key);
    const maxAge = this.options.maxAgeMs;
    if (
      entry &&
      entry.revision === revision &&
      (maxAge === undefined || now - entry.computedAt < maxAge)
    ) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.value;
    }
    const value = compute();
    let current = revision;
    let stable: string | undefined;
    if (entry && entry.revision === revision && this.options.stable) {
      entry.stable ??= this.options.stable(entry.value);
      stable = this.options.stable(value);
      if (stable !== entry.stable) {
        this.revisions.bump(owner, this.options.reason ?? 'nodes');
        current = this.current(owner);
      }
    }
    this.options.observe?.(owner, value);
    this.entries.delete(key);
    this.entries.set(key, { revision: current, computedAt: now, value, stable });
    if (this.entries.size > (this.options.limit ?? 64))
      this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  clear(): void {
    this.entries.clear();
  }
}

/** Cache key of what a principal may see: owner, granted agents and data partition. */
export const overviewViewKey = (principal: Principal) =>
  canonical({
    owner: principal.owner,
    agents: [...new Set(principal.agents)].sort(),
    subject: visibleSubject(principal) ?? '*',
  });

/** Weak ETag: the overview revision plus the caller's identity and the advertised base URL. */
export function overviewEtag(revision: number, principal: Principal, baseUrl: string): string {
  const identity = canonical({
    owner: principal.owner,
    name: principal.name,
    keyId: principal.keyId ?? null,
    scopes: [...principal.scopes].sort(),
    agents: [...principal.agents].sort(),
    baseUrl,
  });
  return `W/"ov.${revision}.${sha(identity).slice(0, 16)}"`;
}

export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return value.split(',').some((tag) => opaque(tag) === target);
}

export type OverviewStreamOptions = {
  perKey: number;
  coalesceMs: number;
  heartbeatMs: number;
  refreshMs: number;
};

export class OverviewStreams {
  private readonly perKey = new Map<string, number>();
  readonly options: OverviewStreamOptions;
  constructor(
    private readonly auth: Auth,
    private readonly revisions: OverviewRevisions,
    options: Partial<OverviewStreamOptions> = {},
  ) {
    this.options = {
      perKey: 4,
      coalesceMs: 250,
      heartbeatMs: 20_000,
      refreshMs: 5_000,
      ...options,
    };
  }
  /**
   * Open the SSE feed. `refresh` re-runs the overview projections for this principal so changes
   * without events are still detected while a console listens without polling.
   */
  open(req: FastifyRequest, reply: FastifyReply, refresh: () => void): void {
    const principal = req.principal;
    const key = principal.keyId ?? `${principal.owner}\n${principal.name}`;
    const open = this.perKey.get(key) ?? 0;
    if (open >= this.options.perKey)
      throw new Fault(
        'too_many_streams',
        `An API key may hold at most ${this.options.perKey} overview event streams.`,
        429,
      );
    const stream = openEventStream(req, reply, this.auth, {}, 256 * 1024, 'sse', {
      heartbeatMs: this.options.heartbeatMs,
      heartbeatFrame: ': ping\n\n',
    });
    this.perKey.set(key, open + 1);
    const owner = principal.owner;
    let pending = new Set<OverviewReason>();
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending.size || stream.closed) return;
      const reasons = reasonOrder.filter((reason) => pending.has(reason));
      pending = new Set();
      stream.write(
        `event: changed\ndata: ${JSON.stringify({ revision: this.revisions.revision(owner), reasons })}\n\n`,
      );
    };
    const unsubscribe = this.revisions.subscribe(owner, (reason) => {
      pending.add(reason);
      timer ??= setTimeout(flush, this.options.coalesceMs);
    });
    const refresher = setInterval(() => {
      try {
        refresh();
      } catch {
        // Refresh is retried on the next tick.
      }
    }, this.options.refreshMs);
    refresher.unref();
    stream.onClose(() => {
      unsubscribe();
      clearTimeout(timer);
      clearInterval(refresher);
      const remaining = (this.perKey.get(key) ?? 1) - 1;
      if (remaining > 0) this.perKey.set(key, remaining);
      else this.perKey.delete(key);
    });
    stream.write(
      `event: ready\ndata: ${JSON.stringify({ revision: this.revisions.revision(owner) })}\n\n`,
    );
  }
  openCount(principal: Principal): number {
    return this.perKey.get(principal.keyId ?? `${principal.owner}\n${principal.name}`) ?? 0;
  }
}
