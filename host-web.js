// W95HOST for a plain browser: the same write-through store the Electron app keeps in SQLite (electron/store.js),
// here in IndexedDB. The shell reads its store synchronously at boot, so this loads everything first and then
// starts win95.js. Each write opens its own readwrite transaction as it happens; IndexedDB runs those in the order
// they were opened. In the app the preload has already set W95HOST and this only starts the shell.
(() => {
  const start = () => { const s = document.createElement('script'); s.src = 'win95.js'; s.async = false; document.body.appendChild(s); };
  if (window.W95HOST || !window.indexedDB) return start();

  const CHUNK = 65536;
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  // The sessions this computer keeps, side by side, each a database of its own ('win95' the first); which one Windows
  // starts from is the catalog's choice (localStorage w95.stores), so saving or importing one adds it and chooses it,
  // and the one chosen before is still there to go back to. A session joined (shared.js) runs from memory and the
  // server, and is kept here only when saved
  const CATALOG = 'w95.stores';
  const catalog = (() => { let c = null; try { c = JSON.parse(localStorage.getItem(CATALOG) || 'null'); } catch (_) { /* none */ }
    return c && c.current && Array.isArray(c.list) ? c : { current: 'win95', list: [{ db: 'win95', name: 'This computer', at: 0 }] }; })();
  const keepCatalog = () => { try { localStorage.setItem(CATALOG, JSON.stringify(catalog)); } catch (_) { /* no storage */ } };
  const openDb = name => new Promise((ok, no) => {
    const o = indexedDB.open(name, 1);
    o.onupgradeneeded = () => {
      const db = o.result;
      db.createObjectStore('node', { keyPath: 'sid' }).createIndex('parent', 'parent');
      db.createObjectStore('chunk', { keyPath: ['sid', 'idx'] });
      db.createObjectStore('volume', { keyPath: 'k' });
      db.createObjectStore('regkey', { keyPath: 'path' });
      db.createObjectStore('regval', { keyPath: ['path', 'name'] });
    };
    o.onsuccess = () => ok(o.result); o.onerror = () => no(o.error);
  });
  // a session's tables (W95Session.TABLES' rows) as a database of its own, added to the catalog and chosen
  const keepSession = async (rows, name) => {
    const db = 'win95-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), d = await openDb(db);
    try {
      await new Promise((ok, no) => {
        const tx = d.transaction(W95Session.TABLES, 'readwrite', { durability: 'strict' });
        for (const n of W95Session.TABLES) { const st = tx.objectStore(n); for (const r of rows[n] || []) st.put(r); }
        tx.oncomplete = ok; tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error);
      });
    } finally { d.close(); }
    catalog.list.push({ db, name: String(name || 'Session').slice(0, 64), at: Date.now() }); catalog.current = db; keepCatalog();
    return db;
  };
  // the tables of a session as the page's machine has it now (C: as its store loads, the registry as regDump gives it)
  const rowsOf = (disk, registry) => {
    const out = { node: [], chunk: [], volume: [], regkey: [], regval: [] };
    for (const e of (disk && disk.nodes) || []) {
      const { data, ...r } = e; out.node.push({ ...r, size: data ? data.length : 0 });
      if (data) for (let i = 0; i * CHUNK < data.length; i++) out.chunk.push({ sid: e.sid, idx: i, bytes: data.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
    if (disk) out.volume.push({ k: 'label', v: disk.label }, { k: 'serial', v: disk.serial });
    for (const [path, vals, name] of registry || []) {
      out.regkey.push(name ? { path, name } : { path });
      for (const [n, v] of vals) out.regval.push({ path, name: n, value: { type: v.type, data: v.data }, ord: out.regval.length + 1 });
    }
    return out;
  };

  // the server's shares (/__share: tools/serve.py's, the deployed win95_server.py's), asked synchronously as the app's
  // preload asks its main process
  const share = (op, name, args) => {
    const x = new XMLHttpRequest(); x.open('POST', '__share', false); x.setRequestHeader('Content-Type', 'application/json');
    const enc = v => (v instanceof Uint8Array ? { $b64: btoa(Array.from(v, c => String.fromCharCode(c)).join('')) } : v);
    try { x.send(JSON.stringify({ op, name, args: (args || []).map(enc) })); } catch (e) { return null; }
    if (x.status !== 200) return null;
    const r = JSON.parse(x.responseText), dec = v => (v && v.$b64 !== undefined ? Uint8Array.from(atob(v.$b64), c => c.charCodeAt(0)) : v);
    return r && r.ok !== undefined ? { ok: dec(r.ok) } : r;
  };
  const shares = { list: () => share('$list') || [], op: (name, op, ...args) => share(op, name, args) || { err: 'EIO' } };
  // the computer's name, asked in the background as the page loads (a blocking request here held every script after this one for
  // a round trip); a reader before the answer asks synchronously
  let hostName, hostNameKnown = false;
  fetch('__share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: '$host' }) })
    .then(r => (r.ok ? r.json() : null)).then(r => { if (!hostNameKnown) { hostName = typeof r === 'string' ? r : undefined; hostNameKnown = true; } }).catch(() => {});
  const computerName = () => { if (!hostNameKnown) { hostName = share('$host') || undefined; hostNameKnown = true; } return hostName; };

  // sql.js for a session file (session-file.js), fetched when one is exported or imported: its script pinned by its
  // integrity, its WebAssembly by its SHA-256 before it runs
  const SQLJS = { js: 'https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/sql-wasm.js', sri: 'sha384-4BFYB3flXPr2Z7nY58MEovqPlVDyWWBDlHTclbOjtPii317X+bu9vsbPUCkb//6+',
    wasm: 'https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/sql-wasm.wasm', sha256: '438c88f666dc054ce4e9395f80fe9db4218b1a3c379960454880f048a7898aed' };
  let sqljs = null;
  const loadSql = () => sqljs || (sqljs = (async () => {
    if (!window.initSqlJs) await new Promise((ok, no) => {
      const s = document.createElement('script'); s.src = SQLJS.js; s.integrity = SQLJS.sri; s.crossOrigin = 'anonymous';
      s.onload = ok; s.onerror = () => no(new Error('sql.js could not be loaded')); document.head.appendChild(s);
    });
    const wasm = new Uint8Array(await (await fetch(SQLJS.wasm)).arrayBuffer());
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasm)), c => c.toString(16).padStart(2, '0')).join('');
    if (hex !== SQLJS.sha256) throw new Error('sql.js\'s WebAssembly is not the one expected');
    return window.initSqlJs({ wasmBinary: wasm });
  })().catch(e => { sqljs = null; throw e; }));
  // a sql.js database as session-file.js reaches one
  const adapt = d => ({ exec: s => d.exec(s), run: (s, p) => d.run(s, p),
    all: s => { const st = d.prepare(s), out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; } });
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const download = (bytes, name) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  let frozen = false;   // (an imported session is replacing this one: the page going away writes nothing more)
  let valOrd = 0;       // (the last registry value's place in the order values were made: a new one's is next)

  function host(db, disk, registry) {
    // ---- a session file: the stores as they stand now, as the Electron app's database; an imported one in their place
    const rows = async () => {
      const tx = db.transaction(W95Session.TABLES), all = n => req(tx.objectStore(n).getAll());
      const [node, chunk, volume, regkey, regval] = await Promise.all(W95Session.TABLES.map(all));
      return { node, chunk, volume, regkey, regval };
    };
    const fileOf = async () => { const SQL = await loadSql(), d = new SQL.Database(); try { W95Session.write(adapt(d), await rows()); return d.export(); } finally { d.close(); } };
    const session = {
      export: async name => { const bytes = await fileOf(), file = name || `Windows 95 ${stamp()}.w95session`; download(bytes, file); return { file, size: bytes.length }; },
      // why the bytes are not a session (null when they are one)
      check: async bytes => { const SQL = await loadSql(); let d; try { d = new SQL.Database(bytes); return W95Session.check(adapt(d)); } catch (e) { return `it is not a Windows 95 session (${e.message})`; } finally { if (d) d.close(); } },
      // the session in the bytes kept beside this computer's others and chosen, then the page starts again from it (the
      // one before still kept: Open Session goes back to it)
      import: async (bytes, name) => {
        const SQL = await loadSql(), d = new SQL.Database(bytes); let next;
        try { const why = W95Session.check(adapt(d)); if (why) throw new Error(why); next = W95Session.read(adapt(d)); } finally { d.close(); }
        await keepSession(next, name || `Imported ${stamp()}`);
        frozen = true; location.reload();
      },
      // the session the page's machine runs now (a joined one too) kept on this computer as a session of its own, and
      // the one it starts from from now on; nothing kept here before is replaced
      save: async (name, disk, registry) => { const db = await keepSession(rowsOf(disk, registry), name); return { db, name }; },
      // the sessions kept here, and the one Windows starts from
      list: () => catalog.list.map(e => ({ ...e, current: e.db === catalog.current })),
      // Windows to start from another kept session: chosen, and the page starts again (leaving a joined session)
      open: db => { if (!catalog.list.some(e => e.db === db)) return false; catalog.current = db; keepCatalog(); frozen = true; return true; },
    };
    const run = (stores, fn) => {
      if (frozen) return;
      const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
      fn(...stores.map(s => tx.objectStore(s)));
      // (a promise for the write's end, for a caller that writes much and waits its turn: braid-page.js writeDisk)
      return new Promise(ok => { tx.oncomplete = () => ok(true); tx.onabort = () => ok(false); tx.onerror = () => { console.error('store write failed:', tx.error); }; });
    };
    const chunks = (sid, from = 0) => IDBKeyRange.bound([sid, from], [sid, Infinity]);
    return {
      shares, get computerName() { return computerName(); }, session,
      disk: {
        load: () => disk,
        node: r => run(['node'], async node => {
          const old = await req(node.get(r.sid));
          node.put({ ...r, size: old ? old.size : 0 });
        }),
        remove: sid => run(['node', 'chunk'], async (node, chunk) => {
          for (let todo = [sid]; todo.length;) {
            const s = todo.pop();
            todo.push(...await req(node.index('parent').getAllKeys(s)));
            node.delete(s); chunk.delete(chunks(s));
          }
        }),
        data: (sid, offset, bytes) => run(['node', 'chunk'], async (node, chunk) => {
          for (let at = 0; at < bytes.length;) {
            const pos = offset + at, idx = Math.floor(pos / CHUNK), within = pos - idx * CHUNK;
            const n = Math.min(CHUNK - within, bytes.length - at);
            const old = await req(chunk.get([sid, idx]));
            let buf = old ? old.bytes : new Uint8Array(0);
            if (buf.length < within + n) { const b = new Uint8Array(within + n); b.set(buf); buf = b; }
            buf.set(bytes.subarray(at, at + n), within);
            chunk.put({ sid, idx, bytes: buf });
            at += n;
          }
          const r = await req(node.get(sid));
          if (r && offset + bytes.length > r.size) node.put({ ...r, size: offset + bytes.length });
        }),
        size: (sid, size) => run(['node', 'chunk'], async (node, chunk) => {
          const keep = Math.ceil(size / CHUNK);
          chunk.delete(chunks(sid, keep));
          if (keep) {
            const last = await req(chunk.get([sid, keep - 1])), want = size - (keep - 1) * CHUNK;
            if (last && last.bytes.length > want) chunk.put({ sid, idx: keep - 1, bytes: last.bytes.slice(0, want) });
          }
          const r = await req(node.get(sid));
          if (r) node.put({ ...r, size });
        }),
        label: (label, serial) => run(['volume'], volume => { volume.put({ k: 'label', v: label }); volume.put({ k: 'serial', v: serial }); }),
      },
      registry: {
        load: () => registry,
        op: o => run(['regkey', 'regval'], async (regkey, regval) => {
          if (o.op === 'key') { const old = await req(regkey.get(o.path)), name = (old && old.name) || o.name; regkey.put(name ? { path: o.path, name } : { path: o.path }); }
          else if (o.op === 'set') {
            if (!await req(regkey.get(o.path))) regkey.put({ path: o.path });
            const old = await req(regval.get([o.path, o.name]));
            regval.put({ path: o.path, name: o.name, value: o.value, ord: old && old.ord !== undefined ? old.ord : ++valOrd });
          }
          else if (o.op === 'del') regval.delete([o.path, o.name]);
          else if (o.op === 'delkey') {
            const inside = k => k === o.path || k.startsWith(o.path + '\\');
            for (const k of await req(regkey.getAllKeys())) if (inside(k)) regkey.delete(k);
            for (const k of await req(regval.getAllKeys())) if (inside(k[0])) regval.delete(k);
          }
        }),
      },
    };
  }

  async function load(db) {
    const tx = db.transaction(['node', 'chunk', 'volume', 'regkey', 'regval']);
    const st = n => tx.objectStore(n);
    const rows = await req(st('node').getAll());
    let disk = null;
    if (rows.length) {
      const nodes = [];
      for (const r of rows) {
        const e = { sid: r.sid, parent: r.parent, name: r.name, short: r.short, dir: r.dir, ord: r.ord, attrs: r.attrs,
          ctime: r.ctime, mtime: r.mtime, atime: r.atime };
        if (!r.dir) {
          const data = new Uint8Array(r.size);
          for (const c of await req(st('chunk').getAll(IDBKeyRange.bound([r.sid, 0], [r.sid, Infinity])))) {
            const off = c.idx * CHUNK; if (off < r.size) data.set(c.bytes.subarray(0, r.size - off), off);
          }
          e.data = data;
        }
        nodes.push(e);
      }
      const label = await req(st('volume').get('label')), serial = await req(st('volume').get('serial'));
      disk = { nodes, label: label && label.v, serial: serial && serial.v };
    }
    const keys = await req(st('regkey').getAll()), vals = await req(st('regval').getAll());
    let registry = null;
    if (keys.length) {
      const by = new Map(keys.map(k => [k.path, []])), names = new Map(keys.map(k => [k.path, k.name]));
      // (a key's values in the order they were made, as RegEnumValue gives them: the store keeps them by name)
      vals.sort((a, b) => (a.ord || 0) - (b.ord || 0));
      for (const v of vals) { (by.get(v.path) || by.set(v.path, []).get(v.path)).push([v.name, v.value]); if (v.ord > valOrd) valOrd = v.ord; }
      registry = [...by].map(([path, v]) => [path, v, names.get(path)]);
    }
    return { disk, registry };
  }

  openDb(catalog.current).then(async db => {
    try {
      const { disk, registry } = await load(db), own = host(db, disk, registry);
      // a session shared with others (shared.js): its C: and registry the server's, the rest this browser's (the
      // shares, the computer's name, its kept sessions); with no server answering, this browser's own store
      const S = window.W95Shared;
      window.W95HOST = (S && S.wanted() && S.start(own)) || own;
    } catch (e) { console.error('no persistent store, starting fresh:', e); }
    start();
  }, e => { console.error('no persistent store, starting fresh:', e); start(); });
})();
