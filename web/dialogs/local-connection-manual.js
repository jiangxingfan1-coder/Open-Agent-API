import { state } from '../lib/state.js';
import { button, copyText, el, iconButton, icons } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { agentModelChoices, agentModelName, openKeyDialog } from './key.js';

const TARGET_CATALOG = {
  dsh: { clientId: 'dsh', name: 'DeepSeek Harness', icon: 'deepseek-harness', channel: 'api' },
  opencode: { clientId: 'opencode-acp', name: 'OpenCode', icon: 'opencode-acp', channel: 'api' },
  codex: { clientId: 'codex', name: 'Codex', icon: 'codex', channel: 'api' },
  'claude-desktop': {
    clientId: 'claude-desktop',
    name: 'Claude Desktop',
    icon: 'claude',
    channel: 'mcp',
  },
  cursor: { clientId: 'cursor', name: 'Cursor', icon: 'cursor', channel: 'mcp' },
  windsurf: { clientId: 'windsurf', name: 'Windsurf', icon: 'windsurf', channel: 'mcp' },
  'claude-code': { clientId: 'claude', name: 'Claude Code', icon: 'claude', channel: 'mcp' },
};

const CLIENT_TARGETS = {
  dsh: { api: 'dsh' },
  'opencode-acp': { api: 'opencode', manual: true },
  opencode: { api: 'opencode', manual: true },
  codex: { api: 'codex', manual: true },
  claude: { mcp: 'claude-code', manual: true },
  'claude-code': { mcp: 'claude-code', manual: true },
  'claude-desktop': { mcp: 'claude-desktop' },
  cursor: { mcp: 'cursor' },
  windsurf: { mcp: 'windsurf' },
};

export function targetClientMeta(target, clients = []) {
  const entry = TARGET_CATALOG[target] ?? TARGET_CATALOG.dsh;
  const matched = clients.find((c) => c.id === entry.clientId || c.id === target);
  if (matched) return matched;
  return {
    id: entry.clientId,
    name: entry.name,
    icon: entry.icon,
    connection: 'managed',
    targets: { [entry.channel]: target },
  };
}

export function resolveClientTargets(client) {
  const preset = CLIENT_TARGETS[client.id] ?? {};
  return {
    api: client.targets?.api ?? preset.api,
    mcp: client.targets?.mcp ?? preset.mcp,
    manual: client.connection === 'manual' || !!preset.manual || !!client.guide,
  };
}

export function protocolName(protocol) {
  return (
    {
      responses: 'OpenAI Responses',
      messages: 'Anthropic Messages',
      'chat-completions': 'OpenAI Chat Completions',
    }[protocol] ?? ''
  );
}

/** Manual setup stays in the normal, explicitly confirmed API-key flow; no client files are edited. */
export function manualConnection(body, actions, client, dlg, valid) {
  const engines = new Set([client.id, ...(client.engines ?? [])]);
  const agents = (state.data?.agents ?? []).filter((a) => !engines.has(a.engine));
  let selected = agents[0];
  let model = 'auto';
  const fields = el('div', undefined, 'local-dialog-fields');
  const source = el('select');
  source.setAttribute('aria-label', t('connections.source'));
  for (const agent of agents) {
    const option = el('option', agent.id);
    option.value = agent.id;
    source.append(option);
  }
  const models = el('select');
  models.setAttribute('aria-label', t('connections.model'));
  for (const [label, input] of [
    [t('connections.source'), source],
    [t('connections.model'), models],
  ]) {
    const field = el('label');
    field.append(el('span', label), input);
    fields.append(field);
  }
  fields.classList.add('local-manual-fields');
  const endpoint = client.protocol === 'messages' ? location.origin : `${location.origin}/v1`;
  const values = el('dl', undefined, 'local-manual-values');
  const modelValue = el('code');
  for (const [label, value, text] of [
    ['Base URL', el('code', endpoint), () => endpoint],
    ['Model', modelValue, () => (selected ? agentModelName(selected.id, model) : '')],
  ]) {
    const row = el('div');
    row.append(
      el('dt', label),
      value,
      iconButton(t('common.copy'), 'copy', () =>
        copyText(text(), t(label === 'Base URL' ? 'dlg.key.base_copied' : 'dlg.key.model_copied')),
      ),
    );
    values.append(row);
  }
  const renderModels = () => {
    models.replaceChildren();
    for (const choice of agentModelChoices(selected)) {
      const option = el('option', choice.label);
      option.value = choice.value;
      option.selected = choice.value === model;
      option.disabled = choice.unavailable;
      models.append(option);
    }
    modelValue.textContent = selected ? agentModelName(selected.id, model) : '';
  };
  source.onchange = () => {
    selected = agents.find((a) => a.id === source.value);
    model = 'auto';
    renderModels();
  };
  models.onchange = () => {
    model = models.value;
    modelValue.textContent = agentModelName(selected.id, model);
  };
  if (agents.length) {
    body.append(fields, values);
    renderModels();
  } else body.append(el('p', t('connections.manual_no_source'), 'local-notice'));
  const create = button(
    t('common.createKey'),
    'key-round',
    () => {
      if (!valid() || !selected) return;
      dlg.close();
      openKeyDialog({ agents: [selected.id], model });
    },
    'primary',
  );
  create.disabled = !selected;
  actions.append(create);
  icons();
}
