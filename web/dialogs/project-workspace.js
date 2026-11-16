import { $, withBusy, toast } from '../lib/dom.js';
import { state, isNodeAdmin } from '../lib/state.js';
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';

const bindings = new Map();
export function openProjectOptions() {
  $('publish-project-use').checked = false;
  $('publish-project-use').disabled = !isNodeAdmin();
  $('publish-project-fields').hidden = true;
  $('publish-project-path').value = '';
  bindings.clear();
  if (isNodeAdmin()) {
    const token = state.token;
    void api('GET', '/v1/local/projects')
      .then((result) => {
        if (token === state.token)
          for (const item of result.data) bindings.set(item.agent, item.path);
      })
      .catch(() => {});
  }
}
export function projectWorkspaceSelection(agent) {
  if (!$('publish-project-use').checked) return 'session';
  if (!bindings.has(agent) || bindings.get(agent) !== $('publish-project-path').value.trim())
    throw Error(t('workspace.save_first'));
  return 'project';
}
$('publish-project-use').onchange = () => {
  $('publish-project-fields').hidden = !$('publish-project-use').checked;
  $('publish-project-path').value = bindings.get($('native-id').value.trim()) ?? '';
};
$('publish-project-bind').onclick = () =>
  withBusy($('publish-project-bind'), t('workspace.saving'), async () => {
    const agent = $('native-id').value.trim();
    const path = $('publish-project-path').value.trim();
    try {
      await api('POST', '/v1/local/projects', { agent, path });
      bindings.set(agent, path);
      $('publish-error').textContent = '';
      toast(t('workspace.saved'));
    } catch (error) {
      $('publish-error').textContent = error.message;
    }
  });
