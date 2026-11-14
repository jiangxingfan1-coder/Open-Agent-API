import { lang, setLang, t } from './i18n.js';
import { $, box, button, el, icon, icons, link } from './dom.js';
import { state } from './state.js';

// The page frame: header, main navigation, account menu, footer.
// Main navigation: what a visitor needs. Everything about "my account" sits in the account menu,
// so the header holds at most four links and a menu at any width, and nothing is ever cut off.
const NAV = [
  ['home', '/', 'nav.home'],
  ['agents', '/agents', 'nav.agents'],
  ['docs', '/docs', 'nav.docs'],
];
const NAV_SIGNED_IN = [['playground', '/playground', 'nav.playground']];
const MENU = [
  ['dashboard', '/dashboard', 'nav.dashboard', 'gauge'],
  ['runs', '/runs', 'nav.runs', 'list-checks'],
  ['keys', '/keys', 'nav.keys', 'key-round'],
  ['billing', '/billing', 'nav.billing', 'receipt-text'],
];
const siteName = () => state.site?.site_name || 'Open Agent API';

// One open menu at most; a click elsewhere or Escape closes it and hands focus back.
let closeOpenMenu = null;
document.addEventListener('click', (e) => {
  if (closeOpenMenu && !e.target.closest('.account-menu')) closeOpenMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && closeOpenMenu) closeOpenMenu().focus();
});

function accountMenu(current, logout) {
  const id = 'account-menu';
  const trigger = el('button', undefined, 'quiet small account-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', id);
  trigger.title = state.account.email;
  trigger.append(
    icon('circle-user-round'),
    el('span', state.account.email, 'acct-email'),
    el('span', t('nav.account'), 'acct-name'),
    icon('chevron-down'),
  );
  const panel = box('div', 'menu', el('div', state.account.email, 'menu-head'));
  panel.id = id;
  panel.hidden = true;
  const inGroup = MENU.some(([name]) => name === current);
  if (inGroup) trigger.dataset.current = 'true';
  for (const [name, path, key, symbol] of MENU) {
    const a = link(`#${path}`, undefined, 'menu-item');
    a.append(icon(symbol), el('span', t(key)));
    if (name === current) a.setAttribute('aria-current', 'page');
    a.addEventListener('click', () => close());
    panel.append(a);
  }
  const out = button(t('nav.logout'), 'menu-item menu-out', logout, 'log-out');
  panel.append(out);

  const wrap = box('div', 'account-menu', trigger, panel);
  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (closeOpenMenu === close) closeOpenMenu = null;
    return trigger;
  }
  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close();
    closeOpenMenu?.();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    closeOpenMenu = close;
  });
  // Tabbing out of the menu closes it.
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !wrap.contains(e.relatedTarget) && !panel.hidden) close();
  });
  return wrap;
}

/** Rebuilds header and footer for the current route. `actions`: { rerender, logout }. */
export function renderChrome(current, actions) {
  closeOpenMenu?.();
  $('skip-link').textContent = t('nav.skip');
  $('brand-word').textContent = siteName();
  $('brand').setAttribute('aria-label', `${siteName()} · ${t('nav.home')}`);

  const nav = $('site-nav');
  nav.setAttribute('aria-label', t('nav.label'));
  const items = state.account ? [...NAV, ...NAV_SIGNED_IN] : NAV;
  nav.replaceChildren(
    ...items.map(([name, path, key]) => {
      const a = link(`#${path}`, t(key));
      if (name === current) a.setAttribute('aria-current', 'page');
      return a;
    }),
  );

  const switchLang = () => {
    setLang(lang === 'zh' ? 'en' : 'zh');
    actions.rerender();
  };
  const langButton = button(lang === 'zh' ? 'EN' : '中文', 'quiet small', switchLang);
  langButton.setAttribute('aria-label', t('nav.lang'));
  langButton.title = t('nav.lang');
  langButton.lang = lang === 'zh' ? 'en' : 'zh-CN';
  const parts = [langButton];
  if (state.account) parts.push(accountMenu(current, actions.logout));
  else {
    parts.push(link('#/login', t('nav.login'), 'plain'));
    if (state.site?.registration !== 'closed')
      parts.push(link('#/signup', t('nav.signup'), 'link-button small'));
  }
  $('head-tools').replaceChildren(...parts);

  // Footer: who this is, the two places a visitor may want next, the language, who runs it.
  const foot = $('foot');
  const version = state.site?.version ? ` · v${state.site.version}` : '';
  const other = button(lang === 'zh' ? 'English' : '中文', 'foot-lang', switchLang);
  other.lang = lang === 'zh' ? 'en' : 'zh-CN';
  other.setAttribute('aria-label', t('nav.lang'));
  foot.replaceChildren(
    el('span', `${siteName()}${version}`, 'foot-name'),
    box(
      'nav',
      'foot-links',
      link('#/agents', t('nav.agents')),
      link('#/docs', t('nav.docs')),
      other,
    ),
    el('span', t('foot.note'), 'foot-note'),
  );
  foot.querySelector('nav').setAttribute('aria-label', t('foot.label'));
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  icons();
}
