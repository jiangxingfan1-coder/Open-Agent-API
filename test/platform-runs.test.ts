import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, call, keysOf, newKey, signup, withPlatform, type Setup } from './platform-http.js';

// Developer platform (0.5.0) task records in the portal: list from the ledger, detail from the
// run itself read under the account's subject. In-process inject only.

const ITEM_KEYS = ['agent', 'charge', 'created_at', 'id', 'status', 'tokens'];
const DETAIL_KEYS = [
  'agent',
  'charge',
  'completed_at',
  'created_at',
  'error',
  'id',
  'output_text',
  'price',
  'status',
  'timeline',
  'usage',
];

async function priced(s: Setup) {
  for (const [agent_id, price] of [
    ['agent/paid', { per_run: 1, per_1k_tokens: 0 }],
    ['agent/free', { per_run: 0, per_1k_tokens: 0 }],
  ] as const) {
    const r = await call(s, 'PUT', '/v1/platform/listings', { agent_id, price }, ADMIN);
    assert.equal(r.statusCode, 200, r.body);
  }
}
async function funded(s: Setup, email: string) {
  const dev = await signup(s, email);
  const credit = await call(
    s,
    'POST',
    `/v1/platform/accounts/${dev.account.id}/credit`,
    { amount: 10, note: 'seed' },
    ADMIN,
  );
  assert.equal(credit.statusCode, 200, credit.body);
  const key = await newKey(s, dev.session);
  return { ...dev, key: key.token as string };
}
async function run(s: Setup, key: string, model = 'agent/paid') {
  const r = await s.request('POST', '/v1/responses', { model, input: 'hi' }, key);
  assert.equal(r.json().status, 'completed', r.body);
  return r.json() as { id: string; usage: Record<string, unknown> };
}

test('portal runs: list is newest first, filters by agent and pages by cursor', async () => {
  await withPlatform({}, async (s) => {
    await priced(s);
    const dev = await funded(s, 'a@x.io');
    const first = await run(s, dev.key);
    const second = await run(s, dev.key, 'agent/free');
    const third = await run(s, dev.key);
    const list = await call(s, 'GET', '/v1/portal/runs', undefined, dev.session);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(keysOf(list.json()), ['data', 'next_cursor']);
    assert.deepEqual(
      list.json().data.map((r: { id: string }) => r.id),
      [third.id, second.id, first.id],
    );
    const item = list.json().data[0];
    assert.deepEqual(keysOf(item), ITEM_KEYS);
    assert.equal(item.agent, 'agent/paid');
    assert.equal(item.status, 'completed');
    assert.equal(item.charge, 1);
    assert.equal(item.tokens, 15);
    assert.equal(typeof item.created_at, 'number');
    assert.equal(list.json().next_cursor, null);
    const paid = await call(s, 'GET', '/v1/portal/runs?agent=agent%2Fpaid', undefined, dev.session);
    assert.deepEqual(
      paid.json().data.map((r: { id: string }) => r.id),
      [third.id, first.id],
    );
    const page1 = await call(s, 'GET', '/v1/portal/runs?limit=2', undefined, dev.session);
    assert.equal(page1.json().data.length, 2);
    assert.equal(typeof page1.json().next_cursor, 'number');
    const page2 = await call(
      s,
      'GET',
      `/v1/portal/runs?limit=2&cursor=${page1.json().next_cursor}`,
      undefined,
      dev.session,
    );
    assert.deepEqual(
      page2.json().data.map((r: { id: string }) => r.id),
      [first.id],
    );
    assert.equal(page2.json().next_cursor, null);
    const bad = await call(s, 'GET', '/v1/portal/runs?limit=0', undefined, dev.session);
    assert.equal(bad.statusCode, 400);
    assert.equal((await call(s, 'GET', '/v1/portal/runs')).statusCode, 401);
    // An API key is not a portal session.
    const withKey = await call(s, 'GET', '/v1/portal/runs', undefined, dev.key);
    assert.equal(withKey.json().error.code, 'session_invalid');
  });
});

test('portal runs: detail carries the run, its price and the same timeline as /v1/runs', async () => {
  await withPlatform({}, async (s) => {
    await priced(s);
    const dev = await funded(s, 'a@x.io');
    const done = await run(s, dev.key);
    const r = await call(s, 'GET', `/v1/portal/runs/${done.id}`, undefined, dev.session);
    assert.equal(r.statusCode, 200, r.body);
    const detail = r.json();
    assert.deepEqual(keysOf(detail), DETAIL_KEYS);
    assert.equal(detail.id, done.id);
    assert.equal(detail.agent, 'agent/paid');
    assert.equal(detail.status, 'completed');
    assert.equal(detail.charge, 1);
    assert.deepEqual(detail.price, { per_run: 1, per_1k_tokens: 0 });
    assert.equal(detail.error, null);
    assert.deepEqual(detail.usage, s.store.run(done.id).usage);
    assert.equal(typeof detail.created_at, 'number');
    assert.ok(detail.completed_at >= detail.created_at);
    const txt = await s.request('GET', `/v1/runs/${done.id}/output.txt`, undefined, dev.key);
    assert.equal(detail.output_text, txt.body);
    assert.ok(detail.output_text.length > 0);
    const timeline = await s.request('GET', `/v1/runs/${done.id}/timeline`, undefined, dev.key);
    // Same computation; only `now` (the moment of each request) differs.
    assert.equal(typeof detail.timeline.now, 'number');
    assert.deepEqual({ ...detail.timeline, now: 0 }, { ...timeline.json(), now: 0 });
    // A later price change does not rewrite the recorded price.
    await call(
      s,
      'PUT',
      '/v1/platform/listings',
      { agent_id: 'agent/paid', price: { per_run: 5 } },
      ADMIN,
    );
    const again = await call(s, 'GET', `/v1/portal/runs/${done.id}`, undefined, dev.session);
    assert.deepEqual(again.json().price, { per_run: 1, per_1k_tokens: 0 });
  });
});

test('portal runs: another account, unknown IDs and owner runs are run_not_found', async () => {
  await withPlatform({}, async (s) => {
    await priced(s);
    const a = await funded(s, 'a@x.io');
    const b = await funded(s, 'b@x.io');
    const mine = await run(s, a.key);
    const owners = await run(s, ADMIN);
    for (const id of [mine.id, owners.id, 'resp_missing']) {
      const r = await call(s, 'GET', `/v1/portal/runs/${id}`, undefined, b.session);
      assert.equal(r.statusCode, 404, id);
      assert.equal(r.json().error.code, 'run_not_found', id);
    }
    const list = await call(s, 'GET', '/v1/portal/runs', undefined, b.session);
    assert.deepEqual(list.json().data, []);
  });
});

test('portal runs: a purged run falls back to its ledger row', async () => {
  await withPlatform({}, async (s) => {
    await priced(s);
    const dev = await funded(s, 'a@x.io');
    const done = await run(s, dev.key);
    s.store.db.exec('PRAGMA foreign_keys=OFF');
    s.store.db.prepare('DELETE FROM runs WHERE id=?').run(done.id);
    const r = await call(s, 'GET', `/v1/portal/runs/${done.id}`, undefined, dev.session);
    assert.equal(r.statusCode, 200, r.body);
    const detail = r.json();
    assert.deepEqual(keysOf(detail), DETAIL_KEYS);
    assert.equal(detail.status, 'completed');
    assert.equal(detail.charge, 1);
    assert.deepEqual(detail.price, { per_run: 1, per_1k_tokens: 0 });
    assert.equal(detail.timeline, null);
    assert.equal(detail.output_text, '');
    assert.equal(detail.usage, null);
    assert.equal(detail.error, null);
    assert.equal(detail.completed_at, null);
  });
});
