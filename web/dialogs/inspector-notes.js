import { el, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

// Task details: the agent line under the title and the "needs a person" note (created by run-inspector.js).
export function createNotes({ $, dialog }) {
  let attention = null;
  let agentLine = null;
  const ensure = () => {
    if (!attention) {
      attention = el('div', undefined, 'run-attention');
      attention.id = 'run-attention';
      attention.setAttribute('role', 'status');
      attention.hidden = true;
      $('run-error').before(attention);
    }
    if (!agentLine) {
      agentLine = el('div');
      agentLine.id = 'run-agent';
      agentLine.translate = false;
      $('run-title').after(agentLine);
    }
    const eyebrow = dialog.querySelector('.sheet-heading .eyebrow');
    if (eyebrow) eyebrow.textContent = t('insp.note.eyebrow');
  };
  // An interrupted task is waiting for a person to decide; this is one of the few places marked in vermilion.
  function attentionText(data) {
    if (data.status !== 'interrupted') return null;
    const uncertain = Number(data.steps?.uncertain) || 0;
    if (uncertain > 0)
      return [
        t('insp.note.uncertain_title'),
        t(uncertain === 1 ? 'insp.note.uncertain_text_one' : 'insp.note.uncertain_text', {
          n: uncertain,
        }),
      ];
    if (data.engine !== 'kernel')
      return [t('insp.note.external_title'), t('insp.note.external_text')];
    return [t('insp.note.waiting_title'), t('insp.note.waiting_text')];
  }
  function render(data) {
    ensure();
    agentLine.textContent = data.agent ?? '';
    const note = attentionText(data);
    attention.hidden = !note;
    if (!note) return attention.replaceChildren();
    const body = el('div');
    body.append(el('strong', note[0]), el('br'), document.createTextNode(note[1]));
    attention.replaceChildren(icon('triangle-alert'), body);
  }
  function reset() {
    ensure();
    attention.hidden = true;
    attention.replaceChildren();
    agentLine.textContent = '';
  }
  return { render, reset };
}
