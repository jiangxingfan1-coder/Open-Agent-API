import { isAdmin, prefs, sdkBaseUrl, state } from '../lib/state.js';
import {
  STRATEGY_PROFILES,
  engineKind,
  engineName,
  formatMode,
  formatPlacement,
} from '../lib/format.js';
import {
  $,
  agentGlyph,
  copyText,
  el,
  icons,
  openDialog,
  status,
  toast,
  withBusy,
} from '../lib/dom.js';
import { api } from '../lib/api.js';
import { load } from '../lib/live.js';
import { t } from '../lib/i18n.js';
import { agentModelName, openKeyDialog } from './key.js';
import { showRun } from './runs.js';
import {
  AUTO_APPROVE_HINT,
  CONVERSION,
  PLACEMENT_REASON,
  TIER_HINT,
  conversionBadge,
  conversionText,
  renderConversion,
  toolsNote,
} from './agent-profile.js';

// The profile helpers moved to agent-profile.js; views keep importing them from here.
export {
  AUTO_APPROVE_HINT,
  CONVERSION,
  PLACEMENT_REASON,
  TIER_HINT,
  conversionBadge,
  conversionText,
  renderConversion,
  toolsNote,
};

/* ── Agent sheet ─────────────────────────────────────── */
export function effectiveModelSelection() {
  const chain = $('model-chain').value.trim();
  if (chain) return chain;
  return $('model-select').value;
}
export function updateEndpointDisplay() {
  const agentId = state.selectedAgent?.id || 'agent/example';
  const map = {
    uap: 'POST /v1/uap',
    oaa: 'POST /v1/invoke',
    openai: 'POST /v1/responses',
    claude: 'POST /v1/messages',
    gemini: `POST /v1beta/models/${agentId}:generateContent`,
  };
  $('endpoint-path').textContent = map[state.snippetDialect] || 'POST /v1/uap';
  updateAgentApi();
}
// Agent API card in the sheet: the base URL and the exact `model` value for the current choice.
export function updateAgentApi() {
  const agent = state.selectedAgent;
  if (!agent) return;
  const base = sdkBaseUrl();
  const model = agentModelName(agent.id, effectiveModelSelection());
  // The call name can be long: it wraps in full, and it is also in the title so it can be checked before copying.
  $('agent-api-base').textContent = base;
  $('agent-api-base').title = base;
  $('agent-api-model').textContent = model;
  $('agent-api-model').title = model;
}
$('copy-agent-base').onclick = () =>
  copyText($('agent-api-base').textContent, t('dlg.agent.copy_base_done'));
$('copy-agent-model').onclick = () =>
  copyText($('agent-api-model').textContent, t('dlg.agent.copy_model_done'));
$('agent-key-btn').onclick = () => {
  const agent = state.selectedAgent;
  if (agent) openKeyDialog({ agents: [agent.id], model: effectiveModelSelection() });
};
export function showAgent(agent) {
  state.agentDialogSequence++;
  state.selectedAgent = agent;
  // Opened normally from the list, the sheet starts a new task; only the "continue" flow keeps continuation info.
  if (!state.keepContinuation) state.continuation = null;
  state.keepContinuation = false;
  // The sheet opens on the routing strategy chosen in Settings > Preferences.
  const strategy = STRATEGY_PROFILES[prefs.strategy] ? prefs.strategy : 'auto';
  state.routingStrategy = strategy;
  document.querySelectorAll('#strategy-pills button').forEach((b) => {
    const active = b.dataset.strategy === strategy;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('agent-title').textContent = agent.id;
  $('agent-engine').textContent = `${engineName(agent.engine)} · ${engineKind(agent.engine)}`;
  $('agent-icon').replaceWith(
    Object.assign(agentGlyph(agent.engine, 'large', agent.preset), { id: 'agent-icon' }),
  );
  $('agent-version').textContent = agent.version;
  $('agent-key-btn').hidden = !isAdmin();
  $('agent-key-btn').title = t('dlg.agent.key_title');
  $('agent-key-btn').setAttribute('aria-label', t('dlg.agent.key_title'));
  const select = $('model-select');
  select.replaceChildren(
    new Option(t('dlg.agent.model.auto'), 'auto'),
    new Option(t('dlg.agent.model.fast'), '@fast'),
    new Option(t('dlg.agent.model.best'), '@best'),
    new Option(t('dlg.agent.model.eco'), '@eco'),
  );
  agent.routes.forEach((r) => select.add(new Option(`${r.id} / ${r.model}`, r.id)));
  // When continuing with the original agent, keep its previous model route by default.
  select.value = state.continuation?.agent === agent.id ? 'auto' : STRATEGY_PROFILES[strategy];
  $('model-chain').value = '';
  // Fallback agent: none by default; lists every agent except this one.
  const others = (state.data?.agents ?? []).filter((a) => a.id !== agent.id);
  $('fallback-agent').replaceChildren(
    new Option(t('dlg.agent.fallback.none'), ''),
    ...others.map((a) => new Option(a.id, a.id)),
  );
  $('fallback-agent-field').hidden = !others.length;
  renderContinuation();
  $('agent-tools-note').textContent = toolsNote(agent);
  const capabilities = $('agent-capabilities');
  capabilities.replaceChildren();
  const capRow = (name, tag, mono = true) => {
    const row = el('div', undefined, 'cap-row');
    row.append(el('span', name, mono ? 'mono' : ''), el('span', tag, 'tag'));
    capabilities.append(row);
  };
  for (const tool of agent.tools) capRow(tool.name, formatPlacement(tool.placement));
  for (const s of agent.skills) capRow(s.name, t('dlg.agent.cap.skill'), false);
  for (const wf of agent.workflows || []) capRow(wf.name, t('dlg.agent.cap.workflow'));
  for (const del of agent.delegates || [])
    capRow(`${del.name} → ${del.agent}`, t('dlg.agent.cap.delegate'));
  // An external agent's tools are explained by "Tools and models" above, so no fallback sentence repeats it.
  if (!capabilities.childElementCount && agent.engine === 'kernel')
    capabilities.append(el('span', t('dlg.agent.cap.none'), 'muted'));
  renderConversion(agent.conversion, agent.approvals);
  $('invoke-result').hidden = true;
  $('input-files').value = '';
  $('attachments-label').textContent = t('dlg.agent.attach.add');
  $('task-input').value = '';
  updateEndpointDisplay();
  openDialog('agent-dialog');
  // Focus the task box right away; openDialog would focus the first header button and show a focus ring.
  $('task-input').focus({ preventScroll: true });
  void previewRoute();
}
document.querySelectorAll('#strategy-pills button').forEach((btn) => {
  btn.onclick = () => {
    const strat = btn.dataset.strategy || 'auto';
    state.routingStrategy = strat;
    document.querySelectorAll('#strategy-pills button').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    if (STRATEGY_PROFILES[strat] && !$('model-chain').value.trim())
      $('model-select').value = STRATEGY_PROFILES[strat];
    updateAgentApi();
    void previewRoute();
  };
});
document.querySelectorAll('#dialect-tabs button').forEach((btn) => {
  btn.onclick = () => {
    state.snippetDialect = btn.dataset.dialect || 'uap';
    document.querySelectorAll('#dialect-tabs button').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    updateEndpointDisplay();
  };
});
$('model-select').onchange = () => {
  updateAgentApi();
  void previewRoute();
};
$('model-chain').oninput = () => {
  updateAgentApi();
  void previewRoute();
};
$('task-input').onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    $('invoke-form').requestSubmit();
  }
};
$('refresh-route').onclick = () =>
  withBusy($('refresh-route'), t('dlg.agent.route.checking_btn'), previewRoute);
export async function previewRoute() {
  const selected = state.selectedAgent;
  if (!selected || !$('agent-dialog').open) return;
  const sequence = ++state.routeSequence;
  const token = state.token;
  const choice = effectiveModelSelection();
  const submit = $('invoke-form').querySelector('[type=submit]');
  state.routeAvailable = false;
  submit.disabled = true;
  let hint = $('route-checking-hint');
  if (!hint) {
    hint = el('span', t('dlg.agent.route.checking_hint'), 'route-checking-hint muted');
    hint.id = 'route-checking-hint';
    submit.after(hint);
  }
  hint.hidden = false;
  $('route-summary').textContent = t('dlg.agent.route.checking');
  $('route-candidates').replaceChildren();
  try {
    const report = await api('POST', '/v1/agents/preview', {
      agent: selected.id,
      model: choice,
      agent_version: selected.version,
      ...continuationFields(selected.id, choice),
    });
    if (
      sequence !== state.routeSequence ||
      token !== state.token ||
      state.selectedAgent?.id !== selected.id ||
      !$('agent-dialog').open
    )
      return;
    state.routeAvailable = !!report.selected;
    submit.disabled = !state.routeAvailable || state.pendingForms.has(state.agentDialogSequence);
    $('route-summary').replaceChildren(
      status(report.selected ? 'ready' : 'unavailable'),
      el(
        'span',
        report.selected
          ? t('dlg.agent.route.selected', {
              id: report.selected.id,
              model: report.selected.model,
              mode: formatMode(report.selected.mode),
            })
          : t('dlg.agent.route.none'),
        'route-selected',
      ),
    );
    if (report.candidates && report.candidates.length) {
      const devDetails = el('details', undefined, 'dev-details route-details');
      devDetails.append(el('summary', t('dlg.agent.route.details')));
      const candidateList = el('div', undefined, 'route-candidate-list');
      for (const candidate of report.candidates) {
        const details = el('details', undefined, 'route-candidate');
        details.open = candidate.id === report.selected?.id;
        const heading = el('summary');
        heading.append(el('code', candidate.id), status(candidate.placement.status));
        details.append(heading);
        const jitterText =
          candidate.health?.jitterMs > 0 ? ` ±${Math.round(candidate.health.jitterMs)} ms` : '';
        const calls = candidate.health?.successfulCalls;
        const evidence =
          candidate.latency_evidence === 'observed_execution'
            ? t(
                calls === 1
                  ? 'dlg.agent.route.evidence_calls_one'
                  : 'dlg.agent.route.evidence_calls',
                {
                  avg: Math.round(candidate.health.averageMs),
                  jitter: jitterText,
                  n: calls,
                },
              )
            : t('dlg.agent.route.no_stats');
        details.append(
          el(
            'div',
            t('dlg.agent.route.score', {
              score: Math.round(candidate.score),
              priority: candidate.priority,
              evidence,
            }),
            'route-evidence',
          ),
        );
        if (candidate.health?.cooldownUntil > Date.now())
          details.append(
            el(
              'div',
              t('dlg.agent.route.cooldown', {
                s: Math.ceil((candidate.health.cooldownUntil - Date.now()) / 1000),
              }),
              'route-reason',
            ),
          );
        for (const node of candidate.placement.candidates) {
          const row = el('div', undefined, 'route-node');
          row.append(
            el('code', node.node_id),
            el(
              'span',
              node.available
                ? t('dlg.agent.route.node_load', { active: node.active, capacity: node.capacity })
                : t('dlg.agent.route.node_unavailable'),
              'muted',
            ),
          );
          details.append(row);
          for (const reason of node.reasons) {
            const copy = PLACEMENT_REASON[reason.code];
            const line = el('div', copy ?? reason.message, 'route-reason');
            if (copy && reason.message) line.title = reason.message;
            details.append(line);
          }
        }
        for (const tool of candidate.placement.tools.filter((x) => !x.available)) {
          const row = el('div', undefined, 'route-reason');
          row.append(
            el('code', tool.name),
            el(
              'span',
              tool.required
                ? t('dlg.agent.route.tool_required')
                : t('dlg.agent.route.tool_optional'),
            ),
          );
          details.append(row);
        }
        if (!candidate.placement.candidates.length)
          details.append(el('div', t('dlg.agent.route.no_nodes'), 'route-reason'));
        candidateList.append(details);
      }
      devDetails.append(candidateList);
      $('route-candidates').append(devDetails);
    }
  } catch (e) {
    if (sequence === state.routeSequence && token === state.token)
      $('route-summary').textContent = e.message;
  } finally {
    if (hint) hint.hidden = true;
  }
  icons();
}
$('input-files').onchange = (e) =>
  ($('attachments-label').textContent = e.target.files.length
    ? t('dlg.agent.attach.count', { n: e.target.files.length })
    : t('dlg.agent.attach.add'));
$('copy-request').onclick = () => {
  const modelVal = effectiveModelSelection();
  const compositeTarget =
    modelVal === 'auto'
      ? state.selectedAgent.id
      : `${state.selectedAgent.id}@${modelVal.replace(/^@/, '')}`;
  const sampleTask = $('task-input').value.trim() || t('dlg.agent.copy.your_task');
  let snippet;
  if (state.snippetDialect === 'uap') {
    snippet = {
      uap: '1.0',
      target: compositeTarget,
      input: sampleTask,
      ...(state.routingStrategy !== 'auto' ? { routing: { strategy: state.routingStrategy } } : {}),
      delivery: { stream: false, format: 'json' },
    };
  } else if (state.snippetDialect === 'openai') {
    snippet = { model: compositeTarget, input: sampleTask };
  } else if (state.snippetDialect === 'claude') {
    snippet = {
      model: compositeTarget,
      max_tokens: 1024,
      messages: [{ role: 'user', content: sampleTask }],
    };
  } else if (state.snippetDialect === 'gemini') {
    snippet = { contents: [{ role: 'user', parts: [{ text: sampleTask }] }] };
  } else {
    snippet = {
      protocol: 'oaa/1',
      agent: state.selectedAgent.id,
      agent_version: state.selectedAgent.version,
      model: modelVal,
      input: sampleTask,
      background: true,
    };
  }
  void copyText(
    JSON.stringify(snippet, null, 2),
    t('dlg.agent.copy.done', { dialect: state.snippetDialect.toUpperCase() }),
  );
};
$('invoke-form').onsubmit = async (e) => {
  e.preventDefault();
  if (
    !state.selectedAgent ||
    !state.routeAvailable ||
    state.pendingForms.has(state.agentDialogSequence)
  )
    return;
  const request = {
    agent: state.selectedAgent.id,
    agent_version: state.selectedAgent.version,
    model: effectiveModelSelection(),
    strategy: state.routingStrategy,
    input: $('task-input').value,
    files: [...$('input-files').files],
    token: state.token,
    sequence: state.agentDialogSequence,
    continuation: continuationFields(state.selectedAgent.id, effectiveModelSelection()),
    fallbackAgent: $('fallback-agent').value,
  };
  const checkConnection = () => {
    if (state.token !== request.token) throw Error(t('dlg.agent.err.connection_changed'));
  };
  const submit = e.target.querySelector('[type=submit]');
  state.pendingForms.add(request.sequence);
  submit.disabled = true;
  try {
    const files = [];
    if (request.files.length) {
      await withBusy(submit, t('dlg.agent.uploading'), async () => {
        for (const file of request.files) {
          if (file.size > 8 * 1024 * 1024) throw Error(t('dlg.agent.err.file_too_large'));
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          checkConnection();
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
      });
      toast(t('dlg.agent.uploaded', { n: files.length }));
    }
    checkConnection();
    const metadata = {
      ...(request.strategy && request.strategy !== 'auto'
        ? { 'oaa.routing_strategy': request.strategy }
        : {}),
      ...(request.fallbackAgent ? { 'oaa.agent_fallback': request.fallbackAgent } : {}),
    };
    const r = await api('POST', '/v1/invoke', {
      protocol: 'oaa/1',
      agent: request.agent,
      agent_version: request.agent_version,
      model: request.model,
      input: request.input,
      file_ids: files,
      background: true,
      metadata,
      ...request.continuation,
    });
    if (state.token !== request.token) return;
    state.continuation = null;
    if (request.sequence === state.agentDialogSequence) {
      $('agent-dialog').close();
      await showRun(r.id);
    } else toast(t('dlg.agent.accepted', { id: r.id }));
    await load();
  } catch (err) {
    if (request.sequence === state.agentDialogSequence && state.token === request.token) {
      $('invoke-result').hidden = false;
      $('invoke-result').textContent = err.message;
    }
  } finally {
    state.pendingForms.delete(request.sequence);
    if (request.sequence === state.agentDialogSequence) submit.disabled = !state.routeAvailable;
  }
};

/* ── Continue / switch agent ─────────────────────────── */
// Fields a continuation request carries. Switching agents, or choosing another model route for the
// original one, must declare a handoff so the new side gets the earlier conversation; the original
// agent continuing on its original route is a plain continuation.
export function continuationFields(agentId, model) {
  const c = state.continuation;
  if (!c) return {};
  const handoff = c.agent !== agentId || model !== 'auto';
  return { previous_response_id: c.runId, ...(handoff ? { handoff: true } : {}) };
}
export function renderContinuation() {
  const c = state.continuation;
  $('continue-strip').hidden = !c;
  if (!c) return;
  const same = state.selectedAgent?.id === c.agent;
  $('continue-text').textContent = same
    ? t('dlg.agent.continue.same', { agent: c.agent })
    : t('dlg.agent.continue.other', { agent: c.agent, current: state.selectedAgent.id });
  const select = $('continue-agent');
  select.replaceChildren(
    ...(state.data?.agents ?? []).map(
      (a) =>
        new Option(a.id === c.agent ? t('dlg.agent.continue.original', { id: a.id }) : a.id, a.id),
    ),
  );
  select.value = state.selectedAgent.id;
}
$('continue-agent').onchange = () => {
  const target = (state.data?.agents ?? []).find((a) => a.id === $('continue-agent').value);
  if (!target || target.id === state.selectedAgent?.id) return;
  const draft = $('task-input').value;
  state.keepContinuation = true;
  showAgent(target);
  $('task-input').value = draft;
};
$('continue-clear').onclick = () => {
  state.continuation = null;
  renderContinuation();
  void previewRoute();
};
