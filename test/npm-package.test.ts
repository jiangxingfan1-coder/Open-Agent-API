import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { lucideScriptUrl } from '../src/gateway/console-assets.js';

// The npm route: `npm pack` makes open-agent-api-<version>.tgz, which installs globally and runs
// `oaa quickstart`. These tests read repository files only; they never listen on a port and never
// touch the network (npm pack runs with --dry-run --ignore-scripts).

type Pkg = {
  name: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const pkg = JSON.parse(await readFile('package.json', 'utf8')) as Pkg;

test('package.json: private stays on, bin points at the compiled CLI, prepack rebuilds dist', () => {
  assert.equal(pkg.private, true, 'private keeps an accidental npm publish impossible');
  assert.equal(pkg.bin.oaa, 'dist/src/cli.js');
  assert.match(pkg.scripts.prepack ?? '', /scripts\/prepack\.mjs/);
});

test('package.json: runtime files the gateway and quickstart read are packed', () => {
  for (const needed of ['dist/src', 'web', 'examples/sample-agent.mjs', 'licenses', 'LICENSE'])
    assert.ok(pkg.files.includes(needed), `files lacks ${needed}`);
  assert.ok(pkg.files.includes('!dist/src/**/*.map'));
  assert.ok(pkg.dependencies.lucide, 'console icons are read from node_modules/lucide at run time');
  // The proprietary Claude Agent SDK is never installed by a plain `npm install -g`.
  assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], undefined);
  assert.ok(pkg.devDependencies['@anthropic-ai/claude-agent-sdk']);
});

test('every package src/ imports at run time is a runtime dependency (no dev dependency leaks)', async () => {
  const optional = new Set(['@anthropic-ai/claude-agent-sdk']); // loaded lazily, see engines/claude-sdk.ts
  const missing = new Set<string>();
  const files = (await readdir('src', { recursive: true })).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const text = await readFile(path.join('src', file), 'utf8');
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (fileName.startsWith('.') || fileName.startsWith('node:')) continue;
      const parts = fileName.split('/');
      const name = fileName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      if (!(name in pkg.dependencies) && !optional.has(name)) missing.add(`${name} (${file})`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('lucide.js is found by Node resolution and the file exists', () => {
  const url = lucideScriptUrl();
  assert.equal(url.protocol, 'file:');
  assert.ok(existsSync(url));
});

test('the CLI runs when started through a symlink, as npm installs the oaa bin', async () => {
  const cli = path.resolve('dist/src/cli.js');
  assert.ok(existsSync(cli), 'run npm run build first');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-bin-'));
  try {
    const link = path.join(dir, 'oaa');
    await symlink(cli, link);
    const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /oaa quickstart/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('npm pack --dry-run lists what the tarball carries', (t) => {
  const npm = process.env.npm_execpath
    ? { cmd: process.execPath, args: [process.env.npm_execpath] }
    : { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
  const r = spawnSync(npm.cmd, [...npm.args, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
    shell: process.platform === 'win32' && !process.env.npm_execpath,
  });
  if (r.error || r.status !== 0)
    return t.skip(`npm is not runnable here: ${r.error?.message ?? r.stderr}`);
  const [info] = JSON.parse(r.stdout) as [{ files: { path: string }[] }];
  const listed = info.files.map((f) => f.path);
  for (const must of [
    'dist/src/cli.js',
    'dist/src/gateway/server.js',
    'web/index.html',
    'examples/sample-agent.mjs',
    'examples/research.oaa',
    'LICENSE',
    'licenses/Lucide-ISC.txt',
    'package.json',
  ])
    assert.ok(listed.includes(must), `the tarball lacks ${must}`);
  assert.deepEqual(
    listed.filter(
      (p) => /\.map$|^dist\/(test|bench|examples)\//.test(p) || p.startsWith('node_modules/'),
    ),
    [],
  );
});
