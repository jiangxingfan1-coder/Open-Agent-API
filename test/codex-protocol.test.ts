import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNative } from '../src/engines/native.js';
import { workerSchema } from '../src/config/config.js';
import { setup, agent } from './helpers.js';

async function run(mode: string, state?: Record<string, unknown>) {
  const s = await setup();
  const events: string[] = [];
  try {
    const config = workerSchema.parse({
      nodeId: 'fixture',
      dataDir: s.dir,
      native: {
        codex: {
          enabled: true,
          executable: process.execPath,
          args: [path.resolve('test/fixtures/codex-protocol.mjs'), mode],
        },
      },
    });
    const result = await runNative(
      agent({
        engine: 'codex',
        model: 'test-model',
        ...(mode === 'auto-policy' ? { approvals: 'auto' } : {}),
      }),
      config,
      s.dir,
      'Only a fixture.',
      AbortSignal.timeout(8000),
      async (event) => {
        if (mode === 'elicitation' && event.type === 'approval') return { decision: 'approve' };
        if (mode === 'late-rejection' && event.type === 'text') {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('delayed persistence failure');
        }
        if (mode === 'early-exit' && event.type === 'text')
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.notEqual(event.type, 'approval', 'foreign approvals must not reach the owner');
        if (event.type === 'text') events.push(String(event.data.delta));
        return undefined;
      },
      state,
    );
    assert.equal(events.join(''), 'OK');
    return result;
  } finally {
    await s.cleanup();
  }
}

test('Codex scopes events, deduplicates snapshots and records per-turn usage', async () => {
  const result = await run('normal');
  assert.equal(result.text, 'OK');
  assert.equal(result.nativeState.observedModel, 'test-model');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
});
test('Codex automatic approval applies only to its explicitly authorized thread', async () => {
  assert.equal((await run('auto-policy')).text, 'OK');
});
test('Codex accepts completed message snapshots without deltas', async () => {
  assert.equal((await run('snapshot')).text, 'OK');
});
test('Codex bridges thread-scoped MCP elicitation only within the active turn', async () => {
  assert.equal((await run('elicitation')).text, 'OK');
});
test('Codex resume subtracts previous cumulative usage instead of billing history twice', async () => {
  const result = await run('normal', {
    threadId: 'thread',
    observedUsage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  });
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 2, total_tokens: 9 });
  assert.equal((await run('normal', { threadId: 'thread' })).usage, null);
});
test('Codex rejects silent model fallback before prompting', async () => {
  await assert.rejects(run('wrong-model'), { code: 'model_not_supported' });
});
test('Codex preserves actionable upstream failures', async () => {
  await assert.rejects(run('rpc-error'), /thread\/start: model unavailable/);
  await assert.rejects(run('failed'), /upstream overloaded/);
});
test('Codex shuts down its own completed but lingering app-server', async () => {
  assert.equal((await run('linger')).text, 'OK');
});
test('Codex completion waits for delayed output persistence', async () => {
  await assert.rejects(run('late-rejection'), /delayed persistence failure/);
  assert.equal((await run('early-exit')).text, 'OK');
});
