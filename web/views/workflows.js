import { api as request, sessionApi } from '../lib/api.js';
import { state, isNodeAdmin } from '../lib/state.js';
import {
  el,
  button,
  iconButton,
  table,
  cell,
  icons,
  toast,
  withBusy,
  status,
  confirmAction,
} from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { editWorkflow } from '../dialogs/workflow-editor.js';
import { showRun } from '../dialogs/runs.js';

const triggerName = (kind) =>
  ({ manual: t('workflow.manual'), interval: t('workflow.interval'), event: t('workflow.event') })[
    kind
  ];
let archivedView = false;
const executionStatus = (run) => {
  if (run.status === 'cancelling') return el('span', t('workflow.cancelling'), 'status run');
  if (run.status === 'blocked') return el('span', t('workflow.blocked'), 'status warn');
  if (['running', 'queued'].includes(run.status) && run.progress?.waiting_on)
    return status(run.progress.waiting_on === 'owner' ? 'requires_action' : 'awaiting_caller');
  return status(run.status);
};
export async function renderWorkflows(parent) {
  const api = sessionApi();
  const token = state.token,
    toolbar = el('div', undefined, 'view-toolbar');
  const reload = () => {
    if (!parent.isConnected || state.view !== 'workflows' || token !== state.token) return;
    parent.replaceChildren();
    void renderWorkflows(parent);
  };
  toolbar.append(button(t('evaluation.refresh'), 'refresh-cw', reload));
  if (isNodeAdmin())
    toolbar.append(
      button(t('workflow.create'), 'workflow', () =>
        editWorkflow(null, () => {
          archivedView = false;
          reload();
        }),
      ),
    );
  const modes = el('div', undefined, 'segmented');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', t('workflow.state'));
  for (const archived of [false, true]) {
    const mode = button(
      archived ? t('workflow.archived') : t('workflow.active'),
      archived ? 'archive' : 'workflow',
      () => {
        archivedView = archived;
        reload();
      },
    );
    mode.setAttribute('aria-pressed', String(archived === archivedView));
    modes.append(mode);
  }
  toolbar.append(modes);
  parent.append(toolbar);
  const content = el('div');
  parent.append(content);
  try {
    const [definitions, runs] = await Promise.all([
      api('GET', `/v1/workflows?archived=${archivedView}`),
      api('GET', '/v1/workflow-runs'),
    ]);
    if (token !== state.token || !parent.isConnected) return;
    content.append(
      table(
        [
          { text: t('project.name') },
          { text: t('workflow.trigger') },
          { text: t('workflow.state') },
          { text: '' },
        ],
        definitions.data.map((record) => {
          const row = el('tr'),
            actions = el('div', undefined, 'row-actions');
          if (isNodeAdmin())
            if (record.archived_at)
              actions.append(
                iconButton(t('workflow.restore'), 'archive-restore', () =>
                  archiveWorkflow(record, false, reload),
                ),
              );
            else
              actions.append(
                iconButton(t('workflow.editor'), 'pencil', () => editWorkflow(record, reload)),
                iconButton(t('workflow.archive'), 'archive', () =>
                  archiveWorkflow(record, true, reload),
                ),
              );
          if (!record.archived_at)
            actions.append(button(t('workflow.run'), 'play', () => runWorkflow(record, reload)));
          const triggerState = el('div');
          if (record.archived_at) triggerState.textContent = t('workflow.archived');
          else if (record.definition.trigger.kind === 'manual')
            triggerState.textContent = t('workflow.manual');
          else if (isNodeAdmin()) {
            const label = el('label', undefined, 'inline-check'),
              toggle = el('input');
            toggle.type = 'checkbox';
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-label', t('workflow.enabled'));
            toggle.checked = record.definition.enabled;
            label.append(
              toggle,
              el('span', record.definition.enabled ? t('workflow.enabled') : t('workflow.paused')),
            );
            toggle.onchange = async () => {
              toggle.disabled = true;
              try {
                await api('POST', '/v1/workflows', {
                  definition: { ...record.definition, enabled: toggle.checked },
                  revision: record.revision,
                });
                reload();
              } catch (error) {
                toggle.checked = record.definition.enabled;
                toggle.disabled = false;
                toast(error.message);
              }
            };
            triggerState.append(label);
          } else
            triggerState.textContent = record.definition.enabled
              ? t('workflow.enabled')
              : t('workflow.paused');
          if (record.trigger_status?.error)
            triggerState.append(el('small', record.trigger_status.error, 'muted'));
          row.append(
            cell(record.definition.name),
            cell(triggerName(record.definition.trigger.kind)),
            cell(triggerState),
            cell(actions),
          );
          return row;
        }),
      ),
      el('h2', t('workflow.executions'), 'workflow-history-heading'),
    );
    content.append(
      table(
        [
          { text: t('project.name') },
          { text: t('workflow.state') },
          { text: t('workflow.started') },
          { text: '' },
        ],
        runs.data.map((run) => {
          const row = el('tr'),
            actions = el('div', undefined, 'row-actions');
          actions.append(
            button(t('project.open'), 'list-tree', () => inspectExecution(run, reload)),
          );
          executionControls(actions, run, api, reload);
          const stateNode = el('div', undefined, 'workflow-execution-state');
          stateNode.append(executionStatus(run));
          if (run.progress?.started)
            stateNode.append(el('small', t('workflow.progress', run.progress), 'muted'));
          if (run.error) stateNode.append(el('small', run.error, 'muted'));
          row.append(
            cell(run.definition.name),
            cell(stateNode),
            cell(new Date(run.createdAt).toLocaleString()),
            cell(actions),
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
function executionControls(parent, run, api, changed) {
  const action = (label, icon, command) => {
    const control = iconButton(label, icon, async () => {
      try {
        await withBusy(control, '', () =>
          api('POST', `/v1/workflow-runs/${run.id}/${command}`, {}),
        );
        await changed();
      } catch (error) {
        toast(error.message);
      }
    });
    parent.append(control);
  };
  if (['queued', 'running', 'blocked'].includes(run.status))
    action(t('workflow.cancel'), 'square', 'cancel');
  if (run.status === 'blocked' && !run.cancel_requested)
    action(t('workflow.resume'), 'play', 'resume');
}
async function archiveWorkflow(record, archived, reload) {
  const api = sessionApi();
  if (
    archived &&
    !(await confirmAction({
      title: t('workflow.archive'),
      message: t('workflow.archive_confirm'),
      accept: t('workflow.archive'),
    }))
  )
    return;
  try {
    await api(
      'POST',
      `/v1/workflows/${encodeURIComponent(record.definition.id)}/${archived ? 'archive' : 'restore'}`,
      { revision: record.revision },
    );
    reload();
  } catch (error) {
    toast(error.message);
  }
}
function modal(title) {
  const opener = document.activeElement,
    dialog = el('dialog', undefined, 'modal wide-modal');
  const header = el('header', undefined, 'dialog-heading'),
    body = el('div', undefined, 'inspector-body');
  header.append(
    el('h2', title),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  dialog.append(header, body);
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
  return { dialog, body };
}
function runWorkflow(record, reload) {
  const api = sessionApi();
  const { dialog, body } = modal(record.definition.name),
    form = el('form');
  const label = el('label', undefined, 'field'),
    input = el('textarea');
  input.rows = 6;
  input.value = '{"task":""}';
  label.append(el('span', t('workflow.input')), input);
  const attachmentsLabel = el('label', undefined, 'field'),
    attachments = el('input');
  attachments.type = 'file';
  attachments.multiple = true;
  attachmentsLabel.append(el('span', t('workflow.files')), attachments);
  const start = button(t('workflow.run'), 'play', () => {}, 'primary');
  start.type = 'submit';
  form.append(label, attachmentsLabel, start);
  body.append(form);
  icons();
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const data = JSON.parse(input.value);
      await withBusy(start, '', async () => {
        const files = [];
        for (const file of attachments.files) {
          if (file.size > 8 * 1024 * 1024) throw Error(t('dlg.agent.err.file_too_large'));
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          files.push(
            (
              await api('POST', '/v1/files', {
                filename: file.name,
                content: btoa(binary),
                encoding: 'base64',
              })
            ).id,
          );
        }
        await api('POST', `/v1/workflows/${encodeURIComponent(record.definition.id)}/run`, {
          input: data,
          file_ids: files,
        });
        dialog.close();
        reload();
      });
    } catch (error) {
      toast(error.message);
    }
  };
}
async function inspectExecution(run, reload) {
  const token = state.token,
    controller = new AbortController();
  const { dialog, body } = modal(run.definition.name);
  let timer,
    pending = false,
    signature = '';
  dialog.addEventListener(
    'close',
    () => {
      clearTimeout(timer);
      controller.abort();
    },
    { once: true },
  );
  const refresh = async () => {
    clearTimeout(timer);
    if (!dialog.open || pending) return;
    if (token !== state.token) return dialog.close();
    pending = true;
    try {
      const result = await request('GET', `/v1/workflow-runs/${run.id}`, undefined, {
        token,
        signal: controller.signal,
      });
      if (!dialog.open || token !== state.token) return dialog.close();
      const next = JSON.stringify([result.status, result.progress, result.error, result.stages]);
      if (next !== signature) {
        signature = next;
        const heading = el('div', undefined, 'view-toolbar');
        heading.append(
          executionStatus(result),
          button(t('evaluation.refresh'), 'refresh-cw', refresh),
        );
        executionControls(heading, result, sessionApi(token), refresh);
        if (result.progress?.started)
          heading.append(el('span', t('workflow.progress', result.progress), 'muted'));
        body.replaceChildren(heading);
        if (result.error) body.append(el('p', result.error, 'form-error'));
        const stages =
          result.stages ??
          Object.entries(result.nodes).map(([stage, run_id]) => ({
            stage,
            run_id,
            status: 'unavailable',
          }));
        body.append(
          table(
            [{ text: t('workflow.stage') }, { text: t('workflow.state') }],
            stages.map((stage) => {
              const row = el('tr');
              row.append(
                cell(button(stage.stage, 'activity', () => showRun(stage.run_id))),
                cell(status(stage.waiting_on === 'caller' ? 'awaiting_caller' : stage.status)),
              );
              return row;
            }),
          ),
          Object.hasOwn(result, 'output')
            ? el('pre', JSON.stringify(result.output, null, 2), 'code')
            : el('p', t('workflow.no_result'), 'muted'),
        );
        icons();
        reload();
      }
      if (['queued', 'running', 'cancelling', 'blocked'].includes(result.status))
        timer = setTimeout(refresh, document.hidden ? 10000 : 2000);
    } catch (error) {
      if (controller.signal.aborted || !dialog.open) return;
      if (token !== state.token) return dialog.close();
      body.replaceChildren(
        el('p', error.message, 'form-error'),
        button(t('evaluation.refresh'), 'refresh-cw', refresh),
      );
      signature = '';
      icons();
    } finally {
      pending = false;
    }
  };
  await refresh();
}
