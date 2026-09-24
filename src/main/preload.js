'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// renderer には nodeIntegration を与えず、必要な口だけをここで公開する。
contextBridge.exposeInMainWorld('ppt', {
  getState:      ()       => ipcRenderer.invoke('get-state'),
  start:         ()       => ipcRenderer.invoke('server:start'),
  stop:          ()       => ipcRenderer.invoke('server:stop'),
  setSettings:   (patch)  => ipcRenderer.invoke('settings:set', patch),
  pickDir:       ()       => ipcRenderer.invoke('settings:pick-dir'),
  openDir:       ()       => ipcRenderer.invoke('shell:open-dir'),
  showItem:      (p)      => ipcRenderer.invoke('shell:show-item', p),
  openItem:      (p)      => ipcRenderer.invoke('shell:open-item', p),
  refreshAddrs:  ()       => ipcRenderer.invoke('refresh-addresses'),

  onState: (cb) => {
    const h = (_e, state) => cb(state);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
  onTransfer: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on('transfer', h);
    return () => ipcRenderer.removeListener('transfer', h);
  }
});
