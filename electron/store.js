// The database behind C: and the registry: SQLite in the app's data folder, one transaction per change.
// Files are kept in 64 KiB chunks so a write touches only the chunks it covers.
const { DatabaseSync } = require('node:sqlite')
const v8 = require('v8')

const CHUNK = 65536

function open(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS node (sid INTEGER PRIMARY KEY, parent INTEGER NOT NULL, name TEXT NOT NULL, short TEXT NOT NULL,
      dir INTEGER NOT NULL, ord INTEGER NOT NULL, attrs INTEGER NOT NULL, ctime REAL NOT NULL, mtime REAL NOT NULL, atime REAL NOT NULL, size INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS node_parent ON node(parent);
    CREATE TABLE IF NOT EXISTS chunk (sid INTEGER NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sid, idx));
    CREATE TABLE IF NOT EXISTS volume (k TEXT PRIMARY KEY, v);
    CREATE TABLE IF NOT EXISTS regkey (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS regval (path TEXT NOT NULL, name TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (path, name));
  `)
  // a key's name as created (its path is lower case), added to stores made before it was kept
  if (!db.prepare('PRAGMA table_info(regkey)').all().some(c => c.name === 'name')) db.exec('ALTER TABLE regkey ADD COLUMN name TEXT')
  // a value's place in the order its key's values were made (RegEnumValue's order), added to stores made before it was kept
  if (!db.prepare('PRAGMA table_info(regval)').all().some(c => c.name === 'ord')) db.exec('ALTER TABLE regval ADD COLUMN ord INTEGER')
  const q = {
    upsert: db.prepare(`INSERT INTO node (sid, parent, name, short, dir, ord, attrs, ctime, mtime, atime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET parent = excluded.parent, name = excluded.name, short = excluded.short, ord = excluded.ord, attrs = excluded.attrs,
      ctime = excluded.ctime, mtime = excluded.mtime, atime = excluded.atime`),
    subtree: db.prepare(`WITH RECURSIVE t(sid) AS (SELECT ? UNION ALL SELECT node.sid FROM node JOIN t ON node.parent = t.sid) SELECT sid FROM t`),
    delNode: db.prepare('DELETE FROM node WHERE sid = ?'),
    delChunks: db.prepare('DELETE FROM chunk WHERE sid = ?'),
    getChunk: db.prepare('SELECT bytes FROM chunk WHERE sid = ? AND idx = ?'),
    putChunk: db.prepare('INSERT OR REPLACE INTO chunk (sid, idx, bytes) VALUES (?, ?, ?)'),
    delChunksFrom: db.prepare('DELETE FROM chunk WHERE sid = ? AND idx >= ?'),
    setSize: db.prepare('UPDATE node SET size = ? WHERE sid = ?'),
    getSize: db.prepare('SELECT size FROM node WHERE sid = ?'),
    nodes: db.prepare('SELECT * FROM node ORDER BY sid'),
    chunks: db.prepare('SELECT idx, bytes FROM chunk WHERE sid = ? ORDER BY idx'),
    setVol: db.prepare('INSERT OR REPLACE INTO volume (k, v) VALUES (?, ?)'),
    vol: db.prepare('SELECT v FROM volume WHERE k = ?'),
    addKey: db.prepare('INSERT OR IGNORE INTO regkey (path) VALUES (?)'),
    addNamedKey: db.prepare('INSERT INTO regkey (path, name) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET name = COALESCE(regkey.name, excluded.name)'),
    delKeys: db.prepare(`DELETE FROM regkey WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '\\'`),
    delKeyVals: db.prepare(`DELETE FROM regval WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '\\'`),
    setVal: db.prepare(`INSERT INTO regval (path, name, value, ord) VALUES (?, ?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM regval))
      ON CONFLICT(path, name) DO UPDATE SET value = excluded.value`),
    delVal: db.prepare('DELETE FROM regval WHERE path = ? AND name = ?'),
    keys: db.prepare('SELECT path, name FROM regkey ORDER BY path'),
    vals: db.prepare('SELECT name, value FROM regval WHERE path = ? ORDER BY ord, rowid'),
  }
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } }

  function write(sid, offset, bytes) {
    for (let at = 0; at < bytes.length;) {
      const pos = offset + at, idx = Math.floor(pos / CHUNK), within = pos - idx * CHUNK
      const n = Math.min(CHUNK - within, bytes.length - at)
      const old = q.getChunk.get(sid, idx)
      let buf = old ? Buffer.from(old.bytes) : Buffer.alloc(0)
      if (buf.length < within + n) buf = Buffer.concat([buf, Buffer.alloc(within + n - buf.length)])
      buf.set(bytes.subarray(at, at + n), within)
      q.putChunk.run(sid, idx, buf)
      at += n
    }
    const end = offset + bytes.length, size = q.getSize.get(sid)
    if (size && end > size.size) q.setSize.run(end, sid)
  }
  function resize(sid, size) {
    const keep = Math.ceil(size / CHUNK)
    q.delChunksFrom.run(sid, keep)
    if (keep) {
      const last = q.getChunk.get(sid, keep - 1), want = size - (keep - 1) * CHUNK
      if (last && last.bytes.length > want) q.putChunk.run(sid, keep - 1, Buffer.from(last.bytes).subarray(0, want))
    }
    q.setSize.run(size, sid)
  }

  const ops = {
    node: r => q.upsert.run(r.sid, r.parent, r.name, r.short, r.dir ? 1 : 0, r.ord, r.attrs, r.ctime, r.mtime, r.atime),
    remove: sid => { for (const { sid: s } of q.subtree.all(sid)) { q.delChunks.run(s); q.delNode.run(s) } },
    data: write,
    size: resize,
    label: (label, serial) => { q.setVol.run('label', label); q.setVol.run('serial', serial) },
    reg: o => {
      if (o.op === 'key') { if (o.name) q.addNamedKey.run(o.path, o.name); else q.addKey.run(o.path) }
      else if (o.op === 'delkey') { q.delKeys.run(o.path, o.path, o.path); q.delKeyVals.run(o.path, o.path, o.path) }
      else if (o.op === 'set') { q.addKey.run(o.path); q.setVal.run(o.path, o.name, v8.serialize(o.value)) }
      else if (o.op === 'del') q.delVal.run(o.path, o.name)
    },
  }

  return {
    apply: (op, args) => { const f = ops[op]; if (!f) throw new Error('unknown store op ' + op); tx(() => f(...args)) },
    loadDisk() {
      const rows = q.nodes.all()
      if (!rows.length) return null
      const nodes = rows.map(r => {
        const e = { sid: r.sid, parent: r.parent, name: r.name, short: r.short, dir: !!r.dir, ord: r.ord, attrs: r.attrs, ctime: r.ctime, mtime: r.mtime, atime: r.atime }
        if (!r.dir) {
          const data = new Uint8Array(r.size)
          for (const c of q.chunks.all(r.sid)) { const off = c.idx * CHUNK; if (off < r.size) data.set(c.bytes.subarray(0, r.size - off), off) }
          e.data = data
        }
        return e
      })
      const label = q.vol.get('label'), serial = q.vol.get('serial')
      return { nodes, label: label ? label.v : undefined, serial: serial ? serial.v : undefined }
    },
    loadRegistry() {
      const keys = q.keys.all()
      if (!keys.length) return null
      return keys.map(({ path, name }) => [path, q.vals.all(path).map(r => [r.name, v8.deserialize(r.value)]), name || undefined])
    },
    // a copy of the whole store as it stands, consistent while it is in use (SQLite's VACUUM INTO): a session to
    // continue on another computer
    exportTo: file => db.prepare('VACUUM INTO ?').run(file),
    close: () => db.close(),
  }
}

// whether a file is a store this app wrote (its tables, a C: and a registry in it), before it replaces this one's
function check(file) {
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name))
    for (const t of ['node', 'chunk', 'volume', 'regkey', 'regval']) if (!tables.has(t)) return `it has no ${t} table`
    const nodes = db.prepare('SELECT COUNT(*) AS n FROM node').get().n, keys = db.prepare('SELECT COUNT(*) AS n FROM regkey').get().n
    if (!nodes || !keys) return 'its C: or its registry is empty'
    return null
  } catch (err) { return `it is not a Windows 95 session (${err.message})` }
  finally { if (db) db.close() }
}

module.exports = { open, check }
