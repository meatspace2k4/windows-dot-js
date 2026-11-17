// The app's shares as the Mac itself sees them: a WebDAV server on this computer alone (127.0.0.1), which Finder
// connects as a network volume (Go > Connect to Server, http://127.0.0.1:<port>/<SHARE>). The same folders Windows has
// as \\<this Mac>\<SHARE>, so a file is in both at once. It is read-only whatever the share is: the methods that read
// (OPTIONS, PROPFIND, GET, HEAD) are all it answers, class 1 with no locks, which macOS connects read-only.
// Nothing here waits on the disk: every file operation is asynchronous, a file is sent as a stream.
const http = require('http')
const fs = require('fs')
const path = require('path')

const PROTECTED = new Set(['desktop', 'documents', 'downloads', 'library'])
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const href = parts => '/' + parts.map(encodeURIComponent).join('/')

/** serve(shares, port): `shares()` answers the shares served now, each { name, path, home }. Answers the server. */
function serve(shares, port) {
  // a request's share and file: null when it names none, or leads outside its share
  // (a host named for a share, <share>.localhost, is that share alone, at the server's root: Finder names a connected
  // server by its host, so the share is "public.localhost" there and not a folder inside "127.0.0.1")
  const locate = async (url, host) => {
    let parts
    try { parts = decodeURIComponent(new URL(url, 'http://x').pathname).split('/').filter(Boolean) } catch (_) { return null }
    const m = /^([^.:]+)\.localhost(:\d+)?$/i.exec(host || ''), own = m && shares().find(x => x.name.toUpperCase() === m[1].toUpperCase())
    if (own) parts = [own.name, ...parts]
    const hp = p => (own ? p.slice(1) : p)   // (the parts as the client names them)
    if (!parts.length) return { root: true, parts, hp }
    if (parts.some(p => p === '..' || p === '.' || p.includes('\\') || p.includes('\0'))) return null
    const s = shares().find(x => x.name.toUpperCase() === parts[0].toUpperCase())
    if (!s) return null
    if (s.home && parts.length > 1 && PROTECTED.has(parts[1].toLowerCase())) return null
    const root = await fs.promises.realpath(s.path), full = path.join(root, ...parts.slice(1))
    const real = await fs.promises.realpath(full).catch(() => null)
    if (!real || (real !== root && !real.startsWith(root + path.sep))) return null
    return { share: s, full: real, parts: [s.name, ...parts.slice(1)], hp }
  }
  const entry = (parts, st) => `<D:response><D:href>${esc(href(parts) + (st.isDirectory() && parts.length ? '/' : ''))}</D:href><D:propstat><D:prop>`
    + `<D:displayname>${esc(parts[parts.length - 1] || '')}</D:displayname>`
    + `<D:resourcetype>${st.isDirectory() ? '<D:collection/>' : ''}</D:resourcetype>`
    + (st.isDirectory() ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`)
    + `<D:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</D:getlastmodified><D:creationdate>${new Date(st.birthtimeMs || st.ctimeMs).toISOString()}</D:creationdate>`
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
  const DIR = { isDirectory: () => true, mtimeMs: Date.now(), birthtimeMs: Date.now(), size: 0 }

  const propfind = async (req, res, at) => {
    const deep = req.headers.depth !== '0', out = []
    if (at.root) { out.push(entry([], DIR)); if (deep) for (const s of shares()) out.push(entry([s.name], DIR)) }
    else {
      const st = await fs.promises.stat(at.full); out.push(entry(at.hp(at.parts), st))
      if (deep && st.isDirectory()) for (const name of await fs.promises.readdir(at.full)) {
        if (at.share.home && at.parts.length === 1 && PROTECTED.has(name.toLowerCase())) continue
        const k = await fs.promises.stat(path.join(at.full, name)).catch(() => null)   // (a dangling link, or no permission)
        if (k && (k.isFile() || k.isDirectory())) out.push(entry(at.hp([...at.parts, name]), k))
      }
    }
    const body = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${out.join('')}</D:multistatus>`)
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': body.length }); res.end(body)
  }
  const get = async (req, res, at, head) => {
    if (at.root) { res.writeHead(403); return res.end() }
    const st = await fs.promises.stat(at.full)
    if (st.isDirectory()) { res.writeHead(403); return res.end() }
    const h = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Last-Modified': new Date(st.mtimeMs).toUTCString(), ETag: `"${st.size}-${Math.round(st.mtimeMs)}"` }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    let from = 0, to = st.size - 1, code = 200
    if (m && (m[1] || m[2])) {
      if (m[1]) { from = Number(m[1]); if (m[2]) to = Math.min(to, Number(m[2])) } else from = Math.max(0, st.size - Number(m[2]))
      if (from > to || from >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end() }
      code = 206; h['Content-Range'] = `bytes ${from}-${to}/${st.size}`
    }
    h['Content-Length'] = st.size ? to - from + 1 : 0
    res.writeHead(code, h)
    if (head || !st.size) return res.end()
    fs.createReadStream(at.full, { start: from, end: to }).on('error', () => res.destroy()).pipe(res)
  }

  const server = http.createServer((req, res) => {
    req.resume()   // (a body, PROPFIND's, is not read: every property asked for gets the same answer)
    const run = async () => {
      if (req.method === 'OPTIONS') { res.writeHead(200, { DAV: '1', Allow: 'OPTIONS, PROPFIND, GET, HEAD', 'MS-Author-Via': 'DAV', 'Content-Length': 0 }); return res.end() }
      if (!['PROPFIND', 'GET', 'HEAD'].includes(req.method)) { res.writeHead(403, { 'Content-Length': 0 }); return res.end() }   // read-only
      const at = await locate(req.url, req.headers.host)
      if (!at) { res.writeHead(404, { 'Content-Length': 0 }); return res.end() }
      return req.method === 'PROPFIND' ? propfind(req, res, at) : get(req, res, at, req.method === 'HEAD')
    }
    run().catch(e => { if (!res.headersSent) res.writeHead(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500, { 'Content-Length': 0 }); res.end() })
  })
  server.on('error', e => console.error('[webdav]', e.message))
  server.listen(port, '127.0.0.1')
  // (a .localhost name is this computer's IPv6 loopback to macOS: the same server there; a port chosen by the system,
  // the tests', has one address)
  if (port) { const six = http.createServer((req, res) => server.emit('request', req, res)); six.on('error', e => console.error('[webdav]', e.message)); six.listen(port, '::1'); server.on('close', () => six.close()) }
  return server
}
module.exports = { serve }
