import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, FixtureModel, waitFor } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { sleep } from '../src/core/util.js';
import { durability } from '../src/kernel/durability.js';

test('durable workspace tasks automatically resume after restart without replaying completed writes', async () => {
  const driver = new FixtureModel(async (_a, messages, signal) => {
    if (messages.some((m) => m.role === 'tool')) {
      await sleep(10000, signal);
      return { text: 'late' };
    }
    return {
      calls: [
        {
          id: 'write',
          name: 'write_file',
          arguments: { path: 'saved.txt', content: 'exactly once' },
        },
      ],
    };
  });
  const s = await setup(driver);
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ tools: [builtin('write_file')], limits: { timeoutMs: 172800000 } })),
    );
    const response = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Long work',
      background: true,
      metadata: { 'oaa.durable': 'true' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().id;
    await waitFor(() => driver.calls === 2);
    const deadline = s.store.run(id).checkpoint.durability!.deadlineAt;
    assert.equal(s.store.steps(id).filter((s) => s.status === 'completed').length, 1);
    await s.app.close();
    const nextDriver = new FixtureModel(() => ({ text: 'Recovered without repeating the write.' }));
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', nextDriver]])),
    );
    await next.listen();
    const done = await next.kernel.wait(id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.checkpoint.durability?.attempts, 1);
    assert.equal(done.checkpoint.deadlineAt, deadline);
    assert.equal(done.artifactIds.length, 1);
    assert.equal(nextDriver.calls, 1);
    assert.equal(next.store.steps(id).length, 1);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});

test('durable policy preserves publication ceilings and caps restart retries', () => {
  const a = agent({ limits: { timeoutMs: 172800000 } });
  const p = durability(a, { 'oaa.durable': 'true' })!;
  assert.ok(p.deadlineAt > Date.now() + 86400000);
  assert.equal(p.maxAttempts, 10);
  assert.throws(() => durability(a, { 'oaa.durable': 'true', 'oaa.timeout_ms': '9999999999' }), {
    code: 'invalid_request',
  });
  assert.throws(() => durability(a, { 'oaa.durable': 'true', 'oaa.max_resume_attempts': '1000' }), {
    code: 'invalid_request',
  });
});
