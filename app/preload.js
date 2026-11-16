'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, data) => cb(data));

// theme for every BladeMail window
function applyTheme(t) { document.documentElement.classList.toggle('light', t === 'light'); }
ipcRenderer.on('ui:theme', (_e, t) => applyTheme(t));
window.addEventListener('DOMContentLoaded', async () => applyTheme(await ipcRenderer.invoke('theme:get')));

contextBridge.exposeInMainWorld('fluxget', {
  list: () => ipcRenderer.invoke('dl:list'),
  add: (req) => ipcRenderer.invoke('dl:add', req),
  pause: (id) => ipcRenderer.invoke('dl:pause', id),
  resume: (id) => ipcRenderer.invoke('dl:resume', id),
  restart: (id) => ipcRenderer.invoke('dl:restart', id),
  remove: (id, del) => ipcRenderer.invoke('dl:remove', id, del),
  updateUrl: (id, url) => ipcRenderer.invoke('dl:updateUrl', id, url),
  pauseAll: () => ipcRenderer.invoke('dl:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('dl:resumeAll'),
  clearCompleted: () => ipcRenderer.invoke('dl:clearCompleted'),
  open: (id) => ipcRenderer.invoke('dl:open', id),
  folder: (id) => ipcRenderer.invoke('dl:folder', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (p) => ipcRenderer.invoke('settings:set', p),
  pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  extInfo: () => ipcRenderer.invoke('ext:info'),
  extOpen: (id) => ipcRenderer.invoke('ext:open', id),
  extFolder: (kind) => ipcRenderer.invoke('ext:folder', kind),
  extCopy: (kind) => ipcRenderer.invoke('ext:copy', kind),
  extFirstRunDone: () => ipcRenderer.invoke('ext:firstRunDone'),
  onShowExtGuide: on('ui:showExtGuide'),
  onHighlight: on('ui:highlight'),
  addMany: (urls, opts) => ipcRenderer.invoke('dl:addMany', urls, opts),
  setQuality: (id, url) => ipcRenderer.invoke('dl:setQuality', id, url),
  schedule: (id) => ipcRenderer.invoke('dl:schedule', id),
  cancelPower: () => ipcRenderer.invoke('power:cancel'),
  ignoreClipboard: (t) => ipcRenderer.invoke('clipboard:ignore', t),
  closePopup: () => ipcRenderer.invoke('popup:close'),
  onQuality: on('ui:quality'),
  resolveDuplicate: (id, action) => ipcRenderer.invoke('dl:resolveDuplicate', id, action),
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  openPath: (p) => ipcRenderer.invoke('path:open', p),
  showPath: (p) => ipcRenderer.invoke('path:show', p),
  hashFile: (id) => ipcRenderer.invoke('hash:file', id),
  ffmpegStatus: () => ipcRenderer.invoke('tools:ffmpegStatus'),
  installFfmpeg: () => ipcRenderer.invoke('tools:installFfmpeg'),
  showMain: () => ipcRenderer.invoke('win:showMain'),
  saveMiniPos: () => ipcRenderer.invoke('mini:savePos'),
  onToolsProgress: on('tools:progress'),
  onDuplicate: on('ui:duplicate'),
  onHashProgress: on('hash:progress'),
  onPower: on('ui:power'),
  onAddPrefill: on('ui:addPrefill'),
  onUpdate: on('dl:update'),
  onAdded: on('dl:added'),
  onRemoved: on('dl:removed'),
  onList: on('dl:list'),
  onTick: on('dl:tick'),
});
