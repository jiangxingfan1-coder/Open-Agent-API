// 可重试的 429 给出真实的等待秒数。进程内，不监听端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle } from '../src/lang/bundle.js';
import { setup, agent, principal } from './helpers.js';

test('rate_limited answers Retry-After with the seconds left in the current window', async (t) => {
  const s = await setup();
  try {
    const limited = String(s.auth.create(principal, 'rpm-key', ['*'], ['read'], { rpm: 1 }).token);
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    assert.equal((await s.request('GET', '/v1/models', undefined, limited)).statusCode, 200);
    t.mock.timers.tick(45_200);
    const limitedNow = await s.request('GET', '/v1/models', undefined, limited);
    assert.equal(limitedNow.statusCode, 429);
    assert.equal(limitedNow.json().error.code, 'rate_limited');
    assert.equal(limitedNow.headers['retry-after'], '15');
    t.mock.timers.tick(14_000);
    assert.equal(
      (await s.request('GET', '/v1/models', undefined, limited)).headers['retry-after'],
      '1',
    );
    t.mock.timers.tick(1_000);
    assert.equal((await s.request('GET', '/v1/models', undefined, limited)).statusCode, 200);
  } finally {
    t.mock.timers.reset();
    await s.cleanup();
  }
});

test('exhausted key quotas stay 429 but tell official SDKs not to retry', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const quota = String(
      s.auth.create(principal, 'run-quota', ['*'], ['read', 'invoke'], { maxRuns: 1 }).token,
    );
    const body = { model: 'agent/test', messages: [{ role: 'user', content: 'x' }] };
    const first = await s.request('POST', '/v1/chat/completions', body, quota);
    assert.equal(first.statusCode, 200);
    const exhausted = await s.request('POST', '/v1/chat/completions', body, quota);
    assert.equal(exhausted.statusCode, 429);
    assert.equal(exhausted.json().error.code, 'run_quota_exceeded');
    assert.equal(exhausted.headers['x-should-retry'], 'false');
    assert.equal(exhausted.headers['retry-after'], undefined);
  } finally {
    await s.cleanup();
  }
});
