import { sessionApi } from '../lib/api.js';
import { isNodeAdmin } from '../lib/state.js';
import { el, iconButton, icons, toast } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

export function renderModelFeedback(parent, run, token) {
  const enabled = isNodeAdmin() && run.feedback_eligible;
  if (!enabled) {
    parent.replaceChildren();
    delete parent.dataset.run;
    return;
  }
  if (parent.dataset.run === run.id) return;
  parent.dataset.run = run.id;
  parent.replaceChildren(el('span', t('feedback.result'), 'muted'));
  const api = sessionApi(token),
    controls = [];
  for (const passed of [true, false]) {
    const control = iconButton(
      passed ? t('feedback.good') : t('feedback.bad'),
      passed ? 'thumbs-up' : 'thumbs-down',
      async () => {
        try {
          await api('POST', '/v1/local/evaluations/feedback', { run_id: run.id, passed });
          for (const item of controls) item.setAttribute('aria-pressed', String(item === control));
          toast(t('feedback.saved'));
        } catch (error) {
          toast(error.message);
        }
      },
    );
    control.setAttribute('aria-pressed', 'false');
    control.disabled = passed && run.status !== 'completed';
    controls.push(control);
    parent.append(control);
  }
  icons();
}
