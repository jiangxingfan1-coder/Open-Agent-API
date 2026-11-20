import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, FixtureModel, waitFor } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { sleep } from '../src/core/util.js';
import { durability } from '../src/kernel/durability.js';
import { indexRecoveryCandidates, recoveryCandidates } from '../src/store/recovery-candidates.js';
import { DatabaseSync } from 'node:sqlite';

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
    const admitted: { attempts: number | undefined; marker: string | undefined }[] = [];
    const db = next.store;
    db.events.on('summary', (event: { runId: string; status: string }) => {
      if (event.runId === id && event.status === 'queued') {
        const persisted = db.run(id);
        admitted.push({
          attempts: persisted.checkpoint.durability?.attempts,
          marker: persisted.metadata['oaa.recovery'],
        });
      }
    });
    await next.listen();
    const done = await next.kernel.wait(id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.checkpoint.durability?.attempts, 1);
    assert.equal(done.checkpoint.deadlineAt, deadline);
    assert.equal(done.artifactIds.length, 1);
    assert.equal(nextDriver.calls, 1);
    assert.equal(next.store.steps(id).length, 1);
    assert.deepEqual(admitted, [{ attempts: 1, marker: 'resumed' }]);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});

test('startup visits only durable interruption candidates in row order while requeue writes change the index', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,payload TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO runs VALUES(?,?,?)');
    insert.run('old-invalid', 'interrupted', 'legacy-invalid');
    const expected: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const status = i % 2 ? 'completed' : 'interrupted',
        durable = i % 3 === 0,
        eligibleError = i % 5 !== 0;
      const code = eligibleError
        ? ['gateway_restarted', 'shutting_down', 'cancelled'][Math.floor(i / 3) % 3]
        : 'effect_outcome_unknown';
      insert.run(
        'run' + i,
        status,
        JSON.stringify({
          checkpoint: durable ? { durability: { attempts: 0 } } : {},
          error: { code },
        }),
      );
      if (status === 'interrupted' && durable && eligibleError) expected.push('run' + i);
    }
    indexRecoveryCandidates(db);
    const visited: string[] = [];
    for (const id of recoveryCandidates(db)) {
      visited.push(id);
      db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(id);
    }
    assert.ok(expected.length > 128);
    assert.deepEqual(visited, expected);
    assert.deepEqual([...recoveryCandidates(db)], []);
  } finally {
    db.close();
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
