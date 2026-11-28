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
    // once the app has taken every write sent so far: a whole disk is handed over a little at a time, each part once
    // the last is taken (braid-page.js writeDisk), so the app's other work for the page is not kept waiting behind it
    drained: () => ipcRenderer.invoke('store-drained'),
  },
  registry: {
    load: () => ipcRenderer.sendSync('registry-load'),
    op: op => send('reg', op),
  },
  // the Mac's folders the LAN's file server shares, and their file operations (each { ok } or { err })
  shares: {
    list: () => ipcRenderer.sendSync('shares-list'),
    op: (name, op, ...args) => ipcRenderer.sendSync('share-op', name, op, ...args),
    on: f => ipcRenderer.on('shares-changed', () => f()),   // a share joined the list (its folder read) or left it
  },
  // the disc in the CD drive: the CD image chosen with File > Insert CD Image, a byte range at a time (null with none),
  // its file's name, and each time another is put in or it is taken out; and the app's Insert CD Image and Eject CD,
  // which Windows' own Start menu item and Eject ask for
  cd: { read: (sector, length) => ipcRenderer.sendSync('cd-read', sector, length), image: () => ipcRenderer.sendSync('cd-image'),
    on: f => ipcRenderer.on('cd-changed', (_, name) => f(name)), insert: () => ipcRenderer.send('cd-insert'), eject: () => ipcRenderer.send('cd-eject') },
  // the audio CD in the second drive: its table of contents (null with none) and its sectors a byte range at a time
  audio: { toc: ipcRenderer.sendSync('audio-toc'), read: (start, length) => ipcRenderer.invoke('audio-read', start, length) },
  // the window is the monitor: its content takes the size of the display mode the system's machine is in
  screen: { fit: (width, height) => ipcRenderer.send('fit-window', width, height) },
  // a session file to continue on another computer: the app's own Export and Import Session (main.js), which choose the file
  session: { host: true, export: () => ipcRenderer.send('session-export'), import: () => ipcRenderer.send('session-import') },
  // DevTools (Option+Cmd+I, View > Toggle Developer Tools): whether they are open now, and each change
  devtools: { get open() { return ipcRenderer.sendSync('devtools-open') }, on: f => ipcRenderer.on('devtools', (_, open) => f(open)) },
  // the translated modules' JavaScript, each kept as the machine makes it (dynjs.js keep): a file of its own, userData/dyn
  dynjs: { write: (file, text) => ipcRenderer.send('dynjs-write', file, text) },
  computerName: ipcRenderer.sendSync('host-name'),
  userName: ipcRenderer.sendSync('user-name'),   // the Mac's account: the name Setup gives the network logon
})
