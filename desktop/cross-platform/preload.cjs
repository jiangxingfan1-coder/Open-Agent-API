'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const LEGACY_LOCAL_KEYS = ['oaa-token', 'oaa_token', 'oaa_admin_token'];
const LEGACY_SESSION_KEYS = ['oaa_token'];

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    oaa: {
      postMessage: (message) => ipcRenderer.send('oaa:desktop', message),
    },
  },
});

function renderFirstRunBanner(notice) {
  if (!notice || typeof notice !== 'object' || !notice.title || !notice.body) return;
  if (document.getElementById('oaa-desktop-first-run')) return;
  const host = document.createElement('aside');
  host.id = 'oaa-desktop-first-run';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  Object.assign(host.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '900',
    maxWidth: '380px',
    padding: '14px 16px',
    borderRadius: '12px',
    background: 'var(--surface-raised, rgba(28, 32, 31, 0.96))',
    color: 'var(--ink, #eef1ef)',
    border: '1px solid var(--line, rgba(127, 212, 203, 0.28))',
    boxShadow: '0 14px 36px rgba(0, 0, 0, 0.24)',
    font: '12.5px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif',
  });

  const title = document.createElement('strong');
  title.textContent = String(notice.title);
  Object.assign(title.style, {
    display: 'block',
    fontSize: '13.5px',
    marginBottom: '6px',
  });

  const body = document.createElement('div');
  body.textContent = String(notice.body);
  Object.assign(body.style, {
    whiteSpace: 'pre-wrap',
    opacity: '0.88',
    marginBottom: '12px',
    fontSize: '12px',
  });

  const actions = document.createElement('div');
  Object.assign(actions.style, {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  });

  const makeButton = (label, primary, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    Object.assign(btn.style, {
      padding: '5px 11px',
      borderRadius: '7px',
      fontSize: '12px',
      cursor: 'pointer',
      border: primary ? 'none' : '1px solid rgba(127, 140, 138, 0.35)',
      background: primary ? '#7fd4cb' : 'transparent',
      color: primary ? '#0c2220' : 'inherit',
      fontWeight: primary ? '600' : '500',
    });
    btn.addEventListener('click', onClick);
    return btn;
  };

  if (notice.actionLabel) {
    actions.append(
      makeButton(String(notice.actionLabel), false, () => {
        location.hash = 'nodes';
        host.remove();
      }),
    );
  }
  actions.append(
    makeButton(String(notice.dismissLabel || 'OK'), true, () => {
      host.remove();
    }),
  );

  host.append(title, body, actions);
  document.body?.append(host);
}

window.addEventListener(
  'DOMContentLoaded',
  () => {
    try {
      for (const key of LEGACY_LOCAL_KEYS) localStorage.removeItem(key);
      for (const key of LEGACY_SESSION_KEYS) sessionStorage.removeItem(key);
    } catch {}

    void ipcRenderer
      .invoke('oaa:bootstrap')
      .then((token) => {
        if (!token) return;
        sessionStorage.setItem('oaa-token', token);
        window.dispatchEvent(new Event('oaa-desktop-connected'));
        return ipcRenderer.invoke('oaa:first-run-notice');
      })
      .then((notice) => {
        if (notice) renderFirstRunBanner(notice);
      })
      .catch(() => {});
  },
  { once: true },
);
