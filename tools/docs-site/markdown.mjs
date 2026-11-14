// A small Markdown renderer for the project's documentation. No dependency.
//
// It implements the subset of CommonMark / GitHub Flavored Markdown that the documents actually use,
// following the specification's rules where they matter (emphasis flanking, list item indentation, tight
// and loose lists, GitHub heading anchors), so that the site reads the way GitHub renders the same file:
//
//   blocks:  ATX headings, paragraphs, fenced and indented code, block quotes, bullet / ordered / task lists
//            (nested), GFM tables with alignment, thematic breaks, footnote and link-reference definitions,
//            a few block-level HTML tags (<details>, <summary>, ...)
//   inline:  code spans, emphasis, strong, strikethrough, links, images, reference links, autolinks (also bare
//            https URLs), footnote references, hard line breaks, backslash escapes, entities, and a short
//            whitelist of inline HTML (<a id>, <br>, <kbd>, <sub>, <sup>, ...)
//
// Every piece of text is HTML-escaped; URLs are limited to http(s), mailto and relative targets; raw HTML that is
// not on the whitelist is shown as text (and reported in `warnings`), so a document cannot inject script.
import { highlight } from './highlight.mjs';
import { SlugCounter } from './slug.mjs';

export const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rarr: '→',
  larr: '←',
  middot: '·',
  times: '×',
};

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/u;

// ───────────────────────────── inline ─────────────────────────────

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const isWs = (ch) => ch === undefined || /\s/u.test(ch);
const isPunct = (ch) => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);

const ALLOWED_INLINE_TAGS = new Set([
  'a',
  'br',
  'kbd',
  'sub',
  'sup',
  'em',
  'strong',
  'b',
  'i',
  'code',
  'span',
  'del',
]);
/** Tags that are only meaningful as a block of their own (a line that starts with them). */
const ALLOWED_BLOCK_TAGS = new Set([...ALLOWED_INLINE_TAGS, 'details', 'summary']);
const VOID_TAGS = new Set(['br']);
const TAG_RE =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A URL that is safe to put in href / src. Anything else becomes undefined. */
export function safeUrl(raw) {
  const url = String(raw).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^(https?:|mailto:)/i.test(url) ? url : undefined;
  return url;
}

/** Sanitizes one raw HTML tag: only whitelisted tags and attributes survive. Returns undefined if not allowed. */
function sanitizeTag(match, block = false) {
  const [, closing, rawName, rawAttrs] = match;
  const name = rawName.toLowerCase();
  if (!(block ? ALLOWED_BLOCK_TAGS : ALLOWED_INLINE_TAGS).has(name)) return undefined;
  if (closing) return VOID_TAGS.has(name) ? '' : `</${name}>`;
  const attrs = [];
  for (const m of rawAttrs.matchAll(ATTR_RE)) {
    const key = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name === 'a' && (key === 'id' || key === 'name')) attrs.push(`id="${esc(value)}"`);
    else if (name === 'a' && key === 'href') {
      const url = safeUrl(value);
      if (url !== undefined) attrs.push(`href="${esc(url)}"`);
    } else if (name === 'a' && key === 'title') attrs.push(`title="${esc(value)}"`);
    else if (name === 'details' && key === 'open') attrs.push('open');
  }
  return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${VOID_TAGS.has(name) ? ' /' : ''}>`;
}

const textNode = (value) => ({ t: 'text', h: esc(value), x: value });
const rawNode = (h, x = '') => ({ t: 'raw', h, x });

/** Decodes the entity at the start of `s` ("&amp;", "&#65;", "&#x41;"), or returns undefined. */
function entityAt(s) {
  const m = /^&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/i.exec(s);
  if (!m) return undefined;
  const body = m[1];
  let value;
  if (body[0] === '#') {
    const code =
      body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    value = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
  } else value = ENTITIES[body.toLowerCase()];
  return value === undefined ? undefined : { length: m[0].length, value };
}

/** Parses the destination and optional title of an inline link at s[0] === "(". */
function parseLinkTail(s) {
  let i = 1;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  skipWs();
  let dest = '';
  if (s[i] === '<') {
    const end = s.indexOf('>', i);
    if (end < 0) return undefined;
    dest = s.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    const start = i;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    dest = s.slice(start, i);
  }
  skipWs();
  let title;
  if (s[i] === '"' || s[i] === "'" || s[i] === '(') {
    const close = s[i] === '(' ? ')' : s[i];
    let j = i + 1;
    while (j < s.length && s[j] !== close) j += s[j] === '\\' ? 2 : 1;
    if (j >= s.length) return undefined;
    title = s.slice(i + 1, j);
    i = j + 1;
    skipWs();
  }
  if (s[i] !== ')') return undefined;
  const unescaped = dest.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  return { dest: unescaped, title, length: i + 1 };
}

const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Parses inline Markdown into nodes `{h, x}` (html and plain text). `ctx` supplies reference definitions,
 * footnote bookkeeping and the link rewriting hooks.
 */
function parseInline(src, ctx) {
  const nodes = [];
  const brackets = [];
  let buf = '';
  let pos = 0;
  const flush = () => {
    if (buf) nodes.push(textNode(buf));
    buf = '';
  };

  const urlNode = (dest, title, innerH, innerX, image) => {
    const safe = safeUrl(dest);
    if (safe === undefined) return { t: 'raw', h: innerH, x: innerX };
    if (image) {
      const rewritten = ctx.rewriteSrc ? ctx.rewriteSrc(safe) : safe;
      return {
        t: 'raw',
        h: `<img src="${esc(rewritten)}" alt="${esc(innerX)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`,
        x: innerX,
      };
    }
    const rewritten = ctx.rewriteHref ? ctx.rewriteHref(safe) : safe;
    const external = /^https?:/i.test(rewritten);
    ctx.links.push({ href: safe, rewritten });
    return {
      t: 'raw',
      h: `<a href="${esc(rewritten)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' class="ext"' : ''}>${innerH}</a>`,
      x: innerX,
    };
  };

  while (pos < src.length) {
    const c = src[pos];
    if (c === '\\') {
      const next = src[pos + 1];
      if (next === '\n') {
        flush();
        nodes.push(rawNode('<br>', '\n'));
        pos += 2;
      } else if (next !== undefined && ASCII_PUNCT.test(next)) {
        buf += next;
        pos += 2;
      } else {
        buf += c;
        pos++;
      }
    } else if (c === '`') {
      let end = pos;
      while (src[end] === '`') end++;
      const run = src.slice(pos, end);
      let search = end;
      let close = -1;
      while (search < src.length) {
        const found = src.indexOf(run, search);
        if (found < 0) break;
        let after = found + run.length;
        if (src[found - 1] !== '`' && src[after] !== '`') {
          close = found;
          break;
        }
        while (src[after] === '`') after++;
        search = after;
      }
      if (close < 0) {
        buf += run;
        pos = end;
      } else {
        flush();
        let content = src.slice(end, close).replace(/\n/g, ' ');
        if (
          content.length > 2 &&
          content.startsWith(' ') &&
          content.endsWith(' ') &&
          content.trim() !== ''
        )
          content = content.slice(1, -1);
        nodes.push({ t: 'raw', h: `<code>${esc(content)}</code>`, x: content });
        pos = close + run.length;
      }
    } else if (c === '<') {
      const rest = src.slice(pos);
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
      const mail = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)>/.exec(
        rest,
      );
      const tag = TAG_RE.exec(rest);
      if (auto && safeUrl(auto[1]) !== undefined) {
        flush();
        nodes.push(urlNode(auto[1], undefined, esc(auto[1]), auto[1], false));
        pos += auto[0].length;
      } else if (mail) {
        flush();
        nodes.push(urlNode(`mailto:${mail[1]}`, undefined, esc(mail[1]), mail[1], false));
        pos += mail[0].length;
      } else if (tag) {
        const clean = sanitizeTag(tag);
        if (clean === undefined) {
          ctx.warnings.push({ kind: 'raw-html-escaped', detail: tag[0] });
          buf += tag[0];
        } else {
          flush();
          nodes.push(rawNode(clean, tag[2].toLowerCase() === 'br' ? '\n' : ''));
        }
        pos += tag[0].length;
      } else {
        buf += c;
        pos++;
      }
    } else if (c === '&') {
      const entity = entityAt(src.slice(pos, pos + 12));
      if (entity) {
        buf += entity.value;
        pos += entity.length;
      } else {
        buf += c;
        pos++;
      }
    } else if (c === '!' && src[pos + 1] === '[') {
      flush();
      nodes.push(textNode('!['));
      brackets.push({ index: nodes.length - 1, image: true, active: true });
      pos += 2;
    } else if (c === '[') {
      const fn = /^\[\^([^\]\s]+)\]/.exec(src.slice(pos));
      if (fn && ctx.footnoteDefs.has(fn[1])) {
        flush();
        nodes.push(ctx.footnoteRef(fn[1]));
        pos += fn[0].length;
      } else {
        flush();
        nodes.push(textNode('['));
        brackets.push({ index: nodes.length - 1, image: false, active: true });
        pos++;
      }
    } else if (c === ']') {
      flush();
      const opener = brackets.at(-1);
      if (!opener) {
        buf += ']';
        pos++;
        continue;
      }
      if (!opener.active) {
        brackets.pop();
        buf += ']';
        pos++;
        continue;
      }
      let link;
      const after = src.slice(pos + 1);
      if (after[0] === '(') {
        const tail = parseLinkTail(after);
        if (tail) link = { dest: tail.dest, title: tail.title, length: tail.length };
      }
      if (!link && ctx.refs.size) {
        const inner = nodes
          .slice(opener.index + 1)
          .map((n) => n.x)
          .join('');
        const full = /^\[([^\]]*)\]/.exec(after);
        const label = full ? (full[1] === '' ? inner : full[1]) : inner;
        const def = ctx.refs.get(normalizeLabel(label));
        if (def) link = { dest: def.dest, title: def.title, length: full ? full[0].length : 0 };
      }
      if (!link) {
        brackets.pop();
        buf += ']';
        pos++;
        continue;
      }
      const inner = nodes.splice(opener.index + 1);
      nodes.pop(); // the opener's own text node
      const processed = processEmphasis(inner);
      // No nested links: autolinks inside link text fall back to their text.
      const innerH = processed.map((n) => (n.auto ? esc(n.x) : n.h)).join('');
      const innerX = processed.map((n) => n.x).join('');
      nodes.push(urlNode(link.dest, link.title, innerH, innerX, opener.image));
      brackets.pop();
      if (!opener.image) for (const b of brackets) if (!b.image) b.active = false;
      pos += 1 + link.length;
    } else if (c === '*' || c === '_' || c === '~') {
      let end = pos;
      while (src[end] === c) end++;
      const count = end - pos;
      const prev = pos === 0 ? undefined : [...src.slice(Math.max(0, pos - 2), pos)].at(-1);
      const next = src[end] === undefined ? undefined : [...src.slice(end, end + 2)][0];
      const nextWs = isWs(next);
      const prevWs = isWs(prev);
      const nextP = isPunct(next);
      const prevP = isPunct(prev);
      // CommonMark would refuse "**风险：**自动" (punctuation before the closing run, a letter after it); next to
      // CJK text the site is lenient, because a word boundary is not marked by spaces there.
      // `strictEmphasis: true` turns the leniency off, so that a test can find what GitHub shows with literal asterisks.
      const cjkNeighbour =
        !ctx.options.strictEmphasis &&
        c !== '_' &&
        ((prev !== undefined && CJK.test(prev)) || (next !== undefined && CJK.test(next)));
      const left = !nextWs && (!nextP || prevWs || prevP || cjkNeighbour);
      const right = !prevWs && (!prevP || nextWs || nextP || cjkNeighbour);
      let canOpen = left;
      let canClose = right;
      if (c === '_') {
        canOpen = left && (!right || prevP);
        canClose = right && (!left || nextP);
      }
      if (c === '~' && count !== 2) {
        buf += src.slice(pos, end);
      } else {
        flush();
        nodes.push({ t: 'delim', ch: c, n: count, orig: count, canOpen, canClose, h: '', x: '' });
      }
      pos = end;
    } else if (c === '\n') {
      const trimmed = buf.replace(/ +$/, '');
      const hard = buf.length - trimmed.length >= 2;
      buf = trimmed;
      const lastChar = [...buf].at(-1) ?? [...(nodes.at(-1)?.x ?? '')].at(-1);
      pos++;
      while (src[pos] === ' ') pos++;
      if (hard) {
        flush();
        nodes.push(rawNode('<br>', '\n'));
      } else if (lastChar && CJK.test(lastChar) && src[pos] && CJK.test(src[pos])) {
        // A line break between two CJK characters is not a space.
      } else buf += '\n';
    } else if (
      (c === 'h' || c === 'H') &&
      /^https?:\/\//i.test(src.slice(pos, pos + 8)) &&
      !/[\w]/.test(src[pos - 1] ?? ' ')
    ) {
      const m = /^https?:\/\/[^\s<]+/i.exec(src.slice(pos));
      let url = m[0];
      // Trailing punctuation is not part of the URL; unbalanced closing parentheses neither.
      for (;;) {
        const before = url;
        url = url.replace(/[?!.,:*_~'";]+$/, '');
        while (
          url.endsWith(')') &&
          (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length
        )
          url = url.slice(0, -1);
        if (url === before) break;
      }
      if (url.length > 8) {
        flush();
        const node = urlNode(url, undefined, esc(url), url, false);
        node.auto = true;
        nodes.push(node);
        pos += url.length;
      } else {
        buf += c;
        pos++;
      }
    } else {
      buf += c;
      pos++;
    }
  }
  flush();
  return processEmphasis(nodes);
}

/** CommonMark's emphasis algorithm over a flat node list (delimiter runs are `t: 'delim'` nodes). */
function processEmphasis(nodes) {
  nodes = [...nodes];
  let closerIdx = 0;
  while (closerIdx < nodes.length) {
    const closer = nodes[closerIdx];
    if (closer.t !== 'delim' || !closer.canClose || closer.n === 0) {
      closerIdx++;
      continue;
    }
    let openerIdx = -1;
    for (let j = closerIdx - 1; j >= 0; j--) {
      const o = nodes[j];
      if (o.t !== 'delim' || o.ch !== closer.ch || !o.canOpen || o.n === 0) continue;
      if (closer.ch === '~') {
        openerIdx = j;
        break;
      }
      const oddMatch =
        (o.canClose || closer.canOpen) &&
        (o.orig + closer.orig) % 3 === 0 &&
        !(o.orig % 3 === 0 && closer.orig % 3 === 0);
      if (!oddMatch) {
        openerIdx = j;
        break;
      }
    }
    if (openerIdx < 0) {
      if (!closer.canOpen) closer.canClose = false;
      closerIdx++;
      continue;
    }
    const opener = nodes[openerIdx];
    const use = closer.ch === '~' ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    const inner = nodes
      .slice(openerIdx + 1, closerIdx)
      .map((n) => (n.t === 'delim' ? textNode(n.ch.repeat(n.n)) : n));
    const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const wrapped = {
      t: 'raw',
      h: `<${tag}>${inner.map((n) => n.h).join('')}</${tag}>`,
      x: inner.map((n) => n.x).join(''),
    };
    opener.n -= use;
    closer.n -= use;
    nodes.splice(openerIdx + 1, closerIdx - openerIdx - 1, wrapped);
    closerIdx = openerIdx + 2;
    if (opener.n === 0) {
      nodes.splice(openerIdx, 1);
      closerIdx--;
    }
    if (closer.n === 0) {
      nodes.splice(closerIdx, 1);
    }
  }
  return nodes.map((n) => (n.t === 'delim' ? textNode(n.ch.repeat(n.n)) : n));
}

/** Renders inline Markdown. Returns { h, x } (HTML and plain text). */
export function renderInline(src, ctx) {
  const nodes = parseInline(src, ctx);
  return { h: nodes.map((n) => n.h).join(''), x: nodes.map((n) => n.x).join('') };
}

// ───────────────────────────── blocks ─────────────────────────────

const isBlank = (line) => /^\s*$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*([^`]*?)\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const BQ_RE = /^ {0,3}>/;
const BLOCK_HTML_RE =
  /^ {0,3}<\/?(details|summary|div|p|table|thead|tbody|tr|td|th|ul|ol|li|hr|center|figure|blockquote|pre)(?:\s|>|\/>|$)/i;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function matchMarker(line) {
  let m = /^( {0,3})([-+*])(?:( +)(\S.*)|\s*)$/.exec(line);
  if (m) {
    const spaces = m[3]?.length ?? 0;
    const width = m[4] === undefined ? 1 : spaces > 4 ? 1 : spaces;
    return {
      kind: 'bullet',
      char: m[2],
      indent: m[1].length,
      offset: m[1].length + 1 + width,
      rest: m[4] === undefined ? '' : line.slice(m[1].length + 1 + width),
    };
  }
  m = /^( {0,3})(\d{1,9})([.)])(?:( +)(\S.*)|\s*)$/.exec(line);
  if (m) {
    const spaces = m[4]?.length ?? 0;
    const width = m[5] === undefined ? 1 : spaces > 4 ? 1 : spaces;
    const head = m[1].length + m[2].length + 1;
    return {
      kind: 'ordered',
      char: m[3],
      num: Number(m[2]),
      indent: m[1].length,
      offset: head + width,
      rest: m[5] === undefined ? '' : line.slice(head + width),
    };
  }
  return undefined;
}

/** Can this line interrupt a paragraph (so the paragraph ends before it)? */
function interruptsParagraph(line, nextLine) {
  if (FENCE_RE.test(line) || HR_RE.test(line) || ATX_RE.test(line) || BQ_RE.test(line)) return true;
  if (BLOCK_HTML_RE.test(line)) return true;
  const marker = matchMarker(line);
  if (marker && marker.rest !== '' && (marker.kind === 'bullet' || marker.num === 1)) return true;
  if (
    nextLine !== undefined &&
    line.includes('|') &&
    TABLE_DELIM_RE.test(nextLine) &&
    nextLine.includes('-')
  )
    return true;
  return false;
}

/** Splits a table row into cells; an escaped pipe stays inside its cell (even inside code, as in GFM). */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function parseBlocks(lines, ctx) {
  const blocks = [];
  let i = 0;
  let pendingGap = false;
  const add = (block) => {
    if (pendingGap && blocks.length) blocks.at(-1).gapAfter = true;
    pendingGap = false;
    block.gapAfter = false;
    blocks.push(block);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      pendingGap = true;
      i++;
      continue;
    }
    // Fenced code.
    let m = FENCE_RE.exec(line);
    if (m) {
      const fence = m[2];
      const indent = m[1].length;
      const body = [];
      i++;
      while (i < lines.length) {
        const close = new RegExp(
          `^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`,
        ).exec(lines[i]);
        if (close) {
          i++;
          break;
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      add({ type: 'code', info: m[3], text: body.join('\n') });
      continue;
    }
    // ATX heading.
    m = ATX_RE.exec(line);
    if (m) {
      add({ type: 'heading', level: m[1].length, text: (m[2] ?? '').trim() });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      add({ type: 'hr' });
      i++;
      continue;
    }
    // Block quote.
    if (BQ_RE.test(line)) {
      const inner = [];
      while (i < lines.length) {
        const l = lines[i];
        if (BQ_RE.test(l)) inner.push(l.replace(/^ {0,3}> ?/, ''));
        else if (
          !isBlank(l) &&
          inner.length &&
          !isBlank(inner.at(-1)) &&
          !interruptsParagraph(l) &&
          !matchMarker(l)
        )
          inner.push(l);
        else break;
        i++;
      }
      add({ type: 'quote', blocks: parseBlocks(inner, ctx) });
      continue;
    }
    // Lists.
    const marker = matchMarker(line);
    if (marker) {
      const result = parseList(lines, i, marker, ctx);
      add(result.block);
      i = result.next;
      if (result.trailingBlank) pendingGap = true;
      continue;
    }
    // Table.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_DELIM_RE.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      if (head.length === delim.length) {
        const align = delim.map((d) =>
          d.startsWith(':') && d.endsWith(':')
            ? 'center'
            : d.endsWith(':')
              ? 'right'
              : d.startsWith(':')
                ? 'left'
                : '',
        );
        const rows = [];
        i += 2;
        while (
          i < lines.length &&
          !isBlank(lines[i]) &&
          !FENCE_RE.test(lines[i]) &&
          !ATX_RE.test(lines[i]) &&
          !BQ_RE.test(lines[i])
        ) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        add({ type: 'table', head, align, rows });
        continue;
      }
    }
    // Block-level HTML.
    if (BLOCK_HTML_RE.test(line)) {
      const html = [];
      while (i < lines.length && !isBlank(lines[i])) html.push(lines[i++]);
      add({ type: 'html', text: html.join('\n') });
      continue;
    }
    // Indented code (not after a paragraph, since a paragraph would have consumed the line).
    if (indentOf(line) >= 4) {
      const body = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4))
        body.push(lines[i++].replace(/^ {4}/, ''));
      while (body.length && isBlank(body.at(-1))) body.pop();
      add({ type: 'code', info: '', text: body.join('\n') });
      continue;
    }
    // Paragraph.
    const para = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !interruptsParagraph(lines[i], lines[i + 1]))
      para.push(lines[i++]);
    add({
      type: 'paragraph',
      text: para
        .map((l) => l.replace(/^\s+/, ''))
        .join('\n')
        .replace(/\s+$/, ''),
    });
  }
  return blocks;
}

function parseList(lines, start, first, ctx) {
  const items = [];
  let i = start;
  let betweenItemsLoose = false;
  let lastMarker = first;
  while (i < lines.length) {
    const m = matchMarker(lines[i]);
    if (!m || m.kind !== first.kind || m.char !== first.char || m.indent >= lastMarker.offset)
      break;
    if (HR_RE.test(lines[i])) break;
    const itemLines = [m.rest];
    let k = i + 1;
    while (k < lines.length) {
      const l = lines[k];
      if (isBlank(l)) {
        itemLines.push('');
        k++;
        continue;
      }
      if (indentOf(l) >= m.offset) {
        itemLines.push(l.slice(m.offset));
        k++;
        continue;
      }
      // Lazy continuation of a paragraph (never inside a fenced block of the item).
      const prevBlank = isBlank(lines[k - 1]);
      const inFence = itemLines.filter((x) => FENCE_RE.test(x)).length % 2 === 1;
      if (!prevBlank && !inFence && !interruptsParagraph(l, lines[k + 1]) && !matchMarker(l)) {
        itemLines.push(l.trimStart());
        k++;
        continue;
      }
      break;
    }
    let trailingBlank = false;
    while (itemLines.length > 1 && isBlank(itemLines.at(-1))) {
      itemLines.pop();
      trailingBlank = true;
    }
    items.push({ lines: itemLines, trailingBlank, marker: m });
    lastMarker = m;
    i = k;
    // After trailing blanks, the next line must be another item of this list, otherwise the list ends.
    if (trailingBlank) {
      let probe = i;
      while (probe < lines.length && isBlank(lines[probe])) probe++;
      const next = probe < lines.length ? matchMarker(lines[probe]) : undefined;
      if (
        next &&
        next.kind === first.kind &&
        next.char === first.char &&
        next.indent < lastMarker.offset &&
        !HR_RE.test(lines[probe])
      ) {
        betweenItemsLoose = true;
        i = probe;
      } else {
        // Give the blank lines back so that the paragraph that follows is not glued to the list.
        break;
      }
    }
  }
  const parsed = items.map((item) => {
    let text = item.lines;
    let task;
    const t = /^\[([ xX])\][ \t]+/.exec(text[0] ?? '');
    if (t) {
      task = t[1] !== ' ' ? 'done' : 'todo';
      text = [text[0].slice(t[0].length), ...text.slice(1)];
    }
    const blocks = parseBlocks(text, ctx);
    const loose = blocks.slice(0, -1).some((b) => b.gapAfter);
    return { blocks, loose, task };
  });
  const loose = betweenItemsLoose || parsed.some((it) => it.loose);
  return {
    next: i,
    trailingBlank: items.at(-1)?.trailingBlank ?? false,
    block: {
      type: 'list',
      ordered: first.kind === 'ordered',
      start: first.kind === 'ordered' ? first.num : 1,
      loose,
      items: parsed,
    },
  };
}

// ───────────────────────────── rendering ─────────────────────────────

/** Text the renderer itself puts into the page (accessible names and one caption); the site passes its translation. */
export const DEFAULT_LABELS = {
  anchor: 'Link to this section',
  table: 'Table',
  mermaid: 'Diagram source (Mermaid)',
  footnote: 'Footnote',
  back: 'Back to the text',
  done: 'Done',
  notDone: 'Not done',
};

class Context {
  constructor(options) {
    this.options = options;
    this.labels = { ...DEFAULT_LABELS, ...options.labels };
    this.rewriteHref = options.rewriteHref;
    this.rewriteSrc = options.rewriteSrc;
    this.refs = new Map();
    this.footnoteDefs = new Map();
    this.fnOrder = [];
    this.fnUses = new Map();
    this.warnings = [];
    this.links = [];
    this.slugs = new SlugCounter();
    this.headings = [];
    this.sections = [];
    this.current = undefined;
  }

  footnoteRef(id) {
    let n = this.fnOrder.indexOf(id) + 1;
    if (n === 0) {
      this.fnOrder.push(id);
      n = this.fnOrder.length;
    }
    const uses = (this.fnUses.get(id) ?? 0) + 1;
    this.fnUses.set(id, uses);
    const key = footnoteKey(id);
    return rawNode(
      `<sup class="fnref"><a href="#fn-${key}" id="fnref-${key}${uses > 1 ? `-${uses}` : ''}" aria-label="${esc(this.labels.footnote)} ${n}">${n}</a></sup>`,
      '',
    );
  }

  openSection(level, title, id) {
    this.current = { level, title, id, text: [], code: [] };
    this.sections.push(this.current);
  }
  addText(text) {
    if (!this.current) this.openSection(0, '', '');
    if (text) this.current.text.push(text);
  }
  addCode(text) {
    if (!this.current) this.openSection(0, '', '');
    if (text) this.current.code.push(text);
  }
}

const footnoteKey = (id) => id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

function inline(src, ctx) {
  const { h, x } = renderInline(src, ctx);
  return { h, x };
}

function renderTable(block, ctx) {
  // A column with prose in its cells gets a wider minimum, so that its rows do not turn into tall, narrow strips;
  // columns of short cells (names, links, code) stay narrow.
  const shown = (text) => text.replace(/\]\([^)]*\)/g, ']').replace(/[`*_]/g, '');
  const wide = new Set();
  for (const row of [block.head, ...block.rows])
    row.forEach((text, i) => {
      if (shown(text).length > 70) wide.add(i);
    });
  const cell = (tag, text, i) => {
    const { h, x } = inline(text, ctx);
    ctx.addText(x);
    const classes = [block.align[i] ? `al-${block.align[i]}` : '', wide.has(i) ? 'wc' : ''].filter(
      Boolean,
    );
    return `<${tag}${classes.length ? ` class="${classes.join(' ')}"` : ''}>${h}</${tag}>`;
  };
  // GFM drops the cells of a row that are beyond the header. A reader is better served by seeing them, so the table
  // is widened (with empty header cells) and the problem is reported to the build, which lets the test name it.
  const headWidth = block.head.length;
  const width = Math.max(headWidth, ...block.rows.map((r) => r.length));
  for (const row of block.rows)
    if (row.length > headWidth)
      ctx.warnings.push({
        kind: 'table-row-too-wide',
        detail: `${row.length} cells in a ${headWidth}-column table: ${row[0]}`,
      });
  const headCells = Array.from({ length: width }, (_, i) =>
    i < headWidth ? cell('th', block.head[i], i) : '<th></th>',
  );
  const head = `<thead><tr>${headCells.join('')}</tr></thead>`;
  const rows = block.rows
    .map(
      (row) =>
        `<tr>${Array.from({ length: width }, (_, i) => cell('td', row[i] ?? '', i)).join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(ctx.labels.table)}"><table>${head}<tbody>${rows}</tbody></table></div>`;
}

function renderCode(block, ctx) {
  const lang = block.info.split(/\s+/)[0] ?? '';
  ctx.addCode(block.text);
  const label = lang ? `<div class="code-lang" aria-hidden="true">${esc(lang)}</div>` : '';
  const note = lang === 'mermaid' ? `<div class="code-note">${esc(ctx.labels.mermaid)}</div>` : '';
  return `<div class="code-block${lang ? ' has-lang' : ''}">${label}${note}<pre${lang === 'mermaid' ? ' class="mermaid"' : ''} tabindex="0"><code${lang ? ` class="language-${esc(lang)}"` : ''}>${highlight(block.text, lang)}</code></pre></div>`;
}

function renderBlocks(blocks, ctx, tight = false) {
  let out = '';
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const { h, x } = inline(block.text, ctx);
        const id = ctx.slugs.next(x);
        ctx.headings.push({ level: block.level, text: x, id });
        ctx.openSection(block.level, x, id);
        out += `<h${block.level} id="${esc(id)}">${h}<a class="anchor" href="#${esc(id)}" aria-label="${esc(ctx.labels.anchor)}"><span aria-hidden="true">#</span></a></h${block.level}>\n`;
        break;
      }
      case 'paragraph': {
        const { h, x } = inline(block.text, ctx);
        ctx.addText(x);
        out += tight ? `${h}\n` : `<p>${h}</p>\n`;
        break;
      }
      case 'code':
        out += renderCode(block, ctx) + '\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'quote':
        out += `<blockquote>\n${renderBlocks(block.blocks, ctx)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const startAttr = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
        const hasTasks = block.items.some((it) => it.task);
        const items = block.items
          .map((it) => {
            const box = it.task
              ? `<input type="checkbox" disabled${it.task === 'done' ? ' checked' : ''} aria-label="${esc(it.task === 'done' ? ctx.labels.done : ctx.labels.notDone)}"> `
              : '';
            const body = renderBlocks(it.blocks, ctx, !block.loose).replace(/\n$/, '');
            return `<li${it.task ? ' class="task"' : ''}>${box}${body}</li>`;
          })
          .join('\n');
        out += `<${tag}${startAttr}${hasTasks ? ' class="tasks"' : ''}>\n${items}\n</${tag}>\n`;
        break;
      }
      case 'table':
        out += renderTable(block, ctx) + '\n';
        break;
      case 'html': {
        // Block-level raw HTML: text is escaped and every tag goes through the same whitelist as inline HTML.
        let html = '';
        let last = 0;
        for (const m of block.text.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
          html += esc(block.text.slice(last, m.index));
          const parsed = TAG_RE.exec(m[0]);
          const clean = parsed ? sanitizeTag(parsed, true) : undefined;
          if (clean === undefined) {
            ctx.warnings.push({ kind: 'raw-html-escaped', detail: m[0] });
            html += esc(m[0]);
          } else html += clean;
          last = m.index + m[0].length;
        }
        out += html + esc(block.text.slice(last)) + '\n';
        break;
      }
      default:
        throw new Error(`unknown block ${block.type}`);
    }
  }
  return out;
}

/** Collects footnote and link definitions and returns the remaining lines. */
function extractDefinitions(lines, ctx) {
  const kept = [];
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      kept.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      kept.push(line);
      continue;
    }
    const fn = /^\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
    if (fn) {
      const parts = [fn[2]];
      while (i + 1 < lines.length && /^( {4}|\t)\S/.test(lines[i + 1]))
        parts.push(lines[++i].trim());
      ctx.footnoteDefs.set(fn[1], parts.join(' '));
      continue;
    }
    const ref = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*$/.exec(line);
    if (ref) {
      ctx.refs.set(normalizeLabel(ref[1]), {
        dest: ref[2].replace(/^<|>$/g, ''),
        title: ref[3] ?? ref[4],
      });
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/**
 * Renders a Markdown document.
 * @param {string} source
 * @param {{rewriteHref?: (href: string) => string, rewriteSrc?: (src: string) => string}} [options]
 * @returns {{html: string, title: string, headings: Array, sections: Array, warnings: Array, links: Array}}
 */
export function renderMarkdown(source, options = {}) {
  const ctx = new Context(options);
  const text = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = extractDefinitions(text.split('\n'), ctx);
  const blocks = parseBlocks(lines, ctx);
  let html = renderBlocks(blocks, ctx);
  if (ctx.fnOrder.length) {
    const items = ctx.fnOrder
      .map((id) => {
        const key = footnoteKey(id);
        const { h, x } = inline(ctx.footnoteDefs.get(id), ctx);
        ctx.addText(x);
        const uses = ctx.fnUses.get(id) ?? 1;
        const back = Array.from(
          { length: uses },
          (_, n) =>
            `<a href="#fnref-${key}${n ? `-${n + 1}` : ''}" class="fnback" aria-label="${esc(ctx.labels.back)}">↩</a>`,
        ).join(' ');
        return `<li id="fn-${key}">${h} ${back}</li>`;
      })
      .join('\n');
    html += `<div class="footnotes" role="doc-endnotes">\n<ol>\n${items}\n</ol>\n</div>\n`;
  }
  const title = ctx.headings.find((h) => h.level === 1)?.text ?? '';
  const sections = ctx.sections.map((s) => ({
    level: s.level,
    title: s.title,
    id: s.id,
    text: s.text.join(' '),
    code: s.code.join('\n'),
  }));
  return {
    html,
    title,
    headings: ctx.headings,
    sections,
    warnings: ctx.warnings,
    links: ctx.links,
  };
}
