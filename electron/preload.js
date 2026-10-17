// The page's stores for C: and the registry. Reads are synchronous at boot; every write is sent to the main
// process as it happens, in order, and applied to the database there.
const { contextBridge, ipcRenderer } = require('electron')

const send = (op, ...args) => ipcRenderer.send('store', op, ...args)

contextBridge.exposeInMainWorld('W95HOST', {
  disk: {
    load: () => ipcRenderer.sendSync('disk-load'),
    node: rec => send('node', rec),
    remove: sid => send('remove', sid),
    data: (sid, offset, bytes) => send('data', sid, offset, bytes),
    size: (sid, size) => send('size', sid, size),
    label: (label, serial) => send('label', label, serial),
  },
  registry: {
    load: () => ipcRenderer.sendSync('registry-load'),
    op: op => send('reg', op),
  },
  // the Mac's folders the LAN's file server shares, and their file operations (each { ok } or { err })
  shares: {
    list: () => ipcRenderer.sendSync('shares-list'),
    op: (name, op, ...args) => ipcRenderer.sendSync('share-op', name, op, ...args),
  },
  computerName: ipcRenderer.sendSync('host-name'),
})
