import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebhookDb, type DeliveryInput } from '../src/gateway/webhook-db.js';
import { WebhookOutbox } from '../src/gateway/webhook-outbox.js';
import { Store } from '../src/store/store.js';

function endpoint(db: WebhookDb, owner: string) {
  return db.create(owner, {
    url: 'https://example.invalid/hook',
    events: [],
    agents: [],
    enabled: true,
    description: '',
    include_output: false,
    allow_insecure_http: false,
    allow_private_network: false,
  }).endpoint.id;
}
function input(owner: string, endpointId: string, n: number): DeliveryInput {
  return {
    owner,
    endpointId,
    eventId: 'event_' + n,
    eventType: 'run.completed',
    runId: 'run_' + n,
    dedupe: 'source_' + n,
    seed: {},
    createdAt: n,
  };
}
test('webhook queue heads preserve FIFO across deadlines, manual requeue, and endpoint removal', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  try {
    const db = new WebhookDb(sql),
      a = endpoint(db, 'alpha'),
      a2 = endpoint(db, 'alpha'),
      b = endpoint(db, 'beta');
    endpoint(db, 'idle');
    assert.deepEqual(db.heads(), []);
    assert.deepEqual(db.stageHeads(1), []);
    db.stage(90, input('alpha', a, 90), 300);
    db.stage(4, input('alpha', a2, 4), 0);
    db.stage(80, input('beta', b, 80), 0);
    const heads = (now: number, cursor = '') =>
      db.stageHeads(2, now, cursor).map((h) => [h.owner, h.source_seq]);
    assert.deepEqual(heads(10), [
      ['beta', 80],
      ['alpha', 90],
    ]);
    assert.deepEqual(heads(300, 'alpha'), [
      ['beta', 80],
      ['alpha', 90],
    ]);
    assert.deepEqual(heads(300, 'beta'), [
      ['alpha', 90],
      ['beta', 80],
    ]);
    const first = db.enqueue(input('beta', b, 3))!,
      second = db.enqueue(input('beta', b, 1))!;
    db.enqueue(input('alpha', a, 8));
    const check = () => {
      const reference = sql
        .prepare(
          "SELECT endpoint_id,min(seq) AS head FROM webhook_deliveries WHERE status='pending' GROUP BY endpoint_id ORDER BY endpoint_id",
        )
        .all();
      assert.deepEqual(
        db
          .heads()
          .map((d) => d.seq)
          .sort((a, b) => a - b),
        reference.map((r) => Number(r.head)).sort((a, b) => a - b),
      );
    };
    check();
    db.finishAttempt(first, {
      status: 'succeeded',
      nextAt: 0,
      httpStatus: 204,
      error: null,
      durationMs: 1,
    });
    check();
    assert.ok(db.heads().some((h) => h.id === second.id));
    db.requeue('beta', b, first.id);
    check();
    assert.ok(db.heads().some((h) => h.id === first.id));
    db.remove('alpha', a);
    check();
    assert.deepEqual(
      heads(10),
      [
        ['alpha', 4],
        ['beta', 80],
      ],
      'remove advances just that owner to its surviving head',
    );
  } finally {
    sql.close();
  }
});

test('webhook recovery yields between atomic fanouts and rotates all ready owners before revisiting a slow one', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oaa-webhook-heads-'));
  const store = new Store(dir);
  try {
    const db = new WebhookDb(store.db),
      outbox = new WebhookOutbox(
        store,
        db,
        () => [],
        () => {},
      );
    const owners = Array.from({ length: 21 }, (_, i) => 'tenant_' + String(i).padStart(2, '0'));
    const endpoints = owners.map((o) => [endpoint(db, o), endpoint(db, o)]);
    for (const [i, o] of owners.entries())
      for (const n of [1, 2]) for (const ep of endpoints[i]!) db.stage(n, input(o, ep, n), 0);
    // Model an arbitrarily slow disk without sleeping or depending on the CI host's timer.
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    store.db.function('fixture_disk_write', () => {
      elapsed += 8;
      return 1;
    });
    store.db.exec(
      'CREATE TEMP TRIGGER slow AFTER INSERT ON webhook_deliveries BEGIN SELECT fixture_disk_write(); END;',
    );
    const recount = t.mock.method(db, 'boundQueue');
    for (let round = 1; round <= 2; round++)
      for (let i = 0; i < owners.length; i++) {
        outbox.drain(1234);
        const written = store
          .prepare('SELECT owner,event_id FROM webhook_deliveries ORDER BY seq DESC LIMIT 2')
          .all();
        assert.ok(
          written.length === 2 &&
            written.every((w) => w.owner === owners[i] && w.event_id === 'event_' + round),
        );
        const n = store.prepare('SELECT count(*) AS n FROM webhook_deliveries').get()!.n;
        assert.equal(
          n,
          2 * ((round - 1) * owners.length + i + 1),
          'no extra or split source group in this event-loop slice',
        );
      }
    assert.equal(outbox.drain(1234), Infinity);
    assert.equal(
      recount.mock.callCount(),
      0,
      'transferring an existing reservation does not rescan the endpoint',
    );
    assert.ok(endpoints.flat().every((ep) => db.pendingCount(ep) === 2));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
