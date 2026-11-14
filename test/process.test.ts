import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProcess } from '../src/engines/process.js';
import { setup } from './helpers.js';

test('owned process output preserves fragmented multibyte UTF-8', async () => {
  const script =
    "const b=Buffer.from('\\u4f60\\u597d, Agent'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),15);";
  const result = await collectProcess(
    process.execPath,
    ['-e', script],
    process.cwd(),
    '',
    AbortSignal.timeout(3000),
  );
  assert.equal(result, '\u4f60\u597d, Agent');
});
test('over-limit owned subprocesses cannot grow output indefinitely or ignore termination', async () => {
  const script =
    "process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(131072)),1);";
  await assert.rejects(
    () =>
      collectProcess(
        process.execPath,
        ['-e', script],
        process.cwd(),
        '',
        AbortSignal.timeout(5000),
      ),
    /exceeds 2 MiB/,
  );
});
test('native enablement is explicit and does not call the provider', async () => {
  const s = await setup();
  try {
    s.config.localWorker!.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.runtime.config.native.codex = { executable: process.execPath, enabled: false, args: [] };
    const before = await s.request('GET', '/v1/local/backends');
    assert.equal(
      before.json().data.find((b: { engine: string }) => b.engine === 'codex').enabled,
      false,
    );
    const enable = await s.request('POST', '/v1/local/backends/codex', { enabled: true });
    assert.equal(enable.json().enabled, true);
    assert.equal(enable.json().global_agent_configuration_changed, false);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});
