// Prints scripts/install.sh with the release version stamped in (the copy attached to a GitHub
// Release installs exactly that release). Usage: node scripts/stamp-install.mjs <version> > install.sh
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampInstallScript } from './release-plan.mjs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.sh');
try {
  process.stdout.write(stampInstallScript(fs.readFileSync(source, 'utf8'), version));
} catch (err) {
  console.error(`stamp-install: ${err.message}`);
  process.exit(1);
}
