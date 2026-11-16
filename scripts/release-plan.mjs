// 打包的纯逻辑：参数解析、是否安装到本机、产物命名、进包的依赖清单、Node 版本校验、SHA256SUMS、
// install.sh 盖版本号。这里不读写文件、不执行命令，由 scripts/package-all.mjs 调用，
// 由 test/release-plan.test.ts 离线测试。
import path from 'node:path';

export const PRODUCT_FILE_PREFIX = 'Open-Agent-API';
export const MAC_ARCHES = ['arm64', 'x64'];
export const WIN_ARCHES = ['x64'];
export const LINUX_ARCHES = ['x64', 'arm64'];
/** 平台 → 产物里的系统名、release/ 下的输出目录、Node 的 process.platform。 */
const PLATFORMS = {
  mac: { os: 'macOS', dir: 'macos', node: 'darwin' },
  win: { os: 'win', dir: 'windows', node: 'win32' },
  linux: { os: 'linux', dir: 'linux', node: 'linux' },
};

/** 专有许可、不得随公开安装包再分发的包（Claude 原生引擎需要时由用户另行安装）。 */
export const PROPRIETARY_PACKAGES = [/^@anthropic-ai\/claude-agent-sdk(-.+)?$/];

const USAGE = `用法：node scripts/package-all.mjs <mac|win|linux|all> [选项]（all = mac + win）
  --release            发布模式：不安装到任何应用目录、不链接 CLI、不写用户主目录；产物只写到 release/ 下
  --dry-run            只打印将要写的路径与将要执行的外部命令，什么都不做
  --no-install         本机开发打包但不替换已安装应用、不修改 CLI 链接
  --arch <arm64|x64>   目标架构（mac 与 linux：arm64 或 x64；win：x64）
  --node-dir <目录>    已解压的官方 Node 发行目录，拷进安装包（发布模式必填）
  --node-version <v>   --node-dir 里 Node 的版本号（无法在本机执行该 Node 时用于校验，如在 macOS 上打 Windows 或 Linux 包）`;

/** 解析命令行；出错时抛出带用法说明的 Error。 */
export function parseOptions(argv, hostArch = process.arch) {
  const opts = {
    target: 'all',
    release: false,
    dryRun: false,
    noInstall: false,
    arch: undefined,
    nodeDir: undefined,
    nodeVersion: undefined,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) opts.target = rest.shift();
  while (rest.length) {
    const flag = rest.shift();
    const value = () => {
      const v = rest.shift();
      if (!v || v.startsWith('--')) throw new Error(`${flag} 需要一个值\n${USAGE}`);
      return v;
    };
    if (flag === '--release') opts.release = true;
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--no-install') opts.noInstall = true;
    else if (flag === '--arch') opts.arch = value();
    else if (flag === '--node-dir') opts.nodeDir = path.resolve(value());
    else if (flag === '--node-version') opts.nodeVersion = value().replace(/^v/, '');
    else throw new Error(`未知参数：${flag}\n${USAGE}`);
  }
  if (!['mac', 'win', 'linux', 'all'].includes(opts.target))
    throw new Error(`未知目标：${opts.target}\n${USAGE}`);
  if (opts.release && opts.target === 'all')
    throw new Error(
      '发布模式一次只打一个平台（mac、win 或 linux），以便各自指定架构与 Node 运行时。',
    );
  if (opts.release && !opts.nodeDir)
    throw new Error('发布模式必须用 --node-dir 指定要打进安装包的官方 Node 发行目录。');
  const defaultArch = hostArch === 'x64' ? 'x64' : 'arm64';
  if (opts.target === 'mac' || opts.target === 'linux') opts.arch ??= defaultArch;
  if (opts.target === 'win') opts.arch ??= 'x64';
  if (opts.target === 'mac' && !MAC_ARCHES.includes(opts.arch))
    throw new Error(`macOS 只支持 --arch ${MAC_ARCHES.join('|')}`);
  if (opts.target === 'win' && !WIN_ARCHES.includes(opts.arch))
    throw new Error(`Windows 只支持 --arch ${WIN_ARCHES.join('|')}`);
  if (opts.target === 'linux' && !LINUX_ARCHES.includes(opts.arch))
    throw new Error(`Linux 只支持 --arch ${LINUX_ARCHES.join('|')}`);
  if (opts.target === 'all' && opts.arch)
    throw new Error('--arch 只能与 mac、win 或 linux 一起用。');
  return opts;
}

/** 是否把应用安装到本机（~/Applications、/Applications）并链接 CLI：只有本机开发打包才做。 */
export function shouldInstallLocally(opts) {
  return !opts.release && !opts.noInstall;
}

/** 产物文件名：Open-Agent-API-<版本>-macOS-<arch>.dmg / -win-x64.zip / -linux-<arch>.tar.gz */
export function artifactName(version, platform, arch, ext) {
  return `${PRODUCT_FILE_PREFIX}-${version}-${PLATFORMS[platform].os}-${arch}.${ext}`;
}

/** npm 包的文件名：`npm pack` 对 package.json 里的 open-agent-api 产出 open-agent-api-<版本>.tgz。 */
export const npmTarballName = (version) => `open-agent-api-${version}.tgz`;

/** swiftc 的 -target：与 Info.plist 的 LSMinimumSystemVersion（13.0）一致。 */
export function swiftTarget(arch) {
  return `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.0`;
}

/** Node 的 process.platform / process.arch 名称（package-lock 的 os / cpu 用的也是这些）。 */
export function nodePlatform(platform) {
  return PLATFORMS[platform].node;
}

/** 发布目录与中间目录（都在仓库的 release/ 下）。 */
export function releasePaths(rootDir, platform, arch) {
  const releaseDir = path.join(rootDir, 'release');
  const outDir = path.join(releaseDir, PLATFORMS[platform].dir);
  return {
    releaseDir,
    outDir,
    workDir: path.join(releaseDir, '.work', `${platform}-${arch}`),
  };
}

/** Node 发行目录里要拷进安装包的文件：只要可执行文件与 LICENSE（不带 npm、头文件）。 */
export function nodeRuntimeFiles(platform, nodeDir, runtimeDir) {
  if (platform !== 'win')
    return [
      { from: path.join(nodeDir, 'bin', 'node'), to: path.join(runtimeDir, 'bin', 'node') },
      { from: path.join(nodeDir, 'LICENSE'), to: path.join(runtimeDir, 'LICENSE') },
    ];
  return [
    { from: path.join(nodeDir, 'node.exe'), to: path.join(runtimeDir, 'node.exe') },
    { from: path.join(nodeDir, 'LICENSE'), to: path.join(runtimeDir, 'LICENSE') },
  ];
}

/**
 * 把 Windows 包目录打成 .zip 用的命令。
 * - Windows 主机：必须用系统自带的 bsdtar（%SystemRoot%\System32\tar.exe，`-a` 按后缀选 zip 格式）。
 *   不能写成裸的 `tar.exe`：GitHub Windows 运行器的 bash 里 PATH 靠前的是 Git 自带的 GNU tar，
 *   它不会生成 zip，只会生成一个扩展名叫 .zip 的 tar。
 * - 其他主机：zip -r -q（macOS 用 /usr/bin/zip）。
 */
export function zipCommand({ hostPlatform, zipPath, bundleName, env = process.env }) {
  if (hostPlatform === 'win32') {
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    return {
      cmd: path.win32.join(root, 'System32', 'tar.exe'),
      args: ['-a', '-c', '-f', zipPath, bundleName],
    };
  }
  return {
    cmd: hostPlatform === 'darwin' ? '/usr/bin/zip' : 'zip',
    args: ['-r', '-q', zipPath, bundleName],
  };
}

/**
 * 把 Linux 包目录打成 .tar.gz 用的命令（在 release/linux 下执行，只打包 bundleName 这一个目录）。
 * 属主一律写成 root:root（0:0），免得解压出来带上打包机上的用户 id；macOS 自带的 bsdtar 另要关掉
 * 扩展属性（否则会混进 `._*` 文件）。Windows 主机同样只用系统自带的 bsdtar。
 */
export function tarCommand({ hostPlatform, tarPath, bundleName, env = process.env }) {
  if (hostPlatform === 'linux')
    return {
      cmd: 'tar',
      args: ['--owner=0', '--group=0', '--numeric-owner', '-czf', tarPath, bundleName],
    };
  if (hostPlatform === 'win32') {
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    return {
      cmd: path.win32.join(root, 'System32', 'tar.exe'),
      args: ['--uid', '0', '--gid', '0', '-czf', tarPath, bundleName],
    };
  }
  return {
    cmd: '/usr/bin/tar',
    args: ['--uid', '0', '--gid', '0', '--no-mac-metadata', '-czf', tarPath, bundleName],
  };
}

/**
 * scripts/install.sh 里的版本占位符 @OAA_VERSION@ 换成真实版本：随包与随发布页提供的那一份只装它自己所属的版本，
 * 不必再去查「最新版」。未盖章的源码副本里占位符保持原样，脚本会改去解析最新发布的标签。
 */
export function stampInstallScript(text, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号格式不对：${version}`);
  if (!text.includes('@OAA_VERSION@')) throw new Error('install.sh 里没有 @OAA_VERSION@ 占位符。');
  return text.replaceAll('@OAA_VERSION@', version);
}

const parseVersion = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** 判断版本是否满足 engines.node（支持以空格分隔的 >=、>、<=、<、= 比较式，如 ">=24.18.0 <27"）。 */
export function satisfiesEngines(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
    if (!m) throw new Error(`不支持的 engines 写法：${range}`);
    const bound = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    const c = compare(v, bound);
    const ok =
      m[1] === '>='
        ? c >= 0
        : m[1] === '>'
          ? c > 0
          : m[1] === '<='
            ? c <= 0
            : m[1] === '<'
              ? c < 0
              : c === 0;
    if (!ok) return false;
  }
  return true;
}

const packageName = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const matchesList = (list, value) =>
  !list ||
  (list.some((x) => x === value)
    ? true
    : list.every((x) => x.startsWith('!') && x !== `!${value}`));

/**
 * 按 package-lock.json（lockfileVersion 2/3）决定发布包里的 node_modules：
 * 排除开发依赖（`dev: true`）、专有包、与目标平台/架构不符的可选原生包（`os` / `cpu`），
 * 以及从根的 dependencies / optionalDependencies 出发、只经由入选包已无法到达的包（例如只被专有包
 * 当作 peer 依赖的 `@anthropic-ai/sdk`）。
 * 返回 { include: [{key, name}], exclude: [{key, name, reason}] }，key 形如 `node_modules/a/node_modules/b`。
 */
export function payloadPackages(lock, platform, arch) {
  const packages = lock?.packages;
  if (!packages)
    throw new Error('package-lock.json 缺少 packages（需要 lockfileVersion 2 或 3）。');
  const os = nodePlatform(platform);
  const reasons = new Map();
  for (const [key, meta] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const name = meta.name ?? packageName(key);
    if (PROPRIETARY_PACKAGES.some((re) => re.test(name))) reasons.set(key, 'proprietary');
    else if (meta.dev) reasons.set(key, 'dev');
    else if (!matchesList(meta.os, os) || !matchesList(meta.cpu, arch))
      reasons.set(key, 'platform');
  }
  // Node 的解析规则：从 from 所在的包往上逐层找 node_modules/<name>。
  const resolve = (from, name) => {
    for (let base = from; ;) {
      const cand = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[cand]) return cand;
      if (!base) return undefined;
      const i = base.lastIndexOf('/node_modules/');
      base = i < 0 ? '' : base.slice(0, i);
    }
  };
  const reached = new Set();
  const queue = [''];
  while (queue.length) {
    const from = queue.shift();
    const meta = packages[from] ?? {};
    const deps = {
      ...meta.dependencies,
      ...meta.optionalDependencies,
      ...(from ? meta.peerDependencies : {}),
    };
    for (const name of Object.keys(deps)) {
      const key = resolve(from, name);
      if (!key || reached.has(key) || reasons.has(key)) continue;
      reached.add(key);
      queue.push(key);
    }
  }
  const include = [];
  const exclude = [];
  for (const [key, meta] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const name = meta.name ?? packageName(key);
    const reason = reasons.get(key) ?? (reached.has(key) ? undefined : 'unused');
    (reason ? exclude : include).push(reason ? { key, name, reason } : { key, name });
  }
  return { include, exclude };
}

/** 单个包里按平台分目录放的预编译二进制：只保留目标平台/架构的那一份。 */
const PLATFORM_DIRS = [
  { parent: 'node-pty/prebuilds', name: 'dash' },
  { parent: 'koffi/build/koffi', name: 'underscore' },
];
const platformDirs = (platform, arch) => ({
  dash: `${nodePlatform(platform)}-${arch}`,
  underscore: `${nodePlatform(platform)}_${arch}`,
});

/**
 * 拷贝 node_modules 时的过滤：`rel` 是相对仓库根、用 `/` 分隔的路径。
 * 只保留锁文件里登记且未被排除的包（锁文件外的多余目录、.bin、.package-lock.json 都不进包）。
 */
export function payloadFilter(plan, platform, arch) {
  const included = new Set(plan.include.map((p) => p.key));
  const keep = platformDirs(platform, arch);
  return (rel) => {
    if (rel === 'node_modules') return true;
    if (!rel.startsWith('node_modules/')) return true;
    if (rel.endsWith('/.DS_Store') || rel === '.DS_Store') return false;
    for (const { parent, name } of PLATFORM_DIRS) {
      const m = new RegExp(`(^|/)node_modules/${parent}/([^/]+)(/|$)`).exec(rel);
      if (m && m[2] !== keep[name]) return false;
    }
    // 找到 rel 所属的最深一层包：node_modules/a、node_modules/@s/b、node_modules/a/node_modules/c …
    const segs = rel.split('/');
    let owner;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] !== 'node_modules' || i + 1 >= segs.length) continue;
      const scoped = segs[i + 1].startsWith('@');
      if (scoped && i + 2 >= segs.length) {
        // 只到作用域目录本身（node_modules/@s）：其下有包入选才保留
        const prefix = `${segs.slice(0, i + 2).join('/')}/`;
        return owner === undefined
          ? [...included].some((k) => k.startsWith(prefix))
          : included.has(owner);
      }
      owner = segs.slice(0, i + (scoped ? 3 : 2)).join('/');
    }
    return owner !== undefined && included.has(owner);
  };
}

/**
 * 第三方包里运行时不会读取的文件（`rel` 是相对仓库根、用 `/` 分隔的路径；platform 为 mac/win/linux，缺省时不裁平台专属文件）：
 * - 所有 source map（`*.map`：Node 默认不读，缺了也只是栈里没有源码位置）；
 * - 包根目录下的 test(s)、__tests__、example(s)、doc(s)、benchmark(s)、.github（只看包根这一层：yaml 的 dist/doc 是代码，不受影响；
 *   核对过没有入选的包的 main / module / bin / exports 指向这些目录）；
 * - lucide 的 dist/esm 与 dist/cjs：本项目只读 dist/umd/lucide.js（见 src/gateway/console-assets.ts），没有任何代码 import lucide；
 * - sandbox-runtime 的 vendor/srt-win（Windows 沙箱辅助程序，两个 .exe 共约 8 MB）只在 Windows 包里留，
 *   vendor/seccomp（Linux 沙箱的过滤器）只在 Linux 包里留。
 * 许可证文件、README 与各包的 package.json 一律保留。
 */
export function isThirdPartyDeadWeight(rel, platform) {
  if (!rel.startsWith('node_modules/') && !rel.includes('/node_modules/')) return false;
  if (rel.endsWith('.map')) return true;
  // Only the directory straight under a package root counts (nested packages included).
  if (
    /(^|\/)node_modules\/(@[^/]+\/)?[^/]+\/(tests?|__tests__|examples?|docs?|benchmarks?|\.github)(\/|$)/.test(
      rel,
    )
  )
    return true;
  if (/^node_modules\/lucide\/dist\/(esm|cjs)(\/|$)/.test(rel)) return true;
  const sandbox = 'node_modules/@anthropic-ai/sandbox-runtime/vendor';
  if (platform && platform !== 'win' && rel.startsWith(`${sandbox}/srt-win`)) return true;
  if (platform && platform !== 'linux' && rel.startsWith(`${sandbox}/seccomp`)) return true;
  return false;
}

/**
 * 发布模式拷贝时的总过滤（`rel` 是相对仓库根、用 `/` 分隔的路径）：先去掉 .DS_Store、编译出来的测试、基准与示例、
 * source map（指向包里没有的 src/*.ts）与第三方的无用文件（isThirdPartyDeadWeight），其余交给 node_modules 的
 * `keep`（payloadFilter 的结果）。
 */
export function releaseCopyFilter(keep, platform) {
  return (rel) => {
    if (/(^|\/)\.DS_Store$/.test(rel)) return false;
    if (/^dist\/(test|bench|examples)(\/|$)/.test(rel)) return false;
    // 安装包里没有 TypeScript 与开发依赖：examples/ 只带能直接运行或发布的文件。
    if (/^examples\/(.*\.ts|live-agents(\/.*)?|gemini-sdk-probe\.mjs)$/.test(rel)) return false;
    if (/^dist\/.*\.map$/.test(rel)) return false;
    if (isThirdPartyDeadWeight(rel, platform)) return false;
    return keep(rel);
  };
}

/** SHA256SUMS 的内容（与 `shasum -a 256` / `sha256sum` 的输出格式一致，可用 `-c` 校验）。 */
export function sha256sumsText(entries) {
  return (
    [...entries]
      .sort((a, b) => a.file.localeCompare(b.file))
      .map(({ hash, file }) => `${hash}  ${file}`)
      .join('\n') + '\n'
  );
}

/** 只列顶层包（node_modules/a、node_modules/@s/b），供 --dry-run 打印进包清单与体积。 */
export function topLevelPackages(plan) {
  return plan.include.filter((p) => !p.key.slice('node_modules/'.length).includes('node_modules/'));
}

/** CHANGELOG.md 里某个版本的一节（`## <版本>` 到下一个 `## ` 之前），不含标题行；找不到返回空串。 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^## v?${escaped}(?![\\w.-])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}
