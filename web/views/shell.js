import { hasFeature, isAdmin, isNodeAdmin, prefs, state } from '../lib/state.js';
import { locale, t } from '../lib/i18n.js';
import { REQUEST_FILTERS, VIEWS, num } from '../lib/format.js';
import { $, connectPrompt, el, empty, icon, icons } from '../lib/dom.js';
import { activity, activityData, live, syncBadge } from '../lib/live.js';
import { renderSettings } from './settings.js';
import { renderRequests } from './runs.js';
import { renderNodes } from './nodes.js';
import { heroCard, renderOverview } from './overview.js';
import { renderAccess, renderKeys } from './access.js';
import { renderAgents } from './agents.js';
import { renderPlatform } from './platform.js';
import { connections, renderConnections } from './connections.js';
import { usageView, renderUsage } from './usage.js';
import { platform } from '../dialogs/platform-data.js';

/* ── Chrome ──────────────────────────────────────────── */
export function render() {
  const d = state.data;
  const meta = VIEWS[state.view];
  const agents = d?.agents || [];
  $('agent-count').textContent = d ? agents.length : '';
  $('active-count').textContent = d?.metrics.active ? d.metrics.active : '';
  $('active-count').classList.toggle('live', !!d?.metrics.active);
  $('node-count').textContent = d && isNodeAdmin() ? d.nodes.length : '';
  // Status text: clickable while disconnected (opens the connection dialog), plain status after.
  $('live-status').disabled = !!d;
  $('live-status').title = d ? '' : t('shell.connectTitle');
  $('page-title').textContent = meta.title;
  $('page-crumb').textContent = meta.title;
  $('page-group').textContent = meta.group;
  $('page-desc').textContent = meta.desc;
  document.title = `${meta.title} · Open Agent API`;
  $('update-time').textContent = !d
    ? t('shell.notConnected')
    : live.connected
      ? t('live.sync')
      : t('shell.updatedAt', {
          time: new Date(state.updatedAt || Date.now()).toLocaleTimeString(locale(), {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
        });
  $('live-status').classList.toggle('live', !!d && live.connected);
  $('footer-status').textContent = d
    ? t('shell.footerStatus', { done: num(d.metrics.completed), runs: num(d.metrics.runs) })
    : t('shell.waiting');
  document.querySelectorAll('[data-view]').forEach((a) => {
    const active = a.dataset.view === state.view;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const primary = $('primary-action');
  const publishView = ['overview', 'agents'].includes(state.view);
  // Without a connection the only primary action on the page is "Connect workspace", so this
  // button is not shown.
  primary.hidden = !d || (!publishView && state.view !== 'keys');
  // Settings are per device and readable without a workspace connection.
  $('primary-action').closest('.page-actions').hidden = state.view === 'settings';
  primary.disabled = !d || !isAdmin();
  primary.title = d && !isAdmin() ? t('shell.needsAdmin') : '';
  primary.querySelector('span').textContent =
    state.view === 'keys' ? t('common.generateKey') : t('common.publishAgent');
  const primaryIcon = state.view === 'keys' ? 'key-round' : 'plus';
  if (primary.dataset.icon !== primaryIcon) {
    primary.dataset.icon = primaryIcon;
    primary.querySelector('svg, i')?.replaceWith(icon(primaryIcon));
  }
  renderView();
  syncBadge();
  icons();
}

/* ── Views ───────────────────────────────────────────── */
export let lastViewSignature = '';
export function viewToolbar(view) {
  if (!['agents', 'requests', 'nodes', 'keys', 'platform'].includes(view)) return null;
  const bar = el('div', undefined, 'view-toolbar');
  const search = el('label', undefined, 'search');
  const input = el('input');
  input.id = 'filter';
  input.type = 'search';
  input.placeholder = {
    agents: t('shell.search.agents'),
    requests: t('shell.search.requests'),
    nodes: t('shell.search.nodes'),
    keys: t('shell.search.keys'),
    platform: t('shell.search.platform'),
  }[view];
  input.setAttribute('aria-label', input.placeholder);
  input.oninput = () => renderView(true);
  search.append(icon('search'), input);
  bar.append(search);
  if (view === 'requests') {
    const chips = el('div', undefined, 'segmented');
    chips.id = 'request-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', t('shell.filterByStatus'));
    for (const [key, label] of REQUEST_FILTERS) {
      const b = el('button');
      b.type = 'button';
      b.dataset.filter = key;
      b.append(el('span', label), el('small', ''));
      b.onclick = () => {
        state.requestFilter = key;
        renderView(true);
      };
      chips.append(b);
    }
    bar.append(chips);
  }
  const count = el('span', '', 'count');
  count.id = 'collection-count';
  bar.append(count);
  return bar;
}
export function viewSignature() {
  const d = state.data;
  const minute = Math.floor(Date.now() / 30000);
  const filter = $('filter')?.value ?? '';
  const pick = {
    overview: () => [d, activityData(), activity.supported],
    agents: () => [d?.agents, activityData()?.agents],
    requests: () => state.runs || d?.runs,
    nodes: () => [
      d?.nodes,
      state.registrations,
      state.backends,
      state.presets,
      [...state.nodeCommands],
    ],
    access: () => [d?.endpoints, d?.public_base_url, d?.agents?.map((a) => a.id)],
    connections: () => [connections.rev, isNodeAdmin(), state.token],
    usage: () => [usageView.rev, usageView.days, usageView.tab, isNodeAdmin(), state.token],
    keys: () => [state.keys, isAdmin()],
    platform: () => [platform.rev, isAdmin(), hasFeature('platform-v1')],
    settings: () => [prefs, d?.principal, state.health, live.connected, live.supported],
  }[state.view];
  return JSON.stringify([
    state.view,
    !!d,
    state.connecting,
    filter,
    state.requestFilter,
    minute,
    pick(),
  ]);
}
export function renderView(force = false) {
  const root = $('view');
  if (root.dataset.view !== state.view) {
    root.replaceChildren();
    root.dataset.view = state.view;
    const bar = viewToolbar(state.view);
    if (bar) root.append(bar);
    root.append(el('div', undefined, 'view-content'));
    lastViewSignature = '';
  }
  const bar = root.querySelector('.view-toolbar');
  // While the developer platform is off (or the key is not an admin), the page is only an
  // explanation with nothing to search, so the search box is hidden too.
  const noData = state.view === 'platform' && !(isAdmin() && hasFeature('platform-v1') === true);
  if (bar) bar.hidden = !state.data || noData;
  const signature = viewSignature();
  if (!force && signature === lastViewSignature) return;
  const content = root.querySelector('.view-content');
  // No redraw while a menu is open on the page: it would close the menu. Redraw on the next
  // refresh after it closes.
  if (!force && content.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
  if (
    !force &&
    ['connections', 'usage'].includes(state.view) &&
    content.contains(document.activeElement) &&
    document.activeElement?.matches('input, select')
  )
    return;
  lastViewSignature = signature;
  const focus = focusKey(content);
  // A redraw keeps what the reader had open and where they were: open <details> are matched
  // by their summary text (and order among equal summaries); scroll offsets are restored.
  const openDetails = detailsKeys(content, true);
  const scrollers = scrollPositions(root);
  content.replaceChildren();
  if (state.view === 'settings') renderSettings(content);
  else if (!state.data) {
    const waiting = state.connecting
      ? empty(t('shell.reading'), t('common.wait'), { icon: 'refresh-cw', page: true })
      : connectPrompt();
    content.append(state.view === 'overview' ? heroCard(false) : waiting);
    if (state.view === 'overview') content.append(waiting);
  } else
    ({
      overview: renderOverview,
      agents: renderAgents,
      requests: renderRequests,
      nodes: renderNodes,
      access: renderAccess,
      connections: renderConnections,
      usage: renderUsage,
      keys: renderKeys,
      platform: renderPlatform,
    })[state.view](content);
  const keys = detailsKeys(content, false);
  keys.forEach(([key, node]) => {
    if (openDetails.has(key)) node.open = true;
  });
  scrollers.forEach(([node, top]) => {
    node.scrollTop = top;
  });
  restoreFocus(content, focus);
  icons();
}
// A redraw must not make a keyboard user lose their place: if focus was on a button or link in
// the page, find the one with the same label again.
const FOCUSABLE = 'button, a[href], summary';
const focusLabel = (node) =>
  node.getAttribute('aria-label') || node.title || node.textContent.trim().slice(0, 60);
function focusKey(content) {
  const active = document.activeElement;
  if (!active || !content.contains(active) || !active.matches(FOCUSABLE)) return null;
  const label = focusLabel(active);
  const same = [...content.querySelectorAll(FOCUSABLE)].filter((n) => focusLabel(n) === label);
  return { label, nth: same.indexOf(active) };
}
function restoreFocus(content, key) {
  if (!key) return;
  const same = [...content.querySelectorAll(FOCUSABLE)].filter((n) => focusLabel(n) === key.label);
  same[Math.min(key.nth, same.length - 1)]?.focus({ preventScroll: true });
}
export function detailsKeys(container, openOnly) {
  const seen = new Map();
  const keys = [];
  for (const node of container.querySelectorAll('details')) {
    const label = node.querySelector('summary')?.textContent ?? '';
    const n = seen.get(label) ?? 0;
    seen.set(label, n + 1);
    keys.push([`${label}#${n}`, node]);
  }
  return openOnly ? new Set(keys.filter(([, n]) => n.open).map(([k]) => k)) : keys;
}
export function scrollPositions(node) {
  const found = [];
  for (let n = node; n; n = n.parentElement) if (n.scrollTop) found.push([n, n.scrollTop]);
  return found;
}
