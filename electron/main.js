const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const os = require('os')
const fs = require('fs')
const path = require('path')

// packaged builds carry the shell in ./web; a dev run uses the project folder
const bundled = path.join(__dirname, 'web', 'index.html')
const page = fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', 'index.html')

// the window's place and size, kept in the app's own folder (window.json) as it last was, and taken again at start when
// it still lies on a display
const boundsFile = () => path.join(app.getPath('userData'), 'window.json')
const savedBounds = () => {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'))
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null
    const { screen } = require('electron'), a = screen.getDisplayMatching(b).workArea
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y ? b : null
  } catch { return null }
}
function open() {
  const b = savedBounds()
  const win = new BrowserWindow({
    width: 640, height: 480, useContentSize: true, minWidth: 320, minHeight: 240, ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height, useContentSize: false } : {}),
    title: 'Windows 95', backgroundColor: '#000000', show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  })
  let keep = null
  const save = () => { clearTimeout(keep); keep = null; if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return; try { fs.mkdirSync(path.dirname(boundsFile()), { recursive: true }); fs.writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds())) } catch {} }
  for (const ev of ['move', 'resize']) win.on(ev, () => { clearTimeout(keep); keep = setTimeout(save, 500) })
  win.on('close', save)
  win.once('ready-to-show', () => { win.show(); win.focus() })
  // DevTools: Option+Cmd+I (Ctrl+Alt+I elsewhere) toggles them before the page sees the key, and the page is told
  // (W95HOST.devtools) so the machine knows (its registry's DevTools value, the Debug Monitor)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'i' && input.alt && (input.meta || input.control)) { e.preventDefault(); win.webContents.toggleDevTools() }
  })
  win.webContents.on('devtools-opened', () => win.webContents.send('devtools', true))
  win.webContents.on('devtools-closed', () => win.webContents.send('devtools', false))
  const search = 'mods=debug&debug=1'   // (the mods debug.mod names: win95.js modFile; debug=1: the machine's own commands, shell_cmd)
  // (debug=1: the page starts with DevTools open, its console reading from the first line; in a window of their own,
  // as docked they would take part of the screen's content size and move the window from where it was kept)
  if (new URLSearchParams(search).get('debug') === '1') win.webContents.once('did-start-loading', () => win.webContents.openDevTools({ mode: 'detach' }))
  win.loadFile(page, { search })
}
ipcMain.on('devtools-open', e => { e.returnValue = e.sender.isDevToolsOpened() })

// DevTools protocol on 127.0.0.1:9334 so Claude Code can drive the running shell
// the machines run in workers on shared memory (SharedArrayBuffer), which a file: page gets with this feature
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
app.commandLine.appendSwitch('remote-debugging-port', '9334')
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

app.setName('Windows 95')
app.setPath('userData', path.join(app.getPath('appData'), 'local.win95'))

// ---- C: and the registry, written through to SQLite as they change
let store, swapping = false
const dbFile = () => path.join(app.getPath('userData'), 'C.db')
// (while an imported session replaces this one, the page that is going away writes nothing into it; the page loaded
// after asks for its disk first, and writes go through again)
ipcMain.on('disk-load', e => { swapping = false; e.returnValue = store.loadDisk() })
ipcMain.on('registry-load', e => { e.returnValue = store.loadRegistry() })
ipcMain.handle('store-drained', () => true)   // (answered in its turn: after every write sent before it)
// a translated module's JavaScript as the machine keeps it (dynjs.js keep): a file of its own in userData/dyn, its name
// the module's and its translation's (NAME-KEY.js), written once
ipcMain.on('dynjs-write', (e, file, text) => {
  const name = path.basename(String(file)).replace(/[^\w.-]+/g, '_'); if (!/\.js$/.test(name)) return
  const dir = path.join(app.getPath('userData'), 'dyn'), f = path.join(dir, name)
  fs.promises.mkdir(dir, { recursive: true }).then(() => fs.promises.writeFile(f, String(text))).catch(err => console.warn('dynjs-write', name, err.message))
})
ipcMain.on('store', (e, op, ...args) => {
  if (swapping) return
  try { store.apply(op, args) } catch (err) { console.error('store', op, err) }
})
// ---- a session to continue on another computer: C: and the registry (the Claude program's sessions in it), as one file
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
async function exportSession() {
  const r = await dialog.showSaveDialog({ title: 'Export Session', buttonLabel: 'Export', defaultPath: path.join(app.getPath('documents'), `Windows 95 ${stamp()}.w95session`),
    filters: [{ name: 'Windows 95 sessions', extensions: ['w95session'] }] })
  if (r.canceled || !r.filePath) return
  try {
    fs.rmSync(r.filePath, { force: true })   // (VACUUM INTO writes a new file only; the save dialog asked about replacing it)
    store.exportTo(r.filePath)
    dialog.showMessageBox({ type: 'info', message: 'Session exported', detail: `${r.filePath}\n\nOpen it on the other computer with File > Import Session.` })
  } catch (err) { dialog.showErrorBox('Export Session', `The session was not exported: ${err.message}`) }
}
ipcMain.on('session-export', () => exportSession())   // (Start > Programs > Accessories > System Tools, inside Windows 95)
ipcMain.on('session-import', () => importSession())
async function importSession() {
  const r = await dialog.showOpenDialog({ title: 'Import Session', buttonLabel: 'Import', properties: ['openFile'], filters: [{ name: 'Windows 95 sessions', extensions: ['w95session', 'db'] }] })
  if (r.canceled || !r.filePaths[0]) return
  const file = r.filePaths[0], why = require('./store').check(file)
  if (why) { dialog.showErrorBox('Import Session', `${path.basename(file)} cannot be imported: ${why}.`); return }
  const backup = path.join(app.getPath('userData'), `C ${stamp()} before import.db`)
  const ok = await dialog.showMessageBox({ type: 'warning', buttons: ['Import', 'Cancel'], defaultId: 0, cancelId: 1, message: 'Replace this computer\'s Windows 95 with the imported session?',
    detail: `C:, the registry and the Claude program's sessions are replaced by those in ${path.basename(file)}, and Windows 95 starts again from them. What is here now is kept in\n${backup}` })
  if (ok.response !== 0) return
  swapping = true
  try {
    store.exportTo(backup)                                   // (the state now, kept before it is replaced)
    store.close()
    for (const f of [dbFile(), dbFile() + '-wal', dbFile() + '-shm']) fs.rmSync(f, { force: true })
    fs.copyFileSync(file, dbFile())
  } catch (err) {
    try { if (fs.existsSync(backup) && !fs.existsSync(dbFile())) fs.copyFileSync(backup, dbFile()) } catch (_) {}   // (the state before, back in place)
    dialog.showErrorBox('Import Session', `The session was not imported: ${err.message}. The state before is in ${backup}.`)
  } finally {
    store = require('./store').open(dbFile())
    for (const w of BrowserWindow.getAllWindows()) w.webContents.reloadIgnoringCache()
  }
}
app.on('will-quit', () => store && store.close())
// (the page may still be handing a disk to the store, a file at a time between its other work: a moment's, after an
// arrival (braid-page.js writeDisk). The app quits once it has, a minute at most; quit before, the store held part of
// one disk over another)
let settling = false
app.on('before-quit', e => {
  const w = BrowserWindow.getAllWindows()[0]
  if (settling || !w) return
  e.preventDefault(); settling = true
  const settled = w.webContents.executeJavaScript('window.win95 && win95.braid && win95.braid.settled ? win95.braid.settled() : true').catch(() => {})
  Promise.race([settled, new Promise(ok => setTimeout(ok, 60000))]).then(() => app.quit())
})

// ---- the Mac's folders, as the LAN's other computer serves them (shares.js)
let shares
ipcMain.on('shares-list', e => { e.returnValue = shares.list() })
ipcMain.on('share-op', (e, name, op, ...args) => { e.returnValue = shares.op(name, op, ...args) })
ipcMain.on('host-name', e => { e.returnValue = os.hostname().split('.')[0] })
// the window is the monitor: its content is the size of the display mode the system's machine is in (the page asks
// as the mode is set, and after a resize once the machine holds the largest mode the window held), unless the
// window is full screen or maximized, where the screen is centered in it; likewise while DevTools are open (docked, they
// take part of the content size, so fitting to the mode would shrink the window around them again and again)
ipcMain.on('fit-window', (e, width, height) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || win.isFullScreen() || win.isMaximized() || e.sender.isDevToolsOpened() || !(width > 0 && height > 0)) return
  const [w, h] = win.getContentSize()
  if (w !== width || h !== height) win.setContentSize(Math.round(width), Math.round(height), true)
})
ipcMain.on('user-name', e => { try { e.returnValue = os.userInfo().username } catch (_) { e.returnValue = '' } })
// ---- the CD drive's disc: an ISO 9660 image the person chose, remembered in cdrom.json; the page checks its label
let cdImage = null, cdFd = null
const cdFile = () => path.join(app.getPath('userData'), 'cdrom.json')
function cdOpen(file) {
  if (cdFd !== null) { try { fs.closeSync(cdFd) } catch (_) {} cdFd = null }
  cdImage = file || null
  if (cdImage) try { cdFd = fs.openSync(cdImage, 'r') } catch (err) { console.error('cd', err.message); cdImage = null }
}
ipcMain.on('cd-read', (e, sector, length) => {
  if (cdFd === null || !(sector >= 0) || !(length > 0) || length > 64 << 20) { e.returnValue = null; return }
  const b = Buffer.alloc(length), n = fs.readSync(cdFd, b, 0, length, sector * 2048)
  e.returnValue = n === length ? b : null
})
// ---- the audio CD in the second drive: its table of contents and the file of its sectors, as the build placed them
const audioToc = JSON.parse(fs.readFileSync(path.join(__dirname, 'audiocd.json'), 'utf8'))
const audioFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'audio.json'), 'utf8')).file
let audioFd = null
ipcMain.on('audio-toc', e => { e.returnValue = audioToc })
ipcMain.handle('audio-read', (e, start, length) => {
  if (!(start >= 0) || !(length > 0) || length > 16 << 20) throw new Error('audio-read: bad range')
  if (audioFd === null) audioFd = fs.openSync(audioFile, 'r')
  const b = Buffer.alloc(length), n = fs.readSync(audioFd, b, 0, length, start)
  return b.subarray(0, n)
})
// the disc put in the drive (an image's file) or taken out (null): kept for the next start (cdrom.json), and the page told
function cdPut(file) {
  cdOpen(file); fs.writeFileSync(cdFile(), JSON.stringify({ image: cdImage }, null, 2))
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('cd-changed', cdImage && path.basename(cdImage))
}
async function insertCD() {
  const r = await dialog.showOpenDialog({ title: 'Insert CD Image', buttonLabel: 'Insert', properties: ['openFile'], filters: [{ name: 'CD images', extensions: ['iso'] }] })
  if (r.canceled || !r.filePaths[0]) return
  cdPut(r.filePaths[0])
}
const ejectCD = () => cdPut(null)
ipcMain.on('cd-image', e => { e.returnValue = cdImage && path.basename(cdImage) })
// (Windows' own: Start > Programs > Accessories > System Tools > Insert CD Image, and the drive's Eject)
ipcMain.on('cd-insert', () => insertCD())
ipcMain.on('cd-eject', () => ejectCD())
// The shares on the Mac: each connected as a network volume (Finder's own, under Locations and in /Volumes), from the
// app's WebDAV server, as it joins the list; File > Connect Shares in Finder also opens each one's window. They are
// disconnected as the app quits (the server goes with it).
const DAV_PORT = 9395
// (connected by mount_webdav at a folder of the app's own: Finder's Connect to Server asks, of a server on this very
// computer, whether to send a name and password insecurely, and none is sent)
function connectShares(show) {
  const { execFile } = require('child_process')
  for (const s of shares.served()) {
    // (the volume has the folder's own name, "Public", and its server is <share>.localhost: Finder lists a connected
    // server by its host, and by the address the share was a folder inside "127.0.0.1")
    const name = path.basename(s.path) || s.name, at = path.join(app.getPath('userData'), 'Shares', name)
    const url = `http://${s.name.toLowerCase()}.localhost:${DAV_PORT}/`
    fs.promises.mkdir(at, { recursive: true }).then(() => execFile('mount_webdav', ['-S', '-v', name, url, at], () => { if (show) execFile('open', [at], () => {}) }), () => {})
  }
}
app.on('will-quit', () => {
  // (by a process of its own, which outlives the app: every volume connected from this server)
  const sh = `mount | sed -n 's|^http://[^/]*:${DAV_PORT}/.* on \\(/.*\\) (webdav.*|\\1|p' | while IFS= read -r m; do umount "$m"; done`
  require('child_process').spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref()
})
async function shareFolder() {
  const r = await dialog.showOpenDialog({ title: 'Share a Folder', buttonLabel: 'Share', properties: ['openDirectory', 'createDirectory'] })
  if (!r.canceled && r.filePaths[0]) shares.add(r.filePaths[0])
}
// ---- View > Mute: the app's sound off (the machine runs on, its sound unheard), kept for the next start (mute.json)
const muteFile = () => path.join(app.getPath('userData'), 'mute.json')
let muted = false
function setMuted(on) {
  muted = !!on; fs.writeFileSync(muteFile(), JSON.stringify({ muted }))
  for (const w of BrowserWindow.getAllWindows()) w.webContents.setAudioMuted(muted)
}
app.on('browser-window-created', (_, w) => w.webContents.setAudioMuted(muted))
app.whenReady().then(() => {
  try { muted = !!JSON.parse(fs.readFileSync(muteFile(), 'utf8')).muted } catch (_) {}
  store =require('./store').open(dbFile())
  // (a share joins the list once its folder has been read: the page is told, and connects its drive)
  shares = require('./shares').open(path.join(app.getPath('userData'), 'shares.json'), () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('shares-changed'); connectShares(false) })
  // the same shares for the Mac itself, read-only (webdav.js): File > Connect Shares in Finder connects each as a volume
  require('./webdav').serve(() => shares.served(), DAV_PORT)
  // the disc in the drive: the one the person inserted, or none when they took it out (cdrom.json); before either,
  // the one the app was built with (cd.json, the project's cdrom.iso, the same disc serve.py serves the page)
  const kept = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (_) { return null } }
  const chosen = kept(cdFile()), built = kept(path.join(__dirname, 'cd.json'))
  cdOpen(chosen ? chosen.image || null : built && built.image)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [{ label: 'Share a Folder…', click: shareFolder }, { label: 'Connect Shares in Finder', click: () => connectShares(true) }, { label: 'Insert CD Image…', click: insertCD }, { label: 'Eject CD', click: ejectCD }, { type: 'separator' },
      { label: 'Export Session…', click: exportSession }, { label: 'Import Session…', click: importSession }] },
    { label: 'View', submenu: [{ label: 'Mute', type: 'checkbox', checked: muted, accelerator: 'CmdOrCtrl+Shift+M', click: i => setMuted(i.checked) }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]))
  open()
})
app.on('window-all-closed', () => app.quit())
