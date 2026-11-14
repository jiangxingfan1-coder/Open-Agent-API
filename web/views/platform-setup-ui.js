import { t } from '../lib/i18n.js';
import { button, el, icon } from '../lib/dom.js';
import {
  disablePlatform,
  inDesktopApp,
  openSetupDialog,
  restartBackend,
  setup,
  setupSupported,
} from '../dialogs/platform-setup.js';

/* ── Developer platform: the enable / settings / disable widgets on the page ─────────
   Shared by two pages: the explanation page when it is off (platform-intro.js) and the summary
   tab when it is on (platform.js). */

// "Restart background service" in the desktop app. Disabled during the restart, with its progress
// written out; `primary` is true only at the single primary action of a screen.
export function restartButton(primary = false) {
  const b = button(
    setup.restarting ? t('platform.restarting') : t('platform.restartBackendAction'),
    'rotate-cw',
    () => void restartBackend(),
    primary ? 'primary' : 'subtle small-btn',
  );
  if (setup.restarting) b.disabled = true;
  return b;
}
// One sentence when the service has not come back after a restart; nothing otherwise.
export function restartNote() {
  if (!setup.restartTimedOut) return null;
  return el('p', t('platform.restartTimedOut'), 'muted');
}

// Settings that are saved but not yet in effect: a neutral outlined bar (not cinnabar, since
// nobody has to act at once).
export function pendingBar() {
  const data = setup.data;
  if (!data?.pending_restart) return null;
  const bar = el('div', undefined, 'callout setup-pending');
  bar.setAttribute('role', 'status');
  const text = el('span', undefined, 'setup-pending-text');
  text.append(el('strong', data.desired ? t('platform.pending') : t('platform.pendingDisable')));
  if (inDesktopApp()) {
    text.append(document.createTextNode(' · '));
    bar.append(icon('clock'), text, restartButton());
  } else {
    text.append(el('span', t('platform.pendingRestart'), 'muted'));
    bar.append(icon('clock'), text);
  }
  return bar;
}

// The actions and notes next to the site information group, for the enabled summary tab.
// Returns { actions, note }: actions are the buttons for the title row; note is the small text
// under the title (or null).
export function siteControls() {
  const data = setup.data;
  if (!setupSupported() || !data) return { actions: [], note: null };
  const byConfig = data.managed_by_config || data.source === 'config';
  if (byConfig) return { actions: [], note: t('platform.byConfig') };
  if (data.source !== 'console') return { actions: [], note: null };
  return {
    actions: [
      button(t('platform.siteSettings'), 'settings', () => openSetupDialog({ editing: true })),
    ],
    note: null,
  };
}

// The bottom of the summary tab: a restrained "Disable" entry. Not shown when the config file
// manages it, when a disable is already saved, or when the settings could not be read.
export function stopSection() {
  const data = setup.data;
  if (!setupSupported() || !data || data.managed_by_config || data.source !== 'console')
    return null;
  if (!data.desired) return null;
  const box = el('section', undefined, 'platform-stop');
  box.setAttribute('aria-label', t('platform.disable'));
  const stop = button(
    t('platform.disable'),
    'power',
    () => void disablePlatform(),
    'subtle danger-text',
  );
  box.append(el('p', t('platform.disableNote'), 'muted'), stop);
  return box;
}
