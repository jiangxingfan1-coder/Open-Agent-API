import { hooks } from '../lib/state.js';
import { num } from '../lib/format.js';
import { $, cell, el, empty, panel, table } from '../lib/dom.js';
import { compact } from '../views/overview.js';
import { USAGE_DAYS, platform, pts, setPlatformTab } from './platform-data.js';
import { segmented } from './platform-dialog.js';
import { t } from '../lib/i18n.js';

/* ── Developer platform: usage section ────────────────────
   Data comes from GET /v1/platform/usage?days=30 (contract in docs/platform.md, "Endpoint overview"):
   daily has no missing days and date is a UTC YYYY-MM-DD; by_account has at most 50 entries.
   The chart reuses the overview page's "Recent activity" drawing and classes (.pulse*); it has a
   single series, so there is no legend. */
const MODES = {
  runs: { label: t('dlg.usage.mode.runs'), title: t('dlg.usage.mode.runs_title'), format: num },
  spent: { label: t('dlg.usage.mode.spent'), title: t('dlg.usage.mode.spent_title'), format: pts },
};
const ACCOUNT_LIMIT = 50;

function pickMode(mode) {
  if (mode === platform.usageMode) return;
  platform.usageMode = mode;
  platform.rev++;
  hooks.renderView();
}

// Click an email: switch to the Developers tab and fill the search box with it, so the table searches by that email.
function searchAccount(email) {
  setPlatformTab('accounts');
  const input = $('filter');
  if (!input) return;
  input.value = email;
  input.dispatchEvent(new Event('input'));
}

function dayChart(daily, mode) {
  const { format } = MODES[mode];
  const values = daily.map((d) => Number(d[mode]) || 0);
  const peak = Math.max(0, ...values);
  const chart = el('div', undefined, 'pulse');
  chart.setAttribute('role', 'img');
  chart.setAttribute(
    'aria-label',
    t(mode === 'spent' ? 'dlg.usage.aria_spent' : 'dlg.usage.aria_runs', {
      n: daily.length,
      peak: format(peak),
    }),
  );
  const cols = el('div', undefined, 'pulse-cols');
  daily.forEach((d, i) => {
    const col = el('div', undefined, 'pulse-col');
    col.setAttribute('tabindex', '0');
    col.setAttribute('role', 'img');
    const text = t('dlg.usage.day_tip', {
      date: d.date,
      runs: num(d.runs),
      spent: pts(d.spent),
      tokens: num(d.tokens),
    });
    col.title = text;
    col.setAttribute('aria-label', text.replace('\n', t('dlg.sep')));
    const stack = el('div', undefined, 'pulse-stack');
    stack.style.height = peak ? `${(values[i] / peak) * 100}%` : '0%';
    if (values[i] > 0) {
      const seg = el('span', undefined, 'seg ok');
      seg.style.flexGrow = '1'; // A single series: this segment fills the whole bar
      stack.append(seg);
    }
    col.append(stack);
    cols.append(col);
  });
  const axis = el('div', undefined, 'pulse-axis');
  daily.forEach((d, i) => axis.append(el('span', i % 5 === 0 ? String(d.date).slice(5) : '')));
  chart.append(cols, axis, el('span', t('dlg.usage.peak', { n: format(peak) }), 'pulse-peak'));
  return chart;
}

// Small table: the first column is the name (truncated to one line, the full text in the title); the rest are numbers.
function usageTable(rows, head, name) {
  const card = table(
    [
      { text: head, min: 150 },
      { text: t('dlg.usage.col.runs'), align: 'num', width: 76 },
      { text: t('dlg.usage.col.tokens'), align: 'num', width: 96 },
      { text: t('dlg.usage.col.spent'), align: 'num', width: 116 },
    ],
    rows.map((r) => {
      const tr = el('tr');
      tr.append(
        cell(name(r)),
        cell(num(r.runs), 'num'),
        cell(compact(r.tokens), 'num'),
        cell(pts(r.spent), 'num'),
      );
      tr.children[2].title = num(r.tokens);
      return tr;
    }),
  );
  return card.firstElementChild; // The table sits inside a panel, so it is not wrapped in another bordered card (returns the horizontally scrolling layer)
}

function nameCell(text) {
  const box = el('div', text, 'row-title');
  box.title = text;
  box.translate = false;
  return box;
}
function emailCell(row) {
  const button = el('button', row.email || row.account_id, 'cell-link');
  button.type = 'button';
  button.title = t('dlg.usage.search_title', { email: row.email });
  button.translate = false;
  button.onclick = () => searchAccount(row.email);
  return button;
}

function smallTable(title, note, rows, emptyText, build) {
  const { box, body } = panel(title);
  if (note) box.querySelector('.panel-head').append(el('span', note, 'muted'));
  if (rows.length) body.append(build(rows));
  else body.append(empty(emptyText[0], emptyText[1], { icon: 'chart-column', compact: true }));
  return box;
}

export function renderUsage(body, section) {
  const mode = MODES[platform.usageMode] ? platform.usageMode : 'runs';
  const choice = segmented(
    t('dlg.usage.measure'),
    Object.entries(MODES).map(([key, m]) => [key, m.label]),
    mode,
    pickMode,
  );
  body.append(
    section(t('dlg.usage.section'), t('dlg.usage.section_note', { n: USAGE_DAYS }), choice.box),
  );
  const u = platform.usage;
  if (!u) {
    body.append(
      empty(
        t('dlg.usage.none'),
        platform.failure ? t('dlg.usage.none_failed') : t('dlg.usage.none_wait'),
        {
          icon: 'chart-column',
          compact: true,
        },
      ),
    );
    return;
  }
  const daily = u.daily ?? [];
  const byAgent = u.by_agent ?? [];
  const byAccount = u.by_account ?? [];
  const totals = u.totals ?? {};
  const chart = panel(MODES[mode].title);
  chart.box.classList.add('pulse-card', 'platform-chart');
  chart.box.querySelector('.panel-head').append(
    el(
      'span',
      t('dlg.usage.total', {
        runs: num(totals.runs),
        spent: pts(totals.spent),
        tokens: num(totals.tokens),
      }),
      'muted',
    ),
  );
  const peak = Math.max(0, ...daily.map((d) => Number(d[mode]) || 0));
  chart.body.append(
    peak
      ? dayChart(daily, mode)
      : empty(
          t(mode === 'runs' ? 'dlg.usage.empty_runs' : 'dlg.usage.empty_spent', { n: USAGE_DAYS }),
          t(mode === 'runs' ? 'dlg.usage.empty_runs_hint' : 'dlg.usage.empty_spent_hint'),
          { icon: 'chart-column', compact: true },
        ),
  );
  body.append(chart.box);
  // No task at all in the whole period: the chart's empty state already says so, so two empty tables are not shown.
  if (!byAgent.length && !byAccount.length) return;
  const grid = el('div', undefined, 'platform-usage-grid');
  grid.append(
    smallTable(
      t('dlg.usage.by_agent'),
      '',
      byAgent,
      [t('dlg.usage.no_agent'), t('dlg.usage.no_agent_hint')],
      (rows) => usageTable(rows, t('dlg.usage.agent'), (r) => nameCell(r.agent)),
    ),
    smallTable(
      t('dlg.usage.by_account'),
      byAccount.length >= ACCOUNT_LIMIT ? t('dlg.usage.top_n', { n: ACCOUNT_LIMIT }) : '',
      byAccount,
      [t('dlg.usage.no_account'), t('dlg.usage.no_account_hint')],
      (rows) => usageTable(rows, t('dlg.usage.email'), emailCell),
    ),
  );
  body.append(grid);
}
