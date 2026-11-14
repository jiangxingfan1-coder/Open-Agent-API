// GitHub's heading anchors, shared by the documentation site generator and its tests.
// Rule (as GitHub renders them): take the text of the heading, lower-case it, drop everything that is not
// a letter, mark, number, connector punctuation, hyphen or space, then turn spaces into hyphens.
// A repeated heading gets "-1", "-2", ... appended (see SlugCounter).

/** Anchor for the plain text of a heading (inline markup already removed). */
export function githubSlug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Hands out unique anchors for the headings of one document, the way GitHub does. */
export class SlugCounter {
  seen = new Map();
  next(text) {
    const base = githubSlug(text);
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }
}
