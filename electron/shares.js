// The Mac's folders the LAN's other computer (lanhost.js) serves as shares: each a name and a folder, kept in the app's
// data folder (shares.json). ~/Documents/Claude is shared as CLAUDE unless the list says otherwise.
// A share is read-only: every operation that would change the Mac's files (write, truncate, create, mkdir, rmdir,
// unlink, rename, times) is refused here, whatever the page asks; its files are shown read-only and its free space as
// none. Only a share the list marks "writable": true takes changes.
// A share is served once its folder has been read, and that first read is asynchronous: macOS holds the first access
// to Documents, Desktop or Downloads until the person answers its question, and the page waits on each answer here
// (the machine stops meanwhile). Until then the share is not in the list and its operations answer ENOENT at once;
// `changed` is called when it joins.
// A share marked "home" (the whole home folder) leaves out the folders macOS asks permission for.
// Every path the page names is relative to its share's folder, and is refused if it would lead outside it.
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROTECTED = new Set(['desktop', 'documents', 'downloads', 'library'])
const CHANGES = new Set(['write', 'truncate', 'create', 'mkdir', 'rmdir', 'unlink', 'rename', 'times'])

function open(file, changed = () => {}) {
  let list
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { list = null }
  if (!Array.isArray(list)) list = [{ name: 'CLAUDE', path: path.join(os.homedir(), 'Documents', 'Claude') }]
  // the shares whose folders have been read (the entries themselves), each after its first read ends
  const ready = new Set()
  const probe = s => fs.promises.readdir(s.path).then(() => { if (list.includes(s)) { ready.add(s); changed() } }, () => {})
  const probed = Promise.all(list.map(probe))
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
    list: () => list.filter(s => ready.has(s)).map(s => ({ name: s.name, remark: s.remark || '', readonly: s.writable !== true })),
    // an operation: { ok: result } or { err: code }, for the page to turn into the file server's errors
    op: (name, op, ...args) => {
      const s = find(name)
      if (!s || !ready.has(s) || !ops[op]) return { err: 'ENOENT' }
      if (s.writable !== true && CHANGES.has(op)) return { err: 'EACCES' }
      try {
        const r = ops[op](s, ...args)
        if (s.writable !== true) {
          if (op === 'stat' && r) r.readonly = true
          if (op === 'list') for (const e of r) e.readonly = true
          if (op === 'space') r.free = 0
        }
        return { ok: r }
      } catch (e) { return { err: e.code || 'EIO' } }
    },
    probed,   // (every share of the list read, or refused)
    add: (dir, name) => {
      const base = (name || path.basename(dir)).toUpperCase().replace(/[^A-Z0-9_$~!#%&\-{}()@'`^]/g, '').slice(0, 12) || 'SHARE'
      let n = base; for (let i = 2; find(n); i++) n = base.slice(0, 12 - String(i).length) + i
      const s = { name: n, path: dir }; list.push(s); save(); probe(s); return n
    },
    remove: name => { const s = find(name); list = list.filter(x => x !== s); ready.delete(s); save(); changed() },
    all: () => list.map(s => ({ ...s })),
  }
}
module.exports = { open }
