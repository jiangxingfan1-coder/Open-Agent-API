import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import {
  REQUEST_FILTERS,
  formatTime,
  formatWait,
  waitWhen,
  formatWhen,
  runStatusKey,
} from '../lib/format.js';
import { $, agentGlyph, cell, clickableRow, el, empty, status, table } from '../lib/dom.js';
import { agentById, filterText, setCount } from './common.js';
import { showRun } from '../dialogs/runs.js';

// The gateway estimates queue waits as a relative duration; tolerate an absolute timestamp too.
export function queueWait(q) {
  const v = Number(q?.estimated_start_ms);
  if (q?.estimated_start_ms == null || !Number.isFinite(v)) return null;
  return v > 1e12 ? Math.max(0, v - Date.now()) : Math.max(0, v);
}
// A queued task waits for admission; an in-progress one can still have its current step
// waiting in a node queue (node busy, target cooling down). Only the former has a position.
// `brief` is the table version: short enough for one line under the status.
export function queueText(q, status = 'queued', brief = false) {
  if (!q) return '';
  const step = status !== 'queued';
  const parts = [];
  if (!step && q.position != null && Number.isFinite(Number(q.position)))
    parts.push(t('runs.position', { n: q.position }));
  const wait = queueWait(q);
  if (wait == null) {
    if (step) parts.push(t('runs.nextStepQueued'));
  } else if (!step) parts.push(formatWait(wait, brief));
  else if (wait < 1000) parts.push(t('runs.nextStepSoon'));
  else parts.push(t(brief ? 'runs.nextStepBrief' : 'runs.nextStep', { when: waitWhen(wait) }));
  return parts.join(' · ');
}
// Active tasks count up locally between overview revisions (a 304 carries no elapsed_ms).
export const liveElapsed = (r) =>
  Math.max(Number(r.elapsed_ms) || 0, Date.now() - (Number(r.created_at) || Date.now()));
export function runMeta(r) {
  if (r.status === 'queued' && queueText(r.queue)) return queueText(r.queue);
  if (r.status === 'in_progress' && r.queue) return queueText(r.queue, r.status);
  if (r.status === 'in_progress') return t('runs.runningFor', { time: formatTime(liveElapsed(r)) });
  return formatWhen(r.created_at) || formatTime(r.elapsed_ms);
}
// Table version of the queue note: short enough for one line under the status.
export const queueBrief = (q, status) => queueText(q, status, true);
// A task without an input line says so, instead of falling back to its raw ID.
const inputLine = (r) => el('span', r.input || t('runs.noInput'), 'row-sub');
// Elapsed time of a task that has not started is not 0 ms: it has no elapsed time yet.
const elapsedText = (r) =>
  r.status === 'queued'
    ? '—'
    : formatTime(r.status === 'in_progress' ? liveElapsed(r) : r.elapsed_ms);
export function runRow(r) {
  const row = el('button', undefined, 'list-row');
  row.type = 'button';
  row.setAttribute('aria-label', t('runs.open', { id: r.id }));
  row.onclick = () => showRun(r.id);
  const agent = agentById(r.agent);
  const text = el('span');
  const title = el('span', r.agent, 'row-title');
  title.translate = false;
  text.append(title, inputLine(r));
  const end = el('span', undefined, 'row-end');
  end.append(status(runStatusKey(r), true), el('span', runMeta(r), 'muted'));
  row.append(agentGlyph(agent?.engine ?? '', 'small', agent?.preset), text, end);
  return row;
}

export function renderRequests(body) {
  const filter = filterText();
  const all = state.runs || state.data.runs;
  const chips = $('request-chips');
  if (chips)
    for (const b of chips.querySelectorAll('button')) {
      const rule = REQUEST_FILTERS.find(([key]) => key === b.dataset.filter);
      b.classList.toggle('active', state.requestFilter === b.dataset.filter);
      b.querySelector('small').textContent = all.filter((r) => rule[2](r.status, r)).length || '';
    }
  const rule = REQUEST_FILTERS.find(([key]) => key === state.requestFilter) ?? REQUEST_FILTERS[0];
  const rows = all.filter(
    (r) => rule[2](r.status, r) && `${r.id} ${r.agent} ${r.input}`.toLowerCase().includes(filter),
  );
  setCount(t('runs.count', { n: rows.length }));
  const search = $('filter');
  if (search) {
    search.placeholder = t('shell.search.requests');
    search.setAttribute('aria-label', search.placeholder);
  }
  if (!rows.length) {
    body.append(
      all.length
        ? empty(t('runs.noMatch'), t('runs.noMatchHint'), { icon: 'search', compact: true })
        : empty(t('runs.none'), t('runs.noneHint'), { icon: 'activity' }),
    );
    return;
  }
  body.append(
    table(
      [
        { text: t('runs.col.task'), min: 200 },
        { text: t('runs.col.model'), width: 176, truncate: true },
        { text: t('runs.col.status'), width: 148 },
        { text: t('runs.col.duration'), align: 'num', width: 96 },
        { text: t('runs.col.time'), width: 108 },
      ],
      rows.map((r) => {
        const tr = clickableRow(r.id, t('runs.open', { id: r.id }), () => showRun(r.id));
        const title = el('div', undefined, 'cell-title');
        const text = el('div');
        const name = el('span', r.agent, 'row-title');
        name.translate = false;
        text.append(name, inputLine(r));
        title.append(
          agentGlyph(agentById(r.agent)?.engine ?? '', 'small', agentById(r.agent)?.preset),
          text,
        );
        const statusCell = el('div', undefined, 'cell-status');
        statusCell.append(status(runStatusKey(r), true));
        const waiting = ['queued', 'in_progress'].includes(r.status)
          ? queueBrief(r.queue, r.status)
          : '';
        if (waiting) statusCell.append(el('span', waiting, 'cell-hint'));
        tr.append(
          cell(title),
          cell(r.model, 'mono'),
          cell(statusCell),
          cell(elapsedText(r), 'num'),
          cell(formatWhen(r.created_at), 'muted nowrap'),
        );
        return tr;
      }),
    ),
  );
}
