/**
 * Webhook dispatcher (docs/webhooks.md).
 *
 * - Enqueue: a listener on the store's committed `summary` notifications. It runs after the run's
 *   status is on disk, does nothing unless the owner has a matching endpoint (endpoint list cached in
 *   memory), and otherwise writes one small row per endpoint. Bodies are built at the first attempt.
 * - Send: in the background, one in-flight delivery per endpoint (oldest first, so order is kept),
 *   endpoints independent of each other. Timers are unref'd and cleared on stop; a delivery that is
 *   in flight at shutdown is aborted and stays queued (at-least-once).
 */
import http from 'node:http';
import https from 'node:https';
import { checkedLookup } from './checked-lookup.js';
import type { Store } from '../store/store.js';
import { coarseDelay, faultOf, id } from '../core/util.js';
import { GATEWAY_VERSION } from './endpoints.js';
import {
  STATUS_EVENTS,
  TEST_EVENT,
  checkTarget,
  pendingTitle,
  retryDelay,
  runData,
  signature,
  wants,
  webhookTiming,
  type TargetPolicy,
} from './webhook-core.js';
import { WebhookDb, type Delivery, type WebhookEndpoint } from './webhook-db.js';

type Summary = { owner: string; runId: string; agentId: string; status: string };

export class WebhookDispatcher {
  readonly db: WebhookDb;
  private cache = new Map<string, WebhookEndpoint[]>();
  private inflight = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private timerAt = Infinity;
  private running = false;
  private readonly onSummary = (s: Summary) => this.observe(s);

  constructor(
    private readonly store: Store,
    private readonly profile: 'local' | 'public',
  ) {
    this.db = new WebhookDb(store.db);
    // Observing starts at once and lasts until the store closes, so runs interrupted while the
    // kernel shuts down are still queued; sending only happens between start() and halt().
    store.events.on('summary', this.onSummary);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.catchUpInterrupted();
    this.kick();
  }
  /**
   * The kernel marks unfinished runs `interrupted` while it is constructed, before this dispatcher
   * exists. Queue `run.interrupted` for runs interrupted since this process started (and after the
   * endpoint was created); the dedupe key makes a repeat harmless.
   */
  private catchUpInterrupted(): void {
    const since = Date.now() - process.uptime() * 1000;
    const rows = this.store.db
      .prepare(
        "SELECT r.id,r.owner,r.agent_id,s.payload FROM runs r JOIN run_summaries s ON s.run_id=r.id WHERE r.status='interrupted'",
      )
      .all();
    for (const row of rows) {
      const updated = Number(
        (JSON.parse(String(row.payload)) as { updated_at?: number }).updated_at,
      );
      if (!(updated >= since)) continue;
      this.observe(
        {
          owner: String(row.owner),
          runId: String(row.id),
          agentId: String(row.agent_id),
          status: 'interrupted',
        },
        updated,
      );
    }
  }
  /** Stop sending (shutdown); events are still queued until `detach`. */
  halt(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }
  /** Stop observing (right before the store closes). */
  detach(): void {
    this.halt();
    this.store.events.off('summary', this.onSummary);
  }
  /** Endpoint configuration changed: drop the cache and look at the queue again. */
  changed(owner: string): void {
    this.cache.delete(owner);
    this.kick();
  }
  /** Abort the in-flight delivery of a deleted endpoint. */
  forget(endpointId: string): void {
    this.inflight.get(endpointId)?.abort();
  }

  private endpointsOf(owner: string): WebhookEndpoint[] {
    let list = this.cache.get(owner);
    if (!list) this.cache.set(owner, (list = this.db.endpoints(owner)));
    return list;
  }

  /** Store observer: must stay cheap and must never throw into the store. */
  private observe(s: Summary, happenedAt?: number): void {
    try {
      const type = STATUS_EVENTS[s.status as keyof typeof STATUS_EVENTS];
      if (!type) return;
      const targets = this.endpointsOf(s.owner).filter(
        (e) =>
          wants(e, type, s.agentId) && (happenedAt === undefined || e.created_at <= happenedAt),
      );
      if (!targets.length) return;
      let seed: Record<string, unknown> = { run_id: s.runId, status: s.status };
      let dedupe = `${s.runId}:${type}`;
      if (type === 'run.requires_action') {
        const pending = this.store
          .approvals(s.runId)
          .filter((a) => a.status === 'pending')
          .map((a) => a.id);
        const fresh = this.db.announce(s.runId, pending);
        if (!fresh.length) return;
        seed = { ...seed, approval_ids: pending };
        dedupe = `${s.runId}:${type}:${fresh.sort().join(',')}`;
      }
      const eventId = id('evt');
      const created = Date.now();
      for (const e of targets)
        this.db.enqueue({
          endpointId: e.id,
          owner: s.owner,
          eventId,
          eventType: type,
          runId: s.runId,
          dedupe,
          seed: { ...seed, created_at: created },
        });
      this.kick();
    } catch (error) {
      process.emitWarning(`Webhook enqueue failed: ${faultOf(error).message}`, {
        code: 'OAA_WEBHOOK_ENQUEUE',
      });
    }
  }

  /** Queue a `webhook.test` event for one endpoint. */
  test(endpoint: WebhookEndpoint): Delivery {
    const d = this.db.enqueue({
      endpointId: endpoint.id,
      owner: endpoint.owner,
      eventId: id('evt'),
      eventType: TEST_EVENT,
      runId: null,
      dedupe: null,
      seed: { created_at: Date.now() },
    })!;
    this.kick();
    return d;
  }

  /** Re-scan the queue soon (coalesced). */
  kick(): void {
    if (this.running) this.arm(Date.now());
  }
  private arm(at: number): void {
    if (!this.running || at >= this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.timerAt = Infinity;
        this.pump();
      },
      // Rounded: an unref'd timer re-armed with exact durations leaks a Node timer list each time.
      coarseDelay(at - Date.now()),
    );
    this.timer.unref();
  }
  private pump(): void {
    if (!this.running) return;
    const now = Date.now();
    let next = Infinity;
    for (const head of this.db.heads()) {
      if (this.inflight.has(head.endpoint_id)) continue;
      const endpoint = this.endpointsOf(head.owner).find((e) => e.id === head.endpoint_id);
      if (!endpoint?.enabled) continue;
      if (head.next_at > now) {
        next = Math.min(next, head.next_at);
        continue;
      }
      void this.send(endpoint, head);
    }
    if (next < Infinity) this.arm(next);
  }

  private body(endpoint: WebhookEndpoint, d: Delivery): string {
    if (d.body) return d.body;
    const created = Math.floor(Number(d.seed.created_at ?? d.created_at) / 1000);
    let data: Record<string, unknown>;
    if (d.event_type === TEST_EVENT) {
      data = {
        object: 'webhook_test',
        endpoint_id: endpoint.id,
        message: 'Test event from Open Agent API.',
      };
    } else {
      const run = this.store.run(String(d.seed.run_id));
      const ids = (d.seed.approval_ids as string[] | undefined) ?? undefined;
      const pending = ids
        ? this.store
            .approvals(run.id)
            .filter((a) => ids.includes(a.id))
            .map((a) => ({
              id: a.id,
              type: a.kind,
              title: pendingTitle(a.detail),
              status: a.status,
              expires_at: Math.floor(a.expiresAt / 1000),
            }))
        : undefined;
      data = runData(
        {
          ...run,
          keyId: run.checkpoint.keyId,
          output: run.output.map((m) => m.text).join('\n'),
        },
        String(d.seed.status),
        { ...(pending ? { pending } : {}), includeOutput: endpoint.include_output },
      );
    }
    const body = JSON.stringify({ id: d.event_id, type: d.event_type, created_at: created, data });
    this.db.setBody(d.id, body);
    return body;
  }

  private async send(endpoint: WebhookEndpoint, d: Delivery): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(endpoint.id, controller);
    const started = Date.now();
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const secret = this.db.secret(endpoint.id);
      if (secret === undefined) return;
      const body = this.body(endpoint, d);
      const policy: TargetPolicy = {
        profile: this.profile,
        allowInsecureHttp: endpoint.allow_insecure_http,
        allowPrivateNetwork: endpoint.allow_private_network,
      };
      httpStatus = await post(endpoint.url, body, {
        headers: {
          'content-type': 'application/json',
          'user-agent': `OpenAgentAPI/${GATEWAY_VERSION}`,
          'x-oaa-event': d.event_type,
          'x-oaa-delivery': d.id,
          'x-oaa-signature': signature(secret, Math.floor(Date.now() / 1000), body),
        },
        policy,
        signal: controller.signal,
      });
      if (httpStatus < 200 || httpStatus >= 300) error = `HTTP ${httpStatus}`;
    } catch (e) {
      error = faultOf(e).message.slice(0, 500);
    } finally {
      if (this.inflight.get(endpoint.id) === controller) this.inflight.delete(endpoint.id);
    }
    // Aborted by shutdown or deletion: leave the delivery queued, record nothing.
    if (controller.signal.aborted || !this.running) return;
    if (!this.db.secret(endpoint.id)) return;
    const ok = error === null;
    const delay = ok ? undefined : retryDelay(d.attempts + 1);
    this.db.finishAttempt(d, {
      status: ok ? 'succeeded' : delay === undefined ? 'failed' : 'pending',
      nextAt: Date.now() + (delay ?? 0),
      httpStatus,
      error,
      durationMs: Date.now() - started,
    });
    this.cache.delete(endpoint.owner);
    this.kick();
  }
}

/**
 * POST without following redirects. The host is resolved once and every resolved address is checked
 * against the target policy inside the connection's own lookup, so the address that is checked is
 * the address that is connected to (no second resolution an attacker could rebind).
 */
function post(
  target: string,
  body: string,
  o: { headers: Record<string, string>; policy: TargetPolicy; signal: AbortSignal },
): Promise<number> {
  const url = new URL(target);
  const lookup = checkedLookup(o.policy);
  checkTarget(url.hostname, o.policy);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...o.headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup,
        signal: o.signal,
        agent: false,
      },
      (res) => {
        // Drain a little of the answer and ignore it; the status code is what counts.
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > 64 * 1024) res.destroy();
        });
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('close', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(res.statusCode ?? 0));
      },
    );
    // Whole-request deadline (connect, send and the answer's headers and body).
    const deadline = setTimeout(
      () => req.destroy(new Error(`Timed out after ${webhookTiming.timeoutMs} ms.`)),
      webhookTiming.timeoutMs,
    );
    deadline.unref();
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(body);
  });
}
