'use strict';
// Ring α ("Braid") on the page: the machines' moments with the page's disk, registry and shell beside them; the line
// they lie on (braid.js Line: generations, forks, machine time); travel along it, to a moment or to a time; moments
// anchored on this computer; the lint over the line; the mods beside it; and, in a shared session, the line shared
// with the other people, who mark and travel together (their marks and travels are intents of the session, made on
// every machine at the same machine time). win95.js makes it once (W95BraidPage(ui)) with what of the shell it needs;
// the API is win95.braid (SCRIPTING.md, Ring α), the Braid window (Run > braid) and CLAUDE.EXE's Braid tool use it.
//
// A moment is taken of every machine running (each worker's cmd 'mark': its memory, registers and objects, at a step),
// then of the page's file system (the volumes' trees, as a graph of its own) and the page's registry. Travel to it puts
// each back as it was then, and writes the disk's store what the tree has then for every node written since, so the
// disk on this computer is the moment's too. A moment is on the line in this page's memory, and anchored on this
// computer (IndexedDB) once `anchor` writes it there: travel reaches either the same way.
(() => {
window.W95BraidPage = function (ui) {
  const B = window.W95Braid, W = ui.W95Win32, fs = ui.fs;
  const here = new Map();                 // the moments in this page's memory, by name: { s: the page's record, machines: { key: { app, info } } }
  const diskTouched = new Set(), mods = [], line = new B.Line();
  const auto = { timer: null, n: 0, ring: [], v: new Map(), hold: null, every: 0, keep: 3, atimer: null, an: 0, anchors: [], anchorEvery: 0, anchorKeep: 3 };
  let anchorBusy = null;   // (the name of the anchor being written, anchor)
  let sig = null, quiet = false, markN = 0;
  const key = a => (a.system ? 'system' : a.path);
  const live = () => ui.machines().filter(a => a.alive);
  const sys = () => { const a = ui.sysApp(); return a && a.alive ? a : null; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /** the build's signature (braid.js BUILD_FILES), fetched once and told to every machine */
  const build = () => sig || (sig = B.buildSignature(f => fetch(f, { cache: 'no-store' }).then(r => r.text())).then(b => { for (const a of live()) a.cmd('build', [b]); return b; }));
  /** the system's machine's own clock (worker.js vclock), ms since its start: the line's time */
  const clock = async () => { const a = sys(); return a ? await a.cmd('now') : 0; };

  // ---- the disk: the volumes' stores, each wrapped once to note the node ids written (what travel writes back); the
  // wrap is the volume's `store` from then on, so a moment's graph keeps it too
  function watchStores() {
    for (const v of fs.vols.values()) {
      const st = v.store; if (!st || st.under) continue;
      const rec = sid => diskTouched.add(sid);
      v.store = { ...st, under: st, node: r => { rec(r.sid); return st.node(r); }, remove: sid => { rec(sid); return st.remove(sid); }, data: (sid, off, b) => { rec(sid); return st.data(sid, off, b); }, size: (sid, n) => { rec(sid); return st.size(sid, n); } };
    }
  }
  const opaque = () => { const o = new Set([fs.uncBackend]); for (const v of [...fs.vols.values(), ...fs.uncs.values()]) { if (v.disc) o.add(v.disc); if (v.remote) o.add(v.remote); if (v.store) o.add(v.store); } o.delete(null); o.delete(undefined); return o; };
  // (a machine's page-side object (its worker, the calls in flight, its rings, its canvases) is the host's live thing, left alone)
  const shellSkip = (o, k) => (o && o.worker instanceof Worker && /^(worker|calls|nextCall|started|ring|rpcSab|lanRing|mem|modeBusy|modeDone|alive|lanStation|lanDetach|kids|kidsAsked|cv|cx|img|d32|ov|ox|oimg|o32|pal|scr|snap)$/.test(k)) || (o === fs && k === 'subs');
  const nodeRec = n => ({ sid: fs.sidOf(n), parent: n.parent ? fs.sidOf(n.parent) : -1, name: n.name, short: n.short, dir: n.dir, ord: n.ord || 0, attrs: n.attrs, ctime: n.ctime, mtime: n.mtime, atime: n.atime });
  /** the disk's store written what the tree has now, for every node written since the last travel (or every node) */
  function writeDisk(all) {
    const nodes = new Map(), stores = []; let wrote = 0, removed = 0;
    for (const v of fs.vols.values()) if (v.store && v.store.under) { stores.push(v.store.under); (function walk(n) { if (n.sid !== undefined || all) nodes.set(fs.sidOf(n), n); if (n.dir) for (const k of n.kids.values()) walk(k); })(v.root); }
    const sids = all ? [...nodes.keys()] : [...diskTouched].sort((a, b) => a - b);
    const put = (n, sid) => { const st = n.vol.store.under; st.node(nodeRec(n)); if (!n.dir) { st.size(sid, n.size); if (n.size) return st.data(sid, 0, all ? n.buf.subarray(0, n.size) : n.buf.slice(0, n.size)); } };
    const later = [];
    for (const sid of sids) {
      const n = nodes.get(sid);
      if (!n) { for (const st of stores) st.remove(sid); removed++; continue; }
      if (all) later.push(sid); else put(n, sid);
      storeSids.add(sid); wrote++;
    }
    // (every node: one file at a time, the next once the store has taken the last. Handed over all at once, as a
    // moment arrived at from its anchor hands the whole disk over, each file's copy waited in the page for its turn in
    // the store: 400 MB of disk held the page at over 2 GB, everything ran slowly, and the tab ran out of memory)
    if (later.length) diskPump = diskPump.then(async () => {
      const now = new Map(); for (const v of fs.vols.values()) if (v.store && v.store.under) (function walk(n) { now.set(fs.sidOf(n), n); if (n.dir) for (const k of n.kids.values()) walk(k); })(v.root);
      for (const sid of later) {
        const n = now.get(sid); if (!n || diskTouched.has(sid)) continue;   // (gone, or written since by its own change)
        try { await put(n, sid); } catch (e) { console.error('[braid] disk store:', e); }
      }
    });
    // (every node: the store then holds this tree and nothing else. A moment's nodes carry the ids of the line that
    // anchored it; written over a store numbered by another line, the store held both trees under one numbering, a
    // folder's id a file's, and the page's next start could not attach it)
    if (all) {
      for (const st of stores) { const held = st.load && st.load(); if (held) for (const e of held.nodes) storeSids.add(e.sid); }
      for (const sid of [...storeSids]) if (!nodes.has(sid)) { for (const st of stores) st.remove(sid); storeSids.delete(sid); removed++; }
    }
    diskTouched.clear(); fs.version++; ui.dirty();
    return { wrote, removed };
  }
  const storeSids = new Set();   // (the node ids this page wrote to the disk's store, beside those it loaded)
  let diskPump = Promise.resolve();   // (the whole-disk writes in turn, writeDisk)

  // ---- anchored moments: IndexedDB, this origin's
  // (an anchor's blobs are kept as chunks shared between anchors, braid.js packAnchor: the record in 'anchors' lists
  // its chunks' hashes, each chunk once in 'chunks' under its hash. A chunk is written only when the store has none
  // under its hash, and letting an anchor go deletes the chunks no anchor left refers to)
  const db = fn => new Promise((ok, no) => { const r = indexedDB.open('w95-braid', 3); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('anchors')) d.createObjectStore('anchors', { keyPath: 'name' }); if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks'); }; r.onsuccess = () => Promise.resolve(fn(r.result)).then(v => { r.result.close(); ok(v); }, e => { r.result.close(); no(e); }); r.onerror = () => no(r.error); });
  const req = (tx, r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const done = tx => new Promise((ok, no) => { tx.oncomplete = () => ok(true); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error || new Error('aborted')); });
  const dbRaw = name => db(d => req(null, d.transaction('anchors').objectStore('anchors').get(String(name))));
  const dbGet = async name => {
    const s = await dbRaw(name); if (!s || !s.packed) return s;
    // (each chunk read as its blob is joined, none kept: every chunk held at once beside the blobs joined from them, an
    // anchor of 430 MB stood in the page twice over, and with the tree and the machine made from it the tab ran out)
    return db(d => B.unpackAnchor(s, h => req(null, d.transaction('chunks').objectStore('chunks').get(h))));
  };
  // (never every record at once: an anchor stored whole, before chunks, is the machines' bytes, 350 to 700 MB, and a
  // getAll over thirteen of them asked the page for 6.7 GB, which paused it on the edge of running out of memory at each
  // anchor (whose names came from it) and each moments(). Names come from the keys; records one at a time, by cursor,
  // each let go before the next, only what is asked kept: `fn(record)` answers what to keep of it)
  const dbNames = () => db(d => req(null, d.transaction('anchors').objectStore('anchors').getAllKeys()));
  const eachIn = (st, fn) => new Promise((ok, no) => { const c = st.openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return ok(); fn(cur.value); cur.continue(); }; c.onerror = () => no(c.error); });
  const dbEach = fn => db(d => { const out = []; return eachIn(d.transaction('anchors').objectStore('anchors'), v => { const x = fn(v); if (x !== undefined) out.push(x); }).then(() => out); });
  const summary = x => ({ name: x.name, gen: x.gen, now: x.now, at: x.at, build: x.build, mods: x.mods, bytes: Object.values(x.machines || {}).reduce((n, m) => n + B.blobLength(m.blob), x.page ? B.blobLength(x.page.blob) : 0) });
  const dbPut = async rec => {
    const { rec: s, chunks } = await B.packAnchor(rec);
    return db(d => { const tx = d.transaction(['anchors', 'chunks'], 'readwrite'), cs = tx.objectStore('chunks');
      for (const [h, b] of chunks) { const g = cs.getKey(h); g.onsuccess = () => { if (g.result === undefined) cs.put(b, h); }; }
      tx.objectStore('anchors').put(s); return done(tx); });
  };
  const dbDel = name => db(async d => {
    const tx = d.transaction(['anchors', 'chunks'], 'readwrite'), st = tx.objectStore('anchors'), cs = tx.objectStore('chunks');
    const had = (await req(null, st.getKey(String(name)))) !== undefined;
    if (had) await req(null, st.delete(String(name)));
    const keep = new Set(); await eachIn(st, v => { for (const h of B.chunkRefs([v])) keep.add(h); });   // (in the same transaction: no anchor written between the count and the deletes)
    const all = await req(null, cs.getAllKeys());
    for (const h of all) if (!keep.has(h)) cs.delete(h);
    await done(tx); return had;
  });

  // ---- a shared session: this person's marks and travels, to the others, as intents of the session (shared.js)
  const share = op => { if (quiet) return; const S = ui.shared(); if (!S) return; S.intent({ key: op.op === 'mark' ? `braid:mark:${op.name}` : `braid:${op.op}`, kind: 'braid', ...op }); };
  // (in a shared session a mark, anchor, travel, scrub or forget is the session's: posted as its intent and made here
  // as it comes back in the op order, with every other machine, so each takes its own moment, or goes back to it, at
  // the same place in the session's history, and the server keeps the session's shared state with it (tools/sessions.py
  // braid). The call resolves with what was made here. `local` keeps one to this machine: the line marking and
  // anchoring itself (every) is each machine's own net)
  const waits = new Map(), waitKey = op => `${op.op}:${op.name != null ? op.name : op.t}`;
  const viaLine = (op, o = {}) => {
    if (quiet || o.local || o.quiet || !ui.shared()) return null;
    return new Promise((ok, no) => { const k = waitKey(op); const w = waits.get(k); if (w) w.no(new Error(`another ${op.op} of ${k} was asked for`)); waits.set(k, { ok, no }); share(op); });
  };

  // ---- the shell's state put back (the windows the page draws, the active one, the menus, the clipboard)
  const shellBack = sh => { ui.setShell(sh); };

  /** the controls the page holds for a machine's windows (win95.js children) are of the time left behind: emptied in
   *  place, so an answer still on its way lands in the map and is asked again at the next look */
  const forgetKids = app => { if (app.kids) { app.kids.clear(); app.kidsAsked.clear(); } };
  /** a moment's name when none is given: m1, m2, ... */
  const autoName = () => `m${++markN}`;

  const braid = {
    /** a moment of everything, by name (m<n> when none), now: the machines first (each at a step), then the page's
     *  disk, registry and shell. In a shared session, at a machine time 200 ms ahead, which every machine marks at as
     *  its own clock reaches it (the same state everywhere). Linted against the moment before it on the line. Resolves
     *  with what was taken (bytes, the build signature, the sum, the lint's verdict) */
    async mark(name, o = {}) {
      name = name == null ? autoName() : String(name);
      if (here.has(name)) throw new Error(`a moment named ${name} is on the line already`);
      const v = viaLine({ op: 'mark', name }, o); if (v) return v;
      const b = await build(); watchStores();
      const at = o.at != null ? o.at : null;
      const machines = {};
      for (const a of live()) { const r = await (a.system && at != null ? a.cmd('markAt', [name, at]) : a.cmd('mark', [name])); if (!r) throw new Error(`the machine ${key(a)} took no moment (inside a call: try again)`); machines[key(a)] = { app: a, info: r }; }
      ui.closeMenus();
      const graph = B.takeGraph([fs, ui.shell()], { opaque: opaque(), skip: shellSkip });
      const now = machines.system ? machines.system.info.now : 0;
      const s = B.make({ disk: { kind: 'graph', graph }, registry: { kind: 'json', value: W.regDump() } }, { name, build: b, now, mods: mods.map(m => `${m.name}@${m.sum}`) });
      here.set(name, { s, machines });
      const bytes = s.bytes + Object.values(machines).reduce((n, m) => n + (m.info.bytes || 0), 0);
      const d = line.took({ name, at: now, sum: s.sum, build: b, mods: mods.slice(), bytes });
      // (the lint: this moment against the one before it on the line, when the system's machine still has both)
      let findings = null;
      const prev = line.along().filter(m => m.name !== name && m.at <= d.at).pop();
      if (prev && here.has(prev.name) && machines.system) {
        findings = await machines.system.app.cmd('lint', [prev.name, name]).catch(() => null);
        if (findings) { const v = B.verdict(findings); d.verdict = v; if (v !== 'ok') line.broken.set(name, v); ui.emit('braid.lint', { moment: name, from: prev.name, verdict: v, findings }); }
      }
      ui.emit('braid.mark', { name, at: now, gen: line.gen, verdict: d.verdict || 'ok' });
      return { ...B.describe(s), gen: d.gen, bytes, verdict: d.verdict || 'ok', findings, machines: Object.fromEntries(Object.entries(machines).map(([k, m]) => [k, m.info])) };
    },
    /** to a moment, by name, or to a time on the line ({ t }: the moment at or before it, then the run from there to
     *  it, fast, with the journal's actions made again at their times). Back or ahead, in any generation: the machines
     *  first, then the page's disk, registry and shell, then the disk's store. The input waiting is dropped; the
     *  machine's clock reads the moment's time. A moment anchored on this computer and not in this page's memory is
     *  arrived at in the page's machines, booted as they are, by the paths of their objects (braid.js rebind). Refused
     *  for a damaged moment (checksum), one of another build (unless `force`), or one the lint found broken (unless
     *  `force`: a broken state is what one travels away from). Travel forks the line: the new generation grows from
     *  the moment; the one left runs no further, its moments stay */
    async travel(to, o = {}) {
      if (to && typeof to === 'object' && 't' in to) { const v = viaLine({ op: 'scrub', t: Number(to.t) }, o); return v || scrub(Number(to.t), o); }
      const name = String(to), h = here.get(name);
      const asked = viaLine({ op: 'travel', name, force: !!o.force }, o); if (asked) return asked;
      if (!h) return arrive(name, o);
      // (the system's machine the moment is in has ended, its worker with it: the moment is gone from here. Its anchor
      // comes back; without one, refused: a travel that skipped it as 'gone' ran nothing and said it had arrived)
      if (h.machines.system && !h.machines.system.app.alive) {
        if ((await dbNames().catch(() => [])).includes(name)) return arrive(name, o);
        throw new Error(`the moment ${name} was in the system's machine, which ended: it went with it (an anchored moment comes back)`);
      }
      const v = line.broken.get(name); if (v === 'broken' && !o.force) throw new Error(`the moment ${name} is a broken state (the lint): travel(name, { force: true }) goes anyway`);
      const why = B.refuse(h.s, await build()); if (why && !(o.force && /build/.test(why))) throw new Error(why);
      const out = {}, now = await clock();
      // (a machine that no longer holds the moment, its worker started again since (Setup's restart: the moment taken as
      // Windows 98's VMM loaded, w98-windows), has it from its anchor, as an ended one does)
      const held = await Promise.all(Object.values(h.machines).map(m => (m.app.alive ? m.app.cmd('moments').then(l => (l || []).some(x => x.name === name), () => false) : true)));
      if (held.includes(false) && (await dbNames().catch(() => [])).includes(name)) return arrive(name, o);
      for (const [k, m] of Object.entries(h.machines)) { if (!m.app.alive) { out[k] = 'gone'; continue; } out[k] = await m.app.cmd('travel', [name]); if (!out[k]) throw new Error(`the machine ${k} refused the moment (see the console)`); forgetKids(m.app); }
      ui.closeMenus();
      const [, sh] = B.restoreGraph(h.s.sections.disk.graph); shellBack(sh);
      W.regLoad(h.s.sections.registry.value, true);
      const disk = writeDisk(false);
      const gen = line.fork(name, o.how || 'travel', { now });
      ui.emit('braid.travel', { gen, moment: name, fromGen: line.moments.get(name).gen, at: line.moments.get(name).at, how: o.how || 'travel' });
      ui.dirty();
      return { ...out, gen, at: line.moments.get(name).at, disk };
    },
    /** the moment of now anchored on this computer (IndexedDB, this origin's): every machine's bytes and objects by name
     *  and path, the page's disk and shell, the registry, the mods and the line, under a checksum and the build's
     *  signature; marked on the line here as well. Taken at a step with no ring-0 run in flight. The memo's ground: a
     *  page that has it starts there, nothing run again */
    async anchor(name, o = {}) {
      if (name == null) name = autoName();
      const v = viaLine({ op: 'anchor', name: String(name) }, o); if (v) return v;
      // (one anchor at a time: the moment it marks is a braid.mark like any, and a listener that anchors on marks
      // anchored again from inside this one, each a moment of 300 MB under a name grown by its prefix, until this
      // computer's store held gigabytes)
      if (anchorBusy) throw new Error(`an anchor (${anchorBusy}) is being written: one at a time`);
      anchorBusy = name == null ? 'unnamed' : String(name);
      try {
      name = name == null ? autoName() : String(name);
      // (a name already on the line or on this computer: the moment of now takes the next free one, name-2, name-3, ...;
      // the earlier moment keeps its own)
      const taken = new Set([...here.keys(), ...line.moments.keys(), ...(await dbNames().catch(() => []))]);
      if (taken.has(name)) { let i = 2; while (taken.has(`${name}-${i}`)) i++; name = `${name}-${i}`; }
      await braid.mark(name, { local: true });   // (the anchor's own moment: made here; the anchor is the session's already when it is)
      const b = await build(), machines = {};
      for (const a of live()) {
        let ex = null; for (let i = 0; i < 400 && !(ex && ex.meta); i++) { ex = await a.cmd('export'); if (ex && ex.busy) await sleep(50); }
        if (!ex || !ex.meta) throw new Error('the anchor was refused: ' + (ex && ex.busy ? 'a ring-0 run in flight on every step' : 'inside a call: try again'));
        machines[key(a)] = ex;
      }
      ui.closeMenus();
      const page = B.serialize(B.takeGraph([fs, ui.shell()], { opaque: opaque(), skip: shellSkip }));
      const m = line.moments.get(name), now = machines.system ? machines.system.now : (m ? m.at : 0);
      if (m) m.anchored = true;
      const rec = B.anchor({ name, now, gen: line.gen, build: b, mods: mods.slice(), machines, page: { meta: page.meta, roots: page.roots, blob: page.blob }, registry: W.regDump(), line: line.toJSON() });
      await dbPut(rec);
      const bytes = Object.values(machines).reduce((n, x) => n + x.blob.length, page.blob.length);
      ui.emit('braid.anchor', { name, bytes, sum: rec.sum });
      return { name, bytes, build: b, sum: rec.sum, at: now };
      } finally { anchorBusy = null; }
    },
    /** every moment on the line, in machine order: `here` (this page's memory), `anchored` (this computer), the
     *  generation it was taken in, its machine time, the lint's verdict */
    async moments() {
      const by = new Map();
      for (const m of line.moments.values()) by.set(m.name, { ...m, verdict: line.broken.get(m.name) || (m.verdict || 'ok'), here: here.has(m.name), anchored: !!m.anchored });
      for (const x of await dbEach(summary).catch(() => [])) { const w = by.get(x.name); if (w) { w.anchored = true; w.anchorBytes = x.bytes; } else by.set(x.name, { name: x.name, gen: x.gen, at: x.now, wall: x.at, build: x.build, mods: x.mods, here: false, anchored: true, verdict: 'ok', anchorBytes: x.bytes }); }
      return [...by.values()].sort((a, b) => a.at - b.at || a.wall - b.wall);
    },
    /** a moment let go: from this page's memory, from every machine, and from this computer */
    async forget(name, o = {}) {
      name = String(name);
      const v = viaLine({ op: 'forget', name }, o); if (v) return v;
      const h = here.get(name);
      if (h) for (const m of Object.values(h.machines)) if (m.app.alive) m.app.cmd('forget', [name]);
      const anchored = await dbDel(name).catch(() => false);
      here.delete(name); const was = line.forget(name) || anchored;
      return was;
    },
    /** the line marking itself as the machine runs: a moment every `ms` (30 s), named t1, t2, ..., the last `keep` (3)
     *  held (one the lint found broken is held beyond them, as the state to travel away from); what a lock-up or a
     *  crash is travelled back from when no one marked a moment before it. And anchored on this computer every
     *  `o.anchorEvery` ms (5 min), live1, live2, ..., the last `o.anchorKeep` (3) kept, a broken one held beyond them:
     *  the marks live in the page's memory and a reload loses them, the anchors do not, so a running line is never
     *  more than anchorEvery from a moment a reloaded page travels to. An older anchor is let go only after a newer
     *  one is written. every(0) ends both; anchorEvery 0, the anchoring alone */
    every(ms = 30000, keep = 3, o = {}) {
      clearTimeout(auto.timer); auto.timer = null; auto.every = ms; auto.keep = keep;
      clearTimeout(auto.atimer); auto.atimer = null; auto.anchorEvery = ms ? (o.anchorEvery === undefined ? 300000 : o.anchorEvery) : 0; auto.anchorKeep = o.anchorKeep || 3;
      if (!ms) return null;
      const anchorTick = async () => {
        if (!auto.atimer) return; const run = auto.atimer;
        try {
          const r = await braid.anchor('live' + (++auto.an), { local: true }); auto.anchors.push(r.name);
          if (auto.atimer !== run) return;   // (stopped meanwhile: no anchor let go)
          const fine = auto.anchors.filter(n => (line.broken.get(n) || 'ok') !== 'broken');
          while (fine.length > auto.anchorKeep) { const n = fine.shift(); auto.anchors.splice(auto.anchors.indexOf(n), 1); await braid.forget(n, { local: true }); }
        } catch (e) { console.warn('[braid] the line could not anchor itself:', e.message); }   // (another anchor being written, a ring-0 run on every step: the next tick)
        if (auto.atimer) auto.atimer = setTimeout(anchorTick, auto.anchorEvery);
      };
      if (auto.anchorEvery) auto.atimer = setTimeout(anchorTick, auto.anchorEvery);
      const tick = async () => {
        if (!auto.timer) return; const run = auto.timer;
        // (a line stopped or started again while this mark was taken lets nothing go: the stop is to keep what it has;
        // and the last clean moment before the latest suspect or broken one stays: the one before a fault to travel to,
        // as moments after the fault lint clean again against each other)
        try { const name = 't' + (++auto.n); const r = await braid.mark(name, { local: true }); auto.ring.push(name); auto.v.set(name, r.verdict || 'ok'); if (auto.timer !== run) return; const v = n => line.broken.get(n) || auto.v.get(n) || 'ok'; if (v(name) !== 'ok') auto.hold = auto.ring.slice(0, -1).filter(n => v(n) === 'ok').pop() || auto.hold; const hold = auto.hold; const fine = auto.ring.filter(n => n !== hold && v(n) !== 'broken' && !(line.moments.get(n) || {}).anchored); while (fine.length > keep) { const n = fine.shift(); auto.ring.splice(auto.ring.indexOf(n), 1); auto.v.delete(n); await braid.forget(n, { local: true }); } if (r.verdict === 'broken') ui.emit('braid.broken', { moment: name, findings: r.findings }); }
        catch (e) { console.warn('[braid] the line could not mark itself:', e.message); }
        if (auto.timer) auto.timer = setTimeout(tick, ms);
      };
      auto.timer = setTimeout(tick, ms); return { every: ms, keep, anchorEvery: auto.anchorEvery, anchorKeep: auto.anchorKeep };
    },
    get auto() { return { every: auto.every, keep: auto.keep, moments: auto.ring.slice(), anchorEvery: auto.anchorEvery, anchorKeep: auto.anchorKeep, anchors: auto.anchors.slice() }; },
    /** the system's machine between two moments (or a moment and now): the lint's findings and their verdict (broken,
     *  suspect, ok). The signs of a machine that will not come back: the Win16Lock held by one thread across both, a
     *  thread at the same place with its time running out each slice, a ring-0 run at the same place, faults since, the
     *  process ended, a heap or a queue only growing. Heuristics: the halting problem allows no proof */
    async lint(a, b) {
      const s = sys(); if (!s) return null;
      const findings = await s.cmd('lint', b === undefined ? [String(a)] : [String(a), String(b)]);
      return { verdict: B.verdict(findings), findings };
    },
    /** the system's machine run ahead of the wall by `x` (its steps back to back, each x periods of its own clock):
     *  the waits on time pass x times faster than real time; 1 is a person's pace again. Answers { scale, now } */
    speed: x => { const s = sys(); return s ? s.cmd('speed', [x]) : Promise.resolve(null); },
    /** the machine's own clock, ms since its start: the line's time */
    now: () => clock(),
    get build() { return build(); },
    /** the line: its generation now, every fork (the moment and generation it grew from, how: travel, scrub, memo,
     *  anchor), every moment (with the lint's verdict), the segments between moments with how many actions each, the
     *  faults written to it, and the journal since the last moment */
    get line() { return line.describe(); },
    /** the journal: every action made through the API since the last moment, stamped with the machine's clock, and
     *  the segments closed between moments (each pair of moments with the actions between them) */
    get journal() { return { from: line.j.from, actions: line.j.actions.slice(), segments: line.segments.map(s => ({ ...s, actions: s.actions.slice() })) }; },
    /** a span already computed: the segment from the moment the line is at whose actions are these ([[op, args], ...],
     *  as the journal has them) and whose end is a moment on the line. The line travels to its end and the work
     *  between is not done again (PIDGEN's key check, Setup's copy): { from, to, ms, gen }, or null when there is none */
    async memo(actions) {
      const seg = line.memo(actions); if (!seg) return null;
      const r = await braid.travel(seg.to, { how: 'memo' });
      return { memo: true, from: seg.from, to: seg.to, ms: seg.at1 - seg.at0, ...r };
    },
    /** the moments on the lineage the line is on, in machine order, with their verdicts: where travel back goes */
    along() { return line.along().map(m => ({ ...m, verdict: line.broken.get(m.name) || m.verdict || 'ok' })); },
    /** actions made in `fn` go to no journal: what must not be on the line (a product key typed) */
    async hush(fn) { const was = quiet; quiet = true; try { return await fn(); } finally { quiet = was; } },
    /** the scripts loaded over the running machine since the page's start: { name, sum } each (braid.js mod), named
     *  beside every moment marked from then on; never carried in one */
    get mods() { return mods.slice(); },
    modded(rec) { mods.push(rec); ui.emit('braid.mod', rec); return rec; },
    /** an action of the API's into the journal, with the machine's clock (asked of the machine, written when it answers) */
    note(op, args) {
      if (quiet) return;
      const a = { op, args: args.map(x => (x && typeof x === 'object' && !(x instanceof RegExp) ? { name: x.name, role: x.role, window: x.window instanceof RegExp ? String(x.window) : x.window } : x instanceof RegExp ? String(x) : x)), t: Date.now(), at: null };
      line.note(a); const s = sys(); if (s) s.cmd('now').then(n => { a.at = n; });
    },
    /** a fault a machine reported, on the line under its generation, with the machine's record of it (win32.js
     *  faultInfo) and its fault log then */
    fault(app, f, fatal) {
      const ev = line.event({ t: Date.now(), machine: key(app), fatal, fault: f, faults: null });
      const tell = () => ui.emit('braid.fault', { gen: ev.gen, machine: ev.machine, fault: f, faults: ev.faults, index: line.events.length - 1 });
      if (app.alive) app.cmd('faults').then(l => { ev.faults = l; tell(); }, tell); else tell();
    },
    /** two faults of the line compared record for record (by index into line.events, or { gen } for a generation's
     *  last): the same exception at the same place on the same thread with the same stack words and the same path, or
     *  where they part */
    same(a, b) {
      const ev = x => (typeof x === 'number' ? line.events[x] : line.events.filter(e => e.gen === x.gen).slice(-1)[0]);
      const A = ev(a), Bv = ev(b); if (!A || !Bv) return { same: false, why: 'no such fault on the line' };
      const diff = [], fa = A.fault || {}, fb = Bv.fault || {};
      for (const k of ['why', 'at', 'module', 'ring', 'thread', 'cr2', 'from', 'esp', 'ss']) if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) diff.push({ what: k, a: fa[k], b: fb[k] });
      for (const k of Object.keys({ ...(fa.regs || {}), ...(fb.regs || {}) })) if ((fa.regs || {})[k] !== (fb.regs || {})[k]) diff.push({ what: 'reg ' + k, a: (fa.regs || {})[k], b: (fb.regs || {})[k] });
      const sa = fa.stack || [], sb = fb.stack || []; for (let i = 0; i < Math.max(sa.length, sb.length); i++) if (sa[i] !== sb[i]) diff.push({ what: 'stack ' + i, a: sa[i], b: sb[i] });
      const la = (A.faults || []).filter(x => x.thread !== 'host').slice(-1)[0] || {}, lb = (Bv.faults || []).filter(x => x.thread !== 'host').slice(-1)[0] || {};
      for (const k of ['why', 'thread', 'from', 'fromIn', 'at', 'esp', 'ss']) if (JSON.stringify(la[k]) !== JSON.stringify(lb[k])) diff.push({ what: 'log ' + k, a: la[k], b: lb[k] });
      for (const k of ['path', 'stack']) { const pa = la[k] || [], pb = lb[k] || []; for (let i = 0; i < Math.max(pa.length, pb.length); i++) if (pa[i] !== pb[i]) diff.push({ what: `log ${k} ${i}`, a: pa[i], b: pb[i] }); }
      return { same: !diff.length, gens: [A.gen, Bv.gen], diff };
    },
    /** another person's mark or travel (an intent of the session, kind 'braid'), made here: a mark at the machine time
     *  they named, a travel to the moment they named, a scrub to the time */
    async remote(i) {
      // (anyone's, this person's own too: made here as it reaches this machine in the session's op order; the call
      // that asked for it here, if this person's, resolves with what was made, viaLine)
      const k = waitKey(i), w = waits.get(k); waits.delete(k);
      const L = { local: true };
      try {
        let r;
        if (i.op === 'mark') r = await braid.mark(i.name, { ...L, at: i.at });
        else if (i.op === 'anchor') r = await braid.anchor(i.name, L);
        else if (i.op === 'travel') r = await braid.travel(i.name, { ...L, force: !!i.force });
        else if (i.op === 'scrub') r = await braid.travel({ t: i.t }, L);
        else if (i.op === 'forget') r = await braid.forget(i.name, L);
        if (w) w.ok(r);
      } catch (e) { if (w) w.no(e); else console.warn(`[braid] another person's ${i.op} could not be made here:`, e.message); }
    },
    /** the Braid window: the line as a slider, the moments as ticks (coloured by the lint), the forks, the thumb at
     *  now; drag it to travel to a time, click a tick to travel to its moment; Mark, Anchor, Lint, the line marking itself */
    window() { return braidWindow(); },
    /** the API's calls the journal keeps */
    actions: ['click', 'dblclick', 'type', 'key', 'run', 'drag', 'open'],
  };

  /** to machine time t: the moment at or before it on the lineage (unless the line is between it and t already), then
   *  the machine run fast to t with the journal's actions made again as its clock reaches each one's time */
  async function scrub(t, o) {
    if (!(t >= 0)) throw new Error('travel({ t }): a machine time, ms');
    const s = sys(); if (!s) throw new Error('no system machine');
    const now = await clock(), place = line.at(t);
    if (!place) throw new Error(`no moment on the line at or before ${t} ms`);
    const m = place.moment, own = place.gen === line.gen;
    const stay = own && now <= t && line.before(now) && line.before(now).name === m.name;   // (between the moment and t already: run on from here)
    // (the actions on the way: this lineage's between the moment and t, or those of the generation left behind whose run t is in)
    const acts = own ? line.actionsBetween(stay ? now : m.at, t) : line.actionsBetween(m.at, t, place.gen);
    if (!stay) await braid.travel(m.name, { ...o, how: 'scrub', quiet: true });
    const done = s.cmd('until', [t, o.speed || 8]); let over = false; done.then(() => { over = true; }, () => { over = true; });
    let i = 0;
    while (!over && i < acts.length) {
      const at = await s.cmd('now');
      while (i < acts.length && acts[i].at <= at) { const a = acts[i++]; quiet = true; try { await ui.script[a.op](...a.args); } catch (e) { console.warn('[braid] an action on the way could not be made again:', e.message); } finally { quiet = false; } }
      await sleep(20);
    }
    const r = await done;
    ui.emit('braid.scrub', { t, at: r.at, from: stay ? null : m.name, actions: acts.length });
    return { at: r.at, from: stay ? null : m.name, actions: acts.length, left: !!r.left };
  }
  /** to a moment anchored on this computer: brought into this page's machines (booted: their objects matched by path)
   *  and its disk, shell and registry; the line is the anchored one, the arrival a fork from the moment in it */
  async function arrive(name, o) {
    const rec = await dbGet(name); if (!rec) throw new Error(`no moment ${name}: not on the line here, not anchored on this computer`);
    const b = await build(), why = B.refuseAnchor(rec, b); if (why && !(o.force && /build/.test(why))) throw new Error(why);
    const out = {};
    // (the system's machine the page starts as something needs it: a moment with one, arrived at in a page that has
    // none yet, starts it first, booted, then brings the moment into it; the moment's page is not arrived at into a
    // page with no machine for it, which left the line at the moment and the machines where they were)
    // (booted on the moment's own disk, brought into the page's tree and its store first: the store held another
    // generation's disk, the one Windows 98 Setup's restart left half renamed (Windows 95's GDI.EXE and USER.EXE beside
    // Windows 98's GDI32 and USER32), and the boot on it died in GDI's LibEntry, leaving no machine to arrive in. The
    // shell is left as it is: the record's shell comes in with the rest below)
    if (rec.machines.system && !sys()) { B.rebind([fs, {}], rec.page, { opaque: opaque(), skip: shellSkip }); writeDisk(true); }
    for (const [k, ex] of Object.entries(rec.machines)) { const a = k === 'system' ? (sys() || await ui.startSystem()) : live().find(x => x.path === k); if (!a) throw new Error(`no machine running for the moment's ${k}`); out[k] = await a.cmd('import', [ex]); ex.blob = null; forgetKids(a); }
    watchStores(); ui.closeMenus();
    // (the shell's windows are not rebound: a machine's windows come from its next frame, as they are its own, and a
    // window of the page's is code the record cannot carry. Matched by position to the booted shell's windows, the
    // record's windows took over those objects (the Welcome window drew the CD's folder) and the rest were made with
    // no procedure to draw them)
    const sh = ui.shell(), own = ['windows', 'tasks', 'modals', 'active', 'menus', 'menuSrc', 'cap', 'drag', 'ghost', 'msgApp'], kept = Object.fromEntries(own.map(k => [k, sh[k]]));
    const r = B.rebind([fs, sh], rec.page, { opaque: opaque(), skip: (o, k) => shellSkip(o, k) || (o === sh && own.includes(k)) });
    const recWins = Array.isArray(sh.windows) ? sh.windows : [], recActive = sh.active;   // (the record's windows, made anew: their fields, not their code)
    Object.assign(sh, kept); shellBack(sh);   // (rebind gives the record's own of what it did not find live: the shell's are put back)
    // the machines' windows as the record has them, placed as a frame's list would place them (a machine that holds
    // its Win16Lock, as a task mid-way does, sends no list until the lock is let go: the page would show none of its
    // windows meanwhile); the booted machines' windows the record has not are closed on the page
    const appOf = a => a && (a.system ? sys() : live().find(x => x.path === a.path));
    const placed = new Set(); let act = null;
    for (const w of recWins) {
      const a = w && w.native && appOf(w.app); if (!a) continue;
      const n = { key: w.hwnd, hwnd: w.guestHwnd, x: w.x, y: w.y, w: w.w, h: w.h, title: w.title, cls: w.cls, iconic: !!w.min, modal: !!w.nativeModal, ex: w.transparent ? 0x20 : 0, ownerPid: w.ownerPid, win32: w.win32, parent: w.guestParent, preview: w.preview };
      const nw = ui.adoptNative(a, n, { noTask: !!w.noTask, minimizable: !w.noTask }); placed.add(nw); if (w === recActive) act = nw;
    }
    for (const w of [...ui.windows()]) if (w.native && [sys(), ...live()].includes(w.app) && !placed.has(w)) ui.closeWin(w, true);
    if (act) ui.setActive(act);
    r.placed = placed.size;
    W.regLoad(rec.registry, true);
    const disk = writeDisk(true);
    if (rec.line) Object.assign(line, B.Line.from(rec.line));
    const gen = line.fork(name, 'anchor', { at: rec.now, build: rec.build, forced: rec.build !== b });
    if (line.moments.has(name)) line.moments.get(name).anchored = true;
    ui.emit('braid.travel', { gen, moment: name, at: rec.now, how: 'anchor' });
    // (a moment with no system's machine, taken as the PC booted (Setup's restart: w98-reboot, w98-windows): the PC
    // boots again on the moment's disk, the page's own machine ended. Left booting, the page's PC read the disk the
    // arrival wrote under it and never reached Windows)
    if (!rec.machines.system && ui.pcBoot) { const s = sys(); if (s && s.alive) s.exited(0); ui.pcBoot(); }
    ui.dirty();
    return { ...out, page: r, gen, at: rec.now, disk };
  }

  // ---- the Braid window: the line as a slider
  function braidWindow() {
    const open = ui.windows().find(w => w.title === 'Braid'); if (open) { ui.activate(open); return open; }
    const G = ui.gfx, K = G.K, WIDTH = 440;
    let win, now = 0, drag = null, hover = null, busy = false, people = 0;
    const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const geom = a => ({ x0: a.x + 8, x1: a.x + a.w - 8, y: a.y + 22 });
    const extent = () => { const e = line.extent(now) || { lo: 0, hi: Math.max(1, now) }; if (e.hi - e.lo < 1000) e.hi = e.lo + 1000; return e; };
    const xOf = (a, t) => { const g = geom(a), e = extent(); return Math.round(g.x0 + (t - e.lo) * (g.x1 - g.x0) / (e.hi - e.lo)); };
    const tOf = (a, x) => { const g = geom(a), e = extent(); return e.lo + Math.max(0, Math.min(1, (x - g.x0) / (g.x1 - g.x0))) * (e.hi - e.lo); };
    const colour = v => (v === 'broken' ? '#800000' : v === 'suspect' ? '#808000' : '#008000');
    const status = { type: 'label', text: '', x: 12, y: 92, w: WIDTH - 24 };
    const track = {
      type: 'custom', x: 12, y: 28, w: WIDTH - 24, h: 56, key: () => false,
      draw(a, foc) {
        const g = geom(a), e = extent(), along = line.along();
        G.fill(g.x0, g.y - 1, g.x1 - g.x0, 1, K.sh); G.fill(g.x0, g.y, g.x1 - g.x0, 1, K.dk); G.fill(g.x0, g.y + 1, g.x1 - g.x0, 1, K.hl);   // (the groove)
        // (the generations left: their moments past the fork, greyed; the lineage's moments as ticks, coloured by the lint)
        for (const m of line.moments.values()) { const on = along.includes(m), x = xOf(a, m.at), v = line.broken.get(m.name) || m.verdict || 'ok'; G.fill(x, g.y - (on ? 9 : 5), on ? 2 : 1, on ? 18 : 10, on ? colour(v) : K.sh); if (m.anchored) G.fill(x - 2, g.y + 11, on ? 6 : 5, 2, on ? colour(v) : K.sh); }
        for (const f of line.forks) if (f.gen) { const x = xOf(a, f.at); G.fill(x - 3, g.y - 14, 7, 1, K.dk); G.fill(x - 2, g.y - 13, 5, 1, K.dk); G.fill(x - 1, g.y - 12, 3, 1, K.dk); G.fill(x, g.y - 11, 1, 1, K.dk); }   // (a fork: a wedge)
        const tx = drag ? drag.x : xOf(a, now); G.btnUp(tx - 5, g.y - 10, 11, 21); if (foc) G.focusRect(tx - 3, g.y - 8, 7, 17);   // (the thumb: now, or where it is dragged)
        G.text(fmt(e.lo), g.x0, g.y + 16, K.dk); const r = fmt(e.hi); G.text(r, g.x1 - G.textW(r), g.y + 16, K.dk);
        const label = drag ? fmt(tOf(a, drag.x)) : hover ? `${hover.name}  ${fmt(hover.at)}  ${line.broken.get(hover.name) || hover.verdict || 'ok'}` : `now ${fmt(now)}  generation ${line.gen}${people > 1 ? `  ${people} people` : ''}`;
        G.text(label, a.x + ((a.w - G.textW(label)) >> 1), g.y + 16, K.dk);
      },
      down(x, y, btn, dbl, a) {
        if (busy) return null;
        const g = geom(a), tx = xOf(a, now);
        if (Math.abs(x - tx) <= 6 && Math.abs(y - g.y) <= 11) { drag = { x }; return { move: mx => { drag.x = Math.max(g.x0, Math.min(g.x1, mx)); ui.dirty(); }, up: mx => { const t = tOf(a, Math.max(g.x0, Math.min(g.x1, mx))); drag = null; go(() => braid.travel({ t }), `travel to ${fmt(t)}`); } }; }
        const m = near(a, x); if (m) go(() => braid.travel(m.name), `travel to ${m.name}`);
        return null;
      },
    };
    const near = (a, x) => { let best = null; for (const m of line.moments.values()) { const d = Math.abs(xOf(a, m.at) - x); if (d <= 4 && (!best || d < best.d)) best = { m, d }; } return best ? best.m : null; };
    const go = (f, what) => { busy = true; status.text = `${what}...`; ui.dirty(); Promise.resolve().then(f).then(r => { status.text = `${what}: ${r && r.verdict ? r.verdict : 'done'}`; }, e => { status.text = `${what}: ${e.message}`; ui.msgBox('Braid', e.message, 'error'); }).finally(() => { busy = false; refresh(); }); };
    const everyBox = { type: 'check', label: '&Every 30 s', checked: !!auto.timer, x: 12, y: 116, onChange: () => braid.every(everyBox.checked ? 30000 : 0) };
    const buttons = [
      { type: 'button', label: '&Mark', x: WIDTH - 12 - 4 * 80, y: 112, w: 75, h: 23, def: true, fn: () => go(() => braid.mark(), 'mark') },
      { type: 'button', label: '&Anchor', x: WIDTH - 12 - 3 * 80, y: 112, w: 75, h: 23, fn: () => go(() => braid.anchor(), 'anchor') },
      { type: 'button', label: '&Lint', x: WIDTH - 12 - 2 * 80, y: 112, w: 75, h: 23, fn: () => { const along = line.along(); const last = along[along.length - 1]; if (!last) return ui.msgBox('Braid', 'No moment on the line yet.', 'info'); go(() => braid.lint(last.name).then(r => { ui.msgBox('Braid', r ? `${last.name} to now: ${r.verdict}\n\n${r.findings.map(f => `${f.level}: ${f.what}`).join('\n') || 'nothing to say'}` : 'No machine.', 'info'); return r; }), `lint ${last.name}`); } },
      { type: 'button', label: 'Close', x: WIDTH - 12 - 80, y: 112, w: 75, h: 23, cancel: true, fn: () => ui.closeWin(win) },
    ];
    const refresh = async () => { if (!ui.windows().some(w => w.title === 'Braid')) { clearInterval(timer); return; } now = await clock(); const S = ui.shared(); people = S ? S.people().length : 0; everyBox.checked = !!auto.timer; ui.dirty(); };
    win = ui.dialog('Braid', WIDTH, 146, [
      { type: 'label', text: 'The line: every moment on it, the forks, and now. Drag the thumb to a time, or click a moment, to travel there.', x: 12, y: 8, w: WIDTH - 24 },
      track, status, everyBox, ...buttons,
    ], { modal: false, noTask: false });
    const timer = setInterval(refresh, 500); refresh();
    if (win && win.body) win.body.onClose = () => clearInterval(timer);
    return win;
  }

  braid.__test = { dbPut, dbGet, dbDel, dbNames, dbEach, summary };   // (the store, for tests/braidchunks.test.mjs)
  return braid;
};
})();
