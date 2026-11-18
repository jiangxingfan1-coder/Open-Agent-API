// The documentation site: reads docs/*.md (English), docs/zh-CN/*.md (Chinese) and the cookbook README files,
// renders them with ./markdown.mjs and lays them out next to the showcase pages.
//
// Output layout (all links are relative, so the site works under a sub-path such as /Open-Agent-API/ and from file://):
//
//   index.html, en/index.html, styles.css, fonts/, assets/ ...  the showcase (copied from site/)
//   docs/index.html, docs/<name>.html                           English documents
//   docs/zh-CN/index.html, docs/zh-CN/<name>.html               Chinese documents
//   docs/cookbook.html, docs/zh-CN/cookbook.html                 the cookbook (from examples/cookbook/README*.md)
//   docs/assets/docs.css, docs.js, search-index.<lang>.js        the documentation's own style, script and search index
//
// `buildSite()` returns everything in memory ({files, copies, pages}); `writeSite()` puts it on disk.
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { esc, renderMarkdown } from './markdown.mjs';
import { buildIndex, indexScript } from './search.mjs';

const posix = path.posix;

/** Per-language settings and interface strings. */
export const LANGS = {
  en: {
    code: 'en',
    outDir: 'docs',
    srcDir: 'docs',
    cookbookSrc: 'examples/cookbook/README.md',
    ui: {
      siteName: 'Open Agent API',
      skip: 'Skip to content',
      docs: 'Docs',
      cookbook: 'Cookbook',
      search: 'Search the documentation',
      searchPlaceholder: 'Search docs',
      searchHint: 'Press / to search',
      noResults: 'No results',
      resultsCount: (n) => `${n} result${n === 1 ? '' : 's'}`,
      menu: 'Documentation menu',
      onThisPage: 'On this page',
      homeLabel: 'Open Agent API, home',
      edit: 'Edit this page on GitHub',
      prev: 'Previous',
      next: 'Next',
      more: 'More',
      examples: 'Examples',
      switchLabel: '中文',
      switchTitle: 'Read this page in Chinese',
      themeToLight: 'Switch to light theme',
      themeToDark: 'Switch to dark theme',
      footer: 'Apache-2.0 · Open Agent API documentation',
      copy: 'Copy',
      copied: 'Copied',
      englishOnly: 'English only',
      titleSuffix: 'Open Agent API docs',
      labels: {},
    },
  },
  'zh-CN': {
    code: 'zh-CN',
    outDir: 'docs/zh-CN',
    srcDir: 'docs/zh-CN',
    cookbookSrc: 'examples/cookbook/README.zh-CN.md',
    ui: {
      siteName: 'Open Agent API',
      skip: '跳到正文',
      docs: '文档',
      cookbook: '示例',
      search: '搜索文档',
      searchPlaceholder: '搜索文档',
      searchHint: '按 / 键搜索',
      noResults: '没有结果',
      resultsCount: (n) => `${n} 条结果`,
      menu: '文档目录',
      onThisPage: '本页内容',
      homeLabel: 'Open Agent API 首页',
      edit: '在 GitHub 上编辑此页',
      prev: '上一篇',
      next: '下一篇',
      more: '其他',
      examples: '示例',
      switchLabel: 'EN',
      switchTitle: '阅读英文版',
      themeToLight: '切换为浅色模式',
      themeToDark: '切换为深色模式',
      footer: 'Apache-2.0 · Open Agent API 文档',
      copy: '复制',
      copied: '已复制',
      englishOnly: '仅英文',
      titleSuffix: 'Open Agent API 文档',
      labels: {
        anchor: '链接到本节',
        table: '表格',
        mermaid: '图示源码（Mermaid）',
        footnote: '脚注',
        back: '返回正文',
        done: '已完成',
        notDone: '未完成',
      },
    },
  },
};
const LANG_CODES = Object.keys(LANGS);
const OTHER = { en: 'zh-CN', 'zh-CN': 'en' };

/** Documents that the site renders although they are not under docs/. */
const COOKBOOK_KEY = 'cookbook';

/** "git+https://github.com/o/r.git" → "https://github.com/o/r". */
export function repoUrlFrom(pkg) {
  const raw = pkg.repository?.url ?? pkg.homepage ?? '';
  return raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/#.*$/, '');
}

const BRAND_MARK = `<svg viewBox="40.11 43 175.78 170" aria-hidden="true"><g><path d="M209.89 207L150.11 49L108.57 155" /><path d="M94.7 190.38L88.19 207" /><path d="M143.36 106.65A50 50 0 1 1 119.1 78.6" /></g></svg>`;
const THEME_ICON = `<svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2.5 12h2.2M19.3 12h2.2M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56" /></svg><svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 14.6A8.2 8.2 0 1 1 9.4 3.8a6.6 6.6 0 0 0 10.8 10.8z" /></svg>`;

const relUrl = (fromFile, toFile) => {
  const r = posix.relative(posix.dirname(fromFile), toFile);
  return r === '' ? posix.basename(toFile) : r;
};

// ───────────────────────────── reading the sources ─────────────────────────────

async function listMarkdown(root, dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return (await readdir(abs, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

/** Drops the "English · 简体中文" language switch line: the site has its own switcher. */
function stripSwitchLine(source) {
  const lines = source.split('\n');
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const l = lines[i].trim();
    if (
      /^English · \[简体中文\]\(.+\)$/.test(l) ||
      /^\[English\]\(.+\) · 简体中文$/.test(l) ||
      /^English · <a href=.+>简体中文<\/a>$/.test(l) ||
      /^<a href=.+>English<\/a> · 简体中文$/.test(l)
    ) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

/** Reads every source document and works out its page. */
async function readSources(root) {
  const pages = [];
  for (const lang of LANG_CODES) {
    const cfg = LANGS[lang];
    for (const name of await listMarkdown(root, cfg.srcDir)) {
      const base = name.slice(0, -3);
      const key = base === 'README' ? 'index' : base;
      pages.push({
        lang,
        key,
        src: posix.join(cfg.srcDir, name),
        out: posix.join(cfg.outDir, key + '.html'),
      });
    }
    if (existsSync(path.join(root, cfg.cookbookSrc)))
      pages.push({
        lang,
        key: COOKBOOK_KEY,
        src: cfg.cookbookSrc,
        out: posix.join(cfg.outDir, COOKBOOK_KEY + '.html'),
      });
  }
  for (const p of pages) p.source = stripSwitchLine(await readFile(path.join(root, p.src), 'utf8'));
  return pages;
}

/**
 * Sidebar groups from the documentation map (docs/README.md, "I want to ..."): each document goes into the first
 * group that links to it. Documents the map does not mention end up under "More".
 */
function navGroups(pages, lang, ui) {
  const own = pages.filter((p) => p.lang === lang);
  const index = own.find((p) => p.key === 'index');
  const byKey = new Map(
    own.filter((p) => p.key !== 'index' && p.key !== COOKBOOK_KEY).map((p) => [p.key, p]),
  );
  const placed = new Set();
  const groups = [];
  let current;
  for (const line of (index?.source ?? '').split('\n')) {
    const h = /^## (.+)$/.exec(line);
    if (h) {
      current = { title: h[1].replace(/[`*_]/g, '').trim(), pages: [] };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    for (const m of line.matchAll(/\]\(([A-Za-z0-9-]+)\.md(?:#[^)\s]*)?\)/g)) {
      const page = byKey.get(m[1]);
      if (page && !placed.has(page.key)) {
        placed.add(page.key);
        current.pages.push(page);
      }
    }
  }
  const rest = [...byKey.values()].filter((p) => !placed.has(p.key));
  // Documents that exist in the other language only are listed too, marked as such.
  const other = pages.filter(
    (p) =>
      p.lang === OTHER[lang] && p.key !== 'index' && p.key !== COOKBOOK_KEY && !byKey.has(p.key),
  );
  const more = { title: ui.more, pages: [...rest, ...other.map((p) => ({ ...p, foreign: true }))] };
  return [...groups.filter((g) => g.pages.length), ...(more.pages.length ? [more] : [])];
}

// ───────────────────────────── links ─────────────────────────────

/**
 * Rewrites a link of a source document for the site: links between documents become links between pages, links to
 * other files of the repository become GitHub URLs, everything else is left alone.
 */
function makeLinkRewriter({ page, byRepoPath, root, repoUrl, ref, record }) {
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
    if (href.startsWith('#')) return href;
    const [filePart, ...anchorParts] = href.split('#');
    const anchor = anchorParts.length ? '#' + anchorParts.join('#') : '';
    let repoPath;
    try {
      repoPath = posix.normalize(posix.join(posix.dirname(page.src), decodeURIComponent(filePart)));
    } catch {
      return href;
    }
    if (repoPath.startsWith('..')) return href;
    const target = byRepoPath.get(repoPath);
    if (target) return relUrl(page.out, target.out) + anchor;
    const abs = path.join(root, repoPath);
    const isDir = existsSync(abs) && statSync(abs).isDirectory();
    if (!existsSync(abs)) record?.({ kind: 'missing-target', from: page.src, href, repoPath });
    return `${repoUrl}/${isDir ? 'tree' : 'blob'}/${ref}/${repoPath.replace(/\/$/, '')}${anchor}`;
  };
}

// ───────────────────────────── page layout ─────────────────────────────

function renderNav(site, page, groups, ui) {
  const item = (p, label) => {
    const current = p.out === page.out;
    const foreign = p.foreign ? ` hreflang="${OTHER[page.lang]}" lang="${OTHER[page.lang]}"` : '';
    return `<li><a href="${esc(relUrl(page.out, p.out))}"${foreign}${current ? ' aria-current="page"' : ''}>${esc(label ?? p.title)}${p.foreign ? ` <span class="tag">${esc(ui.englishOnly)}</span>` : ''}</a></li>`;
  };
  const home = site.pages.find((p) => p.lang === page.lang && p.key === 'index');
  const cookbook = site.pages.find((p) => p.lang === page.lang && p.key === COOKBOOK_KEY);
  let html = '<ul class="nav-top">';
  if (home) html += item(home, ui.docs);
  if (cookbook) html += item(cookbook, ui.cookbook);
  html += '</ul>';
  for (const g of groups) {
    html += `<div class="nav-group"><p class="nav-title">${esc(g.title)}</p><ul>${g.pages.map((p) => item(p)).join('')}</ul></div>`;
  }
  return html;
}

function renderToc(page, ui) {
  const items = page.rendered.headings.filter((h) => h.level === 2 || h.level === 3);
  if (items.length < 2) return '';
  const list = items
    .map((h) => `<li class="l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('');
  return `<p class="toc-title">${esc(ui.onThisPage)}</p><ul>${list}</ul>`;
}

function description(page) {
  const para = page.rendered.sections.find((s) => s.text.trim() && s.level <= 2)?.text ?? '';
  const t = para.replace(/\s+/g, ' ').trim();
  return t.length > 170 ? t.slice(0, 167).replace(/\s+\S*$/, '') + '…' : t;
}

function renderPage(site, page) {
  const { lang } = page;
  const ui = LANGS[lang].ui;
  const groups = site.groups[lang];
  const twin = site.pages.find((p) => p.lang === OTHER[lang] && p.key === page.key);
  const base = posix.relative(posix.dirname(page.out), '.') || '.'; // "..", "../.."
  const docsAssets = relUrl(page.out, 'docs/assets');
  const home = lang === 'en' ? `${base}/en/index.html` : `${base}/index.html`;
  const nav = renderNav(site, page, groups, ui);
  const toc = renderToc(page, ui);
  const flat = [
    ...(site.pages.find((p) => p.lang === lang && p.key === 'index')
      ? [site.pages.find((p) => p.lang === lang && p.key === 'index')]
      : []),
    ...groups.flatMap((g) => g.pages.filter((p) => !p.foreign)),
  ];
  const at = flat.findIndex((p) => p.out === page.out);
  const prev = at > 0 ? flat[at - 1] : undefined;
  const next = at >= 0 && at < flat.length - 1 ? flat[at + 1] : undefined;
  const pager =
    prev || next
      ? `<nav class="pager" aria-label="${esc(ui.prev)} / ${esc(ui.next)}">${prev ? `<a class="prev" href="${esc(relUrl(page.out, prev.out))}"><span>${esc(ui.prev)}</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${esc(relUrl(page.out, next.out))}"><span>${esc(ui.next)}</span>${esc(next.title)}</a>` : '<span></span>'}</nav>`
      : '';
  const docsHome = site.pages.find((p) => p.lang === lang && p.key === 'index');
  const cookbook = site.pages.find((p) => p.lang === lang && p.key === COOKBOOK_KEY);
  const switchLink = twin
    ? `<a class="lang" href="${esc(relUrl(page.out, twin.out))}" hreflang="${OTHER[lang]}" lang="${OTHER[lang]}" title="${esc(ui.switchTitle)}">${esc(ui.switchLabel)}</a>`
    : `<a class="lang" href="${esc(relUrl(page.out, site.pages.find((p) => p.lang === OTHER[lang] && p.key === 'index').out))}" hreflang="${OTHER[lang]}" lang="${OTHER[lang]}" title="${esc(ui.switchTitle)}">${esc(ui.switchLabel)}</a>`;
  const alternates = twin
    ? `<link rel="alternate" hreflang="${OTHER[lang]}" href="${esc(relUrl(page.out, twin.out))}">\n    <link rel="alternate" hreflang="${lang}" href="${esc(posix.basename(page.out))}">`
    : '';
  const title =
    page.key === 'index'
      ? `${page.title} · ${ui.titleSuffix}`
      : `${page.title} · ${ui.titleSuffix}`;
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description(page))}">
    <link rel="icon" type="image/svg+xml" href="${base}/favicon.svg">
    ${alternates}
    <link rel="stylesheet" href="${base}/styles.css">
    <link rel="stylesheet" href="${docsAssets}/docs.css">
    <script src="${base}/theme-init.js"></script>
    <script src="${docsAssets}/docs.js" defer></script>
  </head>
  <body data-lang="${lang}" data-index="${docsAssets}/search-index.${lang}.js" data-copy="${esc(ui.copy)}" data-copied="${esc(ui.copied)}" data-no-results="${esc(ui.noResults)}">
    <a class="skip" href="#main">${esc(ui.skip)}</a>
    <header class="site-head docs-head">
      <div class="wrap wide head-inner">
        <a class="brand" href="${home}" aria-label="${esc(ui.homeLabel)}">
          ${BRAND_MARK}
          <span class="brand-word" translate="no">Open Agent API</span>
        </a>
        <form class="docs-search" role="search" hidden>
          <label class="visually-hidden" for="docs-q">${esc(ui.search)}</label>
          <input id="docs-q" type="search" placeholder="${esc(ui.searchPlaceholder)}" title="${esc(ui.searchHint)}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="docs-results">
          <ul id="docs-results" class="search-results" role="listbox" hidden></ul>
          <p class="visually-hidden" id="docs-status" role="status" aria-live="polite"></p>
        </form>
        <nav class="head-nav" aria-label="${lang === 'en' ? 'Site' : '站点'}">
          ${docsHome ? `<a href="${esc(relUrl(page.out, docsHome.out))}"${page.key === 'index' ? ' aria-current="page"' : ''}>${esc(ui.docs)}</a>` : ''}
          ${cookbook ? `<a href="${esc(relUrl(page.out, cookbook.out))}"${page.key === COOKBOOK_KEY ? ' aria-current="page"' : ''}>${esc(ui.cookbook)}</a>` : ''}
          <a href="${esc(site.repoUrl)}">GitHub</a>
          ${switchLink}
          <button type="button" class="theme-toggle" data-theme-toggle data-label-light="${esc(ui.themeToLight)}" data-label-dark="${esc(ui.themeToDark)}" aria-label="${esc(ui.themeToDark)}" title="${esc(ui.themeToDark)}">${THEME_ICON}</button>
        </nav>
      </div>
    </header>
    <div class="wrap wide docs-shell">
      <aside class="docs-side">
        <nav aria-label="${esc(ui.menu)}">${nav}</nav>
      </aside>
      <main id="main" class="docs-main">
        <details class="menu-mobile">
          <summary>${esc(ui.menu)}</summary>
          <nav aria-label="${esc(ui.menu)}">${nav}</nav>
        </details>
        <article class="prose" id="content">
${page.rendered.html}        </article>
        ${toc ? `<details class="toc-mobile"><summary>${esc(ui.onThisPage)}</summary><nav aria-label="${esc(ui.onThisPage)}">${toc}</nav></details>` : ''}
        ${pager}
        <p class="edit-link"><a href="${esc(`${site.repoUrl}/blob/${site.ref}/${page.src}`)}">${esc(ui.edit)}</a></p>
      </main>
      <aside class="docs-toc">${toc ? `<nav aria-label="${esc(ui.onThisPage)}">${toc}</nav>` : ''}</aside>
    </div>
    <footer class="docs-foot"><div class="wrap wide"><p>${esc(ui.footer)}</p></div></footer>
  </body>
</html>
`;
}

// ───────────────────────────── building ─────────────────────────────

/**
 * Renders the whole site in memory.
 * @returns {Promise<{files: Map<string,string>, copies: Array<{from: string, to: string}>, pages: Array, warnings: Array, repoUrl: string, ref: string}>}
 */
export async function buildSite({ root = process.cwd(), ref = 'main', repoUrl } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  repoUrl ??= repoUrlFrom(pkg);
  const pages = await readSources(root);
  const byRepoPath = new Map(pages.map((p) => [p.src, p]));
  const warnings = [];
  for (const page of pages) {
    page.rendered = renderMarkdown(page.source, {
      rewriteHref: makeLinkRewriter({
        page,
        byRepoPath,
        root,
        repoUrl,
        ref,
        record: (w) => warnings.push(w),
      }),
      rewriteSrc: (src) => src,
      labels: LANGS[page.lang].ui.labels,
    });
    page.title = page.rendered.title || page.key;
    for (const w of page.rendered.warnings) warnings.push({ ...w, from: page.src });
  }
  const site = { pages, repoUrl, ref, groups: {} };
  for (const lang of LANG_CODES) site.groups[lang] = navGroups(pages, lang, LANGS[lang].ui);

  const files = new Map();
  for (const page of pages) files.set(page.out, renderPage(site, page));
  for (const lang of LANG_CODES) {
    const own = pages.filter((p) => p.lang === lang);
    const entries = buildIndex(
      own.map((p) => ({
        title: p.title,
        url: posix.basename(p.out),
        sections: p.rendered.sections,
      })),
      { lang },
    );
    files.set(`docs/assets/search-index.${lang}.js`, indexScript(entries, lang));
  }

  const copies = [];
  const siteDir = path.join(root, 'site');
  for (const rel of await walkFiles(siteDir))
    copies.push({ from: path.join('site', rel), to: rel.split(path.sep).join('/') });
  for (const name of ['docs.css', 'docs.js'])
    copies.push({
      from: path.join('tools', 'docs-site', 'assets', name),
      to: `docs/assets/${name}`,
    });
  return { files, copies, pages, warnings, repoUrl, ref };
}

async function walkFiles(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** Refuses to wipe a directory that could hold the sources. */
function assertSafeOut(root, out) {
  const abs = path.resolve(out);
  const r = path.resolve(root);
  const protectedDirs = [
    '',
    'src',
    'docs',
    'site',
    'web',
    'desktop',
    'test',
    'tools',
    'examples',
    'scripts',
    'integrations',
    '.git',
    '.github',
  ].map((d) => path.join(r, d));
  if (protectedDirs.includes(abs) || r.startsWith(abs + path.sep))
    throw new Error(`refusing to write the site into ${abs}: it holds sources`);
}

/** Writes the site to `out` (the directory is emptied first). */
export async function writeSite(result, { root = process.cwd(), out }) {
  assertSafeOut(root, out);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const { from, to } of result.copies) {
    const dest = path.join(out, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(root, from), dest);
  }
  for (const [rel, content] of result.files) {
    const dest = path.join(out, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
}
