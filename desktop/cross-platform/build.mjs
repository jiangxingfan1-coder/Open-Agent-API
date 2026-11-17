import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packager } from '@electron/packager';
import { Data } from 'resedit';
import { brandIconPng } from '../../scripts/brand-icon.mjs';
import {
  nodeRuntimeFiles,
  satisfiesEngines,
  payloadPackages,
  payloadFilter,
  releaseCopyFilter,
  zipCommand,
  tarCommand,
} from '../../scripts/release-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, '../..');
const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
    'node-dir': { type: 'string' },
    'node-version': { type: 'string' },
  },
});
if (
  !['darwin', 'win32', 'linux'].includes(values.platform) ||
  !['x64', 'arm64'].includes(values.arch)
)
  throw Error('Use a supported desktop platform and architecture.');
if (!values['node-dir'] || !values['node-version'])
  throw Error('An explicit official Node runtime directory and version are required.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!satisfiesEngines(values['node-version'], pkg.engines.node))
  throw Error('The supplied Node runtime does not meet the gateway version requirements.');
if (values.platform === process.platform) {
  const executable = path.join(
    values['node-dir'],
    values.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  const actual = execFileSync(executable, ['--version'], { encoding: 'utf8' })
    .trim()
    .replace(/^v/, '');
  if (actual !== values['node-version'])
    throw Error('The supplied Node version does not match the executable.');
}
const target = values.platform === 'darwin' ? 'mac' : values.platform === 'win32' ? 'win' : 'linux';
const output = fs.mkdtempSync(path.join(root, 'output/desktop-package-'));
const staging = path.join(output, 'shell'),
  gateway = path.join(output, 'gateway'),
  runtime = path.join(output, 'runtime');
fs.mkdirSync(staging);
fs.mkdirSync(gateway);
fs.mkdirSync(runtime);
for (const name of ['main.cjs', 'preload.cjs', 'core.cjs', 'strings.cjs'])
  fs.copyFileSync(path.join(here, name), path.join(staging, name));
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
  if (!fs.existsSync(entry.from)) throw Error(`Missing Node runtime file: ${entry.from}`);
  fs.mkdirSync(path.dirname(entry.to), { recursive: true });
  fs.copyFileSync(entry.from, entry.to);
  if (values.platform !== 'win32' && entry.to.endsWith('/node')) fs.chmodSync(entry.to, 0o755);
}
const icon = path.join(output, 'icon.png');
fs.copyFileSync(path.join(root, 'docs/brand/oaa-app-icon-1024.png'), icon);
const electronVersion = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
  .devDependencies.electron;
let applicationIcon = values.platform === 'linux' ? icon : undefined;
if (values.platform === 'win32') {
  const file = new Data.IconFile();
  file.icons.push({ data: Data.RawIconItem.from(brandIconPng(256), 256, 256, 32) });
  applicationIcon = path.join(output, 'icon.ico');
  fs.writeFileSync(applicationIcon, Buffer.from(file.generate()));
} else if (values.platform === 'darwin' && process.platform === 'darwin') {
  const directory = path.join(output, 'icon.iconset');
  fs.mkdirSync(directory);
  for (const size of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(directory, `icon_${size}x${size}.png`), brandIconPng(size));
    fs.writeFileSync(path.join(directory, `icon_${size}x${size}@2x.png`), brandIconPng(size * 2));
  }
  applicationIcon = path.join(output, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', directory, '-o', applicationIcon]);
}
const paths = await packager({
  dir: staging,
  out: path.join(output, 'apps'),
  platform: values.platform,
  arch: values.arch,
  electronVersion,
  name: 'Open Agent API',
  executableName: 'open-agent-api',
  appBundleId: 'com.openagentapi.desktop',
  appVersion: pkg.version,
  asar: true,
  prune: false,
  overwrite: false,
  extraResource: [gateway, runtime, icon],
  ...(applicationIcon ? { icon: applicationIcon } : {}),
});
const archives = [];
if (values.platform !== 'darwin') {
  for (const directory of paths) {
    const archive = path.join(
      output,
      `Open-Agent-API-desktop-${pkg.version}-${values.platform}-${values.arch}.${values.platform === 'win32' ? 'zip' : 'tar.gz'}`,
    );
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
