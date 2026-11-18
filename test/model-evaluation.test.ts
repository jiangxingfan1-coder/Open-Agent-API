import test from 'node:test';
import assert from 'node:assert/strict';
import { agent, setup, FixtureModel, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import {
  evaluationCases,
  scoreEvaluation,
  evaluationSettingsSchema,
} from '../src/core/model-evaluation.js';
import { ModelEvaluator, evaluationRevision } from '../src/kernel/model-evaluation.js';
import { ModelEvaluations } from '../src/store/model-evaluations.js';

test('fresh objective questions accept exact answers and reject extra fields, prose and prompt injection', () => {
  const cases = evaluationCases('first');
  assert.equal(cases.length, 10);
  assert.ok(cases.some((c) => c.dimension === 'tool_calling'));
  assert.notDeepEqual(cases, evaluationCases('second'));
  for (const c of cases) {
    assert.equal(scoreEvaluation(c, JSON.stringify(c.expected)), true, c.id);
    assert.equal(
      scoreEvaluation(c, '```json\n' + JSON.stringify(c.expected) + '\n```'),
      c.dimension === 'coding' || c.dimension === 'reasoning',
    );
    assert.equal(
      scoreEvaluation(c, JSON.stringify({ ...(c.expected as object), injected: true })),
      false,
    );
  }
});

test('evaluation is opt-in, bounded per day, persisted per revision, and used for routing', async () => {
  const s = await setup(new FixtureModel(() => ({ text: '{"wrong":true}' })));
  const evaluator = new ModelEvaluator(s.store, s.hub, s.kernel);
  try {
    const a = agent({
      routes: [
        { id: 'slow', provider: 'fixture', model: 'slow', priority: 0 },
        { id: 'accurate', provider: 'fixture', model: 'accurate', priority: 1 },
      ],
    });
    s.store.publish('owner', makeBundle(a));
    await assert.rejects(evaluator.run('owner', a.id), { code: 'scope_denied' });
    assert.equal(s.driver.calls, 0);
    evaluator.records.configure(
      'owner',
      a.id,
      evaluationSettingsSchema.parse({ enabled: true, maxCallsPerDay: 8 }),
    );
    await evaluator.run('owner', a.id);
    assert.equal(s.driver.calls, 8);
    await evaluator.run('owner', a.id);
    assert.equal(s.driver.calls, 8);
    assert.equal(
      evaluator.view('owner', a.id).routes.reduce((n, r) => n + (r.performance?.samples ?? 0), 0),
      8,
    );
    const revision = evaluationRevision(s.hub, 'owner', a);
    for (let i = 0; i < 8; i++)
      evaluator.records.save({
        owner: 'owner',
        agent: a.id,
        revision,
        route: 'accurate',
        epoch: 0,
        caseId: `good-${i}`,
        dimension: 'reasoning',
        runId: 'test-fixture',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        elapsedMs: 100,
        passed: true,
      });
    assert.equal(
      s.kernel.router.select('owner', makeBundle(a).digest, a, 'auto', () => true, undefined, {
        strategy: 'quality',
      }).id,
      'accurate',
    );
    const reloaded = new ModelEvaluations(s.store);
    assert.equal(reloaded.performance('owner', a.id, revision, 'accurate')?.score, 1);
    assert.equal(reloaded.performance('owner', a.id, 'different-revision', 'accurate'), undefined);
  } finally {
    await evaluator.close();
    await s.cleanup();
  }
});

test('evaluation management rejects remote and scoped callers; reads never start model work', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const response = await s.app.inject({
      method: 'GET',
      url: '/v1/local/evaluations?agent=agent/test',
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().settings.enabled, false);
    assert.equal(s.driver.calls, 0);
    const remote = await s.app.inject({
      method: 'GET',
      url: '/v1/local/evaluations?agent=agent/test',
      remoteAddress: '10.0.0.2',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
    });
    assert.equal(remote.statusCode, 403);
  } finally {
    await s.cleanup();
  }
});

test('evaluation settings reject stale revisions and public gateways cannot start background work', async () => {
  const s = await setup();
  const evaluator = new ModelEvaluator(s.store, s.hub, s.kernel, false);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
    const result = await s.app.inject({
      method: 'POST',
      url: '/v1/local/evaluations/settings',
      remoteAddress: '127.0.0.1',
      headers,
      payload: { agent: 'agent/test', revision: '0'.repeat(64), settings: { enabled: true } },
    });
    assert.equal(result.statusCode, 409);
    assert.equal(s.driver.calls, 0);
    await assert.rejects(evaluator.run('owner', 'agent/test'), { code: 'scope_denied' });
  } finally {
    await evaluator.close();
    await s.cleanup();
  }
});
