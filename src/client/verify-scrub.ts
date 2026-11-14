/**
 * Scrubbing for the reports `oaa verify` writes. A report is meant to be pasted into a public issue, so
 * it must carry nothing about the machine beyond the test itself: no key or token, no user name, no home
 * or other local path, no host name, no e-mail address or LAN address. Approach as in
 * tools/demo-video/lib/scrub.mjs: replace known values first (secrets, the work directory, home
 * directory, user and host names), then every path-looking token, and finally check the result again.
 */
import os from 'node:os';
import { realpathSync } from 'node:fs';

export type ScrubContext = {
  /** Secret values (keys, tokens, secret-looking environment values): replaced wherever they occur. */
  secrets?: string[];
  /** The temporary work directory; paths below it become `<workdir>/...`. */
  workDir?: string;
  homeDir?: string;
  user?: string;
  host?: string;
};

export const PATH_PLACEHOLDER = '<path>';
export const WORKDIR_PLACEHOLDER = '<workdir>';

/** Values taken from the machine this process runs on; tests pass their own. */
export function machineContext(extra: Partial<ScrubContext> = {}): ScrubContext {
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME;
  }
  return { homeDir: os.homedir(), user, host: os.hostname(), ...extra };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What follows a path root up to whitespace, a bracket, a quote, an escape or punctuation.
const PATHISH = String.raw`[^\s)\]}"'\\,;，；）」<>|]*`;
const ROOTS = 'Users|home|Volumes|private|var|tmp|root|etc|opt|mnt|srv|usr|nix|proc|run|snap';
const PATTERNS: [RegExp, string][] = [
  [new RegExp(String.raw`file://${PATHISH}`, 'gi'), PATH_PLACEHOLDER],
  [new RegExp(String.raw`(?<![\w.:~<-])~/${PATHISH}`, 'g'), PATH_PLACEHOLDER],
  [new RegExp(String.raw`(?<![\w.:~<-])/(?:${ROOTS})/${PATHISH}`, 'g'), PATH_PLACEHOLDER],
  // Windows: C:\Users\x, C:/Users/x and the JSON-escaped C:\\Users\\x
  [/(?<![\w])[A-Za-z]:(?:\\\\?|\/)[^\s)\]}"']*/g, PATH_PLACEHOLDER],
  [/\\\\[A-Za-z0-9._$-]{3,}\\[^\s"']*/g, PATH_PLACEHOLDER],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/127\.0\.0\.1:\d{2,5}/g, '127.0.0.1:<port>'],
  [/\b(?!127\.)(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, '<ip>'],
  // Credential shapes that are not ours: provider keys, GitHub and Slack tokens, AWS key IDs, JWTs, bearer headers.
  [/\bsk-oaa-[A-Za-z0-9_-]{8,}/g, 'sk-oaa-[REDACTED]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [REDACTED]'],
];

function variants(dir: string | undefined): string[] {
  if (!dir) return [];
  const out = new Set<string>([dir]);
  try {
    out.add(realpathSync(dir));
  } catch {
    // The directory may already be gone (the work directory is removed before the report is built).
  }
  for (const d of [...out]) {
    if (d.startsWith('/private/')) out.add(d.slice('/private'.length));
    else if (/^\/(var|tmp|etc)\//.test(d)) out.add(`/private${d}`);
    out.add(d.replace(/\\/g, '\\\\'));
  }
  return [...out].filter((d) => d.length > 1).sort((a, b) => b.length - a.length);
}

/** A name replaced as a whole word (so a three-letter user name does not mangle other words). */
const wordPattern = (name: string) =>
  new RegExp(String.raw`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'g');

/** The scrubber for one report: `text` for strings, `deep` for whole JSON values (keys and strings). */
export function makeScrubber(context: ScrubContext) {
  const secrets = [...new Set((context.secrets ?? []).filter((s) => s.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );
  const names: [RegExp, string][] = [];
  const user = context.user?.trim();
  if (user && user.length >= 3 && user !== 'root') names.push([wordPattern(user), '<user>']);
  const host = context.host?.trim();
  if (host) {
    for (const h of new Set([host, host.split('.')[0] ?? ''])) {
      if (h.length >= 3 && h.toLowerCase() !== 'localhost') names.push([wordPattern(h), '<host>']);
    }
  }
  const work = variants(context.workDir);
  const home = variants(context.homeDir).filter((d) => !work.includes(d));
  const text = (input: string): string => {
    let out = input;
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    // The work directory keeps its tail (session folders are not personal); the home directory does not.
    for (const dir of work) out = out.split(dir).join(WORKDIR_PLACEHOLDER);
    for (const dir of home)
      out = out.replace(new RegExp(`${escapeRegExp(dir)}${PATHISH}`, 'g'), PATH_PLACEHOLDER);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    for (const [pattern, replacement] of names) out = out.replace(pattern, replacement);
    return out;
  };
  const deep = <T>(value: T): T => {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map((v) => deep(v)) as T;
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [text(k), deep(v)]),
      ) as T;
    return value;
  };
  /** What a scrubbed text still contains that should not be there (empty when clean). */
  const leaks = (scrubbed: string): string[] => {
    const found: string[] = [];
    for (const secret of secrets) if (scrubbed.includes(secret)) found.push('secret value');
    for (const dir of [...work, ...home]) if (scrubbed.includes(dir)) found.push('local directory');
    for (const [pattern] of names)
      if (new RegExp(pattern.source).test(scrubbed)) found.push('user or host name');
    for (const [pattern, replacement] of PATTERNS)
      if (replacement === PATH_PLACEHOLDER && new RegExp(pattern.source).test(scrubbed))
        found.push('path');
    return found;
  };
  return { text, deep, leaks };
}
