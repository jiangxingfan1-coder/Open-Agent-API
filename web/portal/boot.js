// Resolves 跟随系统 into data-theme before first paint. The page CSP forbids inline scripts, so
// this small classic script is loaded synchronously from <head>.
(() => {
  const root = document.documentElement;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    root.dataset.theme = query.matches ? 'dark' : 'light';
  };
  apply();
  query.addEventListener('change', apply);
})();
