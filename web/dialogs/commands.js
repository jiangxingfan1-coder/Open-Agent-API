import { isAdmin, prefs, savePrefs, state } from '../lib/state.js';
import { STATUS, VIEWS, VIEW_ICONS, engineName } from '../lib/format.js';
import { $, agentGlyph, el, error, icon, icons, openDialog } from '../lib/dom.js';
import { activityAvailable, activityWindow, load, queueLoad } from '../lib/live.js';
import { agentById } from '../views/common.js';
import { openKeyDialog } from './key.js';
import { showRun } from './runs.js';
import { openPublish } from './publish.js';
import { showAgent } from './agent.js';
import { renderView } from '../views/shell.js';
import { t } from '../lib/i18n.js';

/* ── Command palette ─────────────────────────────────── */
export const command = { items: [], index: 0 };
export function toggleSidebar() {
  savePrefs({ sidebar: prefs.sidebar === 'collapsed' ? 'expanded' : 'collapsed' });
}
export function commandItems(query) {
  const list = [];
  for (const [id, v] of Object.entries(VIEWS))
    list.push({
      group: t('dlg.cmd.group.pages'),
      label: v.title,
      hint: v.group,
      icon: VIEW_ICONS[id],
      run: () => (location.hash = id),
    });
  if (state.data && isAdmin())
    list.push(
      {
        group: t('dlg.cmd.group.actions'),
        label: t('dlg.cmd.publish'),
        icon: 'plus',
        run: openPublish,
      },
      {
        group: t('dlg.cmd.group.actions'),
        label: t('dlg.cmd.new_key'),
        icon: 'key-round',
        run: () => openKeyDialog(),
      },
    );
  if (state.data)
    list.push({
      group: t('dlg.cmd.group.actions'),
      label: t('dlg.cmd.attention'),
      hint: t('dlg.cmd.attention_hint'),
      icon: 'hand',
      run: () => {
        state.requestFilter = 'attention';
        if (location.hash === '#requests') renderView(true);
        else location.hash = 'requests';
      },
    });
  if (state.data && activityAvailable())
    list.push({
      group: t('dlg.cmd.group.actions'),
      label: activityWindow() === '7d' ? t('dlg.cmd.window_to_24h') : t('dlg.cmd.window_to_7d'),
      icon: 'chart-column',
      run: () => {
        savePrefs({ activityWindow: activityWindow() === '7d' ? '24h' : '7d' });
        queueLoad();
      },
    });
  list.push(
    {
      group: t('dlg.cmd.group.actions'),
      label: t('dlg.cmd.refresh'),
      icon: 'refresh-cw',
      run: () => load().catch((e) => error(e.message)),
    },
    {
      group: t('dlg.cmd.group.actions'),
      label:
        prefs.sidebar === 'collapsed' ? t('dlg.cmd.sidebar_expand') : t('dlg.cmd.sidebar_collapse'),
      icon: 'layout-panel-left',
      run: toggleSidebar,
    },
    {
      group: t('dlg.cmd.group.actions'),
      label: state.data ? t('dlg.cmd.switch_key') : t('dlg.cmd.connect'),
      icon: 'plug',
      run: () => openDialog('connection-dialog'),
    },
  );
  for (const [v, label, symbol] of [
    ['system', t('dlg.cmd.theme.system'), 'sun-moon'],
    ['light', t('dlg.cmd.theme.light'), 'sun'],
    ['dark', t('dlg.cmd.theme.dark'), 'moon'],
  ])
    list.push({
      group: t('dlg.cmd.group.appearance'),
      label: t('dlg.cmd.theme', { name: label }),
      icon: symbol,
      current: prefs.theme === v,
      run: () => savePrefs({ theme: v }),
    });
  list.push(
    {
      group: t('dlg.cmd.group.appearance'),
      label: prefs.palette === 'tide' ? t('dlg.cmd.palette_black') : t('dlg.cmd.palette_tide'),
      icon: 'palette',
      run: () => savePrefs({ palette: prefs.palette === 'tide' ? 'black' : 'tide' }),
    },
    {
      group: t('dlg.cmd.group.appearance'),
      label:
        prefs.density === 'compact'
          ? t('dlg.cmd.density_comfortable')
          : t('dlg.cmd.density_compact'),
      icon: 'rows-3',
      run: () => savePrefs({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' }),
    },
  );
  const agents = (state.data?.agents ?? []).map((a) => ({
    group: t('dlg.cmd.group.agents'),
    label: a.id,
    hint: engineName(a.engine),
    engine: a.engine,
    preset: a.preset,
    run: () => showAgent(a),
  }));
  const runs = (state.runs || state.data?.runs || []).slice(0, 40).map((r) => ({
    group: t('dlg.cmd.group.recent'),
    label: r.input || t('dlg.cmd.no_input'),
    hint: `${r.agent} · ${STATUS[r.status]?.[0] ?? r.status}`,
    keywords: r.id,
    engine: agentById(r.agent)?.engine ?? '',
    run: () => showRun(r.id),
  }));
  if (!query) return [...list, ...agents.slice(0, 6), ...runs.slice(0, 5)];
  // Typing an agent name also offers "generate a key for it" directly.
  const keyFor =
    state.data && isAdmin()
      ? (state.data.agents ?? []).map((a) => ({
          group: t('dlg.cmd.group.key'),
          label: t('dlg.cmd.key_for', { id: a.id }),
          hint: engineName(a.engine),
          engine: a.engine,
          preset: a.preset,
          run: () => openKeyDialog({ agents: [a.id] }),
        }))
      : [];
  return [...list, ...agents, ...keyFor, ...runs]
    .filter((c) =>
      `${c.label} ${c.hint ?? ''} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(query),
    )
    .slice(0, 60);
}
export function updateCommandSelection() {
  for (const node of $('command-list').querySelectorAll('.command-item'))
    node.setAttribute('aria-selected', String(node.id === `command-${command.index}`));
  $('command-input').setAttribute('aria-activedescendant', `command-${command.index}`);
  $(`command-${command.index}`)?.scrollIntoView({ block: 'nearest' });
}
export function renderCommands() {
  const query = $('command-input').value.trim().toLowerCase();
  command.items = commandItems(query);
  $('command-input').setAttribute('aria-expanded', String(command.items.length > 0));
  command.index = Math.min(command.index, Math.max(0, command.items.length - 1));
  const list = $('command-list');
  list.replaceChildren();
  if (!command.items.length) {
    const none = el('div', undefined, 'command-empty');
    none.append(
      icon('search'),
      el('strong', t('dlg.cmd.none')),
      el('span', t('dlg.cmd.none_hint')),
    );
    list.append(none);
    icons();
    return;
  }
  let group = null;
  command.items.forEach((c, i) => {
    if (c.group !== group) {
      group = c.group;
      list.append(el('div', group, 'command-group'));
    }
    const item = el('button', undefined, 'command-item');
    item.type = 'button';
    item.id = `command-${i}`;
    item.setAttribute('role', 'option');
    item.append(
      c.engine !== undefined ? agentGlyph(c.engine, 'small', c.preset) : icon(c.icon),
      el('span', c.label, 'label'),
    );
    if (c.current) item.append(el('span', t('dlg.cmd.current'), 'hint current'));
    else if (c.hint) item.append(el('span', c.hint, 'hint'));
    item.onmousemove = () => {
      if (command.index === i) return;
      command.index = i;
      updateCommandSelection();
    };
    item.onclick = () => runCommand(i);
    list.append(item);
  });
  icons();
  updateCommandSelection();
}
export function runCommand(i) {
  const c = command.items[i];
  if (!c) return;
  $('command-dialog').close();
  c.run();
}
export function openCommand() {
  if ($('command-dialog').open) return;
  command.index = 0;
  $('command-input').value = '';
  $('command-input').placeholder = t('dlg.cmd.placeholder');
  renderCommands();
  $('command-dialog').showModal();
  $('command-input').focus();
}
$('open-command').onclick = openCommand;
$('command-input').oninput = () => {
  command.index = 0;
  renderCommands();
};
$('command-input').onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = command.items.length;
    if (!n) return;
    command.index = (command.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    updateCommandSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runCommand(command.index);
  }
};
$('command-dialog').addEventListener('close', () =>
  $('command-input').setAttribute('aria-expanded', 'false'),
);
$('command-dialog').addEventListener('click', (e) => {
  if (e.target === $('command-dialog')) $('command-dialog').close();
});
