// Webhook deliveries against a receiver on a 127.0.0.1 ephemeral port: event per run outcome,
// retries with a stable delivery ID, timeouts that never hold up the run, restart, deletion,
// the test event and include_output. Retry delays are shortened through `webhookTiming`.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { verifySignature, webhookTiming } from '../src/gateway/webhook-core.js';
import { FixtureModel, agent, setup, token, waitFor as waitUntil } from './helpers.js';

// Bounded waits with room for a slow, loaded CI machine (the condition is polled every 10 ms).
const waitFor = (check: () => boolean | Promise<boolean>, ms = 20_000) => waitUntil(check, ms);

type Hit = { headers: http.IncomingHttpHeaders; body: string; json: Record<string, unknown> };

/** A receiver whose answer per request comes from `respond` (status code, or 'hang'). */
async function receiver(respond: (n: number) => number | 'hang' = () => 200) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      hits.push({ headers: req.headers, body, json: JSON.parse(body) });
      const answer = respond(hits.length);
      if (answer === 'hang') return;
      res.writeHead(answer).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    url: `http://127.0.0.1:${port}/hook`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const saved = { ...webhookTiming, backoffMs: [...webhookTiming.backoffMs] };
test.beforeEach(() => {
  webhookTiming.backoffMs = [50, 100, 150];
  webhookTiming.jitter = 0;
  webhookTiming.timeoutMs = 2_000;
});
test.after(() => Object.assign(webhookTiming, saved));

/** The approval-gated writer from approval-outcomes.test.ts. */
async function writerGateway(extra: Record<string, unknown> = {}) {
  const tool = builtin('write_file');
  tool.capability.requiresApproval = true;
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'written and done' }
        : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
    ),
    { approvalTimeoutMs: 30_000, ...extra },
  );
  s.store.publish('owner', makeBundle(agent({ tools: [tool] })));
  return s;
}

async function addEndpoint(
  s: Awaited<ReturnType<typeof setup>>,
  body: Record<string, unknown>,
): Promise<{ id: string; secret: string }> {
  const r = await s.request('POST', '/v1/webhooks', body);
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}

type Inject = (o: {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}) => Promise<{ json(): { data: { status: string }[] } }>;
type DeliveryRow = {
  id: string;
  status: string;
  http_status: number | null;
  attempts: number;
  last_error: string | null;
};

/**
 * Wait until the endpoint has at least `count` deliveries and none of them is pending any more.
 * The receiver records a request before it answers, and the gateway records the outcome only after
 * the answer arrives, so "the receiver saw it" is not yet "the delivery is settled".
 */
async function settled(
  app: { inject: Inject },
  endpointId: string,
  count: number,
): Promise<DeliveryRow[]> {
  let rows: DeliveryRow[] = [];
  await waitFor(async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${token}` },
    });
    rows = r.json().data as DeliveryRow[];
    return rows.length >= count && rows.every((d) => d.status !== 'pending');
  }, 20_000);
  return rows;
}

async function start(s: Awaited<ReturnType<typeof setup>>, input = 'write') {
  const r = await s.request('POST', '/v1/responses', {
    model: 'agent/test',
    input,
    background: true,
  });
  return r.json().id as string;
}

test('webhook: a failed fanout rolls back both announcements and deliveries before a redelivered notification', async () => {
  const hook = await receiver(),
    s = await writerGateway();
  try {
    await addEndpoint(s, { url: hook.url, events: ['run.requires_action'] });
    const second = await addEndpoint(s, {
      url: hook.url + '/second',
      events: ['run.requires_action'],
    });
    s.store.db.function('test_second_endpoint', () => second.id);
    s.store.db
      .exec(`CREATE TEMP TRIGGER refuse_second BEFORE INSERT ON webhook_deliveries WHEN NEW.endpoint_id=test_second_endpoint()
      BEGIN SELECT RAISE(ABORT,'fixture delivery write failure'); END`);
    const id = await start(s);
    await waitFor(() => s.store.run(id).checkpoint.suspension?.kind === 'approval');
    const count = (table: string) =>
      Number(s.store.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id=?`).get(id)?.n);
    assert.equal(count('webhook_announced'), 0);
    assert.equal(count('webhook_deliveries'), 0);
    s.store.db.exec('DROP TRIGGER refuse_second');
    const summary = { owner: 'owner', runId: id, status: 'requires_action', agentId: 'agent/test' };
    s.store.events.emit('summary', summary);
    s.store.events.emit('summary', summary);
    await waitFor(() => hook.hits.length === 2);
    assert.equal(count('webhook_announced'), 1);
    assert.equal(count('webhook_deliveries'), 2);
    assert.equal(hook.hits[0]!.json.id, hook.hits[1]!.json.id);
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: requires_action then completed, signed, without the task input', async () => {
  const hook = await receiver();
  const s = await writerGateway();
  try {
    const { id: endpointId, secret } = await addEndpoint(s, { url: hook.url });
    const runId = await start(s, 'secret task text');
    await waitFor(() => hook.hits.length >= 1);
    const first = hook.hits[0]!;
    assert.equal(first.headers['x-oaa-event'], 'run.requires_action');
    assert.match(String(first.headers['user-agent']), /^OpenAgentAPI\/\d/);
    assert.match(String(first.headers['x-oaa-delivery']), /^whd_/);
    assert.ok(verifySignature(secret, String(first.headers['x-oaa-signature']), first.body));
    const data = first.json.data as Record<string, unknown>;
    assert.equal(first.json.type, 'run.requires_action');
    assert.match(String(first.json.id), /^evt_/);
    assert.equal(data.run_id, runId);
    assert.equal(data.agent, 'agent/test');
    assert.equal(data.status, 'requires_action');
    const pending = data.pending_actions as { id: string; type: string; title: string }[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.type, 'tool');
    assert.equal(pending[0]!.title, 'write_file');
    assert.equal(first.body.includes('secret task text'), false, 'no task input');
    assert.equal(data.output, undefined, 'no output by default');

    const action = pending[0]!.id;
    await s.request('POST', `/v1/runs/${runId}/actions/${action}`, { decision: 'approve' });
    await waitFor(() => hook.hits.length >= 2);
    assert.equal(hook.hits[1]!.json.type, 'run.completed');
    const done = hook.hits[1]!.json.data as Record<string, unknown>;
    assert.equal(done.status, 'completed');
    assert.deepEqual(Object.keys(done.usage as object).sort(), [
      'input_tokens',
      'output_tokens',
      'total_tokens',
    ]);
    assert.equal(done.output, undefined);
    const deliveries = await settled(s.app, endpointId, 2);
    assert.deepEqual(
      deliveries.map((d) => [d.status, d.http_status]),
      [
        ['succeeded', 200],
        ['succeeded', 200],
      ],
    );
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: denied approval fails the run (run.failed); cancel gives run.cancelled', async () => {
  const hook = await receiver();
  const s = await writerGateway();
  try {
    await addEndpoint(s, { url: hook.url, events: ['run.failed', 'run.cancelled'] });
    const failed = await start(s);
    await waitFor(() => s.store.run(failed).status === 'requires_action');
    const action = s.store.approvals(failed)[0]!.id;
    await s.request('POST', `/v1/runs/${failed}/actions/${action}`, { decision: 'deny' });
    await waitFor(() => hook.hits.length >= 1);
    assert.equal(hook.hits[0]!.json.type, 'run.failed');
    const error = (hook.hits[0]!.json.data as { error: { code: string } }).error;
    assert.equal(error.code, 'permission_denied');

    const cancelled = await start(s);
    await waitFor(() => s.store.run(cancelled).status === 'requires_action');
    await s.request('POST', `/v1/responses/${cancelled}/cancel`);
    await waitFor(() => hook.hits.length >= 2);
    assert.equal(hook.hits[1]!.json.type, 'run.cancelled');
    assert.equal((hook.hits[1]!.json.data as { run_id: string }).run_id, cancelled);
    assert.equal(hook.hits.length, 2, 'requires_action was not subscribed');
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: 500 then 200 is retried with the same delivery ID and body', async () => {
  const hook = await receiver((n) => (n === 1 ? 500 : 200));
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const endpoint = await addEndpoint(s, { url: hook.url, events: ['run.completed'] });
    await start(s);
    await waitFor(() => hook.hits.length >= 2);
    assert.equal(hook.hits[0]!.headers['x-oaa-delivery'], hook.hits[1]!.headers['x-oaa-delivery']);
    assert.equal(hook.hits[0]!.body, hook.hits[1]!.body);
    const [d] = await settled(s.app, endpoint.id, 1);
    assert.equal(d!.status, 'succeeded');
    assert.equal(d!.attempts, 2);
    assert.equal(d!.http_status, 200);
    const view = (await s.request('GET', `/v1/webhooks/${endpoint.id}`)).json();
    assert.equal(view.status.consecutive_failures, 0);
    assert.equal(view.status.state, 'ok');
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: a receiver that always fails ends as failed after the attempt budget; redeliver works', async () => {
  let fail = true;
  const hook = await receiver(() => (fail ? 503 : 204));
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const endpoint = await addEndpoint(s, { url: hook.url });
    await start(s);
    const deliveries = async () =>
      (await s.request('GET', `/v1/webhooks/${endpoint.id}/deliveries`)).json().data;
    await waitFor(async () => (await deliveries())[0]?.status === 'failed');
    const [d] = await deliveries();
    assert.equal(d.attempts, 4, 'one attempt plus three retries');
    assert.equal(d.last_error, 'HTTP 503');
    const view = (await s.request('GET', `/v1/webhooks/${endpoint.id}`)).json();
    assert.equal(view.status.state, 'failing');
    assert.equal(view.status.consecutive_failures, 4);
    fail = false;
    const again = await s.request(
      'POST',
      `/v1/webhooks/${endpoint.id}/deliveries/${d.id}/redeliver`,
    );
    assert.equal(again.statusCode, 202);
    await waitFor(async () => (await deliveries())[0]?.status === 'succeeded');
    assert.equal(hook.hits.at(-1)!.headers['x-oaa-delivery'], d.id);
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: a receiver that never answers does not hold up the run', async () => {
  webhookTiming.timeoutMs = 300;
  const hook = await receiver(() => 'hang');
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const endpoint = await addEndpoint(s, { url: hook.url });
    const before = Date.now();
    const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    assert.equal(r.json().status, 'completed');
    assert.ok(Date.now() - before < 2_000, 'the synchronous call is not delayed by the webhook');
    let d: DeliveryRow | undefined;
    await waitFor(async () => {
      [d] = (await s.request('GET', `/v1/webhooks/${endpoint.id}/deliveries`)).json().data;
      return (d?.attempts ?? 0) >= 1;
    }, 20_000);
    assert.match(String(d!.last_error), /Timed out after 300 ms/);
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: queued deliveries continue after a gateway restart', async () => {
  webhookTiming.backoffMs = [400];
  let up = false;
  const hook = await receiver(() => (up ? 200 : 500));
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const endpoint = await addEndpoint(s, { url: hook.url });
    await start(s);
    await waitFor(() => hook.hits.length === 1);
    const deliveryId = hook.hits[0]!.headers['x-oaa-delivery'];
    await s.app.close();
    up = true;
    const again = await createGateway(s.config, s.runtime);
    await again.app.ready();
    try {
      await waitFor(() => hook.hits.length === 2);
      assert.equal(hook.hits[1]!.headers['x-oaa-delivery'], deliveryId);
      const [d] = await settled(again.app, endpoint.id, 1);
      assert.equal(d!.id, deliveryId);
      assert.equal(d!.status, 'succeeded');
    } finally {
      await again.app.close();
    }
  } finally {
    await rm(s.dir, { recursive: true, force: true });
    await hook.close();
  }
});

test('webhook: a run interrupted by a gateway restart sends run.interrupted', async () => {
  const hook = await receiver();
  const s = await writerGateway();
  try {
    const endpoint = await addEndpoint(s, { url: hook.url, events: ['run.interrupted'] });
    const runId = await start(s);
    await waitFor(() => s.store.run(runId).status === 'requires_action');
    await s.app.close();
    const again = await createGateway(s.config, s.runtime);
    await again.app.ready();
    try {
      await waitFor(() => hook.hits.length >= 1);
      assert.equal(hook.hits[0]!.json.type, 'run.interrupted');
      const data = hook.hits[0]!.json.data as { run_id: string; status: string };
      assert.equal(data.run_id, runId);
      assert.equal(data.status, 'interrupted');
      // Once everything queued for the endpoint is settled, exactly one delivery exists.
      const rows = await settled(again.app, endpoint.id, 1);
      assert.deepEqual(
        rows.map((d) => d.status),
        ['succeeded'],
        'queued once, whether at shutdown or at startup',
      );
      assert.equal(hook.hits.length, 1);
    } finally {
      await again.app.close();
    }
  } finally {
    await rm(s.dir, { recursive: true, force: true });
    await hook.close();
  }
});

test('webhook: deleting the endpoint stops deliveries; disabled endpoints get nothing', async () => {
  const hook = await receiver();
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const kept = await addEndpoint(s, { url: hook.url, description: 'disabled', enabled: false });
    const gone = await addEndpoint(s, { url: hook.url });
    assert.equal((await s.request('DELETE', `/v1/webhooks/${gone.id}`)).statusCode, 204);
    // Synchronous call: the run's events are queued (or not) before the response is returned.
    const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    assert.equal(r.json().status, 'completed');
    const queued = s.store.db.prepare('SELECT count(*) AS n FROM webhook_deliveries').get()!;
    assert.equal(Number(queued.n), 0, 'nothing is queued for a deleted or a disabled endpoint');
    assert.equal(hook.hits.length, 0);
    const listed = (await s.request('GET', `/v1/webhooks/${kept.id}/deliveries`)).json().data;
    assert.deepEqual(listed, [], 'a disabled endpoint queues nothing');
  } finally {
    await s.cleanup();
    await hook.close();
  }
});

test('webhook: test event, and include_output carries the final output', async () => {
  const hook = await receiver();
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const plain = await addEndpoint(s, { url: hook.url, events: ['run.completed'] });
    const tested = await s.request('POST', `/v1/webhooks/${plain.id}/test`);
    assert.equal(tested.statusCode, 202);
    await waitFor(() => hook.hits.length === 1);
    assert.equal(hook.hits[0]!.json.type, 'webhook.test');
    assert.ok(
      verifySignature(
        plain.secret,
        String(hook.hits[0]!.headers['x-oaa-signature']),
        hook.hits[0]!.body,
      ),
    );
    const [tested1] = await settled(s.app, plain.id, 1);
    assert.equal(tested1!.status, 'succeeded');
    await s.request('DELETE', `/v1/webhooks/${plain.id}`);

    const withOutput = await addEndpoint(s, { url: hook.url, include_output: true });
    await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    await waitFor(() => hook.hits.length === 2);
    const output = (hook.hits[1]!.json.data as { output: Record<string, unknown> }).output;
    assert.deepEqual(output, { text: 'Fixture response.', truncated: false, bytes: 17 });
    const [delivered] = await settled(s.app, withOutput.id, 1);
    assert.equal(delivered!.status, 'succeeded');
  } finally {
    await s.cleanup();
    await hook.close();
  }
});
