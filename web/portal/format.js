import { lang, t } from './i18n.js';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatPoints,
  formatSignedPoints,
  formatTokens,
  formatTokensShort,
  formatWhen,
} from './shared/format.js';

// Numbers, durations and times follow web/shared/format.js, the console's rules too.
const locale = () => (lang === 'zh' ? 'zh-CN' : 'en-US');
export const points = (n) => formatPoints(n, lang);
export const signedPoints = (n) => formatSignedPoints(n, lang);
export const integer = (n) => formatTokens(n, lang);
export const compact = (n) => formatTokensShort(n, lang);
export const duration = (ms) => formatDuration(ms, lang);
// Relative within 7 days, then "11月5日 16:29" / "Nov 5, 16:29".
export const when = (ms) => formatWhen(ms, lang);
export const dateTime = (ms) => formatDateTime(ms, lang);
export const dateOnly = (ms) => formatDate(ms, lang);

// The full moment, seconds included, for places that show exact times (a task's details).
export const dateTimeFull = (ms) =>
  ms
    ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'medium' }).format(ms)
    : '—';

// ["每次 0.5 点", "每千 token 0.1 点"], or ["免费"] when both prices are zero.
export function priceLines(price) {
  const perRun = price?.per_run ?? 0;
  const perK = price?.per_1k_tokens ?? 0;
  if (!perRun && !perK) return [t('price.free')];
  const parts = [];
  if (perRun)
    parts.push(t(perRun === 1 ? 'price.per_run_one' : 'price.per_run', { n: points(perRun) }));
  if (perK) parts.push(t(perK === 1 ? 'price.per_1k_one' : 'price.per_1k', { n: points(perK) }));
  return parts;
}
// The same on one line: "每次 0.5 点 · 每千 token 0.1 点".
export const priceText = (price) => priceLines(price).join(' · ');

// "任务出错：…" / "The task failed: …": the colon follows the page's language.
export const withLabel = (label, text) => `${label}${lang === 'zh' ? '：' : ': '}${text}`;
