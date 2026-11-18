import {
  DEFAULT_PREFS,
  isAdmin,
  nativeBridge,
  nativePost,
  prefs,
  savePrefs,
  sdkBaseUrl,
  state,
} from '../lib/state.js';
import { lang, setLang, t } from '../lib/i18n.js';
import { MOD, SCOPE_NAMES } from '../lib/format.js';
import {
  $,
  brandMark,
  button,
  confirmAction,
  copyText,
  el,
  iconButton,
  openDialog,
  toast,
} from '../lib/dom.js';
import { activityWindow, live, queueLoad } from '../lib/live.js';
import { disconnect } from '../dialogs/connect.js';

// Language names are always written in their own language, whichever one the console is in.
const LANGUAGES = [
  ['zh', '\u4e2d\u6587'],
  ['en', 'English'],
];

/* ── Settings ────────────────────────────────────────── */
export function settingSection(id, title, desc) {
  const section = el('section', undefined, 'settings-section');
  section.id = `settings-${id}`;
  section.append(el('h2', title));
  if (desc) section.append(el('p', desc));
  const card = el('div', undefined, 'card setting-card');
  section.append(card);
  return { section, card };
}
export function settingRow(card, title, desc, control, stack = false) {
  const row = el('div', undefined, `setting-row${stack ? ' stack' : ''}`);
  const label = el('div', undefined, 'setting-label');
  label.append(el('strong', title));
  if (desc) label.append(el('p', desc));
  row.append(label);
  if (control) row.append(control);
  card.append(row);
  return row;
}
export function segmented(options, value, onPick, label) {
  const group = el('div', undefined, 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const b = el('button', text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === value));
    b.setAttribute('aria-pressed', String(v === value));
    b.classList.toggle('active', v === value);
    b.onclick = () => onPick(v);
    group.append(b);
  }
  return group;
}
export function selectControl(options, value, onPick, label) {
  const select = el('select');
  select.setAttribute('aria-label', label);
  for (const [v, text] of options) select.add(new Option(text, String(v)));
  select.value = String(value);
  select.onchange = () => onPick(select.value);
  return select;
}
// Ported from Possibility's SettingsPage theme cards and mobius-pages.css.
export function themePicker() {
  const wrap = el('div', undefined, 'theme-options');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', t('settings.theme'));
  for (const [v, text] of [
    ['light', t('settings.themeLight')],
    ['dark', t('settings.themeDark')],
    ['system', t('settings.themeSystem')],
  ]) {
    const b = el(
      'button',
      undefined,
      `theme-option theme-option-${v}${prefs.theme === v ? ' selected' : ''}`,
    );
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(prefs.theme === v));
    const preview = el('span', undefined, 'theme-preview');
    preview.setAttribute('aria-hidden', 'true');
    const content = el('b');
    content.append(el('em'), el('em'), el('s'));
    preview.append(el('i'), content);
    const name = el('span', undefined, 'theme-name');
    name.append(el('span', undefined, 'theme-radio'), el('span', text));
    b.append(preview, name);
    b.onclick = () => savePrefs({ theme: v });
    wrap.append(b);
  }
  return wrap;
}
// Base URL: one line with the address and a copy button, a sentence below; for a loopback
// address it adds that only this machine can reach it.
const isLocalHost = (host) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost');
function baseUrlValue(address) {
  let local = false;
  try {
    local = isLocalHost(new URL(address).hostname);
  } catch {
    local = false;
  }
  const box = el('div', undefined, 'address-value');
  const line = el('div', undefined, 'address-line');
  line.append(
    el('code', address),
    iconButton(t('common.copyBaseUrl'), 'copy', () => copyText(address, t('common.baseUrlCopied'))),
  );
  box.append(
    line,
    el('p', t(local ? 'settings.addressNoteLocal' : 'settings.addressNote'), 'address-note'),
  );
  return box;
}
let activeSection = 'appearance';
export function leaveSettings() {
  location.hash = state.settingsReturnHash || '#overview';
}
export function renderSettings(body) {
  const frame = el('div', undefined, 'settings-wrap');
  const nav = $('settings-nav');
  const focusedSection = nav.contains(document.activeElement)
    ? document.activeElement.dataset.section
    : null;
  nav.replaceChildren();
  const main = el('div', undefined, 'settings-main');
  const sections = [];
  const add = (id, title, desc) => {
    const { section, card } = settingSection(id, title, desc);
    section.setAttribute('aria-labelledby', `${section.id}-title`);
    section.querySelector('h2').id = `${section.id}-title`;
    sections.push([id, title]);
    main.append(section);
    return card;
  };

  let card = add('appearance', t('settings.appearance'), t('settings.appearanceDesc'));
  settingRow(
    card,
    t('settings.language'),
    t('settings.languageDesc'),
    segmented(
      LANGUAGES,
      lang,
      (v) => {
        if (v === lang) return;
        // Every string is built in the language at load time, so the page reloads.
        setLang(v);
        location.reload();
      },
      t('settings.language'),
    ),
  );
  settingRow(card, t('settings.theme'), t('settings.themeDesc'), themePicker(), true);
  settingRow(
    card,
    t('settings.density'),
    t('settings.densityDesc'),
    segmented(
      [
        ['comfortable', t('settings.densityComfortable')],
        ['compact', t('settings.densityCompact')],
      ],
      prefs.density,
      (v) => savePrefs({ density: v }),
      t('settings.density'),
    ),
  );
  settingRow(
    card,
    t('settings.motion'),
    t('settings.motionDesc'),
    segmented(
      [
        ['system', t('settings.themeSystem')],
        ['reduce', t('settings.motionReduce')],
      ],
      prefs.motion,
      (v) => savePrefs({ motion: v }),
      t('settings.motion'),
    ),
  );
  settingRow(
    card,
    t('settings.sidebar'),
    t('settings.sidebarDesc', { mod: MOD }),
    segmented(
      [
        ['expanded', t('settings.sidebarExpanded')],
        ['collapsed', t('settings.sidebarCollapsed')],
      ],
      prefs.sidebar,
      (v) => savePrefs({ sidebar: v }),
      t('settings.sidebar'),
    ),
  );

  card = add('behavior', t('settings.behavior'));
  settingRow(
    card,
    t('settings.landing'),
    t('settings.landingDesc'),
    selectControl(
      [
        ['overview', t('view.overview.title')],
        ['agents', t('view.agents.title')],
        ['workbench', t('view.workbench.title')],
        ['requests', t('view.requests.title')],
        ['nodes', t('view.nodes.title')],
      ],
      prefs.landing,
      (v) => savePrefs({ landing: v }),
      t('settings.landing'),
    ),
  );
  const liveText = live.connected
    ? t('settings.refreshLive')
    : live.supported === false
      ? t('settings.refreshUnsupported')
      : t('settings.refreshInterval');
  settingRow(
    card,
    t('settings.refresh'),
    t('settings.refreshDesc', { state: liveText }),
    selectControl(
      [
        [3, t('settings.every3')],
        [10, t('settings.every10')],
        [30, t('settings.every30')],
        [0, t('settings.manualOnly')],
      ],
      prefs.refresh,
      (v) => savePrefs({ refresh: Number(v) }),
      t('settings.refresh'),
    ),
  );
  settingRow(
    card,
    t('settings.timeFormat'),
    t('settings.timeFormatDesc'),
    segmented(
      [
        ['relative', t('settings.timeRelative')],
        ['absolute', t('settings.timeAbsolute')],
      ],
      prefs.timeFormat,
      (v) => savePrefs({ timeFormat: v }),
      t('settings.timeFormat'),
    ),
  );
  settingRow(
    card,
    t('settings.window'),
    t('settings.windowDesc'),
    segmented(
      [
        ['24h', t('window.24h')],
        ['7d', t('window.7d')],
      ],
      activityWindow(),
      (v) => {
        savePrefs({ activityWindow: v });
        queueLoad();
      },
      t('settings.window'),
    ),
  );
  settingRow(
    card,
    t('settings.strategy'),
    t('settings.strategyDesc'),
    segmented(
      [
        ['auto', t('strategy.auto')],
        ['speed', t('strategy.speed')],
        ['quality', t('strategy.quality')],
        ['cost', t('strategy.cost')],
      ],
      prefs.strategy,
      (v) => savePrefs({ strategy: v }),
      t('settings.strategy'),
    ),
  );
  settingRow(
    card,
    t('settings.checklist'),
    t('settings.checklistDesc'),
    segmented(
      [
        ['show', t('settings.show')],
        ['hidden', t('settings.hide')],
      ],
      prefs.checklist,
      (v) => savePrefs({ checklist: v }),
      t('settings.checklist'),
    ),
  );

  card = add('connection', t('settings.connection'), t('settings.connectionDesc'));
  if (state.data) {
    const p = state.data.principal;
    const dl = el('dl', undefined, 'info-list');
    const item = (k, v) => {
      const dd = el('dd');
      if (v instanceof Node) dd.append(v);
      else dd.textContent = v;
      dl.append(el('dt', k), dd);
    };
    item(t('settings.keyName'), p.name);
    // Written like the API key list: text separated by thin dots, admin permission on its own as
    // "Admin".
    item(
      t('settings.scopes'),
      p.scopes
        .map((s) => (s === 'admin' ? t('scope.adminShort') : (SCOPE_NAMES[s] ?? s)))
        .join(' · '),
    );
    const agents = el('div');
    (p.agents ?? []).forEach((a) =>
      agents.append(el('span', a === '*' ? t('common.allAgents') : a, 'tag')),
    );
    item(t('settings.agents'), agents);
    item(t('common.baseUrl'), baseUrlValue(sdkBaseUrl()));
    card.append(dl);
    const actions = el('div', undefined, 'setting-actions');
    actions.append(
      button(t('settings.switchKey'), 'key-round', () => openDialog('connection-dialog')),
      button(t('html.connect.disconnect'), 'log-out', async () => {
        if (
          await confirmAction({
            title: t('settings.disconnectTitle'),
            message: t('settings.disconnectMessage'),
            accept: t('html.connect.disconnect'),
            danger: true,
          })
        )
          disconnect();
      }),
    );
    if (isAdmin())
      actions.append(
        button(t('settings.manageKeys'), 'arrow-up-right', () => (location.hash = 'keys')),
      );
    card.append(actions);
  } else
    settingRow(
      card,
      t('shell.notConnected'),
      t('settings.notConnectedDesc'),
      button(
        t('common.connectWorkspace'),
        'plug',
        () => openDialog('connection-dialog'),
        'primary',
      ),
    );

  if (nativeBridge) {
    card = add('desktop', t('settings.desktop'), t('settings.desktopDesc'));
    const act = (label, symbol, name, options = {}) =>
      button(label, symbol, async () => {
        if (options.confirm && !(await confirmAction(options.confirm))) return;
        nativePost({ type: 'action', name });
        if (options.toast) toast(options.toast);
      });
    settingRow(
      card,
      t('settings.dockBadge'),
      t('settings.dockBadgeDesc'),
      segmented(
        [
          ['on', t('settings.show')],
          ['off', t('settings.hide')],
        ],
        prefs.dockBadge === 'off' ? 'off' : 'on',
        (v) => savePrefs({ dockBadge: v }),
        t('settings.dockBadge'),
      ),
    );
    const notifyControls = el('div', undefined, 'setting-inline');
    notifyControls.append(
      segmented(
        [
          ['on', t('settings.on')],
          ['off', t('settings.off')],
        ],
        prefs.notify === 'on' ? 'on' : 'off',
        (v) => {
          savePrefs({ notify: v });
          if (v === 'on') nativePost({ type: 'notifications', enabled: true });
        },
        t('settings.notify'),
      ),
    );
    if (prefs.notify === 'on')
      notifyControls.append(
        button(t('settings.notifyTest'), 'bell', () =>
          nativePost({
            type: 'notify',
            id: 'test',
            test: true,
            title: 'Open Agent API',
            body: t('settings.notifyTestBody'),
          }),
        ),
      );
    const notifyHint = {
      granted: t('settings.notifyGranted'),
      denied: t('settings.notifyDenied'),
      unavailable: t('settings.notifyUnavailable'),
    }[state.notificationStatus];
    settingRow(
      card,
      t('settings.notify'),
      `${t('settings.notifyDesc')}${notifyHint ? ` ${notifyHint}` : ''}`,
      notifyControls,
    );
    settingRow(
      card,
      t('settings.dataFolder'),
      t('settings.dataFolderDesc'),
      act(t('settings.dataFolderOpen'), 'folder-open', 'openDataFolder'),
    );
    settingRow(
      card,
      t('settings.browser'),
      t('settings.browserDesc'),
      act(t('settings.open'), 'globe', 'openInBrowser'),
    );
    settingRow(
      card,
      t('settings.adminKey'),
      t('settings.adminKeyDesc'),
      act(t('settings.adminKeyCopy'), 'key-round', 'copyAdminToken', {
        toast: t('settings.adminKeyCopied'),
      }),
    );
    settingRow(
      card,
      t('settings.restart'),
      t('settings.restartDesc'),
      act(t('settings.restartAction'), 'rotate-cw', 'restartKernel', {
        confirm: {
          title: t('settings.restartTitle'),
          message: t('settings.restartMessage'),
          accept: t('settings.restartAction'),
          danger: true,
        },
      }),
    );
  }

  card = add('shortcuts', t('settings.shortcuts'));
  for (const [keys, text] of [
    [[MOD, 'K'], t('settings.keyCommand')],
    [[MOD, ','], t('settings.keySettings')],
    [[MOD, '\\'], t('settings.keySidebar')],
    [['/'], t('settings.keySearch')],
    [[MOD, '↵'], t('settings.keyRun')],
    [['esc'], t('settings.keyClose')],
  ]) {
    const combo = el('span', undefined, 'keys');
    keys.forEach((k) => combo.append(el('kbd', k)));
    settingRow(card, text, null, combo).classList.add('compact');
  }

  card = add('about', t('settings.about'));
  const about = el('div', undefined, 'about');
  const words = el('div');
  const name = el('strong', 'Open Agent API');
  name.translate = false;
  words.append(
    name,
    el(
      'p',
      `${state.health?.version ? t('settings.version', { version: state.health.version }) : ''}${t('settings.notices')}`,
    ),
  );
  about.append(brandMark(), words);
  card.append(about);
  settingRow(
    card,
    t('settings.reset'),
    t('settings.resetDesc'),
    button(t('settings.resetAction'), 'rotate-ccw', async () => {
      if (
        await confirmAction({
          title: t('settings.resetTitle'),
          message: t('settings.resetMessage'),
          accept: t('settings.resetAction'),
        })
      )
        savePrefs({ ...DEFAULT_PREFS });
    }),
  );

  const symbols = {
    appearance: 'palette',
    behavior: 'sliders-horizontal',
    connection: 'plug',
    desktop: 'monitor',
    shortcuts: 'keyboard',
    about: 'info',
  };
  const selectSection = (id) => {
    activeSection = id;
    for (const section of main.children) section.hidden = section.id !== `settings-${id}`;
    for (const entry of nav.children) {
      const selected = entry.dataset.section === id;
      entry.classList.toggle('active', selected);
      if (selected) entry.setAttribute('aria-current', 'page');
      else entry.removeAttribute('aria-current');
    }
  };
  for (const [id, label] of sections) {
    const entry = button(
      label,
      symbols[id],
      () => {
        selectSection(id);
        frame.closest('.main').scrollTop = 0;
      },
      'settings-nav-item',
    );
    entry.dataset.section = id;
    entry.setAttribute('aria-controls', `settings-${id}`);
    nav.append(entry);
  }
  if (!sections.some(([id]) => id === activeSection)) activeSection = 'appearance';
  selectSection(activeSection);
  frame.append(main);
  body.append(frame);
  if (focusedSection)
    [...nav.children]
      .find((entry) => entry.dataset.section === focusedSection)
      ?.focus({ preventScroll: true });
}
