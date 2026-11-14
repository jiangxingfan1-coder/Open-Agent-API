import { hasFeature, hooks, sdkBaseUrl, state } from '../lib/state.js';
import { STATUS, engineName } from '../lib/format.js';
import {
  $,
  agentGlyph,
  button,
  copyText,
  el,
  empty,
  error,
  icon,
  iconButton,
  icons,
  openDialog,
  toast,
  withBusy,
} from '../lib/dom.js';
import { api } from '../lib/api.js';
import { load } from '../lib/live.js';
import { agentById } from '../views/common.js';
import { t } from '../lib/i18n.js';

/* ── API keys (Agent API generator) ──────────────────── */
// Pick agents → pick a default model per agent → name & scopes. The default model is not stored
// on the key: it is expressed through the gateway's `agent@model` selector in the `model` field.
export const SCOPE_PRESETS = { invoke: ['read', 'invoke', 'files'], read: ['read'] };
export const keyDraft = {
  mode: 'pick',
  agents: [],
  models: new Map(),
  nameEdited: false,
  lang: 'python',
  result: null,
  snippetIndex: 0,
};
export const shortAgent = (id) => String(id).split('/').pop() || String(id);
export function agentModelChoices(agent) {
  const list = [
    { value: 'auto', label: t('dlg.key.auto'), hint: t('dlg.key.auto_hint') },
    { value: '@fast', label: t('dlg.key.fast'), hint: t('dlg.key.fast_hint') },
    { value: '@best', label: t('dlg.key.best'), hint: t('dlg.key.best_hint') },
    { value: '@eco', label: t('dlg.key.eco'), hint: t('dlg.key.eco_hint') },
  ];
  for (const r of agent?.routes ?? [])
    list.push({
      value: r.id,
      label:
        r.id === r.model
          ? r.model === 'default'
            ? t('dlg.key.default_model')
            : r.model
          : `${r.id}`,
      hint:
        r.available === false
          ? t('dlg.key.route_not_ready')
          : r.id === r.model
            ? t('dlg.key.route_fixed')
            : t('dlg.key.route_fixed_model', { model: r.model }),
      route: true,
      unavailable: r.available === false,
    });
  return list;
}
// `agent` alone means automatic routing; anything else rides along as `agent@model`.
export function agentModelName(id, model) {
  if (!model || model === 'auto') return id;
  return `${id}@${String(model).replace(/^@/, '')}`;
}
export function openKeyDialog(preset) {
  const opts = preset && !(preset instanceof Event) ? preset : {};
  const agents = state.data?.agents ?? [];
  const known = (id) => agents.some((a) => a.id === id);
  keyDraft.agents = (opts.agents ?? []).filter(known);
  if (!opts.agents && agents.length === 1) keyDraft.agents = [agents[0].id];
  keyDraft.mode = opts.all || (!agents.length && !keyDraft.agents.length) ? 'all' : 'pick';
  keyDraft.models = new Map();
  if (opts.model && keyDraft.agents[0]) keyDraft.models.set(keyDraft.agents[0], opts.model);
  keyDraft.nameEdited = false;
  keyDraft.result = null;
  keyDraft.snippetIndex = 0;
  $('key-agent-search').value = '';
  $('key-name').value = '';
  $('key-expiry').value = '0';
  $('key-error').textContent = '';
  $('key-submit').disabled = false;
  syncBillingScope();
  setScopePreset('invoke');
  showKeyStep('config');
  renderKeyDraft();
  openDialog('key-dialog');
  (keyDraft.agents.length || keyDraft.mode === 'all'
    ? $('key-name')
    : $('key-agent-search')
  ).focus();
}
export function showKeyStep(step) {
  $('key-step-config').hidden = step !== 'config';
  $('key-step-result').hidden = step !== 'result';
  $('key-dialog-title').textContent =
    step === 'result' ? t('dlg.key.step.ready_title') : t('dlg.key.step.config_title');
  $('key-dialog-desc').textContent =
    step === 'result' ? t('dlg.key.step.ready_desc') : t('dlg.key.step.config_desc');
}
export function suggestedKeyName() {
  if (keyDraft.mode === 'all') return t('dlg.key.name.all');
  if (keyDraft.agents.length === 1)
    return t('dlg.key.name.one', { name: shortAgent(keyDraft.agents[0]) });
  if (keyDraft.agents.length > 1) return t('dlg.key.name.many', { n: keyDraft.agents.length });
  return '';
}
export function renderKeyDraft() {
  for (const b of document.querySelectorAll('[data-agent-mode]')) {
    const active = b.dataset.agentMode === keyDraft.mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  $('key-agent-pick').hidden = keyDraft.mode !== 'pick';
  $('key-agent-all').hidden = keyDraft.mode !== 'all';
  renderKeyAgentList();
  renderKeyModels();
  if (!keyDraft.nameEdited) $('key-name').value = suggestedKeyName();
  icons();
}
export function renderKeyAgentList() {
  const list = $('key-agent-list');
  list.replaceChildren();
  const agents = state.data?.agents ?? [];
  if (!agents.length) {
    list.append(
      empty(t('dlg.key.empty.title'), t('dlg.key.empty.text'), {
        compact: true,
        icon: 'bot',
        action: button(
          t('dlg.key.empty.action'),
          'plus',
          () => {
            $('key-dialog').close();
            void hooks.openPublish();
          },
          'subtle',
        ),
      }),
    );
    return;
  }
  const q = $('key-agent-search').value.trim().toLowerCase();
  const shown = agents.filter((a) =>
    `${a.id} ${a.engine} ${engineName(a.engine)} ${a.description ?? ''}`.toLowerCase().includes(q),
  );
  if (!shown.length) {
    list.append(el('div', t('dlg.key.no_match'), 'key-empty'));
    return;
  }
  for (const a of shown) {
    const selected = keyDraft.agents.includes(a.id);
    const option = el('label', undefined, `key-agent${selected ? ' selected' : ''}`);
    const input = el('input');
    input.type = 'checkbox';
    input.value = a.id;
    input.checked = selected;
    input.onchange = () => {
      keyDraft.agents = input.checked
        ? [...keyDraft.agents.filter((x) => x !== a.id), a.id]
        : keyDraft.agents.filter((x) => x !== a.id);
      option.classList.toggle('selected', input.checked);
      $('key-error').textContent = '';
      renderKeyModels();
      if (!keyDraft.nameEdited) $('key-name').value = suggestedKeyName();
      icons();
    };
    const text = el('span', undefined, 'key-agent-text');
    const name = el('strong', a.id);
    name.translate = false;
    // Second line: software name and availability. Availability is only information, nothing waiting for a person, so it does not use the vermilion accent.
    const code = a.status ?? (a.ready ? 'ready' : 'unavailable');
    const sub = el('small');
    sub.append(
      document.createTextNode(`${engineName(a.engine)} · `),
      el('span', STATUS[code]?.[0] ?? code, `status ${code === 'ready' ? 'good' : 'neutral'}`),
    );
    text.append(name, sub);
    const check = el('span', undefined, 'key-check');
    check.append(icon('check'));
    option.append(input, agentGlyph(a.engine, 'small', a.preset), text, check);
    list.append(option);
  }
}
export function renderKeyModels() {
  const box = $('key-model-list');
  box.replaceChildren();
  $('key-model-section').hidden = keyDraft.mode === 'all';
  $('key-step-3').textContent = keyDraft.mode === 'all' ? '2' : '3';
  if (keyDraft.mode === 'all') return;
  if (!keyDraft.agents.length) {
    box.append(el('div', t('dlg.key.pick_first'), 'key-empty'));
    return;
  }
  for (const id of keyDraft.agents) {
    const agent = agentById(id);
    const current = keyDraft.models.get(id) ?? 'auto';
    const choices = agentModelChoices(agent);
    if (!choices.some((c) => c.value === current))
      choices.push({ value: current, label: current, hint: t('dlg.key.custom_choice') });
    const row = el('div', undefined, 'key-model-row');
    const head = el('div', undefined, 'key-model-agent');
    const name = el('strong', id);
    name.translate = false;
    const out = el('code', agentModelName(id, current), 'key-model-name');
    head.append(
      agentGlyph(agent?.engine ?? id, 'small', agent?.preset),
      name,
      icon('arrow-right'),
      out,
      iconButton(t('dlg.key.copy_model'), 'copy', () =>
        copyText(out.textContent, t('dlg.key.model_copied')),
      ),
    );
    const chips = el('div', undefined, 'model-options');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', t('dlg.key.default_model_of', { id }));
    for (const c of choices) {
      const chip = el('button', undefined, `chip-choice${c.route ? ' route' : ''}`);
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(c.value === current));
      chip.classList.toggle('active', c.value === current);
      chip.classList.toggle('unavailable', !!c.unavailable);
      chip.title = c.hint;
      const label = el('span', c.label);
      label.translate = false;
      chip.append(label);
      chip.onclick = () => {
        keyDraft.models.set(id, c.value);
        renderKeyModels();
        icons();
      };
      chips.append(chip);
    }
    row.append(head, chips);
    box.append(row);
  }
}
export function setScopePreset(preset) {
  for (const b of document.querySelectorAll('#scope-presets button')) {
    const active = b.dataset.preset === preset;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  if (SCOPE_PRESETS[preset])
    for (const box of document.querySelectorAll('input[name=scope]'))
      box.checked = SCOPE_PRESETS[preset].includes(box.value);
}
document.querySelectorAll('[data-agent-mode]').forEach((b) => {
  b.onclick = () => {
    keyDraft.mode = b.dataset.agentMode;
    $('key-error').textContent = '';
    renderKeyDraft();
  };
});
document.querySelectorAll('#scope-presets button').forEach((b) => {
  b.onclick = () => setScopePreset(b.dataset.preset);
});
function syncScopePreset() {
  const checked = [...document.querySelectorAll('input[name=scope]:checked')]
    .map((x) => x.value)
    .sort()
    .join();
  const match = Object.entries(SCOPE_PRESETS).find(([, s]) => [...s].sort().join() === checked);
  for (const b of document.querySelectorAll('#scope-presets button')) {
    const active = b.dataset.preset === (match ? match[0] : 'custom');
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
}
document.querySelectorAll('input[name=scope]').forEach((box) => {
  box.onchange = syncScopePreset;
});
// The "top-up" permission only makes sense on a gateway with the developer platform enabled: this adds
// its checkbox (index.html only has the basic ones) and hides and unchecks it without the platform-v1 feature.
function syncBillingScope() {
  const on = hasFeature('platform-v1') === true;
  let row = document.querySelector('#key-scopes [data-scope=billing]');
  if (!row && on) {
    row = el('label');
    row.dataset.scope = 'billing';
    const input = el('input');
    input.type = 'checkbox';
    input.name = 'scope';
    input.value = 'billing';
    input.onchange = syncScopePreset;
    row.append(input, document.createTextNode(t('dlg.key.scope_billing')));
    $('key-scopes').append(row);
    const hint = el('p', t('dlg.key.scope_billing_hint'), 'scope-hint');
    hint.id = 'key-billing-hint';
    $('key-scopes').closest('.scope-row').after(hint);
  }
  if (!row) return;
  row.hidden = !on;
  $('key-billing-hint').hidden = !on;
  if (!on) row.querySelector('input').checked = false;
}
$('key-agent-search').oninput = () => {
  renderKeyAgentList();
  icons();
};
$('key-agent-search').onkeydown = (e) => {
  // Enter selects the single remaining match instead of submitting the form.
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const boxes = $('key-agent-list').querySelectorAll('input[type=checkbox]');
  if (boxes.length === 1 && !boxes[0].checked) boxes[0].click();
};
$('key-name').oninput = () => {
  keyDraft.nameEdited = $('key-name').value.trim() !== '';
};
export function keyResultModels() {
  if (keyDraft.mode === 'pick')
    return keyDraft.agents.map((id) => {
      const agent = agentById(id);
      return {
        id,
        engine: agent?.engine ?? id,
        preset: agent?.preset,
        model: agentModelName(id, keyDraft.models.get(id) ?? 'auto'),
      };
    });
  const agents = (state.data?.agents ?? []).slice(0, 8);
  if (!agents.length) return [{ id: 'agent/your-agent', engine: '', model: 'agent/your-agent' }];
  return agents.map((a) => ({ id: a.id, engine: a.engine, preset: a.preset, model: a.id }));
}
export function keySnippet(lang, { token, base, model }) {
  const prompt = t('dlg.key.sample_prompt');
  if (lang === 'node')
    return `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${base}',
  apiKey: '${token}',
});

const resp = await client.chat.completions.create({
  model: '${model}',
  messages: [{ role: 'user', content: '${prompt}' }],
});
console.log(resp.choices[0].message.content);`;
  if (lang === 'curl')
    return `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${prompt}"}]
  }'`;
  if (lang === 'env')
    return `OPENAI_BASE_URL=${base}
OPENAI_API_KEY=${token}
OPENAI_MODEL=${model}`;
  return `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${token}",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${prompt}"}],
)
print(resp.choices[0].message.content)`;
}
// "Copy all": the three items as environment variables, ready to paste into another agent or client.
// With several model names, OPENAI_MODEL is the selected one and the rest go in a comment line.
export function keyResultEnv(r, index = keyDraft.snippetIndex) {
  const names = r.models.map((m) => m.model);
  const model = r.models[index]?.model ?? names[0];
  const env = keySnippet('env', { token: r.token, base: r.base, model });
  return names.length > 1
    ? `${env}\n${t('dlg.key.env_models', { names: names.join(t('dlg.key.list_sep')) })}`
    : env;
}
export function renderKeyResult() {
  const r = keyDraft.result;
  if (!r) return;
  $('new-key-value').textContent = r.token;
  $('key-result-base').textContent = r.base;
  $('key-result-title').textContent = t('dlg.key.result_title', { name: r.name });
  const list = $('key-result-models');
  list.replaceChildren();
  $('key-result-all-hint').textContent =
    r.models.length > 1 ? t('dlg.key.result_all_many') : t('dlg.key.result_all_one');
  r.models.forEach((m, i) => {
    const row = el('div', undefined, `result-model${i === keyDraft.snippetIndex ? ' active' : ''}`);
    row.tabIndex = 0;
    row.title = t('dlg.key.result_model_title');
    const code = el('code', m.model);
    row.append(agentGlyph(m.engine, 'small', m.preset), code);
    row.append(
      iconButton(t('dlg.key.copy_model'), 'copy', () =>
        copyText(m.model, t('dlg.key.model_copied')),
      ),
    );
    const pick = () => {
      keyDraft.snippetIndex = i;
      renderKeyResult();
    };
    row.onclick = pick;
    row.onkeydown = (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        pick();
      }
    };
    list.append(row);
  });
  for (const b of document.querySelectorAll('#snippet-tabs button')) {
    const active = b.dataset.lang === keyDraft.lang;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  const model = r.models[keyDraft.snippetIndex]?.model ?? r.models[0]?.model;
  $('key-snippet').textContent = keySnippet(keyDraft.lang, { token: r.token, base: r.base, model });
  icons();
}
document.querySelectorAll('#snippet-tabs button').forEach((b) => {
  b.onclick = () => {
    keyDraft.lang = b.dataset.lang;
    renderKeyResult();
  };
});
$('key-form').onsubmit = async (e) => {
  e.preventDefault();
  const fail = (message) => {
    $('key-error').textContent = message;
  };
  fail('');
  const agents = keyDraft.mode === 'all' ? ['*'] : [...keyDraft.agents];
  const scopes = [...document.querySelectorAll('input[name=scope]:checked')].map((x) => x.value);
  const name = $('key-name').value.trim() || suggestedKeyName();
  if (!agents.length) return fail(t('dlg.key.err.no_agent'));
  if (!scopes.length) return fail(t('dlg.key.err.no_scope'));
  if (!name) return fail(t('dlg.key.err.no_name'));
  const body = { name: name.slice(0, 100), agents, scopes };
  const days = Number($('key-expiry').value);
  if (days > 0) body.quota = { expiresAt: Date.now() + days * 86_400_000 };
  const submit = $('key-submit');
  await withBusy(submit, t('dlg.key.generating'), async () => {
    try {
      const result = await api('POST', '/v1/keys', body);
      keyDraft.result = {
        name: result.name ?? name,
        token: result.token,
        base: sdkBaseUrl(),
        models: keyResultModels(),
      };
      keyDraft.snippetIndex = 0;
      showKeyStep('result');
      renderKeyResult();
      state.keys = null;
      void load().catch((err) => error(err.message));
      toast(t('dlg.key.generated_toast'));
    } catch (err) {
      fail(err.message);
    }
  });
};
$('copy-key').onclick = () => copyText($('new-key-value').textContent, t('dlg.key.key_copied'));
$('copy-base').onclick = () => copyText($('key-result-base').textContent, t('dlg.key.base_copied'));
$('copy-all').onclick = () =>
  keyDraft.result && copyText(keyResultEnv(keyDraft.result), t('dlg.key.all_copied'));
$('copy-snippet').onclick = () =>
  copyText($('key-snippet').textContent, t('dlg.key.snippet_copied'));
$('key-done').onclick = () => $('key-dialog').close();
$('key-again').onclick = () => {
  keyDraft.result = null;
  keyDraft.nameEdited = false;
  $('key-error').textContent = '';
  showKeyStep('config');
  renderKeyDraft();
};
// The secret is shown once: wipe it from the DOM as soon as the dialog closes.
$('key-dialog').addEventListener('close', () => {
  keyDraft.result = null;
  $('new-key-value').textContent = '';
  $('key-snippet').textContent = '';
});
