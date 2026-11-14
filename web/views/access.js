import { hasFeature, isAdmin, state } from '../lib/state.js';
import { lang, t } from '../lib/i18n.js';
import { SCOPE_NAMES, compactTokens, num } from '../lib/format.js';
import { formatDate } from '../shared/format.js';
import {
  agentGlyph,
  button,
  cell,
  confirmAction,
  copyText,
  el,
  empty,
  icon,
  iconButton,
  panel,
  status,
  table,
  toast,
} from '../lib/dom.js';
import { api } from '../lib/api.js';
import { load } from '../lib/live.js';
import { agentById, filterText, setCount } from './common.js';
import { openKeyDialog } from '../dialogs/key.js';
import { snippetBlock } from '../dialogs/snippet.js';

export function renderAccess(body) {
  const d = state.data;
  const e = d.endpoints ?? {};
  const base = e.base_url ?? d.public_base_url ?? location.origin;
  const sample = d.agents[0]?.id ?? 'agent/research';
  const page = el('div', undefined, 'access-page');
  const list = panel(t('view.access.title'));
  const rows = [
    ['OpenAI SDK', 'Base URL · Responses / Chat Completions', e.openai_sdk_base_url],
    ['Responses', t('access.hintResponses'), e.responses_endpoint],
    ['Chat Completions', t('access.hintChat'), e.chat_completions_endpoint],
    [t('access.strict'), t('access.hintStrict'), e.openai_compat_base_url],
    ['Claude Messages', t('access.hintClaude'), e.claude_messages_endpoint],
    [
      'Gemini',
      t('access.hintGemini'),
      e.gemini_models_prefix && `${e.gemini_models_prefix}/{agent}:generateContent`,
    ],
    ['UAP/1', t('access.hintUap'), e.uap_endpoint],
    ['OAA/1', t('access.hintOaa'), `${base}/v1/invoke`],
    [t('access.universal'), t('access.hintUniversal'), e.universal_endpoint],
    [t('access.workerConnect'), t('access.hintWorker'), e.worker_connect_ws],
  ].filter(([, , url]) => url);
  list.body.classList.add('endpoint-list');
  for (const [label, hint, url] of rows) {
    const row = el('div', undefined, 'endpoint-row');
    const name = el('div', undefined, 'endpoint-label');
    const note = el('small', hint);
    note.title = hint;
    name.append(el('strong', label), note);
    const target = el('code', url, 'endpoint-url');
    target.tabIndex = 0;
    row.append(
      name,
      target,
      iconButton(t('access.copyEndpoint', { label }), 'copy', () =>
        copyText(url, t('access.copiedEndpoint', { label })),
      ),
    );
    list.body.append(row);
  }
  const code = `from openai import OpenAI

client = OpenAI(
    base_url="${e.openai_sdk_base_url ?? `${base}/v1`}",
    api_key="sk-oaa-…",  # ${t('access.pyKeyComment')}
)
response = client.responses.create(
    model="${sample}",
    input="${t('access.pyInput')}",
    metadata={"oaa.model": "auto"},
    background=True,
)
print(client.responses.retrieve(response.id).status)`;
  const quick = panel(t('access.quickStart'));
  quick.body.append(snippetBlock(t('access.pySample'), code, t('access.sampleCopied')));
  const mcp = panel(t('access.mcpPanel'));
  const steps = el('ol', undefined, 'steps');
  const step = (strong, text, command, title) => {
    const li = el('li');
    li.append(el('strong', strong), el('span', ` ${text}`));
    if (command) li.append(snippetBlock(title, command, t('access.commandCopied')));
    steps.append(li);
  };
  step(t('access.stepKey'), t('access.stepKeyText'));
  step(
    t('access.stepMcp'),
    t('access.stepMcpText'),
    `npm run oaa -- integration --out /absolute/path/mcp.json \\
  --url ${base} --token-file /path/to/scoped.token`,
    t('access.mcpCommandTitle'),
  );
  step(
    t('access.stepCli'),
    t('access.stepCliText'),
    `npm run oaa -- invoke ${sample} --model auto --input '${t('access.cliTask')}'`,
    t('access.cliCommandTitle'),
  );
  mcp.body.append(steps);
  const pair = el('div', undefined, 'access-pair');
  pair.append(quick.box, mcp.box);
  page.append(list.box, pair);
  if (hasFeature('client-tools-policy-v1')) page.append(callerToolsPanel(e, base, sample).box);
  body.append(page);
}
// How the tools a caller sends along are handled when the caller is itself an agent
// (docs/harness.md).
function callerToolsPanel(e, base, sample) {
  const box = panel(t('access.callerTitle'));
  box.body.classList.add('caller-tools');
  box.body.append(el('p', t('access.callerText'), 'muted'));
  const modes = table(
    [
      { text: t('access.colMode'), width: 170 },
      { text: t('access.colMeaning'), min: 240 },
    ],
    [
      [t('access.modeManaged'), t('access.modeManagedText')],
      [t('access.modeBridge'), t('access.modeBridgeText')],
      [t('access.modeReject'), t('access.modeRejectText')],
    ].map(([mode, text]) => {
      const tr = el('tr');
      tr.append(cell(mode), cell(text));
      return tr;
    }),
  );
  // The panel is already the surface: the table inside it needs no card of its own.
  box.body.append(modes.firstElementChild);
  const code = `curl ${e.compat_chat_completions_endpoint ?? `${base}/v1/compat/chat/completions`} \\
  -H "Authorization: Bearer sk-oaa-…" \\
  -H "Content-Type: application/json" \\
  -H "X-OAA-Client-Tools: bridge" \\
  -d '{"model": "${sample}", "messages": [{"role": "user", "content": "${t('access.curlTask')}"}],
       "tools": [{"type": "function", "function": {"name": "edit_file", "parameters": {"type": "object"}}}]}'`;
  const doc = el('p', undefined, 'muted');
  const [before, after] = t('access.bridgeNote').split('{doc}');
  doc.append(el('span', before), el('code', 'docs/harness.md'), el('span', after));
  box.body.append(snippetBlock(t('access.curlSample'), code, t('access.sampleCommandCopied')), doc);
  return box;
}

/* ── API keys ─────────────────────────────────────────── */
// Permissions: admin is written on its own as "Admin", the rest are listed by name, so the
// line fits on one row.
const scopeLine = (scopes) =>
  scopes.map((s) => (s === 'admin' ? t('scope.adminShort') : (SCOPE_NAMES[s] ?? s))).join(' · ');
// Which agents it can call: at most two are named, the rest fold into "N in all", and the full
// list is in the hover tooltip.
function agentsCell(ids) {
  const box = el('div', undefined, 'key-agents');
  if (!ids.length) {
    box.append(el('span', '—', 'muted'));
    return box;
  }
  if (ids.includes('*')) {
    box.append(el('span', t('common.allAgents'), 'key-agents-all'));
    return box;
  }
  const named = ids.slice(0, 2);
  const first = agentById(named[0]);
  const text = el('span', named.join(t('common.listSeparator')), 'key-agents-text');
  text.translate = false;
  box.append(agentGlyph(first?.engine ?? named[0], 'tiny', first?.preset), text);
  if (ids.length > named.length)
    box.append(el('span', t('access.agentsMore', { n: ids.length }), 'key-agents-more'));
  box.title = ids.join('\n');
  return box;
}

// Delete: takes effect at once and the key leaves the list; tasks already accepted are not
// cancelled and usage records are kept.
function deleteKeyButton(k) {
  const b = button(
    t('access.delete'),
    'trash-2',
    async () => {
      if (
        !(await confirmAction({
          title: t('access.deleteTitle', { name: k.name }),
          message: t('access.deleteMessage'),
          accept: t('access.deleteAccept'),
          danger: true,
        }))
      )
        return;
      try {
        await api('DELETE', `/v1/keys/${encodeURIComponent(k.id)}`);
        state.keys = null;
        await load();
        toast(t('access.deleted'));
      } catch (e) {
        toast(e.message);
      }
    },
    'subtle small-btn',
  );
  b.setAttribute('aria-label', t('access.deleteName', { name: k.name }));
  return b;
}
// A key defined in the config file cannot be deleted here: give a visible reason rather than
// leaving a blank.
function configKeyNote() {
  const note = el('span', undefined, 'key-locked');
  const hint = t('access.configKey');
  note.tabIndex = 0;
  note.title = hint;
  note.setAttribute('role', 'img');
  note.setAttribute('aria-label', hint);
  note.append(icon('lock'));
  return note;
}

export function renderKeys(body) {
  if (!isAdmin()) {
    setCount('');
    body.append(
      empty(t('access.needsAdmin'), t('access.needsAdminHint'), {
        icon: 'shield-check',
      }),
    );
    return;
  }
  if (!state.keys) {
    setCount('');
    body.append(empty(t('access.reading'), t('common.wait'), { icon: 'key-round', compact: true }));
    return;
  }
  const filter = filterText();
  // A deleted key no longer appears in the list; older gateways still return revoked rows, which
  // are left out here too.
  const keys = state.keys.filter((k) => !k.revoked);
  const rows = keys.filter((k) =>
    `${k.name} ${(k.agents ?? []).join(' ')}`.toLowerCase().includes(filter),
  );
  setCount(t('access.count', { n: rows.length }));
  if (!rows.length) {
    body.append(
      keys.length
        ? empty(t('access.noMatch'), t('access.noMatchHint'), { icon: 'search', compact: true })
        : empty(t('access.none'), t('access.noneHint'), {
            icon: 'key-round',
            action: button(t('common.createKey'), 'plus', () => openKeyDialog(), 'subtle'),
          }),
    );
    return;
  }
  body.append(
    table(
      [
        { text: t('access.colName'), min: 180 },
        { text: t('access.colAccess'), min: 200 },
        { text: t('access.colUsage'), align: 'num', width: 108 },
        { text: t('access.colStatus'), width: 92 },
        { text: '', align: 'actions', width: 84 },
      ],
      rows.map((k) => {
        const tr = el('tr');
        const title = el('div');
        const expires = k.quota?.expiresAt;
        const expired = !!expires && expires <= Date.now();
        const origin = k.managed ? t('access.originConsole') : t('nodes.sourceConfigured');
        const name = el('div', k.name, 'row-title');
        name.title = k.name;
        title.append(
          name,
          el(
            'div',
            expires
              ? t(expired ? 'access.expired' : 'access.expires', {
                  origin,
                  date: formatDate(expires, lang),
                })
              : origin,
            'node-detail',
          ),
        );
        const access = el('div');
        access.append(agentsCell(k.agents ?? []), el('div', scopeLine(k.scopes), 'node-detail'));
        const usage = el('div', undefined, 'key-usage');
        if (k.usage) {
          const tokens = el(
            'span',
            t('access.tokens', { n: compactTokens(k.usage.usedTokens) }),
            'node-detail',
          );
          tokens.title = t('access.tokens', { n: num(k.usage.usedTokens) });
          usage.append(el('span', t('access.usageRuns', { n: num(k.usage.usedRuns) })), tokens);
        } else usage.append(el('span', '—', 'muted'));
        // Expired means "can no longer be used", not something waiting on a person: neutral.
        const state_ = expired
          ? el('span', t('status.expired'), 'status neutral pill')
          : status('active', true);
        const actions = el('div', undefined, 'row-action');
        if (k.managed) actions.append(deleteKeyButton(k));
        else actions.append(configKeyNote());
        tr.append(cell(title), cell(access), cell(usage, 'num'), cell(state_), cell(actions));
        return tr;
      }),
    ),
  );
}
