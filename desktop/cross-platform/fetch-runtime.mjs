import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import extract from '@electron-internal/extract-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: { platform: { type: 'string' }, arch: { type: 'string' }, version: { type: 'string' } },
});
if (
  !['win32', 'linux', 'darwin'].includes(values.platform) ||
  !['x64', 'arm64'].includes(values.arch) ||
  !/^\d+\.\d+\.\d+$/.test(values.version ?? '')
)
  throw Error('Provide platform, architecture and exact Node version.');
const os = values.platform === 'win32' ? 'win' : values.platform;
const name = `node-v${values.version}-${os}-${values.arch}`;
const archive = `${name}.${values.platform === 'win32' ? 'zip' : 'tar.gz'}`;
const base = `https://nodejs.org/dist/v${values.version}`;
const output = fs.mkdtempSync(path.join(root, 'output/node-runtime-'));
const file = path.join(output, archive);
const curl = (args) =>
  execFileSync(
    'curl',
    ['--fail', '--location', '--silent', '--show-error', '--max-time', '300', ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
const sums = curl([`${base}/SHASUMS256.txt`]);
const expected = sums
  .split('\n')
  .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line))
  .find((row) => row?.[2] === archive)?.[1];
if (!expected) throw Error('The official Node checksum list does not contain this archive.');
curl(['--output', file, `${base}/${archive}`]);
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
if (hash.digest('hex') !== expected)
  throw Error('Node runtime checksum mismatch; extraction refused.');
if (values.platform === 'win32') await extract(file, { dir: output });
else execFileSync('tar', ['-xzf', file, '-C', output]);
const receipt = {
  directory: path.join(output, name),
  version: values.version,
  platform: values.platform,
  arch: values.arch,
  sha256: expected,
  source: `${base}/${archive}`,
};
fs.writeFileSync(path.join(output, 'verified-runtime.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
