import { hooks, state } from '../lib/state.js';
import { api } from '../lib/api.js';
import { el } from '../lib/dom.js';
import { points, signedPoints } from '../lib/format.js';
import { formatDate } from '../shared/format.js';
import { lang, t } from '../lib/i18n.js';

/* ── Developer platform: small helpers for loading and display ──
   See docs/platform.md ("Endpoint overview") for the contract. Amounts are always in credits (up to
   6 decimal places). The data lives only in this module, so other console pages are unaffected;
   views use platform.rev to decide whether to redraw. */
export const PAGE = 50;
export const STALE_MS = 20_000;
export const USAGE_DAYS = 30;
export const platform = {
  token: '',
  rev: 0,
  seq: 0,
  loading: false,
  at: 0,
  failure: '',
  summary: null,
  listings: null,
  accounts: null,
  cursor: null,
  pages: 1,
  query: '',
  pendingQuery: null,
  queryTimer: null,
  codes: null,
  usage: null,
  usageMode: 'runs', // What the usage chart shows: runs (task count) or spent; not reset when the connection changes
};

// Section tabs: the current tab is kept in the address (#platform/accounts) and survives a refresh;
// a missing or wrong one falls back to the first.
export const TABS = [
  ['overview', t('dlg.plat.tab.overview')],
  ['listings', t('dlg.plat.tab.listings')],
  ['accounts', t('dlg.plat.tab.accounts')],
  ['codes', t('dlg.plat.tab.codes')],
];
export const tabId = (value) => (TABS.some(([id]) => id === value) ? value : TABS[0][0]);
platform.tab = tabId(location.hash.slice(1).split('/')[1]);
// Switching tabs: the search text does not carry over, so it is cleared too; the address is replaced, not added to history.
export function setPlatformTab(next) {
  const tab = tabId(next);
  if (tab === platform.tab) return;
  platform.tab = tab;
  const search = document.getElementById('filter');
  if (search) search.value = '';
  history.replaceState(null, '', `#platform/${tab}`);
  platform.rev++;
  hooks.renderView(true);
}

export const REGISTRATION = {
  closed: [t('dlg.plat.reg.closed'), t('dlg.plat.reg.closed_hint')],
  invite: [t('dlg.plat.reg.invite'), t('dlg.plat.reg.invite_hint')],
  open: [t('dlg.plat.reg.open'), t('dlg.plat.reg.open_hint')],
};
export const registrationText = (mode) => REGISTRATION[mode]?.[0] ?? String(mode ?? '—');

export const pts = points;
export const signedPts = signedPoints;
// "12 credits" / "1 credit": the number comes from the shared formatter, the unit from the dictionary.
export const creditsText = (n) =>
  t(Number(n) === 1 ? 'dlg.plat.credits_one' : 'dlg.plat.credits', { n: pts(n) });
export const signedCreditsText = (n) =>
  t(Math.abs(Number(n)) === 1 ? 'dlg.plat.credits_one' : 'dlg.plat.credits', { n: signedPts(n) });
export const day = (ms) => (ms ? formatDate(ms, lang) : '');
export const badge = (label, tone) => el('span', label, `status ${tone} pill`);
export const encode = encodeURIComponent;

// Credit input: an empty string returns null; a non-number, a negative or more than 6 decimal places throws an error with an explanation.
export function parsePoints(text, label, { signed = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw Error(t('dlg.plat.err.nan', { label }));
  if (!signed && n < 0) throw Error(t('dlg.plat.err.negative', { label }));
  if (Math.abs(n * 1e6 - Math.round(n * 1e6)) > 1e-4)
    throw Error(t('dlg.plat.err.decimals', { label }));
  return n;
}

export function resetPlatform() {
  clearTimeout(platform.queryTimer);
  Object.assign(platform, {
    token: state.token,
    seq: platform.seq + 1,
    loading: false,
    at: 0,
    failure: '',
    summary: null,
    listings: null,
    accounts: null,
    cursor: null,
    pages: 1,
    query: '',
    pendingQuery: null,
    queryTimer: null,
    codes: null,
    usage: null,
  });
}
const accountsPath = (query, cursor) =>
  `/v1/platform/accounts?limit=${PAGE}${query ? `&query=${encode(query)}` : ''}${
    cursor ? `&cursor=${encode(cursor)}` : ''
  }`;
// Read everything at once: overview, listings, developers (first page), redeem codes and the last 30
// days of usage. One failing part does not affect the others; existing data keeps showing.
// With accounts set to false the developer list is skipped (a reader who has paged ahead should not be sent back to page one).
export async function refreshPlatform({ accounts = true } = {}) {
  if (platform.token !== state.token) resetPlatform();
  const token = state.token;
  const seq = ++platform.seq;
  const query = platform.query;
  const wantAccounts = accounts || platform.accounts === null;
  platform.loading = true;
  const [summary, listings, people, codes, usage] = await Promise.allSettled([
    api('GET', '/v1/platform/summary'),
    api('GET', '/v1/platform/listings'),
    wantAccounts ? api('GET', accountsPath(query)) : Promise.resolve(null),
    api('GET', '/v1/platform/codes'),
    api('GET', `/v1/platform/usage?days=${USAGE_DAYS}`),
  ]);
  if (seq !== platform.seq || token !== state.token) return;
  let failure = '';
  const take = (result, apply) => {
    if (result.status === 'fulfilled') apply(result.value);
    else failure ||= result.reason?.message ?? t('dlg.plat.err.load');
  };
  take(summary, (v) => (platform.summary = v));
  take(listings, (v) => (platform.listings = v.data ?? []));
  take(people, (v) => {
    if (!v) return;
    platform.accounts = v.data ?? [];
    platform.cursor = v.next_cursor ?? null;
    platform.pages = 1;
  });
  take(codes, (v) => (platform.codes = v.data ?? []));
  take(usage, (v) => (platform.usage = v));
  platform.failure = failure;
  platform.loading = false;
  platform.at = Date.now();
  platform.rev++;
  hooks.renderView();
}
export async function loadMoreAccounts() {
  const token = state.token;
  const seq = platform.seq;
  const page = await api('GET', accountsPath(platform.query, platform.cursor));
  if (seq !== platform.seq || token !== state.token) return;
  platform.accounts = [...(platform.accounts ?? []), ...(page.data ?? [])];
  platform.cursor = page.next_cursor ?? null;
  platform.pages++;
  platform.rev++;
  hooks.renderView();
}
// The search box changed: wait a moment, then search the gateway by email (there can be many developers, so filtering only the pages already loaded is not enough).
export function setAccountQuery(query) {
  platform.pendingQuery = query;
  clearTimeout(platform.queryTimer);
  platform.queryTimer = setTimeout(() => {
    platform.query = query;
    platform.pendingQuery = null;
    void refreshPlatform();
  }, 300);
}
// Called on every view redraw: a changed connection clears the data; stale data or a changed search reloads in the background.
export function ensurePlatformFresh(query) {
  if (platform.token !== state.token) resetPlatform();
  if (query !== (platform.pendingQuery ?? platform.query)) setAccountQuery(query);
  else if (!platform.loading && Date.now() - platform.at > STALE_MS)
    void refreshPlatform({ accounts: platform.pages <= 1 });
}
