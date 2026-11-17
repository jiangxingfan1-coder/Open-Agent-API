import test from 'node:test';
import assert from 'node:assert/strict';
import { accountExhausted, engineQuotaExhausted } from '../src/kernel/quota-routing.js';
import { parseCodexBar } from '../src/engines/usage-parsers.js';
import { agent } from './helpers.js';
import { ModelRouter } from '../src/kernel/routing.js';

test('only fresh, unambiguous quota blocks automatic models; explicit selection remains strict', () => {
  const now = Date.now();
  const quota = parseCodexBar([
    {
      provider: 'codex',
      source: 'oauth',
      usage: {
        dataConfidence: 'percentOnly',
        updatedAt: new Date(now).toISOString(),
        primary: { usedPercent: 100, resetsAt: new Date(now + 3600000).toISOString() },
      },
    },
  ]).accounts[0]!;
  assert.ok(quota);
  assert.equal(accountExhausted(quota, now), true);
  assert.equal(engineQuotaExhausted('codex', [quota], now), true);
  assert.equal(engineQuotaExhausted('codex', [quota, { ...quota, id: 'other' }], now), false);
  assert.equal(accountExhausted({ ...quota, status: 'stale' }, now), false);
  assert.equal(accountExhausted(quota, now + 3600001), false);
  assert.equal(
    accountExhausted(
      {
        ...quota,
        windows: quota.windows.map((w) => ({ ...w, remaining_percent: 60 })),
        balance: { remaining: 0, unit: 'credits', observed_at: now, stale: false, shared: false },
      },
      now,
    ),
    false,
  );
  const router = new ModelRouter();
  router.quotaBlocked = () => true;
  const a = agent();
  assert.throws(() => router.select('owner', 'rev', a, 'auto', () => true), {
    code: 'model_unavailable',
  });
  assert.equal(router.select('owner', 'rev', a, 'default', () => true).mode, 'explicit');
});
