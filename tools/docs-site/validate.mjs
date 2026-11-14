// Self-checks for the generated site: well-formed HTML (tags pair up, ids are unique) and links that resolve to a
// page or file of the site, including the `#anchor`. Used by `build.mjs --check` and by test/docs-site.test.ts.
import path from 'node:path';

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT = new Set(['script', 'style']);

/** Tags must pair up (`<p>` etc. are always closed by the generator), and ids must be unique within the page. */
export function checkHtml(html, label = 'page') {
  const problems = [];
  const stack = [];
  const ids = new Set();
  const re =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!m[2]) continue;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (!closing) {
      const id = /\sid="([^"]*)"/.exec(m[3])?.[1];
      if (id !== undefined) {
        if (ids.has(id)) problems.push(`${label}: duplicate id "${id}"`);
        ids.add(id);
      }
      if (/\s(?:on[a-z]+)\s*=/i.test(m[3]))
        problems.push(`${label}: inline event handler on <${name}>`);
    }
    if (VOID.has(name)) {
      if (closing) problems.push(`${label}: </${name}> is a void element`);
      continue;
    }
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        problems.push(`${label}: </${name}> closes <${top ?? 'nothing'}>`);
        if (top === undefined) break;
      }
    } else {
      if (/\/\s*$/.test(m[3]) && !VOID.has(name)) {
        // Self-closing is valid inside inline SVG only.
        if (!stack.includes('svg'))
          problems.push(`${label}: <${name}/> self-closes a non-void element`);
        continue;
      }
      stack.push(name);
      if (RAW_TEXT.has(name)) {
        const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        if (end < 0) {
          problems.push(`${label}: unterminated <${name}>`);
          break;
        }
        re.lastIndex = end;
      }
    }
  }
  if (stack.length) problems.push(`${label}: unclosed <${stack.join('>, <')}>`);
  return problems;
}

/** href / src attribute values of a page, and the ids it defines. */
export function referencesOf(html) {
  const refs = [];
  for (const m of html.matchAll(/<(a|link|script|img|source)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    for (const a of m[2].matchAll(/\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
      refs.push({
        tag: m[1].toLowerCase(),
        attr: a[1].toLowerCase(),
        value: decodeEntities(a[2] ?? a[3]),
      });
  }
  const ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decodeEntities(m[1])));
  return { refs, ids };
}

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Checks every page of the site.
 * @param {{files: Map<string,string>, copies: Array<{to: string}>}} site
 * @returns {{problems: string[], checked: number}}
 */
export function checkSite(site) {
  const problems = [];
  const present = new Set([...site.files.keys(), ...site.copies.map((c) => c.to)]);
  const idsByPage = new Map();
  for (const [file, content] of site.files)
    if (file.endsWith('.html')) idsByPage.set(file, referencesOf(content).ids);
  let checked = 0;
  for (const [file, content] of site.files) {
    if (!file.endsWith('.html')) continue;
    problems.push(...checkHtml(content, file));
    const { refs, ids } = referencesOf(content);
    for (const { value, tag, attr } of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
        // External: the pages load nothing from outside; only plain links to other sites are allowed.
        if (attr === 'src' || tag === 'link' || tag === 'script')
          problems.push(`${file}: external resource ${value}`);
        continue;
      }
      checked++;
      const [rawPath, ...frag] = value.split(/#/);
      const anchor = frag.length ? decodeURIComponent(frag.join('#')) : undefined;
      let target = file;
      if (rawPath) {
        const cleaned = rawPath.split('?')[0];
        target = path.posix.normalize(path.posix.join(path.posix.dirname(file), cleaned));
        if (cleaned.endsWith('/')) target = path.posix.join(target, 'index.html');
        if (!present.has(target)) {
          problems.push(`${file}: ${value} points at ${target}, which the site does not have`);
          continue;
        }
      }
      if (anchor) {
        const pageIds = target === file ? ids : idsByPage.get(target);
        if (!pageIds) continue; // not an HTML page of ours (a stylesheet, an image)
        if (!pageIds.has(anchor))
          problems.push(`${file}: ${value} points at a heading that ${target} does not have`);
      }
    }
  }
  return { problems, checked };
}
