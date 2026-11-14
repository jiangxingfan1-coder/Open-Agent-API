import { portal, session } from './api.js';
import { errorMessage, t } from './i18n.js';
import { $, box, button, empty, icons, link, loading, notice } from './dom.js';
import { renderChrome } from './chrome.js';
import { go, state } from './state.js';
import { home } from './home.js';
import { catalog } from './catalog.js';
import { agentDetail } from './detail.js';
import { docs } from './docs.js';
import { login, resetPassword, safeNext, signup } from './auth.js';
import { dashboard } from './dashboard.js';
import { keys } from './keys.js';
import { billing } from './billing.js';
import { runs } from './runs.js';
import { runDetail } from './run-detail.js';
import { playground } from './playground.js';

// Hash routes. `auth` pages need a session; `guest` pages bounce a signed-in visitor.
const ROUTES = [
  { name: 'home', re: /^\/?$/, view: home },
  { name: 'agents', re: /^\/agents\/?$/, view: catalog },
  { name: 'agent', re: /^\/agent\/(.+)$/, view: agentDetail, nav: 'agents' },
  { name: 'docs', re: /^\/docs\/?$/, view: docs },
  { name: 'login', re: /^\/login\/?$/, view: login, guest: true },
  { name: 'signup', re: /^\/signup\/?$/, view: signup, guest: true },
  { name: 'reset', re: /^\/reset\/?$/, view: resetPassword, guest: true },
  { name: 'dashboard', re: /^\/dashboard\/?$/, view: dashboard, auth: true },
  { name: 'runs', re: /^\/runs\/?$/, view: runs, auth: true },
  { name: 'run', re: /^\/run\/(.+)$/, view: runDetail, auth: true, nav: 'runs' },
  { name: 'playground', re: /^\/playground\/?$/, view: playground, auth: true },
  { name: 'keys', re: /^\/keys\/?$/, view: keys, auth: true },
  { name: 'billing', re: /^\/billing\/?$/, view: billing, auth: true },
];

const parse = () => {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return { path, query: new URLSearchParams(search) };
};

function match(path) {
  for (const route of ROUTES) {
    const m = route.re.exec(path);
    if (!m) continue;
    let param = m[1];
    if (param !== undefined) {
      try {
        param = decodeURIComponent(param);
      } catch {
        // Keep the raw segment.
      }
    }
    return { route, param };
  }
  return null;
}

/* ── Chrome: header, footer, static labels (chrome.js) ─── */
let current = 'home';
const drawChrome = () => renderChrome(current, { rerender, logout });
const rerender = () => {
  drawChrome();
  renderRoute();
};

async function logout() {
  try {
    await portal.logout();
  } catch {
    // A dead session is as good as logged out.
  }
  session.clear();
  state.account = null;
  drawChrome();
  go('/');
}

// A page that could not be drawn: what went wrong, in words, and a way to try again.
const failure = (err, retry) =>
  box(
    'div',
    'wrap page',
    box(
      'div',
      'error-block',
      notice(errorMessage(err), 'error'),
      button(t('common.retry'), 'small', retry),
    ),
  );

/* ── Rendering ─────────────────────────────────────────── */
let renderToken = 0;

async function renderRoute() {
  const token = ++renderToken;
  const { path, query } = parse();
  const hit = match(path);
  const main = $('main');
  const nextHash = () => `/login?next=${encodeURIComponent(path)}`;
  if (hit?.route.auth && !session.token()) return go(nextHash());
  if (hit?.route.guest && state.account) return go(safeNext(query.get('next')));

  current = hit?.route.nav ?? hit?.route.name ?? '';
  drawChrome();
  document.title = `${t(`title.${hit?.route.name ?? 'missing'}`)} · ${state.site?.site_name ?? 'Open Agent API'}`;
  if (!hit) {
    main.replaceChildren(
      box(
        'div',
        'wrap page',
        empty(t('missing.title'), t('missing.text')),
        link('#/', t('nav.home'), 'text-link'),
      ),
    );
    return;
  }
  main.replaceChildren(box('div', 'wrap page', loading()));
  try {
    await hit.route.view(main, { path, query, param: hit.param });
  } catch (err) {
    if (token !== renderToken || err.code === 'session_invalid' || err.code === 'account_disabled')
      return;
    main.replaceChildren(failure(err, renderRoute));
  }
  if (token !== renderToken) return;
  icons();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

/* ── Boot ──────────────────────────────────────────────── */
window.addEventListener('hashchange', renderRoute);
window.addEventListener('portal:refresh', renderRoute);
window.addEventListener('portal:auth', drawChrome);
window.addEventListener('portal:session-lost', () => {
  state.account = null;
  drawChrome();
  const { path } = parse();
  const hit = match(path);
  if (hit?.route.auth) go(`/login?next=${encodeURIComponent(path)}`);
});

async function boot() {
  drawChrome();
  // The address and the session are asked for before the first page: say that something is loading.
  $('main').replaceChildren(box('div', 'wrap page', loading()));
  try {
    state.site = await portal.site();
  } catch (err) {
    $('main').replaceChildren(failure(err, boot));
    return;
  }
  if (session.token()) {
    try {
      state.account = (await portal.account()).account;
    } catch {
      // session_invalid / account_disabled already cleared the token; other errors leave it.
    }
  }
  drawChrome();
  await renderRoute();
}
boot();
