import { portal } from './api.js';
import { t } from './i18n.js';
import {
  box,
  copyButton,
  el,
  empty,
  icon,
  icons,
  link,
  loading,
  notice,
  pageWrap,
  sectionHead,
} from './dom.js';
import { dateTimeFull, duration, integer, points, priceText, withLabel } from './format.js';
import { isActive, runStatus } from './runs.js';
import { breakdownText, timelineView } from './timeline.js';
import { state } from './state.js';

const POLL_MS = 3000;
const LOST = new Set(['session_invalid', 'account_disabled']);

const back = () => {
  const a = link('#/runs', undefined, 'crumb');
  a.append(icon('arrow-left'), el('span', t('run.back')));
  return a;
};

// A run that is still going refreshes itself: say so, and that it stops on its own.
function liveNote() {
  const note = el('p', undefined, 'live-note');
  note.setAttribute('role', 'status');
  note.append(el('span', undefined, 'live-dot'), el('span', t('run.live', { n: POLL_MS / 1000 })));
  return note;
}

function fact(label, value, sub) {
  const v = el('div', undefined, 'value');
  v.append(value instanceof Node ? value : document.createTextNode(value));
  return box('div', 'fact', el('div', label, 'label'), v, sub ? el('span', sub, 'sub') : null);
}

function facts(run) {
  const active = isActive(run.status);
  // A live run takes its elapsed time from the gateway's own clock (the timeline), not ours.
  const elapsed = run.completed_at
    ? run.completed_at - run.created_at
    : (run.timeline?.total_ms ?? (active ? Math.max(0, Date.now() - run.created_at) : null));
  const usage = run.usage;
  const tokens = usage?.total_tokens;
  const charge = active ? '—' : `${points(run.charge ?? 0)} ${t('unit.points')}`;
  return box(
    'div',
    'run-facts',
    fact(t('run.fact.status'), runStatus(run.status)),
    fact(t('run.fact.started'), dateTimeFull(run.created_at)),
    fact(t('run.fact.ended'), run.completed_at ? dateTimeFull(run.completed_at) : '—'),
    fact(t('run.fact.duration'), duration(elapsed)),
    fact(
      t('run.fact.tokens'),
      tokens || tokens === 0 ? integer(tokens) : '—',
      usage
        ? t('run.tokens_split', {
            input: integer(usage.input_tokens ?? 0),
            output: integer(usage.output_tokens ?? 0),
          })
        : null,
    ),
    fact(
      t('run.fact.charge'),
      charge,
      `${t('run.price_at_start', { price: priceText(run.price) })}${active ? ` · ${t('run.charge_pending')}` : ''}`,
    ),
  );
}

function processSection(run, ui) {
  const tl = run.timeline;
  const note = tl ? breakdownText(tl) : '';
  let body;
  if (!tl) body = empty(null, t('run.process_gone'));
  else if (!tl.spans?.length) body = empty(null, t('run.process_empty'));
  else body = timelineView(tl, ui);
  return box(
    'section',
    '',
    sectionHead(t('run.process'), note ? el('p', note) : null),
    box('div', 'section-body', body),
  );
}

function outputSection(run) {
  const text = run.output_text ?? '';
  const pre = el(
    'pre',
    text || t(isActive(run.status) ? 'run.output_pending' : 'run.output_empty'),
  );
  pre.className = `output${text ? '' : ' is-empty'}`;
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', t('run.output'));
  return box(
    'section',
    '',
    sectionHead(t('run.output'), text ? copyButton(() => text, 'quiet small') : null),
    box('div', 'section-body', box('div', 'output-block', pre)),
  );
}

function build(run, ui) {
  const active = isActive(run.status);
  const id = el('div', undefined, 'agent-id');
  id.append(
    el('span', run.id),
    copyButton(() => run.id, 'quiet small'),
  );
  return [
    box(
      'header',
      'detail-head run-head',
      back(),
      el('h1', run.agent || t('ledger.run_unknown')),
      id,
      active ? liveNote() : null,
    ),
    run.error
      ? notice(
          withLabel(
            t('run.error'),
            `${run.error.message || run.error.code}${run.error.code && run.error.message ? ` (${run.error.code})` : ''}`,
          ),
          'error',
        )
      : null,
    facts(run),
    processSection(run, ui),
    outputSection(run),
  ].filter(Boolean);
}

export async function runDetail(root, ctx) {
  const page = pageWrap(root, loading());
  const id = ctx.param;
  let run;
  try {
    run = await portal.run(id);
  } catch (err) {
    if (err.code !== 'run_not_found') throw err;
    page.replaceChildren(back(), empty(t('run.missing.title'), t('run.missing.text')));
    icons();
    return;
  }
  document.title = `${run.agent || run.id} · ${state.site?.site_name ?? ''}`;
  // The fold state of a long process survives the refreshes below.
  const ui = {
    expanded: false,
    toggle() {
      ui.expanded = !ui.expanded;
      draw();
      page.querySelector('.span.fold button, .fold-actions button')?.focus();
    },
  };
  let drawn = '';
  const draw = () => {
    // Nothing changed since the last refresh: leave the page (and the reader's place) alone.
    const signature = JSON.stringify([run, ui.expanded]);
    if (signature === drawn) return;
    drawn = signature;
    page.replaceChildren(...build(run, ui));
    icons();
  };
  draw();
  if (!isActive(run.status)) return;

  // Refresh every few seconds until the run ends; stop as soon as the page is left.
  let timer = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('hashchange', stop);
  };
  window.addEventListener('hashchange', stop);
  const tick = async () => {
    if (stopped || !page.isConnected) return stop();
    if (!document.hidden) {
      try {
        const fresh = await portal.run(id);
        if (stopped || !page.isConnected) return stop();
        run = fresh;
        draw();
      } catch (err) {
        if (LOST.has(err.code)) return stop();
        // A network blip: try again on the next tick.
      }
    }
    if (!isActive(run.status)) return stop();
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
}
