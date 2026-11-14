import { portal, session } from './api.js';
import { errorMessage, t } from './i18n.js';
import {
  box,
  busy,
  button,
  el,
  empty,
  field,
  link,
  loading,
  notice,
  pageWrap,
  sectionHead,
  validateForm,
} from './dom.js';
import { dateOnly, integer, points } from './format.js';
import { chart } from './chart.js';
import { emit, go, state } from './state.js';
import { stackedTable } from './stack.js';

const METRICS = ['runs', 'tokens', 'spent'];
const FORMAT = { runs: integer, tokens: integer, spent: points };

function balanceBlock(balance) {
  const low = balance <= 0;
  return box(
    'section',
    `balance${low ? ' low' : ''}`,
    box(
      'div',
      '',
      el('span', t('dash.balance'), 'muted'),
      box(
        'div',
        'amount',
        el('span', points(balance), 'figure'),
        el('span', t('unit.points'), 'unit'),
      ),
    ),
    box(
      'div',
      'balance-side',
      low ? notice(t('dash.low'), 'warn') : null,
      link('#/billing', t('dash.redeem'), low ? 'link-button primary' : 'link-button'),
    ),
  );
}

function statsBlock(totals) {
  const stat = (label, value) =>
    box('div', 'stat', el('div', label, 'label'), el('div', value, 'value'));
  return box(
    'div',
    'stats',
    stat(t('dash.stat.runs'), integer(totals.runs)),
    stat(t('dash.stat.tokens'), integer(totals.tokens)),
    stat(t('dash.stat.spent'), points(totals.spent)),
  );
}

// "合计 232 · 单日最高 15（11-08）": the chart in words, which is also its text alternative.
function summaryText(daily, metric) {
  const values = daily.map((d) => d[metric] ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...values);
  if (!peak) return t('dash.summary_none');
  const day = daily[values.indexOf(peak)].date.slice(5);
  const f = FORMAT[metric];
  return t('dash.summary', { total: f(total), peak: f(peak), day });
}

function chartBlock(daily) {
  let metric = 'runs';
  const holder = el('div', undefined, 'chart');
  const pills = el('div', undefined, 'pills');
  pills.setAttribute('role', 'group');
  pills.setAttribute('aria-label', t('dash.chart.title'));
  const summary = el('p', undefined, 'chart-summary');
  summary.setAttribute('aria-live', 'polite');
  const buttons = METRICS.map((m) =>
    button(t(`dash.metric.${m}`), '', () => {
      metric = m;
      sync();
      handle.redraw();
    }),
  );
  const sync = () => {
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(METRICS[i] === metric)));
    summary.textContent = summaryText(daily, metric);
  };
  pills.append(...buttons);
  sync();
  const section = box(
    'section',
    '',
    sectionHead(t('dash.chart.title'), el('p', t('dash.chart.note'))),
    box('div', 'chart-box', box('div', 'chart-tools', pills, summary), holder),
  );
  // The chart measures its container, so it is drawn once the section is in the page.
  let handle = { redraw() {} };
  requestAnimationFrame(() => {
    handle = chart(holder, daily, () => metric);
  });
  return section;
}

function agentTable(byAgent) {
  if (!byAgent?.length) return empty(t('dash.agents.empty'));
  const rows = byAgent.map((r) => {
    const tr = el('tr');
    const name = el('td');
    const agentLink = link(`#/runs?agent=${encodeURIComponent(r.agent)}`, undefined, 'row-link');
    agentLink.append(el('strong', r.agent));
    name.append(agentLink);
    tr.append(
      name,
      el('td', integer(r.runs)),
      el('td', integer(r.tokens)),
      el('td', points(r.spent)),
    );
    return tr;
  });
  return stackedTable(
    'agents',
    [
      { text: t('dash.col.agent'), min: 180 },
      { text: t('dash.col.runs'), align: 'num', width: 100 },
      { text: t('dash.col.tokens'), align: 'num', width: 130 },
      { text: t('dash.col.spent'), align: 'num', width: 150 },
    ],
    rows,
  );
}

// Account details above, the password form below. Changing the password signs every session out.
function accountBlock(account) {
  const current = field('current-password', t('acct.current'), {
    type: 'password',
    required: true,
    autocomplete: 'current-password',
  });
  const next = field('new-password', t('acct.new'), {
    type: 'password',
    required: true,
    autocomplete: 'new-password',
    minlength: 8,
    maxlength: 200,
  });
  const message = el('div');
  message.setAttribute('aria-live', 'polite');
  const submit = button(t('acct.change'), '');
  submit.type = 'submit';
  const form = el('form', undefined, 'form-row account-form');
  form.noValidate = true;
  form.append(current.field, next.field, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.replaceChildren();
    if (!validateForm(form)) return;
    busy(submit, true);
    try {
      await portal.changePassword({
        current_password: current.input.value,
        new_password: next.input.value,
      });
      session.clear();
      state.account = null;
      emit('portal:auth');
      go('/login');
    } catch (err) {
      // A wrong current password is a form error, not a lost session.
      const text = err.code === 'invalid_credentials' ? t('acct.wrong_current') : errorMessage(err);
      message.replaceChildren(notice(text, 'error'));
      busy(submit, false);
    }
  });
  const facts = el('dl', undefined, 'kv');
  const row = (label, value) => facts.append(el('dt', label), el('dd', value));
  row(t('auth.email'), account.email);
  if (account.name) row(t('acct.name'), account.name);
  if (account.created_at) row(t('acct.since'), dateOnly(account.created_at));
  return box(
    'section',
    '',
    sectionHead(t('acct.title')),
    box(
      'div',
      'section-body account',
      facts,
      box(
        'div',
        'account-password',
        el('h3', t('acct.password'), 'form-title'),
        el('p', t('acct.password_note'), 'muted note'),
        form,
        message,
      ),
    ),
  );
}

export async function dashboard(root) {
  const page = pageWrap(root, loading());
  const usage = await portal.usage(30);
  if (state.account) state.account.balance = usage.balance;
  page.replaceChildren(
    box('div', 'page-head', el('h1', t('dash.title')), el('p', t('dash.lede'))),
    box('div', '', balanceBlock(usage.balance), statsBlock(usage.totals)),
    chartBlock(usage.daily ?? []),
    box(
      'section',
      '',
      sectionHead(t('dash.agents.title'), el('p', t('dash.agents.note'))),
      box('div', 'section-body', agentTable(usage.by_agent)),
    ),
    state.account ? accountBlock(state.account) : null,
  );
}
