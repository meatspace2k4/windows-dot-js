const { app, BrowserWindow, Menu, ipcMain } = require('electron')
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
app.whenReady().then(() => {
  store = require('./store').open(path.join(app.getPath('userData'), 'C.db'))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]))
  open()
})
app.on('window-all-closed', () => app.quit())
