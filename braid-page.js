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
  const auto = { timer: null, n: 0, ring: [], every: 0, keep: 3 };
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
    for (const sid of sids) {
      const n = nodes.get(sid);
      if (!n) { for (const st of stores) st.remove(sid); removed++; continue; }
      const st = n.vol.store.under; st.node(nodeRec(n));
      if (!n.dir) { st.size(sid, n.size); if (n.size) st.data(sid, 0, n.buf.slice(0, n.size)); }
      wrote++;
    }
    diskTouched.clear(); fs.version++; ui.dirty();
    return { wrote, removed };
  }

  // ---- anchored moments: IndexedDB, this origin's
  const db = fn => new Promise((ok, no) => { const r = indexedDB.open('w95-braid', 2); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('anchors')) r.result.createObjectStore('anchors', { keyPath: 'name' }); }; r.onsuccess = () => Promise.resolve(fn(r.result)).then(v => { r.result.close(); ok(v); }, e => { r.result.close(); no(e); }); r.onerror = () => no(r.error); });
  const req = (tx, r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const dbGet = name => db(d => req(null, d.transaction('anchors').objectStore('anchors').get(String(name))));
  const dbAll = () => db(d => req(null, d.transaction('anchors').objectStore('anchors').getAll()));
  const dbPut = rec => db(d => new Promise((ok, no) => { const tx = d.transaction('anchors', 'readwrite'); tx.objectStore('anchors').put(rec); tx.oncomplete = () => ok(true); tx.onerror = () => no(tx.error); }));
  const dbDel = name => db(d => new Promise((ok, no) => { const st = d.transaction('anchors', 'readwrite').objectStore('anchors'), g = st.getKey(String(name)); g.onsuccess = () => { if (g.result === undefined) return ok(false); const x = st.delete(String(name)); x.onsuccess = () => ok(true); x.onerror = () => no(x.error); }; g.onerror = () => no(g.error); }));

  // ---- a shared session: this person's marks and travels, to the others, as intents of the session (shared.js)
  const share = op => { if (quiet) return; const S = ui.shared(); if (!S) return; S.intent({ key: op.op === 'mark' ? `braid:mark:${op.name}` : `braid:${op.op}`, kind: 'braid', ...op }); };

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
      const b = await build(); watchStores();
      const S = ui.shared(), at = o.at != null ? o.at : (S && !quiet ? (await clock()) + 200 : null);
      if (at != null && !quiet) share({ op: 'mark', name, at });
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
      if (to && typeof to === 'object' && 't' in to) return scrub(Number(to.t), o);
      const name = String(to), h = here.get(name);
      if (!h) return arrive(name, o);
      const v = line.broken.get(name); if (v === 'broken' && !o.force) throw new Error(`the moment ${name} is a broken state (the lint): travel(name, { force: true }) goes anyway`);
      const why = B.refuse(h.s, await build()); if (why && !(o.force && /build/.test(why))) throw new Error(why);
      const out = {}, now = await clock();
      for (const [k, m] of Object.entries(h.machines)) { if (!m.app.alive) { out[k] = 'gone'; continue; } out[k] = await m.app.cmd('travel', [name]); if (!out[k]) throw new Error(`the machine ${k} refused the moment (see the console)`); forgetKids(m.app); }
      ui.closeMenus();
      const [, sh] = B.restoreGraph(h.s.sections.disk.graph); shellBack(sh);
      W.regLoad(h.s.sections.registry.value, true);
      const disk = writeDisk(false);
      const gen = line.fork(name, o.how || 'travel', { now });
      if (!o.quiet) share({ op: 'travel', name, force: !!o.force });
      ui.emit('braid.travel', { gen, moment: name, fromGen: line.moments.get(name).gen, at: line.moments.get(name).at, how: o.how || 'travel' });
      ui.dirty();
      return { ...out, gen, at: line.moments.get(name).at, disk };
    },
    /** the moment of now anchored on this computer (IndexedDB, this origin's): every machine's bytes and objects by name
     *  and path, the page's disk and shell, the registry, the mods and the line, under a checksum and the build's
     *  signature; marked on the line here as well. Taken at a step with no ring-0 run in flight. The memo's ground: a
     *  page that has it starts there, nothing run again */
    async anchor(name) {
      name = name == null ? autoName() : String(name);
      if (here.has(name) || line.moments.has(name)) throw new Error(`a moment named ${name} is on the line already: an anchor is a moment of now, under a new name`);
      await braid.mark(name);
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
    },
    /** every moment on the line, in machine order: `here` (this page's memory), `anchored` (this computer), the
     *  generation it was taken in, its machine time, the lint's verdict */
    async moments() {
      const by = new Map();
      for (const m of line.moments.values()) by.set(m.name, { ...m, verdict: line.broken.get(m.name) || (m.verdict || 'ok'), here: here.has(m.name), anchored: !!m.anchored });
      for (const x of await dbAll().catch(() => [])) { const w = by.get(x.name); if (w) { w.anchored = true; w.anchorBytes = Object.values(x.machines).reduce((n, m) => n + m.blob.length, x.page.blob.length); } else by.set(x.name, { name: x.name, gen: x.gen, at: x.now, wall: x.at, build: x.build, mods: x.mods, here: false, anchored: true, verdict: 'ok', anchorBytes: Object.values(x.machines).reduce((n, m) => n + m.blob.length, x.page.blob.length) }); }
      return [...by.values()].sort((a, b) => a.at - b.at || a.wall - b.wall);
    },
    /** a moment let go: from this page's memory, from every machine, and from this computer */
    async forget(name, o = {}) {
      name = String(name); const h = here.get(name);
      if (h) for (const m of Object.values(h.machines)) if (m.app.alive) m.app.cmd('forget', [name]);
      const anchored = await dbDel(name).catch(() => false);
      here.delete(name); const was = line.forget(name) || anchored;
      if (!o.quiet && was) share({ op: 'forget', name });
      return was;
    },
    /** the line marking itself as the machine runs: a moment every `ms` (30 s), named t1, t2, ..., the last `keep` (3)
     *  held (one the lint found broken is held beyond them, as the state to travel away from); what a lock-up or a
     *  crash is travelled back from when no one marked a moment before it. every(0) ends it */
    every(ms = 30000, keep = 3) {
      clearTimeout(auto.timer); auto.timer = null; auto.every = ms; auto.keep = keep; if (!ms) return null;
      const tick = async () => {
        if (!auto.timer) return;
        try { const name = 't' + (++auto.n); const r = await braid.mark(name); auto.ring.push(name); const fine = auto.ring.filter(n => (line.broken.get(n) || 'ok') !== 'broken' && !(line.moments.get(n) || {}).anchored); while (fine.length > keep) { const n = fine.shift(); auto.ring.splice(auto.ring.indexOf(n), 1); await braid.forget(n); } if (r.verdict === 'broken') ui.emit('braid.broken', { moment: name, findings: r.findings }); }
        catch (e) { console.warn('[braid] the line could not mark itself:', e.message); }
        if (auto.timer) auto.timer = setTimeout(tick, ms);
      };
      auto.timer = setTimeout(tick, ms); return { every: ms, keep };
    },
    get auto() { return { every: auto.every, keep: auto.keep, moments: auto.ring.slice() }; },
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
      quiet = true;
      try {
        if (i.op === 'mark') await braid.mark(i.name, { at: i.at });
        else if (i.op === 'travel') await braid.travel(i.name, { force: !!i.force, quiet: true });
        else if (i.op === 'scrub') await braid.travel({ t: i.t }, { quiet: true });
        else if (i.op === 'forget') await braid.forget(i.name, { quiet: true });
      } catch (e) { console.warn(`[braid] another person's ${i.op} could not be made here:`, e.message); }
      finally { quiet = false; }
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
    if (!o.quiet) share({ op: 'scrub', t });
    ui.emit('braid.scrub', { t, at: r.at, from: stay ? null : m.name, actions: acts.length });
    return { at: r.at, from: stay ? null : m.name, actions: acts.length, left: !!r.left };
  }
  /** to a moment anchored on this computer: brought into this page's machines (booted: their objects matched by path)
   *  and its disk, shell and registry; the line is the anchored one, the arrival a fork from the moment in it */
  async function arrive(name, o) {
    const rec = await dbGet(name); if (!rec) throw new Error(`no moment ${name}: not on the line here, not anchored on this computer`);
    const b = await build(), why = B.refuseAnchor(rec, b); if (why && !(o.force && /build/.test(why))) throw new Error(why);
    const out = {};
    for (const [k, ex] of Object.entries(rec.machines)) { const a = k === 'system' ? sys() : live().find(x => x.path === k); if (!a) { out[k] = 'no such machine running'; continue; } out[k] = await a.cmd('import', [ex]); forgetKids(a); }
    watchStores(); ui.closeMenus();
    const sh = ui.shell(), r = B.rebind([fs, sh], rec.page, { opaque: opaque(), skip: shellSkip }); shellBack(sh);
    W.regLoad(rec.registry, true);
    const disk = writeDisk(true);
    if (rec.line) Object.assign(line, B.Line.from(rec.line));
    const gen = line.fork(name, 'anchor', { at: rec.now, build: rec.build, forced: rec.build !== b });
    if (line.moments.has(name)) line.moments.get(name).anchored = true;
    ui.emit('braid.travel', { gen, moment: name, at: rec.now, how: 'anchor' });
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

  return braid;
};
})();
