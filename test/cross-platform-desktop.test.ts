import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const core = require('../../desktop/cross-platform/core.cjs') as {
  dataDirectory(platform: string, env: Record<string, string>, home: string): string;
  localConfiguration(config: Record<string, unknown>): string;
  externalURL(url: string): boolean;
  trustedFrame(event: unknown, window: unknown, origin: string): boolean;
  privateToken(file: string): Promise<string>;
};
test('desktop paths and local bootstrap never turn remote or public configurations into an administrator window', () => {
  assert.equal(
    core.dataDirectory('win32', { LOCALAPPDATA: 'C:\\Data' }, 'C:\\Users\\A'),
    'C:\\Data\\OpenAgentAPI',
  );
  assert.equal(
    core.dataDirectory('linux', { XDG_DATA_HOME: '/data' }, '/home/a'),
    '/data/OpenAgentAPI',
  );
  assert.equal(
    core.dataDirectory('linux', { XDG_DATA_HOME: 'relative' }, '/home/a'),
    '/home/a/.local/share/OpenAgentAPI',
  );
  assert.equal(core.localConfiguration({ port: 8787 }), 'http://127.0.0.1:8787');
  assert.equal(core.localConfiguration({ host: '::1', port: 8787 }), 'http://[::1]:8787');
  for (const config of [
    { host: '0.0.0.0' },
    { security: { profile: 'public' } },
    { tls: {} },
    { port: 0 },
  ])
    assert.throws(() => core.localConfiguration(config));
  assert.equal(core.externalURL('https://github.com/openai'), true);
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://example.com',
    'https://github.com@evil.com',
    'http://github.com',
  ])
    assert.equal(core.externalURL(url), false);
});
test('desktop IPC requires its exact top frame, web contents and private origin', () => {
  const frame = { url: 'http://127.0.0.1:8787/' },
    contents = { mainFrame: frame },
    window = { webContents: contents };
  assert.equal(
    core.trustedFrame({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:8787'),
    true,
  );
  assert.equal(
    core.trustedFrame(
      { sender: contents, senderFrame: { ...frame } },
      window,
      'http://127.0.0.1:8787',
    ),
    false,
  );
  assert.equal(
    core.trustedFrame({ sender: {}, senderFrame: frame }, window, 'http://127.0.0.1:8787'),
    false,
  );
  assert.equal(
    core.trustedFrame({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:9999'),
    false,
  );
});
test('desktop bootstrap reads only a bounded private regular key file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-desktop-'));
  try {
    const file = path.join(dir, 'admin.token'),
      value = 'private-local-test-token-1234567890';
    await writeFile(file, value, { mode: 0o600 });
    assert.equal(await core.privateToken(file), value);
    if (process.platform !== 'win32') {
      await symlink(file, path.join(dir, 'link'));
      await assert.rejects(core.privateToken(path.join(dir, 'link')));
    }
    await writeFile(path.join(dir, 'large'), 'x'.repeat(9000), { mode: 0o600 });
    await assert.rejects(core.privateToken(path.join(dir, 'large')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
