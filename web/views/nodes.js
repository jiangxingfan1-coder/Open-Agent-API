import { hooks, isNodeAdmin, state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import { engineName } from '../lib/format.js';
import {
  agentGlyph,
  button,
  cell,
  confirmAction,
  el,
  empty,
  error,
  icon,
  status,
  table,
  toast,
  withBusy,
} from '../lib/dom.js';
import { api } from '../lib/api.js';
import { live, load } from '../lib/live.js';
import { filterText, setCount } from './common.js';
import { openEverythingAcpImport } from '../dialogs/everything-acp.js';

export function nodeState(n) {
  return n.state === 'revoked'
    ? 'revoked'
    : n.state === 'draining'
      ? n.drained
        ? 'drained'
        : 'draining'
      : n.connected
        ? 'online'
        : 'offline';
}
// A command that changes a machine's state: confirm (if needed), send the request, reload.
async function nodeCommand(n, action, confirmation) {
  const token = state.token;
  if (state.nodeCommands.has(n.nodeId)) return;
  if (confirmation && !(await confirmAction(confirmation))) return;
  state.nodeCommands.add(n.nodeId);
  hooks.renderView(true);
  try {
    await api('POST', `/v1/nodes/${encodeURIComponent(n.nodeId)}/${action}`, {}, { token });
    if (state.token === token) await load();
  } catch (e) {
    if (state.token === token) toast(e.message);
  } finally {
    state.nodeCommands.delete(n.nodeId);
    if (state.token === token) hooks.renderView(true);
  }
}

// The main action (pause or resume scheduling) carries a label; revoking is irreversible, so it
// stands apart at the end in a quieter style.
function nodeActions(n) {
  const actions = el('div', undefined, 'row-action node-actions');
  if (!n.manageable || n.state === 'revoked') return actions;
  const busy = state.nodeCommands.has(n.nodeId);
  const resume = n.state === 'draining';
  const toggle = button(
    resume ? t('nodes.resume') : t('nodes.pause'),
    null,
    () =>
      nodeCommand(
        n,
        resume ? 'resume' : 'drain',
        resume
          ? null
          : {
              title: t('nodes.pauseTitle', { id: n.nodeId }),
              message: t('nodes.pauseMessage'),
              accept: t('nodes.pause'),
              danger: true,
            },
      ),
    'subtle',
  );
  const revoke = button(
    t('nodes.revoke'),
    null,
    () =>
      nodeCommand(n, 'revoke', {
        title: t('nodes.revokeTitle', { id: n.nodeId }),
        message: t('nodes.revokeMessage'),
        accept: t('nodes.revokeAccept'),
        danger: true,
      }),
    'node-revoke',
  );
  for (const [control, label] of [
    [toggle, resume ? t('nodes.resume') : t('nodes.pause')],
    [revoke, t('nodes.revokeAccept')],
  ]) {
    control.setAttribute('aria-label', `${label} ${n.nodeId}`);
    control.title = `${label} ${n.nodeId}`;
    control.disabled = busy;
    actions.append(control);
  }
  return actions;
}

// The capability list takes one line: what does not fit is cut off, the full list is in the
// hover tooltip.
function capabilityList(items) {
  if (!items.length) return el('span', t('nodes.notDeclared'), 'muted');
  const text = el('div', items.join(' · '), 'node-caps');
  text.title = items.join(t('common.listSeparator'));
  return text;
}

export function renderNodes(body) {
  if (!isNodeAdmin()) {
    setCount('');
    body.append(
      empty(t('nodes.needsAdmin'), t('nodes.needsAdminHint'), {
        icon: 'shield-check',
      }),
    );
    return;
  }
  const filter = filterText();
  const online = new Map(state.data.nodes.map((node) => [node.nodeId, node]));
  const all =
    state.registrations ??
    state.data.nodes.map((node) => ({
      ...node,
      state: node.admission_state,
      connected: true,
      source: node.local ? 'local' : 'configured',
      manageable: false,
    }));
  const rows = all.filter((n) => n.nodeId.toLowerCase().includes(filter));
  setCount(t('nodes.count', { n: rows.length }));
  const sources = {
    local: t('nodes.sourceLocal'),
    configured: t('nodes.sourceConfigured'),
    enrolled: t('nodes.sourceEnrolled'),
    retired: t('nodes.sourceRetired'),
  };
  const root = el('div', undefined, 'nodes');
  body.append(root);
  root.append(button(t('eacp.import'), 'download', openEverythingAcpImport));
  if (!rows.length)
    root.append(
      all.length
        ? empty(t('nodes.noMatch'), t('common.tryKeyword'), { icon: 'search', compact: true })
        : empty(t('nodes.none'), t('nodes.noneHint'), {
            icon: 'server',
            compact: true,
          }),
    );
  else
    root.append(
      table(
        [
          { text: t('nodes.col.machine') },
          { text: t('nodes.col.capabilities') },
          { text: t('nodes.col.capacity'), align: 'num', width: 84 },
          { text: t('nodes.col.status'), width: 104 },
          { text: '', align: 'actions', width: 164 },
        ],
        rows.map((n) => {
          const tr = el('tr');
          const live = online.get(n.nodeId);
          const title = el('div');
          const identifier = el('div', n.nodeId, 'row-title node-id');
          identifier.translate = false;
          identifier.title = n.nodeId;
          const source = sources[n.source] ?? n.source;
          title.append(
            identifier,
            el(
              'div',
              live ? t('nodes.warm', { n: live.warm.length, source }) : source,
              'node-detail',
            ),
          );
          const caps = capabilityList(
            live
              ? [...live.providers, ...live.natives, ...live.capabilities.map((c) => c.id)]
              : (n.capability_grants ?? []),
          );
          tr.append(
            cell(title),
            cell(caps),
            cell(n.connected && live ? `${n.active} / ${live.concurrency}` : '—', 'num'),
            cell(status(nodeState(n))),
            cell(nodeActions(n)),
          );
          return tr;
        }),
      ),
    );
  if (state.backends?.length) {
    const title = el('div', undefined, 'section-title');
    title.append(el('h2', t('engine.local')), el('p', t('nodes.localIntro')));
    const grid = el('div', undefined, 'ext-grid');
    for (const b of state.backends) {
      const display = engineName(b.engine, b.name);
      const card = el('div', undefined, 'ext-item adapter-card');
      const name = el('strong', display, 'ext-name');
      const sub = el('div', undefined, 'ext-sub');
      const path = el('code', b.executable || '—');
      path.title = b.executable || '';
      sub.append(path);
      const label = el('label', undefined, 'switch');
      label.title = b.enabled ? t('status.enabled') : t('status.disabled');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!b.enabled;
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', t('nodes.enableName', { name: display }));
      input.onchange = async () => {
        const target = input.checked;
        if (
          target &&
          !(await confirmAction({
            title: t('nodes.enableTitle', { name: display }),
            message: t('nodes.enableMessage'),
            accept: t('nodes.enable'),
          }))
        ) {
          input.checked = false;
          return;
        }
        try {
          await api('POST', `/v1/local/backends/${encodeURIComponent(b.engine)}`, {
            enabled: target,
          });
          await load();
        } catch (e) {
          input.checked = !!b.enabled;
          toast(e.message);
        }
      };
      label.append(input, el('span'));
      // ACP and A2A adapters can prove the conversion path with a handshake (no prompt, no model).
      if (b.kind === 'acp' || b.transport === 'a2a') {
        const check = button(
          t('nodes.check'),
          'plug-zap',
          async () => {
            check.disabled = true;
            try {
              const r = await api(
                'POST',
                `/v1/local/backends/${encodeURIComponent(b.engine)}/check`,
              );
              const who = r.agent?.name
                ? `${r.agent.name}${r.agent.version ? ` ${r.agent.version}` : ''}`
                : '';
              toast(
                r.status === 'passed'
                  ? t('nodes.checkOk', {
                      who: who ? t('nodes.checkWho', { who }) : '',
                      protocol: r.protocol_version
                        ? t('nodes.checkProtocol', { version: r.protocol_version })
                        : '',
                    })
                  : t('nodes.checkFailed', { reason: r.message ?? r.status }),
              );
            } catch (e) {
              toast(e.message);
            } finally {
              check.disabled = false;
            }
          },
          'adapter-check',
        );
        sub.append(check);
      }
      card.append(agentGlyph(b.engine, '', b.preset), name, label, sub);
      grid.append(card);
    }
    root.append(title, grid);
  }
  if (state.presets?.length) {
    const found = state.presets.filter((p) => p.configured || p.installed_executable).length;
    const title = el('div', undefined, 'section-title');
    title.append(
      el('h2', t('nodes.presetsTitle')),
      el('p', t('nodes.presetsIntro', { total: state.presets.length, found })),
    );
    const grid = el('div', undefined, 'ext-grid');
    for (const p of state.presets) {
      const tone = p.configured ? 'enabled' : p.installed_executable ? 'installed' : 'missing';
      const card = el('div', undefined, `ext-item preset is-${tone}`);
      const kind = { native: t('engine.local'), acp: 'ACP', a2a: 'A2A' }[p.kind] ?? p.kind ?? 'ACP';
      const maturity = { preview: t('nodes.preview'), community: t('nodes.community') }[p.maturity];
      const facts = [
        kind,
        maturity,
        'verified' in p && !p.verified ? t('nodes.unverified') : null,
      ].filter(Boolean);
      const notes = [p.notes, p.verified ? t('nodes.verifiedOn', { date: p.verified }) : null]
        .filter(Boolean)
        .join('\n');
      if (notes) card.title = notes;
      const name = el('strong', p.name || engineName(p.id), 'ext-name');
      const sub = el('div', undefined, 'ext-sub');
      sub.append(el('span', facts.join(' · '), 'ext-facts'));
      if (p.docs_url) {
        const docs = el('a', undefined, 'ext-doc');
        docs.href = p.docs_url;
        docs.target = '_blank';
        docs.rel = 'noopener noreferrer';
        docs.title = t('nodes.docs', { name: p.name });
        docs.setAttribute('aria-label', docs.title);
        docs.append(icon('external-link'));
        sub.append(docs);
      }
      // An agent that is installed but not yet in the local configuration: one step to enable it,
      // no config file to edit and no restart. The button itself says it is installed, so the
      // "Installed" label is not repeated.
      const canEnable = tone === 'installed' && p.kind === 'acp' && isNodeAdmin();
      let side;
      if (canEnable) {
        side = button(t('nodes.enable'), 'power', () => enablePreset(p, side), 'subtle small-btn');
        side.title = t('nodes.enableInstalled', { name: p.name });
        side.setAttribute('aria-label', side.title);
      } else
        side = el(
          'span',
          {
            enabled: t('nodes.toneEnabled'),
            installed: t('nodes.toneInstalled'),
            missing: t('nodes.toneMissing'),
          }[tone],
          `status ${tone === 'enabled' ? 'good' : 'neutral'}`,
        );
      card.append(agentGlyph(p.engine || p.id, '', p.preset || p.id), name, side, sub);
      grid.append(card);
    }
    root.append(title, grid);
  }
}

export async function enablePreset(preset, control) {
  const ok = await confirmAction({
    title: t('nodes.enableTitle', { name: preset.name }),
    message: t('nodes.enablePresetMessage'),
    accept: t('nodes.enable'),
  });
  if (!ok) return;
  try {
    await withBusy(control, t('nodes.enabling'), () =>
      api('POST', `/v1/local/presets/${encodeURIComponent(preset.id)}/enable`),
    );
    toast(t('nodes.enabled', { name: preset.name }));
    await load();
  } catch (failure) {
    error(failure.message);
  }
}
