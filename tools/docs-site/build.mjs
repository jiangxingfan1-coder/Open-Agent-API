#!/usr/bin/env node
// Builds the documentation site next to the showcase pages.
//
//   node tools/docs-site/build.mjs [--out site-dist] [--check] [--ref main]
//
// Reads docs/, docs/zh-CN/ and examples/cookbook/README*.md, writes the whole site (the showcase from site/ plus the
// rendered documents) to the output directory and, with --check, verifies the generated HTML and every link.
// Pure Node, no dependency, no network. The output directory is emptied first; the generator refuses to use a
// directory that holds sources.
import path from 'node:path';
import { buildSite, writeSite } from './site.mjs';
import { checkSite } from './validate.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = process.cwd();
const out = path.resolve(root, option('--out', 'site-dist'));
const ref = option('--ref', 'main');

const result = await buildSite({ root, ref });
if (args.includes('--check')) {
  const { problems, checked } = checkSite(result);
  if (problems.length) {
    console.error(`docs-site: ${problems.length} problem(s) in the generated site:`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `docs-site: checked ${result.files.size} generated files and ${checked} internal references`,
  );
}
await writeSite(result, { root, out });
const pages = result.pages.length;
console.log(
  `docs-site: wrote ${pages} documents (${result.files.size} generated files, ${result.copies.length} copied) to ${path.relative(root, out) || '.'}`,
);
for (const w of result.warnings)
  console.log(`docs-site: note: ${w.kind} in ${w.from ?? ''}: ${w.detail ?? w.href}`);
