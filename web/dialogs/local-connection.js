import { state } from '../lib/state.js';
import { api, errorText } from '../lib/api.js';
import { agentGlyph, button, el, icon, iconButton, icons, openDialog, toast } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { manualConnection } from './local-connection-manual.js';

export const connectionMode = (client) =>
  t(
    {
      managed: 'connections.mode_managed',
      manual: 'connections.mode_manual',
      unavailable: 'connections.mode_unavailable',
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

  if (client.id !== 'dsh') {
    body.append(
      el(
        'p',
        t(
          client.connection === 'manual'
            ? 'connections.manual_hint'
            : 'connections.receiver_unavailable',
        ),
        'local-notice',
      ),
    );
    if (client.protocol) body.append(el('p', protocolName(client.protocol), 'local-protocol'));
    if (client.id === 'qoder') body.append(el('p', t('connections.qoder_hint'), 'muted'));
    metadata();
    if (client.guide) {
      const guide = el('a', undefined, 'local-guide');
      guide.href = client.guide;
      guide.target = '_blank';
      guide.rel = 'noopener noreferrer';
      guide.append(el('span', t('connections.vendor_guide')), icon('external-link'));
      body.append(guide);
    }
    actions.append(button(t('common.close'), '', () => dlg.close(), 'subtle'));
    if (client.connection === 'manual') manualConnection(body, actions, client, dlg, valid);
    else
      actions.append(
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

  const available = data.sources.filter((s) => s.available);
  const saved = existing ?? data.data.find((item) => item.agent === available[0]?.id);
  const draft = {
    agent: saved?.agent ?? available[0]?.id ?? '',
    model: saved?.model ?? 'auto',
    toolMode: saved?.tool_mode,
  };
  let plan = null;
  const field = (label, choices, value, changed) => {
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
  };
  const renderDraft = () => {
    plan = null;
    body.replaceChildren();
    actions.replaceChildren();
    failure.textContent = '';
    const source = available.find((s) => s.id === draft.agent);
    if (!source?.models.some((m) => m.selector === draft.model)) draft.model = 'auto';
    if (!source?.tool_modes.includes(draft.toolMode)) draft.toolMode = source?.default_tool_mode;
    const route = el('div', undefined, 'local-route');
    route.append(
      agentGlyph(source?.engine ?? 'kernel', 'small'),
      el('code', draft.agent || t('connections.source')),
      icon('arrow-right'),
      agentGlyph('dsh', 'small'),
      el('span', 'DSH'),
    );
    body.append(route);
    if (!data.target.available) body.append(el('p', errorText(data.target.error), 'local-notice'));
    if (!available.length) body.append(el('p', t('connections.publish_first'), 'local-notice'));
    if (available.length) {
      const fields = el('div', undefined, 'local-dialog-fields');
      fields.append(
        field(
          t('connections.source'),
          data.sources.map((s) => ({
            value: s.id,
            label: s.id,
            disabled: !s.available,
          })),
          draft.agent,
          (value) => {
            draft.agent = value;
            const saved = data.data.find((s) => s.agent === value);
            draft.model = saved?.model ?? 'auto';
            draft.toolMode = saved?.tool_mode;
            renderDraft();
            body.querySelector('select')?.focus();
          },
        ),
      );
      fields.append(
        field(
          t('connections.model'),
          (source?.models ?? []).map((m) => ({
            value: m.selector,
            label: m.selector === 'auto' ? t('connections.auto') : m.name,
          })),
          draft.model,
          (value) => {
            draft.model = value;
          },
        ),
      );
      const mode = field(
        t('connections.tool_boundary'),
        (source?.tool_modes ?? []).map((m) => ({
          value: m,
          label: t(`access.${m}`),
        })),
        draft.toolMode,
        (value) => {
          draft.toolMode = value;
        },
      );
      mode.querySelector('select').disabled = (source?.tool_modes.length ?? 0) < 2;
      fields.append(mode);
      body.append(fields);
    }
    if (data.target.files?.length) body.append(paths(t('connections.files'), data.target.files));
    metadata();
    const preview = button(t('connections.review'), 'arrow-right', () => {}, 'primary');
    preview.type = 'submit';
    preview.disabled = !source || !data.target.available;
    actions.append(
      button(t('common.close'), '', () => dlg.close(), 'subtle'),
      preview,
    );
    icons();
  };
  const renderPlan = () => {
    body.replaceChildren();
    const summary = el('dl', undefined, 'local-review');
    for (const [label, value] of [
      [t('connections.source'), draft.agent],
      [t('connections.model'), draft.model === 'auto' ? t('connections.auto') : draft.model],
      [t('connections.models'), String(plan.model_count)],
      [t('connections.tool_boundary'), t(`access.${plan.tool_mode}`)],
      [t('connections.key_scope'), 'read · invoke · files'],
    ]) {
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
        ),
        'local-notice',
      ),
    );
    if (plan.execution === 'host') body.append(el('p', t('connections.host_hint'), 'local-notice'));
    if (plan.files.length) body.append(paths(t('connections.files'), plan.files));
    const apply = button(
      t(
        plan.action === 'sync'
          ? 'connections.sync'
          : plan.action === 'repair'
            ? 'connections.repair'
            : 'connections.connect',
      ),
      'plug',
      () => {},
      'primary',
    );
    apply.type = 'submit';
    actions.replaceChildren(
      button(
        t('connections.edit'),
        'arrow-left',
        () => {
          renderDraft();
          body.querySelector('select')?.focus();
        },
        'subtle',
      ),
      apply,
    );
    icons();
    apply.focus();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!valid() || busy) return;
    failure.textContent = '';
    applying = !!plan;
    setBusy(true);
    try {
      if (!plan) {
        const result = await api('POST', '/v1/local/connections/preview', {
          agent: draft.agent,
          model: draft.model,
          ...(draft.toolMode ? { tool_mode: draft.toolMode } : {}),
        });
        if (!valid()) return;
        setBusy(false);
        plan = result;
        renderPlan();
      } else {
        await api('POST', '/v1/local/connections/apply', { plan_id: plan.plan_id });
        if (!valid()) return;
        state.keys = null;
        toast(t('connections.applied'));
        dlg.close();
        await refresh();
      }
    } catch (error) {
      if (valid()) {
        setBusy(false);
        // Re-preview after stale files, expired plans or a failed apply; never retry a stale write.
        renderDraft();
        failure.textContent = error.message;
      }
    } finally {
      applying = false;
      if (dlg.isConnected) setBusy(false);
    }
  };
  renderDraft();
  openDialog(dlg.id);
}

export function protocolName(protocol) {
  return (
    {
      responses: 'OpenAI Responses',
      messages: 'Anthropic Messages',
      'chat-completions': 'OpenAI Chat Completions',
    }[protocol] ?? ''
  );
}
