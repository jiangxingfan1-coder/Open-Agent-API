// Applies the saved site theme before first paint to avoid light/dark flashes,
// and syncs <picture> dark sources when an explicit theme override is active.
(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('js-ready');
  const KEY = 'oaa-site-theme';
  let saved = null;
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') saved = v;
  } catch {
    // Storage may be blocked in strict privacy modes; fall back to system preference.
  }
  if (saved) root.setAttribute('data-theme', saved);

  const syncPictures = (mode) => {
    const sources = document.querySelectorAll('picture source');
    for (const s of sources) {
      if (!s.dataset.darkSource) {
        const m = s.getAttribute('media') || '';
        if (m.includes('prefers-color-scheme: dark')) s.dataset.darkSource = '1';
      }
      if (s.dataset.darkSource !== '1') continue;
      if (mode === 'dark') s.setAttribute('media', 'all');
      else if (mode === 'light') s.setAttribute('media', 'not all');
      else s.setAttribute('media', '(prefers-color-scheme: dark)');
    }
  };

  window.__oaaTheme = {
    key: KEY,
    syncPictures,
    effective() {
      const explicit = root.getAttribute('data-theme');
      if (explicit === 'light' || explicit === 'dark') return explicit;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    },
    apply(next) {
      if (next === 'light' || next === 'dark') {
        root.setAttribute('data-theme', next);
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // Ignore storage quota / privacy errors.
        }
      } else {
        root.removeAttribute('data-theme');
        try {
          localStorage.removeItem(KEY);
        } catch {
          // Ignore storage quota / privacy errors.
        }
      }
      syncPictures(next);
    },
  };

  if (saved) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => syncPictures(saved), { once: true });
    } else {
      syncPictures(saved);
    }
  }
})();
