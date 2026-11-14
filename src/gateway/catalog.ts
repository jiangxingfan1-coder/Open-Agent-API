import type { Principal } from '../core/contracts.js';
import { Fault, canonical, id, sha } from '../core/util.js';

export type CatalogEntry = { agent: string; version: string; state: unknown };
export type CatalogChange = {
  cursor: string;
  agent: string;
  version: string | null;
  reason: 'published' | 'runtime' | 'removed';
};
type View = {
  principal: Principal;
  epoch: string;
  sequence: number;
  entries: Map<string, { version: string; hash?: string }>;
  history: CatalogChange[];
  listeners: Set<() => void>;
  usedAt: number;
  observedRuntime: boolean;
  error?: unknown;
};

// This is a bounded invalidation journal, not the authoritative publication/audit store.
export class Catalog {
  private views = new Map<string, View>();
  private active = new Map<string, number>();
  private pending: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout;
  private closed = false;
  constructor(
    private snapshot: (principal: Principal) => CatalogEntry[],
    private limits = { history: 256, views: 64, subscriptionsPerOwner: 64, pollMs: 1000 },
  ) {
    this.poll = setInterval(() => {
      for (const view of this.views.values()) {
        if (view.listeners.size) this.refresh(view);
      }
    }, limits.pollMs);
    this.poll.unref();
  }
  invalidate = (): void => {
    if (this.closed || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      for (const view of this.views.values())
        if (view.observedRuntime || view.listeners.size) this.refresh(view);
    }, 50);
    this.pending.unref();
  };
  private notify(view: View): void {
    for (const listener of [...view.listeners]) listener();
  }
  private token(view: View, sequence = view.sequence): string {
    return `${view.epoch}.${sequence}`;
  }
  private refresh(view: View, entries?: CatalogEntry[]): void {
    let next: View['entries'];
    try {
      next = new Map(
        (entries ?? this.snapshot(view.principal)).map((entry) => [
          entry.agent,
          { version: entry.version, hash: sha(canonical(entry)) },
        ]),
      );
      view.error = undefined;
      view.observedRuntime = true;
    } catch (error) {
      view.error = error;
      this.notify(view);
      return;
    }
    const changes: Omit<CatalogChange, 'cursor'>[] = [];
    for (const [agent, entry] of next) {
      const prior = view.entries.get(agent);
      if (
        !prior ||
        prior.version !== entry.version ||
        (prior.hash !== undefined && prior.hash !== entry.hash)
      )
        changes.push({
          agent,
          version: entry.version,
          reason: prior?.version === entry.version ? 'runtime' : 'published',
        });
    }
    for (const agent of view.entries.keys())
      if (!next.has(agent)) changes.push({ agent, version: null, reason: 'removed' });
    view.entries = next;
    for (const change of changes) {
      view.sequence++;
      view.history.push({ ...change, cursor: this.token(view) });
    }
    if (view.history.length > this.limits.history)
      view.history.splice(0, view.history.length - this.limits.history);
    if (changes.length) this.notify(view);
  }
  private acquire(principal: Principal, versions: { id: string; digest: string }[] = []): View {
    if (this.closed) throw new Fault('shutting_down', 'Catalog is shutting down.', 503);
    const key = canonical({
      owner: principal.owner,
      agents: [...new Set(principal.agents)].sort(),
    });
    let view = this.views.get(key);
    if (!view) {
      if (this.views.size >= this.limits.views) {
        const idle = [...this.views]
          .filter(([, v]) => !v.listeners.size)
          .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!idle) throw new Fault('catalog_capacity', 'Too many active catalog views.', 429);
        this.views.delete(idle[0]);
      }
      view = {
        principal: structuredClone(principal),
        epoch: id('catalog'),
        sequence: 0,
        entries: new Map(versions.map((entry) => [entry.id, { version: entry.digest }])),
        history: [],
        listeners: new Set(),
        usedAt: Date.now(),
        observedRuntime: false,
      };
      this.views.set(key, view);
    }
    view.usedAt = Date.now();
    return view;
  }
  private view(principal: Principal, entries?: CatalogEntry[]): View {
    const view = this.acquire(principal);
    this.refresh(view, entries);
    if (view.error) throw view.error;
    return view;
  }
  cursor(principal: Principal, entries?: CatalogEntry[]): string {
    return this.token(this.view(principal, entries));
  }
  publicationCursor(principal: Principal, versions: { id: string; digest: string }[]): string {
    // Summary discovery observes publications, not execution readiness. Runtime observation
    // starts when a subscription refreshes this view; an existing cursor is never advanced here.
    return this.token(this.acquire(principal, versions));
  }
  page(principal: Principal, cursor?: string, limit = 32) {
    return this.read(this.view(principal), cursor, limit);
  }
  private read(view: View, cursor?: string, limit = 32) {
    if (this.closed) throw new Fault('shutting_down', 'Catalog is shutting down.', 503);
    if (view.error) throw view.error;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new Fault('invalid_catalog_limit', 'Catalog limit must be 1-32.');
    const parsed = cursor?.match(/^(catalog_[a-f0-9]{32})\.([0-9]{1,16})$/);
    if (cursor !== undefined && (!parsed || !Number.isSafeInteger(Number(parsed[2]))))
      throw new Fault('invalid_catalog_cursor', 'Use a catalog cursor returned by this gateway.');
    const sequence = Number(parsed?.[2] ?? 0);
    if (parsed?.[1] === view.epoch && sequence > view.sequence)
      throw new Fault('invalid_catalog_cursor', 'Catalog cursor is ahead of the current view.');
    const reset =
      !parsed || parsed[1] !== view.epoch || sequence < view.sequence - view.history.length;
    const data = reset
      ? []
      : view.history
          .slice(
            Math.max(0, sequence - (view.sequence - view.history.length)),
            sequence - (view.sequence - view.history.length) + limit,
          )
          .map((change) => ({ ...change }));
    const next = data.at(-1)?.cursor ?? this.token(view);
    return {
      cursor: next,
      reset,
      data,
      has_more: !reset && sequence + data.length < view.sequence,
      timed_out: false,
    };
  }
  subscribe(principal: Principal, listener: () => void) {
    const view = this.view(principal);
    const count = this.active.get(principal.owner) ?? 0;
    if (count >= this.limits.subscriptionsPerOwner)
      throw new Fault('catalog_capacity', 'Too many catalog subscriptions for this owner.', 429);
    let removed = false;
    const off = () => {
      if (removed) return;
      removed = true;
      view.listeners.delete(notify);
      view.usedAt = Date.now();
      const remaining = (this.active.get(principal.owner) ?? 1) - 1;
      if (remaining) this.active.set(principal.owner, remaining);
      else this.active.delete(principal.owner);
    };
    const notify = () => {
      try {
        listener();
      } catch {
        off();
        process.emitWarning('Detached a failing catalog subscriber.', {
          code: 'OAA_CATALOG_OBSERVER_FAILED',
        });
      }
    };
    view.listeners.add(notify);
    this.active.set(principal.owner, count + 1);
    return {
      close: off,
      read: (cursor?: string, limit = 32) => {
        if (removed) throw new Fault('catalog_closed', 'Catalog subscription is closed.', 409);
        return this.read(view, cursor, limit);
      },
    };
  }
  async wait(
    principal: Principal,
    cursor: string | undefined,
    limit: number,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    const first = this.page(principal, cursor, limit);
    if (first.reset || first.data.length || timeoutMs === 0) return first;
    return new Promise<typeof first>((resolve, reject) => {
      let done = false;
      let off = () => {};
      let read = () => first;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: unknown, result?: typeof first) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const check = (timeout = false) => {
        try {
          const result = timeout ? this.page(principal, cursor, limit) : read();
          if (result.reset || result.data.length || timeout)
            finish(undefined, {
              ...result,
              timed_out: timeout && !result.reset && !result.data.length,
            });
        } catch (error) {
          finish(error);
        }
      };
      const abort = () =>
        finish(signal.reason ?? new Fault('wait_cancelled', 'Catalog wait cancelled.', 499));
      try {
        const subscription = this.subscribe(principal, () => check());
        off = subscription.close;
        read = () => subscription.read(cursor, limit);
      } catch (error) {
        finish(error);
        return;
      }
      timer = setTimeout(() => check(true), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    clearTimeout(this.pending);
    for (const view of this.views.values()) this.notify(view);
    this.views.clear();
    this.active.clear();
  }
}
