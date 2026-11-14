/**
 * Webhook tables (`webhook_*`): endpoints, the durable delivery queue and the approvals already
 * announced through `run.requires_action`. Statements are compiled once per connection
 * (`prepared`, as for the platform tables).
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Fault, id } from '../core/util.js';
import { prepared, transaction } from './platform-db.js';

export type WebhookEndpoint = {
  id: string;
  owner: string;
  url: string;
  events: string[];
  agents: string[];
  include_output: boolean;
  enabled: boolean;
  description: string;
  allow_insecure_http: boolean;
  allow_private_network: boolean;
  created_at: number;
  updated_at: number;
  consecutive_failures: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
};

export type DeliveryStatus = 'pending' | 'succeeded' | 'failed';
export type Delivery = {
  seq: number;
  id: string;
  endpoint_id: string;
  owner: string;
  event_id: string;
  event_type: string;
  run_id: string | null;
  status: DeliveryStatus;
  attempts: number;
  next_at: number;
  /** What the body is built from at the first attempt (run id, status, approval ids…). */
  seed: Record<string, unknown>;
  /** Exact JSON body, fixed at the first attempt so every retry sends the same bytes. */
  body: string | null;
  last_status: number | null;
  last_error: string | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
};

/** Endpoints per owner, and finished deliveries kept per endpoint. */
export const MAX_ENDPOINTS = 20;
export const KEEP_DELIVERIES = 200;
/**
 * Queued deliveries per endpoint. An endpoint that keeps failing holds its serial queue for up to
 * ~42 minutes per delivery while new events keep arriving, so without a cap the queue (and the
 * database) grew without bound; above it the oldest queued deliveries after the head are marked
 * `failed` with `queue_overflow` and then trimmed like any finished delivery.
 */
export const MAX_PENDING_DELIVERIES = 10_000;

export function ensureWebhookTables(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS webhook_endpoints(id TEXT PRIMARY KEY,owner TEXT NOT NULL,secret TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints(owner);
CREATE TABLE IF NOT EXISTS webhook_deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,endpoint_id TEXT NOT NULL,owner TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,run_id TEXT,dedupe TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,seed TEXT NOT NULL,body TEXT,last_status INTEGER,last_error TEXT,duration_ms INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(endpoint_id,dedupe));
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries(status,endpoint_id,seq);
CREATE TABLE IF NOT EXISTS webhook_announced(run_id TEXT NOT NULL,approval_id TEXT NOT NULL,PRIMARY KEY(run_id,approval_id));`);
}

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

const endpointOf = (row: Record<string, unknown>): WebhookEndpoint => ({
  ...(JSON.parse(row.payload as string) as WebhookEndpoint),
  id: row.id as string,
  owner: row.owner as string,
});

const deliveryOf = (row: Record<string, unknown>): Delivery => ({
  seq: Number(row.seq),
  id: row.id as string,
  endpoint_id: row.endpoint_id as string,
  owner: row.owner as string,
  event_id: row.event_id as string,
  event_type: row.event_type as string,
  run_id: (row.run_id as string | null) ?? null,
  status: row.status as DeliveryStatus,
  attempts: Number(row.attempts),
  next_at: Number(row.next_at),
  seed: JSON.parse(row.seed as string) as Record<string, unknown>,
  body: (row.body as string | null) ?? null,
  last_status: row.last_status === null ? null : Number(row.last_status),
  last_error: (row.last_error as string | null) ?? null,
  duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
  created_at: Number(row.created_at),
  updated_at: Number(row.updated_at),
});

export class WebhookDb {
  constructor(readonly db: DatabaseSync) {
    ensureWebhookTables(db);
  }
  private q(sql: string) {
    return prepared(this.db, sql);
  }

  // —— endpoints ——
  endpoints(owner?: string): WebhookEndpoint[] {
    const rows =
      owner === undefined
        ? this.q('SELECT id,owner,payload FROM webhook_endpoints ORDER BY rowid').all()
        : this.q('SELECT id,owner,payload FROM webhook_endpoints WHERE owner=? ORDER BY rowid').all(
            owner,
          );
    return rows.map(endpointOf);
  }
  endpoint(owner: string, endpointId: string): WebhookEndpoint {
    const row = this.q('SELECT id,owner,payload FROM webhook_endpoints WHERE id=? AND owner=?').get(
      endpointId,
      owner,
    );
    if (!row) throw new Fault('webhook_not_found', 'No webhook endpoint with that ID.', 404);
    return endpointOf(row);
  }
  secret(endpointId: string): string | undefined {
    const row = this.q('SELECT secret FROM webhook_endpoints WHERE id=?').get(endpointId);
    return row ? String(row.secret) : undefined;
  }
  create(
    owner: string,
    fields: Omit<
      WebhookEndpoint,
      | 'id'
      | 'owner'
      | 'created_at'
      | 'updated_at'
      | 'consecutive_failures'
      | 'last_success_at'
      | 'last_failure_at'
      | 'last_error'
    >,
  ): { endpoint: WebhookEndpoint; secret: string } {
    return transaction(this.db, () => {
      const count = Number(
        this.q('SELECT count(*) AS n FROM webhook_endpoints WHERE owner=?').get(owner)!.n,
      );
      if (count >= MAX_ENDPOINTS)
        throw new Fault(
          'webhook_limit_reached',
          `At most ${MAX_ENDPOINTS} webhook endpoints per owner.`,
          409,
        );
      const now = Date.now();
      const endpoint: WebhookEndpoint = {
        ...fields,
        id: id('wh'),
        owner,
        created_at: now,
        updated_at: now,
        consecutive_failures: 0,
        last_success_at: null,
        last_failure_at: null,
        last_error: null,
      };
      const secret = newSecret();
      this.q('INSERT INTO webhook_endpoints(id,owner,secret,payload) VALUES(?,?,?,?)').run(
        endpoint.id,
        owner,
        secret,
        JSON.stringify(endpoint),
      );
      return { endpoint, secret };
    });
  }
  save(endpoint: WebhookEndpoint): void {
    this.q('UPDATE webhook_endpoints SET payload=? WHERE id=? AND owner=?').run(
      JSON.stringify(endpoint),
      endpoint.id,
      endpoint.owner,
    );
  }
  rotate(owner: string, endpointId: string): string {
    this.endpoint(owner, endpointId);
    const secret = newSecret();
    this.q('UPDATE webhook_endpoints SET secret=? WHERE id=? AND owner=?').run(
      secret,
      endpointId,
      owner,
    );
    return secret;
  }
  remove(owner: string, endpointId: string): void {
    transaction(this.db, () => {
      this.endpoint(owner, endpointId);
      this.q('DELETE FROM webhook_deliveries WHERE endpoint_id=?').run(endpointId);
      this.q('DELETE FROM webhook_endpoints WHERE id=? AND owner=?').run(endpointId, owner);
    });
  }

  // —— announced approvals (run.requires_action is sent once per new pending item) ——
  /** Marks the ids as announced and returns the ones that were not announced before. */
  announce(runId: string, approvalIds: string[]): string[] {
    const insert = this.q(
      'INSERT OR IGNORE INTO webhook_announced(run_id,approval_id) VALUES(?,?)',
    );
    return approvalIds.filter((a) => Number(insert.run(runId, a).changes) > 0);
  }

  // —— deliveries ——
  /** Queue one delivery; a repeated `dedupe` key for the same endpoint is ignored. */
  enqueue(input: {
    endpointId: string;
    owner: string;
    eventId: string;
    eventType: string;
    runId: string | null;
    dedupe: string | null;
    seed: Record<string, unknown>;
  }): Delivery | undefined {
    const now = Date.now();
    const deliveryId = id('whd');
    const res = this.q(
      `INSERT OR IGNORE INTO webhook_deliveries(id,endpoint_id,owner,event_id,event_type,run_id,dedupe,status,attempts,next_at,seed,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,?)`,
    ).run(
      deliveryId,
      input.endpointId,
      input.owner,
      input.eventId,
      input.eventType,
      input.runId,
      input.dedupe,
      now,
      JSON.stringify(input.seed),
      now,
      now,
    );
    if (Number(res.changes) === 0) return undefined;
    const excess = this.pendingCount(input.endpointId) - MAX_PENDING_DELIVERIES;
    if (excess > 0) {
      this.q(
        `UPDATE webhook_deliveries SET status='failed',last_error='queue_overflow: more than ${MAX_PENDING_DELIVERIES} deliveries were queued for this endpoint',updated_at=?
         WHERE seq IN (SELECT seq FROM webhook_deliveries WHERE endpoint_id=? AND status='pending' ORDER BY seq LIMIT ? OFFSET 1)`,
      ).run(now, input.endpointId, excess);
      this.q(
        `DELETE FROM webhook_deliveries WHERE endpoint_id=? AND status!='pending' AND seq NOT IN (SELECT seq FROM webhook_deliveries WHERE endpoint_id=? ORDER BY seq DESC LIMIT ${KEEP_DELIVERIES})`,
      ).run(input.endpointId, input.endpointId);
    }
    return this.delivery(deliveryId);
  }
  delivery(deliveryId: string): Delivery | undefined {
    const row = this.q('SELECT * FROM webhook_deliveries WHERE id=?').get(deliveryId);
    return row ? deliveryOf(row) : undefined;
  }
  deliveries(endpointId: string, limit: number): Delivery[] {
    return this.q('SELECT * FROM webhook_deliveries WHERE endpoint_id=? ORDER BY seq DESC LIMIT ?')
      .all(endpointId, limit)
      .map(deliveryOf);
  }
  /** Oldest pending delivery of each endpoint that has one (the head of its serial queue). */
  heads(): Delivery[] {
    return this.q(
      `SELECT d.* FROM webhook_deliveries d JOIN (SELECT endpoint_id,min(seq) AS seq FROM webhook_deliveries WHERE status='pending' GROUP BY endpoint_id) h ON d.seq=h.seq`,
    )
      .all()
      .map(deliveryOf);
  }
  pendingCount(endpointId: string): number {
    return Number(
      this.q(
        "SELECT count(*) AS n FROM webhook_deliveries WHERE endpoint_id=? AND status='pending'",
      ).get(endpointId)!.n,
    );
  }
  setBody(deliveryId: string, body: string): void {
    this.q('UPDATE webhook_deliveries SET body=? WHERE id=?').run(body, deliveryId);
  }
  /** Record one attempt's outcome. */
  finishAttempt(
    d: Delivery,
    outcome: {
      status: DeliveryStatus;
      nextAt: number;
      httpStatus: number | null;
      error: string | null;
      durationMs: number;
    },
  ): void {
    const now = Date.now();
    transaction(this.db, () => {
      this.q(
        'UPDATE webhook_deliveries SET status=?,attempts=attempts+1,next_at=?,last_status=?,last_error=?,duration_ms=?,updated_at=? WHERE id=?',
      ).run(
        outcome.status,
        outcome.nextAt,
        outcome.httpStatus,
        outcome.error,
        outcome.durationMs,
        now,
        d.id,
      );
      const row = this.q('SELECT id,owner,payload FROM webhook_endpoints WHERE id=?').get(
        d.endpoint_id,
      );
      if (row) {
        const endpoint = endpointOf(row);
        if (outcome.status === 'succeeded') {
          endpoint.consecutive_failures = 0;
          endpoint.last_success_at = now;
        } else {
          endpoint.consecutive_failures += 1;
          endpoint.last_failure_at = now;
          endpoint.last_error = outcome.error;
        }
        this.save(endpoint);
      }
      if (outcome.status !== 'pending')
        this.q(
          `DELETE FROM webhook_deliveries WHERE endpoint_id=? AND status!='pending' AND seq NOT IN (SELECT seq FROM webhook_deliveries WHERE endpoint_id=? ORDER BY seq DESC LIMIT ${KEEP_DELIVERIES})`,
        ).run(d.endpoint_id, d.endpoint_id);
    });
  }
  /** Put a finished delivery back in the queue with a fresh attempt budget (same delivery ID). */
  requeue(owner: string, endpointId: string, deliveryId: string): Delivery {
    const d = this.delivery(deliveryId);
    if (!d || d.owner !== owner || d.endpoint_id !== endpointId)
      throw new Fault('webhook_delivery_not_found', 'No delivery with that ID.', 404);
    if (d.status === 'pending')
      throw new Fault('webhook_delivery_pending', 'This delivery is still queued.', 409);
    const now = Date.now();
    this.q(
      "UPDATE webhook_deliveries SET status='pending',attempts=0,next_at=?,updated_at=? WHERE id=?",
    ).run(now, now, deliveryId);
    return this.delivery(deliveryId)!;
  }
}
