import { api } from '../lib/api.js';
import { el, button, iconButton, icons, toast, withBusy } from '../lib/dom.js';
import { load } from '../lib/live.js';
import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';

export async function openAgentPolicy(agent) {
  const token = state.token;
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal');
  const header = el('header', undefined, 'dialog-heading');
  header.append(
    el('h2', t('policy.title')),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  const body = el('div');
  body.append(el('p', t('evaluation.loading'), 'muted'));
  dialog.append(header, body);
  document.body.append(dialog);
  dialog.showModal();
  icons();
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  try {
    const bundle = await api('GET', `/v1/agents/definition?agent=${encodeURIComponent(agent.id)}`);
    if (token !== state.token || !dialog.open) return;
    if (bundle.digest !== agent.version) throw Error(t('policy.changed'));
    body.replaceChildren(el('code', agent.id));
    const form = el('form');
    const approvals = el('input');
    approvals.type = 'checkbox';
    approvals.checked = bundle.agent.access
      ? bundle.agent.access.approval !== 'auto'
      : bundle.agent.approvals !== 'auto';
    const approveLabel = el('label', undefined, 'inline-check');
    approveLabel.append(approvals, el('span', t('policy.approvals')));
    const orchestration = el('input');
    orchestration.type = 'checkbox';
    orchestration.checked = !!bundle.agent.orchestration?.enabled;
    const orchestrateLabel = el('label', undefined, 'inline-check');
    orchestrateLabel.append(orchestration, el('span', t('policy.orchestration')));
    const timeoutLabel = el('label', undefined, 'field');
    const timeout = el('input');
    timeout.type = 'number';
    timeout.min = '0.01';
    timeout.max = '168';
    timeout.step = 'any';
    timeout.value = String(bundle.agent.limits.timeoutMs / 3600000);
    timeoutLabel.append(el('span', t('project.timeout')), timeout);
    const error = el('p', undefined, 'form-error');
    error.setAttribute('role', 'alert');
    const save = button(t('evaluation.save'), 'check', () => {}, 'primary');
    save.type = 'submit';
    const actions = el('div', undefined, 'dialog-actions');
    actions.append(error, save);
    form.append(
      approveLabel,
      orchestrateLabel,
      timeoutLabel,
      el('p', t('policy.note'), 'muted'),
      actions,
    );
    body.append(form);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (token !== state.token) {
        dialog.close();
        return;
      }
      try {
        await withBusy(save, '', async () => {
          await api('POST', '/v1/agents/policy', {
            agent: agent.id,
            version: bundle.digest,
            approval: approvals.checked ? 'ask' : 'auto',
            orchestration: orchestration.checked,
            timeout_ms: Math.round(Number(timeout.value) * 3600000),
          });
          if (token !== state.token) return;
          dialog.close();
          document.getElementById('agent-dialog').close();
          await load();
          toast(t('policy.saved'));
        });
      } catch (e) {
        error.textContent = e.message;
      }
    };
    icons();
  } catch (error) {
    if (dialog.open) body.replaceChildren(el('p', error.message, 'form-error'));
  }
}
