import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

test('staged local desktop packages honor an explicit bundled Node without installing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-package-node-'));
  try {
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin/node'), 'non-executable dry-run fixture');
    await writeFile(path.join(root, 'LICENSE'), 'synthetic fixture');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        'scripts/package-all.mjs',
        'mac',
        '--no-install',
        '--node-dir',
        root,
        '--node-version',
        process.versions.node,
        '--dry-run',
      ],
      { timeout: 30_000, maxBuffer: 2_000_000 },
    );
    assert.match(stdout, /Contents[/\\]Resources[/\\]node[/\\]bin[/\\]node/);
    assert.match(stdout, /Contents[/\\]Resources[/\\]node[/\\]LICENSE/);
    assert.doesNotMatch(stdout, /-> .*[/\\]Applications[/\\]Open Agent API.app/);
    assert.doesNotMatch(stdout, /symlink\s+.*\.local[/\\]bin[/\\]oaa/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
