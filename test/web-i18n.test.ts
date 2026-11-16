import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The console is bilingual (Chinese / English). Static checks over web/: the two dictionaries of
// each group have the same keys and placeholders, every key the code and index.html ask for exists,
// no key sits unused, and no Chinese text is left in the code outside the zh dictionaries. Plus the
// language and plural rules of lib/i18n.js with a stubbed browser. No sockets, no models.

const WEB = fileURLToPath(new URL('../../web', import.meta.url));
const rel = (file: string) => path.relative(WEB, file).split(path.sep).join('/');

/** Files that may hold Chinese text on purpose: the zh dictionaries, zh date wording, fonts. */
const CHINESE_ALLOWED = [
  /^lib\/messages-[a-z-]+-zh\.js$/,
  /^lib\/messages\/[a-z-]+-zh\.js$/,
  /^shared\/format-zh\.js$/,
  /^shared\/fonts-serif-sc\.css$/,
  /^portal\//,
  /^fonts\//,
  /^agents\//,
];
const CHINESE = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const consoleFiles = walk(WEB).filter((f) => !rel(f).startsWith('portal/'));
const sourceFiles = consoleFiles.filter((f) => /\.(js|html|css)$/.test(f));
const scriptFiles = consoleFiles.filter((f) => f.endsWith('.js'));

type Dict = Record<string, string>;
type Group = { name: string; zh: Dict; en: Dict };

/** Dictionary groups, found by file name: lib/messages-<group>-<lang>.js (or lib/messages/…). */
async function loadGroups(): Promise<Group[]> {
  const found = new Map<string, Partial<Record<'zh' | 'en', string>>>();
  for (const file of scriptFiles) {
    const m = /^lib\/messages(?:-|\/)([a-z]+)-(zh|en)\.js$/.exec(rel(file));
    if (!m) continue;
    const entry = found.get(m[1]!) ?? {};
    entry[m[2] as 'zh' | 'en'] = file;
    found.set(m[1]!, entry);
  }
  const groups: Group[] = [];
  for (const [name, files] of [...found].sort()) {
    assert.ok(files.zh && files.en, `group ${name} needs both a zh and an en file`);
    const zh = ((await import(`file://${files.zh}`)) as { zh: Dict }).zh;
    const en = ((await import(`file://${files.en}`)) as { en: Dict }).en;
    groups.push({ name, zh, en });
  }
  return groups;
}
const groups = await loadGroups();
const merged = (lang: 'zh' | 'en') => Object.assign({}, ...groups.map((g) => g[lang])) as Dict;

/** `{name}` and `{name|one|other}` placeholders of a message, by name. */
const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)].map((m) => m[1]!).sort();

test('i18n: every group has a zh and an en dictionary with the same keys and placeholders', () => {
  assert.deepEqual(
    groups.map((g) => g.name),
    ['connections', 'core', 'dialogs', 'models', 'platform', 'views'],
  );
  for (const g of groups) {
    const zhKeys = Object.keys(g.zh).sort();
    const enKeys = Object.keys(g.en).sort();
    assert.deepEqual(
      zhKeys.filter((k) => !(k in g.en)),
      [],
      `${g.name}: keys only in zh`,
    );
    assert.deepEqual(
      enKeys.filter((k) => !(k in g.zh)),
      [],
      `${g.name}: keys only in en`,
    );
    for (const key of zhKeys) {
      assert.ok(g.zh[key]!.trim() && g.en[key]!.trim(), `${g.name}.${key}: empty text`);
      assert.deepEqual(
        [...new Set(placeholders(g.en[key]!))],
        [...new Set(placeholders(g.zh[key]!))],
        `${g.name}.${key}: placeholders differ`,
      );
    }
  }
  // A key belongs to one group only, so merging never lets one silently replace another.
  const all = groups.flatMap((g) => Object.keys(g.zh));
  assert.equal(new Set(all).size, all.length, 'a key appears in two groups');
});

/** Keys named in a script: t('key') calls, plus every quoted dotted literal (a ternary picks one). */
function keysInScript(text: string): { called: string[]; literals: string[] } {
  const called = [...text.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]!);
  const literals = [...text.matchAll(/'([a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9_-]+)+)'/g)].map(
    (m) => m[1]!,
  );
  return { called, literals };
}
/** Keys named in index.html: data-i18n, data-i18n-html and data-i18n-attr="a,b:key;c:key2". */
function keysInHtml(html: string): string[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const keys = [...text.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]!);
  for (const m of text.matchAll(/data-i18n-attr="([^"]+)"/g))
    for (const group of m[1]!.split(';')) keys.push(group.split(':')[1]!.trim());
  return keys;
}

test('i18n: every key the code and index.html ask for is in both dictionaries', () => {
  const zh = merged('zh');
  const en = merged('en');
  const missing: string[] = [];
  for (const file of sourceFiles) {
    if (/\.css$/.test(file) || /\/lib\/messages/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const keys = file.endsWith('.html') ? keysInHtml(text) : keysInScript(text).called;
    for (const key of keys) if (!(key in zh) || !(key in en)) missing.push(`${rel(file)}: ${key}`);
  }
  assert.deepEqual(missing, []);
});

test('i18n: no dictionary key of the pages and the shell is unused', () => {
  const used = new Set<string>();
  for (const file of sourceFiles) {
    if (/\.css$/.test(file) || /\/lib\/messages/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const key of file.endsWith('.html') ? keysInHtml(text) : keysInScript(text).literals)
      used.add(key);
  }
  for (const g of groups) {
    // The dialogs group is written by other work and may build keys at run time.
    if (g.name === 'dialogs') continue;
    const unused = Object.keys(g.zh).filter((k) => !used.has(k));
    assert.deepEqual(unused, [], `${g.name}: unused keys`);
  }
});

test('i18n: no Chinese text is left in the console code, pages or styles (zh dictionaries excepted)', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const name = rel(file);
    if (CHINESE_ALLOWED.some((re) => re.test(name))) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (CHINESE.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim().slice(0, 70)}`);
      });
  }
  assert.deepEqual(offenders, []);
});

test('i18n: console scripts stay under 600 lines', () => {
  const long = scriptFiles
    .filter((f) => !f.includes(`${path.sep}fonts${path.sep}`))
    .map((f) => [rel(f), readFileSync(f, 'utf8').split('\n').length - 1] as const)
    .filter(([, lines]) => lines > 600);
  assert.deepEqual(long, []);
});

/** lib/i18n.js reads document, localStorage and navigator when it loads: stub them per import. */
async function loadI18n(stored: string | null, language: string, tag: string) {
  const root = { lang: '' };
  Object.assign(globalThis, {
    document: { documentElement: root },
    localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true });
  const mod = (await import(`file://${path.join(WEB, 'lib/i18n.js')}?${tag}`)) as {
    lang: string;
    setLang(next: string): void;
    t(key: string, params?: Record<string, unknown>): string;
    locale(): string;
  };
  return { mod, root, saved: () => stored };
}

test('i18n: the language is the saved choice, else the browser language, and sets <html lang>', async () => {
  const zhBrowser = await loadI18n(null, 'zh-TW', 'a');
  assert.equal(zhBrowser.mod.lang, 'zh');
  assert.equal(zhBrowser.root.lang, 'zh-CN');
  assert.equal(zhBrowser.mod.locale(), 'zh-CN');
  const enBrowser = await loadI18n(null, 'de-DE', 'b');
  assert.equal(enBrowser.mod.lang, 'en');
  assert.equal(enBrowser.root.lang, 'en');
  assert.equal(enBrowser.mod.locale(), 'en-US');
  const saved = await loadI18n('en', 'zh-CN', 'c');
  assert.equal(saved.mod.lang, 'en', 'a saved choice wins over the browser');
  const junk = await loadI18n('fr', 'en-US', 'd');
  assert.equal(junk.mod.lang, 'en', 'an unknown saved value is ignored');
  const switching = await loadI18n(null, 'zh-CN', 'g');
  switching.mod.setLang('en');
  assert.equal(switching.saved(), 'en');
  assert.equal(switching.root.lang, 'en');
  switching.mod.setLang('anything');
  assert.equal(switching.saved(), 'zh', 'an unknown language falls back to zh');
});

test('i18n: t() fills placeholders and plurals, and falls back to zh and then the key', async () => {
  const en = await loadI18n('en', 'en-US', 'e');
  assert.equal(en.mod.t('runs.count', { n: 1 }), '1 task');
  assert.equal(en.mod.t('runs.count', { n: 3 }), '3 tasks');
  assert.equal(en.mod.t('runs.count', { n: '1,204' }), '1,204 tasks');
  assert.equal(en.mod.t('runs.count', { n: 0 }), '0 tasks');
  assert.equal(en.mod.t('runs.open', { id: 'run_1' }), 'Open task run_1');
  assert.equal(en.mod.t('no.such.key'), 'no.such.key');
  const zh = await loadI18n('zh', 'en-US', 'f');
  assert.equal(zh.mod.t('runs.count', { n: 3 }), '3 个任务');
  assert.equal(zh.mod.t('runs.open', {}), '打开任务 ');
});
