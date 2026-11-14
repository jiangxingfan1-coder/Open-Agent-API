import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { workerSchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { runNative } from '../src/engines/native.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { setup, FixtureModel, agent, principal, waitFor } from './helpers.js';
import { sleep } from '../src/core/util.js';
import { Store } from '../src/store/store.js';
import { token } from './helpers.js';

test('graceful shutdown aborts active work before waiting for SSE connections to close', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(10000, signal);
      return { text: 'late' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();
    const response = await fetch(url + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'agent/test', input: 'long task', stream: true }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    const deadline = setTimeout(() => {
      void reader.cancel();
    }, 2500);
    const start = Date.now();
    try {
      await s.app.close();
      assert.ok(Date.now() - start < 2000, 'Shutdown must not wait for the long model task.');
    } finally {
      clearTimeout(deadline);
      await reader.cancel().catch(() => {});
    }
  } finally {
    await s.cleanup();
  }
});

test('a second gateway cannot recover or mutate live runs in the same data directory', async () => {
  const s = await setup();
  try {
    assert.throws(() => new Store(s.config.dataDir), /Another gateway/);
    assert.equal((await s.request('GET', '/v1/agents')).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});
test('failed gateway initialization releases its node resources and data-directory lease', async () => {
  const s = await setup();
  let closed = false;
  try {
    const config = {
      ...s.config,
      dataDir: path.join(s.dir, 'failed-init'),
      tls: { keyFile: path.join(s.dir, 'missing.key'), certFile: path.join(s.dir, 'missing.cert') },
    };
    await assert.rejects(
      () =>
        createGateway(config, {
          advertisement: () => s.runtime.advertisement(),
          install: async () => {},
          execute: async () => {
            throw new Error('No execution is expected during initialization.');
          },
          close: async () => {
            closed = true;
          },
        }),
      /ENOENT/,
    );
    assert.equal(closed, true);
    const store = new Store(config.dataDir);
    store.close();
  } finally {
    await s.cleanup();
  }
});

test('gateway restart resumes a confirmed checkpoint without replaying completed tools', async () => {
  const driver = new FixtureModel(async (_a, m, signal) => {
    if (m.some((x) => x.role === 'tool')) {
      await sleep(5000, signal);
      return { text: 'done' };
    }
    return {
      calls: [
        {
          id: 'written',
          name: 'write_file',
          arguments: { path: 'checkpoint.txt', content: 'completed exactly once in this fixture' },
        },
      ],
    };
  });
  const s = await setup(driver);
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [builtin('write_file')] })));
    const req = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'create',
      background: true,
    });
    const runId = req.json().id;
    await waitFor(() => driver.calls === 2);
    assert.equal(s.store.steps(runId)[0]?.status, 'completed');
    await s.app.close();
    const nextDriver = new FixtureModel(() => ({
      text: 'Resumed after confirmed tool completion.',
    }));
    const runtime = new WorkerRuntime(
      s.config.localWorker!,
      new Map(),
      new Map([['fixture', nextDriver]]),
    );
    replacement = await createGateway(s.config, runtime);
    assert.equal(replacement.store.run(runId).status, 'interrupted');
    replacement.kernel.resume(principal, runId);
    const done = await replacement.kernel.wait(runId);
    assert.equal(done.status, 'completed');
    assert.equal(replacement.store.steps(runId).length, 1);
    assert.equal(done.artifactIds.length, 1);
    assert.equal(nextDriver.calls, 1);
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});
test('output schema violations are not reported as successful responses', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'not JSON' })));
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ outputSchema: { type: 'object', required: ['answer'] } })),
    );
    const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'answer' });
    assert.equal(r.json().status, 'failed');
    assert.equal(r.json().error.code, 'output_contract');
  } finally {
    await s.cleanup();
  }
});
test('tool and turn limits produce explicit incomplete results', async () => {
  const s = await setup(
    new FixtureModel(() => ({ calls: [{ id: 'list', name: 'list_files', arguments: {} }] })),
  );
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [builtin('list_files')],
          limits: {
            maxTurns: 1,
            maxOutputTokens: 100,
            timeoutMs: 5000,
            toolConcurrency: 1,
            maxTotalTokens: 1000,
          },
        }),
      ),
    );
    const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'loop' });
    assert.equal(r.json().status, 'incomplete');
    assert.equal(r.json().incomplete_details.reason, 'turn_limit');
    assert.equal(s.driver.calls, 1);
  } finally {
    await s.cleanup();
  }
});
test('published native adapters invoke only their owned subprocesses (protocol fixtures, no real provider)', async () => {
  const s = await setup();
  const fixture = path.resolve('test/fixtures/native-agent.mjs');
  try {
    for (const engine of ['codex', 'antigravity'] as const) {
      const cfg = workerSchema.parse({
        nodeId: 'local',
        dataDir: s.dir,
        native: {
          [engine]: {
            executable: process.execPath,
            enabled: true,
            args: [fixture, engine === 'codex' ? 'codex' : 'agy'],
          },
        },
      });
      const messages: string[] = [];
      const result = await runNative(
        agent({ engine, model: 'default' }),
        cfg,
        s.dir,
        'A fixture task',
        AbortSignal.timeout(5000),
        async (event) => {
          if (event.type === 'text') messages.push(String(event.data.delta));
        },
      );
      assert.match(result.text, /fixture output/);
      assert.ok(messages.length > 0);
    }
  } finally {
    await s.cleanup();
  }
});
test('Antigravity exit code zero cannot mask a denied operation', async () => {
  const s = await setup();
  try {
    const cfg = workerSchema.parse({
      nodeId: 'local',
      dataDir: s.dir,
      native: {
        antigravity: {
          executable: process.execPath,
          enabled: true,
          args: [path.resolve('test/fixtures/native-agent.mjs'), 'agy-denied'],
        },
      },
    });
    await assert.rejects(
      () =>
        runNative(
          agent({ engine: 'antigravity', model: 'default' }),
          cfg,
          s.dir,
          'task',
          AbortSignal.timeout(5000),
          async () => {},
        ),
      /denied/,
    );
  } finally {
    await s.cleanup();
  }
});
test('DSH unsupported model override fails before spawning or changing native config', async () => {
  const s = await setup();
  try {
    const cfg = workerSchema.parse({
      nodeId: 'local',
      dataDir: s.dir,
      native: { dsh: { executable: '/must-not-execute', enabled: true } },
    });
    await assert.rejects(
      () =>
        runNative(
          agent({ engine: 'dsh', model: 'unconfigured-model' }),
          cfg,
          s.dir,
          'task',
          AbortSignal.timeout(5000),
          async () => {},
        ),
      /owner-configured model overlay/,
    );
  } finally {
    await s.cleanup();
  }
});
test('event replay resumes strictly after the requested event ID', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hello' });
    const events = s.store.history(r.json().id);
    const after = events[2]!.id;
    const stream = await s.request('GET', `/v1/runs/${r.json().id}/events?after=${after}`);
    const ids = stream.body
      .split('\n')
      .filter((l) => l.startsWith('id: '))
      .map((l) => Number(l.slice(4)));
    assert.ok(ids.length > 0);
    assert.ok(ids.every((id) => id > after));
  } finally {
    await s.cleanup();
  }
});
