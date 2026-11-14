'use strict';
// The only bridge between the island UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('islandHost', {
  send: (msg) => ipcRenderer.send('ui', msg),
  onMessage: (cb) => ipcRenderer.on('host', (_e, msg) => cb(msg)),
  // Full path of a file dropped on the island (for the shelf and the converter).
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  // Ask main for something and wait for the answer (file icons, conversions...).
  invoke: (channel, arg) => ipcRenderer.invoke(channel, arg),
  // Drag a shelf file back out of the island into Explorer, a browser, a chat app...
  startDrag: (filePath) => ipcRenderer.send('shelf-drag', filePath),
});
