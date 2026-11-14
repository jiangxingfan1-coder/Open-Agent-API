import { hasFeature } from '../lib/state.js';
import { formatWait } from '../lib/format.js';
import { el, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

// Task details: timeline and queue note (created by run-inspector.js; dependencies come in as arguments).
export function createTimeline({ $, formatDuration, breakdown, read, base, terminal }) {
  // Timeline: spans derived by the gateway from the durable event journal (run-timeline-v1).
  let timelineSupported = null;
  const SPAN_KIND = {
    queue: t('insp.span.queue'),
    model: t('insp.span.model'),
    tool: t('insp.span.tool'),
    approval: t('insp.span.approval'),
    client_tool: t('insp.span.client_tool'),
    subagent: t('insp.span.subagent'),
    interrupted: t('insp.span.interrupted'),
    native: t('insp.span.native'),
  };
  const SPAN_STATUS = {
    completed: t('insp.span_status.completed'),
    failed: t('insp.span_status.failed'),
    cached: t('insp.span_status.cached'),
    running: t('insp.span_status.running'),
    waiting: t('insp.span_status.waiting'),
    uncertain: t('insp.span_status.uncertain'),
    cancelled: t('insp.span_status.cancelled'),
  };
  const QUEUE_REASON = {
    admission: t('insp.queue_reason.admission'),
    fairness: t('insp.queue_reason.fairness'),
    agent_fallback: t('insp.queue_reason.agent_fallback'),
    approval: t('insp.queue_reason.approval'),
    node_busy: t('insp.queue_reason.node_busy'),
    cooling_down: t('insp.queue_reason.cooling_down'),
    unknown: t('insp.queue_reason.unknown'),
  };
  // Queue spans say why they waited: admission, a fairness yield, re-queue after approval,
  // or a dispatched step waiting for its node.
  const QUEUE_SPAN = {
    admission: t('insp.queue_span.admission'),
    fairness: t('insp.queue_span.fairness'),
    approval: t('insp.queue_span.approval'),
    agent_fallback: t('insp.queue_span.agent_fallback'),
    node: t('insp.queue_span.node'),
  };
  // Caller-tool spans reuse the tool span style.
  const SPAN_CLASS = { client_tool: 'tool client_tool' };
  const spanName = (s) => {
    if (s.kind === 'model')
      return s.ref?.turn ? t('insp.span_name.model_turn', { n: s.ref.turn }) : t('insp.span.model');
    if (s.kind === 'tool') return s.label || s.ref?.tool || t('insp.span.tool');
    if (s.kind === 'approval') {
      const subject = s.ref?.tool ?? s.label;
      return subject ? t('insp.span_name.approval', { subject }) : t('insp.span.approval');
    }
    if (s.kind === 'client_tool')
      return s.label
        ? t('insp.span_name.client_tool', { label: s.label })
        : t('insp.span.client_tool');
    if (s.kind === 'subagent')
      return s.label ? t('insp.span_name.subagent', { label: s.label }) : t('insp.span.subagent');
    if (s.kind === 'queue') return QUEUE_SPAN[s.label] ?? t('insp.span.queue');
    return SPAN_KIND[s.kind] ?? s.label ?? s.kind;
  };
  // Opens a sub-agent's own request; set once the inspector's public API exists.
  let openChild = null;
  const tickLabel = (ms) => (ms <= 0 ? '0' : formatDuration(ms));
  // Human steps (seconds, minutes, hours) so axis labels land on round clock values.
  const STEPS = [
    10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5,
    72e5, 108e5, 216e5, 432e5, 864e5,
  ];
  function niceTicks(max) {
    if (!(max > 0)) return [0];
    const step = STEPS.find((s) => s >= max / 5) ?? Math.ceil(max / 5 / 864e5) * 864e5;
    const out = [];
    for (let ms = 0; ms <= max * 1.0001; ms += step) out.push(ms);
    return out;
  }
  // One wait (an approval or a queue) can dwarf seconds of real work. Fold it to a fixed
  // share of the axis, mark the break, and keep everything else linear and legible.
  function timeScale(spans, total) {
    const waits = spans
      .filter((s) => ['approval', 'client_tool', 'queue', 'interrupted'].includes(s.kind))
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    const longest = waits[0];
    const span = longest ? longest.end - longest.start : 0;
    if (!longest || span < 0.7 * total || span < 8 * (total - span) || total - span <= 0) {
      const ticks = niceTicks(total).map((ms) => ({ x: ms / total, label: tickLabel(ms) }));
      return { x: (ms) => ms / total, ticks, gap: null };
    }
    const share = 0.22;
    const k = (1 - share) / (total - span);
    const x = (ms) =>
      ms <= longest.start
        ? ms * k
        : ms >= longest.end
          ? longest.start * k + share + (ms - longest.end) * k
          : longest.start * k + ((ms - longest.start) / span) * share;
    const before = longest.start > 0 ? niceTicks(longest.start) : [0];
    const ticks = before
      .filter((ms) => x(ms) < x(longest.start) - 0.06 || ms === 0)
      .map((ms) => ({ x: x(ms), label: tickLabel(ms) }));
    ticks.push({ x: x(longest.start), label: tickLabel(longest.start) });
    ticks.push({ x: x(longest.end), label: tickLabel(longest.end), cut: true });
    if (longest.end < total) ticks.push({ x: 1, label: tickLabel(total) });
    return { x, ticks, gap: { x0: x(longest.start), x1: x(longest.end), ms: span } };
  }
  async function readTimeline(v) {
    if (timelineSupported === false || hasFeature('run-timeline-v1') === false) return null;
    try {
      const data = await read(v, `${base(v)}/timeline`);
      if (data) timelineSupported = true;
      return data;
    } catch (error) {
      // An older gateway has no such route; the rest of the inspector keeps working.
      if ([404, 405, 501].includes(error.status)) {
        timelineSupported = false;
        return null;
      }
      if ([401, 403].includes(error.status) && error.code !== 'scope_denied') throw error;
      return null;
    }
  }
  function renderQueue(data) {
    const note = $('run-queue');
    // Queued runs wait for admission; an in-progress run can have its current step queued on a node.
    const q = data.queue && !terminal(data.status) ? data.queue : null;
    note.hidden = !q;
    if (!q) return;
    const step = data.status !== 'queued';
    const parts = step ? [t('insp.queue.step_in_queue')] : [];
    if (!step && q.position != null) parts.push(t('insp.queue.position', { n: q.position }));
    const raw = Number(q.estimated_start_ms);
    if (q.estimated_start_ms != null && Number.isFinite(raw)) {
      const wait = raw > 1e12 ? Math.max(0, raw - Date.now()) : Math.max(0, raw);
      parts.push(
        wait < 1000 ? t('insp.queue.soon') : t('insp.queue.eta', { wait: formatWait(wait) }),
      );
    }
    if (q.reason) parts.push(QUEUE_REASON[q.reason] ?? q.reason);
    note.replaceChildren(
      icon('hourglass'),
      el('span', parts.join(' · ') || t('insp.queue.queued')),
    );
  }
  function renderTimeline(data) {
    const section = $('timeline-section');
    const box = $('run-timeline');
    if (!data || !Array.isArray(data.spans) || !data.spans.length) {
      section.hidden = true;
      box.replaceChildren();
      return;
    }
    section.hidden = false;
    const total = Math.max(1, Number(data.total_ms) || 0);
    const spans = data.spans.map((s) => {
      const start = Math.max(0, Math.min(total, Number(s.start_ms) || 0));
      const end = s.end_ms == null ? total : Math.max(start, Math.min(total, Number(s.end_ms)));
      return { ...s, start, end, lane: Number(s.lane) || 0 };
    });
    const scale = timeScale(spans, total);
    const lanes = Math.max(...spans.map((s) => s.lane)) + 1;
    const chart = el('div', undefined, 'tl-chart');
    const names = el('div', undefined, 'tl-lanes');
    const plot = el('div', undefined, 'tl-plot');
    const tracks = el('div', undefined, 'tl-tracks');
    if (scale.gap) {
      const band = el('div', undefined, 'tl-break');
      band.style.left = `${scale.gap.x0 * 100}%`;
      band.style.width = `${(scale.gap.x1 - scale.gap.x0) * 100}%`;
      band.title = t('insp.tl.break_title', { d: formatDuration(scale.gap.ms) });
      tracks.append(band);
    }
    for (let lane = 0; lane < lanes; lane++) {
      names.append(el('span', lane === 0 ? t('insp.tl.main') : t('insp.tl.parallel', { n: lane })));
      const track = el('div', undefined, 'tl-track');
      for (const s of spans.filter((x) => x.lane === lane)) {
        const x0 = scale.x(s.start);
        const x1 = scale.x(s.end);
        const open = s.end_ms == null;
        const bar = el(
          'span',
          undefined,
          `tl-span ${SPAN_CLASS[s.kind] ?? s.kind} ${s.status ?? ''}${s.critical ? ' critical' : ''}${open ? ' open' : ''}${
            s.estimated ? ' estimated' : ''
          }`,
        );
        bar.style.left = `${x0 * 100}%`;
        bar.style.width = `max(3px, ${(x1 - x0) * 100}%)`;
        const name = spanName(s);
        const child = typeof s.ref?.child_run_id === 'string' ? s.ref.child_run_id : null;
        const facts = [
          name,
          `${formatDuration(s.end - s.start)}${open ? t('insp.tl.in_progress') : ''}`,
          SPAN_STATUS[s.status] ?? s.status,
          s.kind === 'model' && s.label ? t('insp.tl.route', { label: s.label }) : '',
          s.ref?.attempt > 1 ? t('insp.tl.attempt', { n: s.ref.attempt }) : '',
          s.critical ? t('insp.tl.critical') : '',
          s.estimated ? t('insp.tl.estimated') : '',
          child ? t('insp.tl.open_child') : '',
        ].filter(Boolean);
        bar.title = facts.join(' · ');
        bar.setAttribute('aria-label', facts.join(t('insp.tl.sep')));
        if (x1 - x0 > 0.1) bar.append(el('span', name, 'tl-label'));
        if (child && openChild) {
          bar.classList.add('link');
          bar.setAttribute('role', 'button');
          bar.tabIndex = 0;
          const go = () => void openChild(child);
          bar.onclick = go;
          bar.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              go();
            }
          };
        }
        track.append(bar);
      }
      tracks.append(track);
    }
    const axis = el('div', undefined, 'tl-axis');
    // Labels that would touch their neighbour are left out; the break marks and the end stay.
    const shown = [];
    for (const tick of [...scale.ticks].sort((x, y) => x.x - y.x)) {
      const last = shown[shown.length - 1];
      if (!last || tick.x - last.x >= 0.1) shown.push(tick);
      else if (last.x > 0) shown[shown.length - 1] = tick;
    }
    for (const tick of shown) {
      const mark = el(
        'span',
        tick.label,
        `tl-tick${tick.cut ? ' cut' : ''}${tick.x > 0.92 ? ' end' : ''}`,
      );
      mark.style.left = `${tick.x * 100}%`;
      axis.append(mark);
    }
    plot.append(tracks, axis);
    chart.append(names, plot);
    chart.setAttribute('role', 'group');
    chart.setAttribute('aria-label', t('insp.tl.aria', { n: spans.length }));
    box.replaceChildren(chart);
    const legend = el('div', undefined, 'tl-legend');
    for (const kind of [
      'queue',
      'model',
      'tool',
      'approval',
      'client_tool',
      'subagent',
      'native',
      'interrupted',
    ]) {
      if (!spans.some((s) => s.kind === kind)) continue;
      const item = el('span', undefined, 'legend-item');
      item.append(
        el('i', undefined, `swatch tl-${kind === 'client_tool' ? 'tool' : kind}`),
        el('span', SPAN_KIND[kind]),
      );
      legend.append(item);
    }
    const critical = el('span', undefined, 'legend-item');
    critical.append(
      el('i', undefined, 'swatch tl-critical'),
      el('span', t('insp.tl.legend_critical')),
    );
    legend.append(critical);
    box.append(legend);
    const split = breakdown(data.breakdown_ms, {
      caption:
        data.critical_path_ms != null
          ? t('insp.tl.caption', { d: formatDuration(data.critical_path_ms) })
          : '',
    });
    if (split) box.append(split);
    $('timeline-summary').textContent = `${t(
      spans.length === 1 ? 'insp.tl.summary_one' : 'insp.tl.summary',
      { d: formatDuration(total), n: spans.length },
    )}${spans.some((s) => s.estimated) ? t('insp.tl.estimates') : ''}${
      data.truncated ? t('insp.tl.truncated') : ''
    }`;
  }
  return {
    readTimeline,
    renderQueue,
    renderTimeline,
    setOpenChild: (open) => (openChild = open),
  };
}
