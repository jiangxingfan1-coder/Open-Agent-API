/* The console renders only authenticated runtime state; no fabricated metrics. */
import './lib/static-text.js';
import { applyPrefs, hooks, savePrefs, state } from './lib/state.js';
import { MOD } from './lib/format.js';
import { $, icons } from './lib/dom.js';
import { schedulePolling, syncBadge } from './lib/live.js';
import { runInspector, showRun } from './dialogs/runs.js';
import { openPublish } from './dialogs/publish.js';
import { showAgent } from './dialogs/agent.js';
import { render, renderView } from './views/shell.js';
import { openCommand, toggleSidebar } from './dialogs/commands.js';
import { refreshConnections } from './views/connections.js';

Object.assign(hooks, {
  icons,
  openPublish,
  render,
  renderView,
  runInspector,
  schedulePolling,
  showAgent,
  syncBadge,
  refreshConnections,
});
/* ── Keyboard ────────────────────────────────────────── */
export const isTyping = (t) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('command-dialog').open) $('command-dialog').close();
    else openCommand();
  } else if (mod && e.key === ',') {
    e.preventDefault();
    location.hash = 'settings';
  } else if (mod && e.key === '\\') {
    e.preventDefault();
    toggleSidebar();
  } else if (
    e.key === '/' &&
    !mod &&
    !isTyping(e.target) &&
    !document.querySelector('dialog[open]')
  ) {
    const filter = $('filter');
    if (filter) {
      e.preventDefault();
      filter.focus();
    }
  }
});

/* ── Start ───────────────────────────────────────────── */
if (MOD !== '⌘')
  for (const k of document.querySelectorAll('kbd'))
    k.textContent = k.textContent.replace('⌘', 'Ctrl ');
for (const id of ['collapse-sidebar', 'expand-sidebar'])
  $(id).title = $(id).title.replace('⌘\\', `${MOD} \\`);
// Native menu items (Settings… ⌘,  Command palette ⌘K  Toggle sidebar ⌘\\) call into the page.
window.oaaShell = {
  openSettings: () => (location.hash = 'settings'),
  openCommand,
  toggleSidebar,
  // A clicked notification opens the request it was about.
  openRun: (id) => {
    if (typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id) && state.token) void showRun(id);
  },
  // The shell enabled notifications natively (launch flag): reflect it in Settings › Desktop app.
  setNotify: (on) => savePrefs({ notify: on ? 'on' : 'off' }),
  // Result of the macOS permission request: granted | denied | unavailable.
  notificationStatus: (value) => {
    state.notificationStatus = ['granted', 'denied', 'unavailable'].includes(value) ? value : null;
    if (state.view === 'settings') renderView(true);
  },
};
applyPrefs();
window.onhashchange();
schedulePolling();
