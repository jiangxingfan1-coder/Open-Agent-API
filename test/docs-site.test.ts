import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

// The documentation site generator (tools/docs-site/): the Markdown renderer, the whole-corpus check and the
// workflow that publishes the result. Offline and in memory: nothing is written to disk and no port is opened.

type Mod = Record<string, any>;
const load = (file: string): Promise<Mod> => import(pathToFileURL(path.resolve(file)).href);
const md = await load('tools/docs-site/markdown.mjs');
const siteMod = await load('tools/docs-site/site.mjs');
const validate = await load('tools/docs-site/validate.mjs');
const searchMod = await load('tools/docs-site/search.mjs');
const { githubSlug } = await load('tools/docs-site/slug.mjs');

const render = (source: string, options: Record<string, unknown> = {}) =>
  md.renderMarkdown(source, options) as {
    html: string;
    title: string;
    headings: Array<{ level: number; text: string; id: string }>;
    sections: Array<{ title: string; text: string; code: string; id: string; level: number }>;
    warnings: Array<{ kind: string; detail: string }>;
    links: Array<{ href: string; rewritten: string }>;
  };

// ───────────────────────── the renderer, one syntax at a time ─────────────────────────

test('docs-site renderer: headings get GitHub anchors, duplicates are numbered, inline markup is not part of the id', () => {
  const r = render(
    '# Title\n\n## Same\n\n## Same\n\n### `code` and **bold** and [link](x.md)\n\n## 中文标题（含标点）\n',
  );
  assert.deepEqual(
    r.headings.map((h) => h.id),
    ['title', 'same', 'same-1', 'code-and-bold-and-link', '中文标题含标点'],
  );
  assert.equal(r.title, 'Title');
  assert.match(r.html, /<h2 id="same-1">Same<a class="anchor" href="#same-1"/);
  assert.equal(githubSlug('Error codes (`error.code`)'), 'error-codes-errorcode');
});

test('docs-site renderer: paragraphs, emphasis, code spans, escapes and hard breaks', () => {
  const r = render('A *b* **c** ***d*** ~~e~~ `f <g>` \\*h\\* i_j_k\n\nline one  \nline two\n');
  assert.match(
    r.html,
    /<p>A <em>b<\/em> <strong>c<\/strong> <em><strong>d<\/strong><\/em> <del>e<\/del> <code>f &lt;g&gt;<\/code> \*h\* i_j_k<\/p>/,
  );
  assert.match(r.html, /line one<br>line two/);
  const nested = render('Use ``a ` b`` here and `x` there.');
  assert.match(nested.html, /<code>a ` b<\/code> here and <code>x<\/code> there/);
});

test('docs-site renderer: emphasis next to CJK punctuation works (CommonMark alone would leave the asterisks)', () => {
  const r = render('**风险：**自动批准，**重点**。');
  assert.equal(r.html.trim(), '<p><strong>风险：</strong>自动批准，<strong>重点</strong>。</p>');
});

test('docs-site renderer: lists nest, number, mark tasks and tell tight from loose', () => {
  const tight = render('- a\n  - b\n    - c\n- d\n');
  assert.match(tight.html, /<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c<\/li>/);
  assert.doesNotMatch(tight.html, /<p>/);
  const loose = render('1. one\n\n   more\n\n2. two\n');
  assert.match(
    loose.html,
    /<ol>\n<li><p>one<\/p>\n<p>more<\/p><\/li>\n<li><p>two<\/p><\/li>\n<\/ol>/,
  );
  const start = render('3. three\n4. four\n');
  assert.match(start.html, /<ol start="3">/);
  const tasks = render('- [x] done\n- [ ] open\n');
  assert.match(tasks.html, /<ul class="tasks">/);
  assert.match(tasks.html, /<input type="checkbox" disabled checked aria-label="Done"> done/);
  assert.match(tasks.html, /<input type="checkbox" disabled aria-label="Not done"> open/);
  const withCode = render('1. run\n\n   ```bash\n   echo hi\n   ```\n2. next\n');
  assert.match(withCode.html, /<li><p>run<\/p>\n<div class="code-block has-lang">/);
  assert.match(withCode.html, /<\/div><\/li>\n<li><p>next<\/p><\/li>/);
});

test('docs-site renderer: tables keep alignment, escaped pipes and inline markup; wide rows are reported', () => {
  const r = render('| a | b | c |\n|:--|:-:|--:|\n| `x\\|y` | **z** | 3 |\n| only |\n');
  assert.match(
    r.html,
    /<th class="al-left">a<\/th><th class="al-center">b<\/th><th class="al-right">c<\/th>/,
  );
  assert.match(
    r.html,
    /<td class="al-left"><code>x\|y<\/code><\/td><td class="al-center"><strong>z<\/strong><\/td><td class="al-right">3<\/td>/,
  );
  assert.match(r.html, /<td class="al-left">only<\/td><td class="al-center"><\/td>/);
  assert.match(r.html, /<div class="table-wrap" tabindex="0" role="region"/);
  const wide = render('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n');
  assert.deepEqual(
    wide.warnings.map((w) => w.kind),
    ['table-row-too-wide'],
  );
  assert.match(wide.html, /<th>a<\/th><th>b<\/th><th><\/th>/);
  assert.match(wide.html, /<td>3<\/td>/);
  // A pipe table is not mistaken for text when it follows a paragraph line.
  assert.match(
    render('intro\n| a | b |\n|---|---|\n| 1 | 2 |\n').html,
    /<p>intro<\/p>\n<div class="table-wrap"/,
  );
});

test('docs-site renderer: fenced code carries its language, is escaped and coloured without scripts', () => {
  const r = render(
    '```bash\n# note\ncurl -H "A: b" $URL --flag <x>\n```\n\n```text\nplain <b>\n```\n\n~~~\ntilde\n~~~\n',
  );
  assert.match(r.html, /<span class="tk-c"># note<\/span>/);
  assert.match(r.html, /<span class="tk-k">curl<\/span>/);
  assert.match(r.html, /<span class="tk-s">"A: b"<\/span>/);
  assert.match(r.html, /&lt;x&gt;/);
  assert.match(
    r.html,
    /<code class="language-text">plain &lt;b&gt;\n<\/code>|<code class="language-text">plain &lt;b&gt;<\/code>/,
  );
  assert.match(r.html, /<div class="code-lang" aria-hidden="true">bash<\/div>/);
  assert.match(r.html, /<code>tilde<\/code>/);
  const json = render('```json\n{"a": [1, true, null, "x"]}\n```\n');
  assert.match(json.html, /<span class="tk-k">"a"<\/span>/);
  assert.match(json.html, /<span class="tk-n">true<\/span>/);
  const mermaid = render('```mermaid\ngraph LR\n A-->B\n```\n');
  assert.match(mermaid.html, /Diagram source \(Mermaid\)/);
  assert.doesNotMatch(mermaid.html, /<script/);
});

test('docs-site renderer: block quotes, rules, links, images, autolinks, reference links and footnotes', () => {
  const r = render(
    '> quoted *text*\n> more\n\n---\n\n[a](b.md#c "T") ![alt](i.png) <https://x.example/p> see https://y.example/q). [ref] [ref2][r]\n\n[ref]: https://z.example\n[r]: https://w.example "W"\n\nNote[^n].\n\n[^n]: The note.\n',
    {
      rewriteHref: (h: string) => (/^https?:/.test(h) ? h : `/R/${h}`),
      rewriteSrc: (s: string) => `/S/${s}`,
    },
  );
  assert.match(r.html, /<blockquote>\n<p>quoted <em>text<\/em>\nmore<\/p>\n<\/blockquote>/);
  assert.match(r.html, /<hr>/);
  assert.match(r.html, /<a href="\/R\/b.md#c" title="T">a<\/a>/);
  assert.match(r.html, /<img src="\/S\/i.png" alt="alt" loading="lazy">/);
  assert.match(r.html, /<a href="https:\/\/x.example\/p" class="ext">https:\/\/x.example\/p<\/a>/);
  assert.match(
    r.html,
    /<a href="https:\/\/y.example\/q" class="ext">https:\/\/y.example\/q<\/a>\)\./,
  );
  assert.match(r.html, /<a href="https:\/\/z.example" class="ext">ref<\/a>/);
  assert.match(r.html, /<a href="https:\/\/w.example" title="W" class="ext">ref2<\/a>/);
  assert.match(
    r.html,
    /Note<sup class="fnref"><a href="#fn-n" id="fnref-n" aria-label="Footnote 1">1<\/a><\/sup>\./,
  );
  assert.match(r.html, /<li id="fn-n">The note\. <a href="#fnref-n"/);
});

test('docs-site renderer: a line break between two Chinese characters is not turned into a space', () => {
  assert.equal(
    render('中文\n文字\n\nEnglish\nwords\n').html.trim(),
    '<p>中文文字</p>\n<p>English\nwords</p>',
  );
});

test('docs-site renderer: nothing from a document can inject script or an unsafe URL', () => {
  const r = render(
    [
      '<script>alert(1)</script>',
      '',
      'text <img src=x onerror="alert(2)"> and <a href="javascript:alert(3)" onclick="alert(4)">x</a>',
      '',
      '[bad](javascript:alert(5)) [data](data:text/html;base64,AAAA) ![i](vbscript:x)',
      '',
      '<a id="ok"></a> <br> <kbd>K</kbd> <details open>',
      '',
      '<details open><summary onclick="x()">s</summary>',
      '',
      '<div onclick="x()">block</div>',
      '',
      '`<script>` and \\<script\\>',
    ].join('\n'),
  );
  assert.doesNotMatch(r.html, /<script/i);
  assert.doesNotMatch(r.html, /<[^>]*\son[a-z]+\s*=/i, 'no tag carries an event handler');
  assert.doesNotMatch(r.html, /javascript:|data:text|vbscript:/i);
  assert.doesNotMatch(r.html, /<img[^>]*onerror/i);
  assert.match(
    r.html,
    /<a id="ok"><\/a> <br \/> <kbd>K<\/kbd> &lt;details open&gt;/,
    'a block tag in the middle of text is text',
  );
  assert.match(
    r.html,
    /^<details open><summary>s<\/summary>$/m,
    'a block-level details is kept, without its handler',
  );
  assert.ok(r.warnings.length >= 3, 'the escaped tags are reported');
  assert.match(r.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ───────────────────────── the whole corpus ─────────────────────────

const built = await siteMod.buildSite({ root: process.cwd() });
type Page = {
  lang: string;
  key: string;
  src: string;
  out: string;
  title: string;
  source: string;
  rendered: ReturnType<typeof render>;
};
const pages: Page[] = built.pages;

/** Defects of the documents themselves that the site can only report. Delete a line when the document is fixed. */
const KNOWN_DOC_DEFECTS: string[] = [];
/** Documents that are linked before they exist (the same list as PENDING_NEW_DOCS in test/docs.test.ts). */
const PENDING = ['docs/stability.md', 'docs/zh-CN/stability.md'];

test('docs-site: every document of both languages and the cookbook becomes a page', async () => {
  const { readdir } = await import('node:fs/promises');
  for (const [dir, lang] of [
    ['docs', 'en'],
    ['docs/zh-CN', 'zh-CN'],
  ] as const) {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
    assert.ok(names.length >= 20, `${dir} has ${names.length} documents`);
    for (const name of names) {
      const page = pages.find((p) => p.lang === lang && p.src === `${dir}/${name}.md`);
      assert.ok(page, `${dir}/${name}.md has no page`);
      assert.equal(page.out, `${dir}/${name === 'README' ? 'index' : name}.html`);
      assert.ok(built.files.has(page.out));
      assert.ok(page.rendered.html.length > 200, `${page.src} rendered to almost nothing`);
      assert.ok(page.title, `${page.src} has no title`);
    }
  }
  for (const lang of ['en', 'zh-CN'])
    assert.ok(
      pages.some((p) => p.lang === lang && p.key === 'cookbook'),
      `${lang} cookbook page`,
    );
});

test('docs-site: no Markdown file of the repository shows literal ** or ~~ on GitHub (CommonMark flanking, CJK punctuation)', async () => {
  // The site renders emphasis next to CJK punctuation leniently, GitHub does not: "**风险：**自动" shows its
  // asterisks there. Render every Markdown file strictly (as GitHub does) and look for what was left over.
  const { readdir } = await import('node:fs/promises');
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'release',
    '.claude',
    'site-dist',
    'output',
  ]);
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  await walk('.');
  assert.ok(files.length > 40);
  const problems: string[] = [];
  for (const file of files) {
    const rendered = render(await readFile(file, 'utf8'), { strictEmphasis: true });
    const prose = rendered.html
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<code[^>]*>[\s\S]*?<\/code>/g, '')
      .replace(/<[^>]+>/g, ' ');
    for (const m of prose.matchAll(/\*\*|~~/g))
      problems.push(
        `${file}: "${prose.slice(Math.max(0, m.index - 20), m.index + 20).replace(/\s+/g, ' ')}"`,
      );
  }
  assert.deepEqual(problems, [], 'move the punctuation outside the bold text or add a space');
});

test('docs-site: no Markdown syntax is left unprocessed in any document', () => {
  const problems: string[] = [];
  for (const page of pages) {
    // Text outside of code: remove code blocks, code spans and tags.
    const prose = page.rendered.html
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<code[^>]*>[\s\S]*?<\/code>/g, '')
      .replace(/<[^>]+>/g, ' ');
    const checks: Array<[string, RegExp]> = [
      ['emphasis asterisks', /\*\*|(?<![\w*])\*(?=\w)/],
      ['strike marks', /~~/],
      ['a backtick', /`/],
      ['an unparsed link', /\]\(/],
      ['an unresolved footnote reference', /\[\^/],
      ['a table row', /^\s*\|.*\|\s*$/m],
      ['a table delimiter row', /\|\s*:?-{3,}/],
      ['a bullet marker at line start', /^\s*[-*+] \S/m],
      ['a heading marker at line start', /^\s*#{1,6} \S/m],
      ['a fence marker', /^\s*(```|~~~)/m],
      ['an html comment', /<!--/],
    ];
    for (const [what, re] of checks) {
      const m = re.exec(prose);
      if (m)
        problems.push(
          `${page.src}: ${what} near "${prose.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}"`,
        );
    }
    // Every code block is closed and every table has a header.
    if (page.rendered.html.includes('```'))
      problems.push(`${page.src}: a fence leaked into the output`);
    for (const w of page.rendered.warnings)
      if (w.kind === 'raw-html-escaped')
        problems.push(`${page.src}: raw HTML outside code was not on the whitelist: ${w.detail}`);
  }
  assert.deepEqual(problems, []);
});

test('docs-site: the defects the site can only report are exactly the known ones', () => {
  const seen = new Set<string>();
  for (const page of pages)
    for (const w of page.rendered.warnings)
      if (w.kind === 'table-row-too-wide')
        seen.add(`${w.kind}:${page.src}:${w.detail.split(': ').pop()}`);
  assert.deepEqual([...seen].sort(), [...KNOWN_DOC_DEFECTS].sort());
});

test('docs-site: heading anchors equal the ones GitHub computes for the same Markdown file', () => {
  const problems: string[] = [];
  for (const page of pages) {
    const seen = new Map<string, number>();
    const expected: string[] = [];
    let fence: string | undefined;
    for (const line of page.source.split('\n')) {
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
      // GitHub slugs the rendered text: markup outside code spans disappears, the text inside a code span stays
      // (so "`oaa connect <preset>`" becomes "oaa-connect-preset").
      const plain = heading
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\s+#+\s*$/, '')
        .split('`')
        .map((part, i) => (i % 2 === 0 ? part.replace(/<[^>]+>/g, '') : part))
        .join('');
      const base = githubSlug(plain);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      expected.push(n === 0 ? base : `${base}-${n}`);
    }
    const got = page.rendered.headings.map((h) => h.id);
    if (JSON.stringify(got) !== JSON.stringify(expected))
      problems.push(
        `${page.src}: ${got.filter((g, i) => g !== expected[i]).slice(0, 3)} differ from ${expected.filter((g, i) => g !== got[i]).slice(0, 3)}`,
      );
  }
  assert.deepEqual(problems, []);
});

test('docs-site: every internal link resolves to a page or file of the site, including its anchor', () => {
  const { problems, checked } = validate.checkSite(built);
  assert.ok(checked > 3000, `expected thousands of references, checked ${checked}`);
  assert.deepEqual(problems, []);
});

test('docs-site: links to repository files become GitHub URLs, links between documents stay inside the site', () => {
  const protocol = pages.find((p) => p.src === 'docs/protocol.md')!;
  const html = protocol.rendered.html;
  assert.match(html, /href="architecture\.html#/, 'a link to another document');
  const index = pages.find((p) => p.src === 'docs/README.md')!;
  assert.match(
    index.rendered.html,
    /href="https:\/\/github\.com\/[^"]+\/blob\/main\/README\.md#running-in-three-minutes"/,
  );
  assert.match(
    index.rendered.html,
    /href="https:\/\/github\.com\/[^"]+\/blob\/main\/bench\/paired\/README\.md"/,
  );
  const zhWebhooks = pages.find((p) => p.src === 'docs/zh-CN/webhooks.md')!;
  assert.match(
    zhWebhooks.rendered.html,
    /href="\.\.\/cli\.html"/,
    'the Chinese page links to the English cli page',
  );
  // Pending documents are tolerated by name only, and as GitHub links.
  const missing = built.warnings
    .filter((w: { kind: string }) => w.kind === 'missing-target')
    .map((w: { repoPath: string }) => w.repoPath);
  assert.deepEqual(
    [...new Set(missing)].filter((m) => !PENDING.includes(m as string)),
    [],
  );
});

test('docs-site: pages are well formed, load nothing from outside and carry the language switch', () => {
  for (const page of pages) {
    const html = built.files.get(page.out) as string;
    assert.deepEqual(validate.checkHtml(html, page.out), []);
    assert.match(html, new RegExp(`<html lang="${page.lang}">`));
    assert.match(html, /<a class="skip" href="#main">/);
    assert.match(html, /<main id="main"/);
    assert.match(html, /<link rel="stylesheet" href="(\.\.\/)+styles\.css">/);
    for (const ref of validate.referencesOf(html).refs)
      if (ref.attr === 'src' || ref.tag === 'link' || ref.tag === 'script')
        assert.doesNotMatch(
          ref.value,
          /^(?:[a-z][a-z0-9+.-]*:)?\/\//i,
          `${page.out} loads ${ref.value} from outside`,
        );
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'no inline scripts');
    assert.doesNotMatch(html, /fonts\.googleapis|cdn\./);
    const twin = pages.find((p) => p.lang !== page.lang && p.key === page.key);
    if (twin)
      assert.match(
        html,
        new RegExp(
          `class="lang" href="[^"]*${path.posix.basename(twin.out)}" hreflang="${twin.lang}"`,
        ),
      );
  }
});

test('docs-site: the sidebar follows the documentation map and every document is reachable from it', () => {
  for (const lang of ['en', 'zh-CN']) {
    const own = pages.filter((p) => p.lang === lang);
    const index = built.files.get(own.find((p) => p.key === 'index')!.out) as string;
    const side = /<aside class="docs-side">([\s\S]*?)<\/aside>/.exec(index)![1]!;
    for (const p of own.filter((q) => q.key !== 'index'))
      assert.ok(
        side.includes(`href="${path.posix.basename(p.out)}"`),
        `${p.out} is not in the ${lang} sidebar`,
      );
    assert.match(side, /nav-title/);
  }
  // A document that exists in one language only is listed in the other language's sidebar, marked as such.
  for (const [lang, other] of [
    ['en', 'zh-CN'],
    ['zh-CN', 'en'],
  ] as const) {
    const index = built.files.get(
      pages.find((p) => p.lang === lang && p.key === 'index')!.out,
    ) as string;
    for (const p of pages.filter(
      (q) =>
        q.lang === other &&
        q.key !== 'index' &&
        !pages.some((r) => r.lang === lang && r.key === q.key),
    ))
      assert.match(
        index,
        new RegExp(
          `href="\\.\\./${p.key === 'cookbook' ? 'x' : p.key}\\.html"[^>]*hreflang="${other}"`,
        ),
        `${p.out} is listed in the ${lang} sidebar, marked as foreign`,
      );
  }
});

test('docs-site: the search index is small, covers both languages and finds identifiers, headings and Chinese words', () => {
  const probes: Record<string, Array<[string, string]>> = {
    en: [
      ['previous_response_id', 'protocol'],
      ['x-oaa-client-tools', 'harness'],
      ['structured_output_invalid', 'structured-output'],
      ['webhook', 'webhooks'],
      ['sandbox', 'sandbox-design'],
    ],
    'zh-CN': [
      ['审批', 'protocol'],
      ['沙箱', 'sandbox-design'],
      ['结构化输出', 'structured-output'],
      ['previous_response_id', 'protocol'],
    ],
  };
  for (const lang of ['en', 'zh-CN']) {
    const script = built.files.get(`docs/assets/search-index.${lang}.js`) as string;
    assert.ok(script.length < 260_000, `${lang} index is ${script.length} bytes`);
    const sandbox = { window: {} as Record<string, any> };
    vm.runInNewContext(script, sandbox);
    const data = sandbox.window.__OAA_DOCS_INDEX__[lang] as string[][];
    assert.ok(data.length > 300, `${lang} index has ${data.length} entries`);
    for (const e of data) {
      assert.equal(e.length, 5);
      assert.doesNotMatch(e[0]!, /^\w+:|^\//, 'relative URLs');
    }
    for (const [query, page] of probes[lang]!) {
      const hit = data.some(
        (e) =>
          e[0]!.startsWith(`${page}.html`) &&
          `${e[1]} ${e[2]} ${e[3]} ${e[4]}`.toLowerCase().includes(query),
      );
      assert.ok(hit, `${lang}: "${query}" is not findable in ${page}`);
    }
  }
  // The tokenizer keeps identifiers whole and drops filler words.
  assert.deepEqual(
    searchMod.tokens('The previous_response_id and X-OAA-Client-Tools of 12 agents'),
    ['previous_response_id', 'x-oaa-client-tools', 'agents'],
  );
});

test('docs-site: the documentation assets exist and the page script only touches the page', async () => {
  const targets = new Set((built.copies as Array<{ to: string }>).map((c) => c.to));
  for (const t of [
    'docs/assets/docs.css',
    'docs/assets/docs.js',
    'styles.css',
    'favicon.svg',
    'index.html',
    'en/index.html',
  ])
    assert.ok(targets.has(t), `${t} is copied`);
  const js = await readFile('tools/docs-site/assets/docs.js', 'utf8');
  assert.doesNotMatch(
    js,
    /\bfetch\s*\(|XMLHttpRequest|innerHTML|document\.write|eval\(|new Function/,
    'no network, no HTML injection',
  );
  const css = await readFile('tools/docs-site/assets/docs.css', 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:|googleapis/, 'no third-party resources');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /--doc-zh:/, 'the Chinese body uses a system font stack');
});

// ───────────────────────── the publishing workflow ─────────────────────────

test('docs-site: the Pages workflow runs the generator and follows the repository rules for workflows', async () => {
  const text = await readFile('.github/workflows/pages.yml', 'utf8');
  const wf = parse(text) as {
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        'timeout-minutes'?: number;
        permissions?: Record<string, string>;
        steps?: Array<Record<string, any>>;
        needs?: string;
      }
    >;
    on: { push: { paths: string[] } };
  };
  // Every action pinned to a 40-character commit and annotated with its version.
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 5);
  for (const [, ref, rest] of uses)
    assert.match(`${ref}${rest}`, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, String(ref));
  for (const [name, job] of Object.entries(wf.jobs))
    assert.ok(job['timeout-minutes'], `${name} has timeout-minutes`);
  assert.deepEqual(wf.permissions, { contents: 'read' }, 'least privilege at the top');
  const writers = Object.entries(wf.jobs)
    .filter(([, j]) => j.permissions?.pages === 'write' || j.permissions?.['id-token'] === 'write')
    .map(([n]) => n);
  assert.deepEqual(writers, ['deploy'], 'only the deploy job may write Pages');
  // The build job runs the generator with --check and uploads exactly what it wrote.
  const run = wf.jobs
    .build!.steps!.map((s) => s.run as string | undefined)
    .find((r) => r?.includes('tools/docs-site/build.mjs'));
  assert.ok(run, 'the build job runs the generator');
  assert.match(run!, /--check/);
  const out = /--out (\S+)/.exec(run!)![1]!;
  const upload = wf.jobs.build!.steps!.find((s) =>
    String(s.uses ?? '').startsWith('actions/upload-pages-artifact'),
  )!;
  assert.equal(upload.with.path, out);
  assert.equal(wf.jobs.deploy!.needs, 'build');
  assert.match(
    await readFile('.gitignore', 'utf8'),
    new RegExp(`^${out}/$`, 'm'),
    'the build output is ignored by git',
  );
  // A change to the sources of the site triggers the workflow.
  for (const p of ['site/**', 'docs/**', 'examples/cookbook/**', 'tools/docs-site/**'])
    assert.ok(wf.on.push.paths.includes(p), `${p} triggers the workflow`);
});

test('docs-site: the generator refuses to write into a directory that holds sources', async () => {
  const root = process.cwd();
  for (const bad of [
    root,
    path.join(root, 'docs'),
    path.join(root, 'site'),
    path.join(root, 'src'),
    path.dirname(root),
  ])
    await assert.rejects(
      () => siteMod.writeSite({ copies: [], files: new Map() }, { root, out: bad }),
      /refusing/,
    );
});
