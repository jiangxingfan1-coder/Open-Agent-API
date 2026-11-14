import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_SDK_PACKAGE,
  CLAUDE_SDK_VERSION,
  claudeSdkStatus,
  claudeSdkVendorDir,
  loadClaudeSdk,
} from '../src/engines/claude-sdk.js';
import { errorEntry } from '../src/core/errors.js';
import { Fault } from '../src/core/util.js';

// 发布安装包不带专有的 Claude Agent SDK：缺少时给目录内的错误码与可操作的说明，而不是堆栈。不监听端口。

const MISSING = '@oaa-test/definitely-not-installed-sdk';

test('固定的 SDK 版本与 package.json 的依赖一致', async () => {
  const pkg = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies[CLAUDE_SDK_PACKAGE], CLAUDE_SDK_VERSION);
});

test('缺少 SDK 时抛出目录内的错误码，说明另行安装、条款与安装位置', async () => {
  const vendorDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sdk-missing-'));
  try {
    await assert.rejects(loadClaudeSdk({ specifier: MISSING, vendorDir }), (err: unknown) => {
      assert.ok(err instanceof Fault, '是 Fault 而不是模块解析的原始错误');
      assert.equal(err.code, 'adapter_unavailable');
      assert.equal(err.status, errorEntry('adapter_unavailable')?.status);
      assert.match(err.message, /另行安装/);
      assert.match(err.message, /Anthropic/);
      assert.ok(err.message.includes(`npm install --prefix "${vendorDir}"`));
      assert.ok(err.message.includes(`${MISSING}@${CLAUDE_SDK_VERSION}`));
      assert.ok(err.message.includes('OAA_CLAUDE_SDK_DIR'));
      assert.doesNotMatch(err.message, /\n\s+at /, '不带堆栈');
      return true;
    });
    const status = claudeSdkStatus({ specifier: MISSING, vendorDir });
    assert.equal(status.status, 'requires_separate_install');
    assert.ok(status.status === 'requires_separate_install' && status.install.includes(vendorDir));
  } finally {
    await rm(vendorDir, { recursive: true, force: true });
  }
});

test('另行安装到 vendor 目录的 SDK 能被找到并加载', async () => {
  const vendorDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sdk-vendor-'));
  try {
    const pkgDir = path.join(vendorDir, 'node_modules', '@oaa-test', 'vendor-sdk');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@oaa-test/vendor-sdk', exports: { '.': { default: './sdk.mjs' } } }),
    );
    await writeFile(path.join(pkgDir, 'sdk.mjs'), 'export const query = () => "vendor";\n');
    const sdk = (await loadClaudeSdk({ specifier: '@oaa-test/vendor-sdk', vendorDir })) as unknown;
    assert.equal((sdk as { query: () => string }).query(), 'vendor');
    const status = claudeSdkStatus({ specifier: '@oaa-test/vendor-sdk', vendorDir });
    assert.deepEqual(status, { status: 'available', source: 'vendor' });
  } finally {
    await rm(vendorDir, { recursive: true, force: true });
  }
});

test('随依赖安装的 SDK 照常加载（行为不变）', async () => {
  const sdk = await loadClaudeSdk();
  assert.equal(typeof sdk.query, 'function');
  assert.deepEqual(claudeSdkStatus(), { status: 'available', source: 'bundled' });
});

test('vendor 目录默认在用户目录下的 .oaa/vendor，可由环境变量改写', () => {
  assert.equal(claudeSdkVendorDir({}), path.join(os.homedir(), '.oaa', 'vendor'));
  assert.equal(claudeSdkVendorDir({ OAA_CLAUDE_SDK_DIR: '/opt/sdk' }), '/opt/sdk');
});
