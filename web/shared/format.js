// Number, duration and time formatting shared by the console and the portal, so a figure reads the
// same in both. Pure functions; `lang` is 'zh' (default) or 'en'. Rules:
//   points    |n| < 1: up to 4 decimals; otherwise up to 2; no trailing zeros; thousands separators.
//             Below 0.0001 it shows "<0.0001" (a charge that exists is never shown as 0).
//   tokens    whole numbers with thousands separators, never in units of ten thousand. Where a column is too narrow,
//             formatTokensShort() gives 1.2K / 3.4M / 5.6B (the same in both languages).
//   duration  < 1 s "320 ms"; < 60 s "4.2 s"; then "1m 24s"; then "2h 5m". Chinese has its own units (format-zh.js).
//   time      within 7 days relative: "just now", "12 min ago", "3 h ago", "2 d ago"; after that
//             "Nov 5, 16:29", with the year when it is not the current year ("Nov 5, 2025, 16:29").
//             Chinese wording and date order live in format-zh.js.
import { ZH } from './format-zh.js';

const DAY = 86_400_000;
const locale = (lang) => (lang === 'en' ? 'en-US' : 'zh-CN');
const formatters = new Map();
const grouped = (lang, digits) => {
  const key = `${lang}:${digits}`;
  if (!formatters.has(key))
    formatters.set(
      key,
      new Intl.NumberFormat(locale(lang), { maximumFractionDigits: digits, useGrouping: true }),
    );
  return formatters.get(key);
};

export function formatPoints(n, lang = 'zh') {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 0.0001) return `${v < 0 ? '−' : ''}<0.0001`;
  return grouped(lang, abs < 1 ? 4 : 2).format(v);
}
export const formatSignedPoints = (n, lang = 'zh') => {
  const v = Number(n);
  const text = formatPoints(Math.abs(v), lang);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${text}`;
};

export const formatTokens = (n, lang = 'zh') =>
  grouped(lang, 0).format(Number.isFinite(Number(n)) ? Number(n) : 0);
export function formatTokensShort(n, lang = 'zh') {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs < 10_000) return formatTokens(v, lang);
  const [unit, size] = abs < 1e6 ? ['K', 1e3] : abs < 1e9 ? ['M', 1e6] : ['B', 1e9];
  return `${(v / size).toFixed(1).replace(/\.0$/, '')}${unit}`;
}

export function formatDuration(value, lang = 'zh') {
  if (value == null || value === '') return '—';
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const en = lang === 'en';
  if (ms < 3_600_000) {
    const seconds = Math.round(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (en) return s ? `${m}m ${s}s` : `${m}m`;
    return s ? `${m} ${ZH.minute} ${s} ${ZH.second}` : `${m} ${ZH.minute}`;
  }
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (en) return m ? `${h}h ${m}m` : `${h}h`;
  return m ? `${h} ${ZH.hour} ${m} ${ZH.minute}` : `${h} ${ZH.hour}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
const sameYear = (d, now) => d.getFullYear() === new Date(now).getFullYear();

/** "Nov 5, 16:29", or "Nov 5, 2025, 16:29" in another year (Chinese: see format-zh.js). */
export function formatDateTime(ms, lang = 'zh', now = Date.now()) {
  if (!ms) return '—';
  const d = new Date(ms);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const year = sameYear(d, now);
  if (lang === 'en')
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${year ? '' : `${d.getFullYear()}, `}${clock}`;
  return `${ZH.date(d, year)} ${clock}`;
}
/** Date only: "Nov 5"; with the year in another year. */
export function formatDate(ms, lang = 'zh', now = Date.now()) {
  if (!ms) return '—';
  const d = new Date(ms);
  const year = sameYear(d, now);
  if (lang === 'en')
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${year ? '' : `, ${d.getFullYear()}`}`;
  return ZH.date(d, year);
}
/** Relative within 7 days (and for a clock a minute ahead at most), absolute after that. */
export function formatWhen(ms, lang = 'zh', now = Date.now()) {
  if (!ms) return '';
  const age = now - ms;
  if (age < -60_000 || age >= 7 * DAY) return formatDateTime(ms, lang, now);
  const en = lang === 'en';
  const minutes = Math.floor(Math.max(age, 0) / 60_000);
  if (minutes < 1) return en ? 'just now' : ZH.justNow;
  if (minutes < 60) return en ? `${minutes} min ago` : `${minutes} ${ZH.minutesAgo}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return en ? `${hours} h ago` : `${hours} ${ZH.hoursAgo}`;
  const days = Math.floor(hours / 24);
  return en ? `${days} d ago` : `${days} ${ZH.daysAgo}`;
}
