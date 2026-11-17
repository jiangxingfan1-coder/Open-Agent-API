import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { setup, token } from './helpers.js';
import { readEverythingAcpClient, discoverEverythingAcp } from '../src/config/everything-acp.js';
import { restoreEverythingAcp } from '../src/gateway/everything-acp-routes.js';

test('EverythingACP discovery accepts arbitrary generated wrappers without a brand allowlist or following directory symlinks', async () => {
  const s = await setup();
  try {
    const root = path.join(s.dir, 'wrappers'),
      folder = path.join(root, 'arbitrary-new-agent');
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, 'client.json'),
      JSON.stringify({ command: process.execPath, args: ['unused'], env: {} }),
    );
    if (process.platform !== 'win32') await symlink(folder, path.join(root, 'linked'));
    const found = await discoverEverythingAcp(root);
    assert.equal(found.data.length, 1);
    assert.equal(found.data[0]?.ready, true);
    assert.equal(found.executed, false);
    assert.equal(s.driver.calls, 0);
    await assert.rejects(discoverEverythingAcp(path.join(root, 'missing')), {
      code: 'invalid_request',
    });
  } finally {
    await s.cleanup();
  }
});

test('EverythingACP descriptors are imported without starting or modifying their runtime', async () => {
  const s = await setup();
  try {
    const file = path.join(s.dir, 'client.json');
    const data = JSON.stringify({
      command: process.execPath,
      args: [path.resolve('test/fixtures/acp-agent.mjs')],
      env: {},
    });
    await writeFile(file, data);
    const imported = await s.app.inject({
      method: 'POST',
      url: '/v1/local/everything-acp/import',
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
      payload: { id: 'wrapped', client_file: file },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().enabled, false);
    assert.equal(
      Object.entries(s.runtime.config.adapters).find(([name]) => name === 'wrapped')?.[1].transport,
      'acp',
    );
    assert.equal(await readFile(file, 'utf8'), data);
    assert.equal(s.driver.calls, 0);
    delete s.runtime.config.adapters.wrapped;
    delete s.config.localWorker!.adapters.wrapped;
    restoreEverythingAcp(s.store, s.config, s.runtime);
    assert.equal(
      Object.entries(s.runtime.config.adapters).find(([name]) => name === 'wrapped')?.[1].transport,
      'acp',
    );
    const twice = await s.app.inject({
      method: 'POST',
      url: '/v1/local/everything-acp/import',
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
      payload: { id: 'wrapped', client_file: file },
    });
    assert.equal(twice.statusCode, 200);
    await writeFile(
      file,
      JSON.stringify({ command: process.execPath, args: ['changed'], env: {} }),
    );
    const conflict = await s.app.inject({
      method: 'POST',
      url: '/v1/local/everything-acp/import',
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
      payload: { id: 'wrapped', client_file: file },
    });
    assert.equal(conflict.statusCode, 409);
    await writeFile(
      file,
      JSON.stringify({ command: process.execPath, env: { SECRET: 'do-not-import' } }),
    );
    await assert.rejects(readEverythingAcpClient(file), { code: 'invalid_request' });
  } finally {
    await s.cleanup();
  }
});
