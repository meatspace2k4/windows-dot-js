const { app, BrowserWindow, Menu } = require('electron')
const fs = require('fs')
const path = require('path')

// packaged builds carry the shell in ./web; a dev run uses the project folder
const bundled = path.join(__dirname, 'web', 'index.html')
const page = fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', 'index.html')

function open() {
  const win = new BrowserWindow({
    width: 640, height: 480, useContentSize: true, minWidth: 320, minHeight: 240,
    title: 'Windows 95', backgroundColor: '#000000', show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  })
  win.once('ready-to-show', () => { win.show(); win.focus() })
  win.loadFile(page)
}

app.setName('Windows 95')
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]))
  open()
})
app.on('window-all-closed', () => app.quit())
