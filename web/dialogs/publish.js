import { isAdmin, isNodeAdmin, state } from '../lib/state.js';
import { NATIVE_RUNTIMES, engineKey, engineName } from '../lib/format.js';
import {
  $,
  agentGlyph,
  modelGlyph,
  confirmAction,
  el,
  icon,
  icons,
  openDialog,
  toast,
  withBusy,
} from '../lib/dom.js';
import { api } from '../lib/api.js';
import { load } from '../lib/live.js';
import { openKeyDialog } from './key.js';
import { t } from '../lib/i18n.js';
import {
  catalogFor,
  refreshModels,
  renderCatalogStatus,
  bindModelRefresh,
} from './model-discovery.js';
import { renderPublishToolModes } from './access-options.js';
import { openProjectOptions, projectWorkspaceSelection } from './project-workspace.js';

/* ── Publish ─────────────────────────────────────────── */
$('primary-action').onclick = () => (state.view === 'keys' ? openKeyDialog() : openPublish());
export const publishDraft = { models: ['default'], custom: [] };
export function runtimeChoices() {
  const listed = (state.backends ?? []).filter((b) => b.engine);
  const known = new Map(listed.map((b) => [b.engine, b]));
  for (const engine of NATIVE_RUNTIMES) if (!known.has(engine)) known.set(engine, { engine });
  // The gateway publishes built-in natives regardless of their switch; adapters must be enabled.
  const choices = [...known.values()].map((b) => ({
    engine: b.engine,
    preset: b.preset,
    name: engineName(b.engine, b.name),
    enabled: b.enabled,
    publishable: String(b.engine).includes('/') ? b.publishable === true : true,
  }));
  // Usable runtimes first; the order is otherwise kept stable.
  return [...choices.filter((c) => c.publishable), ...choices.filter((c) => !c.publishable)];
}
export function markRuntime(engine) {
  for (const option of $('runtime-picker').querySelectorAll('.runtime-option')) {
    option.classList.toggle('selected', option.dataset.engine === engine);
    option.querySelector('input').checked = option.dataset.engine === engine;
  }
}
export function selectRuntime(engine) {
  const changed = $('native-engine').value !== engine;
  $('native-engine').value = engine;
  $('native-id').value =
    `agent/${engineKey(engine) === 'deepseek-harness' ? 'dsh' : engineKey(engine)}`;
  if (changed) Object.assign(publishDraft, { models: ['default'], custom: [] });
  markRuntime(engine);
  renderModelPicker();
  updateIdHint();
  if (isNodeAdmin()) void refreshModels(engine, renderModelPicker);
}
export function renderRuntimePicker() {
  const picker = $('runtime-picker');
  picker.replaceChildren();
  const choices = runtimeChoices();
  const current = $('native-engine').value;
  const valid = choices.some((c) => c.engine === current && c.publishable);
  for (const r of choices) {
    const option = el('label', undefined, `runtime-option${r.publishable ? '' : ' unavailable'}`);
    option.dataset.engine = r.engine;
    const input = el('input');
    input.type = 'radio';
    input.name = 'runtime';
    input.value = r.engine;
    input.checked = r.engine === current;
    input.disabled = !r.publishable;
    input.onchange = () => selectRuntime(r.engine);
    const meta = el('span', undefined, 'runtime-meta');
    const stateText =
      r.enabled === undefined
        ? t('dlg.publish.runtime.local')
        : r.enabled
          ? t('dlg.publish.runtime.enabled')
          : t('dlg.publish.runtime.disabled');
    if (r.enabled === false) option.title = t('dlg.publish.runtime.enable_title');
    meta.append(
      el('strong', r.name),
      el(
        'small',
        r.publishable ? stateText : t('dlg.publish.runtime.enable_first'),
        r.enabled ? 'on' : '',
      ),
    );
    option.append(input, agentGlyph(r.engine, 'small', r.preset), meta);
    picker.append(option);
  }
  // Keep a custom agent ID when the inventory refreshes; reset only an invalid choice.
  if (valid) {
    markRuntime(current);
    renderModelPicker();
    if (isNodeAdmin()) void refreshModels(current, renderModelPicker);
  } else selectRuntime('codex');
}
export function publishModelChoices(engine) {
  const out = ['default'];
  const add = (m) => {
    const name = String(m ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  };
  const backend = (state.backends ?? []).find((b) => b.engine === engine);
  if (Array.isArray(backend?.model_overrides)) backend.model_overrides.forEach(add);
  for (const model of catalogFor(engine)?.models ?? []) add(model.id);
  for (const a of state.data?.agents ?? [])
    if (a.engine === engine) for (const r of a.routes ?? []) add(r.model);
  publishDraft.custom.forEach(add);
  publishDraft.models.forEach(add);
  return out;
}
// Picking a first real model replaces the untouched runtime default; later picks add routes.
export function pickPublishModel(model) {
  const list = publishDraft.models;
  if (list.includes(model)) return;
  publishDraft.models = list.length === 1 && list[0] === 'default' ? [model] : [...list, model];
}
export function renderModelPicker() {
  const picker = $('model-picker');
  picker.replaceChildren();
  const engine = $('native-engine').value;
  renderCatalogStatus(engine);
  renderPublishToolModes(engine);
  for (const m of publishModelChoices(engine)) {
    const index = publishDraft.models.indexOf(m);
    const chip = el('span', undefined, `model-chip${index >= 0 ? ' selected' : ''}`);
    const main = el('button', undefined, 'chip-main');
    main.type = 'button';
    main.setAttribute('aria-pressed', String(index >= 0));
    const displayName = catalogFor(engine)?.models?.find((model) => model.id === m)?.name ?? m;
    const label = el('span', m === 'default' ? t('dlg.publish.model.default') : displayName);
    label.translate = false;
    if (m !== 'default') main.append(modelGlyph(m, displayName));
    main.append(label);
    if (index === 0) {
      main.prepend(icon('star'));
      main.title = t('dlg.publish.model.current_default');
    } else if (index > 0) main.title = t('dlg.publish.model.make_default');
    else
      main.title =
        m === 'default'
          ? t('dlg.publish.model.default_hint')
          : t('dlg.publish.model.add', { name: m });
    main.onclick = () => {
      if (index > 0) publishDraft.models = [m, ...publishDraft.models.filter((x) => x !== m)];
      else if (index < 0) pickPublishModel(m);
      renderModelPicker();
    };
    if (
      m !== 'default' &&
      !catalogFor(engine)?.models?.some(
        (model) => model.id === m && model.verification === 'discovered',
      )
    )
      main.title += ` · ${t('models.configured')}`;
    chip.append(main);
    if (index >= 0 && publishDraft.models.length > 1) {
      const remove = el('button', undefined, 'chip-remove');
      remove.type = 'button';
      remove.title = t('dlg.publish.model.remove', {
        name: m === 'default' ? t('dlg.publish.model.default') : m,
      });
      remove.setAttribute('aria-label', remove.title);
      remove.append(icon('x'));
      remove.onclick = () => {
        publishDraft.models = publishDraft.models.filter((x) => x !== m);
        renderModelPicker();
      };
      chip.append(remove);
    }
    picker.append(chip);
  }
  $('native-models').value = publishDraft.models.join(',');
  icons();
}
export function addCustomModel() {
  const input = $('model-custom');
  const name = input.value.trim();
  if (!name) return;
  if (name.length > 200 || /[,\s]/.test(name)) {
    $('publish-error').textContent = t('dlg.publish.model.invalid');
    return;
  }
  $('publish-error').textContent = '';
  if (!publishDraft.custom.includes(name)) publishDraft.custom.push(name);
  pickPublishModel(name);
  input.value = '';
  renderModelPicker();
}
bindModelRefresh(renderModelPicker);
$('model-add').onclick = addCustomModel;
$('model-custom').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addCustomModel();
  }
};
export function updateIdHint() {
  const id = $('native-id').value.trim();
  const hint = $('native-id-hint');
  const exists = (state.data?.agents ?? []).some((a) => a.id === id);
  hint.classList.toggle('hint-exists', exists);
  hint.textContent = exists ? t('dlg.publish.id.exists', { id }) : t('dlg.publish.id.hint');
}
$('native-id').oninput = updateIdHint;
export async function openPublish() {
  openProjectOptions();
  $('publish-error').textContent = '';
  $('model-custom').value = '';
  $('model-follow').checked = true;
  $('publish-tool-boundary').value = 'managed';
  $('publish-approver').value = 'owner';
  $('publish-orchestrate').checked = true;
  $('publish-helpers').replaceChildren(
    ...(state.data?.agents ?? []).map((a) => {
      const option = el('option', a.id);
      option.value = a.id;
      return option;
    }),
  );
  $('model-restrict').checked = false;
  $('publish-auto-approve').checked = false;
  $('publish-auto-approve-note').hidden = true;
  Object.assign(publishDraft, { models: ['default'], custom: [] });
  renderRuntimePicker();
  updateIdHint();
  openDialog('publish-dialog');
  if (isNodeAdmin()) {
    const token = state.token;
    try {
      const backends = await api('GET', '/v1/local/backends');
      if (token === state.token) {
        state.backends = backends.data;
        if (backends.providers) state.providers = backends.providers;
        renderProviderPicker();
        if ($('publish-dialog').open) {
          renderRuntimePicker();
          icons();
        }
      }
    } catch {
      /* The static native list stays usable without the backend inventory. */
    }
  }
}
/* Built-in agents: pick one of the configured model providers instead of typing its name. The
   choice rewrites the provider of every `route "x" -> provider/"model"` line in the source. */
export function routeProvider(source) {
  return /->\s*([A-Za-z0-9_-]+)\/"/.exec(source)?.[1];
}
export function withRouteProvider(source, name) {
  return source.replace(/(->\s*)[A-Za-z0-9_-]+(\/")/g, `$1${name}$2`);
}
export function renderProviderPicker() {
  const providers = state.providers ?? [];
  const select = $('oaa-provider');
  $('oaa-provider-field').hidden = !providers.length;
  const current = routeProvider($('oaa-source-editor').value || '');
  select.replaceChildren(
    ...providers.map((p) => {
      const option = el(
        'option',
        t(p.key_ready ? 'dlg.publish.provider.option' : 'dlg.publish.provider.option_nokey', {
          name: p.name,
          kind: p.kind,
        }),
      );
      option.value = p.name;
      option.selected = p.name === current;
      return option;
    }),
  );
  const known = providers.find((p) => p.name === current);
  if (!known && providers.length) {
    const other = el('option', t('dlg.publish.provider.other', { name: current ?? '—' }));
    other.value = '';
    other.selected = true;
    select.prepend(other);
  }
  $('oaa-provider-hint').textContent = known
    ? known.key_ready
      ? t('dlg.publish.provider.ready', { url: known.base_url })
      : t('dlg.publish.provider.nokey', { ref: known.key.ref ?? '' })
    : t('dlg.publish.provider.hint');
}
$('oaa-provider').onchange = (e) => {
  if (!e.target.value) return;
  $('oaa-source-editor').value = withRouteProvider(
    $('oaa-source-editor').value || '',
    e.target.value,
  );
  renderProviderPicker();
};
$('oaa-source-editor').addEventListener('change', () => renderProviderPicker());
export const DEFAULT_OAA_TEMPLATE = `let DEFAULT_TIMEOUT = 30s

agent "agent/studio-analyst" {
  description = "Source-grounded analyst with compiled workflow macros"
  engine      = kernel

  route "primary" -> default/"gpt-4.1"      priority=0 cost=3 speed=3 tags=["reasoning", "quality"]
  route "fast"    -> default/"gpt-4.1-mini" priority=1 cost=1 speed=5 tags=["fast", "cost"]

  use builtin [list_files, read_file, write_file]

  flow "inspect_workspace" {
    description = "List workspace files and summarize count"
    params {
      target_file?: string(default="README.md")
    }
    step listing = list_files()
    step stats   = $transform(
      total = $(len(listing.files)),
      names = $(pluck(listing.files, "name"))
    )
  }

  limits {
    max_turns        = 12
    timeout          = DEFAULT_TIMEOUT
    tool_concurrency = 4
  }

  instructions """
    Use inspect_workspace or built-in file tools to ground every answer in source files.
  """
}`;
export const PUBLISH_MODE_HINT = {
  native: t('dlg.publish.mode.native'),
  oaa: t('dlg.publish.mode.oaa'),
  bundle: t('dlg.publish.mode.bundle'),
};
export function publishMode(mode) {
  state.publishMode = mode;
  $('native-fields').hidden = mode !== 'native';
  $('oaa-fields').hidden = mode !== 'oaa';
  $('bundle-fields').hidden = mode !== 'bundle';
  $('native-mode').classList.toggle('active', mode === 'native');
  $('oaa-mode').classList.toggle('active', mode === 'oaa');
  $('bundle-mode').classList.toggle('active', mode === 'bundle');
  $('native-mode').setAttribute('aria-pressed', String(mode === 'native'));
  $('oaa-mode').setAttribute('aria-pressed', String(mode === 'oaa'));
  $('bundle-mode').setAttribute('aria-pressed', String(mode === 'bundle'));
  $('publish-mode-hint').textContent = PUBLISH_MODE_HINT[mode] ?? '';
  $('native-id').required = mode === 'native';
  $('native-models').required = mode === 'native';
  if (mode === 'oaa' && !$('oaa-source-editor').value.trim())
    $('oaa-source-editor').value = DEFAULT_OAA_TEMPLATE;
  if (mode === 'oaa') renderProviderPicker();
}
$('native-mode').onclick = () => publishMode('native');
$('oaa-mode').onclick = () => publishMode('oaa');
$('bundle-mode').onclick = () => publishMode('bundle');

export function formatOaaDiagnostics(report) {
  const container = el('div', undefined, 'diagnostics-container');
  const rawJson = JSON.stringify(
    {
      valid: report.valid,
      agent: report.agent?.id ?? null,
      routes: report.agent?.routes?.length ?? 0,
      workflows: Object.keys(report.workflow_plans || {}),
      diagnostics: report.diagnostics,
    },
    null,
    2,
  );
  const items = report.diagnostics || [];
  if (report.valid && !items.length) {
    container.append(el('div', t('dlg.publish.diag.ok'), 'diagnostic-ok'));
  } else {
    const list = el('div', undefined, 'diagnostic-cards');
    for (const d of items) {
      const card = el('div', undefined, `diagnostic-card ${d.severity || 'info'}`);
      const tag = el(
        'span',
        d.severity === 'error'
          ? t('dlg.publish.diag.error')
          : d.severity === 'warning'
            ? t('dlg.publish.diag.warning')
            : t('dlg.publish.diag.info'),
        `tag ${d.severity || 'info'}`,
      );
      const title = el('strong', d.message || d.code || t('dlg.publish.diag.unknown'));
      const head = el('div', undefined, 'diagnostic-card-head');
      head.append(tag, title);
      const pos = d.line ? t('dlg.publish.diag.pos', { line: d.line, col: d.col ?? 1 }) : '';
      let suggestion = '';
      if (d.code === 'empty_description') suggestion = t('dlg.publish.diag.s_empty_description');
      else if (d.code === 'empty_instructions')
        suggestion = t('dlg.publish.diag.s_empty_instructions');
      else if (d.code === 'single_route') suggestion = t('dlg.publish.diag.s_single_route');
      else if (d.code === 'workflow_compiled') suggestion = '';
      else if (d.severity === 'error') suggestion = t('dlg.publish.diag.s_error');
      const body = el('div', undefined, 'diagnostic-card-body');
      if (pos) body.append(el('div', t('dlg.publish.diag.pos_label', { pos }), 'muted'));
      if (suggestion)
        body.append(el('div', t('dlg.publish.diag.suggestion', { text: suggestion })));
      card.append(head);
      if (body.childNodes.length) card.append(body);
      list.append(card);
    }
    container.append(list);
  }
  const rawDetails = el('details', undefined, 'raw-details');
  rawDetails.append(el('summary', t('dlg.publish.raw')), el('pre', rawJson, 'code small'));
  container.append(rawDetails);
  return container;
}

$('oaa-verify-btn').onclick = async () => {
  $('publish-error').textContent = '';
  const source = $('oaa-source-editor').value || '';
  if (!source.trim()) return;
  try {
    const report = await api('POST', '/v1/lang/compile', { source });
    if (report.formatted) $('oaa-source-editor').value = report.formatted;
    $('oaa-compile-output').replaceChildren(formatOaaDiagnostics(report));
  } catch (err) {
    $('publish-error').textContent = err.message;
  }
};
$('bundle-file').onchange = async (e) => {
  try {
    state.bundle = JSON.parse(await e.target.files[0].text());
    const rawJson = JSON.stringify(
      {
        agent: state.bundle.agent?.id,
        version: state.bundle.digest,
        files: state.bundle.files?.map((f) => f.path),
      },
      null,
      2,
    );
    const wrap = el('div', undefined, 'bundle-info-wrap');
    const summaryList = el('div', undefined, 'bundle-summary');
    summaryList.append(
      el(
        'div',
        t('dlg.publish.bundle.agent', {
          id: state.bundle.agent?.id || t('dlg.publish.bundle.unspecified'),
        }),
      ),
      el(
        'div',
        t('dlg.publish.bundle.digest', {
          digest: state.bundle.digest ? state.bundle.digest.slice(0, 16) + '…' : '—',
        }),
        'muted',
      ),
      el('div', t('dlg.publish.bundle.files', { n: state.bundle.files?.length || 0 }), 'muted'),
    );
    const rawDetails = el('details', undefined, 'raw-details');
    rawDetails.append(el('summary', t('dlg.publish.raw')), el('pre', rawJson, 'code small'));
    wrap.append(summaryList, rawDetails);
    $('bundle-preview').replaceChildren(wrap);
  } catch (err) {
    state.bundle = null;
    $('publish-error').textContent = t('dlg.publish.bundle.parse_failed');
  }
};
$('publish-form').onsubmit = async (e) => {
  e.preventDefault();
  $('publish-error').textContent = '';
  let targetId = null;
  if (state.publishMode === 'native') {
    targetId = $('native-id').value.trim();
  } else if (state.publishMode === 'oaa') {
    const src = $('oaa-source-editor').value || '';
    const match = /(?:^|\s)agent\s+([A-Za-z0-9_.\-\/]+)/.exec(src);
    if (match) targetId = match[1];
  } else if (state.bundle) {
    targetId = state.bundle.agent?.id;
  }
  if (targetId && state.data?.agents?.some((a) => a.id === targetId)) {
    const confirmed = await confirmAction({
      title: t('dlg.publish.overwrite.title', { id: targetId }),
      message: t('dlg.publish.overwrite.message'),
      accept: t('dlg.publish.overwrite.accept'),
      danger: true,
    });
    if (!confirmed) return;
  }
  const submit = $('publish-form').querySelector('[type=submit]');
  await withBusy(submit, t('dlg.publish.publishing'), async () => {
    try {
      let published;
      let models = [];
      if (state.publishMode === 'native') {
        const id = $('native-id').value.trim();
        if (!id) throw Error(t('dlg.publish.err.no_id'));
        models = publishDraft.models.length ? [...publishDraft.models] : ['default'];
        const limited = $('model-restrict').checked;
        if (limited) models = models.filter((m) => m !== 'default');
        if (!models.length) throw Error(t('models.pick_required'));
        published = await api('POST', '/v1/agents/publish-native', {
          id,
          engine: $('native-engine').value,
          models,
          model_policy: {
            mode: $('model-follow').checked ? 'discover' : 'declared',
            ...(limited ? { allow: models } : {}),
          },
          access: {
            modes: renderPublishToolModes($('native-engine').value),
            defaultMode: $('publish-tool-boundary').value,
            approval: $('publish-auto-approve').checked ? 'auto' : $('publish-approver').value,
            trust: 'private',
            workspace: projectWorkspaceSelection(id),
          },
          orchestration: {
            enabled: $('publish-orchestrate').checked,
            helpers: [...$('publish-helpers').selectedOptions]
              .map((o) => o.value)
              .filter((helper) => helper !== id),
          },
          ...($('publish-auto-approve').checked ? { approvals: 'auto' } : {}),
        });
      } else if (state.publishMode === 'oaa') {
        const source = $('oaa-source-editor').value.trim();
        if (!source) throw Error(t('dlg.publish.err.no_source'));
        published = await api('POST', '/v1/agents/publish-oaa', { source });
      } else {
        if (!state.bundle) throw Error(t('dlg.publish.err.no_bundle'));
        published = await api('POST', '/v1/agents/publish', state.bundle);
      }
      // Published, but nothing on this machine can run it yet: keep the dialog open and say why.
      if (published?.warning?.code === 'not_runnable_here') {
        await load();
        $('publish-error').textContent = t('dlg.publish.not_runnable', {
          id: published.id ?? '',
          message: published.warning.message,
        });
        return;
      }
      $('publish-dialog').close();
      toast(
        published?.id
          ? t('dlg.publish.published', { id: published.id })
          : t('dlg.publish.published_plain'),
      );
      await load();
      if ($('publish-then-key').checked && published?.id && isAdmin())
        openKeyDialog({
          agents: [published.id],
          model: models.length
            ? (state.data?.agents
                ?.find((a) => a.id === published.id)
                ?.routes?.find((r) => r.model === models[0])?.id ?? models[0])
            : 'auto',
        });
    } catch (err) {
      $('publish-error').textContent = err.message;
    }
  });
};

// The auto-approve risk note is only shown while the box is checked.
$('publish-auto-approve').addEventListener('change', (event) => {
  $('publish-auto-approve-note').hidden = !event.target.checked;
});
