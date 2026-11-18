import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ERROR_CATALOG } from '../src/core/errors.js';

// Documentation checks, offline and without listening on a port:
// - every relative link between Markdown files (and from README to images) points at an existing
//   file, and a `#anchor` points at a real heading of the target file (GitHub's slug rules);
// - every English document under docs/ has a Chinese twin under docs/zh-CN/ and the other way
//   round, and both sides carry the language switch line;
// - the HTTP statuses in the error-code tables of both protocol documents agree with each other
//   and with the error catalog in src/core/errors.ts.

/**
 * Documents that are being added by other work and may exist in one language only for now. Links to
 * a pending document that does not exist yet are tolerated too. DELETE THIS LIST (and the
 * "pending list is honest" test) once every name here has both an English and a Chinese version.
 */
const PENDING_NEW_DOCS: string[] = [];

/** Directories that never hold project documentation. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'release',
  'output',
  'site-dist',
  'coverage',
  '.claude',
  '.playwright-cli',
  '.venv',
  'venv',
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.oaa')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const posix = (file: string) => file.split(path.sep).join('/');

/** Text with fenced code blocks and inline code removed, so that examples are not mistaken for links. */
function prose(text: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      kept.push('');
    } else if (marker) {
      fence = marker;
      kept.push('');
    } else kept.push(line.replace(/`[^`]*`/g, ''));
  }
  return kept.join('\n');
}

/** GitHub's heading anchor (the rule itself is shared with the documentation site generator). */
const { githubSlug } = (await import(
  pathToFileURL(path.resolve('tools/docs-site/slug.mjs')).href
)) as { githubSlug: (text: string) => string };
function slug(heading: string): string {
  return githubSlug(
    heading
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+#+\s*$/, '')
      .split('`')
      .map((part, i) => (i % 2 === 0 ? part.replace(/<[^>]+>/g, '') : part))
      .join(''),
  );
}

const anchorCache = new Map<string, Set<string>>();
async function anchorsOf(file: string): Promise<Set<string>> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]!);
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = slug(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

const isPendingDoc = (target: string) => {
  const rel = posix(path.relative('.', target));
  const m = /^docs\/(?:zh-CN\/)?([a-z-]+)\.md$/.exec(rel);
  return m !== undefined && m !== null && PENDING_NEW_DOCS.includes(m[1]!);
};

test('docs: relative links between Markdown files point at existing files and headings', async () => {
  const problems: string[] = [];
  let checked = 0;
  for (const file of await walk('.')) {
    const text = prose(await readFile(file, 'utf8'));
    const targets = [
      ...[...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!),
      ...[...text.matchAll(/\b(?:href|src|srcset)="([^"\s]+)"/g)].map((m) => m[1]!),
      ...[...text.matchAll(/^\[[^\]]+\]:\s+(\S+)/gm)].map((m) => m[1]!),
    ];
    for (const raw of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      const [filePart = '', anchorPart] = raw.split('#') as [string, string | undefined];
      const target = filePart
        ? path.resolve(path.dirname(file), decodeURIComponent(filePart))
        : path.resolve(file);
      const where = `${posix(file)}: ${raw}`;
      checked++;
      if (!existsSync(target)) {
        if (!isPendingDoc(target)) problems.push(`${where} (no such file)`);
        continue;
      }
      if (anchorPart === undefined || anchorPart === '' || !target.endsWith('.md')) continue;
      if (statSync(target).isDirectory()) continue;
      const anchors = await anchorsOf(target);
      if (!anchors.has(decodeURIComponent(anchorPart)))
        problems.push(`${where} (no such heading in ${posix(path.relative('.', target))})`);
    }
  }
  assert.ok(checked > 200, `expected to check the links of the whole repository, saw ${checked}`);
  assert.deepEqual(problems, []);
});

const docNames = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.slice(0, -3))
    .sort();

test('docs: every English document has a Chinese twin under docs/zh-CN and the other way round', async () => {
  const english = await docNames('docs');
  const chinese = await docNames('docs/zh-CN');
  const pending = new Set(PENDING_NEW_DOCS);
  assert.deepEqual(
    english.filter((name) => !chinese.includes(name) && !pending.has(name)),
    [],
    'missing under docs/zh-CN/',
  );
  assert.deepEqual(
    chinese.filter((name) => !english.includes(name) && !pending.has(name)),
    [],
    'missing under docs/',
  );
});

test('docs: the pending list is honest (remove names that now exist in both languages)', async () => {
  const english = await docNames('docs');
  const chinese = await docNames('docs/zh-CN');
  const done = PENDING_NEW_DOCS.filter((n) => english.includes(n) && chinese.includes(n));
  assert.deepEqual(done, [], 'delete these names from PENDING_NEW_DOCS in test/docs.test.ts');
});

/** [English file, Chinese file, expected switch line in each]. */
async function documentPairs(): Promise<Array<[string, string, string, string]>> {
  const pairs: Array<[string, string, string, string]> = [];
  for (const name of (await docNames('docs')).filter((n) => existsSync(`docs/zh-CN/${n}.md`)))
    pairs.push([
      `docs/${name}.md`,
      `docs/zh-CN/${name}.md`,
      `English · [简体中文](zh-CN/${name}.md)`,
      `[English](../${name}.md) · 简体中文`,
    ]);
  for (const name of ['CONTRIBUTING', 'SECURITY', 'CODE_OF_CONDUCT', 'CHANGELOG', 'ROADMAP'])
    pairs.push([
      `${name}.md`,
      `${name}.zh-CN.md`,
      `English · [简体中文](${name}.zh-CN.md)`,
      `[English](${name}.md) · 简体中文`,
    ]);
  pairs.push([
    'README.md',
    'README.zh-CN.md',
    'English · <a href="README.zh-CN.md">简体中文</a>',
    '<a href="README.md">English</a> · 简体中文',
  ]);
  return pairs;
}

test('docs: both languages carry the language switch line near the top', async () => {
  const problems: string[] = [];
  for (const [en, zh, enLine, zhLine] of await documentPairs()) {
    for (const [file, line] of [
      [en, enLine],
      [zh, zhLine],
    ] as const) {
      if (!existsSync(file)) {
        problems.push(`${file} is missing`);
        continue;
      }
      const head = (await readFile(file, 'utf8')).split('\n').slice(0, 20);
      if (!head.some((l) => l.trim() === line)) problems.push(`${file}: missing "${line}"`);
    }
  }
  assert.deepEqual(problems, []);
});

test('docs: the changelog starts with an empty Unreleased section in both languages', async () => {
  const english = await readFile('CHANGELOG.md', 'utf8');
  const chinese = await readFile('CHANGELOG.zh-CN.md', 'utf8');
  assert.match(english, /^## Unreleased$/m);
  assert.match(chinese, /^## 未发布$/m);
  assert.ok(
    english.indexOf('## Unreleased') < english.indexOf('## 0.0.'),
    'Unreleased comes first',
  );
  assert.ok(chinese.indexOf('## 未发布') < chinese.indexOf('## 0.0.'), '未发布 comes first');
});

/** code -> HTTP column of the error-code tables of a protocol document. */
async function errorTable(file: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  let inErrors = false;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (/^## (Error codes|错误码)/.test(line)) inErrors = true;
    const m = /^\| `([a-z0-9_]+)` \| ([^|]+) \|/.exec(line);
    if (inErrors && m) rows.set(m[1]!, m[2]!.trim());
  }
  return rows;
}

test('docs: the error-code tables of both protocol documents match the error catalog', async () => {
  const english = await errorTable('docs/protocol.md');
  const chinese = await errorTable('docs/zh-CN/protocol.md');
  assert.ok(english.size > 200, `expected the full table, found ${english.size} rows`);
  assert.deepEqual([...english.keys()].sort(), [...chinese.keys()].sort(), 'same codes');
  const mismatches: string[] = [];
  for (const [code, http] of english) {
    if (chinese.get(code) !== http)
      mismatches.push(`${code}: en ${http} vs zh ${chinese.get(code)}`);
    const entry = ERROR_CATALOG.find((e) => e.code === code);
    if (!entry) {
      mismatches.push(`${code}: not in the error catalog`);
      continue;
    }
    const want = entry.statuses
      ? entry.statuses.join('/')
      : entry.status === null
        ? '—'
        : String(entry.status);
    if (http !== want) mismatches.push(`${code}: doc ${http} vs catalog ${want}`);
  }
  assert.deepEqual(mismatches, []);
});
