import { sessionApi } from '../lib/api.js';
import { button, el, iconButton, icons, toast, withBusy } from '../lib/dom.js';
import { load } from '../lib/live.js';
import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';

export function openEverythingAcpImport() {
  const token = state.token;
  const api = sessionApi(token);
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal');
  const header = el('header', undefined, 'dialog-heading');
  header.append(
    el('h2', 'EverythingACP'),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  const form = el('form');
  const directory = el('input');
  directory.autocomplete = 'off';
  const folderLabel = el('label', undefined, 'field');
  folderLabel.append(el('span', t('eacp.directory')), directory);
  const found = el('select');
  found.add(new Option('-', ''));
  found.hidden = true;
  let candidates = [];
  found.onchange = () => {
    const item = candidates.find((candidate) => candidate.client_file === found.value);
    if (item) {
      name.value = item.id;
      path.value = item.client_file;
    }
  };
  const scan = button(t('eacp.scan'), 'folder-search', async () => {
    try {
      await withBusy(scan, '', async () => {
        const result = await api(
          'GET',
          `/v1/local/everything-acp/discover?directory=${encodeURIComponent(directory.value)}`,
        );
        if (token !== state.token || !dialog.open) return;
        candidates = result.data.filter((item) => item.ready);
        found.replaceChildren(
          new Option('-', ''),
          ...candidates.map((item) => new Option(item.id, item.client_file)),
        );
        found.hidden = false;
      });
    } catch (e) {
      error.textContent = e.message;
    }
  });
  form.append(folderLabel, scan, found);
  const name = el('input');
  name.required = true;
  name.pattern = '[a-z0-9][a-z0-9_\\-]{0,63}';
  name.value = 'wrapped-agent';
  const path = el('input');
  path.required = true;
  path.placeholder = '/path/to/wrapper/client.json';
  path.autocomplete = 'off';
  for (const [label, input] of [
    [t('eacp.name'), name],
    [t('eacp.file'), path],
  ]) {
    const field = el('label', undefined, 'field');
    field.append(el('span', label), input);
    form.append(field);
  }
  const error = el('p', undefined, 'form-error');
  error.setAttribute('role', 'alert');
  const actions = el('div', undefined, 'dialog-actions');
  const submit = button(t('eacp.import'), 'download', () => {}, 'primary');
  submit.type = 'submit';
  actions.append(error, submit);
  form.append(actions);
  dialog.append(header, form);
  document.body.append(dialog);
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (state.token !== token) {
      dialog.close();
      return;
    }
    try {
      await withBusy(submit, '', async () => {
        await api('POST', '/v1/local/everything-acp/import', {
          id: name.value.trim(),
          client_file: path.value.trim(),
        });
        if (state.token !== token) return;
        dialog.close();
        await load();
        toast(t('eacp.imported'));
      });
    } catch (e) {
      error.textContent = e.message;
    }
  };
  dialog.showModal();
  icons();
  path.focus();
}
