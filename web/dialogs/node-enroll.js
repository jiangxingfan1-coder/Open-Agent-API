import { sessionApi } from '../lib/api.js';
import { button, copyText, el, iconButton, icons, toast, withBusy } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { load } from '../lib/live.js';
import { state } from '../lib/state.js';

function parseCsvList(value) {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : ['*'];
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteWorkerCommand({ gatewayUrl, owner, nodeId, token }) {
  const safeId = String(nodeId).replace(/[^A-Za-z0-9_-]/g, '') || 'worker';
  const dir = `$HOME/.oaa-workers/${safeId}`;
  const writer =
    'const fs=require("node:fs"),p=require("node:path"),[,d,id,own,url]=process.argv;' +
    'fs.writeFileSync(p.join(d,"worker.json"),JSON.stringify({nodeId:id,owner:own,dataDir:p.join(d,"state"),gatewayUrl:url,tokenFile:p.join(d,"node.token")},null,2)+"\\n",{mode:0o600});';
  return [
    `mkdir -p "${dir}" && chmod 700 "${dir}"`,
    `printf '%s' ${shellSingleQuote(token)} > "${dir}/node.token" && chmod 600 "${dir}/node.token"`,
    `node -e ${shellSingleQuote(writer)} "${dir}" ${shellSingleQuote(safeId)} ${shellSingleQuote(owner)} ${shellSingleQuote(gatewayUrl)}`,
    `oaa node join --config "${dir}/worker.json"`,
  ].join('\n');
}

export function openNodeEnrollDialog() {
  const token = state.token;
  const api = sessionApi(token);
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal');
  const header = el('header', undefined, 'dialog-heading');
  header.append(
    el('h2', t('dlg.nodePair.title')),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );

  const form = el('form');
  form.append(el('p', t('dlg.nodePair.subtitle'), 'muted'));

  const nodeId = el('input');
  nodeId.required = true;
  nodeId.pattern = '[A-Za-z0-9_-]{1,64}';
  nodeId.value = `worker-${Math.random().toString(36).slice(2, 6)}`;
  nodeId.autocomplete = 'off';

  const agents = el('input');
  agents.required = true;
  agents.value = '*';
  agents.autocomplete = 'off';

  const capabilities = el('input');
  capabilities.required = true;
  capabilities.value = '*';
  capabilities.autocomplete = 'off';

  for (const [label, input] of [
    [t('dlg.nodePair.nodeId'), nodeId],
    [t('dlg.nodePair.agents'), agents],
    [t('dlg.nodePair.capabilities'), capabilities],
  ]) {
    const field = el('label', undefined, 'field');
    field.append(el('span', label), input);
    form.append(field);
  }

  const resultBox = el('div', undefined, 'pair-result');
  resultBox.hidden = true;

  const formError = el('p', undefined, 'form-error');
  formError.setAttribute('role', 'alert');
  const actions = el('div', undefined, 'dialog-actions');
  const submit = button(t('dlg.nodePair.generate'), 'key-round', () => {}, 'primary');
  submit.type = 'submit';
  actions.append(formError, submit);
  form.append(actions, resultBox);

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
    formError.textContent = '';
    if (state.token !== token) {
      dialog.close();
      return;
    }
    const desiredId = nodeId.value.trim();
    try {
      await withBusy(submit, '', async () => {
        const created = await api('POST', '/v1/keys', {
          name: desiredId,
          agents: parseCsvList(agents.value),
          capabilities: parseCsvList(capabilities.value),
          scopes: ['node'],
        });
        if (state.token !== token || !dialog.open) return;
        const gatewayUrl = state.data?.public_base_url || window.location.origin;
        const owner = state.data?.principal?.owner || 'owner';
        const command = buildRemoteWorkerCommand({
          gatewayUrl,
          owner,
          nodeId: created.node_id || desiredId,
          token: created.token,
        });

        const tokenRow = el('div', undefined, 'field');
        const tokenCode = el('code', created.token);
        const copyTok = button(
          t('dlg.nodePair.copyToken'),
          'copy',
          () => copyText(created.token, t('dlg.nodePair.tokenCopied')),
          'subtle small-btn',
        );
        tokenRow.append(el('span', t('dlg.nodePair.tokenLabel')), tokenCode, copyTok);

        const cmdRow = el('div', undefined, 'field');
        const cmdPre = el('pre', command);
        const copyCmd = button(
          t('dlg.nodePair.copyCommand'),
          'terminal',
          () => copyText(command, t('dlg.nodePair.commandCopied')),
          'primary small-btn',
        );
        cmdRow.append(el('span', t('dlg.nodePair.commandLabel')), cmdPre, copyCmd);

        resultBox.replaceChildren(tokenRow, cmdRow);
        resultBox.hidden = false;
        icons();
        await load();
        toast(t('dlg.nodePair.enrolled', { id: created.node_id || desiredId }));
      });
    } catch (e) {
      formError.textContent = e.message;
    }
  };

  dialog.showModal();
  icons();
  nodeId.focus();
  nodeId.select();
}
