import { state } from './lib/state.js';
import { formatTime, num } from './lib/format.js';
import { confirmAction, el, icons, status, toast } from './lib/dom.js';
import { api, errorText } from './lib/api.js';
import { lang, t } from './lib/i18n.js';
import { breakdownBlock } from './views/common.js';
import { createTimeline } from './dialogs/inspector-timeline.js';
import { createActions } from './dialogs/inspector-actions.js';
import { createSections } from './dialogs/inspector-sections.js';
import { createNotes } from './dialogs/inspector-notes.js';

// Shared helpers come from the console modules; only the app-level callbacks are injected.
export function createRunInspector({ onChanged, onClosed, onSelected, onContinue = () => {} }) {
  const getToken = () => state.token;
  const getScopes = () => state.data?.principal.scopes ?? [];
  const formatDuration = formatTime;
  const breakdown = breakdownBlock;
  const $ = (id) => document.getElementById(id);
  const EFFECT_NAMES = {
    read: t('insp.effect.read'),
    write: t('insp.effect.write'),
    'idempotent-write': t('insp.effect.idempotent_write'),
    unknown: t('insp.effect.unknown'),
  };
  const formatEffect = (e) => EFFECT_NAMES[e] ?? e ?? '';
  // When a task did not finish: say in one sentence what happened and what can be done; the raw
  // error code is for developers. The copy is looked up by the console (the gateway's error
  // catalogue first, then a local fallback).
  const runErrorNode = (error) => {
    const box = el('div', undefined, 'run-error-copy');
    box.append(
      el('span', errorText(error.code) ?? t('insp.error.generic')),
      el('small', `${error.code}: ${error.message}`),
    );
    return box;
  };
  const dialog = $('run-dialog');
  const notes = createNotes({ $, dialog });
  const terminal = (value) =>
    ['completed', 'failed', 'interrupted', 'incomplete', 'cancelled'].includes(value);
  const bytes = (n) =>
    n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${(n / 1024 / 1024).toFixed(1)} MiB`;
  const permit = (scope) => getScopes().includes('admin') || getScopes().includes(scope);
  const commands = new Map();
  const reconciliations = new Set();
  let view = null;
  let stepView = null;
  const current = (v) =>
    view === v && v.token === getToken() && !v.controller.signal.aborted && dialog.open;
  const base = (v) => `/v1/runs/${encodeURIComponent(v.id)}`;
  const read = async (v, endpoint) => {
    const data = await api('GET', endpoint, undefined, {
      signal: v.controller.signal,
      token: v.token,
    });
    return current(v) ? data : null;
  };
  // Timeline and queue note, approvals and waiting-on-caller, steps and file list live in dialogs/inspector-*.js.
  const { readTimeline, renderQueue, renderTimeline, setOpenChild } = createTimeline({
    $,
    formatDuration,
    breakdown,
    read,
    base,
    terminal,
  });
  const { renderActions } = createActions({
    $,
    formatDuration,
    bytes,
    download,
    base,
    permit,
    current,
    refresh,
    onChanged,
  });
  const { renderSteps, renderArtifacts } = createSections({
    $,
    bytes,
    download,
    permit,
    inspectStep,
  });
  function reconcileControls() {
    const selected = stepView;
    const pending = !!selected && reconciliations.has(selected.id);
    const form = $('reconcile-form');
    for (const option of form.querySelectorAll('input[name="outcome"]')) option.disabled = pending;
    const outcome = new FormData(form).get('outcome');
    $('reconcile-value').disabled = pending || outcome !== 'completed';
    $('record-outcome').disabled = pending || !outcome || selected?.status !== 'uncertain';
  }
  async function download(v, endpoint, name) {
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${v.token}` },
        signal: v.controller.signal,
      });
      if (!response.ok) throw Error(t('insp.download_failed', { status: response.status }));
      const blob = await response.blob();
      if (!current(v)) return;
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (current(v)) toast(error.message);
    }
  }
  function clear() {
    view?.controller.abort();
    view = null;
    stepView = null;
    if ($('step-dialog').open) $('step-dialog').close();
    if (dialog.open) dialog.close();
    for (const name of ['run-actions', 'run-caller', 'run-steps', 'run-artifacts', 'run-timeline'])
      $(name).replaceChildren();
    for (const name of ['run-output', 'step-args', 'step-result', 'timeline-summary'])
      $(name).textContent = '';
    $('timeline-section').hidden = true;
    $('caller-section').hidden = true;
    $('run-queue').hidden = true;
    $('reconcile-value').value = '';
    onClosed();
  }
  dialog.addEventListener('close', () => {
    if (!dialog.open) clear();
  });
  $('step-dialog').addEventListener('close', () => {
    if (!$('step-dialog').open) {
      stepView = null;
      if (dialog.open) $('refresh-run').focus();
    }
  });
  // With a single page, neither the arrows nor the page number are shown (an empty list does not show "0 / 0" either).
  function showPager(name, show) {
    for (const part of ['prev', 'page', 'next']) $(`${name}-${part}`).hidden = !show;
  }
  function pager(v, name, offset, total, next, size) {
    showPager(name, offset > 0 || next !== null);
    $(`${name}-prev`).disabled = !!v.loading || offset === 0;
    $(`${name}-next`).disabled = !!v.loading || next === null;
    $(`${name}-page`).textContent = total
      ? `${Math.floor(offset / size) + 1} / ${Math.ceil(total / size)}`
      : '0 / 0';
  }
  function controls(v) {
    const data = v.state;
    if (!data) return;
    const pending = commands.get(v.id);
    $('cancel-run').hidden = terminal(data.status) || !permit('invoke');
    $('cancel-run').disabled = !!pending;
    $('cancel-run').querySelector('span').textContent =
      pending === 'cancel' ? t('insp.cancelling') : t('insp.cancel');
    $('resume-run').hidden = data.status !== 'interrupted' || !permit('invoke');
    // A completed task can be continued: in the same session, or with another agent.
    $('continue-run').hidden = data.status !== 'completed' || !permit('invoke');
    $('continue-run').onclick = () => onContinue({ runId: data.id, agent: data.agent });
    $('resume-run').disabled =
      !!pending || data.engine !== 'kernel' || (data.steps.uncertain ?? 0) > 0;
    $('resume-run').title =
      data.engine !== 'kernel'
        ? t('insp.resume_title.external')
        : (data.steps.uncertain ?? 0) > 0
          ? t('insp.resume_title.uncertain')
          : t('insp.resume_title.ok');
    $('resume-run').querySelector('span').textContent =
      pending === 'resume' ? t('insp.resuming') : t('insp.resume');
    $('download-output').disabled = !data.output.characters;
    $('output-prev').disabled = !!v.loading || v.outputIndex === 0;
    $('output-next').disabled =
      !!v.loading || !v.output?.next_cursor || v.output.waiting_for_output;
    $('output-page').textContent = t('insp.output_part', { n: v.outputIndex + 1 });
    showPager(
      'output',
      v.outputIndex > 0 || !!v.output?.next_cursor || !!v.output?.waiting_for_output,
    );
    if (v.steps) pager(v, 'steps', v.stepsOffset, v.steps.total, v.steps.next_offset, 20);
    if (v.actions) pager(v, 'actions', v.actionsOffset, v.actions.total, v.actions.next_offset, 5);
    if (v.artifacts)
      pager(v, 'artifacts', v.artifactsOffset, data.artifact_count, v.artifacts.next_offset, 10);
    for (const name of ['steps', 'actions', 'artifacts'])
      if (!v[name]) {
        $(`${name}-prev`).disabled = true;
        $(`${name}-next`).disabled = true;
        $(`${name}-page`).textContent = t('insp.loading');
      }
  }
  async function refresh(force = false) {
    const v = view;
    if (!v || !current(v)) return;
    if (v.loading) {
      await v.loading;
      if (force && current(v)) return refresh(true);
      return;
    }
    v.loading = (async () => {
      const data = await read(v, `${base(v)}/state`);
      if (!data) return;
      const changed = force || JSON.stringify(data) !== v.stateKey;
      v.state = data;
      $('run-title').textContent = data.id;
      // When every pending item is a caller tool, the task waits for the caller to send results back; no person needs to act.
      const pending = data.pending_actions ?? [];
      const caller =
        data.status === 'requires_action' &&
        pending.length > 0 &&
        pending.every((a) => a.kind === 'client_tool');
      $('run-status').replaceChildren(status(caller ? 'awaiting_caller' : data.status));
      $('run-model').textContent = data.route.model;
      $('run-usage').textContent = data.usage
        ? `${t('insp.usage.tokens', { n: num(data.usage.total_tokens) })}${data.usage_complete ? '' : t('insp.usage.partial')}`
        : t('insp.usage.none');
      if (data.output_contract)
        $('run-usage').textContent +=
          ` · ${t('insp.contract', { kind: data.output_contract.kind })}${data.output_contract.repairs ? t('insp.contract.repairs', { n: data.output_contract.repairs }) : ''}`;
      $('run-error').hidden = !data.error;
      $('run-error').replaceChildren(...(data.error ? [runErrorNode(data.error)] : []));
      $('output-count').textContent = t('insp.output_chars', { n: num(data.output.characters) });
      renderQueue(data);
      notes.render(data);
      if (!v.filterChosen && !v.steps && data.steps.uncertain) {
        v.stepFilter = 'uncertain';
        $('step-filter').value = 'uncertain';
      }
      if (!v.filterChosen && v.stepFilter === 'uncertain' && !data.steps.uncertain) {
        v.stepFilter = '';
        v.stepsOffset = 0;
        $('step-filter').value = '';
      }
      if (changed) {
        const stepOffset = v.stepsOffset,
          actionOffset = v.actionsOffset,
          artifactOffset = v.artifactsOffset,
          filter = v.stepFilter;
        const query = new URLSearchParams({
          offset: String(stepOffset),
          limit: '20',
          ...(filter ? { status: filter } : {}),
        });
        const [steps, actions, artifacts, timeline] = await Promise.all([
          read(v, `${base(v)}/steps?${query}`),
          read(v, `${base(v)}/actions?offset=${actionOffset}&limit=5`),
          read(v, `${base(v)}/artifacts?offset=${artifactOffset}&limit=10`),
          readTimeline(v),
        ]);
        if (!current(v)) return;
        renderTimeline(timeline);
        for (const [name, page, size] of [
          ['steps', steps, 20],
          ['actions', actions, 5],
        ]) {
          if (page && v[`${name}Offset`] >= page.total && v[`${name}Offset`] > 0) {
            v[`${name}Offset`] = page.total ? Math.floor((page.total - 1) / size) * size : 0;
            v.correctedPage = true;
          }
        }
        if (steps && stepOffset === v.stepsOffset && filter === v.stepFilter) {
          v.steps = steps;
          renderSteps(v, steps);
        }
        if (actions && actionOffset === v.actionsOffset) {
          v.actions = actions;
          renderActions(v, actions);
        }
        if (artifacts && artifactOffset === v.artifactsOffset) {
          v.artifacts = artifacts;
          renderArtifacts(v, artifacts);
        }
      }
      if (force || !v.output || (changed && (v.output.waiting_for_output || v.output.done))) {
        const index = v.outputIndex;
        const cursor = v.outputCursors[index];
        const page = await read(
          v,
          `${base(v)}/output?${new URLSearchParams({ max_bytes: '8000', ...(cursor ? { cursor } : {}) })}`,
        );
        if (page && index === v.outputIndex) {
          const pre = $('run-output');
          const top = pre.scrollTop,
            atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
          if (pre.textContent !== (page.text || t('insp.output_empty'))) {
            pre.textContent = page.text || t('insp.output_empty');
            pre.scrollTop = atEnd && v.output ? pre.scrollHeight : top;
          }
          v.output = page;
        }
      }
      if (current(v)) {
        v.stateKey = JSON.stringify(data);
        icons();
      }
    })()
      .catch((error) => {
        if (!current(v)) return;
        v.stateKey = null;
        if ([401, 403].includes(error.status)) {
          clear();
          toast(error.message);
          return;
        }
        $('run-error').hidden = false;
        $('run-error').textContent = error.message;
        if (!v.state) {
          $('run-status').replaceChildren(el('span', t('insp.unavailable'), 'status error'));
        }
        if (!v.output) $('run-output').textContent = t('insp.output_unavailable');
      })
      .finally(() => {
        v.loading = null;
        if (current(v)) {
          controls(v);
          if (v.correctedPage) {
            v.correctedPage = false;
            void refresh(true);
          }
        }
      });
    controls(v);
    await v.loading;
  }
  async function inspectStep(v, id) {
    if (!current(v)) return;
    const selected = { view: v, id, status: null };
    stepView = selected;
    $('step-title').textContent = t('insp.loading');
    $('step-id').textContent = id;
    $('step-args').textContent = '';
    $('step-result').textContent = '';
    $('step-status').replaceChildren();
    $('step-node').textContent = '';
    $('step-effect').textContent = '';
    $('step-args-size').textContent = '';
    $('step-result-size').textContent = '';
    $('reconcile-form').hidden = true;
    $('step-reconciliation').hidden = true;
    if (!$('step-dialog').open) $('step-dialog').showModal();
    try {
      const data = await read(v, `${base(v)}/steps/${encodeURIComponent(id)}`);
      if (!data || stepView !== selected || !$('step-dialog').open) return;
      selected.status = data.status;
      $('step-reconciliation').hidden = !data.reconciliation;
      $('step-reconciliation').textContent = data.reconciliation
        ? t('insp.step.reconciled', {
            outcome:
              data.reconciliation.outcome === 'completed'
                ? t('insp.step.outcome_completed')
                : data.reconciliation.outcome === 'not_executed'
                  ? t('insp.step.outcome_not_executed')
                  : data.reconciliation.outcome,
            time: new Date(data.reconciliation.recorded_at).toLocaleTimeString(
              lang === 'zh' ? 'zh-CN' : 'en-US',
              { hour12: false },
            ),
          })
        : '';
      $('step-title').textContent = data.name;
      $('step-status').replaceChildren(status(data.status));
      $('step-node').textContent = data.node_id || t('insp.step.not_dispatched');
      $('step-effect').textContent = formatEffect(data.effect);
      for (const [name, field] of [
        ['args', data.arguments],
        ['result', data.result],
      ]) {
        $(`step-${name}`).textContent = field.preview;
        $(`step-${name}-size`).textContent =
          `${bytes(field.bytes)}${field.truncated ? t('insp.step.preview_truncated') : ''}`;
      }
      $('reconcile-form').hidden =
        data.status !== 'uncertain' || v.state.status !== 'interrupted' || !permit('approve');
      $('reconcile-value').value = '';
      for (const option of $('reconcile-form').querySelectorAll('input[name="outcome"]'))
        option.checked = false;
      reconcileControls();
      $('reconcile-error').hidden = true;
      icons();
    } catch (error) {
      if (current(v)) toast(error.message);
    }
  }
  for (const name of ['steps', 'actions', 'artifacts'])
    for (const direction of ['prev', 'next'])
      $(`${name}-${direction}`).onclick = async () => {
        const v = view;
        if (!v || v.loading || !current(v)) return;
        const size = name === 'steps' ? 20 : name === 'actions' ? 5 : 10;
        v[`${name}Offset`] =
          direction === 'prev'
            ? Math.max(0, v[`${name}Offset`] - size)
            : (v[name]?.next_offset ?? v[`${name}Offset`]);
        v[name] = null;
        v[`${name}Key`] = null;
        $(`run-${name}`).replaceChildren(el('p', t('insp.loading'), 'muted inspector-empty'));
        await refresh(true);
      };
  $('step-filter').onchange = async () => {
    if (!view) return;
    view.stepFilter = $('step-filter').value;
    view.filterChosen = true;
    view.stepsOffset = 0;
    view.steps = null;
    view.stepsKey = null;
    $('run-steps').replaceChildren(el('p', t('insp.loading'), 'muted inspector-empty'));
    await refresh(true);
  };
  for (const direction of ['prev', 'next'])
    $(`output-${direction}`).onclick = async () => {
      const v = view;
      if (!v || v.loading || !current(v)) return;
      if (direction === 'prev') v.outputIndex = Math.max(0, v.outputIndex - 1);
      else {
        if (!v.output?.next_cursor || v.output.waiting_for_output) return;
        v.outputCursors[++v.outputIndex] = v.output.next_cursor;
      }
      $('run-output').scrollTop = 0;
      $('run-output').textContent = t('insp.loading');
      v.output = null;
      await refresh(true);
    };
  $('refresh-run').onclick = () => refresh(true);
  $('download-output').onclick = () => {
    if (view) void download(view, `${base(view)}/output.txt`, `${view.id}.txt`);
  };
  $('download-step').onclick = () => {
    if (stepView)
      void download(
        stepView.view,
        `${base(stepView.view)}/steps/${encodeURIComponent(stepView.id)}/content`,
        'step.json',
      );
  };
  for (const command of ['cancel', 'resume'])
    $(`${command}-run`).onclick = async () => {
      const v = view;
      if (!v || !current(v) || commands.has(v.id)) return;
      if (command === 'cancel') {
        const confirmed = await confirmAction({
          title: t('insp.cancel_confirm.title', { id: v.id }),
          message: t('insp.cancel_confirm.message'),
          accept: t('insp.cancel_confirm.accept'),
          danger: true,
        });
        if (!confirmed) return;
      }
      commands.set(v.id, command);
      controls(v);
      try {
        await api(
          'POST',
          command === 'cancel'
            ? `/v1/responses/${encodeURIComponent(v.id)}/cancel`
            : `${base(v)}/resume`,
          {},
          { token: v.token },
        );
        if (current(v)) {
          await refresh(true);
          onChanged();
        }
      } catch (error) {
        if (current(v)) toast(error.message);
      } finally {
        commands.delete(v.id);
        if (current(v)) controls(v);
      }
    };
  $('reconcile-form').onchange = reconcileControls;
  $('reconcile-form').onsubmit = async (event) => {
    event.preventDefault();
    const selected = stepView;
    if (
      !selected ||
      !current(selected.view) ||
      reconciliations.has(selected.id) ||
      $('record-outcome').disabled
    )
      return;
    const v = selected.view;
    try {
      const outcome = new FormData($('reconcile-form')).get('outcome');
      if (!['completed', 'not_executed'].includes(outcome))
        throw Error(t('insp.reconcile.none_selected'));
      let value = null;
      if (outcome === 'completed') {
        const raw = $('reconcile-value').value.trim();
        if (raw) {
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
        }
      }
      reconciliations.add(selected.id);
      reconcileControls();
      $('reconcile-error').hidden = true;
      await api(
        'POST',
        `${base(v)}/reconcile`,
        { step_id: selected.id, outcome, value },
        { token: v.token },
      );
      if (stepView === selected) $('step-dialog').close();
      if (current(v)) {
        await refresh(true);
        onChanged();
      }
    } catch (error) {
      if (stepView === selected) {
        $('reconcile-error').hidden = false;
        $('reconcile-error').textContent = error.message;
      }
    } finally {
      reconciliations.delete(selected.id);
      if (stepView?.view === v && stepView.id === selected.id && current(v)) {
        if (stepView === selected) reconcileControls();
        else await inspectStep(v, selected.id);
      }
    }
  };
  const inspector = {
    reset: clear,
    refresh,
    open: async (id) => {
      if (view?.id === id && current(view)) return refresh(true);
      clear();
      view = {
        id,
        token: getToken(),
        controller: new AbortController(),
        loading: null,
        state: null,
        stateKey: null,
        outputCursors: [null],
        outputIndex: 0,
        output: null,
        stepsOffset: 0,
        actionsOffset: 0,
        artifactsOffset: 0,
        stepFilter: '',
        filterChosen: false,
        actionRows: new Map(),
        resolved: new Set(),
      };
      onSelected(id);
      notes.reset();
      $('run-title').textContent = id;
      $('run-status').replaceChildren(el('span', t('insp.loading'), 'status neutral'));
      $('run-model').textContent = '';
      $('run-usage').textContent = '';
      $('run-error').hidden = true;
      $('actions-heading').hidden = true;
      $('caller-section').hidden = true;
      for (const name of ['run-actions', 'run-caller', 'run-steps', 'run-artifacts'])
        $(name).replaceChildren();
      $('run-output').textContent = t('insp.loading');
      $('step-filter').value = '';
      for (const name of ['output', 'steps', 'actions', 'artifacts']) {
        $(`${name}-prev`).disabled = true;
        $(`${name}-next`).disabled = true;
        $(`${name}-page`).textContent = '';
      }
      for (const name of ['output-count', 'step-count', 'artifact-count']) $(name).textContent = '';
      $('cancel-run').hidden = true;
      $('resume-run').hidden = true;
      $('continue-run').hidden = true;
      $('download-output').disabled = true;
      dialog.showModal();
      icons();
      await refresh(true);
    },
  };
  setOpenChild((id) => inspector.open(id));
  return inspector;
}
