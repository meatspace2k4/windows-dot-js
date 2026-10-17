// The Mac's folders the LAN's other computer (lanhost.js) serves as shares: each a name and a folder, kept in the app's
// data folder (shares.json). The home folder is shared as HOME unless the list says otherwise; the folders macOS asks
// permission for (Desktop, Documents, Downloads, Library) are left out of it, so nothing is opened that the app has not
// been given. A folder chosen with "Share a Folder..." is the person's choice and is shared as it is.
// Every path the page names is relative to its share's folder, and is refused if it would lead outside it.
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROTECTED = new Set(['desktop', 'documents', 'downloads', 'library'])

function open(file) {
  let list
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { list = null }
  if (!Array.isArray(list)) list = [{ name: 'HOME', path: os.homedir(), home: true }]
  const save = () => fs.writeFileSync(file, JSON.stringify(list, null, 2))
  const find = name => list.find(s => s.name.toUpperCase() === String(name).toUpperCase())

  // a share's path for a relative one: inside its folder, through no link that leads out, and not into a protected folder
  const resolve = (s, rel) => {
    const root = fs.realpathSync(s.path)
    const parts = String(rel || '').split(/[\\/]+/).filter(p => p && p !== '.')
    if (parts.some(p => p === '..')) throw Object.assign(new Error('outside the share'), { code: 'EACCES' })
    if (s.home && parts.length && PROTECTED.has(parts[0].toLowerCase())) throw Object.assign(new Error('not shared'), { code: 'ENOENT' })
    const full = path.join(root, ...parts)
    // the deepest part that exists, resolved, must still be inside the share
    let probe = full
    while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe)
    const real = fs.realpathSync(probe)
    if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(new Error('outside the share'), { code: 'EACCES' })
    return full
  }
  const info = (full, st) => ({ size: st.isDirectory() ? 0 : st.size, dir: st.isDirectory(), mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs,
    atime: st.atimeMs, readonly: !(st.mode & 0o200), hidden: path.basename(full).startsWith('.') })

  const ops = {
    stat: (s, rel) => { const f = resolve(s, rel); try { return info(f, fs.statSync(f)) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e } },
    list: (s, rel) => {
      const d = resolve(s, rel), out = []
      for (const name of fs.readdirSync(d)) {
        if (s.home && !String(rel || '').replace(/[\\/]/g, '') && PROTECTED.has(name.toLowerCase())) continue
        let st; try { st = fs.statSync(path.join(d, name)) } catch (_) { continue }   // a dangling link or no permission
        if (!st.isFile() && !st.isDirectory()) continue
        out.push({ name, ...info(path.join(d, name), st) })
      }
      return out
    },
    read: (s, rel, off, n) => {
      const fd = fs.openSync(resolve(s, rel), 'r')
      try { const b = Buffer.alloc(Math.max(0, Math.min(n, 1 << 20))); const k = fs.readSync(fd, b, 0, b.length, off); return new Uint8Array(b.buffer, b.byteOffset, k) } finally { fs.closeSync(fd) }
    },
    write: (s, rel, off, bytes) => { const fd = fs.openSync(resolve(s, rel), 'r+'); try { fs.writeSync(fd, Buffer.from(bytes), 0, bytes.length, off) } finally { fs.closeSync(fd) } },
    truncate: (s, rel, n) => fs.truncateSync(resolve(s, rel), n),
    create: (s, rel, excl) => fs.closeSync(fs.openSync(resolve(s, rel), excl ? 'wx' : 'w')),
    mkdir: (s, rel) => fs.mkdirSync(resolve(s, rel)),
    rmdir: (s, rel) => fs.rmdirSync(resolve(s, rel)),
    unlink: (s, rel) => fs.unlinkSync(resolve(s, rel)),
    rename: (s, a, b) => fs.renameSync(resolve(s, a), resolve(s, b)),
    times: (s, rel, ms) => { const t = new Date(ms); fs.utimesSync(resolve(s, rel), t, t) },
    space: s => { const st = fs.statfsSync(s.path); return { total: st.blocks * st.bsize, free: st.bavail * st.bsize } },
  }
  return {
    list: () => list.filter(s => { try { return fs.statSync(s.path).isDirectory() } catch (_) { return false } }).map(s => ({ name: s.name, remark: s.remark || '' })),
    // an operation: { ok: result } or { err: code }, for the page to turn into the file server's errors
    op: (name, op, ...args) => {
      const s = find(name)
      if (!s || !ops[op]) return { err: 'ENOENT' }
      try { return { ok: ops[op](s, ...args) } } catch (e) { return { err: e.code || 'EIO' } }
    },
    add: (dir, name) => {
      const base = (name || path.basename(dir)).toUpperCase().replace(/[^A-Z0-9_$~!#%&\-{}()@'`^]/g, '').slice(0, 12) || 'SHARE'
      let n = base; for (let i = 2; find(n); i++) n = base.slice(0, 12 - String(i).length) + i
      list.push({ name: n, path: dir }); save(); return n
    },
    remove: name => { list = list.filter(s => s !== find(name)); save() },
    all: () => list.map(s => ({ ...s })),
  }
}
module.exports = { open }
