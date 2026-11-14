// Builds the client-side search index of the documentation site.
//
// One entry per section (headings of level 1 to 3; deeper headings are folded into their parent). An entry is a
// compact array: [url, page title, section heading, excerpt, keywords]. The excerpt is the start of the section's
// prose (this is what a result shows); the keywords are the identifiers and words of the rest of the section
// (including its code), so that a search for `previous_response_id` or `X-OAA-Client-Tools` finds the section that
// talks about it even if the word is not in the excerpt. Chinese text is matched as a plain substring of the
// excerpt, heading and title, which is why the Chinese excerpt is kept a little longer.

const STOP = new Set(
  (
    'the and for with that this from are was were has have had not but you your can will when what which how its ' +
    'into only also any all one two than then them they their there these those been being does did done use used ' +
    'using each such via per may might must should would could about after before over under more most other some ' +
    'both either neither same own very just like see set get put new add run runs'
  ).split(' '),
);

const WORD = /[a-z0-9][a-z0-9_.:/-]*[a-z0-9]|[a-z0-9]/g;

/** Lower-case Latin tokens of a text (identifiers keep their underscores, dots, colons, slashes and hyphens). */
export function tokens(text) {
  return (text.toLowerCase().match(WORD) ?? []).filter(
    (t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t),
  );
}

const clean = (text) => text.replace(/\s+/g, ' ').trim();

/** Excerpt: the first `limit` characters, cut at a word boundary for Latin text. */
function excerpt(text, limit) {
  const t = clean(text);
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim() + '…';
}

/**
 * @param {Array<{title: string, url: string, sections: Array<{level: number, title: string, id: string, text: string, code: string}>}>} pages
 * @param {{lang: string}} options
 */
export function buildIndex(pages, { lang }) {
  const zh = lang.startsWith('zh');
  const excerptLength = zh ? 150 : 200;
  const maxKeywords = 28;
  const entries = [];
  for (const page of pages) {
    // Fold sections deeper than 3 into the closest shallower one.
    const merged = [];
    for (const s of page.sections) {
      const last = merged.at(-1);
      if (s.level > 3 && last) {
        last.text += ' ' + s.title + ' ' + s.text;
        last.code += '\n' + s.code;
      } else merged.push({ ...s });
    }
    for (const s of merged) {
      const prose = clean(s.text);
      if (!prose && !s.code && s.level !== 1) continue;
      const heading = s.level === 0 ? '' : s.title;
      const shown = excerpt(prose || clean(s.code), excerptLength);
      const known = new Set(tokens(`${page.title} ${heading} ${shown}`));
      const counts = new Map();
      for (const t of tokens(`${prose} ${s.code}`))
        if (!known.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      const rank = (t) => (counts.get(t) ?? 0) + (/[_.:/-]/.test(t) ? 3 : 0);
      const keywords = [...counts.keys()]
        .sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
        .slice(0, maxKeywords)
        .join(' ');
      const url = s.id && s.level !== 1 ? `${page.url}#${s.id}` : page.url;
      entries.push([url, page.title, heading === page.title ? '' : heading, shown, keywords]);
    }
  }
  return entries;
}

/** The index as a script file (a script tag works from file:// as well, where fetch() does not). */
export function indexScript(entries, lang) {
  return `window.__OAA_DOCS_INDEX__=window.__OAA_DOCS_INDEX__||{};window.__OAA_DOCS_INDEX__[${JSON.stringify(lang)}]=${JSON.stringify(entries)};\n`;
}
