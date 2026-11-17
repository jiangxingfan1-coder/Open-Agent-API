import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lifecycle = require('../../desktop/cross-platform/smoke-lifecycle.cjs') as {
  waitForProcessExit(
    pid: number,
    options?: { timeoutMs?: number; pollMs?: number; isRunning?: (pid: number) => boolean },
  ): Promise<void>;
  withTimeout<T>(pending: Promise<T>, timeoutMs: number, message: string): Promise<T>;
};

test('desktop smoke waits for the desktop PID, independently of lingering automation pipes', async () => {
  let calls = 0;
  let pipeClosed = false;
  await lifecycle.waitForProcessExit(123, {
    pollMs: 1,
    isRunning: (pid) => {
      assert.equal(pid, 123);
      return ++calls < 3;
    },
  });
  assert.equal(calls, 3);
  assert.equal(pipeClosed, false);
  pipeClosed = true;
  assert.equal(await lifecycle.withTimeout(Promise.resolve(pipeClosed), 100, 'timeout'), true);
});

test('desktop smoke cannot report exit while the process is running and has bounded cleanup', async () => {
  await assert.rejects(
    lifecycle.waitForProcessExit(123, { timeoutMs: 10, pollMs: 1, isRunning: () => true }),
    /did not exit/,
  );
  await assert.rejects(lifecycle.waitForProcessExit(0), /Invalid desktop process ID/);
  await assert.rejects(
    lifecycle.withTimeout(new Promise(() => {}), 10, 'transport timeout'),
    /transport timeout/,
  );
});
