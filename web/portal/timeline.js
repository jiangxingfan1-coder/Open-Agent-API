import { t } from './i18n.js';
import { box, button, el, icon } from './dom.js';
import { duration, withLabel } from './format.js';

// One row per span of `RunDetail.timeline` (the gateway's run timeline, passed through as is):
// a category (icon + word), a name, a hairline showing where it sits in the run, a status and
// how long it took. No colour blocks: tide for work in progress, garnet for a failure, cinnabar
// only for a wait that needs a person (an approval).
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const KIND_ICON = {
  queue: 'hourglass',
  model: 'cpu',
  tool: 'wrench',
  approval: 'shield-check',
  client_tool: 'plug',
  subagent: 'git-branch',
  interrupted: 'pause',
  native: 'terminal',
};

const known = (key, fallback) => (t(key) === key ? fallback : t(key));
const kindLabel = (kind) => known(`span.kind.${kind}`, kind);

function tone(span) {
  if (span.status === 'failed') return 'error';
  if (span.status === 'running') return 'run';
  if (span.status === 'waiting' && span.kind === 'approval') return 'warn';
  return 'neutral';
}

// { name, sub } for a span; `label` and `ref` are what the gateway recorded.
function describe(span) {
  const label = span.label || '';
  const ref = span.ref ?? {};
  switch (span.kind) {
    case 'model':
      return {
        name: ref.turn ? t('span.turn', { n: ref.turn }) : t('span.model_default'),
        sub: label,
      };
    case 'tool':
      return { name: label || ref.tool || '—' };
    case 'approval':
      return { name: ref.tool || label || t('span.approval_default') };
    case 'queue':
      return { name: known(`span.queue.${label}`, t('span.queue.admission')) };
    case 'interrupted':
      return { name: t('span.interrupted_text') };
    default:
      return { name: label || '—' };
  }
}

// Hairline on a shared axis: where the span starts and how much of the run it covers.
function track(span, total) {
  const start = Math.min(total, Math.max(0, span.start_ms ?? 0));
  const end = span.end_ms == null ? total : Math.min(total, Math.max(start, span.end_ms));
  const x = (start / total) * 100;
  const w = Math.max(1.2, Math.min(100 - x, ((end - start) / total) * 100));
  const node = svg('svg', { class: 'span-track', width: '100%', height: 8, 'aria-hidden': 'true' });
  node.append(
    svg('line', { class: 'track-line', x1: 0, x2: '100%', y1: 4, y2: 4 }),
    svg('rect', { class: 'track-bar', x: `${x}%`, y: 2, width: `${w}%`, height: 4 }),
  );
  return node;
}

function row(span, total) {
  const { name, sub } = describe(span);
  const end = span.end_ms == null ? total : span.end_ms;
  const status = known(`span.status.${span.status}`, span.status);
  const li = el('li', undefined, `span ${tone(span)} k-${span.kind}`);
  const kind = el('span', undefined, 'span-kind');
  kind.append(icon(KIND_ICON[span.kind] ?? 'circle'), el('span', kindLabel(span.kind)));
  const label = el('span', undefined, 'span-name');
  label.append(document.createTextNode(name));
  if (sub) label.append(el('span', sub, 'span-sub'));
  if (span.estimated) label.append(el('span', t('span.estimated'), 'span-sub'));
  li.append(
    el('span', undefined, 'dot'),
    kind,
    label,
    track(span, total),
    el('span', status, `span-status status ${tone(span)}`),
    el('span', duration(end - (span.start_ms ?? 0)), 'span-dur'),
  );
  return li;
}

// The "where did the time go" line: non-zero parts of the gateway's critical-path breakdown.
export function breakdownText(timeline) {
  const b = timeline?.breakdown_ms;
  if (!b) return '';
  const parts = [];
  for (const key of ['queue', 'model', 'tools', 'approval', 'other'])
    if (b[key] > 0) parts.push(`${t(`span.breakdown.${key}`)} ${duration(b[key])}`);
  return parts.length ? withLabel(t('run.breakdown'), parts.join(' · ')) : '';
}

// A long run (more than FOLD_AT spans) shows its first HEAD and last TAIL spans with one row in
// between that opens the rest; the end matters most while it is still running.
const FOLD_AT = 16;
const HEAD = 6;
const TAIL = 8;

function foldRow(hidden, ui) {
  const li = el('li', undefined, 'span fold');
  li.append(
    el('span', undefined, 'dot'),
    button(t('run.process_expand', { n: hidden }), 'quiet small', ui.toggle, 'chevrons-up-down'),
  );
  return li;
}

/** `ui`: { expanded, toggle } keeps the fold state across the page's refreshes. */
export function timelineView(timeline, ui = { expanded: false, toggle() {} }) {
  const spans = [...(timeline.spans ?? [])].sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
  const total = Math.max(
    1,
    Number(timeline.total_ms) || 0,
    ...spans.map((s) => Number(s.end_ms) || Number(s.start_ms) || 0),
  );
  const list = el('ol', undefined, 'timeline');
  list.setAttribute('aria-label', t('run.process'));
  const rows = spans.map((s) => row(s, total));
  const folded = spans.length > FOLD_AT && !ui.expanded;
  if (folded)
    list.append(
      ...rows.slice(0, HEAD),
      foldRow(spans.length - HEAD - TAIL, ui),
      ...rows.slice(-TAIL),
    );
  else list.append(...rows);
  return box(
    'div',
    '',
    list,
    spans.length > FOLD_AT && ui.expanded
      ? box(
          'div',
          'actions fold-actions',
          button(t('run.process_collapse'), 'quiet small', ui.toggle, 'chevrons-down-up'),
        )
      : null,
    timeline.truncated
      ? el('p', t('run.process_truncated', { n: spans.length }), 'muted note')
      : null,
  );
}
