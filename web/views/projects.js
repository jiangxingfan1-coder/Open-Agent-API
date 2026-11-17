import { sessionApi } from '../lib/api.js';
import { isNodeAdmin, state } from '../lib/state.js';
import {
  el,
  button,
  iconButton,
  table,
  cell,
  icons,
  toast,
  confirmAction,
  withBusy,
} from '../lib/dom.js';
import { t } from '../lib/i18n.js';
const accessNames = () => ({
  read: t('project.read'),
  write: t('project.write'),
  none: t('project.revoke'),
});

function modal(title) {
  const opener = document.activeElement,
    dialog = el('dialog', undefined, 'modal wide-modal');
  const header = el('header', undefined, 'dialog-heading'),
    body = el('div');
  header.append(
    el('h2', title),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
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
  return { dialog, body };
}
function field(form, title, value = '', multiline = false) {
  const label = el('label', undefined, 'field'),
    input = el(multiline ? 'textarea' : 'input');
  input.value = value;
  input.required = true;
  if (multiline) input.rows = 7;
  label.append(el('span', title), input);
  form.append(label);
  return input;
}
export async function renderProjects(parent) {
  const token = state.token;
  const api = sessionApi(token);
  const toolbar = el('div', undefined, 'view-toolbar');
  toolbar.append(
    button(t('evaluation.refresh'), 'refresh-cw', () => {
      parent.replaceChildren();
      void renderProjects(parent);
    }),
  );
  if (isNodeAdmin())
    toolbar.append(
      button(t('project.create'), 'folder-plus', () => {
        const { dialog, body } = modal(t('project.create')),
          form = el('form');
        const id = field(form, t('project.id')),
          name = field(form, t('project.name'));
        id.pattern = '[A-Za-z0-9][A-Za-z0-9_.-]{0,119}';
        const save = button(t('evaluation.save'), 'check', () => {}, 'primary');
        save.type = 'submit';
        form.append(save);
        body.append(form);
        form.onsubmit = async (event) => {
          event.preventDefault();
          try {
            await withBusy(save, '', () =>
              api('POST', '/v1/projects', { id: id.value, name: name.value }),
            );
            dialog.close();
            parent.replaceChildren();
            void renderProjects(parent);
          } catch (error) {
            toast(error.message);
          }
        };
      }),
    );
  parent.append(toolbar);
  const content = el('div');
  parent.append(content);
  try {
    const result = await api('GET', '/v1/projects');
    if (token !== state.token || !parent.isConnected) return;
    content.append(
      table(
        [{ text: t('project.name') }, { text: t('project.id') }, { text: '' }],
        result.data.map((project) => {
          const row = el('tr');
          row.append(
            cell(project.name),
            cell(project.id),
            cell(button(t('project.open'), 'notebook-pen', () => openProject(project))),
          );
          return row;
        }),
      ),
    );
    icons();
  } catch (error) {
    content.textContent = error.message;
  }
}
async function openProject(project) {
  const token = state.token,
    { dialog, body } = modal(project.name);
  const api = sessionApi(token);
  const endpoint = `/v1/projects/${encodeURIComponent(project.id)}`;
  const refresh = async () => {
    const result = await api('GET', `${endpoint}/memory`);
    if (!dialog.open || token !== state.token) return;
    body.replaceChildren();
    const toolbar = el('div', undefined, 'view-toolbar');
    if (project.access === 'write')
      toolbar.append(button(t('project.add_note'), 'plus', () => editNote()));
    toolbar.append(
      button(t('evaluation.refresh'), 'refresh-cw', () => refresh().catch((e) => toast(e.message))),
    );
    if (isNodeAdmin()) toolbar.append(button(t('project.members'), 'users', () => manageMembers()));
    body.append(
      toolbar,
      table(
        [
          { text: t('project.namespace') },
          { text: t('project.key') },
          { text: t('project.content') },
          { text: '' },
        ],
        result.data.map((entry) => {
          const row = el('tr'),
            actions = el('div', undefined, 'row-actions');
          if (project.access === 'write')
            actions.append(
              iconButton(t('project.edit'), 'pencil', () => editNote(entry)),
              iconButton(t('project.remove'), 'trash-2', async () => {
                if (
                  !(await confirmAction({
                    title: t('project.remove'),
                    message: `${entry.namespace}/${entry.key}`,
                    accept: t('project.remove'),
                    danger: true,
                  }))
                )
                  return;
                try {
                  await api('DELETE', `${endpoint}/memory`, {
                    namespace: entry.namespace,
                    key: entry.key,
                    revision: entry.revision,
                  });
                  await refresh();
                } catch (error) {
                  toast(error.message);
                }
              }),
            );
          const text = JSON.stringify(entry.value);
          row.append(
            cell(entry.namespace),
            cell(entry.key),
            cell(text.length > 180 ? text.slice(0, 180) + '...' : text),
            cell(actions),
          );
          return row;
        }),
      ),
    );
    icons();
  };
  const editNote = (entry) => {
    const editor = modal(t('project.edit')),
      form = el('form');
    const ns = field(form, t('project.namespace'), entry?.namespace ?? 'shared'),
      key = field(form, t('project.key'), entry?.key ?? ''),
      value = field(form, t('project.json'), JSON.stringify(entry?.value ?? '', null, 2), true);
    ns.disabled = key.disabled = !!entry;
    const save = button(t('evaluation.save'), 'check', () => {}, 'primary');
    save.type = 'submit';
    form.append(save);
    editor.body.append(form);
    icons();
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        const data = JSON.parse(value.value);
        await withBusy(save, '', () =>
          api('PUT', `${endpoint}/memory`, {
            namespace: ns.value,
            key: key.value,
            value: data,
            revision: entry?.revision ?? 'new',
          }),
        );
        editor.dialog.close();
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    };
  };
  const manageMembers = async () => {
    const members = modal(t('project.members')),
      form = el('form');
    const subject = field(form, t('project.subject')),
      access = el('select');
    for (const right of ['read', 'write', 'none'])
      access.add(new Option(accessNames()[right], right));
    const label = el('label', undefined, 'field');
    label.append(el('span', t('project.access')), access);
    form.append(label);
    const save = button(t('evaluation.save'), 'check', () => {}, 'primary');
    save.type = 'submit';
    form.append(save);
    members.body.append(form);
    const listing = el('div');
    members.body.append(listing);
    const load = async () => {
      const result = await api('GET', `${endpoint}/members`);
      listing.replaceChildren(
        table(
          [{ text: t('project.subject') }, { text: t('project.access') }],
          result.data.map((m) => {
            const row = el('tr');
            row.append(cell(m.subject), cell(accessNames()[m.access]));
            return row;
          }),
        ),
      );
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await withBusy(save, '', () =>
          api('POST', `${endpoint}/members`, { subject: subject.value, access: access.value }),
        );
        await load();
      } catch (error) {
        toast(error.message);
      }
    };
    try {
      await load();
      icons();
    } catch (error) {
      toast(error.message);
    }
  };
  try {
    await refresh();
  } catch (error) {
    body.textContent = error.message;
  }
}
