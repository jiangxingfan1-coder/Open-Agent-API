import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import { button, cell, el, empty, table, toast, withBusy } from '../lib/dom.js';
import { snippetBlock } from '../dialogs/snippet.js';
import {
  REGISTRATION_CHOICES,
  cancelEnable,
  inDesktopApp,
  loadSetup,
  openSetupDialog,
  setup,
  setupSupported,
} from '../dialogs/platform-setup.js';
import { restartButton, restartNote } from './platform-setup-ui.js';

/* ── Not enabled: the explanation page ─────────────────────────
   Written for someone who does not know the project: in 30 seconds they should see what this is
   and whether they need it. Structure: purpose in one sentence, when you do not need it, a
   comparison of the two ways to hand out access, then enabling. When the gateway supports
   enabling from the UI (platform-setup-v1), "Enable" is one primary button and the config-file
   way folds into a section at the bottom. Older gateways lack that feature and keep the three
   steps with a config snippet. Once saved and waiting for a restart (pending_restart), this page
   talks only about the restart. */
const part = (title, ...nodes) => {
  const box = el('section', undefined, 'intro-part');
  box.append(el('h3', title, 'title-panel'), ...nodes);
  return box;
};
const line = (...nodes) => {
  const p = el('p', undefined, 'muted');
  p.append(...nodes);
  return p;
};
const field = (name, text) => line(el('code', name), ` ${text}`);

function lead() {
  const box = el('section', undefined, 'intro-part');
  const list = el('ul', undefined, 'intro-list');
  for (const text of [t('platform.leadPoint1'), t('platform.leadPoint2')])
    list.append(el('li', text));
  box.append(el('h2', t('platform.leadTitle'), 'title-section'), list);
  return box;
}
function notNeeded() {
  const skip = el('a', t('platform.goKeys'), 'link');
  skip.href = '#keys';
  return part(t('platform.notNeededTitle'), line(t('platform.notNeededText')), skip);
}
function compare() {
  const row = (...cells) => {
    const tr = el('tr');
    cells.forEach((text, i) => tr.append(cell(text, i === 0 ? 'strong' : undefined)));
    return tr;
  };
  return part(
    t('platform.compareTitle'),
    table(
      [
        { text: t('platform.compareWay'), width: 128 },
        { text: t('platform.compareKeys'), min: 200 },
        { text: t('platform.compareBilling'), width: 112 },
      ],
      [
        row(t('view.keys.title'), t('platform.compareKeysCreate'), t('platform.compareNoBilling')),
        row(
          t('view.platform.title'),
          t('platform.compareSelfService'),
          t('platform.compareCredits'),
        ),
      ],
    ),
    line(t('platform.compareNote')),
  );
}

/* ── Enable with the config file: three steps, a snippet and field notes ── */
function configGuide() {
  const owner = setup.data?.owner ?? state.data?.principal?.owner ?? 'owner';
  const steps = el('ol', undefined, 'steps');
  const step = (strong, text) => {
    const li = el('li');
    li.append(el('strong', strong), el('span', ` ${text}`));
    steps.append(li);
  };
  step(t('platform.stepConfig'), t('platform.stepConfigText'));
  step(t('platform.stepRestart'), t('platform.stepRestartText'));
  step(t('platform.stepList'), t('platform.stepListText'));
  const code = `"platform": {
  "owner": "${owner}",
  "siteName": "Open Agent API",
  "registration": "closed",
  "signupCredits": 0
}`;
  return [
    steps,
    snippetBlock(t('platform.configSnippet'), code, t('platform.configCopied')),
    field('owner', t('platform.fieldOwner')),
    field('registration', t('platform.fieldRegistration')),
    line(t('platform.configNote')),
  ];
}
// At the bottom of the page, folded by default; on a redraw the shell keeps it open or closed
// by its summary text.
function configDetails(open) {
  const box = el('details', undefined, 'intro-details');
  box.open = open;
  const inner = el('div', undefined, 'intro-part');
  inner.append(line(t('platform.configWins')), ...configGuide());
  box.append(el('summary', t('platform.configSummary')), inner);
  return box;
}

/* ── Enable (nothing saved yet) ────────────────────────────── */
function enableSection(managed) {
  if (managed) return part(t('platform.enableTitle'), line(t('platform.enableManaged')));
  const go = button(t('platform.enableAction'), 'store', () => openSetupDialog(), 'primary');
  return part(
    t('platform.enableTitle'),
    line(
      t('platform.enableLine', {
        restart: inDesktopApp() ? t('platform.restartBackend') : t('platform.restartGateway'),
      }),
    ),
    line(t('platform.enableNote')),
    go,
  );
}

/* ── Waiting for the restart ───────────────────────────────── */
function savedFacts(settings) {
  if (!settings) return null;
  const choice = REGISTRATION_CHOICES.find(([id]) => id === settings.registration);
  const facts = el('div', undefined, 'surface rows tight setup-facts');
  for (const [label, value] of [
    [t('platform.factName'), settings.site_name],
    [t('platform.factRegistration'), choice?.[1] ?? settings.registration],
    [t('platform.factCredits'), t('platform.credits', { n: settings.signup_credits ?? 0 })],
  ]) {
    const row = el('div');
    row.append(el('span', label), el('strong', String(value ?? '—')));
    facts.append(row);
  }
  return facts;
}
function recheck() {
  const b = button(t('platform.recheck'), 'refresh-cw', () => {
    void withBusy(b, t('platform.checking'), async () => {
      await loadSetup();
      if (setup.data?.pending_restart) toast(t('platform.notYet'));
    });
  });
  return b;
}
function waiting(data) {
  const managed = data.managed_by_config;
  const box = el('section', undefined, 'intro-part');
  const how = el('p', undefined, 'muted');
  if (inDesktopApp()) how.append(t('platform.restartDesktop'));
  else {
    const [before, after] = t('platform.restartCli').split('{cmd}');
    how.append(before, el('code', 'oaa serve'), after);
  }
  const actions = el('div', undefined, 'setup-actions');
  actions.append(inDesktopApp() ? restartButton(true) : recheck());
  if (!managed)
    actions.append(
      button(t('platform.changeSettings'), 'settings', () => openSetupDialog({ editing: true })),
      button(t('platform.cancelEnable'), 'x', () => void cancelEnable()),
    );
  box.append(
    el('h2', managed ? t('platform.waitingManaged') : t('platform.waitingSaved'), 'title-section'),
    how,
  );
  const saved = savedFacts(data.settings);
  if (saved) box.append(saved);
  const note = restartNote();
  if (note) box.append(note);
  box.append(actions);
  return box;
}

export function renderDisabled(body) {
  const page = el('div', undefined, 'platform-intro');
  if (!setupSupported()) {
    // Older gateway: only the config file can change it.
    page.append(lead(), notNeeded(), compare(), part(t('platform.howToEnable'), ...configGuide()));
    body.append(page);
    return;
  }
  if (setup.denied) {
    body.append(
      empty(t('access.needsAdmin'), t('platform.ownerKeyHint'), {
        icon: 'shield-check',
      }),
    );
    return;
  }
  const data = setup.data;
  if (!data) {
    body.append(
      setup.failure
        ? empty(t('platform.setupReadFailed'), setup.failure, {
            icon: 'store',
            action: button(t('common.retry'), 'refresh-cw', () => void loadSetup()),
          })
        : empty(t('platform.setupReading'), t('common.wait'), { icon: 'store', compact: true }),
    );
    return;
  }
  if (data.pending_restart && data.desired) page.append(waiting(data));
  else page.append(lead(), notNeeded(), compare(), enableSection(data.managed_by_config));
  page.append(configDetails(!!data.managed_by_config && !data.pending_restart));
  body.append(page);
}
