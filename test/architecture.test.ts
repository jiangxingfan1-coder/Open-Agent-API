import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// 架构测试：静态读取 src/ 下的 .ts 源文件，守住分层、循环引用、文件行数与 any 数量。不监听端口。

/** 目录 → 层级。数字小的是底层；只许引用同目录或层级更低的目录。 */
const LAYERS: Record<string, number> = {
  core: 0,
  config: 1,
  lang: 2,
  store: 2,
  providers: 2,
  engines: 3,
  fabric: 4,
  kernel: 5,
  gateway: 6,
  client: 7,
};

/** 行数预算（棘轮）：只登记超过 600 行的文件，上限 = 登记时行数向上取整到 50。以后只许调低。 */
const DEFAULT_LINE_LIMIT = 600;
const LINE_BUDGETS: Record<string, number> = {
  'gateway/server.ts': 700,
  'store/store.ts': 1550,
  'lang/graph.ts': 1350,
  'fabric/network.ts': 1350,
  'providers/models.ts': 1250,
  'cli.ts': 1000,
  'engines/acp.ts': 800,
  'fabric/worker.ts': 750,
  'kernel/routing.ts': 750,
  'gateway/timeline.ts': 650,
  'engines/native.ts': 650,
};

/** `as any` 与 `: any` 的总数上限（棘轮）。以后只许调低。 */
const ANY_BUDGET = 0;

const SRC = path.resolve('src');

type Source = { file: string; text: string; imports: string[] };

async function loadSources(): Promise<Source[]> {
  const entries = (await readdir(SRC, { recursive: true }))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
  const sources: Source[] = [];
  for (const file of entries) {
    const text = await readFile(path.join(SRC, file), 'utf8');
    const imports = ts
      .preProcessFile(text, true, true)
      .importedFiles.map((i) => i.fileName)
      .filter((spec) => spec.startsWith('./') || spec.startsWith('../'))
      .map((spec) =>
        path.posix
          .normalize(path.posix.join(path.posix.dirname(file), spec))
          .replace(/\.js$/, '.ts'),
      );
    sources.push({ file, text, imports });
  }
  return sources;
}

const dirOf = (file: string) => (file.includes('/') ? (file.split('/')[0] ?? '') : '');

test('architecture: every src file except cli.ts lives in a layered directory', async () => {
  const misplaced = (await loadSources())
    .map((s) => s.file)
    .filter((f) => f !== 'cli.ts' && (f.split('/').length !== 2 || !(dirOf(f) in LAYERS)));
  assert.deepEqual(misplaced, []);
});

test('architecture: imports point only to the same directory or a lower layer', async () => {
  const sources = await loadSources();
  const known = new Set(sources.map((s) => s.file));
  const violations: string[] = [];
  for (const { file, imports } of sources) {
    if (file === 'cli.ts') continue;
    const from = dirOf(file);
    for (const target of imports) {
      if (!known.has(target)) {
        violations.push(`${file} -> ${target} (not a src file)`);
        continue;
      }
      const to = dirOf(target);
      if (to === from) continue;
      if (target === 'cli.ts' || !((LAYERS[to] ?? 99) < (LAYERS[from] ?? -1)))
        violations.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('architecture: no import cycles between files (import type included)', async () => {
  const sources = await loadSources();
  const graph = new Map(sources.map((s) => [s.file, s.imports]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[] = [];
  const stack: string[] = [];
  const visit = (file: string) => {
    state.set(file, 'visiting');
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      if (!graph.has(next)) continue;
      const seen = state.get(next);
      if (seen === 'visiting')
        cycles.push([...stack.slice(stack.indexOf(next)), next].join(' -> '));
      else if (!seen) visit(next);
    }
    stack.pop();
    state.set(file, 'done');
  };
  for (const file of graph.keys()) if (!state.has(file)) visit(file);
  assert.deepEqual(cycles, []);
});

test('architecture: file line counts stay within the ratchet budget', async () => {
  const over: string[] = [];
  const sources = await loadSources();
  for (const { file, text } of sources) {
    const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    const limit = LINE_BUDGETS[file] ?? DEFAULT_LINE_LIMIT;
    if (lines > limit) over.push(`${file}: ${lines} > ${limit}`);
  }
  const files = new Set(sources.map((s) => s.file));
  const stale = Object.keys(LINE_BUDGETS).filter((f) => !files.has(f));
  assert.deepEqual(over, []);
  assert.deepEqual(stale, []);
});

test('architecture: count of `any` types (annotations, casts, generic arguments) does not grow', async () => {
  let count = 0;
  // `: any`, `as any`, `any[]`, and `any` as a generic argument (`<any>`, `<string, any>`).
  const anyType = /\bas any\b|: any\b|\bany\[\]|[<,]\s*any\s*[>,]/g;
  for (const { text } of await loadSources()) count += (text.match(anyType) ?? []).length;
  assert.ok(count <= ANY_BUDGET, `any count ${count} > ${ANY_BUDGET}`);
});

test('architecture: the product version matches package.json and is defined once', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  const { PRODUCT_VERSION } = await import('../src/core/version.js');
  assert.equal(PRODUCT_VERSION, pkg.version);
  const literal = `'${pkg.version}'`;
  const stray = (await loadSources())
    .filter((s) => s.file !== 'core/version.ts' && s.text.includes(literal))
    .map((s) => s.file);
  assert.deepEqual(stray, []);
});

test('architecture: desktop/ and scripts/ never hard-code the product version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  // The version only counts as a hard-coded literal when it is not part of a longer number or
  // dotted version (0.0.640, 10.0.64 and 0.0.64.1 are different strings).
  const literal = new RegExp(`(?<![\\d.])${pkg.version.replace(/\./g, '\\.')}(?![\\d.]*\\d)`);
  // A version printed after the product name is the same mistake even when it is stale
  // ("Open Agent API 0.6.4" lived in the macOS About dialog after the renumbering to 0.0.64).
  const named = /Open Agent API v?\d+\.\d+\.\d+/;
  const problems: string[] = [];
  let checked = 0;
  for (const dir of ['desktop', 'scripts']) {
    for (const entry of await readdir(dir, { recursive: true })) {
      if (!/\.(swift|mjs|js|ts|sh|ps1|cmd|vbs|plist|json|yml|yaml)$/.test(entry)) continue;
      const text = await readFile(path.join(dir, entry), 'utf8');
      checked++;
      const file = `${dir}/${entry.split(path.sep).join('/')}`;
      if (literal.test(text)) problems.push(`${file}: contains ${pkg.version}`);
      if (named.test(text)) problems.push(`${file}: prints a version after the product name`);
    }
  }
  assert.ok(checked >= 10, `expected to scan desktop/ and scripts/, saw ${checked} files`);
  assert.deepEqual(problems, []);
});
