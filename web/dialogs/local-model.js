import { sessionApi } from '../lib/api.js';
import { button, el, iconButton, icons, toast } from '../lib/dom.js';
import { load } from '../lib/live.js';
import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';

let current;
export function closeLocalModel() {
  current?.close();
}

export function openLocalModel(client, refresh) {
  closeLocalModel();
  const token = state.token;
  const api = sessionApi(token);
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal local-connection-modal');
  current = dialog;
  dialog.id = 'local-model-dialog';
  dialog.setAttribute('aria-label', client.name);
  const form = el('form');
  const header = el('div', undefined, 'dialog-heading');
  const heading = el('div');
  heading.append(el('h2', client.name), el('p', t('localModels.kind'), 'dialog-desc'));
  let busy = false;
  const close = iconButton(t('common.close'), 'x', () => {
    if (!busy) dialog.close();
  });
  header.append(heading, close);
  const body = el('div', undefined, 'local-dialog-body');
  const saved = client.runtime.connections?.[0];
  const input = (label, value) => {
    const field = el('label', undefined, 'field');
    const control = el('input');
    control.value = value;
    control.autocomplete = 'off';
    field.append(el('span', label), control);
    body.append(field);
    return control;
  };
  const endpoint = input(t('localModels.endpoint'), saved?.base_url ?? client.runtime.base_url);
  endpoint.required = true;
  endpoint.type = 'url';
  const keyEnv = input(t('localModels.keyEnv'), saved?.key_env ?? '');
  keyEnv.pattern = '(?!OAA_)[A-Za-z_][A-Za-z0-9_]{0,127}';
  const provider = input(t('localModels.provider'), saved?.provider ?? `local-${client.id}`);
  provider.required = true;
  provider.pattern = '[a-z][a-z0-9_\\-]{0,63}';
  const agent = input(t('localModels.agent'), `agent/local-${client.id}`);
  agent.required = true;
  agent.pattern = 'agent\\/[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,100}';
  const field = el('label', undefined, 'field');
  const model = el('select');
  model.add(new Option('-', ''));
  model.required = true;
  model.disabled = true;
  field.append(el('span', t('localModels.model')), model);
  const status = el('p', t('localModels.unchecked'), 'muted');
  status.setAttribute('role', 'status');
  const error = el('p', undefined, 'form-error');
  error.setAttribute('role', 'alert');
  const args = () => ({
    runtime: client.id,
    base_url: endpoint.value.trim(),
    ...(keyEnv.value.trim() ? { key_env: keyEnv.value.trim() } : {}),
  });
  let checked = '';
  const valid = () => token === state.token && dialog.open;
  const lock = (value) => {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.querySelectorAll('input, button')) control.disabled = value;
    model.disabled = value || !checked;
    connect.disabled = value || !checked;
  };
  const probe = button(t('localModels.probe'), 'refresh-cw', async () => {
    if (!form.reportValidity()) return;
    error.textContent = '';
    checked = '';
    lock(true);
    try {
      const result = await api('POST', '/v1/local/model-runtimes/probe', args());
      if (!valid()) return;
      checked = result.status === 'ready' ? JSON.stringify(args()) : '';
      model.replaceChildren(new Option('-', ''), ...result.models.map((id) => new Option(id, id)));
      if (result.models.length) model.value = result.models[0];
      status.textContent =
        result.status === 'ready'
          ? t('localModels.modelCount', { n: result.models.length })
          : t(
              {
                unavailable: 'localModels.unavailable',
                empty: 'localModels.empty',
                authentication_required: 'localModels.authentication_required',
                key_missing: 'localModels.key_missing',
              }[result.status] ?? 'localModels.unavailable',
            );
    } catch (e) {
      if (valid()) error.textContent = e.message;
    } finally {
      if (valid()) lock(false);
    }
  });
  const reset = () => {
    checked = '';
    model.replaceChildren(new Option('-', ''));
    model.disabled = true;
    connect.disabled = true;
    status.textContent = t('localModels.unchecked');
  };
  endpoint.oninput = reset;
  keyEnv.oninput = reset;
  body.append(probe, field, status, error);
  const links = el('div', undefined, 'local-model-links');
  for (const [label, url] of [
    [t('localModels.download'), client.runtime.download_url],
    [t('localModels.docs'), client.guide],
  ]) {
    const link = el('a', label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    links.append(link);
  }
  const actions = el('div', undefined, 'dialog-actions');
  const connect = button(t('localModels.connect'), 'plug', () => {}, 'primary');
  connect.type = 'submit';
  connect.disabled = true;
  actions.append(links, connect);
  form.append(header, body, actions);
  dialog.append(form);
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (current === dialog) current = null;
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!valid() || busy || checked !== JSON.stringify(args()) || !model.value) return;
    error.textContent = '';
    lock(true);
    try {
      const result = await api('POST', '/v1/local/model-runtimes/connect', {
        ...args(),
        model: model.value,
        provider_name: provider.value.trim(),
        agent: agent.value.trim(),
      });
      if (!valid()) return;
      dialog.close();
      await load();
      await refresh(true);
      toast(t('localModels.connected', { agent: result.agent }));
    } catch (e) {
      if (valid()) error.textContent = e.message;
    } finally {
      if (valid()) lock(false);
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  icons();
  endpoint.focus();
}
