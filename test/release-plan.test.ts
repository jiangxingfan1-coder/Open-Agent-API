import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

// 打包脚本的纯逻辑（scripts/release-plan.mjs、package-windows.mjs、package-actions.mjs 的越界守卫）。
// 只读仓库内文件，不执行 swiftc / hdiutil / codesign，不写任何文件，不监听端口。

type Mod = Record<string, any>;
const load = (file: string): Promise<Mod> => import(pathToFileURL(path.resolve(file)).href);
const plan = await load('scripts/release-plan.mjs');
const win = await load('scripts/package-windows.mjs');
const actions = await load('scripts/package-actions.mjs');
const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
  version: string;
  engines: { node: string };
  scripts: Record<string, string>;
};
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));

test('参数：发布模式必须带 --node-dir、一次一个平台；本机开发模式才安装', () => {
  assert.throws(() => plan.parseOptions(['mac', '--release']), /--node-dir/);
  assert.throws(
    () => plan.parseOptions(['all', '--release', '--node-dir', 'x']),
    /一次只打一个平台/,
  );
  assert.throws(() => plan.parseOptions(['win', '--arch', 'arm64']), /Windows 只支持/);
  assert.throws(() => plan.parseOptions(['mac', '--arch', 'ppc']), /macOS 只支持/);
  assert.throws(() => plan.parseOptions(['mac', '--bogus']), /未知参数/);
  const rel = plan.parseOptions([
    'mac',
    '--release',
    '--arch',
    'x64',
    '--node-dir',
    'n',
    '--dry-run',
  ]);
  assert.equal(rel.release, true);
  assert.equal(rel.dryRun, true);
  assert.equal(rel.arch, 'x64');
  assert.equal(rel.nodeDir, path.resolve('n'));
  assert.equal(plan.shouldInstallLocally(rel), false);
  const dev = plan.parseOptions(['mac'], 'arm64');
  assert.equal(dev.arch, 'arm64');
  assert.equal(plan.shouldInstallLocally(dev), true);
  const staged = plan.parseOptions(['mac', '--no-install']);
  assert.equal(staged.release, false);
  assert.equal(plan.shouldInstallLocally(staged), false);
  assert.equal(plan.parseOptions([], 'arm64').target, 'all');
  assert.equal(
    plan.parseOptions(['win', '--release', '--node-dir', 'n', '--node-version', 'v24.18.0'])
      .nodeVersion,
    '24.18.0',
  );
});

test('产物命名与 swiftc 目标', () => {
  assert.equal(
    plan.artifactName('1.2.3', 'mac', 'arm64', 'dmg'),
    'Open-Agent-API-1.2.3-macOS-arm64.dmg',
  );
  assert.equal(plan.artifactName('1.2.3', 'win', 'x64', 'zip'), 'Open-Agent-API-1.2.3-win-x64.zip');
  assert.equal(plan.swiftTarget('arm64'), 'arm64-apple-macos13.0');
  assert.equal(plan.swiftTarget('x64'), 'x86_64-apple-macos13.0');
});

test('发布目录都在仓库的 release/ 之下', () => {
  const root = path.resolve('/repo');
  const p = plan.releasePaths(root, 'mac', 'arm64');
  for (const dir of [p.outDir, p.workDir]) assert.ok(dir.startsWith(path.join(root, 'release')));
  const files = plan.nodeRuntimeFiles('win', '/n', '/out/runtime');
  assert.deepEqual(
    files.map((f: { to: string }) => path.basename(f.to)),
    ['node.exe', 'LICENSE'],
  );
});

test('engines 版本判断', () => {
  const range = pkg.engines.node;
  // The real range: the 24 line from 24.18 and the 26 line are supported; older and newer ones are not.
  assert.equal(range, '>=24.18.0 <27');
  for (const ok of ['v24.18.0', '24.20.1', 'v26.0.0', 'v26.13.1'])
    assert.equal(plan.satisfiesEngines(ok, range), true, ok);
  for (const bad of ['v24.17.9', 'v22.1.0', 'v27.0.0', 'v28.1.0'])
    assert.equal(plan.satisfiesEngines(bad, range), false, bad);
  // The comparison logic itself, on a range that is not the current one.
  assert.equal(plan.satisfiesEngines('v24.18.0', '>=24.18.0 <25'), true);
  assert.equal(plan.satisfiesEngines('v25.0.0', '>=24.18.0 <25'), false);
  assert.equal(plan.satisfiesEngines('garbage', range), false);
});

test('发布工作流里固定的 Node 运行时版本满足 engines', async () => {
  const wf = parse(await readFile('.github/workflows/release.yml', 'utf8'));
  const v = wf.env.NODE_RUNTIME_VERSION as string;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(plan.satisfiesEngines(v, pkg.engines.node), true);
  assert.equal(wf.permissions && Object.keys(wf.permissions).length, 0, '顶层不给权限');
  const writers = Object.entries(
    wf.jobs as Record<string, { permissions?: Record<string, string> }>,
  )
    .filter(([, job]) => job.permissions?.contents === 'write')
    .map(([name]) => name);
  assert.deepEqual(writers, ['release'], '只有创建草稿 Release 的作业有 contents: write');
});

test('进包依赖：排除专有、开发与其他平台的包', () => {
  const mac = plan.payloadPackages(lock, 'mac', 'arm64');
  const names = (list: { name: string }[]) => new Set(list.map((p) => p.name));
  const inc = names(mac.include);
  const reasons = new Map(
    mac.exclude.map((e: { name: string; reason: string }) => [e.name, e.reason]),
  );
  assert.ok(!inc.has('@anthropic-ai/claude-agent-sdk'));
  assert.equal(reasons.get('@anthropic-ai/claude-agent-sdk'), 'proprietary');
  assert.equal(reasons.get('@anthropic-ai/claude-agent-sdk-darwin-arm64'), 'proprietary');
  // 专有 SDK 本身是开发依赖，它的 peer 依赖 @anthropic-ai/sdk 在锁文件里也跟着标为 dev。
  assert.equal(reasons.get('@anthropic-ai/sdk'), 'dev');
  for (const dev of ['typescript', 'prettier', 'openai'])
    assert.equal(reasons.get(dev), 'dev', dev);
  for (const runtime of ['fastify', 'ws', 'yaml', 'zod', '@anthropic-ai/sandbox-runtime'])
    assert.ok(inc.has(runtime), runtime);
  if (reasons.has('@koromix/koffi-win32-x64') || inc.has('@koromix/koffi-darwin-arm64')) {
    assert.ok(inc.has('@koromix/koffi-darwin-arm64'));
    assert.equal(reasons.get('@koromix/koffi-win32-x64'), 'platform');
    assert.equal(reasons.get('@koromix/koffi-darwin-x64'), 'platform');
  }
  const winPlan = plan.payloadPackages(lock, 'win', 'x64');
  const winInc = names(winPlan.include);
  if (winInc.has('@koromix/koffi-win32-x64')) assert.ok(!winInc.has('@koromix/koffi-darwin-arm64'));
  assert.ok(!winInc.has('@anthropic-ai/claude-agent-sdk-win32-x64'));
  for (const p of plan.topLevelPackages(mac)) assert.ok(!p.key.slice(13).includes('node_modules/'));
});

test('拷贝过滤：只留锁文件里入选的包与目标平台的预编译目录', () => {
  const fake = {
    packages: {
      '': {
        dependencies: {
          a: '1',
          '@s/b': '1',
          '@anthropic-ai/claude-agent-sdk': '1',
          'not-linux': '1',
        },
        optionalDependencies: { 'node-pty': '1', 'x-win': '1' },
      },
      'node_modules/orphan': {},
      'node_modules/a': { dependencies: { devonly: '1' } },
      'node_modules/a/node_modules/devonly': { dev: true },
      'node_modules/@s/b': {},
      'node_modules/@anthropic-ai/claude-agent-sdk': {},
      'node_modules/node-pty': { optional: true },
      'node_modules/x-win': { os: ['win32'], cpu: ['x64'], optional: true },
      'node_modules/not-linux': { os: ['!linux'] },
    },
  };
  const p = plan.payloadPackages(fake, 'mac', 'arm64');
  const keep = plan.payloadFilter(p, 'mac', 'arm64');
  assert.equal(keep('node_modules'), true);
  assert.equal(keep('dist/src/cli.js'), true);
  assert.equal(keep('node_modules/a/index.js'), true);
  assert.equal(keep('node_modules/a/node_modules/devonly/index.js'), false);
  assert.equal(keep('node_modules/@s'), true);
  assert.equal(keep('node_modules/@s/b/x.js'), true);
  assert.equal(keep('node_modules/@anthropic-ai'), false);
  assert.equal(keep('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), false);
  assert.equal(keep('node_modules/x-win/index.js'), false);
  assert.equal(keep('node_modules/not-linux/index.js'), true);
  assert.equal(keep('node_modules/.bin/tsc'), false);
  assert.equal(keep('node_modules/extraneous/index.js'), false);
  assert.equal(keep('node_modules/orphan/index.js'), false, '锁文件里有但不可达');
  assert.equal(keep('node_modules/node-pty/prebuilds/darwin-arm64/pty.node'), true);
  assert.equal(keep('node_modules/node-pty/prebuilds/win32-x64/pty.node'), false);
  assert.equal(keep('node_modules/a/.DS_Store'), false);
});

test('SHA256SUMS 格式与 sha256sum -c 兼容', () => {
  assert.equal(
    plan.sha256sumsText([
      { file: 'b.zip', hash: '22' },
      { file: 'a.dmg', hash: '11' },
    ]),
    '11  a.dmg\n22  b.zip\n',
  );
});

test('发布模式的副作用层拒绝写 release/ 之外的路径（dry-run 也拒绝）', () => {
  const root = path.resolve('/repo');
  const act = actions.createActions({
    dryRun: true,
    rootDir: root,
    writeRoot: path.join(root, 'release'),
  });
  const log = console.log;
  console.log = () => {};
  try {
    act.write(path.join(root, 'release', 'macos', 'x'), '');
    act.exec('/usr/bin/hdiutil', ['create'], { writes: [path.join(root, 'release', 'a.dmg')] });
    assert.throws(() => act.rm('/Applications/Open Agent API.app'), /只许写/);
    assert.throws(
      () => act.symlink('/x', path.join(process.env.HOME ?? '/home', '.local/bin/oaa')),
      /只许写/,
    );
    assert.throws(() => act.write(path.join(root, 'release-other', 'x'), ''), /只许写/);
    assert.throws(
      () => act.exec('/usr/bin/ditto', ['a', 'b'], { writes: [path.join(root, '..', 'b')] }),
      /只许写/,
    );
  } finally {
    console.log = log;
  }
});

test('Windows 启动器：版本提示与 engines 一致，cmd/vbs 只用 ASCII', () => {
  const req = win.nodeRequirement(pkg.engines.node);
  assert.deepEqual([req.major, req.minor, req.below], [24, 18, 27]);
  const ascii = /^[\x00-\x7f]*$/;
  for (const text of [
    win.oaaCmd(req),
    win.consoleCmd(),
    win.desktopVbs(),
    win.stopCmd(),
    win.installCmd(),
  ]) {
    assert.match(text, ascii);
    assert.doesNotMatch(text, /Node\.js 22/);
  }
  const cmd = win.oaaCmd(req);
  assert.match(cmd, /Node\.js 24\.18\+ \(below 27\)/);
  // The version check inside the .cmd accepts 24.18+ and 26, and refuses 24.17 and 27.
  const check = /process\.exit\((.*?)\?0:1\)/.exec(cmd)?.[1];
  assert.ok(check, 'the .cmd carries a version check');
  const accepts = (v: string) => {
    const [a, b] = v.split('.').map(Number);
    return new Function('a', 'b', `return ${check}`)(a, b) as boolean;
  };
  for (const ok of ['24.18', '24.30', '26.0', '26.13']) assert.equal(accepts(ok), true, ok);
  for (const bad of ['24.17', '22.20', '27.0']) assert.equal(accepts(bad), false, bad);
  // 括号块里的 %ERRORLEVEL% 会在解析时提前展开：exit /b %ERRORLEVEL% 不能出现在 ( … ) 块里。
  assert.doesNotMatch(cmd, /\([^)]*exit \/b %ERRORLEVEL%[^)]*\)/s);
  const ps1 = win.desktopPs1(req);
  assert.match(ps1, /Add-Type -AssemblyName System\.Windows\.Forms/);
  assert.doesNotMatch(
    ps1,
    /Invoke-RestMethod[^\n]*-NoProxy/,
    'Windows PowerShell 5.1 没有 -NoProxy',
  );
  assert.match(ps1, /desktop\.pid/);
  // 首次启动由 quickstart 保证有可调用的离线示例智能体；-Wait 会连同后台网关一起等，不能用。
  assert.match(ps1, /"quickstart", "--dir"/);
  assert.match(ps1, /\$Qs\.WaitForExit\(\)/);
  assert.doesNotMatch(ps1, /"quickstart"[^\n]*-Wait/);
  assert.match(win.stopPs1(), /"stop", "--dir"/);
  const readme = win.readmeTxt('0.0.64', req);
  assert.ok(
    readme.indexOf('oaa.cmd quickstart') < readme.indexOf('1. '),
    'quickstart is the first step',
  );
  assert.match(win.stopPs1(), /Stop-Process/);
});

test('Windows 启动器：提示文字跟随界面语言（中英成对），版本号与端口不写死', () => {
  const req = win.nodeRequirement(pkg.engines.node);
  const scripts: Record<string, string> = {
    desktop: win.desktopPs1(req),
    stop: win.stopPs1(),
    install: win.installPs1('9.9.9'),
  };
  const cjk = /[　-〿一-鿿＀-￯]/;
  for (const [name, text] of Object.entries(scripts)) {
    assert.match(
      text,
      /\(Get-UICulture\)\.Name -like "zh\*"/,
      `${name}: follows the display language`,
    );
    // Every message is Say "中文" "English"; a bare string passed to Show-Error / Write-Host would
    // speak one language only.
    assert.doesNotMatch(text, /(Show-Error|Write-Host)\s+"/, `${name}: a message bypasses Say`);
    const pairs = [...text.matchAll(/Say "([^"]*)" "([^"]*)"/g)];
    assert.ok(pairs.length >= 3, `${name}: expected the messages, found ${pairs.length}`);
    for (const [, chinese, english] of pairs) {
      assert.match(chinese!, cjk, `${name}: the Chinese text of "${english}"`);
      assert.doesNotMatch(english!, cjk, `${name}: the English text of "${english}"`);
    }
    const outside = text
      .replace(/Say "[^"]*" "[^"]*"/g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(outside, cjk, `${name}: Chinese outside the Say calls`);
  }
  // The version comes from the argument, never from a literal; the port from the configuration.
  assert.match(scripts.install!, /v9\.9\.9/);
  assert.doesNotMatch(
    Object.values(scripts).join('\n'),
    new RegExp(pkg.version.replace(/\./g, '\\.')),
  );
  const readme = win.readmeTxt('9.9.9', req);
  assert.equal(readme.match(/v9\.9\.9/g)?.length, 2, 'one heading per language');
  assert.ok(
    readme.indexOf('Step one') >= 0 && readme.indexOf('Step one') < readme.indexOf('第一步'),
  );
  assert.match(readme, /SmartScreen/);
  const desktop = scripts.desktop!;
  assert.match(desktop, /\$Port = \[int\]\$Config\.port/);
  assert.match(desktop, /\$BaseUrl = "http:\/\/127\.0\.0\.1:\$Port"/);
  const hardcoded = desktop
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && line.includes('8787'));
  assert.deepEqual(
    hardcoded.map((line) => line.trim()),
    ['$Port = 8787'],
    'the only literal port is the default used before config.json exists',
  );
});

test('package.json 提供发布打包脚本', () => {
  assert.match(pkg.scripts['package:release:mac'] ?? '', /package-all\.mjs mac --release/);
  assert.match(pkg.scripts['package:release:win'] ?? '', /package-all\.mjs win --release/);
});

test('CHANGELOG 取版本一节作为草稿 Release 正文', async () => {
  const text =
    '# 变更\n\n## 未发布\n\nx\n\n## 1.2.3（2026-01-01）\n\n### 新增\n\n- a\n\n## 1.2.30\n\n- b\n';
  assert.equal(plan.changelogSection(text, '1.2.3'), '### 新增\n\n- a');
  assert.equal(plan.changelogSection(text, '1.2.30'), '- b');
  assert.equal(plan.changelogSection(text, '9.9.9'), '');
  // The English changelog format: ASCII parentheses and an `## Unreleased` section on top.
  const english =
    '# Changelog\n\n## Unreleased\n\n## 1.2.3 (2026-01-01)\n\n### Added\n\n- a\n\n## 1.2.30 (2026-02-01)\n\n- b\n\n## Earlier versions\n\nsee the Chinese file\n';
  assert.equal(plan.changelogSection(english, '1.2.3'), '### Added\n\n- a');
  assert.equal(plan.changelogSection(english, '1.2.30'), '- b');
  assert.equal(plan.changelogSection(english, 'Unreleased'), '');
  const real = await readFile('CHANGELOG.md', 'utf8');
  assert.notEqual(plan.changelogSection(real, pkg.version), '', '当前版本在 CHANGELOG 里有一节');
  assert.doesNotMatch(
    plan.changelogSection(real, pkg.version),
    /Earlier versions/,
    '发布说明不含「Earlier versions」一节',
  );
});

// ── 首跑稳定性：这些工作流从没在 GitHub 上真正跑过，能离线核对的都在这里核对 ──

const workflowDir = '.github/workflows';
const workflowFiles = (await readdir(workflowDir)).filter((f) => f.endsWith('.yml')).sort();
const workflowText = new Map<string, string>();
const workflows = new Map<string, any>();
for (const f of workflowFiles) {
  const text = await readFile(path.join(workflowDir, f), 'utf8');
  workflowText.set(f, text);
  workflows.set(f, parse(text));
}

test('工作流里每个 action 都固定到 40 位提交哈希，行尾注明版本号', () => {
  let count = 0;
  for (const [file, text] of workflowText) {
    for (const line of text.split('\n')) {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) continue;
      count++;
      assert.match(m[1]!, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${line.trim()}`);
      assert.match(m[2]!, /^\s+#\s+v\d+\.\d+\.\d+\s*$/, `${file}: 缺少版本号注释：${line.trim()}`);
    }
  }
  assert.ok(count >= 10, '至少应扫到十来处 uses');
});

test('每个作业都有 timeout-minutes（避免卡死耗光额度），且不超过 60 分钟', () => {
  for (const [file, wf] of workflows)
    for (const [name, job] of Object.entries(wf.jobs as Record<string, any>)) {
      assert.equal(typeof job['timeout-minutes'], 'number', `${file}:${name} 缺少 timeout-minutes`);
      assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60, `${file}:${name}`);
    }
});

test('运行器标签不用已退役的系统镜像', () => {
  // macos-14 已于 2026-11-02 从 GitHub Actions 退役（actions/runner-images 的 README 与 issue 15226）。
  const retired = new Set([
    'macos-11',
    'macos-12',
    'macos-13',
    'macos-14',
    'ubuntu-18.04',
    'ubuntu-20.04',
    'windows-2016',
    'windows-2019',
  ]);
  for (const [file, wf] of workflows)
    for (const [name, job] of Object.entries(wf.jobs as Record<string, any>)) {
      const labels: string[] = [];
      const runsOn = job['runs-on'];
      if (typeof runsOn === 'string' && !runsOn.includes('${{')) labels.push(runsOn);
      for (const e of job.strategy?.matrix?.include ?? []) if (e.runner) labels.push(e.runner);
      for (const label of job.strategy?.matrix?.os ?? []) labels.push(label);
      assert.ok(labels.length > 0, `${file}:${name} 没有可核对的运行器标签`);
      for (const l of labels) assert.ok(!retired.has(l), `${file}:${name} 用了已退役的 ${l}`);
    }
});

test('发布矩阵：字段齐全、被引用的字段都存在、与打包脚本的命名与目录一致', () => {
  const wf = workflows.get('release.yml');
  const build = wf.jobs.build;
  const include = build.strategy.matrix.include as Record<string, string>[];
  assert.deepEqual(
    include.map((e) => `${e.platform}-${e.arch}`),
    ['mac-arm64', 'mac-x64', 'win-x64', 'linux-x64', 'linux-arm64'],
  );
  const keys = new Set(include.flatMap((e) => Object.keys(e)));
  for (const e of include)
    assert.deepEqual(Object.keys(e).sort(), [...keys].sort(), JSON.stringify(e));
  // build 作业里 ${{ matrix.xxx }} 引用的每个字段都得在每个 include 项里有定义。
  const buildText = JSON.stringify(build) + JSON.stringify(wf.jobs.build.name);
  const used = new Set([...buildText.matchAll(/matrix\.(\w+)/g)].map((m) => m[1]!));
  for (const k of used) assert.ok(keys.has(k), `矩阵没有字段 ${k}`);
  for (const k of keys) assert.ok(used.has(k) || k === 'platform', `矩阵字段 ${k} 没被用到`);
  for (const e of include) {
    const arch = e.arch;
    const nodeOs = { mac: 'darwin', win: 'win', linux: 'linux' }[
      e.platform as 'mac' | 'win' | 'linux'
    ];
    assert.equal(e.node_dist, `${nodeOs}-${arch}`);
    assert.equal(e.node_ext, e.platform === 'win' ? 'zip' : 'tar.gz');
    const { outDir } = plan.releasePaths('/r', e.platform, arch);
    assert.equal(e.out, path.basename(outDir), '上传路径要与打包脚本的输出目录一致');
    assert.ok(
      plan.artifactName('1.0.0', e.platform, arch, e.artifact_ext).endsWith(`.${e.artifact_ext}`),
    );
    const arches = { mac: 'MAC_ARCHES', win: 'WIN_ARCHES', linux: 'LINUX_ARCHES' }[
      e.platform as 'mac' | 'win' | 'linux'
    ];
    assert.ok(plan[arches].includes(arch));
  }
  // 上传的产物名要能被汇总作业的 pattern 命中；两边同一份前缀。
  const upload = build.steps.find((st: any) => /upload-artifact@/.test(st.uses ?? ''));
  const download = wf.jobs.release.steps.find((st: any) =>
    /download-artifact@/.test(st.uses ?? ''),
  );
  assert.match(upload.with.name, /^oaa-/);
  assert.equal(download.with.pattern, 'oaa-*');
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(upload.with['if-no-files-found'], 'error');
  // 打包与上传都走 bash（Windows 默认是 pwsh，里面的 bash 语法会直接报错）。
  assert.equal(build.defaults.run.shell, 'bash');
});

test('所有 PowerShell 5.1 的步骤脚本只含 ASCII（runner 写脚本文件时不一定带 BOM，非 ASCII 会变乱码甚至变成智能引号）', () => {
  for (const [file, wf] of workflows)
    for (const [name, job] of Object.entries(wf.jobs as Record<string, any>))
      for (const st of job.steps ?? [])
        if (st.shell === 'powershell') assert.match(st.run, /^[\x00-\x7f]*$/, `${file}:${name}`);
});

test('Windows zip 用系统自带的 bsdtar，不用 PATH 里靠前的 GNU tar', () => {
  const win32 = plan.zipCommand({
    hostPlatform: 'win32',
    zipPath: 'C:\\r\\release\\windows\\x.zip',
    bundleName: 'Open-Agent-API-win-x64',
    env: { SystemRoot: 'D:\\Windows' },
  });
  assert.equal(win32.cmd, 'D:\\Windows\\System32\\tar.exe');
  assert.deepEqual(win32.args.slice(0, 3), ['-a', '-c', '-f']);
  assert.ok(win32.args.at(-2)!.endsWith('x.zip'));
  assert.equal(
    plan.zipCommand({ hostPlatform: 'win32', zipPath: 'z', bundleName: 'b', env: {} }).cmd,
    'C:\\Windows\\System32\\tar.exe',
  );
  const mac = plan.zipCommand({ hostPlatform: 'darwin', zipPath: 'z.zip', bundleName: 'b' });
  assert.deepEqual([mac.cmd, mac.args], ['/usr/bin/zip', ['-r', '-q', 'z.zip', 'b']]);
  assert.equal(
    plan.zipCommand({ hostPlatform: 'linux', zipPath: 'z', bundleName: 'b' }).cmd,
    'zip',
  );
});

test('发布拷贝过滤：去掉 .DS_Store、编译出的测试与基准、source map，其余交给 node_modules 的过滤', () => {
  const f = plan.releaseCopyFilter((rel: string) => !rel.startsWith('node_modules/x'));
  assert.equal(f('dist/src/cli.js'), true);
  assert.equal(f('dist/src/cli.js.map'), false);
  assert.equal(f('dist/examples/demo.js.map'), false);
  assert.equal(f('examples/demo.ts'), false);
  assert.equal(f('examples/live-agents/harness.ts'), false);
  assert.equal(f('examples/live-agents'), false);
  assert.equal(f('examples/gemini-sdk-probe.mjs'), false);
  assert.equal(f('examples/sample-agent.mjs'), true);
  assert.equal(f('examples/sample-agent.json'), true);
  assert.equal(f('examples/research.oaa'), true);
  assert.equal(f('dist/test/a.test.js'), false);
  assert.equal(f('dist/bench'), false);
  assert.equal(f('dist/testing/x.js'), true);
  assert.equal(f('web/.DS_Store'), false);
  assert.equal(f('web/console.js'), true);
  assert.equal(f('node_modules/x/index.js'), false);
  assert.equal(f('node_modules/y/index.js'), true);
  assert.equal(f('dist/examples/demo.js'), false, '编译出来的示例不进包');
});

test('瘦身：第三方的 source map、测试与文档目录不进包，代码与许可证不受影响', () => {
  const f = plan.releaseCopyFilter(() => true, 'mac');
  for (const gone of [
    'node_modules/zod/index.js.map',
    'node_modules/@scope/pkg/dist/a.js.map',
    'node_modules/fastify/test/basic.test.js',
    'node_modules/fastify/docs/Guides/x.md',
    'node_modules/pino/benchmarks/log.js',
    'node_modules/a/examples/one.js',
    'node_modules/a/node_modules/b/tests/x.js',
    'node_modules/@s/p/__tests__/y.js',
    'node_modules/a/.github/workflows/ci.yml',
    'node_modules/lucide/dist/esm/icons/a-arrow-up.js',
    'node_modules/lucide/dist/cjs/lucide.js',
  ])
    assert.equal(f(gone), false, gone);
  for (const kept of [
    'node_modules/yaml/dist/doc/Document.js', // dist/doc 是代码，不是文档目录
    'node_modules/fastify/lib/test-helper.js',
    'node_modules/a/LICENSE',
    'node_modules/a/README.md',
    'node_modules/a/package.json',
    'node_modules/a/dist/index.d.ts',
    'node_modules/lucide/dist/umd/lucide.js',
    'node_modules/lucide/package.json',
    'node_modules/a/node_modules/test/index.js', // 一个叫 test 的包，不是 test 目录
  ])
    assert.equal(f(kept), true, kept);
});

test('瘦身：Windows 沙箱程序只留在 Windows 包，seccomp 只留在 Linux 包', () => {
  const vendor = 'node_modules/@anthropic-ai/sandbox-runtime/vendor';
  const win = plan.releaseCopyFilter(() => true, 'win');
  const mac = plan.releaseCopyFilter(() => true, 'mac');
  const linux = plan.releaseCopyFilter(() => true, 'linux');
  const unknown = plan.releaseCopyFilter(() => true);
  assert.equal(win(`${vendor}/srt-win/x64/srt-win.exe`), true);
  assert.equal(mac(`${vendor}/srt-win/x64/srt-win.exe`), false);
  assert.equal(linux(`${vendor}/srt-win/arm64/srt-win.exe`), false);
  assert.equal(linux(`${vendor}/seccomp/x64/apply-seccomp`), true);
  assert.equal(win(`${vendor}/seccomp/x64/apply-seccomp`), false);
  assert.equal(mac(`${vendor}/seccomp/arm64/apply-seccomp`), false);
  assert.equal(mac(`${vendor}/java-proxy-agent/srt-proxy-agent.jar`), true);
  assert.equal(unknown(`${vendor}/srt-win/x64/srt-win.exe`), true, '不知道平台时不裁');
});

test('外部命令失败可重试（hdiutil create 在 macOS 运行器上偶发 Resource busy），次数用尽后抛出', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-retry-'));
  try {
    const counter = path.join(dir, 'count');
    const script = path.join(dir, 'flaky.mjs');
    await writeFile(
      script,
      `import fs from 'node:fs';
const f = process.argv[2];
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
fs.writeFileSync(f, String(n));
process.exit(n >= Number(process.argv[3]) ? 0 : 1);
`,
    );
    const act = actions.createActions({ dryRun: false, rootDir: dir });
    const log = console.log;
    console.log = () => {};
    try {
      // 第 2 次成功；retries=3 够用。
      act.exec(process.execPath, [script, counter, '2'], {
        retries: 3,
        retryDelayMs: 1,
        stdio: 'ignore',
      });
      assert.equal(await readFile(counter, 'utf8'), '2');
      // 默认不重试：第 1 次失败就抛。
      await rm(counter);
      assert.throws(() => act.exec(process.execPath, [script, counter, '2'], { stdio: 'ignore' }));
      assert.equal(await readFile(counter, 'utf8'), '1');
      // 次数用尽：要 5 次才成功但只给 2 次。
      await rm(counter);
      assert.throws(() =>
        act.exec(process.execPath, [script, counter, '5'], {
          retries: 2,
          retryDelayMs: 1,
          stdio: 'ignore',
        }),
      );
      assert.equal(await readFile(counter, 'utf8'), '2');
    } finally {
      console.log = log;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('版本号格式：任意 x.y.z（含 0.0.x）都能走通产物命名、CHANGELOG 取节与 engines 判断', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    plan.artifactName('0.0.64', 'mac', 'x64', 'dmg'),
    'Open-Agent-API-0.0.64-macOS-x64.dmg',
  );
  const text = '## 0.0.6（d）\n\na\n\n## 0.0.64（d）\n\nb\n\n## v0.0.640\n\nc\n';
  assert.equal(plan.changelogSection(text, '0.0.64'), 'b');
  assert.equal(plan.changelogSection(text, '0.0.6'), 'a');
  assert.equal(plan.changelogSection(text, '0.0.640'), 'c');
  assert.equal(plan.changelogSection('## 0.0.64\r\n\r\nx\r\n', '0.0.64'), 'x');
});

// ── Linux 包、npm 包与 install.sh ──

test('Linux：参数、产物命名、目录与 Node 运行时文件', () => {
  const rel = plan.parseOptions(['linux', '--release', '--arch', 'arm64', '--node-dir', 'n']);
  assert.equal(rel.target, 'linux');
  assert.equal(rel.arch, 'arm64');
  assert.equal(plan.parseOptions(['linux'], 'arm64').arch, 'arm64');
  assert.equal(plan.parseOptions(['linux'], 'x64').arch, 'x64');
  assert.throws(() => plan.parseOptions(['linux', '--arch', 'ppc64']), /Linux 只支持/);
  assert.throws(() => plan.parseOptions(['linux', '--release']), /--node-dir/);
  assert.equal(
    plan.artifactName('0.0.64', 'linux', 'x64', 'tar.gz'),
    'Open-Agent-API-0.0.64-linux-x64.tar.gz',
  );
  assert.equal(plan.nodePlatform('linux'), 'linux');
  assert.equal(
    plan.releasePaths('/r', 'linux', 'arm64').outDir,
    path.join('/r', 'release', 'linux'),
  );
  assert.deepEqual(
    plan.nodeRuntimeFiles('linux', '/n', '/out/runtime').map((f: { to: string }) => f.to),
    [path.join('/out/runtime', 'bin', 'node'), path.join('/out/runtime', 'LICENSE')],
  );
  assert.equal(plan.npmTarballName('0.0.64'), 'open-agent-api-0.0.64.tgz');
  assert.match(pkg.scripts['package:release:linux'] ?? '', /package-all\.mjs linux --release/);
});

test('Linux tar.gz 的命令：属主一律 0:0，只打包一个目录', () => {
  const linux = plan.tarCommand({ hostPlatform: 'linux', tarPath: 'x.tar.gz', bundleName: 'b' });
  assert.deepEqual(linux, {
    cmd: 'tar',
    args: ['--owner=0', '--group=0', '--numeric-owner', '-czf', 'x.tar.gz', 'b'],
  });
  const mac = plan.tarCommand({ hostPlatform: 'darwin', tarPath: 'x.tar.gz', bundleName: 'b' });
  assert.equal(mac.cmd, '/usr/bin/tar');
  assert.ok(mac.args.includes('--no-mac-metadata'));
  const win32 = plan.tarCommand({
    hostPlatform: 'win32',
    tarPath: 'x.tar.gz',
    bundleName: 'b',
    env: { SystemRoot: 'D:\\Windows' },
  });
  assert.equal(win32.cmd, 'D:\\Windows\\System32\\tar.exe');
  for (const c of [linux, mac, win32])
    assert.deepEqual(c.args.slice(-3), ['-czf', 'x.tar.gz', 'b']);
});

test('install.sh 盖版本号：占位符只出现在一处，盖章后语法仍然正确', async () => {
  const text = await readFile('scripts/install.sh', 'utf8');
  assert.equal(text.split('@OAA_VERSION@').length - 1, 1, '占位符只能出现在赋值那一行');
  const stamped = plan.stampInstallScript(text, '1.2.3');
  assert.match(stamped, /^OAA_STAMPED_VERSION="1\.2\.3"$/m);
  assert.doesNotMatch(stamped, /@OAA_VERSION@/);
  assert.throws(() => plan.stampInstallScript(text, 'v1.2'), /版本号格式/);
  assert.throws(() => plan.stampInstallScript('no placeholder', '1.2.3'), /占位符/);
  // 默认仓库与 package.json 的 repository 一致。
  const repo = /^OAA_REPO="([^"]+)"$/m.exec(text)?.[1];
  const url = (
    JSON.parse(await readFile('package.json', 'utf8')) as { repository: { url: string } }
  ).repository.url;
  assert.ok(url.includes(`github.com/${repo}.git`), `${repo} vs ${url}`);
});

test('发布工作流：Linux 两个架构、npm 包作业与汇总核对', () => {
  const wf = workflows.get('release.yml');
  const runners = wf.jobs.build.strategy.matrix.include.map((e: { runner: string }) => e.runner);
  assert.ok(runners.includes('ubuntu-latest') && runners.includes('ubuntu-24.04-arm'));
  const npmJob = wf.jobs['npm-package'];
  assert.equal(npmJob.permissions.contents, 'read');
  assert.equal(npmJob.needs, 'version');
  assert.deepEqual(wf.jobs.release.needs, ['version', 'build', 'npm-package']);
  const upload = npmJob.steps.find((st: any) => /upload-artifact@/.test(st.uses ?? ''));
  assert.match(upload.with.name, /^oaa-/, '汇总作业按 oaa-* 下载');
  assert.equal(upload.with['if-no-files-found'], 'error');
  const sums = wf.jobs.release.steps.find((st: any) => /SHA256SUMS/.test(st.name ?? ''));
  for (const piece of ['*.tar.gz', '*.tgz', 'install.sh', 'stamp-install.mjs'])
    assert.ok(sums.run.includes(piece), `汇总 SHA256SUMS 时漏了 ${piece}`);
  // 每个平台的烟雾测试都走同一个脚本，并带 --app-dir 做逐模块 import。
  for (const [name, job] of Object.entries(wf.jobs as Record<string, any>))
    for (const st of job.steps ?? [])
      if (/smoke-release\.mjs/.test(st.run ?? ''))
        assert.match(st.run, /--app-dir/, `${name}: ${st.name}`);
});
