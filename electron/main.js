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

app.setName('Windows 95')
app.setPath('userData', path.join(app.getPath('appData'), 'local.win95'))

// ---- saved state: one file, replaced atomically and flushed so a crash or power loss keeps the last good copy
const stateFile = () => path.join(app.getPath('userData'), 'state.w95')
function writeState(bytes) {
  const tmp = stateFile() + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try { fs.writeSync(fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, stateFile())
}
let writing = Promise.resolve()
ipcMain.on('state-load', e => {
  try { e.returnValue = new Uint8Array(fs.readFileSync(stateFile())) } catch { e.returnValue = null }
})
ipcMain.handle('state-save', (e, bytes) => { writing = writing.then(() => writeState(bytes)).catch(err => console.error('state save:', err)); return writing })
ipcMain.on('state-save-sync', (e, bytes) => {
  try { writeState(bytes); e.returnValue = true } catch (err) { console.error('state save:', err); e.returnValue = false }
})
ipcMain.on('state-discard', e => {
  try { fs.renameSync(stateFile(), stateFile() + '.unreadable-' + Date.now()) } catch {}
  e.returnValue = true
})
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]))
  open()
})
app.on('window-all-closed', () => app.quit())
