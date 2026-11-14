import { button, confirmAction, el, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { lang, t } from '../lib/i18n.js';

// Task details: approvals and waiting on the caller (created by run-inspector.js; dependencies come in as arguments).
export function createActions({
  $,
  formatDuration,
  bytes,
  download,
  base,
  permit,
  current,
  refresh,
  onChanged,
}) {
  const decisions = new Set();
  // Waiting for the caller to run its own tool (bridging) is not a manual approval: approve/reject
  // does not apply to it, so it is listed separately under "waiting on the caller".
  function renderCaller(calls) {
    const section = $('caller-section');
    const parent = $('run-caller');
    section.hidden = !calls.length;
    $('caller-count').textContent = calls.length || '';
    parent.replaceChildren();
    for (const action of calls) {
      let detail = null;
      try {
        detail = JSON.parse(action.detail.preview);
      } catch {
        // A truncated preview is not complete JSON: leave the tool name empty and show the arguments as they are.
      }
      const tool = typeof detail?.tool === 'string' ? detail.tool : t('insp.act.caller_tool');
      const args =
        detail && 'arguments' in detail
          ? JSON.stringify(detail.arguments, null, 2)
          : action.detail.preview;
      const flat = args.replace(/\s+/g, ' ');
      const left = action.expires_at - Date.now();
      const row = el('div', undefined, 'caller-call');
      const head = el('div', undefined, 'artifact');
      const name = el('span', tool, 'artifact-name');
      name.translate = false;
      head.append(
        icon('plug'),
        name,
        el(
          'span',
          left > 0 ? t('insp.act.left', { d: formatDuration(left) }) : t('insp.act.expired'),
          'muted',
        ),
      );
      const more = el('details', undefined, 'raw-details caller-args');
      more.append(
        el('summary', flat.length > 120 ? `${flat.slice(0, 120)}…` : flat),
        el(
          'pre',
          `${args}${action.detail.truncated ? t('insp.act.preview_truncated_line') : ''}`,
          'code small',
        ),
      );
      row.append(head, more);
      parent.append(row);
    }
  }
  function renderActions(v, data) {
    const parent = $('run-actions');
    const calls = data.data.filter((action) => action.kind === 'client_tool');
    renderCaller(calls);
    const approvals = data.total - calls.length;
    $('actions-heading').hidden =
      data.total === 0 ||
      (calls.length === data.data.length && v.actionsOffset === 0 && data.next_offset === null);
    $('action-count').textContent = approvals || '';
    const active = new Set(
      data.data.filter((action) => action.kind !== 'client_tool').map((action) => action.id),
    );
    for (const child of [...parent.children])
      if (!active.has(child.dataset.actionId)) child.remove();
    for (const action of data.data) {
      if (action.kind === 'client_tool') continue;
      if (v.resolved.has(action.id)) continue;
      let row = v.actionRows.get(action.id);
      if (!row) {
        row = el('details', undefined, 'approval-row');
        row.dataset.actionId = action.id;
        row.open = data.data.length === 1;
        const summary = el('summary');
        summary.append(
          icon('chevron-right'),
          el(
            'strong',
            action.kind === 'native' ? t('insp.act.native') : t('insp.act.tool_approval'),
          ),
          el('code', action.id),
          el(
            'span',
            t('insp.act.expires', {
              time: new Date(action.expires_at).toLocaleTimeString(
                lang === 'zh' ? 'zh-CN' : 'en-US',
                { hour12: false },
              ),
            }),
            'muted',
          ),
        );
        const heading = el('div', undefined, 'inspector-heading');
        heading.append(
          el(
            'span',
            `${bytes(action.detail.bytes)}${action.detail.truncated ? t('insp.act.preview_truncated') : ''}`,
            'muted',
          ),
        );
        const file = button(
          '',
          'download',
          () =>
            download(
              v,
              `${base(v)}/actions/${encodeURIComponent(action.id)}/content`,
              'approval.json',
            ),
          'icon-button',
        );
        file.title = t('insp.act.download');
        file.setAttribute('aria-label', file.title);
        heading.append(file);
        const preview = el('pre', action.detail.preview, 'code small');
        row.append(summary, heading, preview);
        let reply = null;
        if (action.kind === 'native' && permit('approve')) {
          // The reply is handed to the requesting agent as is, and every agent uses its own format, so
          // we do not guess one: approve with an empty reply by default, and fill it in under
          // "Advanced" only when content is really needed.
          const advanced = el('details', undefined, 'approval-advanced');
          advanced.append(el('summary', t('insp.act.advanced')));
          const label = el('label', undefined, 'field');
          label.append(
            el('span', t('insp.act.reply_label')),
            el('small', t('insp.act.reply_hint'), 'muted'),
          );
          reply = el('textarea');
          reply.rows = 3;
          reply.maxLength = 16384;
          reply.value = '{}';
          reply.setAttribute('aria-label', t('insp.act.reply_aria', { id: action.id }));
          label.append(reply);
          advanced.append(label);
          row.append(advanced);
        }
        const error = el('div', '', 'form-error');
        error.setAttribute('role', 'alert');
        const actions = el('div', undefined, 'approval-controls');
        if (permit('approve'))
          for (const decision of ['approve', 'deny']) {
            const control = button(
              decision === 'approve' ? t('insp.act.approve') : t('insp.act.reject'),
              decision === 'approve' ? 'check' : 'x',
              async () => {
                if (!current(v) || decisions.has(action.id)) return;
                if (decision === 'deny') {
                  const ok = await confirmAction({
                    title: t('insp.act.reject_title'),
                    message: t('insp.act.reject_message'),
                    accept: t('insp.act.reject_accept'),
                    danger: true,
                  });
                  if (!ok) return;
                }
                let response = {};
                try {
                  if (decision === 'approve' && reply) {
                    try {
                      response = JSON.parse(reply.value.trim() || '{}');
                    } catch {
                      openAdvanced(row);
                      throw Error(t('insp.act.err.reply_format'));
                    }
                    if (!response || typeof response !== 'object' || Array.isArray(response)) {
                      openAdvanced(row);
                      throw Error(t('insp.act.err.reply_object'));
                    }
                  }
                  error.textContent = '';
                  decisions.add(action.id);
                  for (const b of actions.querySelectorAll('button')) b.disabled = true;
                  await api(
                    'POST',
                    `${base(v)}/actions/${encodeURIComponent(action.id)}`,
                    { decision, response },
                    { token: v.token },
                  );
                  v.resolved.add(action.id);
                  row.remove();
                  if (current(v)) {
                    await refresh(true);
                    onChanged();
                  }
                } catch (failure) {
                  if (current(v)) error.textContent = failure.message;
                } finally {
                  decisions.delete(action.id);
                  for (const b of actions.querySelectorAll('button')) b.disabled = false;
                }
              },
            );
            control.disabled = decisions.has(action.id);
            if (decision === 'approve') control.classList.replace('subtle', 'primary');
            actions.append(control);
          }
        row.append(error, actions);
        v.actionRows.set(action.id, row);
      }
      if (row.parentElement !== parent) parent.append(row);
    }
  }
  function openAdvanced(row) {
    const details = row.querySelector('.approval-advanced');
    if (details) details.open = true;
  }
  return { renderActions };
}
