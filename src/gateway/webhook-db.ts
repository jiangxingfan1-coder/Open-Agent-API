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
export type DeliveryInput = {
  endpointId: string;
  owner: string;
  eventId: string;
  eventType: string;
  runId: string | null;
  dedupe: string | null;
  seed: Record<string, unknown>;
  createdAt?: number;
};
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
CREATE INDEX IF NOT EXISTS webhook_deliveries_age ON webhook_deliveries(endpoint_id,created_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS webhook_announced(run_id TEXT NOT NULL,approval_id TEXT NOT NULL,PRIMARY KEY(run_id,approval_id));
CREATE TABLE IF NOT EXISTS webhook_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,source_seq INTEGER NOT NULL,endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,dedupe TEXT NOT NULL,input TEXT NOT NULL,created_at INTEGER NOT NULL,retry_at INTEGER NOT NULL,UNIQUE(endpoint_id,dedupe));
CREATE INDEX IF NOT EXISTS webhook_outbox_owner ON webhook_outbox(owner,source_seq,seq);
CREATE INDEX IF NOT EXISTS webhook_outbox_age ON webhook_outbox(endpoint_id,created_at);
CREATE TABLE IF NOT EXISTS webhook_queue_stats(endpoint_id TEXT PRIMARY KEY REFERENCES webhook_endpoints(id) ON DELETE CASCADE,overflows INTEGER NOT NULL);`);
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
  enqueue(input: DeliveryInput): Delivery | undefined {
    const inserted = this.insertDelivery(input);
    return inserted ? this.delivery(inserted) : undefined;
  }
  insertDelivery(input: DeliveryInput): string | undefined {
    const now = input.createdAt ?? Date.now();
    const deliveryId = id('whd');
    const res = this.q(
      `INSERT INTO webhook_deliveries(id,endpoint_id,owner,event_id,event_type,run_id,dedupe,status,attempts,next_at,seed,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,?) ON CONFLICT(endpoint_id,dedupe) DO NOTHING`,
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
    this.boundQueue(input.endpointId);
    return deliveryId;
  }
  boundQueue(endpointId: string): void {
    const pending = Number(
      this.q(
        "SELECT count(*) AS n FROM webhook_deliveries WHERE endpoint_id=? AND status='pending'",
      ).get(endpointId)!.n,
    );
    const excess = pending + this.stagedCount(endpointId) - MAX_PENDING_DELIVERIES;
    if (excess > 0) {
      const marked = this.q(
        `UPDATE webhook_deliveries SET status='failed',last_error='queue_overflow: more than ${MAX_PENDING_DELIVERIES} deliveries were queued for this endpoint',updated_at=?
         WHERE seq IN (SELECT seq FROM webhook_deliveries WHERE endpoint_id=? AND status='pending' ORDER BY seq LIMIT ? OFFSET 1)`,
      ).run(Date.now(), endpointId, excess);
      const rest = excess - Number(marked.changes);
      if (rest > 0)
        this.q(
          'DELETE FROM webhook_outbox WHERE seq IN (SELECT seq FROM webhook_outbox WHERE endpoint_id=? ORDER BY seq LIMIT ? OFFSET ?)',
        ).run(endpointId, rest, pending ? 0 : 1);
      this.q(
        'INSERT INTO webhook_queue_stats SELECT id,? FROM webhook_endpoints WHERE id=? ON CONFLICT(endpoint_id) DO UPDATE SET overflows=overflows+excluded.overflows',
      ).run(excess, endpointId);
      this.trim(endpointId);
    }
  }
  stage(sourceSeq: number, input: DeliveryInput, retryAt: number) {
    this.q(
      'INSERT INTO webhook_outbox(owner,source_seq,endpoint_id,dedupe,input,created_at,retry_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(endpoint_id,dedupe) DO NOTHING',
    ).run(
      input.owner,
      sourceSeq,
      input.endpointId,
      input.dedupe,
      JSON.stringify(input),
      input.createdAt!,
      retryAt,
    );
    this.boundQueue(input.endpointId);
  }
  stagedCount(endpointId: string) {
    return Number(
      this.q('SELECT count(*) AS n FROM webhook_outbox WHERE endpoint_id=?').get(endpointId)!.n,
    );
  }
  hasStagedOwner(owner: string) {
    return !!this.q('SELECT 1 FROM webhook_outbox WHERE owner=? LIMIT 1').get(owner);
  }
  stageHeads(limit: number) {
    return this.q(
      `SELECT o.owner,o.source_seq,o.retry_at FROM (SELECT owner,min(seq) AS head FROM webhook_outbox GROUP BY owner) h
      JOIN webhook_outbox o ON o.seq=h.head ORDER BY o.retry_at,o.seq LIMIT ?`,
    ).all(limit);
  }
  takeStage(owner: string, seq: number): DeliveryInput[] {
    const args = [owner, seq];
    const rows = this.q(
      'SELECT input FROM webhook_outbox WHERE owner=? AND source_seq=? ORDER BY seq',
    ).all(...args);
    this.q('DELETE FROM webhook_outbox WHERE owner=? AND source_seq=?').run(...args);
    return rows.map((r) => JSON.parse(String(r.input)) as DeliveryInput);
  }
  deferStage(owner: string, seq: number, until: number) {
    this.q('UPDATE webhook_outbox SET retry_at=? WHERE owner=? AND source_seq=?').run(
      until,
      owner,
      seq,
    );
  }
  queueStatus(endpointId: string) {
    const row = this.q(
      `SELECT min(at) AS oldest FROM (
      SELECT min(created_at) AS at FROM webhook_deliveries WHERE endpoint_id=? AND status='pending'
      UNION ALL SELECT min(created_at) FROM webhook_outbox WHERE endpoint_id=?)`,
    ).get(endpointId, endpointId)!;
    return {
      capture_pending: this.stagedCount(endpointId),
      oldest_pending_at: row.oldest === null ? null : Number(row.oldest),
      overflow_total: Number(
        this.q('SELECT overflows FROM webhook_queue_stats WHERE endpoint_id=?').get(endpointId)
          ?.overflows ?? 0,
      ),
    };
  }
  retire(d: Delivery) {
    this.q(
      "UPDATE webhook_deliveries SET status='failed',last_error='subscription_changed',updated_at=? WHERE id=? AND status='pending'",
    ).run(Date.now(), d.id);
    this.trim(d.endpoint_id);
  }
  private trim(endpointId: string) {
    this.q(
      `DELETE FROM webhook_deliveries WHERE endpoint_id=? AND status!='pending' AND seq NOT IN (SELECT seq FROM webhook_deliveries WHERE endpoint_id=? ORDER BY seq DESC LIMIT ${KEEP_DELIVERIES})`,
    ).run(endpointId, endpointId);
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
    return (
      this.stagedCount(endpointId) +
      Number(
        this.q(
          "SELECT count(*) AS n FROM webhook_deliveries WHERE endpoint_id=? AND status='pending'",
        ).get(endpointId)!.n,
      )
    );
  }
  setBody(deliveryId: string, body: string, withOutput: boolean): void {
    // After the first attempt, keep only one copy of the bounded output.
    this.q(
      "UPDATE webhook_deliveries SET body=?, seed=json_set(json_remove(seed,'$.snapshot'),'$.sent_output',?) WHERE id=?",
    ).run(body, Number(withOutput), deliveryId);
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
      if (outcome.status !== 'pending') this.trim(d.endpoint_id);
    });
  }
  /** Put a finished delivery back in the queue with a fresh attempt budget (same delivery ID). */
  requeue(owner: string, endpointId: string, deliveryId: string): Delivery {
    const d = this.delivery(deliveryId);
    if (!d || d.owner !== owner || d.endpoint_id !== endpointId)
      throw new Fault('webhook_delivery_not_found', 'No delivery with that ID.', 404);
    if (d.status === 'pending')
      throw new Fault('webhook_delivery_pending', 'This delivery is still queued.', 409);
    if (this.pendingCount(endpointId) >= MAX_PENDING_DELIVERIES)
      throw new Fault('queue_full', 'The endpoint delivery queue is full.', 429);
    const now = Date.now();
    this.q(
      "UPDATE webhook_deliveries SET status='pending',attempts=0,next_at=?,updated_at=? WHERE id=?",
    ).run(now, now, deliveryId);
    return this.delivery(deliveryId)!;
  }
}
