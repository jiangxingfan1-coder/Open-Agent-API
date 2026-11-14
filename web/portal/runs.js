import { portal } from './api.js';
import { errorMessage, t } from './i18n.js';
import {
  box,
  button,
  el,
  empty,
  icons,
  link,
  loading,
  notice,
  pageWrap,
  selectField,
} from './dom.js';
import { dateTimeFull, integer, points, when } from './format.js';
import { stackedTable } from './stack.js';

const PAGE_SIZE = 20;

export const runHref = (id) => `#/run/${encodeURIComponent(id)}`;

// Run states: tide while working, cinnabar only when a person has to act, quiet otherwise.
const TONE = {
  in_progress: 'run',
  queued: 'run',
  requires_action: 'warn',
  completed: 'good',
  failed: 'error',
  cancelled: 'neutral',
  interrupted: 'neutral',
  incomplete: 'neutral',
};
export const isActive = (status) => ['in_progress', 'queued', 'requires_action'].includes(status);

export function runStatus(status, extra = '') {
  const key = `run.${status}`;
  return el(
    'span',
    t(key) === key ? status : t(key),
    `status ${TONE[status] ?? 'neutral'} ${extra}`,
  );
}

// "12 分钟前" within a week, then "11月5日 16:29"; the exact moment is the tooltip.
export function timeCell(ms) {
  const td = el('td', when(ms), 'nowrap');
  td.title = dateTimeFull(ms);
  return td;
}

function runTable(rows) {
  const trs = rows.map((run) => {
    const name = el('td');
    name.append(
      link(runHref(run.id), run.agent || t('ledger.run_unknown'), 'row-link'),
      el('span', run.id, 'sub mono'),
    );
    const status = el('td');
    status.append(runStatus(run.status));
    const active = run.status === 'in_progress';
    const tr = el('tr');
    tr.append(
      name,
      status,
      el('td', run.tokens ? integer(run.tokens) : '—'),
      el('td', active ? '—' : points(run.charge)),
      timeCell(run.created_at),
    );
    return tr;
  });
  return stackedTable(
    'runs',
    [
      { text: t('runs.col.agent'), min: 200 },
      { text: t('runs.col.status'), width: 120 },
      { text: t('runs.col.tokens'), align: 'num', width: 110 },
      { text: t('runs.col.charge'), align: 'num', width: 130 },
      { text: t('runs.col.time'), width: 160 },
    ],
    trs,
  );
}

export async function runs(root, ctx) {
  const page = pageWrap(root, loading());
  let listed = [];
  try {
    listed = (await portal.agents()).data ?? [];
  } catch {
    // Without the catalog the filter still offers "all".
  }
  let agent = ctx.query.get('agent') || '';
  const options = [['', t('runs.filter_all')]];
  const seen = new Set();
  for (const a of listed) {
    seen.add(a.id);
    options.push([a.id, a.title ? `${a.title} · ${a.id}` : a.id]);
  }
  // A delisted agent can still own old runs (and the link may point at it).
  if (agent && !seen.has(agent)) options.push([agent, agent]);
  const filter = selectField('runs-agent', t('runs.filter'), options, agent);

  // Cursor paging: `cursors[i]` is the cursor that opens page i.
  let cursors = [undefined];
  let index = 0;
  const list = el('div', undefined, 'section-body');
  let token = 0;

  async function load() {
    const mine = ++token;
    list.replaceChildren(loading());
    try {
      const result = await portal.runs(PAGE_SIZE, cursors[index], agent || undefined);
      if (mine !== token) return;
      const rows = result.data ?? [];
      const next = result.next_cursor ?? null;
      if (!rows.length && index === 0) {
        list.replaceChildren(
          empty(t('runs.empty.title'), t(agent ? 'runs.empty.filtered' : 'runs.empty.text')),
          box('div', 'actions', link('#/playground', t('runs.empty.cta'), 'link-button primary')),
        );
        icons();
        return;
      }
      const prev = button(t('common.prev'), 'small', () => {
        index -= 1;
        load();
      });
      prev.disabled = index === 0;
      const forward = button(t('common.next'), 'small', () => {
        cursors[index + 1] = next;
        index += 1;
        load();
      });
      forward.disabled = !next;
      list.replaceChildren(
        runTable(rows),
        box(
          'div',
          'pager',
          el('span', t('common.page', { n: index + 1 })),
          box('div', 'actions', prev, forward),
        ),
      );
    } catch (err) {
      if (mine !== token) return;
      list.replaceChildren(notice(errorMessage(err), 'error'));
    }
    icons();
  }

  filter.input.addEventListener('change', () => {
    agent = filter.input.value;
    cursors = [undefined];
    index = 0;
    // Keep the address shareable without re-rendering the page.
    history.replaceState(null, '', agent ? `#/runs?agent=${encodeURIComponent(agent)}` : '#/runs');
    load();
  });

  page.replaceChildren(
    box('div', 'page-head', el('h1', t('runs.title')), el('p', t('runs.lede'))),
    box('section', '', box('div', 'run-tools', filter.field), list),
  );
  await load();
}
