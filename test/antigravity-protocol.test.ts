import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNative } from '../src/engines/native.js';
import { workerSchema } from '../src/config/config.js';
import { setup, agent } from './helpers.js';

test('Antigravity confirms the explicit model before accepting a correctly framed prompt and reports observed usage', async () => {
  const s = await setup();
  try {
    const config = workerSchema.parse({
      nodeId: 'fixture',
      dataDir: s.dir,
      native: {
        antigravity: {
          enabled: true,
          executable: process.execPath,
          args: [path.resolve('test/fixtures/native-agent.mjs'), 'agy'],
        },
      },
    });
    const definition = agent({ engine: 'antigravity', model: 'gemini-3.8-flash-low' });
    const progress: Record<string, unknown>[] = [];
    const first = await runNative(
      definition,
      config,
      s.dir,
      'A bounded local protocol fixture.',
      AbortSignal.timeout(5000),
      async (event) => {
        if (event.type === 'progress') progress.push(event.data);
      },
    );
    assert.match(first.text, /Antigravity fixture output/);
    assert.equal(first.nativeState.observedModel, definition.model);
    assert.equal(progress[0]?.event, 'initialized');
    assert.equal(progress[0]?.model, definition.model);
    assert.deepEqual(first.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    const next = await runNative(
      definition,
      config,
      s.dir,
      'Explicit continuation fixture.',
      AbortSignal.timeout(5000),
      async () => {},
      first.nativeState,
    );
    assert.equal(
      next.usage,
      null,
      'Session-cumulative totals must not masquerade as per-call usage.',
    );
    assert.deepEqual(next.nativeState.observedUsage, first.usage);
  } finally {
    await s.cleanup();
  }
});

test('Antigravity cannot silently use a different or unreported model for an explicit route', async () => {
  const s = await setup();
  try {
    for (const mode of ['agy-wrong-model', 'agy-no-model']) {
      const config = workerSchema.parse({
        nodeId: 'fixture',
        dataDir: s.dir,
        native: {
          antigravity: {
            enabled: true,
            executable: process.execPath,
            args: [path.resolve('test/fixtures/native-agent.mjs'), mode],
          },
        },
      });
      await assert.rejects(
        () =>
          runNative(
            agent({ engine: 'antigravity', model: 'gemini-3.8-flash-low' }),
            config,
            s.dir,
            'This prompt must not be sent.',
            AbortSignal.timeout(5000),
            async () => {},
          ),
        /no prompt was sent/,
      );
    }
  } finally {
    await s.cleanup();
  }
});
