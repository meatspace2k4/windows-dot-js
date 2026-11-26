// A session file (.w95session): the machine's C: and registry (the Claude program's sessions in it) as one SQLite
// database, the same tables the Electron app keeps (electron/store.js) and the page keeps in IndexedDB (host-web.js),
// so a session exported from either continues in the other. A registry value is kept as the app's store keeps it, in
// V8's serialization format (Node's v8.serialize: { type, data } with data a Uint8Array); this reads that format and
// writes it at version 15, which every V8 the app and Node use read. The database itself is reached through `db`:
// sql.js in the page, node:sqlite in the tests ({ exec(sql), run(sql, params), all(sql) }).
(() => {
  // ---------------------------------------------------------------- V8 values (the subset a registry value uses)
  const VIEWS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, DataView];   // (Node's host-object type index)
  function v8decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); let i = 0;
    const varint = () => { let v = 0, s = 0, c; do { c = b[i++]; v += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return v; };
    const zig = () => { const v = varint(); return v % 2 ? -(v + 1) / 2 : v / 2; };
    const value = () => {
      for (;;) {
        const t = b[i++];
        switch (t) {
          case 0x00: continue;                                        // (padding)
          case 0xff: varint(); continue;                              // (the header: its version)
          case 0x5f: return undefined;                                // _
          case 0x30: return null;                                     // 0
          case 0x54: return true;                                     // T
          case 0x46: return false;                                    // F
          case 0x49: return zig();                                    // I: int32
          case 0x55: return varint();                                 // U: uint32
          case 0x4e: { const v = new DataView(b.buffer, b.byteOffset + i, 8).getFloat64(0, true); i += 8; return v; }   // N: double
          case 0x22: { const n = varint(), s = String.fromCharCode(...b.subarray(i, i + n)); i += n; return s; }      // ": one-byte string
          case 0x63: { const n = varint(); let s = ''; for (let k = 0; k < n; k += 2) s += String.fromCharCode(b[i + k] | b[i + k + 1] << 8); i += n; return s; }   // c: two-byte string
          case 0x53: { const n = varint(), s = new TextDecoder().decode(b.subarray(i, i + n)); i += n; return s; }    // S: UTF-8 string
          case 0x6f: { const o = {}; while (b[i] !== 0x7b) { const k = value(); o[k] = value(); } i++; varint(); return o; }   // o ... {
          case 0x41: { const n = varint(), a = []; for (let k = 0; k < n; k++) a.push(value()); while (b[i] !== 0x24) { const k = value(); a[k] = value(); } i++; varint(); varint(); return a; }   // A ... $
          case 0x5c: { const ti = varint(), n = varint(), raw = b.slice(i, i + n); i += n; const C = VIEWS[ti] || Uint8Array; return C === Uint8Array || C === DataView ? raw : new C(raw.buffer); }   // \: a Node host object, a typed array
          default: throw new Error(`a registry value in a form this does not read (tag 0x${t.toString(16)} at ${i - 1})`);
        }
      }
    };
    return value();
  }
  function v8encode(v) {
    const out = [], varint = n => { do { let c = n % 128; n = Math.floor(n / 128); if (n) c |= 0x80; out.push(c); } while (n); };
    const put = x => {
      if (x === undefined) out.push(0x5f);
      else if (x === null) out.push(0x30);
      else if (x === true) out.push(0x54);
      else if (x === false) out.push(0x46);
      else if (typeof x === 'number') {
        if (Number.isInteger(x) && x >= -2147483648 && x <= 2147483647) { out.push(0x49); varint(x < 0 ? -2 * x - 1 : 2 * x); }
        else { out.push(0x4e); const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x, true); out.push(...new Uint8Array(d.buffer)); }
      } else if (typeof x === 'string') {
        if (/^[\x00-\xff]*$/.test(x)) { out.push(0x22); varint(x.length); for (const ch of x) out.push(ch.charCodeAt(0)); }
        else { out.push(0x63); varint(x.length * 2); for (let k = 0; k < x.length; k++) { const c = x.charCodeAt(k); out.push(c & 0xff, c >> 8); } }
      } else if (ArrayBuffer.isView(x)) {
        const raw = new Uint8Array(x.buffer, x.byteOffset, x.byteLength), ti = VIEWS.findIndex(C => x instanceof C);
        out.push(0x5c); varint(ti < 0 ? 1 : ti); varint(raw.length); for (const c of raw) out.push(c);
      } else if (Array.isArray(x)) { out.push(0x41); varint(x.length); x.forEach(put); out.push(0x24); varint(0); varint(x.length); }
      else { const ks = Object.keys(x); out.push(0x6f); for (const k of ks) { put(k); put(x[k]); } out.push(0x7b); varint(ks.length); }
    };
    out.push(0xff, 0x0f); put(v);
    return Uint8Array.from(out);
  }

  // ---------------------------------------------------------------- the database: the app's tables, row by row
  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS node (sid INTEGER PRIMARY KEY, parent INTEGER NOT NULL, name TEXT NOT NULL, short TEXT NOT NULL,
      dir INTEGER NOT NULL, ord INTEGER NOT NULL, attrs INTEGER NOT NULL, ctime REAL NOT NULL, mtime REAL NOT NULL, atime REAL NOT NULL, size INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS node_parent ON node(parent);
    CREATE TABLE IF NOT EXISTS chunk (sid INTEGER NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sid, idx));
    CREATE TABLE IF NOT EXISTS volume (k TEXT PRIMARY KEY, v);
    CREATE TABLE IF NOT EXISTS regkey (path TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS regval (path TEXT NOT NULL, name TEXT NOT NULL, value BLOB NOT NULL, ord INTEGER, PRIMARY KEY (path, name));`;
  const TABLES = ['node', 'chunk', 'volume', 'regkey', 'regval'];

  // rows: { node: [{ sid, parent, name, short, dir, ord, attrs, ctime, mtime, atime, size }], chunk: [{ sid, idx, bytes }],
  // volume: [{ k, v }], regkey: [{ path, name }], regval: [{ path, name, value }] } (a value as the registry holds it)
  function write(db, rows) {
    db.exec(SCHEMA);
    db.exec('BEGIN');
    for (const r of rows.node) db.run('INSERT INTO node (sid, parent, name, short, dir, ord, attrs, ctime, mtime, atime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.sid, r.parent, r.name, r.short, r.dir ? 1 : 0, r.ord, r.attrs, r.ctime, r.mtime, r.atime, r.size || 0]);
    for (const r of rows.chunk) db.run('INSERT INTO chunk (sid, idx, bytes) VALUES (?, ?, ?)', [r.sid, r.idx, r.bytes]);
    for (const r of rows.volume) db.run('INSERT INTO volume (k, v) VALUES (?, ?)', [r.k, r.v === undefined ? null : r.v]);
    for (const r of rows.regkey) db.run('INSERT INTO regkey (path, name) VALUES (?, ?)', [r.path, r.name === undefined ? null : r.name]);
    for (const r of rows.regval) db.run('INSERT INTO regval (path, name, value, ord) VALUES (?, ?, ?, ?)', [r.path, r.name, v8encode(r.value), r.ord === undefined ? null : r.ord]);
    db.exec('COMMIT');
  }
  // why a database is not a session (null when it is one), as the app checks one before it replaces its own
  function check(db) {
    let names;
    try { names = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name)); } catch (e) { return `it is not a Windows 95 session (${e.message})`; }
    for (const t of TABLES) if (!names.has(t)) return `it has no ${t} table`;
    if (!db.all('SELECT COUNT(*) AS n FROM node')[0].n || !db.all('SELECT COUNT(*) AS n FROM regkey')[0].n) return 'its C: or its registry is empty';
    return null;
  }
  function read(db) {
    const u8 = b => (b instanceof Uint8Array ? new Uint8Array(b) : new Uint8Array(b || []));
    const hasName = db.all('PRAGMA table_info(regkey)').some(c => c.name === 'name'), hasOrd = db.all('PRAGMA table_info(regval)').some(c => c.name === 'ord');
    return {
      node: db.all('SELECT * FROM node ORDER BY sid').map(r => ({ sid: r.sid, parent: r.parent, name: r.name, short: r.short, dir: !!r.dir, ord: r.ord, attrs: r.attrs,
        ctime: r.ctime, mtime: r.mtime, atime: r.atime, size: r.size })),
      chunk: db.all('SELECT sid, idx, bytes FROM chunk ORDER BY sid, idx').map(r => ({ sid: r.sid, idx: r.idx, bytes: u8(r.bytes) })),
      volume: db.all('SELECT k, v FROM volume').map(r => ({ k: r.k, v: r.v })),
      regkey: db.all(`SELECT path${hasName ? ', name' : ''} FROM regkey ORDER BY path`).map(r => (r.name ? { path: r.path, name: r.name } : { path: r.path })),
      // (a key's values in the order they were made, as RegEnumValue gives them)
      regval: db.all(`SELECT path, name, value${hasOrd ? ', ord' : ''} FROM regval ORDER BY ${hasOrd ? 'ord, ' : ''}rowid`).map((r, i) => ({ path: r.path, name: r.name, value: v8decode(u8(r.value)), ord: r.ord == null ? i + 1 : r.ord })),
    };
  }

  const api = { v8decode, v8encode, write, read, check, TABLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.W95Session = api;
})();
