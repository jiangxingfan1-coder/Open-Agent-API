// Applies saved appearance before first paint. The page CSP forbids inline scripts,
// so this small classic script is loaded synchronously from <head>.
(() => {
  const root = document.documentElement;
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem('oaa.prefs.v1') || '{}') || {};
  } catch {
    prefs = {};
  }
  // Language: the saved choice, else the browser's (same rule as lib/i18n.js). The page text is
  // filled in by lib/static-text.js; until then the body stays hidden so nothing flashes empty.
  let lang = '';
  try {
    lang = localStorage.getItem('oaa.console.lang') || '';
  } catch {
    lang = '';
  }
  if (lang !== 'zh' && lang !== 'en')
    lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  root.lang = lang === 'zh' ? 'zh-CN' : 'en';
  root.dataset.i18nPending = '';
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const choice = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : 'system';
    root.dataset.theme = choice === 'system' ? (query.matches ? 'dark' : 'light') : choice;
  };
  apply();
  root.dataset.palette = 'black';
  root.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable';
  if (prefs.motion === 'reduce') root.dataset.motion = 'reduce';
  if (prefs.sidebar === 'collapsed') root.dataset.sidebar = 'collapsed';
  // The macOS shell registers a message handler and uses an inset title bar.
  if (window.webkit?.messageHandlers?.oaa) root.dataset.shell = 'macos';
  query.addEventListener('change', () => {
    try {
      prefs = JSON.parse(localStorage.getItem('oaa.prefs.v1') || '{}') || {};
    } catch {
      prefs = {};
    }
    apply();
  });
})();
