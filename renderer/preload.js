'use strict';

// Bridge for the app's own pages. main.js also rejects IPC from any non-file:// sender.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (location.protocol === 'file:') {
  // Lets the pages leave room for the window buttons (left on macOS, right elsewhere).
  const markPlatform = () => (document.documentElement.dataset.platform = process.platform);
  if (document.documentElement) markPlatform();
  else window.addEventListener('DOMContentLoaded', markPlatform, { once: true });
  contextBridge.exposeInMainWorld('companion', {
    getState: () => ipcRenderer.invoke('state:get'),
    onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
    checkNow: () => ipcRenderer.invoke('connection:check'),
    library: () => ipcRenderer.invoke('tablet:library'),
    startDownload: (request) => ipcRenderer.invoke('download:start', request),
    stopDownload: () => ipcRenderer.invoke('download:stop'),
    openNote: (doc) => ipcRenderer.invoke('note:open', doc),
    cancelOpenNote: () => ipcRenderer.invoke('note:cancel'),
    readNote: (file) => ipcRenderer.invoke('note:read', file),
    localNotes: (docs) => ipcRenderer.invoke('notes:local', docs),
    saveThumbnail: (doc, image, pages) => ipcRenderer.invoke('thumbs:save', doc, image, pages),
    fetchThumbnails: (docs) => ipcRenderer.invoke('thumbs:fetch', docs),
    chooseUpload: (folder) => ipcRenderer.invoke('upload:choose', folder),
    uploadFiles: (paths, folder) => ipcRenderer.invoke('upload:files', paths, folder),
    // Dropped files: Electron no longer exposes File.path; this is the supported way.
    pathForFile: (file) => webUtils.getPathForFile(file),
    openExternally: (file) => ipcRenderer.invoke('note:external', file),
    setSkipUnchanged: (value) => ipcRenderer.invoke('settings:skip-unchanged', value),
    setFlag: (name, value) => ipcRenderer.invoke('settings:flag', name, value),
    saveTablet: (name, address) => ipcRenderer.invoke('tablets:save', name, address),
    removeTablet: (address) => ipcRenderer.invoke('tablets:remove', address),
    useTablet: (address) => ipcRenderer.invoke('tablets:use', address),
    saveTabletLog: () => ipcRenderer.invoke('tablet:log'),
    tabletThumbnails: (docs) => ipcRenderer.invoke('thumbs:tablet', docs),
    saveText: (doc, text) => ipcRenderer.invoke('text:save', doc, text),
    searchText: (query) => ipcRenderer.invoke('text:search', query),
    combine: (docs) => ipcRenderer.invoke('combine:start', docs),
    choosePngFolder: (name) => ipcRenderer.invoke('export:png-folder', name),
    writePngPage: (token, page, total, bytes) => ipcRenderer.invoke('export:png-page', token, page, total, bytes),
    showPngExport: (token) => ipcRenderer.invoke('export:png-show', token),
    showResult: () => ipcRenderer.invoke('result:show'),
    themes: () => ipcRenderer.invoke('themes:list'),
    setAppearance: (change) => ipcRenderer.invoke('appearance:set', change),
    welcomeDone: () => ipcRenderer.invoke('welcome:done'),
    openLink: (name) => ipcRenderer.invoke('open:link', name),
    openLicenses: () => ipcRenderer.invoke('open:licenses'),
    openChromiumLicenses: () => ipcRenderer.invoke('open:chromium-licenses'),
    testAddress: (address) => ipcRenderer.invoke('address:test', address),
    saveAddress: (address) => ipcRenderer.invoke('address:save', address),
    resetAddress: () => ipcRenderer.invoke('address:reset'),
    chooseDestination: () => ipcRenderer.invoke('destination:choose'),
    openDestination: () => ipcRenderer.invoke('destination:open'),
  });
}
