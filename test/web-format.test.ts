import test from 'node:test';
import assert from 'node:assert/strict';

// The console and the portal format points, tokens, durations and times with the same functions
// (web/shared/format.js). Table-driven: every row is `[input, expected]`. Pure functions, no DOM.

type Lang = 'zh' | 'en';
interface Format {
  formatPoints(n: unknown, lang?: Lang): string;
  formatSignedPoints(n: unknown, lang?: Lang): string;
  formatTokens(n: unknown, lang?: Lang): string;
  formatTokensShort(n: unknown, lang?: Lang): string;
  formatDuration(ms: unknown, lang?: Lang): string;
  formatWhen(ms: number, lang?: Lang, now?: number): string;
  formatDateTime(ms: number, lang?: Lang, now?: number): string;
  formatDate(ms: number, lang?: Lang, now?: number): string;
}
const f = (await import(new URL('../../web/shared/format.js', import.meta.url).href)) as Format;

test('points: under 1 up to 4 decimals, otherwise 2, no trailing zeros, grouped', () => {
  const rows: Array<[unknown, string]> = [
    [0, '0'],
    [0.5, '0.5'],
    [0.7522, '0.7522'],
    [0.0814, '0.0814'],
    [0.75226, '0.7523'],
    [0.00005, '<0.0001'],
    [1, '1'],
    [1.2, '1.2'],
    [12.5, '12.5'],
    [0.99996, '1'],
    [128.45, '128.45'],
    [128.4567, '128.46'],
    [2000, '2,000'],
    [9913.35, '9,913.35'],
    [12345678.9, '12,345,678.9'],
    [-3.5, '-3.5'],
    ['abc', '0'],
    [undefined, '0'],
  ];
  for (const [input, expected] of rows)
    assert.equal(f.formatPoints(input), expected, String(input));
  assert.equal(f.formatPoints(1234.5, 'en'), '1,234.5');
  assert.equal(f.formatSignedPoints(12.5), '+12.5');
  assert.equal(f.formatSignedPoints(-0.35), '−0.35');
  assert.equal(f.formatSignedPoints(0), '0');
});

test('tokens: thousands separators, never 万 / 亿; short form is the same in both languages', () => {
  const rows: Array<[unknown, string, string]> = [
    [0, '0', '0'],
    [999, '999', '999'],
    [12600, '12,600', '12.6K'],
    [1556700, '1,556,700', '1.6M'],
    [18420000, '18,420,000', '18.4M'],
    [482000000, '482,000,000', '482M'],
    [8000000000, '8,000,000,000', '8B'],
    [9999, '9,999', '9,999'],
    [10000, '10,000', '10K'],
  ];
  for (const [input, full, short] of rows) {
    assert.equal(f.formatTokens(input), full, String(input));
    assert.equal(f.formatTokensShort(input), short, String(input));
    assert.equal(f.formatTokensShort(input, 'en'), short, `en ${String(input)}`);
    assert.ok(!/[万亿]/.test(f.formatTokens(input) + f.formatTokensShort(input)));
  }
});

test('duration: ms, one-decimal seconds, minutes and hours, per language', () => {
  const rows: Array<[unknown, string, string]> = [
    [0, '0 ms', '0 ms'],
    [320, '320 ms', '320 ms'],
    [4200, '4.2 s', '4.2 s'],
    [41000, '41.0 s', '41.0 s'],
    [60000, '1 分', '1m'],
    [84000, '1 分 24 秒', '1m 24s'],
    [125000, '2 分 5 秒', '2m 5s'],
    [3600000, '1 小时', '1h'],
    [7500000, '2 小时 5 分', '2h 5m'],
    [-5, '—', '—'],
    [null, '—', '—'],
    [Number.NaN, '—', '—'],
  ];
  for (const [input, zh, en] of rows) {
    assert.equal(f.formatDuration(input), zh, String(input));
    assert.equal(f.formatDuration(input, 'en'), en, `en ${String(input)}`);
  }
});

test('time: relative within 7 days, then M月D日 HH:mm, with the year when it differs', () => {
  const at = (y: number, mo: number, d: number, h = 16, mi = 29) =>
    new Date(y, mo - 1, d, h, mi).getTime();
  const now = at(2026, 11, 12, 16, 30);
  const min = 60_000;
  const rows: Array<[number, string, string]> = [
    [now - 20_000, '刚刚', 'just now'],
    [now - 12 * min, '12 分钟前', '12 min ago'],
    [now - 59 * min, '59 分钟前', '59 min ago'],
    [now - 3 * 60 * min, '3 小时前', '3 h ago'],
    [now - 23 * 60 * min, '23 小时前', '23 h ago'],
    [now - 2 * 24 * 60 * min, '2 天前', '2 d ago'],
    [now - (7 * 24 * 60 - 1) * min, '6 天前', '6 d ago'],
    [now - 7 * 24 * 60 * min, '11月5日 16:30', 'Nov 5, 16:30'],
    [at(2026, 10, 23, 9, 5), '10月23日 09:05', 'Oct 23, 09:05'],
    [at(2025, 12, 31, 23, 59), '2025年12月31日 23:59', 'Dec 31, 2025, 23:59'],
    [now + 10 * min, '11月12日 16:40', 'Nov 12, 16:40'],
    [now + 30_000, '刚刚', 'just now'],
  ];
  for (const [ms, zh, en] of rows) {
    assert.equal(f.formatWhen(ms, 'zh', now), zh, `zh ${new Date(ms).toISOString()}`);
    assert.equal(f.formatWhen(ms, 'en', now), en, `en ${new Date(ms).toISOString()}`);
  }
  assert.equal(f.formatWhen(0, 'zh', now), '');
  assert.equal(f.formatDateTime(at(2026, 1, 3, 7, 8), 'zh', now), '1月3日 07:08');
  assert.equal(f.formatDateTime(0), '—');
  assert.equal(f.formatDate(at(2026, 11, 5), 'zh', now), '11月5日');
  assert.equal(f.formatDate(at(2025, 11, 5), 'en', now), 'Nov 5, 2025');
});
