import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brandIconPng, statusTemplatePng } from '../../scripts/brand-icon.mjs';
import {
  nodeRuntimeFiles,
  satisfiesEngines,
  payloadPackages,
  payloadFilter,
  releaseCopyFilter,
  zipCommand,
  tarCommand,
} from '../../scripts/release-plan.mjs';

const SHELL_FILES = [
  'main.cjs',
  'preload.cjs',
  'core.cjs',
  'strings.cjs',
  'tray-panel.cjs',
  'tray-preload.cjs',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
    'node-dir': { type: 'string' },
    'node-version': { type: 'string' },
    'out-dir': { type: 'string' },
    'executable-name': { type: 'string' },
    'shell-only': { type: 'boolean', default: false },
    'no-archive': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (
  !['darwin', 'win32', 'linux'].includes(values.platform) ||
  !['x64', 'arm64'].includes(values.arch)
) {
  throw new Error('Use a supported desktop platform and architecture.');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const shellPkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const electronVersion = shellPkg.devDependencies.electron;
const target = values.platform === 'darwin' ? 'mac' : values.platform === 'win32' ? 'win' : 'linux';
const executableName =
  values['executable-name'] || (values.platform === 'darwin' ? 'OpenAgentAPI' : 'open-agent-api');

if (!values['shell-only'] && !values['dry-run']) {
  if (!values['node-dir'] || !values['node-version']) {
    throw new Error('An explicit official Node runtime directory and version are required.');
  }
}

if (values['node-version'] && !satisfiesEngines(values['node-version'], pkg.engines.node)) {
  throw new Error('The supplied Node runtime does not meet the gateway version requirements.');
}

if (
  !values['dry-run'] &&
  values['node-dir'] &&
  values['node-version'] &&
  values.platform === process.platform
) {
  const executable = path.join(
    values['node-dir'],
    values.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  const actual = execFileSync(executable, ['--version'], { encoding: 'utf8' })
    .trim()
    .replace(/^v/, '');
  if (actual !== values['node-version'].replace(/^v/, '')) {
    throw new Error('The supplied Node version does not match the executable.');
  }
}

for (const name of SHELL_FILES) {
  if (!fs.existsSync(path.join(here, name))) {
    throw new Error(`Missing desktop shell source file: ${name}`);
  }
}

const plannedArchiveName =
  values.platform === 'darwin' || values['no-archive'] || values['shell-only']
    ? null
    : `Open-Agent-API-desktop-${pkg.version}-${values.platform}-${values.arch}.${values.platform === 'win32' ? 'zip' : 'tar.gz'}`;

if (values['dry-run']) {
  const resolvedOut = values['out-dir']
    ? path.resolve(values['out-dir'])
    : path.join(root, 'output', `desktop-package-${values.platform}-${values.arch}`);
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        shell: 'electron-unified',
        platform: values.platform,
        arch: values.arch,
        target,
        version: pkg.version,
        electronVersion,
        executableName,
        shellOnly: Boolean(values['shell-only']),
        shellFiles: SHELL_FILES,
        entitlements: values.platform === 'darwin' ? path.join(here, 'entitlements.plist') : null,
        outDir: resolvedOut,
        plannedArchive: plannedArchiveName ? path.join(resolvedOut, plannedArchiveName) : null,
        installed: false,
        signed: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const { packager } = await import('@electron/packager');
const { Data } = await import('resedit');

let output;
if (values['out-dir']) {
  output = path.resolve(values['out-dir']);
  fs.mkdirSync(output, { recursive: true });
} else {
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  output = fs.mkdtempSync(path.join(root, 'output/desktop-package-'));
}

const staging = path.join(output, 'shell');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const name of SHELL_FILES) {
  fs.copyFileSync(path.join(here, name), path.join(staging, name));
}
fs.writeFileSync(
  path.join(staging, 'package.json'),
  JSON.stringify({
    name: 'open-agent-api',
    productName: 'Open Agent API',
    version: pkg.version,
    main: 'main.cjs',
    description: pkg.description,
    author: 'Open Agent API contributors',
    license: pkg.license,
  }),
);

const icon = path.join(output, 'icon.png');
fs.copyFileSync(path.join(root, 'docs/brand/oaa-app-icon-1024.png'), icon);

const extraResource = [icon];
if (values.platform === 'darwin') {
  const tpl1x = path.join(output, 'StatusTemplate.png');
  const tpl2x = path.join(output, 'StatusTemplate@2x.png');
  fs.writeFileSync(tpl1x, statusTemplatePng(18));
  fs.writeFileSync(tpl2x, statusTemplatePng(36));
  extraResource.push(tpl1x, tpl2x);
}

if (!values['shell-only']) {
  const gateway = path.join(output, 'gateway');
  const runtime = path.join(output, 'runtime');
  fs.rmSync(gateway, { recursive: true, force: true });
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(gateway, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });

  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const filter = releaseCopyFilter(
    payloadFilter(payloadPackages(lock, target, values.arch), target, values.arch),
    target,
  );
  for (const name of [
    'dist',
    'web',
    'examples',
    'package.json',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'licenses',
    'node_modules',
  ]) {
    const source = path.join(root, name);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(gateway, name), {
      recursive: true,
      dereference: true,
      filter: (file) => filter(path.relative(root, file).split(path.sep).join('/')),
    });
  }

  for (const entry of nodeRuntimeFiles(target, path.resolve(values['node-dir']), runtime)) {
    if (!fs.existsSync(entry.from)) throw new Error(`Missing Node runtime file: ${entry.from}`);
    fs.mkdirSync(path.dirname(entry.to), { recursive: true });
    fs.copyFileSync(entry.from, entry.to);
    if (values.platform !== 'win32' && entry.to.endsWith('/node')) fs.chmodSync(entry.to, 0o755);
  }
  extraResource.unshift(gateway, runtime);
}

let applicationIcon = values.platform === 'linux' ? icon : undefined;
if (values.platform === 'win32') {
  const file = new Data.IconFile();
  file.icons.push({ data: Data.RawIconItem.from(brandIconPng(256), 256, 256, 32) });
  applicationIcon = path.join(output, 'icon.ico');
  fs.writeFileSync(applicationIcon, Buffer.from(file.generate()));
} else if (values.platform === 'darwin' && process.platform === 'darwin') {
  const directory = path.join(output, 'icon.iconset');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(directory, `icon_${size}x${size}.png`), brandIconPng(size));
    fs.writeFileSync(path.join(directory, `icon_${size}x${size}@2x.png`), brandIconPng(size * 2));
  }
  applicationIcon = path.join(output, 'icon.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', directory, '-o', applicationIcon]);
}

const appsOut = path.join(output, 'apps');
fs.rmSync(appsOut, { recursive: true, force: true });
const paths = await packager({
  dir: staging,
  out: appsOut,
  platform: values.platform,
  arch: values.arch,
  electronVersion,
  name: 'Open Agent API',
  executableName,
  appBundleId: 'dev.oaa.desktop',
  appVersion: pkg.version,
  asar: true,
  prune: false,
  overwrite: true,
  extraResource,
  ...(applicationIcon ? { icon: applicationIcon } : {}),
});

const archives = [];
if (plannedArchiveName) {
  for (const directory of paths) {
    const archive = path.join(output, plannedArchiveName);
    const command =
      values.platform === 'win32'
        ? zipCommand({
            hostPlatform: process.platform,
            zipPath: archive,
            bundleName: path.basename(directory),
          })
        : tarCommand({
            hostPlatform: process.platform,
            tarPath: archive,
            bundleName: path.basename(directory),
          });
    execFileSync(command.cmd, command.args, { cwd: path.dirname(directory) });
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    fs.writeFileSync(`${archive}.sha256`, `${hash.digest('hex')}  ${path.basename(archive)}\n`);
    archives.push(archive);
  }
}

console.log(
  JSON.stringify(
    {
      shell: 'electron-unified',
      platform: values.platform,
      arch: values.arch,
      version: pkg.version,
      paths,
      archives,
      installed: false,
      signed: false,
    },
    null,
    2,
  ),
);
