const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const os = require('os')
const fs = require('fs')
const path = require('path')

// packaged builds carry the shell in ./web; a dev run uses the project folder
const bundled = path.join(__dirname, 'web', 'index.html')
const page = fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', 'index.html')

function open() {
  const win = new BrowserWindow({
    width: 640, height: 480, useContentSize: true, minWidth: 320, minHeight: 240,
    title: 'Windows 95', backgroundColor: '#000000', show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  })
  win.once('ready-to-show', () => { win.show(); win.focus() })
  win.loadFile(page)
}

// DevTools protocol on 127.0.0.1:9334 so Claude Code can drive the running shell
app.commandLine.appendSwitch('remote-debugging-port', '9334')
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

app.setName('Windows 95')
app.setPath('userData', path.join(app.getPath('appData'), 'local.win95'))

// ---- C: and the registry, written through to SQLite as they change
let store
ipcMain.on('disk-load', e => { e.returnValue = store.loadDisk() })
ipcMain.on('registry-load', e => { e.returnValue = store.loadRegistry() })
ipcMain.on('store', (e, op, ...args) => {
  try { store.apply(op, args) } catch (err) { console.error('store', op, err) }
})
app.on('will-quit', () => store && store.close())

// ---- the Mac's folders, as the LAN's other computer serves them (shares.js)
let shares
ipcMain.on('shares-list', e => { e.returnValue = shares.list() })
ipcMain.on('share-op', (e, name, op, ...args) => { e.returnValue = shares.op(name, op, ...args) })
ipcMain.on('host-name', e => { e.returnValue = os.hostname().split('.')[0] })
async function shareFolder() {
  const r = await dialog.showOpenDialog({ title: 'Share a Folder', buttonLabel: 'Share', properties: ['openDirectory', 'createDirectory'] })
  if (!r.canceled && r.filePaths[0]) shares.add(r.filePaths[0])
}
app.whenReady().then(() => {
  store = require('./store').open(path.join(app.getPath('userData'), 'C.db'))
  shares = require('./shares').open(path.join(app.getPath('userData'), 'shares.json'))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [{ label: 'Share a Folder…', click: shareFolder }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]))
  open()
})
app.on('window-all-closed', () => app.quit())
