import type { Run, RunEvent } from '../core/contracts.js';
import { isTerminalEvent } from '../core/events.js';
import { id, sha, faultOf } from '../core/util.js';
import { WebhookCaptureUnavailable } from '../store/checkpoint.js';
import { pendingApprovals } from '../store/approval-rows.js';
import { withSavepoint } from '../store/savepoint.js';
import type { Store } from '../store/store.js';
import { pendingTitle, runData, STATUS_EVENTS, snapshotOutput, wants } from './webhook-core.js';
import { WebhookDb, type DeliveryInput, type WebhookEndpoint } from './webhook-db.js';

const RETRY_MS = 1000;
const CHUNK = 16;
const SLICE_MS = 4;

/** Only database work runs on a source checkpoint. HTTP starts after its transaction commits. */
export class WebhookOutbox {
  private lastWarning = -Infinity;
  private lastOwner = '';
  constructor(
    private store: Store,
    private db: WebhookDb,
    private endpoints: (owner: string) => WebhookEndpoint[],
    private wake: () => void,
  ) {}

  capture = (run: Run, event: RunEvent): (() => void) | undefined => {
    try {
      return this.stage(run, event) ? this.wake : undefined;
    } catch (error) {
      this.warn(error);
      throw new WebhookCaptureUnavailable();
    }
  };
  private stage(run: Run, event: RunEvent): boolean {
    const type = STATUS_EVENTS[run.status];
    if (!type) return false;
    // Both graceful interruption (response.incomplete) and cold recovery (run.interrupted)
    // use the committed run status to select the wire event.
    if (
      run.status === 'requires_action'
        ? event.type !== 'run.requires_action'
        : !isTerminalEvent(event.type)
    )
      return false;
    const recipients = this.endpoints(run.owner).filter((e) => wants(e, type, run.agentId));
    if (!recipients.length) return false;
    const approval =
      run.status === 'requires_action'
        ? (event.data.approval as { id?: string } | undefined)?.id
        : undefined;
    if (run.status === 'requires_action' && !approval) return false;
    const marker = approval ?? (run.status === 'interrupted' ? 'status:interrupted' : undefined);
    const pending = approval
      ? pendingApprovals(this.store, run.id).map((a) => ({
          id: a.id,
          type: a.kind,
          title: pendingTitle(a.detail),
          status: a.status,
          expires_at: Math.floor(a.expiresAt / 1000),
        }))
      : undefined;
    const data = runData({ ...run, keyId: run.checkpoint.keyId, output: undefined }, run.status, {
      pending,
    });
    const output = recipients.some((e) => e.include_output)
      ? snapshotOutput(run.output)
      : undefined;
    const eventId = id('evt'),
      dedupe = `${run.id}:${type}${approval ? ':' + approval : ''}`;
    const entries = recipients.map((e): DeliveryInput => ({
      owner: run.owner,
      runId: run.id,
      endpointId: e.id,
      eventId,
      eventType: type,
      dedupe,
      createdAt: event.time,
      seed: {
        run_id: run.id,
        status: run.status,
        created_at: event.time,
        marker,
        agent: run.agentId,
        target_hash: sha(e.url),
        snapshot: e.include_output ? { ...data, output } : data,
      },
    }));
    if (
      marker &&
      this.store
        .prepare('SELECT 1 FROM webhook_announced WHERE run_id=? AND approval_id=?')
        .get(run.id, marker)
    )
      return false;
    // A blocked earlier event must not be overtaken by a later one from the same owner.
    let retryAt = 0;
    if (!this.db.hasStagedOwner(run.owner)) {
      try {
        withSavepoint(this.store.db, () => this.publish(entries));
        return true;
      } catch (error) {
        // Some SQLite failures roll back the outer transaction as well as our savepoint.
        // Never autocommit a recovery record for a source that just rolled back.
        if (!this.store.db.isTransaction) throw error;
        this.warn(error);
        retryAt = Date.now() + RETRY_MS;
      }
    }
    // Independent durable fallback: a transient failure of the delivery table need not fail the run.
    for (const input of entries) this.db.stage(event.id, input, retryAt);
    return true;
  }

  private publish(entries: DeliveryInput[], capacity: 'new' | 'staged' = 'new') {
    const first = entries[0];
    if (!first) return;
    const marker = first.seed.marker;
    // After prune the snapshot is sufficient; do not recreate a receipt for a deleted run.
    if (
      typeof marker === 'string' &&
      this.store
        .prepare('SELECT 1 FROM runs WHERE id=? AND owner=?')
        .get(first.runId, first.owner) &&
      !this.db.announce(first.runId!, [marker]).length
    )
      return;
    for (const entry of entries) this.db.insertDelivery(entry, capacity);
  }

  /** Bounded store retries, independent across owners. Returns the next wake time. */
  drain(now: number): number {
    let handled = 0;
    const until = performance.now() + SLICE_MS;
    while (handled < CHUNK) {
      const heads = this.db.stageHeads(CHUNK - handled, now, this.lastOwner);
      if (!heads.length) return Infinity;
      for (const h of heads) {
        const next = Number(h.retry_at);
        if (next > now) return handled ? now : next;
        const owner = String(h.owner),
          seq = Number(h.source_seq);
        try {
          withSavepoint(this.store.db, () => this.publish(this.db.takeStage(owner, seq), 'staged'));
        } catch (error) {
          this.warn(error);
          this.db.deferStage(owner, seq, now + RETRY_MS);
        }
        this.lastOwner = owner;
        handled++;
        // A single source group stays atomic; yield between groups on a slow disk or large fanout.
        if (performance.now() >= until) return now;
      }
    }
    return now;
  }
  warn(error: unknown) {
    if (Date.now() - this.lastWarning < 60000) return;
    this.lastWarning = Date.now();
    process.emitWarning(`Webhook queue write delayed: ${faultOf(error).code}`, {
      code: 'OAA_WEBHOOK_ENQUEUE',
    });
  }
}
