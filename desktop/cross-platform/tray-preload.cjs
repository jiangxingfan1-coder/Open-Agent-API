'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oaaTray', {
  getState: () => ipcRenderer.invoke('oaa:tray:get-state'),
  refresh: () => ipcRenderer.invoke('oaa:tray:refresh'),
  decide: (payload) => ipcRenderer.invoke('oaa:tray:decide', payload),
  setLoginItem: (openAtLogin) =>
    ipcRenderer.invoke('oaa:tray:set-login-item', Boolean(openAtLogin)),
  action: (name, payload) => ipcRenderer.send('oaa:tray:action', { name, payload }),
  onState: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('oaa:tray:state', handler);
    return () => ipcRenderer.removeListener('oaa:tray:state', handler);
  },
});
