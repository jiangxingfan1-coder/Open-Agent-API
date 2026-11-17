import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { ModelEvaluations } from '../src/store/model-evaluations.js';

test('explicit task ratings are identity-bound, deduplicated, private, and do not consume evaluation calls', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
    const request = (run_id: string, passed: boolean, remoteAddress = '127.0.0.1') =>
      s.app.inject({
        method: 'POST',
        url: '/v1/local/evaluations/feedback',
        headers,
        remoteAddress,
        payload: { run_id, passed },
      });
    let last = '';
    for (let i = 0; i < 4; i++) {
      const started = await s.request('POST', '/v1/responses', {
        model: 'agent/test',
        input: `PRIVATE_TASK_MARKER ${i}`,
      });
      last = started.json().id;
      const rated = await request(last, true);
      assert.equal(rated.statusCode, 200, rated.body);
    }
    const again = await request(last, false);
    assert.equal(again.json().performance.samples, 4);
    assert.equal(again.json().performance.score, 0.75);
    assert.equal(again.json().performance.sources.feedback, 4);
    const records = new ModelEvaluations(s.store);
    assert.equal(records.callsToday('owner', 'agent/test'), 0);
    const stored = s.store
      .prepare('SELECT payload FROM model_feedback')
      .all()
      .map((r) => String(r.payload))
      .join('');
    assert.equal(stored.includes('PRIVATE_TASK_MARKER'), false);
    assert.equal((await request(last, true, '10.0.0.1')).statusCode, 403);
    const before = s.store.run(last).checkpoint.modelIdentity;
    s.store.publish('owner', makeBundle(agent({ instructions: 'Changed publication identity.' })));
    const view = await s.app.inject({
      method: 'GET',
      url: '/v1/local/evaluations?agent=agent/test',
      headers,
      remoteAddress: '127.0.0.1',
    });
    assert.notEqual(view.json().revision, before);
    assert.equal(view.json().routes[0].performance, null);
  } finally {
    await s.cleanup();
  }
});
