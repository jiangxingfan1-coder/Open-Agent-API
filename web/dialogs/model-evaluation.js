import { api } from '../lib/api.js';
import { el, button, iconButton, icons, table, cell, toast, withBusy } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { t, locale } from '../lib/i18n.js';
import { openModelSources } from './model-sources.js';

export async function openModelEvaluation(agent) {
  const token = state.token;
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal wide-modal model-evaluation-dialog');
  const head = el('header', undefined, 'dialog-heading');
  head.append(
    el('h2', t('evaluation.title')),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  const body = el('div', undefined, 'dialog-body');
  body.append(el('code', agent.id), el('p', t('evaluation.loading'), 'muted'));
  dialog.append(head, body);
  document.body.append(dialog);
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();
  icons();
  const load = () => api('GET', `/v1/local/evaluations?agent=${encodeURIComponent(agent.id)}`);
  const render = (data) => {
    if (!dialog.open || token !== state.token) return;
    body.replaceChildren(el('code', agent.id));
    const controls = el('div', undefined, 'evaluation-controls');
    const toggle = el('label', undefined, 'inline-check');
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = data.settings.enabled;
    enabled.disabled = !data.supported && !data.settings.enabled;
    toggle.append(enabled, el('span', t('evaluation.automatic')));
    const field = el('label', undefined, 'field');
    field.append(el('span', t('evaluation.daily_budget')));
    const budget = el('input');
    budget.type = 'number';
    budget.min = '8';
    budget.max = '2048';
    budget.step = '8';
    budget.value = String(data.settings.maxCallsPerDay);
    field.append(budget);
    const save = button(t('evaluation.save'), 'check', async () => {
      if (!budget.reportValidity()) return;
      try {
        await withBusy(save, '', async () =>
          render(
            await api('POST', '/v1/local/evaluations/settings', {
              agent: agent.id,
              revision: data.settings_revision,
              settings: {
                ...data.settings,
                enabled: enabled.checked,
                maxCallsPerDay: Number(budget.value),
              },
            }),
          ),
        );
      } catch (error) {
        toast(error.message);
      }
    });
    save.disabled = !data.supported && !data.settings.enabled;
    const refresh = button(t('evaluation.refresh'), 'refresh-cw', async () => {
      try {
        render(await load());
      } catch (error) {
        toast(error.message);
      }
    });
    controls.append(toggle, field, save, refresh);
    body.append(controls, el('p', t('evaluation.scope'), 'muted'));
    if (!data.supported) body.append(el('p', t('evaluation.unsupported'), 'callout'));
    if (data.running) body.append(el('p', t('evaluation.running'), 'muted'));
    body.append(
      table(
        [
          { text: t('evaluation.model') },
          { text: t('evaluation.score') },
          { text: t('evaluation.samples') },
          { text: t('evaluation.duration') },
          { text: t('evaluation.observed') },
          { text: '' },
        ],
        data.routes.map((route) => {
          const row = el('tr'),
            p = route.performance;
          if (p?.sources) row.title = t('feedback.sources', p.sources);
          row.append(
            cell(route.model),
            cell(
              p ? `${Math.round(p.score * 100)}%` : (route.last_error ?? t('evaluation.unknown')),
              'num',
            ),
            cell(p ? `${p.passed}/${p.samples}` : '-', 'num'),
            cell(p ? `${(p.averageMs / 1000).toFixed(1)} s` : '-', 'num'),
            cell(p ? new Date(p.observedAt).toLocaleString(locale()) : '-'),
            cell(iconButton(t('sources.title'), 'book-open', () => openModelSources(agent, route))),
          );
          return row;
        }),
      ),
    );
    icons();
  };
  try {
    render(await load());
  } catch (error) {
    if (dialog.open) body.replaceChildren(el('p', error.message));
  }
}
