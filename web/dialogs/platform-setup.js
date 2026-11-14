import { hasFeature, hooks, nativeBridge, nativePost, state } from '../lib/state.js';
import { api } from '../lib/api.js';
import { confirmAction, el, icon, toast } from '../lib/dom.js';
import { platform, refreshPlatform, resetPlatform } from './platform-data.js';
import { field, formDialog, numberInput, textInput } from './platform-dialog.js';
import { t } from '../lib/i18n.js';

/* ── Developer platform: enable from the UI, change settings, disable ──
   Contract: GET / PUT /v1/platform/setup (feature platform-setup-v1; readable even when the platform
   is not enabled). Saving only changes the "saved switch and settings" and does not take effect
   immediately: the background service must restart. pending_restart means what is saved differs
   from what is running. When the config file has a platform block (managed_by_config) the UI is read-only. */
export const DEFAULT_SITE_NAME = 'Open Agent API';
export const NAME_MAX = 60;
const STALE_MS = 20_000;
const RESTART_WAIT_MS = 90_000;
const RESTART_POLL_MS = 1500;

export const setup = {
  token: '',
  seq: 0,
  data: null, // The last { enabled, source, managed_by_config, pending_restart, owner, settings, desired } read
  failure: '',
  denied: false, // 403: not an owner-level admin
  loading: false,
  at: 0,
  restarting: false,
  restartTimedOut: false,
};
export const setupSupported = () => hasFeature('platform-setup-v1') === true;
// "Restart the background service" only exists in the desktop app (which has the native bridge); in a browser the operator has to restart the gateway themselves.
export const inDesktopApp = () => !!nativeBridge;

const repaint = (force = false) => {
  platform.rev++;
  hooks.renderView(force);
};
function resetSetup() {
  Object.assign(setup, {
    token: state.token,
    seq: setup.seq + 1,
    data: null,
    failure: '',
    denied: false,
    loading: false,
    at: 0,
    restarting: false,
    restartTimedOut: false,
  });
}

// After a restart the features the gateway declares may have changed (platform-v1 appearing or disappearing):
// the console reads /health once per connection, so it is read again here.
// Returns whether platform-v1 changed as a result.
async function syncHealth() {
  const token = state.token;
  const health = await fetch('/health')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!health || token !== state.token) return false;
  const was = hasFeature('platform-v1');
  state.health = health;
  return hasFeature('platform-v1') !== was;
}
// Invalidate the platform's cached data and redraw; reload it if the platform is running.
async function reloadPlatform() {
  resetPlatform();
  repaint(true);
  if (hasFeature('platform-v1') === true) await refreshPlatform();
}
function apply(data) {
  setup.data = data;
  setup.failure = '';
  setup.denied = false;
  setup.at = Date.now();
  // Whether the platform is running right now is decided here; if the cached /health disagrees, read it again.
  if ((data.enabled === true) !== (hasFeature('platform-v1') === true))
    void syncHealth().then((changed) => changed && reloadPlatform());
}
function fail(error) {
  setup.at = Date.now();
  if (error.status === 403) setup.denied = true;
  else setup.failure = error.message;
}

export async function loadSetup() {
  if (setup.token !== state.token) resetSetup();
  const seq = ++setup.seq;
  const token = state.token;
  const before = JSON.stringify([setup.data, setup.failure, setup.denied]);
  setup.loading = true;
  try {
    const data = await api('GET', '/v1/platform/setup');
    if (seq === setup.seq && token === state.token) apply(data);
  } catch (error) {
    if (seq === setup.seq && token === state.token) fail(error);
  } finally {
    if (seq === setup.seq) {
      setup.loading = false;
      // If what was read matches the previous read, do not redraw (a timed reload should not rebuild the page every time).
      if (JSON.stringify([setup.data, setup.failure, setup.denied]) !== before) repaint();
    }
  }
}
// Called on every view redraw: a changed connection clears the data; if it was never read, or the data
// is stale, it is reloaded in the background. After a failed read there is no automatic retry (it
// would wipe the failure notice); the "Retry" button on the page triggers it.
export function ensureSetup() {
  if (setup.token !== state.token) resetSetup();
  if (setup.loading || restartWatch) return;
  const stale = Date.now() - setup.at > STALE_MS;
  if (!setup.at || (stale && setup.data)) void loadSetup();
}

const fix = (error) => {
  if (error.code === 'platform_managed_by_config') return Error(t('dlg.setup.err.managed'));
  if (error.code === 'scope_denied' || error.status === 403) return Error(t('dlg.setup.err.owner'));
  return error;
};
export async function saveSetup(body) {
  try {
    const data = await api('PUT', '/v1/platform/setup', body);
    apply(data);
    repaint();
    return data;
  } catch (error) {
    throw fix(error);
  }
}

/* ── Enable / site settings dialog ─────────────────────── */
export const REGISTRATION_CHOICES = [
  ['closed', t('dlg.setup.reg.closed'), t('dlg.setup.reg.closed_hint')],
  ['invite', t('dlg.setup.reg.invite'), t('dlg.setup.reg.invite_hint')],
  ['open', t('dlg.setup.reg.open'), t('dlg.setup.reg.open_hint')],
];
let sequence = 0;
function registrationChoice(value, onChange) {
  const name = `registration-${++sequence}`;
  const box = el('div', undefined, 'choice-list');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', t('dlg.setup.who_label'));
  let current = value;
  const labels = [];
  const sync = () => {
    for (const [label, input] of labels) label.classList.toggle('selected', input.checked);
  };
  for (const [id, title, hint] of REGISTRATION_CHOICES) {
    const label = el('label', undefined, 'choice-option');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = id;
    input.checked = id === current;
    input.onchange = () => {
      current = id;
      sync();
      onChange(id);
    };
    const meta = el('span', undefined, 'choice-meta');
    meta.append(el('strong', title), el('small', hint));
    label.append(input, meta);
    labels.push([label, input]);
    box.append(label);
  }
  sync();
  return { box, get: () => current };
}
// Validation failed: mark the field, move focus to it, then throw an error with an explanation (shown in the dialog's action bar).
function invalid(input, message) {
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  throw Error(message);
}

// Saved settings win (they may not be live yet); without them, use the running values from the overview.
function currentSettings() {
  const saved = setup.data?.settings;
  const running = platform.summary;
  return {
    site_name: saved?.site_name ?? running?.site_name ?? DEFAULT_SITE_NAME,
    registration: saved?.registration ?? running?.registration ?? 'closed',
    signup_credits: saved?.signup_credits ?? 0,
  };
}

// editing is true when the platform is already running or has been saved: the button says "Save"; otherwise it is the first enable and says "Save and enable".
export function openSetupDialog({ editing = false } = {}) {
  const now = currentSettings();
  const name = textInput({ value: now.site_name, max: NAME_MAX, required: true });
  name.setAttribute('aria-label', t('dlg.setup.site_name'));
  const credits = numberInput({ value: now.signup_credits, step: 1 });
  credits.setAttribute('aria-label', t('dlg.setup.signup_credits'));
  credits.inputMode = 'numeric';
  const reminder = el('p', undefined, 'callout setup-reminder');
  reminder.append(icon('info'), el('span', t('dlg.setup.open_reminder')));
  const choice = registrationChoice(now.registration, (v) => {
    reminder.hidden = v !== 'open';
  });
  reminder.hidden = now.registration !== 'open';
  for (const input of [name, credits])
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  const { ctx, open } = formDialog({
    title: editing ? t('dlg.setup.title_edit') : t('dlg.setup.title_enable'),
    desc: t('dlg.setup.desc'),
    submit: editing ? t('dlg.setup.save') : t('dlg.setup.save_enable'),
    symbol: 'check',
    busy: t('dlg.setup.saving'),
    async onSubmit() {
      const site = name.value.trim();
      if (!site) invalid(name, t('dlg.setup.err.no_name'));
      if ([...site].length > NAME_MAX) invalid(name, t('dlg.setup.err.name_long', { n: NAME_MAX }));
      const raw = credits.value.trim();
      const amount = raw === '' ? 0 : Number(raw);
      if (!Number.isSafeInteger(amount) || amount < 0) invalid(credits, t('dlg.setup.err.credits'));
      await saveSetup({
        enabled: true,
        site_name: site,
        registration: choice.get(),
        signup_credits: amount,
      });
      toast(t('dlg.setup.saved_toast'));
    },
  });
  const who = el('div', undefined, 'field');
  who.append(el('span', t('dlg.setup.who_label')), choice.box, reminder);
  ctx.body.append(
    field(t('dlg.setup.site_name'), name, t('dlg.setup.site_name_hint')),
    who,
    field(t('dlg.setup.signup_credits'), credits, t('dlg.setup.signup_credits_hint')),
  );
  open();
}

/* ── Disable, cancel enabling ──────────────────────────── */
export async function disablePlatform() {
  const ok = await confirmAction({
    title: t('dlg.setup.disable_title'),
    message: t('dlg.setup.disable_message'),
    accept: t('dlg.setup.disable_accept'),
    danger: true,
  });
  if (!ok) return;
  try {
    await saveSetup({ enabled: false });
    toast(t('dlg.setup.disable_toast'));
  } catch (error) {
    toast(error.message);
  }
}
// Changing your mind while waiting for the restart: only the switch is turned off; the settings already entered are kept.
export async function cancelEnable() {
  try {
    await saveSetup({ enabled: false });
    toast(t('dlg.setup.cancel_toast'));
  } catch (error) {
    toast(error.message);
  }
}

/* ── Restart the background service (desktop app only) ─────
   The native action is the same as "Restart gateway" under Settings > Desktop app:
   postMessage({ type:'action', name:'restartKernel' }). The connection drops during the restart:
   this reads /v1/platform/setup every 1.5 seconds, and once it reads it and no settings are pending,
   it reads /health again, clears the platform's cached data and redraws, so the page moves on by
   itself (into the data area, or back to the intro page) with no manual refresh. */
let restartWatch = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function restartBackend() {
  const ok = await confirmAction({
    title: t('dlg.setup.restart_title'),
    message: t('dlg.setup.restart_message'),
    accept: t('dlg.setup.restart_accept'),
    danger: true,
  });
  if (!ok || !inDesktopApp() || restartWatch) return;
  nativePost({ type: 'action', name: 'restartKernel' });
  setup.restarting = true;
  setup.restartTimedOut = false;
  repaint(true);
  restartWatch = watchRestart(state.token).finally(() => {
    restartWatch = null;
    setup.restarting = false;
    repaint(true);
  });
}
async function watchRestart(token) {
  const started = Date.now();
  while (token === state.token && Date.now() - started < RESTART_WAIT_MS) {
    await sleep(RESTART_POLL_MS);
    try {
      const data = await api('GET', '/v1/platform/setup');
      if (token !== state.token) return;
      if (!data.pending_restart) {
        apply(data);
        await syncHealth();
        await reloadPlatform();
        return;
      }
    } catch {
      /* The service is restarting, so failing to connect is expected: keep waiting. */
    }
  }
  setup.restartTimedOut = token === state.token;
}
