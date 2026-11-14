import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { AcpTimings } from '../src/engines/acp.js';
import { setup } from './helpers.js';

// 真实联调发现的问题（docs/evidence.md）：ACP 智能体上报全零用量。
// 只用 test/fixtures 里的假智能体；经 app.inject 驱动网关，不监听端口。

const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };

test('acp: all-zero reported usage is treated as unknown, not as 0 tokens', async () => {
  const s = await setup();
  try {
    const entry = () => ({
      transport: 'acp' as const,
      command: process.execPath,
      args: [path.resolve('test/fixtures/acp-agent.mjs'), 'stream'],
      enabled: true,
    });
    s.config.localWorker!.adapters.zero = entry();
    s.runtime.config.adapters.zero = entry();
    s.runtime.acpTimings = fast;
    const published = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/zero',
      engine: 'adapter/zero',
      models: ['default'],
    });
    assert.equal(published.statusCode, 200, published.body);
    const r = await s.request('POST', '/v1/compat/chat/completions', {
      model: 'agent/zero',
      messages: [{ role: 'user', content: 'MODE:zero-usage MARKER:z' }],
    });
    assert.equal(r.statusCode, 200, r.body);
    const run = s.store.run(r.headers['x-run-id'] as string);
    assert.equal(run.status, 'completed');
    assert.equal(run.usage, null);
    assert.equal(run.metadata['oaa.usage_complete'], 'false');
    assert.equal(r.json().usage, undefined, 'no invented zero usage');
    assert.ok(!r.body.includes('prompt_tokens'));
  } finally {
    await s.cleanup();
  }
});
