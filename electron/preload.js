// The page's view of the app's state file: C: and the registry, saved between runs.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('W95HOST', {
  load: () => ipcRenderer.sendSync('state-load'),
  save: bytes => { ipcRenderer.invoke('state-save', bytes) },
  saveSync: bytes => ipcRenderer.sendSync('state-save-sync', bytes),
  discard: () => ipcRenderer.sendSync('state-discard'),
})
