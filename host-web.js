// W95HOST for a plain browser: the same write-through store the Electron app keeps in SQLite (electron/store.js),
// here in IndexedDB. The shell reads its store synchronously at boot, so this loads everything first and then
// starts win95.js. Each write opens its own readwrite transaction as it happens; IndexedDB runs those in the order
// they were opened. In the app the preload has already set W95HOST and this only starts the shell.
(() => {
  const start = () => { const s = document.createElement('script'); s.src = 'win95.js'; s.async = false; document.body.appendChild(s); };
  if (window.W95HOST || !window.indexedDB) return start();

  const CHUNK = 65536;
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const opening = indexedDB.open('win95', 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('node', { keyPath: 'sid' }).createIndex('parent', 'parent');
    db.createObjectStore('chunk', { keyPath: ['sid', 'idx'] });
    db.createObjectStore('volume', { keyPath: 'k' });
    db.createObjectStore('regkey', { keyPath: 'path' });
    db.createObjectStore('regval', { keyPath: ['path', 'name'] });
  };

  function host(db, disk, registry) {
    const run = (stores, fn) => {
      const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
      fn(...stores.map(s => tx.objectStore(s)));
      tx.onerror = () => console.error('store write failed:', tx.error);
    };
    const chunks = (sid, from = 0) => IDBKeyRange.bound([sid, from], [sid, Infinity]);
    return {
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
          else if (o.op === 'set') { if (!await req(regkey.get(o.path))) regkey.put({ path: o.path }); regval.put({ path: o.path, name: o.name, value: o.value }); }
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
      for (const v of vals) (by.get(v.path) || by.set(v.path, []).get(v.path)).push([v.name, v.value]);
      registry = [...by].map(([path, v]) => [path, v, names.get(path)]);
    }
    return { disk, registry };
  }

  opening.onsuccess = async () => {
    try {
      const db = opening.result, { disk, registry } = await load(db);
      window.W95HOST = host(db, disk, registry);
    } catch (e) { console.error('no persistent store, starting fresh:', e); }
    start();
  };
  opening.onerror = () => { console.error('no persistent store, starting fresh:', opening.error); start(); };
})();
