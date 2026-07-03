'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  windowAction: (action) => ipcRenderer.invoke('window-action', action),
  onWindowState: (cb) => ipcRenderer.on('window-state', (e, data) => cb(data)),

  getInitData: () => ipcRenderer.invoke('get-init-data'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),

  startDownload: (payload) => ipcRenderer.invoke('start-download', payload),
  togglePause: (id) => ipcRenderer.invoke('toggle-pause', id),
  cancelItem: (id) => ipcRenderer.invoke('cancel-item', id),
  pauseAll: () => ipcRenderer.invoke('pause-all'),
  resumeAll: () => ipcRenderer.invoke('resume-all'),

  clearHistory: () => ipcRenderer.invoke('clear-history'),
  deleteHistoryItem: (id) => ipcRenderer.invoke('delete-history-item', id),

  checkYtdlpUpdate: () => ipcRenderer.invoke('check-ytdlp-update'),

  onQueueUpdate: (cb) => ipcRenderer.on('queue-update', (e, data) => cb(data)),
  onQueueRemove: (cb) => ipcRenderer.on('queue-remove', (e, data) => cb(data)),
  onHistoryAdd: (cb) => ipcRenderer.on('history-add', (e, data) => cb(data)),
});
