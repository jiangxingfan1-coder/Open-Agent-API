// Late-bound calls into higher layers (render, polling, dialogs); filled in by console.js.
export const hooks = {};
export const state = {
  token: sessionStorage.getItem('oaa-token') || '',
  view: 'overview',
  settingsReturnHash: '#overview',
  data: null,
  keys: null,
  runs: null,
  backends: null,
  registrations: null,
  presets: null,
  selectedAgent: null,
  selectedRun: null,
  bundle: null,
  publishMode: 'native',
  busy: false,
  // While the page is opened with a key and reads the workspace for the first time, it shows
  // "reading" rather than "connect first".
  connecting: false,
  routeSequence: 0,
  routeAvailable: false,
  agentDialogSequence: 0,
  // "Continue": { runId, agent } is the task the next run continues and the agent that handled it.
  continuation: null,
  keepContinuation: false,
  routingStrategy: 'auto',
  snippetDialect: 'uap',
  requestFilter: 'all',
  pendingForms: new Set(),
  nodeCommands: new Set(),
};
export const isAdmin = () => !!state.data?.principal.scopes.includes('admin');
export const isNodeAdmin = () => isAdmin() && (state.data?.principal.agents ?? []).includes('*');
// Base URL: the address given to a client or another agent, used together with an API key.
// Every place in the console (key dialog, agent sheet, settings) takes it from here, so the
// name and the source stay single.
export const sdkBaseUrl = () =>
  state.data?.endpoints?.openai_sdk_base_url ?? `${location.origin}/v1`;
// Capability negotiation: `true`/`false` when the gateway advertises features, `null` when unknown.
export const hasFeature = (name) => {
  const list = state.health?.features;
  return Array.isArray(list) ? list.includes(name) : null;
};

/* ── Preferences (per device) ────────────────────────── */
export const PREFS_KEY = 'oaa.prefs.v1';
export const DEFAULT_PREFS = {
  theme: 'system',
  palette: 'black',
  density: 'comfortable',
  motion: 'system',
  sidebar: 'expanded',
  refresh: 3,
  landing: 'overview',
  timeFormat: 'relative',
  strategy: 'auto',
  checklist: 'show',
  activityWindow: '24h',
  dockBadge: 'on',
  notify: 'off',
};
export const prefs = (() => {
  try {
    return {
      ...DEFAULT_PREFS,
      ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'),
      palette: 'black',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
})();
export const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
export const effectiveTheme = () =>
  prefs.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : prefs.theme;
export function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = effectiveTheme();
  root.dataset.palette = 'black';
  root.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
  if (prefs.motion === 'reduce') root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  if (prefs.sidebar === 'collapsed') root.dataset.sidebar = 'collapsed';
  else delete root.dataset.sidebar;
  // The macOS shell mirrors the choice in its window chrome (traffic lights, scrollers).
  nativePost({
    type: 'appearance',
    theme: prefs.theme,
    resolved: effectiveTheme(),
    palette: prefs.palette,
  });
}
export function savePrefs(patch) {
  Object.assign(prefs, patch, { palette: 'black' });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Preferences still apply for this page without storage. */
  }
  applyPrefs();
  hooks.schedulePolling();
  hooks.renderView(true);
  hooks.syncBadge();
  hooks.icons();
}
systemDark.addEventListener('change', () => {
  if (prefs.theme === 'system') applyPrefs();
});

/* ── macOS shell bridge ──────────────────────────────── */
export const nativeBridge = window.webkit?.messageHandlers?.oaa;
export function nativePost(message) {
  try {
    nativeBridge?.postMessage(message);
  } catch {
    /* Not running inside the desktop shell. */
  }
}
