const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: { oaa: { postMessage: (message) => ipcRenderer.send('oaa:desktop', message) } },
});
window.addEventListener(
  'DOMContentLoaded',
  () => {
    void ipcRenderer
      .invoke('oaa:bootstrap')
      .then((token) => {
        if (!token) return;
        sessionStorage.setItem('oaa-token', token);
        window.dispatchEvent(new Event('oaa-desktop-connected'));
      })
      .catch(() => {});
  },
  { once: true },
);
