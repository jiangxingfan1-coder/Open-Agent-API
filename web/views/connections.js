import { hasFeature, hooks, isNodeAdmin, state } from '../lib/state.js';
import { api } from '../lib/api.js';
import {
  agentGlyph,
  button,
  confirmAction,
  el,
  empty,
  iconButton,
  icon,
  icons,
  toast,
  withBusy,
} from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import {
  closeLocalConnection,
  connectionMode,
  evidenceLabel,
  openLocalConnection,
  protocolName,
} from '../dialogs/local-connection.js';

export const connections = {
  rev: 0,
  data: null,
  error: '',
  token: null,
  pending: null,
  filter: 'installed',
  query: '',
};
export async function refreshConnections(rescan = false) {
  if (!isNodeAdmin() || !hasFeature('local-connections-v1')) return;
  if (connections.token !== state.token) {
    closeLocalConnection();
    Object.assign(connections, {
      token: state.token,
      data: null,
      error: '',
      pending: null,
      filter: 'installed',
      query: '',
    });
  }
  if (connections.pending) {
    await connections.pending;
    if (!rescan) return;
  }
  const token = state.token;
  const pending = api('GET', `/v1/local/connections${rescan ? '?refresh=1' : ''}`)
    .then((data) => {
      if (token !== state.token) return;
      connections.data = data;
      connections.error = '';
      connections.rev++;
    })
    .catch((error) => {
      if (token !== state.token) return;
      connections.error = error.message;
      connections.rev++;
    })
    .finally(() => {
      if (connections.pending === pending) connections.pending = null;
      if (state.view === 'connections' && token === state.token) hooks.renderView();
    });
  connections.pending = pending;
  return pending;
}

const stateLabels = () => ({
  active: t('connections.active'),
  missing: t('connections.missing'),
  outdated: t('connections.outdated'),
  conflict: t('connections.conflict'),
  key_unavailable: t('connections.key_unavailable'),
  unavailable: t('connections.unavailable'),
  source_unavailable: t('connections.source_unavailable'),
  failed: t('connections.failed'),
  installing: t('connections.working'),
  syncing: t('connections.working'),
  removing: t('connections.working'),
  removed: t('connections.removed'),
});

function clientCatalog(body, data) {
  // Keep older local-connections-v1 gateways usable while accepting the additive inventory.
  const clients = data.clients ?? [
    {
      id: 'dsh',
      name: 'DeepSeek Harness',
      icon: 'deepseek-harness',
      installed: data.target.available,
      connection: 'managed',
      protocol: 'chat-completions',
      evidence: [],
    },
  ];
  const detected = (client) => client.installed || (client.id === 'dsh' && data.target.available);
  const installed = clients.filter(detected);
  const bar = el('div', undefined, 'local-catalog-toolbar');
  const filters = el('div', undefined, 'segmented small');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', t('connections.filter'));
  const grid = el('div', undefined, 'local-discovery');
  const draw = () => {
    grid.replaceChildren();
    const query = connections.query.trim().toLocaleLowerCase();
    const visible = clients.filter(
      (c) =>
        (connections.filter === 'all' || detected(c)) &&
        `${c.name} ${c.id}`.toLocaleLowerCase().includes(query),
    );
    visible.sort(
      (a, b) =>
        Number(detected(b)) - Number(detected(a)) ||
        Number(b.connection === 'managed') - Number(a.connection === 'managed') ||
        a.name.localeCompare(b.name),
    );
    for (const client of visible) {
      const card = el('button', undefined, 'local-client-card');
      card.type = 'button';
      card.dataset.localClient = client.id;
      card.setAttribute('aria-haspopup', 'dialog');
      card.setAttribute('aria-label', client.name);
      const head = el('span', undefined, 'local-card-head');
      const identity = el('span', undefined, 'local-client-identity');
      const name = el('span', undefined, 'local-client-title');
      name.append(
        el('strong', client.name),
        el('span', protocolName(client.protocol) || t('connections.agent_client'), 'muted'),
      );
      identity.append(agentGlyph(client.icon, 'large'), name);
      head.append(identity, icon('chevron-right'));
      const status = el(
        'span',
        undefined,
        `local-detection${detected(client) ? '' : ' is-unavailable'}`,
      );
      status.append(
        icon(detected(client) ? 'circle-check' : 'circle-dashed'),
        el('span', t(detected(client) ? 'connections.detected' : 'connections.not_detected')),
      );
      const footer = el('span', undefined, 'local-card-foot');
      footer.append(
        el(
          'span',
          connectionMode(client),
          `local-capability${client.connection === 'managed' ? ' is-managed' : ''}`,
        ),
      );
      const kinds = [...new Set((client.evidence ?? []).map((e) => evidenceLabel(e.kind)))];
      footer.append(
        el(
          'span',
          kinds.join(' · ') ||
            (client.id === 'dsh' && data.target.available
              ? t('connections.evidence_configured')
              : ''),
          'muted',
        ),
      );
      card.append(head, status, footer);
      card.onclick = () => openLocalConnection(client, connections.data, refreshConnections);
      grid.append(card);
    }
    if (!visible.length) grid.append(empty(t('connections.no_matches'), '', { icon: 'search' }));
    for (const control of filters.children) {
      const active = control.dataset.filter === connections.filter;
      control.classList.toggle('active', active);
      control.setAttribute('aria-pressed', String(active));
    }
    icons();
  };
  for (const [value, count] of [
    ['installed', installed.length],
    ['all', clients.length],
  ]) {
    const control = button(
      t(value === 'installed' ? 'connections.filter_installed' : 'connections.filter_all', {
        count,
      }),
      '',
      () => {
        connections.filter = value;
        draw();
      },
    );
    control.dataset.filter = value;
    filters.append(control);
  }
  const search = el('label', undefined, 'search local-client-search');
  const input = el('input');
  input.type = 'search';
  input.value = connections.query;
  input.placeholder = t('connections.search');
  input.setAttribute('aria-label', input.placeholder);
  input.oninput = () => {
    connections.query = input.value;
    draw();
  };
  search.append(icon('search'), input);
  const rescan = iconButton(t('connections.rescan'), 'refresh-cw', async () => {
    await withBusy(rescan, '', () => refreshConnections(true));
  });
  bar.append(filters, search, rescan);
  body.append(bar, grid);
  draw();
}

export function renderConnections(body) {
  if (!isNodeAdmin()) {
    body.append(
      empty(t('connections.admin'), t('connections.admin_hint'), { icon: 'shield-check' }),
    );
    return;
  }
  if (!hasFeature('local-connections-v1')) {
    body.append(empty(t('connections.unavailable'), t('connections.upgrade'), { icon: 'plug' }));
    return;
  }
  if (
    connections.token !== state.token ||
    (!connections.data && !connections.pending && !connections.error)
  )
    void refreshConnections();
  if (connections.error) {
    body.append(
      empty(t('connections.unavailable'), connections.error, {
        icon: 'circle-alert',
        action: button(t('common.refresh'), 'refresh-cw', () => void refreshConnections(true)),
      }),
    );
    return;
  }
  const data = connections.data;
  if (!data) {
    body.append(el('p', t('connections.loading'), 'muted'));
    return;
  }
  clientCatalog(body, data);
  const labels = stateLabels();
  const cards = data.data.map((item) => {
    const card = el('article', undefined, 'local-binding-card');
    card.setAttribute('aria-label', item.agent);
    const head = el('div', undefined, 'local-card-head');
    const named = el('div', undefined, 'local-source-name');
    named.append(
      agentGlyph(data.sources.find((s) => s.id === item.agent)?.engine ?? '', 'small'),
      el('code', item.agent),
    );
    const status = el('span', labels[item.status] ?? item.status, 'local-binding-status');
    status.setAttribute(
      'aria-label',
      `${t('connections.status')}: ${labels[item.status] ?? item.status}`,
    );
    status.classList.toggle('is-active', item.status === 'active');
    head.append(named, status);
    const destination = el('div', undefined, 'local-destination');
    destination.append(
      icon('arrow-down-right'),
      agentGlyph('dsh', 'tiny'),
      el('span', 'DeepSeek Harness'),
    );
    const facts = el('dl', undefined, 'local-binding-facts');
    for (const [label, value] of [
      [t('connections.models'), String(item.model_count)],
      [t('connections.tool_boundary'), t(`access.${item.tool_mode}`)],
    ]) {
      const fact = el('div');
      fact.append(el('dt', label), el('dd', value));
      facts.append(fact);
    }
    const actions = el('div', undefined, 'row-actions');
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', t('connections.actions'));
    const check = iconButton(t('connections.check'), 'shield-check', async () => {
      await withBusy(check, '', async () => {
        try {
          const result = await api('POST', `/v1/local/connections/${item.id}/check`, {});
          toast(result.ok ? t('connections.check_ok') : t('connections.check_failed'));
        } catch (error) {
          toast(error.message);
        }
        await refreshConnections();
      });
    });
    const sync = iconButton(t('connections.sync'), 'refresh-cw', () =>
      openLocalConnection(
        { id: 'dsh', name: 'DeepSeek Harness', icon: 'deepseek-harness', connection: 'managed' },
        connections.data,
        refreshConnections,
        item,
      ),
    );
    const remove = iconButton(t('connections.disconnect'), 'unplug', async () => {
      const token = state.token;
      if (
        !(await confirmAction({
          title: t('connections.disconnect'),
          message: t('connections.disconnect_body', { agent: item.agent }),
          accept: t('connections.disconnect'),
          danger: true,
        })) ||
        token !== state.token
      )
        return;
      try {
        const result = await api('DELETE', `/v1/local/connections/${item.id}`);
        if (token !== state.token) return;
        toast(result.configuration_removed ? t('connections.removed') : t('connections.preserved'));
        state.keys = null;
        await refreshConnections();
      } catch (error) {
        toast(error.message);
      }
    });
    actions.append(check, sync, remove);
    const footer = el('div', undefined, 'local-card-foot');
    footer.append(el('code', item.base_url, 'local-endpoint'), actions);
    card.append(head, destination, facts, footer);
    return card;
  });
  const heading = el('div', undefined, 'local-section-heading');
  heading.append(el('h2', t('connections.saved')), el('span', String(cards.length), 'muted'));
  body.append(heading);
  if (cards.length) {
    const grid = el('div', undefined, 'local-binding-grid');
    grid.append(...cards);
    body.append(grid);
  } else body.append(el('p', t('connections.empty'), 'muted local-empty'));
  icons();
}
