import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import { duration, formatTime, num, percent } from '../lib/format.js';
import { $, el } from '../lib/dom.js';
import { activityData } from '../lib/live.js';

export const filterText = () => ($('filter')?.value ?? '').trim().toLowerCase();
export const setCount = (text) => {
  if ($('collection-count')) $('collection-count').textContent = text;
};
// Where a request's wall-clock time went, attributed along its critical path.
export const BREAKDOWN = [
  ['model', t('breakdown.model')],
  ['tools', t('breakdown.tools')],
  ['queue', t('breakdown.queue')],
  ['approval', t('breakdown.approval')],
  ['other', t('breakdown.other')],
];
export function breakdownInsight(parts, total) {
  const share = Object.fromEntries(parts.map(([key, , value]) => [key, value / total]));
  if ((share.queue ?? 0) >= 0.25)
    return t('breakdown.insightQueue', { share: percent(share.queue) });
  if ((share.approval ?? 0) >= 0.25)
    return t('breakdown.insightApproval', { share: percent(share.approval) });
  const [key, label] = [...parts].sort((x, y) => y[2] - x[2])[0];
  return key === 'other' ? '' : t('breakdown.insightTop', { label, share: percent(share[key]) });
}
// Shared with the run inspector: one bar, one legend, one plain-language reading.
export function breakdownBlock(b, { title = t('breakdown.title'), caption } = {}) {
  if (!b) return null;
  const parts = BREAKDOWN.map(([key, label]) => [
    key,
    label,
    Math.max(0, Number(b[key]) || 0),
  ]).filter(([, , value]) => value > 0);
  const total = parts.reduce((sum, [, , value]) => sum + value, 0);
  // A single category ("100% queue") says nothing the status line does not already say.
  if (!total || parts.length < 2) return null;
  const runs = Number(b.runs) || 0;
  const box = el('div', undefined, 'breakdown');
  const head = el('div', undefined, 'breakdown-head');
  head.append(el('span', title, 'breakdown-title'));
  const note = caption ?? (runs ? t('breakdown.caption', { n: num(runs) }) : '');
  if (note) head.append(el('span', note, 'muted'));
  const bar = el('div', undefined, 'breakdown-bar');
  bar.setAttribute('role', 'img');
  const legend = el('div', undefined, 'breakdown-legend');
  const described = [];
  for (const [key, label, value] of parts) {
    const share = value / total;
    const seg = el('span', undefined, `seg ${key}`);
    seg.style.flexGrow = String(value);
    seg.title = `${label} ${percent(share)}${
      runs ? t('breakdown.avg', { time: formatTime(value / runs) }) : ` · ${formatTime(value)}`
    }`;
    bar.append(seg);
    const item = el('span', undefined, 'legend-item');
    item.append(
      el('i', undefined, `swatch ${key}`),
      el('span', label),
      el('strong', percent(share)),
    );
    legend.append(item);
    described.push(`${label} ${percent(share)}`);
  }
  bar.setAttribute('aria-label', described.join(t('common.comma')));
  box.append(head, bar, legend);
  const insight = breakdownInsight(parts, total);
  if (insight) box.append(el('p', insight, 'breakdown-insight'));
  return box;
}
export function agentById(id) {
  return state.data?.agents.find((a) => a.id === id);
}
export function agentHealth(id) {
  const s = activityData()?.agents?.find((x) => x.agent === id);
  if (!s || !Number(s.runs)) return '';
  const finished = (Number(s.completed) || 0) + (Number(s.failed) || 0);
  const parts = [t('health.runs', { n: num(s.runs) })];
  if (finished) parts.push(t('health.success', { pct: percent(s.completed / finished) }));
  if (s.p50_ms != null) parts.push(t('health.median', { time: duration(s.p50_ms) }));
  return parts.join(' · ');
}
