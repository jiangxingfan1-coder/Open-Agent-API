import { hasFeature, hooks, isNodeAdmin, state } from '../lib/state.js';
import { api, errorText } from '../lib/api.js';
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

export const connections = {
  rev: 0,
  data: null,
  error: '',
  token: null,
  pending: null,
  agent: '',
  model: 'auto',
  toolMode: null,
  editing: false,
};
export async function refreshConnections() {
  if (!isNodeAdmin() || !hasFeature('local-connections-v1')) return;
  if (connections.token !== state.token) {
    Object.assign(connections, {
      token: state.token,
      data: null,
      error: '',
      pending: null,
      agent: '',
      model: 'auto',
      toolMode: null,
      editing: false,
    });
  }
  if (connections.pending) return connections.pending;
  const token = state.token;
  const pending = api('GET', '/v1/local/connections')
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

const toolLabel = (mode) => t(`access.${mode}`);
async function configure(agent, model, toolMode) {
  const token = state.token;
  const plan = await api('POST', '/v1/local/connections/preview', {
    agent,
    model,
    ...(toolMode ? { tool_mode: toolMode } : {}),
  });
  if (token !== state.token) return;
  const approved = await confirmAction({
    title: t('connections.confirm_title'),
    message:
      t(
        plan.action === 'sync'
          ? 'connections.sync_body'
          : plan.action === 'repair'
            ? 'connections.repair_body'
            : 'connections.confirm_body',
        {
          agent,
          count: plan.model_count,
          files: plan.files.join('\n'),
        },
      ) +
      ` ${t('connections.tool_boundary')}: ${toolLabel(plan.tool_mode)}.` +
      (plan.execution === 'host' ? ` ${t('connections.host_hint')}` : ''),
    accept:
      plan.action === 'sync'
        ? t('connections.sync')
        : plan.action === 'repair'
          ? t('connections.repair')
          : t('connections.connect'),
  });
  if (!approved || token !== state.token) return;
  await api('POST', '/v1/local/connections/apply', { plan_id: plan.plan_id });
  connections.editing = false;
  state.keys = null;
  toast(t('connections.applied'));
  await refreshConnections();
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
  ) {
    void refreshConnections();
  }
  if (connections.error) {
    body.append(
      empty(t('connections.unavailable'), connections.error, {
        icon: 'circle-alert',
        action: button(t('common.refresh'), 'refresh-cw', () => void refreshConnections()),
      }),
    );
    return;
  }
  const data = connections.data;
  if (!data) {
    body.append(el('p', t('connections.loading'), 'muted'));
    return;
  }
  const available = data.sources.filter((s) => s.available);
  const discovery = el('div', undefined, 'local-discovery');
  const target = el('article', undefined, 'local-client-card');
  target.setAttribute('aria-label', 'DeepSeek Harness');
  const targetHead = el('div', undefined, 'local-card-head');
  const identity = el('div', undefined, 'local-client-identity');
  identity.append(agentGlyph('dsh', 'large'));
  const title = el('div');
  title.append(el('h2', 'DeepSeek Harness'), el('span', 'OpenAI Chat Completions', 'muted'));
  identity.append(title);
  targetHead.append(
    identity,
    iconButton(t('common.refresh'), 'refresh-cw', () => void refreshConnections()),
  );
  const detected = el('div', undefined, 'local-detection');
  detected.append(
    icon(data.target.available ? 'circle-check' : 'circle-alert'),
    el('span', data.target.available ? t('connections.detected') : errorText(data.target.error)),
  );
  detected.classList.toggle('is-unavailable', !data.target.available);
  const targetFoot = el('div', undefined, 'local-card-foot');
  targetFoot.append(
    el('span', t('connections.connection_count', { count: data.data.length }), 'muted'),
  );
  const add = button(
    t('connections.add'),
    'plus',
    () => {
      connections.editing = true;
      hooks.renderView(true);
      body.querySelector('.local-connect-form select')?.focus();
    },
    'primary',
  );
  add.disabled = !data.target.available || !available.length || connections.editing;
  targetFoot.append(add);
  target.append(targetHead, detected, targetFoot);
  discovery.append(target);
  body.append(discovery);
  if (!available.some((s) => s.id === connections.agent)) {
    connections.agent = available[0]?.id ?? '';
    connections.model = 'auto';
    connections.toolMode = null;
  }
  const form = el('form', undefined, 'local-connect-form');
  form.hidden = !connections.editing;
  const selectedSource = available.find((s) => s.id === connections.agent);
  const saved = data.data.find((item) => item.agent === connections.agent);
  if (connections.toolMode === null) {
    connections.model = saved?.model ?? 'auto';
    connections.toolMode = saved?.tool_mode ?? selectedSource?.default_tool_mode;
  }
  const sourceLabel = el('label');
  sourceLabel.append(el('span', t('connections.source')));
  const source = el('select');
  source.setAttribute('aria-label', t('connections.source'));
  for (const item of data.sources) {
    const option = el('option', item.id);
    option.value = item.id;
    option.disabled = !item.available;
    option.selected = item.id === connections.agent;
    source.append(option);
  }
  source.onchange = () => {
    connections.agent = source.value;
    connections.model = 'auto';
    connections.toolMode = null;
    hooks.renderView(true);
  };
  sourceLabel.append(source);
  const modelLabel = el('label');
  modelLabel.append(el('span', t('connections.model')));
  const models = selectedSource?.models ?? [];
  if (!models.some((m) => m.selector === connections.model)) connections.model = 'auto';
  const model = el('select');
  model.setAttribute('aria-label', t('connections.model'));
  for (const item of models) {
    const option = el('option', item.selector === 'auto' ? t('connections.auto') : item.name);
    option.value = item.selector;
    option.selected = item.selector === connections.model;
    model.append(option);
  }
  model.onchange = () => {
    connections.model = model.value;
  };
  modelLabel.append(model);
  const modeLabel = el('label');
  modeLabel.append(el('span', t('connections.tool_boundary')));
  const mode = el('select');
  mode.setAttribute('aria-label', t('connections.tool_boundary'));
  const modes = selectedSource?.tool_modes ?? [];
  if (!modes.includes(connections.toolMode))
    connections.toolMode = selectedSource?.default_tool_mode;
  for (const value of modes) {
    const option = el('option', toolLabel(value));
    option.value = value;
    option.selected = value === connections.toolMode;
    mode.append(option);
  }
  mode.disabled = modes.length < 2;
  mode.onchange = () => {
    connections.toolMode = mode.value;
  };
  modeLabel.append(mode);
  const submit = button(t('connections.connect'), 'plug', () => {}, 'primary');
  submit.type = 'submit';
  submit.disabled = !data.target.available || !available.length;
  form.append(sourceLabel, modelLabel, modeLabel, submit);
  const dismiss = iconButton(t('common.close'), 'x', () => {
    connections.editing = false;
    hooks.renderView(true);
  });
  dismiss.type = 'button';
  dismiss.classList.add('local-form-dismiss');
  form.append(dismiss);
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await withBusy(submit, t('connections.previewing'), () =>
        configure(connections.agent, connections.model, connections.toolMode),
      );
    } catch (error) {
      toast(error.message);
      await refreshConnections();
    }
  };
  body.append(form);
  if (!available.length) body.append(el('p', t('connections.publish_first'), 'muted'));
  if (data.target.files?.length) {
    const details = el('details', undefined, 'local-paths');
    details.append(el('summary', t('connections.files')));
    for (const file of data.target.files) details.append(el('code', file));
    body.append(details);
  }
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
      [t('connections.tool_boundary'), toolLabel(item.tool_mode)],
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
    const sync = iconButton(t('connections.sync'), 'refresh-cw', async () => {
      try {
        await withBusy(sync, '', () => configure(item.agent, item.model, item.tool_mode));
      } catch (error) {
        toast(error.message);
        await refreshConnections();
      }
    });
    const remove = iconButton(t('connections.disconnect'), 'unplug', async () => {
      if (
        !(await confirmAction({
          title: t('connections.disconnect'),
          message: t('connections.disconnect_body', { agent: item.agent }),
          accept: t('connections.disconnect'),
          danger: true,
        }))
      )
        return;
      try {
        const result = await api('DELETE', `/v1/local/connections/${item.id}`);
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
