import { isAdmin, isNodeAdmin, prefs, savePrefs, state } from '../lib/state.js';
import { lang, locale, t } from '../lib/i18n.js';
import {
  awaitingCaller,
  duration,
  engineName,
  formatWhen,
  num,
  percent,
  ratio,
  compactTokens,
} from '../lib/format.js';
import {
  SVG_NS,
  agentGlyph,
  brandMark,
  button,
  cell,
  copyText,
  el,
  empty,
  icon,
  iconButton,
  panel,
  status,
} from '../lib/dom.js';
import { activityAvailable, activityData, activityWindow, queueLoad } from '../lib/live.js';
import { agentById, agentHealth, breakdownBlock } from './common.js';
import { showRun } from '../dialogs/runs.js';
import { openKeyDialog } from '../dialogs/key.js';
import { openPublish } from '../dialogs/publish.js';
import { showAgent } from '../dialogs/agent.js';
import { segmented } from './settings.js';
import { runRow } from './runs.js';

const SLOGAN_EN = 'Publish once, invoke anywhere';
export function heroCard(connected) {
  const hero = el('section', undefined, 'card hero');
  const brand = el('div', undefined, 'hero-brand');
  const words = el('div');
  const word = el('div', 'Open Agent API', 'hero-word');
  word.translate = false;
  const slogan = el('div', undefined, 'hero-slogan');
  // The Chinese tagline stands next to the English one; the English console shows it once.
  const tagline = t('overview.slogan');
  const en = el('span', lang === 'zh' ? SLOGAN_EN : tagline, 'subtle-sub');
  en.lang = 'en';
  if (lang === 'zh') slogan.append(el('span', tagline, 'zh'));
  slogan.append(en);
  words.append(word, slogan);
  brand.append(brandMark(), words);
  hero.append(brand);
  if (connected) {
    const actions = el('div', undefined, 'hero-actions');
    const p = state.data.principal;
    const who = el('span', undefined, 'muted');
    who.append(el('span', `${p.name} · `), el('code', p.scopes.join(' / ')));
    actions.append(who);
    hero.append(actions);
  }
  return hero;
}
/* ── Overview: operations cockpit ────────────────────── */
export const WINDOW_LABEL = { '24h': t('window.24h'), '7d': t('window.7d') };
// Stack order is bottom to top.
export const PULSE_SERIES = [
  ['completed', t('pulse.completed'), 'ok'],
  ['active', t('pulse.active'), 'live'],
  ['cancelled', t('pulse.cancelled'), 'muted'],
  ['interrupted', t('pulse.interrupted'), 'warn'],
  ['failed', t('pulse.failed'), 'fail'],
];
export const compact = compactTokens;
export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
export function sparkline(values) {
  const w = 100;
  const h = 28;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const line = values
    .map((v, i) => {
      const y = h - 1.5 - (Math.max(0, v) / max) * (h - 5);
      return `${i ? 'L' : 'M'}${(i * step).toFixed(2)} ${y.toFixed(2)}`;
    })
    .join('');
  const svg = svgEl('svg', {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'none',
    class: 'spark',
    'aria-hidden': 'true',
  });
  svg.append(
    svgEl('path', { d: `${line}L${w} ${h}L0 ${h}Z`, class: 'spark-area' }),
    svgEl('path', { d: line, class: 'spark-line' }),
  );
  return svg;
}
// `label` holds only the name, `hint` only a short word such as "24 hours" or "Live"; a longer
// explanation goes into `explain` (visible on hover).
export function kpi({ label, hint, explain, value, note, noteTitle, extra, tone }) {
  const cell = el('div', undefined, `kpi${tone ? ` ${tone}` : ''}`);
  const head = el('div', undefined, 'kpi-label');
  head.append(el('span', label, 'kpi-name'));
  if (hint) head.append(el('span', hint, 'kpi-hint'));
  if (explain) head.title = explain;
  const noteEl = el('div', undefined, 'kpi-note');
  if (note instanceof Node) noteEl.append(note);
  else noteEl.textContent = note || '';
  // The note takes two lines at most; when it is cut off, the full text is in the tooltip.
  const full = noteTitle ?? noteEl.textContent;
  if (full) noteEl.title = full;
  cell.append(head, el('div', value, 'kpi-value'), noteEl);
  if (extra) cell.append(extra);
  return cell;
}
export function activeNote(m) {
  const note = el('span');
  if (!m.active) {
    note.textContent = t('overview.noActive');
    return note;
  }
  const parts = [
    ['queued', t('overview.activeQueued')],
    ['in_progress', t('overview.activeRunning')],
    ['requires_action', t('overview.activeApproval')],
  ]
    .filter(([key]) => Number(m[key]) > 0)
    .map(([key, label]) => `${label} ${num(m[key])}`);
  // Older gateways have no awaiting_caller field; nothing is shown then.
  if (Number(m.awaiting_caller) > 0)
    parts.push(t('overview.activeCaller', { n: num(m.awaiting_caller) }));
  note.append(el('span', '● ', 'live'), el('span', parts.join(' · ') || t('overview.activeMixed')));
  return note;
}
export function kpiBand() {
  const d = state.data;
  const m = d.metrics;
  const a = activityData();
  const band = el('section', undefined, 'card kpi-band');
  band.setAttribute('aria-label', t('overview.kpiLabel'));
  if (a) {
    const totals = a.totals ?? {};
    const buckets = a.buckets ?? [];
    const rate = ratio(totals.success_rate);
    const meter = el('div', undefined, 'kpi-meter');
    const fill = el('span');
    fill.style.width = `${rate == null ? 0 : Math.round(rate * 100)}%`;
    meter.append(fill);
    band.append(
      kpi({
        label: t('overview.kpiTasks'),
        hint: WINDOW_LABEL[a.window] ?? WINDOW_LABEL[activityWindow()],
        value: num(totals.started),
        note: t('overview.kpiTasksNote', {
          done: num(totals.completed),
          failed: num(totals.failed),
        }),
        extra:
          buckets.length > 1 && Number(totals.started) > 0
            ? sparkline(buckets.map((b) => Number(b.started) || 0))
            : null,
      }),
      kpi({
        label: t('overview.kpiSuccess'),
        value: percent(totals.success_rate),
        note: Number(totals.cancelled)
          ? t('overview.kpiCancelled', { n: num(totals.cancelled) })
          : t('overview.kpiFinished'),
        extra: rate == null ? null : meter,
        tone: rate != null && rate < 0.9 ? 'attention' : '',
      }),
      kpi({
        label: t('overview.kpiMedian'),
        explain: t('overview.kpiMedianExplain'),
        value: a.latency_ms?.samples ? duration(a.latency_ms.p50) : '—',
        note: a.latency_ms?.samples
          ? t('overview.kpiP95', { p95: duration(a.latency_ms.p95), n: num(a.latency_ms.samples) })
          : t('overview.kpiNoFinished'),
        noteTitle: a.latency_ms?.samples
          ? t('overview.kpiP95Title', {
              p95: duration(a.latency_ms.p95),
              n: num(a.latency_ms.samples),
            })
          : undefined,
      }),
      kpi({
        label: t('overview.kpiActive'),
        hint: t('overview.kpiLive'),
        value: num(m.active),
        note: activeNote(m),
      }),
    );
    return band;
  }
  const ready = d.agents.filter((x) => x.ready).length;
  band.append(
    kpi({
      label: t('overview.kpiAgents'),
      value: num(d.agents.length),
      note: d.agents.length ? t('overview.kpiReady', { n: ready }) : t('overview.kpiNoneYet'),
    }),
    kpi({
      label: t('overview.kpiActive'),
      hint: t('overview.kpiLive'),
      value: num(m.active),
      note: activeNote(m),
    }),
    kpi({
      label: t('overview.kpiNodes'),
      value: isNodeAdmin() ? num(d.nodes.length) : '—',
      note: isNodeAdmin()
        ? t('overview.kpiAccepting', { n: d.nodes.filter((n) => n.accepting).length })
        : t('overview.kpiNodesAdmin'),
    }),
    kpi({
      label: t('overview.kpiTotal'),
      value: num(m.runs),
      note: m.total_tokens
        ? t('overview.kpiTotalTokens', { done: num(m.completed), tokens: compact(m.total_tokens) })
        : t('overview.kpiTotalDone', { done: num(m.completed) }),
    }),
  );
  return band;
}
export function bucketLabel(iso, range) {
  const when = new Date(iso);
  return range === '7d'
    ? when.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' })
    : when.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function bucketTitle(b, range, bucketMs) {
  const start = new Date(b.start);
  const end = new Date(start.getTime() + (Number(bucketMs) || (range === '7d' ? 6 : 1) * 3600000));
  const at = (when) =>
    when.toLocaleString(locale(), {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const counts = PULSE_SERIES.filter(([key]) => Number(b[key]) > 0).map(
    ([key, label]) => `${label} ${num(b[key])}`,
  );
  return `${at(start)} – ${at(end)}\n${counts.join(' · ') || t('overview.noTasks')}`;
}
export function pulseCard() {
  if (!activityAvailable()) return null;
  const a = activityData();
  const { box, body } = panel(t('overview.recentActivity'));
  box.classList.add('pulse-card');
  box.querySelector('.panel-head').append(
    segmented(
      [
        ['24h', t('window.24h')],
        ['7d', t('window.7d')],
      ],
      activityWindow(),
      (value) => {
        if (value === activityWindow()) return;
        savePrefs({ activityWindow: value });
        queueLoad();
      },
      t('overview.statsWindow'),
    ),
  );
  if (!a) {
    body.append(el('div', t('overview.summarizing'), 'pulse-loading'));
    return box;
  }
  const range = a.window ?? activityWindow();
  const buckets = a.buckets ?? [];
  const heights = buckets.map((b) =>
    Math.max(
      Number(b.started) || 0,
      PULSE_SERIES.reduce((sum, [key]) => sum + (Number(b[key]) || 0), 0),
    ),
  );
  const peak = Math.max(0, ...heights);
  const chart = el('div', undefined, 'pulse');
  chart.setAttribute('role', 'img');
  chart.setAttribute(
    'aria-label',
    t('overview.chartLabel', {
      window: WINDOW_LABEL[range],
      n: num(a.totals?.started),
      peak: num(peak),
    }),
  );
  const cols = el('div', undefined, 'pulse-cols');
  buckets.forEach((b, i) => {
    const col = el('div', undefined, 'pulse-col');
    col.setAttribute('tabindex', '0');
    col.setAttribute('role', 'img');
    const start = new Date(b.start);
    const end = new Date(
      start.getTime() + (Number(a.bucket_ms) || (range === '7d' ? 6 : 1) * 3600000),
    );
    const pad = (n) => String(n).padStart(2, '0');
    const timeLabel =
      range === '24h'
        ? `${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}`
        : `${start.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' })} ${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}`;
    const counts = [];
    if (Number(b.completed) > 0) counts.push(t('overview.countDone', { n: num(b.completed) }));
    if (Number(b.failed) > 0) counts.push(t('overview.countFailed', { n: num(b.failed) }));
    for (const [key, label] of PULSE_SERIES) {
      if (key !== 'completed' && key !== 'failed' && Number(b[key]) > 0) {
        counts.push(t('overview.countOther', { label, n: num(b[key]) }));
      }
    }
    col.setAttribute(
      'aria-label',
      `${timeLabel}${t('common.comma')}${counts.length ? counts.join(t('common.comma')) : t('overview.noTasks')}`,
    );
    col.title = bucketTitle(b, range, a.bucket_ms);
    const stack = el('div', undefined, 'pulse-stack');
    stack.style.height = peak ? `${(heights[i] / peak) * 100}%` : '0%';
    let known = 0;
    for (const [key, , tone] of PULSE_SERIES) {
      const value = Number(b[key]) || 0;
      known += value;
      if (!value) continue;
      const seg = el('span', undefined, `seg ${tone}`);
      seg.style.flexGrow = String(value);
      stack.append(seg);
    }
    if (heights[i] > known) {
      const seg = el('span', undefined, 'seg muted');
      seg.style.flexGrow = String(heights[i] - known);
      stack.append(seg);
    }
    col.append(stack);
    cols.append(col);
  });
  const axis = el('div', undefined, 'pulse-axis');
  const every = range === '7d' ? 4 : 6;
  buckets.forEach((b, i) =>
    axis.append(el('span', i % every === 0 ? bucketLabel(b.start, range) : '')),
  );
  chart.append(cols, axis);
  if (peak) chart.append(el('span', t('overview.peak', { n: num(peak) }), 'pulse-peak'));
  else {
    // No task in the window: the chart keeps only its scale frame with one centred sentence, and
    // draws no legend or time breakdown.
    chart.classList.add('is-empty');
    const overlay = el('div', undefined, 'pulse-empty');
    overlay.append(
      el('strong', t('overview.noneInWindow', { window: WINDOW_LABEL[range] })),
      el('span', t('overview.noneInWindowHint')),
    );
    chart.append(overlay);
  }
  body.append(chart);
  if (!peak) return box;
  const legend = el('div', undefined, 'pulse-legend');
  for (const [key, label, tone] of PULSE_SERIES) {
    const total = Number(a.totals?.[key]) || 0;
    if (!total && key !== 'completed') continue;
    const item = el('span', undefined, 'legend-item');
    item.append(el('i', undefined, `swatch ${tone}`), el('span', label), el('strong', num(total)));
    legend.append(item);
  }
  body.append(legend);
  const split = breakdownBlock(a.breakdown_ms);
  if (split) body.append(split);
  return box;
}
// Approvals and interrupted work surface first: they are the only things waiting on a person.
export function attentionCard() {
  const d = state.data;
  // A task that only waits for the caller to send tool results needs no person
  // (metrics.requires_action no longer counts it either).
  const waiting = d.runs.filter((r) => r.status === 'requires_action' && !awaitingCaller(r));
  const stalled = d.runs.filter((r) => ['interrupted', 'incomplete'].includes(r.status));
  const pending = Number.isFinite(d.metrics.requires_action)
    ? d.metrics.requires_action
    : waiting.length;
  if (!pending && !stalled.length) return null;
  const card = el('section', undefined, 'attention');
  const head = el('div', undefined, 'attention-head');
  const title = el('div', undefined, 'attention-title');
  title.append(
    icon('hand'),
    el(
      'strong',
      pending
        ? t('overview.attentionApproval', { n: num(pending) })
        : t('overview.attentionInterrupted', { n: num(stalled.length) }),
    ),
  );
  if (pending && stalled.length)
    title.append(el('span', t('overview.attentionMore', { n: num(stalled.length) }), 'muted'));
  const all = el('a', undefined, 'link');
  all.append(el('span', t('overview.viewOnTasks')), icon('arrow-right'));
  all.href = '#requests';
  all.onclick = () => (state.requestFilter = 'attention');
  head.append(title, all);
  const list = el('div', undefined, 'attention-list');
  for (const r of [...waiting, ...stalled].slice(0, 3)) {
    const row = el('button', undefined, 'attention-row');
    row.type = 'button';
    row.setAttribute('aria-label', t('runs.open', { id: r.id }));
    row.onclick = () => showRun(r.id);
    const agent = agentById(r.agent);
    const text = el('span', undefined, 'attention-text');
    const name = el('span', r.agent, 'row-title');
    name.translate = false;
    text.append(name, el('span', r.input || t('runs.noInput'), 'row-sub'));
    const meta = el('span', undefined, 'attention-meta');
    meta.append(status(r.status), el('span', formatWhen(r.created_at), 'muted'));
    const go = el('span', undefined, 'attention-go');
    go.append(
      el('span', r.status === 'requires_action' ? t('overview.review') : t('overview.view')),
      icon('arrow-right'),
    );
    row.append(agentGlyph(agent?.engine ?? '', 'small', agent?.preset), text, meta, go);
    list.append(row);
  }
  card.append(head, list);
  return card;
}
// First-run guide built from real workspace state; it disappears once everything is done.
export function checklistCard() {
  const d = state.data;
  const admin = isAdmin();
  const steps = [
    isNodeAdmin() && {
      title: t('overview.stepEnableTitle'),
      text: t('overview.stepEnableText'),
      // The offline sample agent (oaa quickstart / desktop first launch) already counts as callable.
      done:
        d.nodes.some((n) => (n.natives ?? []).length > 0) ||
        d.agents.some((a) => a.id === 'agent/sample'),
      action: [t('overview.stepEnableAction'), () => (location.hash = 'nodes')],
    },
    {
      title: t('overview.stepPublishTitle'),
      text: t('overview.stepPublishText'),
      done: d.agents.length > 0,
      action: admin ? [t('common.publishAgent'), openPublish] : null,
    },
    admin && {
      title: t('overview.stepKeyTitle'),
      text: t('overview.stepKeyText'),
      done: (state.keys ?? []).some((k) => k.managed && !k.revoked),
      action: [t('common.generateKey'), () => openKeyDialog()],
    },
    {
      title: t('overview.stepCallTitle'),
      text: t('overview.stepCallText'),
      done: d.metrics.runs > 0,
      action: [t('overview.stepCallAction'), () => (location.hash = 'access')],
    },
  ].filter(Boolean);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const card = el('section', undefined, 'card checklist');
  const head = el('div', undefined, 'checklist-head');
  const title = el('div');
  title.append(
    el('h2', t('overview.guideTitle')),
    el('p', t('overview.guideProgress', { done, total: steps.length })),
  );
  head.append(
    title,
    button(t('overview.guideHide'), 'x', () => savePrefs({ checklist: 'hidden' }), 'chip'),
  );
  const bar = el('div', undefined, 'progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(steps.length));
  bar.setAttribute('aria-valuenow', String(done));
  bar.setAttribute('aria-label', t('overview.guideLabel'));
  const fill = el('span');
  fill.style.width = `${(done / steps.length) * 100}%`;
  bar.append(fill);
  // The steps are rows of one table separated by hairlines, not separate bordered cards.
  const list = el('ol', undefined, 'check-steps');
  for (const step of steps) {
    const item = el('li', undefined, `check-step${step.done ? ' done' : ''}`);
    const mark = icon(step.done ? 'circle-check' : 'circle-dashed');
    const copy = el('div', undefined, 'check-copy');
    copy.append(el('strong', step.title), el('p', step.text));
    item.append(mark, copy);
    if (!step.done && step.action)
      item.append(button(step.action[0], null, step.action[1], 'subtle'));
    list.append(item);
  }
  card.append(head, bar, list);
  return card;
}
export function renderOverview(body) {
  const d = state.data;
  const agents = d.agents;
  // All layout rules hang off .overview and use the container width (not the window width) to
  // decide how the two columns fold.
  const root = el('div', undefined, 'overview');
  body.append(root);
  const guide = prefs.checklist === 'hidden' ? null : checklistCard();
  if (guide) root.append(guide);
  const attention = attentionCard();
  if (attention) root.append(attention);
  root.append(kpiBand());
  const grid = el('div', undefined, 'overview-grid');
  const main = el('div', undefined, 'overview-main');
  const pulse = pulseCard();
  if (pulse) main.append(pulse);
  const recent = panel(t('overview.recentTasks'), {
    label: t('overview.viewAll'),
    href: '#requests',
  });
  if (d.runs.length) d.runs.slice(0, pulse ? 6 : 8).forEach((r) => recent.body.append(runRow(r)));
  else recent.body.append(empty(t('runs.none'), t('overview.noTasksHint'), { compact: true }));
  main.append(recent.box);
  const side = el('div', undefined, 'overview-side');
  const agentPanel = panel(t('view.agents.title'), {
    label: t('common.allAgents'),
    href: '#agents',
  });
  if (agents.length)
    agents.slice(0, 6).forEach((a) => {
      const row = el('button', undefined, 'list-row');
      row.type = 'button';
      row.onclick = () => showAgent(a);
      const text = el('span');
      const title = el('span', a.id, 'row-title');
      title.translate = false;
      title.title = a.id;
      text.append(title, el('span', agentHealth(a.id) || engineName(a.engine), 'row-sub'));
      const end = el('span', undefined, 'row-end');
      end.append(status(a.status ?? (a.ready ? 'ready' : 'unavailable')));
      row.append(agentGlyph(a.engine, 'small', a.preset), text, end);
      agentPanel.body.append(row);
    });
  else
    agentPanel.body.append(
      empty(t('agents.none'), t('agents.noneHint'), {
        compact: true,
        icon: 'bot',
      }),
    );
  side.append(agentPanel.box);
  if (isNodeAdmin() && d.nodes.length) {
    const nodesPanel = panel(t('overview.capacity'), {
      label: t('overview.manageNodes'),
      href: '#nodes',
    });
    for (const n of d.nodes) {
      const row = el('div', undefined, 'capacity');
      const head = el('div', undefined, 'capacity-head');
      const name = el('span', n.nodeId, 'capacity-name');
      name.translate = false;
      name.title = n.nodeId;
      head.append(name, el('strong', `${n.active} / ${n.concurrency}`));
      const bar = el('div', undefined, 'bar');
      const fill = el('span');
      fill.style.width = `${Math.min(100, (n.active / Math.max(1, n.concurrency)) * 100)}%`;
      bar.append(fill);
      row.append(head, bar);
      nodesPanel.body.append(row);
    }
    side.append(nodesPanel.box);
  }
  const quick = panel(t('overview.quickConnect'), {
    label: t('overview.allEndpoints'),
    href: '#access',
  });
  const mini = el('div', undefined, 'endpoint-mini');
  const url = d.endpoints?.openai_sdk_base_url ?? `${location.origin}/v1`;
  const code = el('code', url);
  code.title = url;
  mini.append(
    code,
    iconButton(t('common.copyBaseUrl'), 'copy', () => copyText(url, t('common.baseUrlCopied'))),
  );
  quick.body.append(mini, el('p', t('overview.quickNote'), 'side-note'));
  // The primary action of this screen is "Publish agent" in the page header; this is only an
  // entry point, so a secondary button.
  if (isAdmin()) {
    const cta = button(t('common.createKey'), 'key-round', () => openKeyDialog(), 'subtle');
    cta.classList.add('block-btn');
    quick.body.append(cta);
  }
  side.append(quick.box);
  grid.append(main, side);
  root.append(grid);
}
