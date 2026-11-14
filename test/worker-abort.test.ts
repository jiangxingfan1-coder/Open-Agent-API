import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeBundle } from '../src/lang/bundle.js';
import { workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { faultOf } from '../src/core/util.js';
import { FixtureModel, agent } from './helpers.js';

// 取消落在 worker 准备工作区（异步 I/O）期间时，不应再把一个已中止的 signal 交给模型驱动：
// 只监听 'abort' 事件的驱动永远等不到事件，取消方 `await task` 就会一直挂着（CI 偶发卡死的根因）。
test(
  'a cancel during workspace preparation never reaches the model driver',
  { timeout: 10_000 },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-worker-abort-'));
    const gate = Promise.withResolvers<void>();
    const model = new FixtureModel(async (_a, _m, signal) => {
      // 故意只听事件、不看 signal.aborted：与容易漏掉“已中止”的驱动写法一致。
      await Promise.race([
        gate.promise,
        new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      ]);
      return { text: 'late' };
    });
    const runtime = new WorkerRuntime(
      workerSchema.parse({ nodeId: 'w', dataDir }),
      new Map(),
      new Map([['fixture', model]]),
    );
    try {
      const bundle = makeBundle(agent());
      await runtime.install(bundle);
      const controller = new AbortController();
      const running = runtime.execute(
        {
          kind: 'model',
          agent: bundle.agent,
          messages: [{ role: 'user', content: 'x' }],
          context: { runId: 'r', sessionId: 's', owner: 'owner', digest: bundle.digest, files: [] },
        },
        controller.signal,
        async () => {},
      );
      // execute 已同步越过入口处的检查，正停在工作区准备的 await 上。
      controller.abort();
      await assert.rejects(running, (e) => faultOf(e).code === 'cancelled');
      assert.equal(model.calls, 0);
    } finally {
      gate.resolve();
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
