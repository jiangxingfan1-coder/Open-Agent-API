import { hasFeature, isAdmin, state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import { num } from '../lib/format.js';
import { $, button, copyText, el, empty } from '../lib/dom.js';
import { filterText, setCount } from './common.js';
import { kpi } from './overview.js';
import { renderDisabled } from './platform-intro.js';
import { pendingBar, siteControls, stopSection } from './platform-setup-ui.js';
import { ensureSetup, loadSetup, setup, setupSupported } from '../dialogs/platform-setup.js';
import { renderAccounts, renderCodes, renderListings } from './platform-tables.js';
import {
  TABS,
  ensurePlatformFresh,
  platform,
  pts,
  refreshPlatform,
  registrationText,
  setPlatformTab,
} from '../dialogs/platform-data.js';
import { renderUsage } from '../dialogs/platform-usage.js';

// The refresh button in the top bar also re-reads the platform data on this page.
$('refresh').addEventListener('click', () => {
  if (state.view === 'platform' && platform.token === state.token)
    void refreshPlatform({ accounts: true });
});

function section(title, description, ...actions) {
  const head = el('div', undefined, 'section-title');
  const text = el('div');
  text.append(el('h2', title), el('p', description));
  head.append(text, ...actions);
  return head;
}

/* ── Section tabs and the scope of the search box ─────────────
   The tab strip sits in the toolbar the shell builds (the same row as the search box); the box
   searches only the current tab and says what it searches. The overview and usage tab has
   nothing to search, so the box is hidden there. */
const SEARCH = {
  listings: t('platform.searchListings'),
  accounts: t('platform.searchAccounts'),
  codes: t('platform.searchCodes'),
};
function tabCount(id) {
  if (id === 'listings') return platform.listings?.length;
  if (id === 'accounts') return platform.summary?.accounts?.total;
  if (id === 'codes') return platform.codes?.length;
  return undefined;
}
function mountTabs() {
  const bar = $('view').querySelector('.view-toolbar');
  if (!bar) return;
  let tabs = bar.querySelector('.platform-tabs');
  if (!tabs) {
    tabs = el('div', undefined, 'platform-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', t('platform.sections'));
    for (const [id, label] of TABS) {
      const tab = el('button', undefined, 'platform-tab');
      tab.type = 'button';
      tab.id = `platform-tab-${id}`;
      tab.dataset.tab = id;
      tab.setAttribute('role', 'tab');
      tab.append(el('span', label), el('small', ''));
      tab.onclick = () => setPlatformTab(id);
      tab.onkeydown = (e) => {
        const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!move) return;
        e.preventDefault();
        const at = TABS.findIndex(([x]) => x === id);
        const next = TABS[(at + move + TABS.length) % TABS.length][0];
        setPlatformTab(next);
        $(`platform-tab-${next}`)?.focus();
      };
      tabs.append(tab);
    }
    bar.prepend(tabs);
  }
  for (const tab of tabs.children) {
    const active = tab.dataset.tab === platform.tab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const n = tabCount(tab.dataset.tab);
    tab.querySelector('small').textContent = n == null ? '' : num(n);
  }
  const search = bar.querySelector('.search');
  const input = $('filter');
  const label = SEARCH[platform.tab];
  if (search) search.hidden = !label;
  if (input && label) {
    input.placeholder = label;
    input.setAttribute('aria-label', label);
  }
}

export function renderPlatform(body) {
  if (!isAdmin()) {
    setCount('');
    body.append(
      empty(t('access.needsAdmin'), t('platform.needsAdminHint'), {
        icon: 'shield-check',
      }),
    );
    return;
  }
  if (setupSupported()) ensureSetup();
  if (hasFeature('platform-v1') !== true) {
    setCount('');
    renderDisabled(body);
    return;
  }
  const tab = platform.tab;
  mountTabs();
  const filter = SEARCH[tab] ? filterText() : '';
  ensurePlatformFresh(tab === 'accounts' ? filter : '');
  if (!platform.summary && !platform.listings && !platform.accounts && !platform.codes) {
    setCount('');
    body.append(
      platform.failure
        ? empty(t('platform.readFailed'), platform.failure, {
            icon: 'store',
            action: button(t('common.retry'), 'refresh-cw', () => refreshPlatform(), 'subtle'),
          })
        : empty(t('platform.reading'), t('common.wait'), { icon: 'store', compact: true }),
    );
    return;
  }
  const total = {
    listings: platform.listings?.length,
    accounts: platform.summary?.accounts?.total,
    codes: platform.codes?.length,
  }[tab];
  const countKey = {
    listings: 'platform.countListings',
    accounts: 'platform.countAccounts',
    codes: 'platform.countCodes',
  }[tab];
  setCount(total == null || !countKey ? '' : t(countKey, { n: num(total) }));
  if (platform.failure) body.append(el('p', platform.failure, 'callout danger'));
  if (tab === 'overview') {
    renderSummary(body);
    renderUsage(body, section);
    const stop = stopSection();
    if (stop) body.append(stop);
  } else if (tab === 'listings') renderListings(body, filter);
  else if (tab === 'accounts') renderAccounts(body);
  else renderCodes(body, filter);
}

/* ── Summary ───────────────────────────────────────────── */
function renderSummary(body) {
  const s = platform.summary;
  if (!s) return;
  const base = state.data?.endpoints?.base_url ?? state.data?.public_base_url ?? location.origin;
  const portal = `${String(base).replace(/\/$/, '')}/portal/`;
  const site = siteControls();
  // Older gateways (no settings UI) can only change the registration mode in the config file;
  // newer ones handle it through the site settings and the notes below.
  const actions = el('div', undefined, 'tab-head-actions');
  actions.append(
    button(t('platform.copyPortal'), 'copy', () => copyText(portal, t('platform.portalCopied'))),
    ...site.actions,
  );
  const head = section(
    t('platform.summary'),
    t(setupSupported() ? 'platform.summaryDesc' : 'platform.summaryDescConfig', {
      name: s.site_name ?? '—',
      mode: registrationText(s.registration),
    }),
    actions,
  );
  head.classList.add('flush');
  // Agent ownership: if the API does not return it, use the owner of the current key. Shown
  // muted, on the second line of the site information.
  const owner = s.owner ?? state.data?.principal?.owner;
  if (owner) head.firstChild.append(el('p', t('platform.owner', { owner }), 'platform-owner'));
  if (site.note) head.firstChild.append(el('p', site.note, 'platform-owner'));
  if (setupSupported() && !setup.data && setup.failure) {
    const note = el('p', t('platform.siteFailed', { reason: setup.failure }), 'platform-owner');
    note.append(
      ' ',
      button(t('common.retry'), 'refresh-cw', () => void loadSetup(), 'subtle small-btn'),
    );
    head.firstChild.append(note);
  }
  const pending = pendingBar();
  const selling = (platform.listings ?? []).filter((l) => l.enabled).length;
  const band = el('section', undefined, 'card platform-band');
  band.setAttribute('aria-label', t('platform.bandLabel'));
  band.append(
    kpi({
      label: t('platform.kpiAccounts'),
      value: num(s.accounts?.total),
      note: t('platform.kpiAccountsNote', {
        active: num(s.accounts?.active),
        disabled: num(s.accounts?.disabled),
      }),
    }),
    kpi({
      label: t('platform.kpiBalance'),
      hint: t('platform.unit'),
      value: pts(s.balance_total),
      note: t('platform.kpiBalanceNote'),
    }),
    kpi({
      label: t('platform.kpiSpent'),
      hint: t('platform.unit'),
      value: pts(s.spent_total),
      note: t('access.tokens', { n: num(s.tokens_total) }),
    }),
    kpi({
      label: t('platform.kpiRuns'),
      value: num(s.runs_total),
      note: platform.listings
        ? t('platform.kpiSelling', { n: num(selling) })
        : t('platform.kpiListings', { n: num(s.listings) }),
    }),
  );
  body.append(head);
  if (pending) body.append(pending);
  body.append(band);
}
