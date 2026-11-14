#!/usr/bin/env node
// Regenerate every committed logo asset from scripts/brand-icon.mjs:
//   node scripts/brand-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markSvg, tileSvg, writeBrandIconPng } from './brand-icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  console.log('wrote', file);
};
out('web/brand.svg', tileSvg({ stroke: 12 })); // favicon: slightly heavier line for 16–32 px tabs
out('docs/brand/oaa-app-icon.svg', tileSvg());
out('docs/brand/oaa-mark.svg', markSvg({ color: '#000000' }));
out('docs/brand/oaa-mark-ink.svg', markSvg({ color: '#132220' }));
out('docs/brand/oaa-mark-inverse.svg', markSvg({ color: '#F2F2F2' }));
writeBrandIconPng(path.join(root, 'docs/brand/oaa-app-icon-1024.png'), 1024);
console.log('wrote docs/brand/oaa-app-icon-1024.png');
