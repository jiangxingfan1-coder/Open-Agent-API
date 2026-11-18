import { state } from '../lib/state.js';
import { api, errorText } from '../lib/api.js';
import {
  agentGlyph,
  button,
  confirmAction,
  el,
  icon,
  iconButton,
  icons,
  openDialog,
  toast,
} from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import {
  manualConnection,
  protocolName,
  resolveClientTargets,
  targetClientMeta,
} from './local-connection-manual.js';

export { protocolName, resolveClientTargets, targetClientMeta };

export const connectionMode = (client) =>
  t(
    {
      managed: 'connections.mode_managed',
      manual: 'connections.mode_manual',
      unavailable: 'connections.mode_unavailable',
      provider: 'localModels.api',
    }[client.connection] ?? 'connections.mode_unavailable',
  );
export const evidenceLabel = (kind) =>
  t(
    {
      cli: 'connections.evidence_cli',
      application: 'connections.evidence_application',
      extension: 'connections.evidence_extension',
      configured: 'connections.evidence_configured',
    }[kind] ?? 'connections.evidence_configured',
  );
let current = null;
export function closeLocalConnection() {
  current?.close();
}

function paths(title, values) {
  const details = el('details', undefined, 'local-paths');
  details.append(el('summary', title));
  for (const value of values) details.append(el('code', value));
  return details;
}

function selectField(label, choices, value, changed) {
  const wrap = el('label');
  const select = el('select');
  select.setAttribute('aria-label', label);
  for (const item of choices) {
    const option = el('option', item.label);
    option.value = item.value;
    option.selected = item.value === value;
    option.disabled = !!item.disabled;
    select.append(option);
  }
  select.onchange = () => changed(select.value);
  wrap.append(el('span', label), select);
  return wrap;
}

export function openLocalConnection(client, data, refresh, existing) {
  closeLocalConnection();
  const token = state.token;
  const opener = document.activeElement;
  const dlg = el('dialog', undefined, 'modal local-connection-modal');
  current = dlg;
  dlg.id = 'local-connection-dialog';
  dlg.setAttribute('aria-labelledby', 'local-connection-title');
  const form = el('form');
  const header = el('div', undefined, 'dialog-heading');
  const identity = el('div', undefined, 'local-client-identity');
  const titles = el('div');
  const title = el('h2', client.name);
  title.id = 'local-connection-title';
  titles.append(title, el('p', connectionMode(client), 'dialog-desc'));
  identity.append(agentGlyph(client.icon, 'large'), titles);
  let busy = false;
  let applying = false;
  const close = iconButton(t('common.close'), 'x', () => {
    if (!applying) dlg.close();
  });
  close.classList.add('close-dialog');
  header.append(identity, close);
  const body = el('div', undefined, 'local-dialog-body');
  const failure = el('p', undefined, 'form-error');
  failure.setAttribute('role', 'alert');
  const actions = el('div', undefined, 'dialog-actions');
  form.append(header, body, failure, actions);
  dlg.append(form);
  dlg.addEventListener('cancel', (event) => {
    if (applying) event.preventDefault();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (current === dlg) current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else
      document
        .querySelector(`[data-local-client="${CSS.escape(client.id)}"]`)
        ?.focus({ preventScroll: true });
  });
  document.body.append(dlg);
  const valid = () => dlg.open && token === state.token;
  const setBusy = (value) => {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.querySelectorAll('button, select')) {
      if (value) {
        control.dataset.wasDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.wasDisabled !== undefined) {
        control.disabled = control.dataset.wasDisabled === 'true';
        delete control.dataset.wasDisabled;
      }
    }
    close.disabled = applying;
  };
  const metadata = () => {
    if (client.evidence?.length)
      body.append(
        paths(
          t('connections.detected_paths'),
          client.evidence.map((e) => `${evidenceLabel(e.kind)} · ${e.path}`),
        ),
      );
  };
  const guideLink = () => {
    if (!client.guide) return;
    const guide = el('a', undefined, 'local-guide');
    guide.href = client.guide;
    guide.target = '_blank';
    guide.rel = 'noopener noreferrer';
    guide.append(el('span', t('connections.vendor_guide')), icon('external-link'));
    body.append(guide);
  };

  const resolved = resolveClientTargets(client);
  const tabs = [];
  if (resolved.api)
    tabs.push({ id: 'api', label: t('connections.tab_api'), target: resolved.api, channel: 'api' });
  if (resolved.mcp)
    tabs.push({ id: 'mcp', label: t('connections.tab_mcp'), target: resolved.mcp, channel: 'mcp' });
  if (resolved.manual && (client.connection === 'manual' || tabs.length > 0))
    tabs.push({ id: 'manual', label: t('connections.tab_manual') });

  if (!tabs.length) {
    body.append(el('p', t('connections.receiver_unavailable'), 'local-notice'));
    if (client.protocol) body.append(el('p', protocolName(client.protocol), 'local-protocol'));
    metadata();
    guideLink();
    actions.append(
      button(t('common.close'), '', () => dlg.close(), 'subtle'),
      button(
        t('connections.backends'),
        'server',
        () => {
          dlg.close();
          location.hash = 'nodes';
        },
        'primary',
      ),
    );
    form.onsubmit = (event) => event.preventDefault();
    openDialog(dlg.id);
    return;
  }

  let activeTab =
    (existing?.channel && tabs.find((tab) => tab.channel === existing.channel)?.id) ?? tabs[0].id;
  let plan = null;
  const draft = {
    agent: existing?.agent ?? '',
    model: existing?.model ?? 'auto',
    toolMode: existing?.tool_mode,
  };

  const renderTabBar = () => {
    if (tabs.length < 2) return;
    const bar = el('div', undefined, 'segmented small local-channel-tabs');
    bar.setAttribute('role', 'tablist');
    for (const tab of tabs) {
      const btn = button(tab.label, '', () => {
        if (busy || activeTab === tab.id) return;
        activeTab = tab.id;
        draft.agent = '';
        renderView();
      });
      const selected = activeTab === tab.id;
      btn.classList.toggle('active', selected);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(selected));
      bar.append(btn);
    }
    body.append(bar);
  };

  const eligibleSources = (targetId) =>
    (data.sources ?? []).filter(
      (s) => s.available && !(s.blocked_targets ?? []).includes(targetId),
    );

  const renderManualTab = () => {
    body.replaceChildren();
    actions.replaceChildren();
    failure.textContent = '';
    renderTabBar();
    body.append(el('p', t('connections.manual_hint'), 'local-notice'));
    if (client.protocol) body.append(el('p', protocolName(client.protocol), 'local-protocol'));
    if (client.id === 'qoder') body.append(el('p', t('connections.qoder_hint'), 'muted'));
    metadata();
    guideLink();
    actions.append(button(t('common.close'), '', () => dlg.close(), 'subtle'));
    manualConnection(body, actions, client, dlg, valid);
    icons();
  };

  const renderManagedDraft = (tab) => {
    plan = null;
    body.replaceChildren();
    actions.replaceChildren();
    failure.textContent = '';
    renderTabBar();

    const targetId = tab.target;
    const channel = tab.channel;
    const targetInfo =
      data.targets?.[targetId] ??
      (targetId === 'dsh' ? data.target : { id: targetId, available: true, files: [] });
    const available = eligibleSources(targetId);
    const savedForTarget =
      (existing?.target === targetId ? existing : null) ??
      (data.data ?? []).find((item) => item.target === targetId);

    if (!draft.agent) {
      draft.agent = savedForTarget?.agent ?? (channel === 'mcp' ? '*' : (available[0]?.id ?? ''));
      draft.model = savedForTarget?.model ?? 'auto';
      draft.toolMode = savedForTarget?.tool_mode;
    }
    if (channel === 'api' && !available.some((s) => s.id === draft.agent))
      draft.agent = available[0]?.id ?? '';
    const source = available.find((s) => s.id === draft.agent);
    if (source) {
      if (!source.models.some((m) => m.selector === draft.model)) draft.model = 'auto';
      if (!source.tool_modes.includes(draft.toolMode)) draft.toolMode = source.default_tool_mode;
    }

    const route = el('div', undefined, 'local-route');
    route.append(
      agentGlyph(source?.engine ?? 'kernel', 'small'),
      el(
        'code',
        draft.agent === '*' ? t('connections.all_agents') : draft.agent || t('connections.source'),
      ),
      icon('arrow-right'),
      agentGlyph(client.icon, 'small'),
      el('span', client.name),
      el(
        'span',
        t(channel === 'mcp' ? 'connections.channel_mcp' : 'connections.channel_api'),
        'local-channel-tag',
      ),
    );
    body.append(route);

    if (targetInfo && !targetInfo.available)
      body.append(el('p', errorText(targetInfo.error), 'local-notice'));
    if (channel === 'api' && !available.length)
      body.append(el('p', t('connections.publish_first', { client: client.name }), 'local-notice'));

    if (channel === 'mcp' || available.length) {
      const fields = el('div', undefined, 'local-dialog-fields');
      const sourceChoices = [
        ...(channel === 'mcp' ? [{ value: '*', label: t('connections.all_agents') }] : []),
        ...(data.sources ?? []).map((s) => ({
          value: s.id,
          label: s.id,
          disabled: !s.available || (s.blocked_targets ?? []).includes(targetId),
        })),
      ];
      fields.append(
        selectField(t('connections.source'), sourceChoices, draft.agent, (value) => {
          draft.agent = value;
          const matched = (data.data ?? []).find(
            (item) => item.target === targetId && item.agent === value,
          );
          draft.model = matched?.model ?? 'auto';
          draft.toolMode = matched?.tool_mode;
          renderManagedDraft(tab);
          body.querySelector('select')?.focus();
        }),
      );
      if (source) {
        fields.append(
          selectField(
            t('connections.model'),
            (source.models ?? []).map((m) => ({
              value: m.selector,
              label: m.selector === 'auto' ? t('connections.auto') : m.name,
            })),
            draft.model,
            (value) => {
              draft.model = value;
            },
          ),
        );
        const mode = selectField(
          t('connections.tool_boundary'),
          (source.tool_modes ?? []).map((m) => ({
            value: m,
            label: t(`access.${m}`),
          })),
          draft.toolMode,
          (value) => {
            draft.toolMode = value;
          },
        );
        mode.querySelector('select').disabled = (source.tool_modes.length ?? 0) < 2;
        fields.append(mode);
      }
      body.append(fields);
    }

    if (targetInfo?.files?.length) body.append(paths(t('connections.files'), targetInfo.files));
    metadata();
    guideLink();

    actions.append(button(t('common.close'), '', () => dlg.close(), 'subtle'));
    if (savedForTarget) {
      actions.append(
        button(
          t('connections.disconnect'),
          'unplug',
          async () => {
            if (!valid() || busy) return;
            const agentName =
              savedForTarget.agent === '*' ? t('connections.all_agents') : savedForTarget.agent;
            if (
              !(await confirmAction({
                title: t('connections.disconnect'),
                message: t('connections.disconnect_body', {
                  agent: agentName,
                  client: client.name,
                }),
                accept: t('connections.disconnect'),
                danger: true,
              })) ||
              !valid()
            )
              return;
            setBusy(true);
            try {
              const result = await api('DELETE', `/v1/local/connections/${savedForTarget.id}`);
              if (!valid()) return;
              toast(
                result.configuration_removed
                  ? t('connections.removed')
                  : t('connections.preserved'),
              );
              state.keys = null;
              dlg.close();
              await refresh();
            } catch (error) {
              if (valid()) {
                setBusy(false);
                failure.textContent = error.message;
              }
            }
          },
          'subtle',
        ),
      );
    }
    const preview = button(t('connections.review'), 'arrow-right', () => {}, 'primary');
    preview.type = 'submit';
    preview.disabled =
      !targetInfo?.available || (channel === 'api' ? !source : draft.agent !== '*' && !source);
    actions.append(preview);
    icons();
  };

  const renderPlan = (tab) => {
    body.replaceChildren();
    const summary = el('dl', undefined, 'local-review');
    const rows = [
      [
        t('connections.channel'),
        t(plan.channel === 'mcp' ? 'connections.channel_mcp' : 'connections.channel_api'),
      ],
      [t('connections.source'), plan.agent === '*' ? t('connections.all_agents') : plan.agent],
    ];
    if (plan.agent !== '*') {
      rows.push(
        [t('connections.model'), plan.model === 'auto' ? t('connections.auto') : plan.model],
        [t('connections.models'), String(plan.model_count)],
        [t('connections.tool_boundary'), t(`access.${plan.tool_mode}`)],
      );
    }
    rows.push([t('connections.key_scope'), 'read · invoke · files']);
    if (plan.key_file) rows.push([t('connections.key_file'), plan.key_file]);
    if (plan.env_key) rows.push([t('connections.env_key'), plan.env_key]);

    for (const [label, value] of rows) {
      const row = el('div');
      row.append(el('dt', label), el('dd', value));
      summary.append(row);
    }
    body.append(
      el('h3', t('connections.confirm_title')),
      summary,
      el(
        'p',
        t(
          {
            connect: 'connections.plan_connect',
            sync: 'connections.plan_sync',
            repair: 'connections.plan_repair',
          }[plan.action] ?? 'connections.plan_connect',
          { client: client.name },
        ),
        'local-notice',
      ),
    );
    if (plan.execution === 'host') body.append(el('p', t('connections.host_hint'), 'local-notice'));
    if (plan.summary) {
      const previewDetails = el('details', undefined, 'local-paths local-diff-details');
      previewDetails.open = true;
      const pre = el('pre', undefined, 'local-plan-diff');
      pre.append(el('code', plan.summary));
      previewDetails.append(el('summary', t('connections.diff_preview')), pre);
      body.append(previewDetails);
    }
    if (plan.files?.length) body.append(paths(t('connections.files'), plan.files));

    const applyLabel =
      plan.action === 'sync'
        ? t('connections.sync')
        : plan.action === 'repair'
          ? t('connections.repair')
          : t('connections.connect', { client: client.name });
    const apply = button(applyLabel, 'plug', () => {}, 'primary');
    apply.type = 'submit';
    actions.replaceChildren(
      button(
        t('connections.edit'),
        'arrow-left',
        () => {
          renderManagedDraft(tab);
          body.querySelector('select')?.focus();
        },
        'subtle',
      ),
      apply,
    );
    icons();
    apply.focus();
  };

  const renderView = () => {
    const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
    if (tab.id === 'manual') renderManualTab();
    else renderManagedDraft(tab);
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const tab = tabs.find((item) => item.id === activeTab);
    if (!tab || tab.id === 'manual' || !valid() || busy) return;
    failure.textContent = '';
    applying = !!plan;
    setBusy(true);
    try {
      if (!plan) {
        const result = await api('POST', '/v1/local/connections/preview', {
          target: tab.target,
          channel: tab.channel,
          agent: draft.agent,
          model: draft.model,
          ...(draft.agent !== '*' && draft.toolMode ? { tool_mode: draft.toolMode } : {}),
        });
        if (!valid()) return;
        setBusy(false);
        plan = result;
        renderPlan(tab);
      } else {
        await api('POST', '/v1/local/connections/apply', {
          plan_id: plan.plan_id,
          target: plan.target,
          channel: plan.channel,
        });
        if (!valid()) return;
        state.keys = null;
        toast(t('connections.applied', { client: client.name }));
        dlg.close();
        await refresh();
      }
    } catch (error) {
      if (valid()) {
        setBusy(false);
        renderManagedDraft(tab);
        failure.textContent = error.message;
      }
    } finally {
      applying = false;
      if (dlg.isConnected) setBusy(false);
    }
  };
  renderView();
  openDialog(dlg.id);
}
