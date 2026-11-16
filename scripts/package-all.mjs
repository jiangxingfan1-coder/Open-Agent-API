#!/usr/bin/env node
// 打包 macOS（.app → .dmg，本机开发另出 .pkg）、Windows（目录 → .zip）与 Linux（目录 → .tar.gz，只在发布模式用）。
//
//   本机开发：node scripts/package-all.mjs mac|win|all
//     会先 npm run build，并把 .app 安装到 ~/Applications 与 /Applications、把 CLI 链接到 ~/.local/bin/oaa。
//     加 --no-install 只构建本机产物，验证后再单独安装。
//   发布构建：node scripts/package-all.mjs mac|win|linux --release --arch <arch> --node-dir <官方 Node 目录>
//     不安装、不链接、不写用户主目录、不 build（要求 dist/ 已由 npm run build 生成）；只写 release/ 之内，
//     越界的写操作由 package-actions.mjs 直接拒绝。加 --dry-run 只打印每一步要写的路径与要执行的命令。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusTemplatePng, brandIconPng } from './brand-icon.mjs';
import { createActions, dirSize, formatBytes } from './package-actions.mjs';
import {
  artifactName,
  nodePlatform,
  nodeRuntimeFiles,
  parseOptions,
  payloadFilter,
  payloadPackages,
  releaseCopyFilter,
  releasePaths,
  satisfiesEngines,
  sha256sumsText,
  shouldInstallLocally,
  stampInstallScript,
  swiftTarget,
  tarCommand,
  topLevelPackages,
  zipCommand,
} from './release-plan.mjs';
import * as win from './package-windows.mjs';
import * as linux from './package-linux.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkgJson.version;
const enginesNode = pkgJson.engines.node;

let opts;
try {
  opts = parseOptions(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const act = createActions({
  dryRun: opts.dryRun,
  rootDir,
  writeRoot: opts.release ? path.join(rootDir, 'release') : undefined,
});

function log(step, msg) {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}

/** 校验要打进包的 Node 版本满足 engines.node；能执行就执行 `node --version`，否则用 --node-version。 */
function checkNodeRuntime(platform) {
  const exe =
    platform === 'win'
      ? path.join(opts.nodeDir, 'node.exe')
      : path.join(opts.nodeDir, 'bin', 'node');
  for (const f of nodeRuntimeFiles(platform, opts.nodeDir, '')) {
    if (!fs.existsSync(f.from)) throw new Error(`--node-dir 里缺少 ${f.from}`);
  }
  let found;
  const canRun = nodePlatform(platform) === process.platform;
  if (canRun) {
    try {
      found = act.query(exe, ['--version']);
    } catch (err) {
      if (!opts.nodeVersion) throw new Error(`无法执行 ${exe} --version：${err.message}`);
    }
  }
  if (!found) {
    if (!opts.nodeVersion)
      throw new Error(`本机无法执行 ${exe}，请用 --node-version 写明它的版本号以便校验。`);
    act.note(`未执行 ${exe}，按 --node-version ${opts.nodeVersion} 校验`);
    found = opts.nodeVersion;
  } else if (opts.nodeVersion && found.replace(/^v/, '') !== opts.nodeVersion) {
    throw new Error(`${exe} 的版本是 ${found}，与 --node-version ${opts.nodeVersion} 不一致。`);
  }
  if (!satisfiesEngines(found, enginesNode))
    throw new Error(`Node ${found} 不满足 package.json engines.node（${enginesNode}）。`);
  log('Node', `运行时 ${found} 满足 ${enginesNode}`);
}

function copyNodeRuntime(platform, runtimeDir) {
  for (const { from, to } of nodeRuntimeFiles(platform, opts.nodeDir, runtimeDir)) {
    act.copy(from, to);
    if (platform !== 'win' && to.endsWith(`${path.sep}node`)) act.chmod(to, 0o755);
  }
}

/** dist、web、examples、package.json、许可证与 node_modules。发布模式按锁文件筛 node_modules。 */
function copyRuntimePayload(destAppDir, platform, arch) {
  act.mkdir(destAppDir);
  const toRel = (src) => path.relative(rootDir, src).split(path.sep).join('/');
  let filter;
  if (opts.release) {
    const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
    const plan = payloadPackages(lock, platform, arch);
    const keep = payloadFilter(plan, platform, arch);
    const releaseFilter = releaseCopyFilter(keep, platform);
    filter = (src) => releaseFilter(toRel(src));
    reportPayload(plan, filter);
  } else {
    // 本机开发打包：保持原来的排除规则。
    filter = (src) =>
      !src.includes('.DS_Store') &&
      !src.includes(`${path.sep}node_modules${path.sep}.bin`) &&
      !src.includes(`${path.sep}node_modules${path.sep}typescript`) &&
      !src.includes(`${path.sep}node_modules${path.sep}prettier`) &&
      !src.includes(`${path.sep}node_modules${path.sep}@types`);
  }
  const items = ['dist', 'web', 'examples', 'package.json'];
  if (opts.release) items.push('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses');
  items.push('node_modules');
  for (const item of items) {
    const srcPath = path.join(rootDir, item);
    if (!fs.existsSync(srcPath)) {
      if (opts.release && item !== 'examples') throw new Error(`缺少 ${item}，无法打发布包。`);
      continue;
    }
    act.copy(srcPath, path.join(destAppDir, item), filter);
  }
}

/** 打印进包与排除的包（dry-run 与真实构建都打印）。 */
function reportPayload(plan, filter) {
  const byReason = {};
  for (const e of plan.exclude) (byReason[e.reason] ??= []).push(e.name);
  const label = {
    proprietary: '专有许可',
    dev: '开发依赖',
    platform: '其他平台/架构',
    unused: '仅被已排除的包引用',
  };
  for (const [reason, names] of Object.entries(byReason))
    log(
      'Payload',
      `排除（${label[reason]}，${names.length} 个）：${[...new Set(names)].join(', ')}`,
    );
  let total = 0;
  const rows = topLevelPackages(plan).map(({ key, name }) => {
    const dir = path.join(rootDir, key);
    const size = fs.existsSync(dir) ? dirSize(dir, filter) : -1;
    if (size > 0) total += size;
    return { name, size };
  });
  rows.sort((a, b) => b.size - a.size);
  log('Payload', `进包的顶层包 ${rows.length} 个（嵌套依赖随所属包）：`);
  for (const r of rows)
    console.log(
      `  ${r.size < 0 ? '（未安装）'.padStart(10) : formatBytes(r.size).padStart(10)}  ${r.name}`,
    );
  log('Payload', `node_modules 合计 ${formatBytes(total)}`);
}

function writeSha256Sums(outDir, files) {
  const entries = files.map((f) => ({ file: path.basename(f), hash: act.sha256(f) }));
  act.write(path.join(outDir, 'SHA256SUMS'), sha256sumsText(entries));
}

function buildMacOSBundle(arch) {
  const { outDir: macReleaseDir, workDir } = releasePaths(rootDir, 'mac', arch);
  log('macOS', `构建 Open Agent API.app（${arch}${opts.release ? '，发布模式' : ''}）`);
  const appBundleDir = path.join(macReleaseDir, 'Open Agent API.app');
  const contentsDir = path.join(appBundleDir, 'Contents');
  const macosBinDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const appPayloadDir = path.join(resourcesDir, 'app');

  act.rm(appBundleDir);
  act.rm(workDir);
  act.mkdir(macosBinDir);
  act.mkdir(appPayloadDir);
  act.mkdir(workDir);

  // 1. 图标：sips 缩放 + iconutil 生成 .icns（中间文件放在 release/.work 下）
  const basePng = path.join(workDir, 'base-1024.png');
  act.write(basePng, opts.dryRun ? '' : brandIconPng(1024));
  const iconsetDir = path.join(workDir, 'AppIcon.iconset');
  act.mkdir(iconsetDir);
  for (const sz of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [
      [1, ''],
      [2, '@2x'],
    ]) {
      const out = path.join(iconsetDir, `icon_${sz}x${sz}${suffix}.png`);
      act.exec(
        '/usr/bin/sips',
        ['-z', String(sz * scale), String(sz * scale), basePng, '--out', out],
        {
          stdio: 'ignore',
          writes: [out],
        },
      );
    }
  }
  act.write(path.join(resourcesDir, 'StatusTemplate.png'), statusTemplatePng(18));
  act.write(path.join(resourcesDir, 'StatusTemplate@2x.png'), statusTemplatePng(36));
  const icnsPath = path.join(resourcesDir, 'AppIcon.icns');
  act.exec('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], { writes: [icnsPath] });

  // 2. 编译 Swift 桌面壳（WKWebView + 菜单栏 + 网关守护）
  // 所有 .swift 一起编译（main.swift 放顶层代码，其余是字符串表与可单测的纯逻辑）；tests/ 下的自检不进包。
  const swiftDir = path.join(rootDir, 'desktop', 'macos');
  const swiftSources = fs
    .readdirSync(swiftDir)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .map((f) => path.join(swiftDir, f));
  const binOut = path.join(macosBinDir, 'OpenAgentAPI');
  act.exec(
    '/usr/bin/swiftc',
    [
      '-O',
      '-target',
      swiftTarget(arch),
      '-framework',
      'Cocoa',
      '-framework',
      'WebKit',
      ...swiftSources,
      '-o',
      binOut,
    ],
    { writes: [binOut] },
  );
  act.chmod(binOut, 0o755);

  // CLI 启动脚本：先用包内自带的 Node（发布包），再找本机的 Node（本机开发包）。
  const cliWrapper = `#!/bin/sh
TARGET="$0"
while [ -L "$TARGET" ]; do
  TARGET_DIR="$(cd "$(dirname "$TARGET")" && pwd)"
  TARGET="$(readlink "$TARGET")"
  case "$TARGET" in
    /*) ;;
    *) TARGET="$TARGET_DIR/$TARGET" ;;
  esac
done
RES="$(cd "$(dirname "$TARGET")" && pwd)"
DIR="$RES/app"
if [ -x "$RES/node/bin/node" ]; then
  exec "$RES/node/bin/node" "$DIR/dist/src/cli.js" "$@"
fi
for NODE_CANDIDATE in "$HOME/.local/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(which node 2>/dev/null)"; do
  if [ -x "$NODE_CANDIDATE" ]; then
    exec "$NODE_CANDIDATE" "$DIR/dist/src/cli.js" "$@"
  fi
done
exec /usr/bin/env node "$DIR/dist/src/cli.js" "$@"
`;
  act.write(path.join(resourcesDir, 'oaa'), cliWrapper, 0o755);

  // 3. Info.plist
  act.write(path.join(contentsDir, 'Info.plist'), infoPlist());

  // 4. 运行时载荷与（发布模式）自带的 Node
  log('macOS', '拷贝编译后的内核、控制台、示例与依赖');
  copyRuntimePayload(appPayloadDir, 'mac', arch);
  if (opts.nodeDir) copyNodeRuntime('mac', path.join(resourcesDir, 'node'));

  // 5. 签名：有 OAA_MACOS_SIGN_IDENTITY 时用开发者证书（hardened runtime），否则临时签名（ad-hoc）
  signMacApp(appBundleDir, resourcesDir);

  // 6. 只在本机开发模式安装到应用目录并链接 CLI
  if (shouldInstallLocally(opts)) installLocally(appBundleDir);
  else log('macOS', '不安装到任何应用目录、不链接 CLI');

  // 7. .dmg（带指向 /Applications 的快捷方式）
  const dmgPath = path.join(macReleaseDir, artifactName(version, 'mac', arch, 'dmg'));
  act.rm(dmgPath);
  const dmgStageDir = path.join(workDir, 'dmg');
  act.mkdir(dmgStageDir);
  act.exec('/usr/bin/ditto', [appBundleDir, path.join(dmgStageDir, 'Open Agent API.app')], {
    writes: [dmgStageDir],
  });
  act.symlink('/Applications', path.join(dmgStageDir, 'Applications'));
  log('macOS', `生成磁盘映像：${dmgPath}`);
  act.exec(
    '/usr/bin/hdiutil',
    [
      'create',
      '-volname',
      'Open Agent API',
      '-srcfolder',
      dmgStageDir,
      '-ov',
      '-format',
      'UDZO',
      dmgPath,
    ],
    { writes: [dmgPath], retries: 3 },
  );
  const artifacts = [dmgPath];

  // 8. 本机开发另出 .pkg（发布只出 .dmg）
  if (!opts.release) {
    const pkgPath = path.join(macReleaseDir, artifactName(version, 'mac', arch, 'pkg'));
    act.rm(pkgPath);
    act.exec(
      '/usr/bin/pkgbuild',
      [
        '--component',
        appBundleDir,
        '--install-location',
        '/Applications',
        '--identifier',
        'dev.oaa.desktop.pkg',
        '--version',
        version,
        pkgPath,
      ],
      { writes: [pkgPath] },
    );
    artifacts.push(pkgPath);
  }
  act.rm(workDir);
  writeSha256Sums(macReleaseDir, artifacts);
  log('macOS', '完成');
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Open Agent API</string>
  <key>CFBundleExecutable</key>
  <string>OpenAgentAPI</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>dev.oaa.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Open Agent API</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleLocalizations</key>
  <array>
    <string>en</string>
    <string>zh-Hans</string>
  </array>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
`;
}

function signMacApp(appBundleDir, resourcesDir) {
  const identity = process.env.OAA_MACOS_SIGN_IDENTITY;
  act.exec('/usr/bin/xattr', ['-cr', appBundleDir], { stdio: 'ignore', writes: [appBundleDir] });
  const entitlements = path.join(rootDir, 'desktop', 'macos', 'entitlements.plist');
  const signArgs = identity
    ? [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        '--entitlements',
        entitlements,
        '--sign',
        identity,
      ]
    : ['--force', '--sign', '-'];
  log('macOS', identity ? `用开发者证书签名：${identity}` : '临时签名（ad-hoc），未公证');
  if (opts.nodeDir) {
    // 包内的 Mach-O（Node、原生 .node 扩展、.dylib）不在 --deep 覆盖的标准位置，逐个先签。
    const inner = opts.dryRun ? [] : machOFiles(resourcesDir);
    if (opts.dryRun)
      act.note(
        `对 ${path.relative(rootDir, resourcesDir)} 下的 node 与 *.node、*.dylib 逐个 codesign`,
      );
    for (const f of inner) act.exec('/usr/bin/codesign', [...signArgs, f], { writes: [f] });
  }
  act.exec(
    '/usr/bin/codesign',
    [...signArgs.filter((a) => a !== '--force'), '--force', '--deep', appBundleDir],
    {
      writes: [appBundleDir],
    },
  );
}

function machOFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath, e.name);
    if (
      /\.(node|dylib)$/.test(e.name) ||
      p.endsWith(`${path.sep}node${path.sep}bin${path.sep}node`)
    )
      out.push(p);
  }
  return out;
}

/** 本机开发模式才会走到这里：覆盖安装到 ~/Applications 与 /Applications，并链接 ~/.local/bin/oaa。 */
function installLocally(appBundleDir) {
  const home = process.env.HOME;
  const targets = [
    path.join(home, 'Applications', 'Open Agent API.app'),
    '/Applications/Open Agent API.app',
  ];
  for (const [i, dest] of targets.entries()) {
    try {
      if (i === 0) act.mkdir(path.dirname(dest));
      act.rm(dest);
      act.exec('/usr/bin/ditto', [appBundleDir, dest], { writes: [dest] });
      act.exec('/usr/bin/xattr', ['-cr', dest], { stdio: 'ignore', writes: [dest] });
      act.exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', dest], {
        stdio: 'ignore',
        writes: [dest],
      });
      log('macOS', `已安装到：${dest}`);
    } catch (err) {
      if (i === 0) throw err; // /Applications 需要管理员权限时跳过
    }
  }
  try {
    const localBin = path.join(home, '.local', 'bin');
    if (fs.existsSync(localBin)) {
      const oaaSymlink = path.join(localBin, 'oaa');
      act.rm(oaaSymlink);
      act.symlink(
        path.join('/Applications', 'Open Agent API.app', 'Contents', 'Resources', 'oaa'),
        oaaSymlink,
      );
      log('macOS', `CLI 已链接到：${oaaSymlink}`);
    }
  } catch {}
}

function buildWindowsBundle(arch) {
  const { outDir: winReleaseDir } = releasePaths(rootDir, 'win', arch);
  log('Windows', `构建 Windows 包（${arch}${opts.release ? '，发布模式' : ''}）`);
  const bundleName = `Open-Agent-API-win-${arch}`;
  const winBundleDir = path.join(winReleaseDir, bundleName);
  const winAppDir = path.join(winBundleDir, 'app');
  const winScriptsDir = path.join(winBundleDir, 'scripts');
  const req = win.nodeRequirement(enginesNode);

  act.rm(winBundleDir);
  act.mkdir(winAppDir);
  act.mkdir(winScriptsDir);

  copyRuntimePayload(winAppDir, 'win', arch);
  if (opts.nodeDir) copyNodeRuntime('win', path.join(winBundleDir, 'runtime'));
  act.write(path.join(winBundleDir, 'OpenAgentAPI.png'), opts.dryRun ? '' : brandIconPng(256));

  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  // PowerShell 5.1 按系统代码页读不带 BOM 的脚本，中文提示需要 UTF-8 BOM。
  const ps1 = (s) => '﻿' + crlf(s);
  act.write(path.join(winBundleDir, 'oaa.cmd'), crlf(win.oaaCmd(req)));
  act.write(path.join(winBundleDir, 'OpenAgentAPI.cmd'), crlf(win.consoleCmd()));
  act.write(path.join(winBundleDir, 'OpenAgentAPI-Desktop.vbs'), crlf(win.desktopVbs()));
  act.write(path.join(winBundleDir, 'Stop-OpenAgentAPI.cmd'), crlf(win.stopCmd()));
  act.write(path.join(winScriptsDir, 'win-desktop.ps1'), ps1(win.desktopPs1(req)));
  act.write(path.join(winScriptsDir, 'win-stop.ps1'), ps1(win.stopPs1()));
  act.write(path.join(winBundleDir, 'Install-OAA-Windows.ps1'), ps1(win.installPs1(version)));
  act.write(path.join(winBundleDir, 'Install-OAA-Windows.cmd'), crlf(win.installCmd()));
  act.write(path.join(winBundleDir, 'README-WINDOWS.txt'), '﻿' + crlf(win.readmeTxt(version, req)));

  const zipPath = path.join(winReleaseDir, artifactName(version, 'win', arch, 'zip'));
  act.rm(zipPath);
  log('Windows', `生成 ZIP：${zipPath}`);
  const zip = zipCommand({ hostPlatform: process.platform, zipPath, bundleName });
  act.exec(zip.cmd, zip.args, { cwd: winReleaseDir, writes: [zipPath] });
  writeSha256Sums(winReleaseDir, [zipPath]);
  log('Windows', '完成');
}

/** Linux：目录（app/ + 自带的 Node 运行时 + oaa 启动脚本 + install.sh + 说明）→ .tar.gz。没有桌面外壳。 */
function buildLinuxBundle(arch) {
  const { outDir: linuxReleaseDir } = releasePaths(rootDir, 'linux', arch);
  log('Linux', `构建 Linux 包（${arch}${opts.release ? '，发布模式' : ''}）`);
  const bundleName = linux.linuxBundleName(arch);
  const bundleDir = path.join(linuxReleaseDir, bundleName);
  const req = linux.nodeRequirement(enginesNode);

  act.rm(bundleDir);
  act.mkdir(path.join(bundleDir, 'app'));
  copyRuntimePayload(path.join(bundleDir, 'app'), 'linux', arch);
  if (opts.nodeDir) copyNodeRuntime('linux', path.join(bundleDir, 'runtime'));
  act.write(path.join(bundleDir, 'oaa'), linux.launcher(req), 0o755);
  act.write(path.join(bundleDir, 'README-LINUX.txt'), linux.readme(version, arch, req));
  const installSh = stampInstallScript(
    fs.readFileSync(path.join(rootDir, 'scripts', 'install.sh'), 'utf8'),
    version,
  );
  act.write(path.join(bundleDir, 'install.sh'), installSh, 0o755);

  const tarPath = path.join(linuxReleaseDir, artifactName(version, 'linux', arch, 'tar.gz'));
  act.rm(tarPath);
  log('Linux', `生成 tar.gz：${tarPath}`);
  const tar = tarCommand({ hostPlatform: process.platform, tarPath, bundleName });
  act.exec(tar.cmd, tar.args, { cwd: linuxReleaseDir, writes: [tarPath] });
  writeSha256Sums(linuxReleaseDir, [tarPath]);
  log('Linux', '完成');
}

function main() {
  if (opts.dryRun)
    log('Plan', '--dry-run：以下每一步只打印，不写任何文件、不执行任何外部命令（query 除外）');
  log(
    'Plan',
    `目标 ${opts.target}${opts.arch ? `/${opts.arch}` : ''}，${opts.release ? '发布模式（只写 release/）' : opts.noInstall ? '本机开发模式（不安装）' : '本机开发模式（会安装到本机）'}`,
  );
  if (opts.nodeDir) {
    for (const target of opts.target === 'all' ? ['mac', 'win'] : [opts.target])
      checkNodeRuntime(target);
  }
  if (opts.release) {
    if (!fs.existsSync(path.join(rootDir, 'dist', 'src', 'cli.js')))
      throw new Error(
        '发布模式不自动编译：请先运行 npm run build（CI 里由 npm run verify 完成）。',
      );
    log('Build', '发布模式：使用已有的 dist/（不运行 npm run build）');
  } else {
    log('Build', '编译 TypeScript 内核与 CLI');
    act.exec('npm', ['run', 'build'], { cwd: rootDir });
  }
  if (opts.target === 'mac' || opts.target === 'all')
    buildMacOSBundle(opts.arch ?? (process.arch === 'x64' ? 'x64' : 'arm64'));
  if (opts.target === 'win' || opts.target === 'all') buildWindowsBundle(opts.arch ?? 'x64');
  if (opts.target === 'linux') buildLinuxBundle(opts.arch);
}

try {
  main();
} catch (err) {
  console.error(`\x1b[31m[失败]\x1b[0m ${err.message}`);
  process.exit(1);
}
