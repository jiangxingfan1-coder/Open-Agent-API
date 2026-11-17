import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const env = { ...process.env, OAA_DESKTOP_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require('electron'),
  [path.dirname(fileURLToPath(import.meta.url)), ...process.argv.slice(2)],
  { env, stdio: 'inherit' },
);
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
