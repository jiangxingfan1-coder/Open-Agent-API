// Crash recovery and recipient isolation across real loopback createServer() receivers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { verifySignature, webhookTiming } from '../src/gateway/webhook-core.js';
import { FixtureModel, agent, setup, token } from './helpers.js';
import { Store } from '../src/store/store.js';
import { prune } from '../src/store/retention.js';
import { MAX_PENDING_DELIVERIES, WebhookDb } from '../src/gateway/webhook-db.js';
import { DatabaseSync } from 'node:sqlite';

import {
  receiver,
  addEndpoint,
  settled,
  start,
  waitFor,
  useWebhookTimings,
} from './webhook-helpers.js';

useWebhookTimings();

const crashFixture = path.resolve('dist/test/fixtures/webhook-crash.js');
for (const mode of ['normal', 'fallback'])
  test(`webhook: ${mode} capture survives exit before observers and prune; late subscribers get nothing`, async () => {
    const original = await receiver(),
      late = await receiver();
    const s = await setup();
    let again: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      s.store.publish('owner', makeBundle(agent({ id: 'agent/source' })));
      const endpoint = await addEndpoint(s, {
        url: original.url,
        events: ['run.completed'],
        include_output: true,
      });
      const file = path.join(s.dir, 'crash.json');
      await writeFile(file, JSON.stringify(s.config));
      await s.app.close();
      const stopped = spawnSync(process.execPath, [crashFixture, file, mode], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(stopped.status, 74, stopped.stderr);
      const offline = new Store(s.config.dataDir);
      let runId: string;
      try {
        const db = new WebhookDb(offline.db),
          [run] = offline.allRuns(['completed']);
        assert.ok(run);
        runId = run.id;
        assert.equal(db.stagedCount(endpoint.id), mode === 'fallback' ? 1 : 0);
        assert.equal(db.pendingCount(endpoint.id), 1);
        const captured = db.endpoint('owner', endpoint.id);
        db.create('owner', { ...captured, url: late.url });
        db.save({ ...captured, enabled: false });
      } finally {
        offline.close();
      }
      again = await createGateway(s.config, s.runtime);
      await again.app.ready();
      assert.equal(
        (await prune(again.store, { olderThanMs: 60000, now: Date.now() + 120000 })).runs,
        1,
      );
      assert.equal(original.hits.length, 0);
      const enabled = await again.app.inject({
        method: 'PATCH',
        url: '/v1/webhooks/' + endpoint.id,
        headers: { authorization: 'Bearer ' + token },
        payload: { enabled: true },
      });
      assert.equal(enabled.statusCode, 200, enabled.body);
      await waitFor(() => original.hits.length === 1, 5000);
      const hit = original.hits[0]!,
        data = hit.json.data as { run_id: string; output: { text: string } };
      assert.equal(data.run_id, runId);
      assert.equal(data.output.text, 'Fixture response.');
      assert.ok(!hit.body.includes('Complete the source task.'));
      assert.ok(verifySignature(endpoint.secret, String(hit.headers['x-oaa-signature']), hit.body));
      const rows = await settled(again.app, endpoint.id, 1);
      assert.equal(rows.length, 1);
      await again.app.close();
      again = await createGateway(s.config, s.runtime);
      await again.app.ready();
      assert.equal(again.store.prepare('SELECT count(*) AS n FROM webhook_deliveries').get()?.n, 1);
      assert.equal(late.hits.length, 0);
      assert.equal(original.hits.length, 1);
    } finally {
      await again?.app.close();
      await s.cleanup();
      await original.close();
      await late.close();
    }
  });

test('webhook: retry after receiver got bytes but the gateway died before acknowledgement has the same ID and body', async () => {
  const hook = await receiver((n) => (n === 1 ? 'hang' : 204));
  const s = await setup();
  let again: Awaited<ReturnType<typeof createGateway>> | undefined;
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/source' })));
    const ep = await addEndpoint(s, {
      url: hook.url,
      events: ['run.completed'],
      include_output: true,
    });
    const config = path.join(s.dir, 'fixture.json');
    await writeFile(config, JSON.stringify(s.config));
    await s.app.close();
    child = spawn(process.execPath, [crashFixture, config, 'await-ack'], { stdio: 'ignore' });
    exited = once(child, 'exit');
    await waitFor(() => hook.hits.length === 1);
    child.kill('SIGKILL');
    await exited;
    again = await createGateway(s.config, s.runtime);
    await again.app.ready();
    const [d] = await settled(again.app, ep.id, 1);
    assert.equal(d?.status, 'succeeded');
    assert.equal(hook.hits.length, 2);
    for (const hit of hook.hits) {
      assert.equal(hit.headers['x-oaa-delivery'], d!.id);
      assert.equal(hit.body, hook.hits[0]!.body);
      assert.ok(verifySignature(ep.secret, String(hit.headers['x-oaa-signature']), hit.body));
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await again?.app.close();
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: local body and acknowledgement write failures do not spend the receiver retry budget', async () => {
  const s = await setup(),
    hook = await receiver();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const ep = await addEndpoint(s, { url: hook.url });
    const db = s.store.db;
    const failed = new Set<string>();
    db.function('track_write', (point) => {
      failed.add(String(point));
      return 1;
    });
    db.exec(`CREATE TEMP TRIGGER deny_body BEFORE UPDATE OF body ON webhook_deliveries
      BEGIN SELECT track_write('body'); SELECT RAISE(ABORT,'fixture'); END;
      CREATE TEMP TRIGGER deny_ack BEFORE UPDATE OF attempts ON webhook_deliveries
      BEGIN SELECT track_write('ack'); SELECT RAISE(ABORT,'fixture'); END;`);
    await start(s);
    await waitFor(() => failed.has('body'));
    assert.ok(!failed.has('ack'), 'no HTTP attempt to acknowledge');
    assert.equal(hook.hits.length, 0);
    db.exec('DROP TRIGGER deny_body');
    await waitFor(() => failed.has('ack'));
    assert.equal(hook.hits.length, 1);
    assert.equal(db.prepare('SELECT attempts FROM webhook_deliveries').get()?.attempts, 0);
    db.exec('DROP TRIGGER deny_ack');
    const [delivery] = await settled(s.app, ep.id, 1);
    assert.equal(delivery?.status, 'succeeded');
    assert.equal(delivery.attempts, 1);
    assert.equal(hook.hits.length, 2);
    assert.equal(hook.hits[0]!.headers['x-oaa-delivery'], hook.hits[1]!.headers['x-oaa-delivery']);
    assert.equal(hook.hits[0]!.body, hook.hits[1]!.body);
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: capture freezes recipients and output permissions, but uses the current signing key', async () => {
  const hook = await receiver();
  const s = await setup();
  let again: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/source' })));
    const ids = new Map<string, string>();
    for (const name of ['plain', 'redacted', 'moved', 'filtered', 'deleted', 'rotated']) {
      const ep = await addEndpoint(s, {
        url: hook.url + '/' + name,
        events: ['run.completed'],
        agents: ['agent/source'],
        include_output: name !== 'plain',
      });
      ids.set(name, ep.id);
    }
    const config = path.join(s.dir, 'capture.json');
    await writeFile(config, JSON.stringify(s.config));
    await s.app.close();
    const child = spawnSync(process.execPath, [crashFixture, config, 'fallback'], {
      timeout: 15000,
      encoding: 'utf8',
    });
    assert.equal(child.status, 74, child.stderr);
    let secret: string;
    const offline = new Store(s.config.dataDir);
    try {
      const db = new WebhookDb(offline.db),
        endpoint = (name: string) => db.endpoint('owner', ids.get(name)!);
      assert.ok(
        !String(
          offline
            .prepare('SELECT input FROM webhook_outbox WHERE endpoint_id=?')
            .get(ids.get('plain')!)?.input,
        ).includes('Fixture response.'),
      );
      db.save({ ...endpoint('plain'), include_output: true });
      db.save({ ...endpoint('redacted'), include_output: false });
      db.save({ ...endpoint('moved'), url: hook.url + '/new-destination' });
      db.save({ ...endpoint('filtered'), agents: ['agent/other'] });
      db.remove('owner', ids.get('deleted')!);
      assert.equal(db.stagedCount(ids.get('deleted')!), 0);
      secret = db.rotate('owner', ids.get('rotated')!);
    } finally {
      offline.close();
    }
    again = await createGateway(s.config, s.runtime);
    await again.app.ready();
    await waitFor(() => hook.hits.length >= 3);
    assert.deepEqual(hook.hits.map((h) => h.path).sort(), [
      '/hook/plain',
      '/hook/redacted',
      '/hook/rotated',
    ]);
    for (const hit of hook.hits) {
      const data = hit.json.data as { output?: { text: string } };
      if (hit.path === '/hook/rotated') {
        assert.equal(data.output?.text, 'Fixture response.');
        assert.ok(verifySignature(secret, String(hit.headers['x-oaa-signature']), hit.body));
      } else assert.equal(data.output, undefined);
    }
    for (const name of ['filtered', 'moved']) {
      const [retired] = await settled(again.app, ids.get(name)!, 1);
      assert.equal(retired?.status, 'failed');
      assert.equal(retired.last_error, 'subscription_changed');
      assert.equal(retired.attempts, 0);
    }
  } finally {
    await again?.app.close();
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: startup captures the recovery interruption before HTTP is ready', async () => {
  const hook = await receiver(),
    s = await setup();
  let again: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/source' })));
    const ep = await addEndpoint(s, { url: hook.url, events: ['run.interrupted'] });
    const config = path.join(s.dir, 'interrupt.json');
    await writeFile(config, JSON.stringify(s.config));
    await s.app.close();
    const child = spawnSync(process.execPath, [crashFixture, config, 'cold-recovery'], {
      timeout: 15000,
      encoding: 'utf8',
    });
    assert.equal(child.status, 74, child.stderr);
    again = await createGateway(s.config, s.runtime);
    const db = new WebhookDb(again.store.db);
    assert.equal(
      db.pendingCount(ep.id),
      1,
      'cold recovery itself captured the delivery, not a later history scan',
    );
    assert.equal(hook.hits.length, 0);
    await again.app.ready();
    await settled(again.app, ep.id, 1);
    assert.equal(hook.hits[0]?.json.type, 'run.interrupted');
  } finally {
    await again?.app.close();
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: withdrawing output permission stops retries of an already fixed output body', async () => {
  webhookTiming.backoffMs = [1000];
  webhookTiming.jitter = 0;
  const hook = await receiver(() => 500),
    s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const ep = await addEndpoint(s, {
      url: hook.url,
      events: ['run.completed'],
      include_output: true,
    });
    await start(s);
    await waitFor(
      () =>
        Number(
          s.store.prepare('SELECT attempts FROM webhook_deliveries WHERE endpoint_id=?').get(ep.id)
            ?.attempts,
        ) === 1,
    );
    const r = await s.app.inject({
      method: 'PATCH',
      url: '/v1/webhooks/' + ep.id,
      headers: { authorization: 'Bearer ' + token },
      payload: { include_output: false },
    });
    assert.equal(r.statusCode, 200, r.body);
    const [d] = await settled(s.app, ep.id, 1);
    assert.equal(d?.last_error, 'subscription_changed');
    assert.equal(d.attempts, 1);
    assert.equal(hook.hits.length, 1);
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: old pending seeds and frozen bodies resume without backfilling historical sources', async () => {
  const s = await setup(),
    hook = await receiver();
  let again: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const id = (
      await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'not in webhook' })
    ).json().id;
    const ep = await addEndpoint(s, { url: hook.url, events: ['run.completed'] });
    await s.app.close();
    const offline = new Store(s.config.dataDir);
    const frozen = JSON.stringify({
      id: 'legacy_frozen',
      type: 'run.completed',
      created_at: 100,
      data: { run_id: id },
    });
    try {
      // An old gateway could leave both first-attempt seeds and already signed/retried bytes.
      const db = new WebhookDb(offline.db);
      for (const eventId of ['legacy_seed', 'legacy_frozen']) {
        const d = db.enqueue({
          endpointId: ep.id,
          eventId,
          eventType: 'run.completed',
          runId: id,
          owner: 'owner',
          dedupe: eventId,
          seed: { run_id: id, status: 'completed' },
        })!;
        if (eventId === 'legacy_frozen')
          offline
            .prepare('UPDATE webhook_deliveries SET body=?,attempts=1 WHERE id=?')
            .run(frozen, d.id);
      }
      offline.db.exec('DROP TABLE webhook_queue_stats; DROP TABLE webhook_outbox;');
    } finally {
      offline.close();
    }
    again = await createGateway(s.config, s.runtime);
    await again.app.ready();
    await settled(again.app, ep.id, 2);
    assert.deepEqual(
      hook.hits.map((h) => h.json.id),
      ['legacy_seed', 'legacy_frozen'],
    );
    assert.equal(hook.hits[1]!.body, frozen);
  } finally {
    await again?.app.close();
    await s.cleanup();
    await hook.close();
  }
});

for (const failure of ['ABORT', 'ROLLBACK'])
  test(`webhook: source checkpoint ${failure} cannot commit a phantom delivery`, async () => {
    const s = await setup();
    const hook = await receiver();
    try {
      s.store.publish('owner', makeBundle(agent()));
      await addEndpoint(s, { url: hook.url, events: ['run.completed', 'run.failed'] });
      s.store.db
        .exec(`CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON webhook_deliveries WHEN NEW.event_type='run.completed'
      BEGIN SELECT RAISE(${failure},'fixture queue failure'); END;
      ${failure === 'ABORT' ? "CREATE TEMP TRIGGER fail_capture BEFORE INSERT ON webhook_outbox BEGIN SELECT RAISE(ABORT,'fixture capture failure'); END;" : ''}`);
      const source = await s.request('POST', '/v1/responses', {
        model: 'agent/test',
        input: 'hello',
      });
      assert.equal(source.json().status, 'failed', source.body);
      assert.equal(s.store.run(source.json().id).error?.code, 'persistence_failed');
      assert.equal(
        s.store.history(source.json().id).filter((e) => e.type === 'response.completed').length,
        0,
      );
      await waitFor(() => hook.hits.length === 1);
      assert.equal(hook.hits[0]!.json.type, 'run.failed');
      assert.equal(
        s.store.db
          .prepare("SELECT count(*) AS n FROM webhook_deliveries WHERE event_type='run.completed'")
          .get()?.n,
        0,
      );
      assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM webhook_outbox').get()?.n, 0);
      assert.equal(s.driver.calls, 1);
    } finally {
      await s.cleanup();
      await hook.close();
    }
  });

test('webhook: a waiting capture and subsequent event keep their source order', async () => {
  const s = await setup(),
    hook = await receiver();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const ep = await addEndpoint(s, { url: hook.url, events: ['run.completed'] });
    s.store.db.exec(
      "CREATE TEMP TRIGGER fail_enqueue BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    const send = async () =>
      (await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'ordinary' })).json()
        .id;
    const one = await send();
    s.store.db.exec('DROP TRIGGER fail_enqueue');
    const two = await send();
    await settled(s.app, ep.id, 2);
    assert.deepEqual(
      hook.hits.map((h) => (h.json.data as { run_id: string }).run_id),
      [one, two],
    );
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

for (const shutdown of [false, true])
  test(`webhook: even a failed failure-notice write cannot crash the gateway or settle uncommitted usage (shutdown=${shutdown})`, async () => {
    const s = await setup(),
      hook = await receiver();
    let again: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      s.store.publish('owner', makeBundle(agent()));
      const endpoint = await addEndpoint(s, { url: hook.url });
      const key = s.auth.authenticate('Bearer ' + token).keyId!;
      let failures = 0;
      s.store.db.function('count_failure', (type) => {
        if (type === 'run.failed') failures++;
        return 1;
      });
      s.store.db.exec(`CREATE TEMP TRIGGER deny_delivery BEFORE INSERT ON webhook_deliveries
      BEGIN SELECT count_failure(NEW.event_type); SELECT RAISE(ABORT,'fixture outage'); END;
      CREATE TEMP TRIGGER deny_capture BEFORE INSERT ON webhook_outbox BEGIN SELECT RAISE(ABORT,'fixture outage'); END;`);
      const id = await start(s);
      await waitFor(() => failures > 0);
      assert.equal((await s.request('GET', '/health')).statusCode, 200);
      assert.equal(s.store.run(id).status, 'in_progress');
      assert.equal(s.auth.keyUsage(key).activeRuns, 1);
      assert.equal(hook.hits.length, 0);
      if (shutdown) {
        await s.app.close();
        again = await createGateway(s.config, s.runtime);
        await again.app.ready();
        assert.equal(again.store.run(id).status, 'interrupted');
        await settled(again.app, endpoint.id, 1);
        assert.deepEqual(
          hook.hits.map((h) => h.json.type),
          ['run.interrupted'],
        );
      } else {
        s.store.db.exec('DROP TRIGGER deny_delivery; DROP TRIGGER deny_capture');
        await waitFor(() => s.store.run(id).status === 'failed');
        await settled(s.app, endpoint.id, 1);
        assert.deepEqual(
          hook.hits.map((h) => h.json.type),
          ['run.failed'],
        );
        assert.equal(s.auth.keyUsage(key).activeRuns, 0);
      }
      assert.equal(s.driver.calls, 1);
    } finally {
      await again?.app.close();
      await s.cleanup();
      await hook.close();
    }
  });

test('webhook: turn exhaustion captures incomplete rather than interrupted', async () => {
  const hook = await receiver(),
    s = await setup(
      new FixtureModel(() => ({ calls: [{ id: 'list', name: 'list_files', arguments: {} }] })),
    );
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ tools: [builtin('list_files')], limits: { maxTurns: 1 } })),
    );
    const ep = await addEndpoint(s, {
      url: hook.url,
      events: ['run.incomplete', 'run.interrupted'],
    });
    await start(s);
    await settled(s.app, ep.id, 1);
    assert.deepEqual(
      hook.hits.map((h) => h.json.type),
      ['run.incomplete'],
    );
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: staged and materialized entries share the endpoint ceiling and report oldest/overflow totals', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  try {
    const db = new WebhookDb(sql),
      ep = db.create('owner', {
        url: 'https://example.invalid/hook',
        events: [],
        agents: [],
        include_output: false,
        enabled: true,
        description: '',
        allow_insecure_http: false,
        allow_private_network: false,
      }).endpoint;
    const input = (i: number) => ({
      owner: 'owner',
      endpointId: ep.id,
      eventId: 'event_' + i,
      eventType: 'run.completed',
      runId: 'run_' + i,
      dedupe: 'dedupe_' + i,
      seed: {},
      createdAt: i,
    });
    sql.exec('BEGIN');
    const raw = sql.prepare(
      'INSERT INTO webhook_outbox(owner,source_seq,endpoint_id,dedupe,input,created_at,retry_at) VALUES(?,?,?,?,?,?,0)',
    );
    for (let i = 1; i <= MAX_PENDING_DELIVERIES; i++)
      raw.run('owner', i, ep.id, 'dedupe_' + i, JSON.stringify(input(i)), i);
    db.stage(MAX_PENDING_DELIVERIES + 1, input(MAX_PENDING_DELIVERIES + 1), 0);
    assert.deepEqual(db.queueStatus(ep.id), {
      capture_pending: MAX_PENDING_DELIVERIES,
      oldest_pending_at: 1,
      overflow_total: 1,
    });
    assert.equal(db.takeStage('owner', 2).length, 0, 'oldest after the head was dropped');
    const head = db.takeStage('owner', 1)[0]!;
    db.enqueue(head);
    db.stage(MAX_PENDING_DELIVERIES + 2, input(MAX_PENDING_DELIVERIES + 2), 0);
    assert.equal(db.pendingCount(ep.id), MAX_PENDING_DELIVERIES);
    assert.equal(db.queueStatus(ep.id).overflow_total, 2);
    assert.equal(db.heads()[0]?.event_id, 'event_1');
    db.remove('owner', ep.id);
    sql.exec('COMMIT');
    assert.equal(db.pendingCount(ep.id), 0);
    assert.equal(db.queueStatus(ep.id).overflow_total, 0);
  } finally {
    sql.close();
  }
});
