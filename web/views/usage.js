import { hasFeature, hooks, isNodeAdmin, state } from '../lib/state.js';
import { api } from '../lib/api.js';
import {
  agentGlyph,
  cell,
  el,
  empty,
  iconButton,
  icons,
  table,
  toast,
  withBusy,
} from '../lib/dom.js';
import { num, engineName } from '../lib/format.js';
import { locale, t } from '../lib/i18n.js';
import { renderUsageSources } from './usage-sources.js';

export const usageView = {
  rev: 0,
  data: null,
  error: '',
  token: null,
  pending: null,
  days: 7,
  tab: 'gateway',
};
export async function refreshUsage() {
  if (!isNodeAdmin() || !hasFeature('local-usage-v1')) return;
  if (usageView.token !== state.token)
    Object.assign(usageView, { token: state.token, data: null, error: '', pending: null });
  if (usageView.pending) return usageView.pending;
  const token = state.token,
    days = usageView.days;
  const pending = api('GET', `/v1/local/usage?days=${days}`)
    .then((data) => {
      if (token !== state.token || days !== usageView.days) return;
      Object.assign(usageView, { data, error: '', rev: usageView.rev + 1 });
    })
    .catch((error) => {
      if (token === state.token) {
        usageView.error = error.message;
        usageView.rev++;
      }
    })
    .finally(() => {
      if (usageView.pending === pending) usageView.pending = null;
      if (token === state.token && state.view === 'usage') hooks.renderView();
    });
  usageView.pending = pending;
  return pending;
}
const number = (value) => (value == null ? t('usage.unknown') : num(value));
const date = (value) =>
  value == null
    ? t('usage.unknown')
    : new Date(value).toLocaleString(locale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
const names = () => ({
  reported: t('usage.reported'),
  stale: t('usage.stale'),
  unavailable: t('usage.unavailable'),
});
function heading(parent, title, note) {
  const row = el('div', undefined, 'usage-section-heading');
  row.append(el('h2', title));
  if (note) row.append(el('span', note, 'muted'));
  parent.append(row);
}
function stats(parent, items) {
  const band = el('dl', undefined, 'usage-metrics');
  for (const [label, value, note] of items) {
    const item = el('div');
    item.append(el('dt', label), el('dd', value));
    if (note) item.append(el('small', note, 'muted'));
    band.append(item);
  }
  parent.append(band);
}
function trend(parent, rows) {
  heading(parent, t('usage.daily'), t('usage.utc'));
  const figure = el('figure', undefined, 'usage-trend');
  const chart = el('div', undefined, 'usage-bars');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', t('usage.daily'));
  const maximum = Math.max(1, ...rows.map((r) => r.total ?? 0));
  for (const row of rows) {
    const column = el('div', undefined, 'usage-bar');
    column.title = `${row.date}: ${number(row.total)} Token`;
    const bar = el('span');
    bar.style.height = `${((row.total ?? 0) / maximum) * 100}%`;
    column.append(bar);
    chart.append(column);
  }
  const axis = el('figcaption', undefined, 'usage-axis');
  axis.append(el('span', rows[0]?.date ?? ''), el('span', rows.at(-1)?.date ?? ''));
  figure.append(chart, axis);
  parent.append(figure);
}
function gateway(parent, data) {
  const report = data.ledger,
    m = report.totals;
  const unknown = m.runs > 0 && m.unknown === m.runs;
  stats(parent, [
    [
      t('usage.total_tokens'),
      unknown ? t('usage.unknown') : number(m.total),
      t('usage.coverage', { known: m.runs - m.unknown, runs: m.runs }),
    ],
    [t('usage.input_tokens'), unknown ? t('usage.unknown') : number(m.input)],
    [t('usage.output_tokens'), unknown ? t('usage.unknown') : number(m.output)],
    [t('usage.requests'), number(m.requests), t('usage.executions', { n: m.runs })],
  ]);
  if (m.unknown || m.partial)
    parent.append(
      el('p', t('usage.incomplete', { unknown: m.unknown, partial: m.partial }), 'usage-notice'),
    );
  trend(parent, report.daily);
  heading(parent, t('usage.by_agent'), t('usage.direct_usage'));
  if (report.agents.length)
    parent.append(
      table(
        [
          { text: t('usage.agent') },
          { text: t('usage.input_tokens') },
          { text: t('usage.output_tokens') },
          { text: t('usage.total_tokens') },
          { text: t('usage.coverage_title') },
        ],
        report.agents.map((a) => {
          const row = el('tr'),
            label = el('div', undefined, 'usage-agent');
          label.append(
            agentGlyph(state.data?.agents?.find((v) => v.id === a.agent)?.engine ?? '', 'tiny'),
            el('code', a.agent),
          );
          const unknown = a.unknown === a.runs;
          row.append(
            cell(label),
            cell(unknown ? t('usage.unknown') : number(a.input), 'num'),
            cell(unknown ? t('usage.unknown') : number(a.output), 'num'),
            cell(unknown ? t('usage.unknown') : number(a.total), 'num'),
            cell(t('usage.coverage', { known: a.runs - a.unknown, runs: a.runs })),
          );
          return row;
        }),
      ),
    );
  else parent.append(el('p', t('usage.no_runs'), 'muted'));
  heading(parent, t('usage.key_limits'), t('usage.not_vendor_quota'));
  parent.append(
    table(
      [
        { text: t('usage.key') },
        { text: t('usage.consumed') },
        { text: t('usage.remaining_tokens') },
        { text: t('usage.remaining_runs') },
        { text: t('usage.expires') },
      ],
      data.keys.map((key) => {
        const row = el('tr');
        row.append(
          cell(key.name),
          cell(number(key.usage.usedTokens), 'num'),
          cell(
            key.remaining_tokens === null ? t('usage.unlimited') : number(key.remaining_tokens),
            'num',
          ),
          cell(
            key.remaining_runs === null ? t('usage.unlimited') : number(key.remaining_runs),
            'num',
          ),
          cell(key.quota.expiresAt ? date(key.quota.expiresAt) : t('usage.no_expiry')),
        );
        return row;
      }),
    ),
  );
}
function accounts(parent, data) {
  const source = data.collectors.sources.codexbar,
    rows = source.data?.accounts ?? [],
    labels = names();
  heading(parent, t('usage.account_quotas'), `CodexBar · ${date(source.updated_at)}`);
  if (!rows.length) {
    parent.append(
      empty(t('usage.no_quota'), t('usage.connect_source'), { icon: 'wallet', compact: true }),
    );
    return;
  }
  const grid = el('div', undefined, 'usage-account-grid');
  for (const account of rows) {
    const card = el('article', undefined, 'usage-account-card');
    card.dataset.status = account.status;
    const head = el('div', undefined, 'usage-card-head'),
      identity = el('div', undefined, 'usage-agent');
    identity.append(
      agentGlyph(account.provider, 'small'),
      el('strong', engineName(account.provider)),
    );
    head.append(
      identity,
      el(
        'span',
        account.status === 'reported' && account.confidence === 'estimated'
          ? t('usage.estimated')
          : labels[account.status],
        'usage-source-status',
      ),
    );
    card.append(head);
    if (account.account) card.append(el('p', account.account, 'muted'));
    for (const window of account.windows) {
      const label =
        window.label === window.id
          ? ({
              primary: t('usage.primary'),
              secondary: t('usage.secondary'),
              tertiary: t('usage.tertiary'),
            }[window.id] ?? window.label)
          : window.label;
      const block = el('div', undefined, 'usage-window'),
        top = el('div', undefined, 'usage-window-head');
      top.append(
        el('span', label),
        el(
          'strong',
          window.remaining_percent === null
            ? t('usage.unknown')
            : t('usage.remaining_percent', { n: Number(window.remaining_percent.toFixed(1)) }),
        ),
      );
      const meter = el('meter');
      meter.min = 0;
      meter.max = 100;
      meter.low = 15;
      meter.high = 40;
      meter.optimum = 100;
      meter.value = Math.min(100, window.remaining_percent ?? 0);
      meter.hidden = window.remaining_percent === null;
      meter.setAttribute('aria-label', label);
      block.append(
        top,
        meter,
        el(
          'small',
          `${window.used_percent === null ? t('usage.unknown') : t('usage.used_percent', { n: Number(window.used_percent.toFixed(1)) })} · ${t('usage.resets', { time: date(window.resets_at) })}`,
          'muted',
        ),
      );
      if (window.limit !== null && window.limit !== undefined)
        block.append(
          el(
            'small',
            t('usage.window_limit', {
              n: window.limit.toLocaleString(locale(), { maximumFractionDigits: 6 }),
              unit: window.unit ?? '',
            }),
            'muted usage-window-limit',
          ),
        );
      card.append(block);
    }
    if (account.balance) {
      const balance = el('div', undefined, 'usage-balance');
      balance.append(
        el(
          'span',
          account.balance.shared
            ? t('usage.shared_balance')
            : account.balance.unit === 'credits'
              ? t('usage.credit_balance')
              : t('usage.balance'),
        ),
        el(
          'strong',
          `${account.balance.remaining.toLocaleString(locale(), { maximumFractionDigits: 6 })} ${account.balance.unit}`,
        ),
      );
      card.append(balance);
      card.append(
        el(
          'small',
          `${account.balance.stale ? t('usage.stale') + ' · ' : ''}${t('usage.observed')}: ${date(account.balance.observed_at)}`,
          'muted',
        ),
      );
    }
    if (account.budget) {
      const budget = account.budget,
        row = el('div', undefined, 'usage-budget');
      row.append(
        el(
          'strong',
          budget.shared ? t('usage.shared_budget') : (budget.period ?? t('usage.spend_budget')),
        ),
        el(
          'p',
          t('usage.budget_amount', {
            used: budget.used.toLocaleString(locale(), { maximumFractionDigits: 6 }),
            limit: budget.limit.toLocaleString(locale(), { maximumFractionDigits: 6 }),
            unit: budget.unit,
          }),
        ),
        el(
          'small',
          `${budget.stale ? t('usage.stale') + ' · ' : ''}${t('usage.observed')}: ${date(budget.observed_at)}`,
          'muted',
        ),
      );
      card.append(row);
    }
    if (!account.windows.length && !account.balance && !account.budget)
      card.append(el('p', t('usage.not_reported'), 'muted'));
    card.append(
      el(
        'footer',
        `${account.source} · ${t('usage.observed')}: ${date(account.observed_at)}${account.confidence === 'estimated' ? ` · ${t('usage.estimated')}` : ''}`,
        'muted',
      ),
    );
    grid.append(card);
  }
  parent.append(grid, el('p', t('usage.quota_boundary'), 'usage-notice'));
}
function history(parent, data) {
  const source = data.collectors.sources.ccusage;
  heading(parent, t('usage.local_history'), `ccusage · ${date(source.updated_at)}`);
  if (source.status === 'error' || source.data?.partial)
    parent.append(el('p', t('usage.partial_history'), 'usage-notice'));
  const start = new Date(data.ledger.start).toISOString().slice(0, 10),
    end = new Date(data.ledger.end).toISOString().slice(0, 10);
  const rows = (source.data?.daily ?? []).filter((r) => r.date >= start && r.date <= end);
  if (!rows.length) {
    parent.append(
      empty(t('usage.no_history'), t('usage.history_boundary'), {
        icon: 'chart-no-axes-combined',
        compact: true,
      }),
    );
    return;
  }
  const totals = new Map();
  for (const row of rows) {
    const a = totals.get(row.agent) ?? {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
    };
    for (const key of Object.keys(a))
      a[key] = a[key] === null || row[key] === null ? null : a[key] + row[key];
    totals.set(row.agent, a);
  }
  parent.append(el('p', t('usage.history_boundary'), 'usage-notice'));
  parent.append(
    table(
      [
        { text: t('usage.agent') },
        { text: t('usage.input_tokens') },
        { text: t('usage.output_tokens') },
        { text: t('usage.cache_read') },
        { text: t('usage.cache_write') },
        { text: t('usage.total_tokens') },
      ],
      [...totals].map(([name, a]) => {
        const row = el('tr'),
          label = el('div', undefined, 'usage-agent');
        label.append(agentGlyph(name, 'tiny'), el('span', name));
        row.append(
          cell(label),
          ...['input', 'output', 'cache_read', 'cache_write', 'total'].map((key) =>
            cell(number(a[key]), 'num'),
          ),
        );
        return row;
      }),
    ),
  );
}
export function renderUsage(body) {
  if (!isNodeAdmin()) {
    body.append(empty(t('usage.owner_only'), t('usage.owner_hint'), { icon: 'shield-check' }));
    return;
  }
  if (!hasFeature('local-usage-v1')) {
    body.append(
      empty(t('usage.unavailable'), t('usage.upgrade'), { icon: 'chart-no-axes-combined' }),
    );
    return;
  }
  if (
    usageView.token !== state.token ||
    (!usageView.data && !usageView.error && !usageView.pending)
  )
    void refreshUsage();
  const bar = el('div', undefined, 'usage-toolbar'),
    tabs = el('div', undefined, 'segmented');
  tabs.setAttribute('role', 'tablist');
  for (const [key, label] of [
    ['gateway', t('usage.gateway')],
    ['accounts', t('usage.account_quotas')],
    ['history', t('usage.local_history')],
    ['sources', t('usage.sources')],
  ]) {
    const b = el('button', label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(usageView.tab === key));
    b.tabIndex = usageView.tab === key ? 0 : -1;
    b.dataset.tab = key;
    b.classList.toggle('active', usageView.tab === key);
    b.onclick = () => {
      usageView.tab = key;
      hooks.renderView(true);
    };
    b.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...tabs.children],
        index = items.indexOf(b);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      usageView.tab = items[next].dataset.tab;
      hooks.renderView(true);
      body.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    };
    tabs.append(b);
  }
  const period = el('select');
  period.setAttribute('aria-label', t('usage.period'));
  for (const days of [1, 7, 30, 90]) {
    const option = el('option', t('usage.days', { n: days }));
    option.value = String(days);
    option.selected = days === usageView.days;
    period.append(option);
  }
  period.onchange = async () => {
    usageView.days = Number(period.value);
    usageView.data = null;
    await usageView.pending;
    await refreshUsage();
  };
  period.hidden = ['accounts', 'sources'].includes(usageView.tab);
  const refresh = iconButton(t('usage.refresh'), 'refresh-cw', async () => {
    try {
      await withBusy(refresh, '', async () => {
        await api('POST', '/v1/local/usage/refresh', {});
        await refreshUsage();
      });
    } catch (e) {
      toast(e.message);
    }
  });
  const actions = el('div', undefined, 'usage-toolbar-actions');
  actions.append(period, refresh);
  bar.append(tabs, actions);
  body.append(bar);
  if (usageView.error) {
    body.append(el('p', usageView.error, 'usage-notice'));
    return;
  }
  if (!usageView.data) {
    body.append(el('p', t('usage.loading'), 'muted'));
    return;
  }
  ({
    gateway,
    accounts,
    history,
    sources: (root, data) => renderUsageSources(root, data.collectors, refreshUsage),
  })[usageView.tab](body, usageView.data);
  icons();
}
