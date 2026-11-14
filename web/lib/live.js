import { hasFeature, hooks, nativeBridge, nativePost, prefs, state } from './state.js';
import { $, error } from './dom.js';
import { t } from './i18n.js';
import {
  LOCAL_ERROR_TEXT,
  api,
  apiError,
  authHeaders,
  errorCatalog,
  fetchErrorCatalog,
} from './api.js';

// Dock and menu-bar badge: how many requests are waiting for this person's approval.
export let lastBadge = null;
export function syncBadge() {
  if (!nativeBridge) return;
  const d = state.data;
  const pending = !d
    ? 0
    : Number.isFinite(d.metrics?.requires_action)
      ? d.metrics.requires_action
      : (d.runs ?? []).filter((r) => r.status === 'requires_action').length;
  const count = prefs.dockBadge === 'off' ? 0 : pending;
  if (count === lastBadge) return;
  lastBadge = count;
  nativePost({ type: 'badge', count });
}
// System notifications for approvals that appear after the console connected. The shell
// stays quiet while its window is in front. Bodies carry the agent ID only: notifications
// can show on the lock screen, so task text stays inside the console.
export const seenApprovals = new Set();
export let approvalsPrimed = false;
export function notifyApprovals(runs) {
  const waiting = runs.filter((r) => r.status === 'requires_action');
  const fresh = waiting.filter((r) => !seenApprovals.has(r.id));
  fresh.forEach((r) => seenApprovals.add(r.id));
  if (!approvalsPrimed) {
    approvalsPrimed = true;
    return;
  }
  if (!nativeBridge || prefs.notify !== 'on' || !fresh.length) return;
  nativePost({
    type: 'notify',
    id: fresh[0].id,
    title: fresh.length > 1 ? t('notify.titleMany', { n: fresh.length }) : t('notify.titleOne'),
    body:
      fresh.length > 1
        ? t('notify.bodyMany', {
            agents: fresh
              .slice(0, 3)
              .map((r) => r.agent)
              .join(t('common.listSeparator')),
          })
        : t('notify.bodyOne', { agent: fresh[0].agent }),
  });
}
export const INTERACTIVE =
  'button, a, input, select, textarea, summary, label, [role="button"], kbd';
// Blank parts of the sidebar head and top bar move the window, like a native title bar.
document.addEventListener('mousedown', (e) => {
  if (!nativeBridge || e.button !== 0) return;
  if (!e.target.closest('[data-drag-region]') || e.target.closest(INTERACTIVE)) return;
  nativePost({ type: 'drag' });
});
document.addEventListener('dblclick', (e) => {
  if (!nativeBridge || !e.target.closest('[data-drag-region]') || e.target.closest(INTERACTIVE))
    return;
  nativePost({ type: 'zoom' });
});

/* ── Live updates: event stream when the gateway offers one, polling otherwise ── */
export const live = { controller: null, supported: null, connected: false, retry: 0, timer: null };
export let pollTimer = null;
export let loadTimer = null;
// Why the next load happens. `changed` events name what moved (runs, catalog, nodes); any
// other trigger (polling, navigation, a manual refresh) re-reads everything.
export let pendingReasons = null;
export function noteReasons(reasons) {
  if (pendingReasons === 'all') return;
  if (!Array.isArray(reasons) || !reasons.length) pendingReasons = 'all';
  else {
    pendingReasons ??= new Set();
    reasons.forEach((r) => pendingReasons.add(String(r)));
  }
}
export function takeReasons() {
  const scope = pendingReasons ?? 'all';
  pendingReasons = null;
  return scope;
}
export function queueLoad(reasons) {
  noteReasons(reasons);
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => void load().catch((e) => error(e.message)), 200);
}
export function schedulePolling() {
  clearInterval(pollTimer);
  // With a live stream, polling is only a slow safety net.
  const seconds = live.connected ? 30 : Number(prefs.refresh) || 0;
  if (!seconds) return;
  pollTimer = setInterval(() => {
    if (state.token && !state.busy) {
      state.busy = true;
      load()
        .catch((e) => error(e.message))
        .finally(() => (state.busy = false));
    }
  }, seconds * 1000);
}
export function updateLiveStatus() {
  $('live-status').classList.toggle('live', live.connected);
  if (live.connected) $('update-time').textContent = t('live.sync');
}
export function stopEvents() {
  live.controller?.abort();
  live.controller = null;
  live.connected = false;
  clearTimeout(live.timer);
  updateLiveStatus();
  schedulePolling();
}
export async function startEvents() {
  if (!state.token || live.controller || live.supported === false) return;
  const token = state.token;
  const controller = new AbortController();
  live.controller = controller;
  try {
    const response = await fetch('/v1/overview/events', {
      headers: authHeaders(token, { Accept: 'text/event-stream' }),
      signal: controller.signal,
    });
    if ([404, 405, 501].includes(response.status)) {
      live.supported = false;
      live.controller = null;
      return;
    }
    if (!response.ok || !response.body)
      throw Error(t('error.streamFailed', { status: response.status }));
    live.supported = true;
    live.connected = true;
    live.retry = 0;
    updateLiveStatus();
    schedulePolling();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^event: ?changed\s*$/m.test(block)) {
          let reasons = null;
          try {
            reasons = JSON.parse(/^data: ?(.*)$/m.exec(block)?.[1] ?? 'null')?.reasons ?? null;
          } catch {
            reasons = null;
          }
          queueLoad(reasons);
        }
      }
    }
    throw Error('stream closed');
  } catch {
    if (controller.signal.aborted) return;
    live.controller = null;
    live.connected = false;
    updateLiveStatus();
    schedulePolling();
    if (state.token === token)
      live.timer = setTimeout(() => void startEvents(), Math.min(30000, 1000 * 2 ** live.retry++));
  }
}
// Conditional overview reads: an unchanged workspace answers 304 without a payload.
export async function fetchOverview(token) {
  const headers = authHeaders(token);
  if (state.etag && state.data) headers['If-None-Match'] = state.etag;
  let response;
  try {
    response = await fetch('/v1/overview', { headers });
  } catch {
    throw Error(LOCAL_ERROR_TEXT.connection_failed);
  }
  if (response.status === 304) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(response.status, data);
  state.etag = response.headers.get('ETag');
  return data;
}
// Activity pulse: time-bucketed outcomes, latency and where time went. Older gateways answer 404.
export const activity = { window: null, data: null, etag: null, supported: null };
export const activityWindow = () => (prefs.activityWindow === '7d' ? '7d' : '24h');
export const activityAvailable = () =>
  activity.supported !== false && hasFeature('overview-activity-v1') !== false;
export async function fetchActivity(token) {
  if (!activityAvailable()) return;
  const range = activityWindow();
  const headers = authHeaders(token);
  if (activity.etag && activity.data && activity.window === range)
    headers['If-None-Match'] = activity.etag;
  let response;
  try {
    response = await fetch(`/v1/overview/activity?window=${range}`, { headers });
  } catch {
    throw Error(LOCAL_ERROR_TEXT.connection_failed);
  }
  if ([404, 405, 501].includes(response.status)) {
    activity.supported = false;
    activity.data = null;
    return;
  }
  if (response.status === 304 && activity.window === range) return;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(response.status, data);
  if (token !== state.token || range !== activityWindow()) return;
  Object.assign(activity, {
    supported: true,
    window: range,
    etag: response.headers.get('ETag'),
    data,
  });
}
export const activityData = () => (activity.window === activityWindow() ? activity.data : null);
export function resetWorkspace() {
  state.data = null;
  state.etag = null;
  state.keys = null;
  state.runs = null;
  state.backends = null;
  state.registrations = null;
  state.presets = null;
  state.selectedAgent = null;
  state.selectedRun = null;
  state.health = null;
  Object.assign(activity, { window: null, data: null, etag: null, supported: null });
  Object.assign(errorCatalog, { etag: null, entries: null });
  seenApprovals.clear();
  approvalsPrimed = false;
  live.supported = null;
  // A new workspace (a key was just accepted, or the connection was dropped) starts without the
  // old workspace's error: the banner belongs to the condition that raised it.
  error('');
  stopEvents();
}

/* ── Data ────────────────────────────────────────────── */
// A read that was started with a key which has since been replaced (or dropped) answers for a
// connection that no longer exists: its failure must not put a banner over the new one.
export async function load() {
  const token = state.token;
  const first = !!token && !state.data;
  if (first) {
    state.connecting = true;
    hooks.render();
  }
  try {
    await loadWorkspace();
  } catch (failure) {
    if (token === state.token) throw failure;
  } finally {
    if (first) {
      state.connecting = false;
      // Nothing was read: go from "reading" back to "connect first". After a successful read,
      // loadWorkspace has already redrawn.
      if (!state.data) hooks.render();
    }
  }
}
async function loadWorkspace() {
  if (!state.token) {
    hooks.render();
    return;
  }
  const token = state.token;
  const view = state.view;
  const scope = takeReasons();
  const data = (await fetchOverview(token)) ?? state.data;
  if (token !== state.token || !data) return;
  const admin = data.principal.scopes.includes('admin');
  const nodeAdmin = admin && (data.principal.agents ?? []).includes('*');
  // The overview checklist needs to know whether caller keys exist.
  const wantKeys =
    admin && (view === 'keys' || (view === 'overview' && prefs.checklist !== 'hidden'));
  // A failing page-specific read is reported, but never makes a working connection look lost.
  let failure = null;
  const optional = async (wanted, read) => {
    if (!wanted) return undefined;
    try {
      return await read();
    } catch (e) {
      if ([401, 403].includes(e.status) && e.code !== 'scope_denied') throw e;
      failure ??= e.message;
      return undefined;
    }
  };
  const keys = await optional(wantKeys, async () => (await api('GET', '/v1/keys')).data);
  if (!state.health)
    state.health = await fetch('/health')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  if (!errorCatalog.entries) await fetchErrorCatalog(token);
  // Activity only moves with runs; node load and catalog changes leave it untouched.
  const activityStale = scope === 'all' || scope.has('runs') || !activityData();
  await optional(['overview', 'agents'].includes(view) && activityStale, () =>
    fetchActivity(token),
  );
  const local = await optional(view === 'nodes' && nodeAdmin, () =>
    api('GET', '/v1/local/backends'),
  );
  const registrations = await optional(
    view === 'nodes' && nodeAdmin,
    async () => (await api('GET', '/v1/nodes/registrations')).data,
  );
  const runs = await optional(
    view === 'requests',
    async () => (await api('GET', '/v1/runs?limit=100')).data,
  );
  if (token !== state.token) return;
  state.data = data;
  notifyApprovals(data.runs ?? []);
  if (keys) state.keys = keys;
  if (view === 'nodes') {
    state.registrations = registrations ?? null;
    state.backends = local?.data ?? null;
    state.presets = local?.presets ?? null;
  }
  if (runs) state.runs = runs;
  state.updatedAt = Date.now();
  error(failure ?? '');
  hooks.render();
  if (!live.controller && live.supported !== false) void startEvents();
  if ($('run-dialog').open) await hooks.runInspector.refresh();
}
