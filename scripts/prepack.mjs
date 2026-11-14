// `npm pack` / `npm publish` run this first: rebuild dist/ from scratch so the tarball can never carry
// stale compiled files (for example a module that has since been deleted from src/).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
// On Windows npm is npm.cmd, which only runs through a shell; the arguments are fixed.
const r = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.status !== 0) {
  console.error('prepack: npm run build failed; refusing to pack.');
  process.exit(r.status ?? 1);
}
