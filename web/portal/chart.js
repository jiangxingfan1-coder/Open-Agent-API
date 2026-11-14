import { t } from './i18n.js';
import { compact, integer, points } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};

const FORMAT = {
  runs: integer,
  tokens: integer,
  spent: points,
};
const AXIS = {
  runs: (n) => compact(n),
  tokens: (n) => compact(n),
  spent: (n) => points(n),
};

// Axis ticks from 0 up to the first "nice" step multiple at or above `max`. Steps are 1, 2 or 5
// times a power of ten; at most four intervals (five ticks). Counts (runs, tokens) are whole
// numbers, so their step never drops below 1 and they always get at least two intervals.
// All zeros: just the baseline, [0].
export function axisTicks(max, whole) {
  if (!(max > 0)) return [0];
  const floor = whole ? 1 : 0;
  let step = 0;
  for (let pow = 10 ** Math.floor(Math.log10(max) - 1); !step; pow *= 10)
    for (const m of [1, 2, 5]) {
      const s = m * pow;
      if (s >= floor && Math.ceil(max / s - 1e-9) <= 4) {
        step = s;
        break;
      }
    }
  const count = Math.max(whole ? 2 : 1, Math.ceil(max / step - 1e-9));
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

// Hairline bar chart, drawn by hand: one thin bar per UTC day, a few grid lines, no legend.
// Sized from the container so the labels stay legible on a phone.
export function drawBars(container, daily, metric, height = 200) {
  const width = Math.max(260, Math.floor(container.clientWidth) || 720);
  const bottom = 24;
  const top = 8;
  const plotH = height - top - bottom;
  const values = daily.map((d) => d[metric] ?? 0);
  const ticks = axisTicks(Math.max(0, ...values), metric !== 'spent');
  const max = ticks[ticks.length - 1] || 1;
  // The left margin follows the widest tick label (a mono figure is about 7px wide).
  const widest = Math.max(...ticks.map((v) => AXIS[metric](v).length));
  const left = Math.max(32, widest * 7 + 14);
  const plotW = width - left - 4;
  const root = svg('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${t(`dash.metric.${metric}`)} · ${t('dash.chart_range', { n: daily.length })}`,
  });
  ticks.forEach((value, i) => {
    const y = top + plotH - (plotH * value) / max;
    root.append(
      svg('line', { x1: left, x2: width, y1: y, y2: y, class: i ? 'grid-line' : 'axis-line' }),
    );
    root.append(
      svg(
        'text',
        { x: left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'tick' },
        AXIS[metric](value),
      ),
    );
  });
  const slot = plotW / Math.max(1, daily.length);
  // Bars take most of their slot (a thin bar in a wide slot reads as a stray line), never more
  // than 22px, and the day labels keep at least 60px between them.
  const barW = Math.max(3, Math.min(22, slot * 0.62));
  const labelEvery = Math.max(1, Math.ceil(60 / slot));
  daily.forEach((d, i) => {
    const x = left + slot * i + slot / 2;
    const v = values[i];
    const h = v > 0 ? Math.min(plotH, Math.max(1.5, (plotH * v) / max)) : 0;
    const hit = svg('rect', {
      x: x - slot / 2,
      y: top,
      width: slot,
      height: plotH,
      class: 'bar-hit',
    });
    hit.append(svg('title', {}, `${d.date} · ${FORMAT[metric](v)} ${t(`dash.unit.${metric}`)}`));
    root.append(hit);
    root.append(
      svg('rect', {
        x: x - barW / 2,
        y: top + plotH - (h || 1),
        width: barW,
        height: h || 1,
        class: h ? 'bar' : 'bar-zero',
      }),
    );
    // Count labels back from the latest day so that day is always named.
    if ((daily.length - 1 - i) % labelEvery === 0)
      root.append(
        svg('text', { x, y: height - 6, 'text-anchor': 'middle', class: 'tick' }, d.date.slice(5)),
      );
  });
  container.replaceChildren(root);
}

// Redraw when the container's width changes (rotation, window resize), not on every callback.
export function chart(container, daily, getMetric) {
  let drawnWidth = 0;
  const draw = () => {
    drawnWidth = container.clientWidth;
    drawBars(container, daily, getMetric());
  };
  draw();
  if (typeof ResizeObserver !== 'function') return { redraw: draw };
  const observer = new ResizeObserver(() => {
    if (!container.isConnected) return observer.disconnect();
    if (container.clientWidth !== drawnWidth) draw();
  });
  observer.observe(container);
  return { redraw: draw };
}
