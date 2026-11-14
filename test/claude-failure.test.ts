import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, copyFile } from 'node:fs/promises';
import { setup } from './helpers.js';

// 真实联调发现的问题（docs/evidence.md）：Claude Code 未登录或失败时的原因。
// 只用 test/fixtures 里的假智能体；经 app.inject 驱动网关，不监听端口。

type Gateway = Awaited<ReturnType<typeof setup>>;

async function claudeSetup() {
  const s = await setup();
  const cli = path.join(s.dir, 'claude-code.mjs');
  await copyFile(path.resolve('test/fixtures/claude-code.mjs'), cli);
  await chmod(cli, 0o755);
  const entry = () => ({ executable: cli, enabled: true, args: [] });
  s.config.localWorker!.native.claude = entry() as never;
  s.runtime.config.native.claude = entry() as never;
  const published = await s.request('POST', '/v1/agents/publish-native', {
    id: 'agent/claude',
    engine: 'claude',
    models: ['default'],
  });
  assert.equal(published.statusCode, 200, published.body);
  return s;
}
const invoke = (s: Gateway, agent: string, input: string) =>
  s.request('POST', '/v1/invoke', { protocol: 'oaa/1', agent, input });

test('claude: a missing login is reported as adapter_auth_required with the CLI reason', async () => {
  const s = await claudeSetup();
  try {
    const r = await invoke(s, 'agent/claude', 'Hi MODE:not-logged-in');
    const run = s.store.run(r.json().id);
    assert.equal(run.status, 'failed', r.body);
    assert.equal(run.error?.code, 'adapter_auth_required');
    assert.match(run.error!.message, /Not logged in · Please run \/login/);
  } finally {
    await s.cleanup();
  }
});

test('claude: other failures stay native_incomplete and carry the redacted, bounded reason', async () => {
  const s = await claudeSetup();
  try {
    const failed = s.store.run((await invoke(s, 'agent/claude', 'Break MODE:fail')).json().id);
    assert.equal(failed.error?.code, 'native_incomplete');
    assert.match(failed.error!.message, /fixture failure/);
    const secret = s.store.run((await invoke(s, 'agent/claude', 'MODE:error-secret')).json().id);
    assert.equal(secret.error?.code, 'native_incomplete');
    assert.match(secret.error!.message, /boom token=\[REDACTED\]/);
    assert.ok(!secret.error!.message.includes('fixture-secret-value-123456'));
    assert.ok(!secret.error!.message.includes('x'.repeat(241)), 'reason is bounded');
  } finally {
    await s.cleanup();
  }
});
