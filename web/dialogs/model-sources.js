import { sessionApi } from '../lib/api.js';
import { state } from '../lib/state.js';
import { el, button, iconButton, icons, toast, withBusy } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

export async function openModelSources(agent, route) {
  const token = state.token,
    api = sessionApi(token),
    opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal wide-modal'),
    head = el('header', undefined, 'dialog-heading'),
    body = el('div');
  head.append(
    el('h2', t('sources.title')),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  dialog.append(head, body);
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  icons();
  const render = (data) => {
    if (!dialog.open || token !== state.token) return;
    body.replaceChildren(el('code', `${agent.id} / ${route.model}`));
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = data.settings.enabled;
    const label = el('label', undefined, 'inline-check');
    label.append(enabled, el('span', t('sources.enabled')));
    const config = el('textarea');
    config.rows = 12;
    config.value = JSON.stringify(data.settings.sources, null, 2);
    config.spellcheck = false;
    const field = el('label', undefined, 'field');
    field.append(el('span', t('sources.config')), config);
    const actions = el('div', undefined, 'dialog-actions');
    const save = button(t('evaluation.save'), 'check', async () => {
      try {
        await withBusy(save, '', async () =>
          render(
            await api('POST', '/v1/local/evaluations/sources', {
              agent: agent.id,
              route: route.id,
              revision: data.revision,
              settings: { enabled: enabled.checked, sources: JSON.parse(config.value) },
            }),
          ),
        );
      } catch (e) {
        toast(e.message);
      }
    });
    const refresh = button(t('sources.fetch'), 'refresh-cw', async () => {
      try {
        await withBusy(refresh, '', async () =>
          render(
            await api('POST', '/v1/local/evaluations/sources/refresh', {
              agent: agent.id,
              route: route.id,
            }),
          ),
        );
      } catch (e) {
        toast(e.message);
      }
    });
    refresh.disabled = !data.settings.enabled || data.running;
    enabled.onchange = config.oninput = () => {
      refresh.disabled = true;
    };
    actions.append(save, refresh);
    body.append(label, field, actions, el('pre', JSON.stringify(data.reports, null, 2), 'code'));
    icons();
  };
  try {
    render(
      await api(
        'GET',
        `/v1/local/evaluations/sources?agent=${encodeURIComponent(agent.id)}&route=${encodeURIComponent(route.id)}`,
      ),
    );
  } catch (e) {
    body.textContent = e.message;
  }
}
