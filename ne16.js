'use strict';
// 16-bit Windows personality for recompiled NE modules (GDI.EXE, DIBENG.DLL, the display driver).
// Segments live in the flat guest memory; selectors resolve through an LDT image at LDT_BASE that the
// recompiled code reads on every segment register load. KERNEL is implemented here (as Wine does);
// everything else is the original 16-bit code. Also provides the KERNEL32 flat-thunk entry points that
// GDI32.DLL uses to reach GDI.EXE and back.
(() => {
const { Process, API, LAYOUT, GuestError, YIELD } = window.W95Win32;
const P = Process.prototype;

const L = {
  LDT: 0x30000, ACC: 0x40000,                      // {base, limit} per selector; access rights at +0x10000
  FLATDS: 0x000F, FLATCS: 0x0017, SENT: 0x001F,    // fixed selectors (SENT: far returns here end a call16)
  STK: 0x0027, NSTK: 24,                           // 16-bit stack aliases of the flat stack, one per nesting level
  DYN: 0x400,                                      // first LDT index handed out dynamically
  THSEL: 0xFFF7, T16: 0xFFFE0000, INT: 0xFFFD0000,
};
const u32 = v => v >>> 0;
const SEGS = [['cs', 'csb'], ['ds', 'dsb'], ['es', 'esb'], ['ss', 'ssb'], ['fsel', 'fs'], ['gsel', 'gsb']];
const GPR = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const lo16 = (r, v) => (r & ~0xffff) | (v & 0xffff);

// ---------------------------------------------------------------- selectors
P.init16 = function () {
  if (this.selUsed) return;
  this.selUsed = new Uint8Array(8192); this.selUsed[0] = 1;
  this.setDesc(L.FLATDS, 0, 0xffffffff, 0xcff300);
  this.setDesc(L.FLATCS, 0, 0xffffffff, 0xcffb00);
  this.setDesc(L.SENT, LAYOUT.SENTINEL, 0xf, 0xfb00);
  for (let i = 0; i < L.NSTK; i++) this.setDesc(L.STK + 8 * i, 0, 0xffff, 0xf300);
  this.setDesc(L.THSEL, L.T16, 0xffff, 0xfb00);
  for (const [sel, base] of [[0x107, 0], [0x10f, 0x400], [0x117, 0xa0000], [0x11f, 0xb0000], [0x127, 0xb8000], [0x12f, 0xc0000], [0x137, 0xd0000], [0x13f, 0xe0000], [0x147, 0xf0000]])
    this.setDesc(sel, base, 0xffff, 0xf300);   // __0000H, __0040H, __A000H ... __F000H
  this.dosTop = 0x50000;                       // conventional memory handed out by GlobalDOSAlloc
  this.stackLevel = 0;
  this.ne = new Map();                // upper-case module name -> NE module record
  this.ghandles = new Map();          // selector -> global block {lin, size, sels, flags, lock, owner}
  this.lheaps = new Map();            // selector -> local heap
  this.atoms = new Map();             // selector -> atom table
  this.dosFiles = new Map(); this.nextDosFile = 5;
  this.mapls = new Map();             // linear 32K-aligned base -> selector (MapLS)
  this.ctx16 = [];                    // saved 16-bit contexts across 16 -> 32 thunks
  this.th16 = (window.W95SYSTEM && window.W95SYSTEM.thunks16 || []).map(k => this.thunk16Def(k));
  this.lastError16 = 0;
};
P.setDesc = function (sel, base, limit, acc = 0xf300) {
  const i = sel & 0xfff8;
  this.w32(L.LDT + i, base); this.w32(L.LDT + i + 4, limit); this.w32(L.ACC + i, acc); this.selUsed[i >> 3] = 1;
};
P.selBase = function (sel) { return this.r32(L.LDT + (sel & 0xfff8)); };
P.selLimit = function (sel) { return this.r32(L.LDT + (sel & 0xfff8) + 4); };
P.selValid = function (sel) { return (sel & 0xfff8) && this.selUsed[(sel & 0xfff8) >> 3]; };
/** n consecutive selectors (stepping by __AHINCR) covering [base, base+size) */
P.allocSels = function (base, size, acc = 0xf300) {
  const n = Math.max(1, Math.ceil(size / 0x10000));
  for (let i = L.DYN; i + n < 8190; i++) {
    let ok = true; for (let k = 0; k < n; k++) if (this.selUsed[i + k]) { ok = false; i += k; break; }
    if (!ok) continue;
    for (let k = 0; k < n; k++) this.setDesc(((i + k) << 3) | 7, base + 0x10000 * k, Math.min(size - 0x10000 * k, 0x10000) - 1 + (k ? 0 : Math.max(0, size - 0x10000)) , acc);
    return (i << 3) | 7;
  }
  throw new GuestError('out of selectors');
};
P.freeSels = function (sel, n = 1) {
  for (let k = 0; k < n; k++) { const i = ((sel & 0xfff8) >> 3) + k; this.selUsed[i] = 0; this.w32(L.LDT + 8 * i, 0); this.w32(L.LDT + 8 * i + 4, 0); this.w32(L.ACC + 8 * i, 0); }
};
/** segmented -> linear */
P.lin = function (sp) { sp = u32(sp); return sp ? u32(this.selBase(sp >>> 16) + (sp & 0xffff)) : 0; };
/** linear -> segmented via a shared 32K-aligned alias (MapLS) */
P.mapLS = function (a) {
  a = u32(a); if (!(a >>> 16)) return a;
  const base = a - (a & 0x7fff); let sel = this.mapls.get(base);
  if (!sel) { sel = this.allocSels(base, 0x10000); this.mapls.set(base, sel); }
  return u32((sel << 16) | (a - base));
};
P.seg = function (name, sel) {
  const pair = SEGS.find(s => s[0] === name);
  this.cpu[name].value = sel & 0xffff;
  if (name === 'fsel' && !(sel & 0xfff8)) return;
  this.cpu[pair[1]].value = this.selBase(sel);
};
/** reload the cached segment bases (a KERNEL call may have moved a segment) */
P.refreshSegs = function () {
  for (const [s, b] of SEGS) { const v = this.cpu[s].value & 0xffff; if (s === 'fsel' && !(v & 0xfff8)) continue; this.cpu[b].value = this.selBase(v); }
};

// ---------------------------------------------------------------- NE modules
const rd = { u16: (d, o) => d[o] | (d[o + 1] << 8), u32: (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 };
P.loadNE = function (name, file, module, meta) {
  this.init16();
  const u8 = this.u8;
  const rec = { name, kind: 'ne', base: meta.base, meta, file, segs: meta.segs, exports: new Map(), names: meta.names, run: null };
  for (const sg of meta.segs) {
    u8.fill(0, sg.base, sg.base + Math.max(sg.alloc, 1));
    if (sg.len) u8.set(file.subarray(sg.fileoff, sg.fileoff + sg.len), sg.base);
    const limit = sg.num === meta.autodata ? 0xffff : Math.max(sg.alloc, 1) - 1;
    this.setDesc(sg.sel, sg.base, limit, sg.flags & 1 ? 0xf300 : (sg.bits === 32 ? 0x40fb00 : 0xfb00));
  }
  for (const [lin, size, val] of meta.fixups) { if (size === 1) u8[lin] = val; else if (size === 2) this.w16(lin, val); else this.w32(lin, val); }
  for (const [ord, [sel, off]] of Object.entries(meta.exports)) rec.exports.set(+ord, u32((sel << 16) | off));
  rec.run = new WebAssembly.Instance(module, this.imports).exports.run;
  const look = new Uint32Array(this.mem.buffer, meta.lookup, meta.textHi - meta.textLo);
  meta.blocks.forEach((a, i) => { look[a - meta.textLo] = i + 1; });
  // module database: a copy of the NE header in its own segment (hModule)
  const n = rd.u32(file, 0x3c), hdrLen = Math.min(file.length - n, 0x4000), mdb = this.alloc(hdrLen + 16);
  u8.set(file.subarray(n, n + hdrLen), mdb);
  rec.hModule = this.allocSels(mdb, hdrLen);
  rec.dgroup = meta.autodata ? meta.segs[meta.autodata - 1].sel : 0;
  rec.hInstance = rec.dgroup || rec.hModule;
  if (rec.dgroup) {   // DGROUP starts at its minimum allocation plus local heap and stack; the module grows it itself
    const dg = meta.segs[meta.autodata - 1], init = Math.min(0x10000, ((dg.minalloc || 0x10000) + rd.u16(file, n + 0x10) + rd.u16(file, n + 0x12) + 15) & ~15);
    this.ghandles.set(rec.dgroup | 1, { lin: dg.base, size: init, n: 1, flags: 2, lock: 0, owner: rec.hModule });
    this.w32(L.LDT + (rec.dgroup & 0xfff8) + 4, init - 1);
  }
  for (const sg of meta.segs) if (sg.num !== meta.autodata) this.ghandles.set(sg.sel | 1, { lin: sg.base, size: Math.max(sg.alloc, 1), n: 1, flags: 0, lock: 0, owner: rec.hModule, code: !(sg.flags & 1) });
  this.modules.push(rec); this.byName.set(name, rec); this.ne.set(name, rec);
  return rec;
};
/** run a DLL's LibEntry the way the Win16 loader does: DS = DGROUP, DI = hInstance, CX = heap size, ES:SI = command line */
P.initNE = function (rec) {
  const m = rec.meta; if (!m.entry[0]) return 1;
  const heap = rd.u16(rec.file, rd.u32(rec.file, 0x3c) + 0x10);
  const r = this.call16(m.segs[m.entry[0] - 1].sel, m.entry[1], [], { ds: rec.dgroup, di: rec.hInstance, cx: heap, es: 0, si: 0 });
  return r.ax;
};
P.neByHandle = function (h) {
  h &= 0xffff; if (!h) return null;
  for (const m of this.ne.values()) if (m.hModule === h || m.hInstance === h || (m.dgroup | 1) === (h | 1) || m.segs.some(s => (s.sel | 1) === (h | 1))) return m;
  return null;
};
P.neExport = function (m, key) {
  if (typeof key === 'string') { const o = m.names[key.toUpperCase()]; if (o === undefined) return 0; key = o; }
  return m.exports.get(key) || 0;
};
// `native`: also bring up the modules the JS personality stands in for (JS16) from their recompiled code, for a
// session that runs native USER; otherwise those imports stay with the JS implementations
P.loadLibrary16 = function (name, native = false, defer = false) {
  this.init16();
  const base = name.toUpperCase().replace(/^.*\\/, '').replace(/\.(DLL|EXE|DRV)$/, '');
  if (base === 'KERNEL') return this.kernelModule();
  if (this.ne.has(base)) return this.ne.get(base);
  const all = (window.W95SYSTEM && window.W95SYSTEM.ne) || {};
  const file = name.toUpperCase().replace(/^.*\\/, '');
  const sys = all[base] || Object.values(all).find(s => s.fileName === file || s.fileName === file + '.DLL');
  if (!sys) return this.loadNEFile(name);
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  if (this.ne.has(sys.meta.name.toUpperCase())) return this.ne.get(sys.meta.name.toUpperCase());
  const rec = this.loadNE(sys.meta.name.toUpperCase(), sys.fileBytes || (sys.fileBytes = b64(sys.file)), sys.mod || (sys.mod = new WebAssembly.Module(b64(sys.wasm))), sys.meta);
  rec.fileName = sys.fileName;
  for (const imp of sys.meta.imports || []) if (imp !== 'KERNEL' && (native || !JS16.includes(imp))) this.loadLibrary16(imp, native);
  if (defer) return rec;   // the caller runs LibEntry (initNE) once what it needs is in place
  if (!this.initNE(rec)) { console.warn('[ne16]', base, 'LibEntry failed'); }
  return rec;
};
/** start the native window system the way KRNL386 does: the drivers SYSTEM.INI's [boot] section names, in its
 *  order (system, keyboard, mouse, display, comm), then GDI and USER; returns USER's module record */
P.bootUser16 = function () {
  for (const m of ['SYSTEM', 'KEYBOARD', 'MOUSE', 'DISPLAY', 'COMM', 'GDI']) this.loadLibrary16(m, true);
  // USER.EXE calls into USER32.DLL through flat thunks from its LibEntry on, and USER32 connects them when it loads,
  // naming USER.EXE: so USER's image first, then USER32, then USER's LibEntry
  const user = this.ne.get('USER') || this.loadLibrary16('USER', true, true);
  const sys = window.W95SYSTEM, b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const d = sys && sys.dlls && sys.dlls['USER32.DLL'];
  if (d && !this.byName.get('USER32')) {
    for (const [n, x] of Object.entries(sys.dlls)) {
      const k = n.replace(/\.DLL$/, '');
      if (!this.dlls.has(k)) this.dlls.set(k, { file: x.fileBytes || (x.fileBytes = b64(x.file)), module: x.mod || (x.mod = new WebAssembly.Module(b64(x.wasm))), meta: x.meta });
    }
    this.loadDll('USER32');
    const pending = this.inits; this.inits = []; for (const m of pending) this.call(m.meta.entry, [m.base, 1, 0]);   // DllMain(DLL_PROCESS_ATTACH)
  }
  if (!user.inited) { user.inited = true; if (!this.initNE(user)) console.warn('[ne16] USER LibEntry failed'); }
  return user;
};
/** a module from disk that has no code (fonts and other resource-only libraries) */
P.loadNEFile = function (name) {
  const full = this.findFile16(/\.[^\\]*$/.test(name) ? name : name + '.DLL'); if (!full) return null;
  const key = full.toUpperCase();
  for (const m of this.ne.values()) if (m.path === key) return m;
  const file = this.fs.readFile(full);
  if (file[0] !== 0x4d || file[1] !== 0x5a) return null;
  const n = rd.u32(file, 0x3c); if (file[n] !== 0x4e || file[n + 1] !== 0x45 || rd.u16(file, n + 0x1c)) return null;
  const hdrLen = Math.min(file.length - n, 0x4000), mdb = this.alloc(hdrLen + 16);
  this.u8.set(file.subarray(n, n + hdrLen), mdb);
  const rec = { name: key, path: key, kind: 'ne', file, segs: [], exports: new Map(), names: {}, meta: null, dgroup: 0 };
  rec.hModule = rec.hInstance = this.allocSels(mdb, hdrLen);
  this.ne.set(key, rec);
  return rec;
};
P.jsModule = function (name) {
  this.jsMods = this.jsMods || new Map();
  if (this.jsMods.has(name)) return this.jsMods.get(name);
  const mdb = this.alloc(0x40); this.u8.set([0x4e, 0x45], mdb);
  const rec = { name, kind: 'js', hModule: this.allocSels(mdb, 0x40), hInstance: 0, segs: [] };
  this.jsMods.set(name, rec); return rec;
};
P.kernelModule = function () { return this.jsModule('KERNEL'); };
const JS16 = ['KERNEL', 'USER', 'KEYBOARD', 'SYSTEM', 'VDD', 'VFLATD', 'DPMI'];

// ---------------------------------------------------------------- calling 16-bit code
/** enter 16-bit code on an alias of the flat stack; args: [['w', v] | ['l', v]...] in Pascal order */
P.call16 = function (sel, off, args = [], regs = {}) {
  this.init16();
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  save.eip = this.cpu.eip.value;
  const lvl = this.stackLevel++; if (lvl >= L.NSTK) throw new GuestError('16-bit stack nesting too deep');
  const ssel = L.STK + 8 * lvl;
  const flat = (this.cpu.ss.value & 0xffff) ? u32(this.cpu.ssb.value + (this.cpu.esp.value & 0xffff)) : u32(this.cpu.esp.value);
  const base = (flat - 0xfff0) & ~0xf;
  this.setDesc(ssel, base, 0xffff, 0xf300); this.seg('ss', ssel);
  let sp = flat - 16 - base;
  for (const [t, v] of args) { if (t === 'w') { sp -= 2; this.w16(base + sp, v); } else { sp -= 4; this.w32(base + sp, v); } }
  sp -= 2; this.w16(base + sp, L.SENT); sp -= 2; this.w16(base + sp, 0);
  this.cpu.esp.value = sp;
  this.seg('ds', regs.ds || 0); this.seg('es', regs.es || 0);
  for (const r of ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp']) if (regs[r] !== undefined) { const R = 'e' + r; this.cpu[R].value = lo16(this.cpu[R].value, regs[r]); }
  this.seg('cs', sel);
  this.depth++;
  const r = this.runAt(u32(this.selBase(sel) + off));
  this.depth--; this.stackLevel--;
  if (r !== 0 || this.trapped) throw new GuestError(this.trapped || `16-bit call ${sel.toString(16)}:${off.toString(16)} did not return (${r} at ${this.reg('eip').toString(16)})`);
  const out = { ax: this.cpu.eax.value & 0xffff, dx: this.cpu.edx.value & 0xffff, eax: u32(this.cpu.eax.value), cx: this.cpu.ecx.value & 0xffff };
  out.dxax = u32((out.dx << 16) | out.ax);
  for (const r of GPR) this.cpu[r].value = save[r];
  for (const [s, b] of SEGS) { this.cpu[s].value = save[s]; this.cpu[b].value = save[b]; }
  this.cpu.eip.value = save.eip;
  return out;
};

// ---------------------------------------------------------------- 16-bit API dispatch
const NAMES16_INIT = {};
const K16 = {};   // 'MODULE.#ord' -> [args, ret, fn]   args: w word, i int16, l dword, p segptr->linear, s segptr->string, x raw segptr
const def16 = (mod, ord, args, ret, fn) => { K16[`${mod}.#${ord}`] = [args, ret, fn]; };
P.thunk16Def = function (key) { return { key, def: K16[key] }; };
P.thunk16For = function (key) {
  let i = this.th16.findIndex(t => t.key === key);
  if (i < 0) { i = this.th16.length; this.th16.push(this.thunk16Def(key)); }
  return u32((L.THSEL << 16) | (4 * i));
};
const ARGBYTES = { w: 2, i: 2, l: 4, p: 4, s: 4, x: 4 };
P.tick16 = function () { if (this.timeLin) this.w32(this.timeLin, u32(this.now() - this.t0 + 3600000)); };
P.api16 = function (eip) {
  this.tick16();
  const t = this.th16[(eip - L.T16) >> 2];
  // an import with no JS implementation, of a module compiled later (GDI's of USER: each imports the other), reaches
  // the native module here once it is loaded: the far call goes on into the export, which returns to the caller
  // itself. A JS implementation, where there is one, always answers.
  if (t && !t.def && t.native === undefined) {
    const i = t.key.indexOf('.'), m = this.ne.get(t.key.slice(0, i)), k = t.key.slice(i + 1);
    t.native = (m && m.meta && this.neExport(m, k[0] === '#' ? +k.slice(1) : k)) || 0;
  }
  if (t && !t.def && t.native) { const sel = t.native >>> 16; this.seg('cs', sel); return u32(this.selBase(sel) + (t.native & 0xffff)); }
  if (!t || !t.def) {
    const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), m = this.neByHandle(this.r16(f + 2));
    this.trapped = `unimplemented 16-bit import ${t ? t.key : eip.toString(16)}, called from ${m ? m.name : '?'} ${this.r16(f + 2).toString(16)}:${this.r16(f).toString(16)}, stack words ${[4, 6, 8, 10, 12, 14].map(k => this.r16(f + k).toString(16)).join(' ')}`;
    return LAYOUT.SENTINEL;
  }
  const [args, ret, fn] = t.def;
  if (window.W95TRACE16) window.W95TRACE16(t, this);
  if (ret === 'jmp') { try { return u32(fn.call(this)); } catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } throw e; } }
  const ssb = this.cpu.ssb.value >>> 0, sp = this.cpu.esp.value & 0xffff, frame = ssb + sp;
  const ip = this.r16(frame), cs = this.r16(frame + 2);
  let total = 0; for (const c of args) total += ARGBYTES[c];
  const vals = []; let o = frame + 4 + total;
  for (const c of args) {
    o -= ARGBYTES[c];
    let v = ARGBYTES[c] === 2 ? this.r16(o) : this.r32(o);
    if (c === 'i') v = (v << 16) >> 16; else if (c === 'p') v = this.lin(v); else if (c === 's') v = v >>> 16 ? this.readA(this.lin(v)) : v ? v : null;
    vals.push(v);
  }
  this.retCS = cs;
  let r;
  try { r = fn.apply(this, vals); }
  catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } throw e; }
  if (this.exitCode !== null) return LAYOUT.SENTINEL;
  if (r === YIELD) return -1;   // a thread suspended in the call: it runs the call again when resumed
  if (ret === 'w') this.cpu.eax.value = lo16(this.cpu.eax.value, r | 0);
  else if (ret === 'l') { this.cpu.eax.value = r | 0; this.cpu.edx.value = lo16(this.cpu.edx.value, u32(r) >>> 16); }
  this.cpu.esp.value = lo16(this.cpu.esp.value, sp + 4 + total);
  this.refreshSegs();
  this.seg('cs', cs);
  return u32(this.selBase(cs) + ip);
};
/** register-convention return from a far-called helper: pop CS:IP (+n bytes) */
P.retf16 = function (n = 0) {
  const ssb = this.cpu.ssb.value >>> 0, sp = this.cpu.esp.value & 0xffff, ip = this.r16(ssb + sp), cs = this.r16(ssb + sp + 2);
  this.cpu.esp.value = lo16(this.cpu.esp.value, sp + 4 + n); this.refreshSegs(); this.seg('cs', cs);
  return u32(this.selBase(cs) + ip);
};
P.ax = function (v) { if (v === undefined) return this.cpu.eax.value & 0xffff; this.cpu.eax.value = lo16(this.cpu.eax.value, v); };

// ---------------------------------------------------------------- interrupts (DPMI and friends)
P.interrupt = function (vec, next) {
  const h = INTS[vec];
  if (window.W95INTTRACE) window.W95INTTRACE(vec, this);
  if (!h) { this.trapped = `unhandled interrupt ${vec.toString(16)}h (ax=${this.ax().toString(16)}) at ${u32(next).toString(16)}`; return LAYOUT.SENTINEL; }
  const r = h.call(this, next);
  return r === undefined ? next : r;
};
const CF = (p, on) => { p.cpu.cf.value = on ? 1 : 0; };
const INTS = {
  0x31(next) {      // DPMI
    const ax = this.ax(), bx = this.cpu.ebx.value & 0xffff, cx = this.cpu.ecx.value & 0xffff, dx = this.cpu.edx.value & 0xffff;
    CF(this, 0);
    switch (ax) {
      case 0x0000: { const s = this.allocSels(0, 1); for (let k = 1; k < Math.max(cx, 1); k++) this.allocSels(0, 1); this.ax(s); return; }
      case 0x0001: this.freeSels(bx); return;
      case 0x0003: this.ax(8); return;
      case 0x0006: { const b = this.selBase(bx); this.cpu.ecx.value = lo16(this.cpu.ecx.value, b >>> 16); this.cpu.edx.value = lo16(this.cpu.edx.value, b); return; }
      case 0x0007: this.w32(L.LDT + (bx & 0xfff8), u32((cx << 16) | dx)); this.refreshSegs(); return;
      case 0x0008: this.w32(L.LDT + (bx & 0xfff8) + 4, u32((cx << 16) | dx)); return;
      case 0x0009: this.w32(L.ACC + (bx & 0xfff8), (cx & 0xff) << 8 | ((cx & 0xc000) << 8)); return;
      case 0x000a: { const s = this.allocSels(this.selBase(bx), this.selLimit(bx) + 1, 0xf300); this.ax(s); return; }
      case 0x000b: { const a = this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff)), b = this.selBase(bx), l = this.selLimit(bx);
        this.w16(a, l); this.w16(a + 2, b); this.u8[a + 4] = b >>> 16; this.w16(a + 5, this.r32(L.ACC + (bx & 0xfff8)) >>> 8); this.u8[a + 7] = b >>> 24; return; }
      case 0x000c: { const a = this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff));
        const b = this.r16(a + 2) | (this.u8[a + 4] << 16) | (this.u8[a + 7] << 24), l = this.r16(a) | ((this.u8[a + 6] & 0xf) << 16);
        this.setDesc(bx, u32(b), this.u8[a + 6] & 0x80 ? (l << 12) | 0xfff : l, this.r16(a + 5) << 8); this.refreshSegs(); return; }
      case 0x0200: case 0x0202: case 0x0204: {   // get real-mode / exception / protected-mode interrupt vector
        const v = ((this.exVec = this.exVec || {})[`${ax}:${bx & 0xff}`]) || (ax === 0x0202 ? this.thunk16For('DPMI.#1') : 0);
        this.cpu.ecx.value = lo16(this.cpu.ecx.value, v >>> 16); this.cpu.edx.value = v & 0xffff; return; }
      case 0x0201: case 0x0203: case 0x0205: case 0x0283:   // 0x0283: Windows' set-exception-handler variant
        (this.exVec = this.exVec || {})[`${ax === 0x0283 ? 0x0202 : ax - 1}:${bx & 0xff}`] = u32((cx << 16) | (this.cpu.edx.value & 0xffff)); return;
      case 0x0501: { const n = u32((bx << 16) | cx), p = this.alloc(n); this.cpu.ebx.value = lo16(this.cpu.ebx.value, p >>> 16); this.cpu.ecx.value = lo16(this.cpu.ecx.value, p);
        this.cpu.esi.value = lo16(this.cpu.esi.value, p >>> 16); this.cpu.edi.value = lo16(this.cpu.edi.value, p); return; }
      case 0x0500: {   // free memory information: what is left of the guest heap, in bytes and 4 KB pages; -1 where unknown
        const a = this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff)), free = LAYOUT.HEAP_END - this.heapTop, pages = free >>> 12;
        const total = (LAYOUT.HEAP_END - LAYOUT.HEAP) >>> 12;
        for (let k = 0; k < 12; k++) this.w32(a + 4 * k, 0xffffffff);
        this.w32(a, free); this.w32(a + 4, pages); this.w32(a + 8, pages); this.w32(a + 12, total);
        this.w32(a + 16, total); this.w32(a + 20, pages); this.w32(a + 24, total); this.w32(a + 28, pages); this.w32(a + 32, 0);
        return; }
      case 0x0502: return;
      case 0x0600: case 0x0601: case 0x0702: case 0x0703: return;
      case 0x0800: { /* physical address mapping: identity within guest memory */ return; }
      case 0x0801: return;
      case 0x0300: case 0x0302: {   // simulate real-mode interrupt: registers in the structure at ES:EDI
        const st = this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff)), vec = bx & 0xff;
        const R = ['edi', 'esi', 'ebp', null, 'ebx', 'edx', 'ecx', 'eax'], save = {};
        for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'es', 'ds', 'cf']) save[r] = this.cpu[r].value;
        R.forEach((r, i) => { if (r) this.cpu[r].value = this.r32(st + 4 * i); });
        this.cpu.es.value = this.r16(st + 0x22); this.cpu.ds.value = this.r16(st + 0x24); this.cpu.cf.value = this.r16(st + 0x20) & 1;
        this.rmode = true; let r;
        try { r = INTS[vec] ? INTS[vec].call(this, next) : (this.trapped = `unhandled real-mode int ${vec.toString(16)}h`, LAYOUT.SENTINEL); }
        finally { this.rmode = false; }
        R.forEach((rr, i) => { if (rr) this.w32(st + 4 * i, this.cpu[rr].value); });
        this.w16(st + 0x20, (this.r16(st + 0x20) & ~1) | (this.cpu.cf.value & 1));
        this.w16(st + 0x22, this.cpu.es.value);
        for (const k of Object.keys(save)) this.cpu[k].value = save[k];
        if (r === LAYOUT.SENTINEL) return r;
        CF(this, 0); return;
      }
    }
    this.trapped = `unhandled DPMI ${ax.toString(16)}`; return LAYOUT.SENTINEL;
  },
  0x10(next) {     // video BIOS with VBE 2.0: the adapter the display driver programs; its framebuffer is guest memory
    const ax = this.ax(), ah = ax >> 8, bl = this.cpu.ebx.value & 0xff;
    const v = this.video();
    const setBX = x => { this.cpu.ebx.value = lo16(this.cpu.ebx.value, x); }, setCX = x => { this.cpu.ecx.value = lo16(this.cpu.ecx.value, x); };
    const esdi = () => this.rmode ? ((this.cpu.es.value & 0xffff) << 4) + (this.cpu.edi.value & 0xffff) : this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff));
    const farp = a => this.rmode ? u32(((a >> 4) << 16) | (a & 0xf)) : this.mapLS(a);
    if (ah === 0x12 && bl === 0x10) { setBX(0x0003); setCX(0x0009); return; }        // EGA/VGA info: color, 256K
    if (ah === 0x1a && (ax & 0xff) === 0) { this.ax(0x001a); setBX(0x0008); return; } // display combination: VGA color
    if (ah === 0x0f) { const a = this.adapter(); this.ax(((a.w / 8) << 8) | a.mode); setBX(0); return; }
    if (ah === 0x00) { this.setVideoMode(ax & 0x7f, !(ax & 0x80), 0); return; }
    if (ax === 0x10f0) {    // Tseng HiColor: BL = mode (15/16 bpp), or BL = FFh with BH = mode for 24 bpp
      const ok = bl === 0xff ? this.setVideoMode(this.cpu.ebx.value >> 8 & 0xff, true, 24) : this.setVideoMode(bl, true, 16);
      this.ax(ok ? 0x0010 : 0x0000); return;
    }
    if (ax === 0x10f1) { this.ax(0x0010); setBX(0x0003); return; }   // DAC type: Sierra 15/16-bit capable
    if (ah === 0x10 || ah === 0x11 || ah === 0x01 || ah === 0x02) return;
    if (ah === 0x4f) {
      const fn = ax & 0xff;
      if (fn === 0x00) {
        const a = esdi(); const want2 = this.r32(a) === 0x32454256;   // 'VBE2'
        this.u8.fill(0, a, a + (want2 ? 512 : 256)); this.writeA(a, 'VESA'); this.w16(a + 4, 0x0200);
        this.w32(a + 6, farp(v.oem)); this.w32(a + 10, 1); this.w32(a + 14, farp(v.list)); this.w16(a + 18, v.mem >> 16);
        this.ax(0x004f); return;
      }
      if (fn === 0x01) { const m = VBE_MODES[this.cpu.ecx.value & 0x1ff]; if (!m) { this.ax(0x014f); return; } this.vbeModeInfo(esdi(), m); this.ax(0x004f); return; }
      if (fn === 0x02) { const n = this.cpu.ebx.value & 0x1ff, m = VBE_MODES[n]; if (!m) { this.ax(0x014f); return; } v.mode = n; v.cur = m; v.pitch = m.w * (m.bpp >> 3); v.start = 0; this.ax(0x004f); return; }
      if (fn === 0x03) { setBX(v.mode | 0x4000); this.ax(0x004f); return; }
      if (fn === 0x05) { if (!(bl & 0x80 >> 7) && (this.cpu.ebx.value & 0x100) === 0) v.bank = this.cpu.edx.value & 0xffff; else this.cpu.edx.value = lo16(this.cpu.edx.value, v.bank || 0); this.ax(0x004f); return; }
      if (fn === 0x06) { if ((bl & 0xff) === 1) { setBX(v.pitch || 0); setCX(v.cur ? v.cur.w : 0); this.cpu.edx.value = lo16(this.cpu.edx.value, v.cur ? v.cur.h : 0); } this.ax(0x004f); return; }
      if (fn === 0x07) { if (bl === 1) { setCX(0); this.cpu.edx.value = lo16(this.cpu.edx.value, 0); } this.ax(0x004f); return; }
      if (fn === 0x08) { setBX(0x0600); this.ax(0x004f); return; }
      if (fn === 0x09) { const n = this.cpu.ecx.value & 0xffff, first = this.cpu.edx.value & 0xffff, a = esdi(); for (let i = 0; i < n; i++) { const k = (first + i) * 3; v.dac[k + 2] = this.u8[a + 4 * i]; v.dac[k + 1] = this.u8[a + 4 * i + 1]; v.dac[k] = this.u8[a + 4 * i + 2]; } this.ax(0x004f); return; }
      this.ax(0x014f); return;
    }
    return;   // other BIOS extensions (Video7 6Fh etc.) are absent: registers come back unchanged
  },
  0x1a(next) {     // BIOS clock; no PCI BIOS
    const ah = this.ax() >> 8;
    if (ah === 0x00) {
      const d = new Date(), ms = ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
      const t = Math.floor(ms * 1193182 / 65536 / 1000);
      this.cpu.ecx.value = lo16(this.cpu.ecx.value, t >>> 16); this.cpu.edx.value = lo16(this.cpu.edx.value, t); this.ax(this.ax() & 0xff00); return;
    }
    if (ah === 0xb1) { CF(this, 1); this.ax(0x8100 | (this.ax() & 0xff)); return; }
    this.trapped = `unhandled int 1Ah ax=${this.ax().toString(16)}`; return LAYOUT.SENTINEL;
  },
  0x21(next) {     // DOS
    const ah = (this.ax() >> 8) & 0xff, al = this.ax() & 0xff;
    CF(this, 0);
    switch (ah) {
      case 0x30: this.ax(0x0007); this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0xff00); this.cpu.ecx.value = lo16(this.cpu.ecx.value, 0); return;   // DOS 7.0
      case 0x19: this.ax((this.ax() & 0xff00) | 2); return;        // current drive C:
      case 0x2a: { const d = new Date(); this.cpu.ecx.value = lo16(this.cpu.ecx.value, d.getFullYear()); this.cpu.edx.value = lo16(this.cpu.edx.value, ((d.getMonth() + 1) << 8) | d.getDate()); this.ax((this.ax() & 0xff00) | d.getDay()); return; }
      case 0x2c: { const d = new Date(); this.cpu.ecx.value = lo16(this.cpu.ecx.value, (d.getHours() << 8) | d.getMinutes()); this.cpu.edx.value = lo16(this.cpu.edx.value, (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10)); return; }
      case 0x33: if (al === 6) { this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0x0007); this.cpu.edx.value = lo16(this.cpu.edx.value, 0x1000); } return;   // true version 7.0, in HMA
      case 0x44: if (al === 0) { this.cpu.edx.value = lo16(this.cpu.edx.value, 0x80); return; } break;
      case 0x50: case 0x51: case 0x62: return;
      case 0x35: {   // a vector nobody has set leads to the BIOS service behind it, where there is one
        const v = ((this.dosVec = this.dosVec || {})[al]) || (BIOS_INT[al] ? this.thunk16For(`BIOSINT.#${al}`) : 0);
        this.seg('es', v >>> 16); this.cpu.ebx.value = lo16(this.cpu.ebx.value, v); return; }
      case 0x0d: return;   // disk reset: nothing is buffered
      case 0x25: (this.dosVec = this.dosVec || {})[al] = u32((this.cpu.ds.value << 16) | (this.cpu.edx.value & 0xffff)); return;
    }
    this.trapped = `unhandled int 21h ax=${this.ax().toString(16)}`; return LAYOUT.SENTINEL;
  },
  0x11() { this.ax(0x0023); },
  0x16() { biosKbd(this); },
  0x33() {   // the DOS mouse driver interface, as far as MOUSE.DRV asks it: 24h version, type (PS/2) and IRQ
    const ax = this.ax();
    if (ax === 0x24) { this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0x0626); this.cpu.ecx.value = lo16(this.cpu.ecx.value, 0x0400); return; }
    this.trapped = `unhandled int 33h ax=${ax.toString(16)}`; return LAYOUT.SENTINEL;
  },   // BIOS equipment list: a floppy drive (A:), a maths coprocessor, 80x25 colour display
  0x2f(next) {
    const ax = this.ax();
    if (ax === 0x1600) { this.ax(0x0004 | (0x00 << 8)); this.cpu.eax.value = lo16(this.cpu.eax.value, 0x0004); return; }  // Windows 4.00 enhanced mode
    if (ax === 0x1683) { this.cpu.ebx.value = lo16(this.cpu.ebx.value, 1); return; }    // current VM id
    if (ax === 0x1684) {   // VxD protected-mode API entry points: the VDD, VFLATD, and the VxDs USER calls (VXD_API)
      const id = this.cpu.ebx.value & 0xffff, ep = id === 0x0a ? this.thunk16For('VDD.#0') : id === 0x11f ? this.thunk16For('VFLATD.#0') : VXD_API[id] ? this.thunk16For(`VXD.#${id}`) : 0;
      this.cpu.edi.value = lo16(this.cpu.edi.value, ep & 0xffff); this.seg('es', ep >>> 16); return;
    }
    if (ax === 0x1686) { this.ax(0); return; }                                          // in protected mode
    if (ax === 0x1689 || ax === 0x1680) return;
    if ((ax >> 8) === 0x40) return;    // VDD save/restore and critical-section notifications
    if (ax === 0x4a32) return;         // boot progress to IO.SYS (USER reports start-up done; its answer is not read)
    this.trapped = `unhandled int 2Fh ax=${ax.toString(16)}`; return LAYOUT.SENTINEL;
  },
};
P.trapHook = function (e, code) {
  if (code === 0) return this.exception16(0, u32(e));
  if (code < 0x100) return false;
  if (code >= 0x1000000) { this.portIO(code & 0xffff, (code >> 16) & 7, !!(code & 0x800000)); return true; }
  this.cpu.eip.value = this.interrupt(code - 0x100, u32(e)) | 0;
  return true;
};

// ---------------------------------------------------------------- video adapter (VBE 2.0, linear framebuffer in guest memory)
const VBE_MODES = {};
[[0x101, 640, 480, 8], [0x103, 800, 600, 8], [0x105, 1024, 768, 8], [0x110, 640, 480, 15], [0x111, 640, 480, 16], [0x112, 640, 480, 24],
 [0x113, 800, 600, 15], [0x114, 800, 600, 16], [0x115, 800, 600, 24], [0x116, 1024, 768, 15], [0x117, 1024, 768, 16]]
  .forEach(([n, w, h, bpp]) => { VBE_MODES[n] = { n, w, h, bpp: bpp === 15 ? 16 : bpp, depth: bpp }; });
P.video = function () {
  if (this.vid) return this.vid;
  this.init16();
  const mem = 4 << 20, fb = this.alloc(mem, true);
  const low = n => { const a = this.dosTop; this.dosTop += (n + 15) & ~15; return a; };
  const oem = low(32); this.writeA(oem, 'Windows 95 VBE');
  const ids = Object.keys(VBE_MODES).map(Number), list = low(2 * ids.length + 2);
  ids.forEach((n, i) => this.w16(list + 2 * i, n)); this.w16(list + 2 * ids.length, 0xffff);
  return (this.vid = { mem, fb, oem, list, mode: 3, cur: null, pitch: 0, dac: new Uint8Array(768) });
};
P.vbeModeInfo = function (a, m) {
  const v = this.video(), Bpp = m.bpp >> 3;
  this.u8.fill(0, a, a + 256);
  this.w16(a, 0x009b); this.u8[a + 2] = 7; this.w16(a + 4, 64); this.w16(a + 6, 64); this.w16(a + 8, 0xa000);
  this.w16(a + 0x10, m.w * Bpp); this.w16(a + 0x12, m.w); this.w16(a + 0x14, m.h); this.u8[a + 0x16] = 8; this.u8[a + 0x17] = 16;
  this.u8[a + 0x18] = 1; this.u8[a + 0x19] = m.bpp; this.u8[a + 0x1a] = 1; this.u8[a + 0x1b] = m.bpp === 8 ? 4 : 6; this.u8[a + 0x1d] = Math.floor(v.mem / (m.w * m.h * Bpp)) - 1; this.u8[a + 0x1e] = 1;
  const masks = { 15: [5, 10, 5, 5, 5, 0], 16: [5, 11, 6, 5, 5, 0], 24: [8, 16, 8, 8, 8, 0] }[m.depth];
  if (masks) masks.forEach((x, i) => { this.u8[a + 0x1f + i] = x; });
  this.w32(a + 0x28, v.fb);
};

// BIOS services reached through interrupt vectors a driver saved and calls with pushf + far call (KEYBOARD.DRV's
// INT 16h and INT 09h): they return as an interrupt handler that keeps its flags does (RETF 2)
const BIOS_INT = { 0x09: true, 0x16: true };
/** INT 16h, the BIOS keyboard: keystrokes typed reach Windows through its own driver, so the BIOS buffer is empty */
function biosKbd(p) {
  const ah = (p.cpu.eax.value >> 8) & 0xff;
  if (ah === 0x01 || ah === 0x11) { p.cpu.zf.value = 1; p.ax(0); return; }          // check keystroke: none
  if (ah === 0x02 || ah === 0x12) { p.ax((p.ax() & 0xff00) | p.u8[0x417]); return; }  // shift flags from the BIOS data area
  if (ah === 0x00 || ah === 0x10) { p.ax(0); return; }                                 // read keystroke: none to read
  if (ah === 0x03 || ah === 0x05) return;                                              // typematic rate, store keystroke
  throw new GuestError(`INT 16h function ${ah.toString(16)}h`);
}
def16('BIOSINT', 0x16, '', 'jmp', function () { biosKbd(this); return this.retf16(2); });
def16('BIOSINT', 0x09, '', 'jmp', function () { return this.retf16(2); });   // the hardware keyboard interrupt: nothing below Windows' driver

// protected-mode API entry points of the VxDs USER.EXE talks to, by device id: function number in AX (or as each
// device takes it); a function not listed stops the caller with its device and number
const VXD_API = {};
const vxdApi = (id, name, fns) => {
  VXD_API[id] = { name, fns };
  def16('VXD', id, '', 'jmp', function () {
    const f = this.cpu.eax.value & 0xffff, h = fns[f];
    if (!h) {
      const ret = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), m = this.neByHandle(this.r16(ret + 2));
      this.trapped = `unimplemented ${name} (VxD ${id.toString(16)}h) API function ${f.toString(16)}h, called from ${m ? m.name : '?'} ${this.r16(ret + 2).toString(16)}:${this.r16(ret).toString(16)}`;
      return LAYOUT.SENTINEL;
    }
    const r = h.call(this); if (r !== undefined) this.cpu.eax.value = lo16(this.cpu.eax.value, r);
    return this.retf16(0);
  });
};
vxdApi(0x0001, 'VMM', {
  // asked once by USER's LibEntry, which keeps a value only when AH comes back 2 (meaning not established here);
  // 0 takes USER's own branch for its absence
  0x26d() { return 0; },
});
vxdApi(0x0009, 'REBOOT', {});
vxdApi(0x000c, 'VMD', {
  0() { return 0x400; },                                       // version 4.00
  5() { this.cpu.edx.value = lo16(this.cpu.edx.value, 0); return 4; },   // mouse type: PS/2 (no serial port IRQ to claim)
  // asked after the type; a zero answer sends MOUSE.DRV through a set-up of its own that this mouse does not need
  // (an unconfirmed reading of the driver)
  0x102() { return 1; },
  // the event procedure MOUSE.DRV's Enable passes on (USER's mouse_event), or 0:0 from Disable
  3() { const cx = this.cpu.ecx.value & 0xffff, dx = this.cpu.edx.value & 0xffff; this.mouseProc = cx || dx ? { sel: cx, off: dx } : null; return 0; },
  0x101() { return 0; },
});
/** a pointer event into USER through the event procedure the mouse driver registered: flags as mouse_event takes
 *  them (1 move, 2/4 left down/up, 8/16 right down/up, 0x8000 absolute), x and y 0..65535 when absolute */
P.mouseEvent16 = function (flags, x, y) {
  if (!this.mouseProc || this.depth) return false;
  this.tick16(); this.call16(this.mouseProc.sel, this.mouseProc.off, [], { ax: flags, bx: x & 0xffff, cx: y & 0xffff, dx: 2, si: 0, di: 0 });
  return true;
};
vxdApi(0x0017, 'SHELL', {});
vxdApi(0x0037, 'VxD 37h', {});
vxdApi(0x0442, 'VTDAPI', {
  // a selector to the system time in milliseconds, which USER reads for message times (the VxD keeps it current;
  // here it is refreshed whenever native code calls out)
  9() { if (!this.timeLin) { this.timeLin = this.alloc(16); this.timeSel = this.allocSels(this.timeLin, 16); } this.tick16(); return this.timeSel; },
  // a periodic callback, as SYSTEM.DRV registers its timer handler: ES:BX -> { min ms, max ms, far handler, ...,
  // flags }; run by timers16() at the shorter period
  7() {
    const a = this.lin((this.cpu.es.value << 16) | (this.cpu.ebx.value & 0xffff));
    (this.vtdCallbacks = this.vtdCallbacks || []).push({ ms: this.r16(a) || 55, off: this.r16(a + 4), sel: this.r16(a + 6), due: this.now() + (this.r16(a) || 55) });
    return 1;
  },
});
/** call the VTDAPI periodic callbacks that are due; the host runs this between slices of guest code */
P.timers16 = function () {
  if (!this.vtdCallbacks || this.depth) return;
  const now = this.now();
  for (const c of this.vtdCallbacks) if (now >= c.due) { c.due = Math.max(c.due + c.ms, now); this.tick16(); this.call16(c.sel, c.off, []); }
};

// the display VxD's driver interface (minivdd): registration, mode-change notifications and the display configuration
P.displayConfig = function () {
  const ini = (k, d) => { const v = winIni(this, 'SYSTEM.INI', 'display', k); return v === null ? d : parseInt(v, 10) || d; };
  return { w: (this.host && this.host.width) || ini('x_resolution', 640), h: (this.host && this.host.height) || ini('y_resolution', 480), bpp: ini('BitsPerPixel', 8) };
};
def16('VDD', 0, '', 'jmp', function () {
  const fn = u32(this.cpu.eax.value);
  switch (fn) {
    case 0x80: this.cpu.eax.value = this.cpu.ecx.value; break;          // VDD_DRIVER_REGISTER: VRAM the visible screen uses
    case 0x81: case 0x82: case 0x83: case 0x84: case 0x86: case 0x87: case 0x88: case 0x89: this.cpu.eax.value = 0; break;
    case 0x85: {                                                         // VDD_GET_DISPLAY_CONFIG -> DISPLAYINFO at ES:EDI
      const a = this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff)), n = Math.min(this.cpu.ecx.value & 0xffff, 0x4a), c = this.displayConfig();
      this.u8.fill(0, a, a + n); this.w16(a, n); this.w32(a + 4, 1); this.writeA(a + 8, 'FRAMEBUF', 16);
      this.w16(a + 0x18, c.w); this.w16(a + 0x1a, c.h); this.w16(a + 0x1c, 96); this.u8[a + 0x1e] = 1; this.u8[a + 0x1f] = c.bpp;
      this.w16(a + 0x20, 60); this.w16(a + 0x22, 60);
      this.cpu.eax.value = 0; break;
    }
  }
  return this.retf16(0);
});

// ---------------------------------------------------------------- display adapter: Tseng ET4000 with a Sierra HiColor DAC
// The register file the drivers probe and program, 1 MB of VRAM behind a 64K window at A0000h selected through the
// segment select register (3CDh), and the Tseng video BIOS modes. FRAMEBUF.DRV + DIBENG drive it as they would the card.
const ET_MODES = { 0x03: [720, 400, 0], 0x13: [320, 200, 8], 0x2e: [640, 480, 8], 0x30: [800, 600, 8], 0x38: [1024, 768, 8] };
const VRAM_SIZE = 1 << 20, WIN = 0xa0000;
P.adapter = function () {
  if (this.et) return this.et;
  this.init16();
  const vramLin = this.alloc(VRAM_SIZE + 0x1000, true);
  return (this.et = { vramLin, vram: this.u8.subarray(vramLin, vramLin + VRAM_SIZE), flat: false, bank: 0, misc: 0x67, seq: new Uint8Array(256), gc: new Uint8Array(256), crtc: new Uint8Array(256),
    attr: new Uint8Array(256), idx: { seq: 0, gc: 0, crtc: 0, attr: 0 }, flip: 0, dacW: 0, dacR: 0, dac: new Uint8Array(768), pelMask: 0xff,
    hicolor: 0, hidden: 0, status: 0, mode: 3, w: 720, h: 400, bpp: 0, pitch: 0, dirty: true });
};
/** move the window contents to VRAM and bring in another bank */
P.setBank = function (b) {
  const a = this.adapter(); b &= 0x0f;
  if (b === a.bank) return;
  if (a.flat) { a.bank = b; return; }     // VFLATD presents VRAM linearly; the window is no longer the access path
  const u8 = this.u8; a.vram = u8.subarray(a.vramLin, a.vramLin + VRAM_SIZE);
  a.vram.set(u8.subarray(WIN, WIN + 0x10000), a.bank << 16);
  u8.set(a.vram.subarray(b << 16, (b << 16) + 0x10000), WIN);
  a.bank = b; a.dirty = true;
};
/** VRAM with the window flushed: what the CRTC scans out */
P.scanout = function () {
  const a = this.adapter();
  a.vram = this.u8.subarray(a.vramLin, a.vramLin + VRAM_SIZE);
  if (!a.flat) a.vram.set(this.u8.subarray(WIN, WIN + 0x10000), a.bank << 16);
  if (a.crtc[0x13]) a.pitch = (a.crtc[0x13] | ((a.crtc[0x3f] & 0x80) << 1)) * 8;   // CRTC offset register: bytes per scanline / 8
  return a;
};
// VFLATD: the VxD that gives display drivers a linear view of banked VRAM. Register (DX=1): ES:DI = the driver's
// bank-switch template (CX bytes), AX = size in 4K pages; returns AX = a selector for the flat framebuffer.
def16('VFLATD', 0, '', 'jmp', function () {
  const fn = this.cpu.edx.value & 0xffff, a = this.adapter();
  if (fn === 1) {
    if (!a.flat) { a.vram.set(this.u8.subarray(WIN, WIN + 0x10000), a.bank << 16); a.flat = true; }
    if (!a.flatSel) a.flatSel = this.allocSels(a.vramLin, VRAM_SIZE);
    this.ax(a.flatSel); this.cpu.edx.value = a.vramLin;
  } else if (fn === 0) this.ax(0x0400);
  else this.ax(0);
  return this.retf16(0);
});
P.setVideoMode = function (mode, clear, hicolor) {
  const a = this.adapter(), m = ET_MODES[mode & 0x7f]; if (!m) return false;
  a.mode = mode & 0x7f; [a.w, a.h, a.bpp] = m; a.hicolor = hicolor || 0;
  if (hicolor) a.bpp = hicolor;
  a.pitch = a.w * (a.bpp >> 3);
  if (clear) { a.vram.fill(0); this.u8.fill(0, WIN, WIN + 0x10000); }
  a.bank = 0; a.dirty = true;
  if (a.bpp === 8 && clear) for (let i = 0; i < 256; i++) { a.dac[3 * i] = a.dac[3 * i + 1] = a.dac[3 * i + 2] = 0; }
  return true;
};
P.portIO = function (port, size, isIn) {
  if (window.W95PORTTRACE) window.W95PORTTRACE(port, size, isIn, this);
  const a = this.adapter(), eax = this.cpu.eax.value;
  if (port >= 0x3b0 && port <= 0x3bf && port !== 0x3bf && !(a.misc & 1) === false) port += 0x20;   // mono CRTC aliases
  if (!isIn) {
    let val = size === 1 ? eax & 0xff : size === 2 ? eax & 0xffff : u32(eax);
    if (size === 2 && [0x3c4, 0x3ce, 0x3d4, 0x3c0].includes(port)) { this.portIO(port, 1, false); this.cpu.eax.value = (eax & ~0xff) | (val >> 8); this.portIO(port + 1, 1, false); this.cpu.eax.value = eax; return; }
    val &= 0xff;
    switch (port) {
      case 0x3c2: a.misc = val; return;
      case 0x3c4: a.idx.seq = val; return;
      case 0x3c5: a.seq[a.idx.seq] = val; return;
      case 0x3ce: a.idx.gc = val; return;
      case 0x3cf: a.gc[a.idx.gc] = val; return;
      case 0x3d4: a.idx.crtc = val; return;
      case 0x3d5: a.crtc[a.idx.crtc] = val; a.dirty = true; return;
      case 0x3c0: if (!a.flip) a.idx.attr = val; else a.attr[a.idx.attr & 0x1f] = val; a.flip ^= 1; return;
      case 0x3c6: if (a.hidden === 4) { a.hicolor = val; a.hidden = 0; } else a.pelMask = val; return;
      case 0x3c7: a.dacR = val * 3; return;
      case 0x3c8: a.dacW = val * 3; a.hidden = 0; return;
      case 0x3c9: a.dac[a.dacW % 768] = val & 0x3f; a.dacW++; a.dirty = true; return;
      case 0x3cd: this.setBank(val & 0x0f); a.segsel = val; return;
      case 0x3bf: case 0x3d8: a.key = val; return;
    }
    return;
  }
  let r = 0xff;
  switch (port) {
    case 0x3cc: r = a.misc; break;
    case 0x3c4: r = a.idx.seq; break;
    case 0x3c5: r = a.seq[a.idx.seq]; break;
    case 0x3ce: r = a.idx.gc; break;
    case 0x3cf: r = a.gc[a.idx.gc]; break;
    case 0x3d4: r = a.idx.crtc; break;
    case 0x3d5: r = a.crtc[a.idx.crtc]; break;
    case 0x3c0: r = a.idx.attr; break;
    case 0x3c1: r = a.attr[a.idx.attr & 0x1f]; break;
    case 0x3da: a.flip = 0; a.status ^= 9; r = a.status; break;
    case 0x3c6: a.hidden = a.hidden >= 4 ? 4 : a.hidden + 1; r = a.hidden === 4 ? a.hicolor : a.pelMask; break;   // four reads expose the Sierra command register
    case 0x3c8: r = a.dacW / 3 | 0; break;
    case 0x3c9: r = a.dac[a.dacR % 768]; a.dacR++; break;
    case 0x3cd: r = a.segsel === undefined ? (a.bank | (a.bank << 4)) : a.segsel; break;
    case 0x3c2: r = 0x10; break;
  }
  if (port !== 0x3c6) a.hidden = 0;
  const m = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
  this.cpu.eax.value = (eax & ~m) | (r & m);
};

// ---------------------------------------------------------------- processor exceptions for 16-bit clients (DPMI 0202h/0203h)
/** dispatch exception `n` at linear `at` to the client's handler with a DPMI exception frame; false if none is installed */
P.exception16 = function (n, at) {
  const cs = this.cpu.cs.value & 0xffff, h = this.exVec && this.exVec[`514:${n}`];
  if (!cs || !h) return false;
  const ss = this.cpu.ss.value & 0xffff, sp0 = this.cpu.esp.value & 0xffff, ssb = this.cpu.ssb.value >>> 0;
  let flags = 0x202; for (const [r, b] of [['cf', 0], ['pf', 2], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) flags |= (this.cpu[r].value & 1) << b;
  const ret = this.thunk16For('DPMI.#2');
  let sp = sp0;
  for (const w of [ss, sp0, flags, cs, (at - this.selBase(cs)) & 0xffff, 0, ret >>> 16, ret & 0xffff]) { sp = (sp - 2) & 0xffff; this.w16(ssb + sp, w); }
  this.cpu.esp.value = lo16(this.cpu.esp.value, sp);
  this.seg('cs', h >>> 16);
  this.cpu.eip.value = u32(this.selBase(h >>> 16) + (h & 0xffff)) | 0;
  return true;
};
def16('DPMI', 2, '', 'jmp', function () {      // the handler's retf lands here: resume at the frame's CS:IP
  const ssb = this.cpu.ssb.value >>> 0, sp = this.cpu.esp.value & 0xffff, f = k => this.r16(ssb + ((sp + 2 * k) & 0xffff));
  const ip = f(1), cs = f(2), flags = f(3), nsp = f(4), nss = f(5);
  for (const [r, b] of [['cf', 0], ['pf', 2], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) this.cpu[r].value = (flags >> b) & 1;
  this.seg('ss', nss); this.cpu.esp.value = lo16(this.cpu.esp.value, nsp);
  this.seg('cs', cs); return u32(this.selBase(cs) + ip);
});
def16('DPMI', 1, '', 'jmp', function () { this.trapped = 'unhandled processor exception in 16-bit code'; return LAYOUT.SENTINEL; });

// ---------------------------------------------------------------- global heap
const GMEM_MOVEABLE = 2, GMEM_ZEROINIT = 0x40;
P.gsel = function (h) { h &= 0xffff; return h ? h | 1 : 0; };
P.gblock = function (h) { return this.ghandles.get(this.gsel(h)); };
P.globalAlloc16 = function (flags, size, owner = 0) {
  size = u32(size); if (!size) size = 1;
  const lin = this.alloc(size + 16, !!(flags & GMEM_ZEROINIT) || true);
  const sel = this.allocSels(lin, size);
  this.ghandles.set(sel, { lin, size, n: Math.ceil(size / 0x10000), flags, lock: 0, owner });
  return flags & GMEM_MOVEABLE ? sel - 1 : sel;
};
P.globalHandleOf = function (h) { const b = this.gblock(h); if (!b) return 0; const sel = this.gsel(h); return b.flags & GMEM_MOVEABLE ? sel - 1 : sel; };

// ---------------------------------------------------------------- local heap (per segment)
const LMEM_MOVEABLE = 2, LMEM_ZEROINIT = 0x40, LMEM_MODIFY = 0x80;
P.lheap = function (sel) {
  sel = (sel || this.cpu.ds.value) & 0xffff;
  const h = this.lheaps.get(sel | 1); if (!h) throw new GuestError(`no local heap in ${sel.toString(16)}`);
  return h;
};
P.localInit = function (sel, start, end) {
  sel = (sel || this.cpu.ds.value) & 0xffff;
  if (start === 0) {
    const b = this.gblock(sel), size = b ? b.size : this.selLimit(sel) + 1;
    start = (size > 0xffff ? 0xffff : size) - 1; if (end > 0xfffe) end = 0xfffe; start -= end; end += start;
  }
  start = (Math.max(start, 16) + 3) & ~3; end &= ~3;
  const base = this.selBase(sel);
  // heap info block (LOCALHEAPINFO) at the bottom; the instance data at DS:6 points to it
  const info = start + 4;
  this.u8.fill(0, base + info, base + info + 0x2a);
  this.w16(base + info + 4, 4); this.w16(base + info + 6, start); this.w16(base + info + 0xa, end - 4); this.w16(base + info + 0x18, 0x20);
  this.w16(base + info + 0x24, 0x200); this.w16(base + info + 0x28, 0x484c);
  this.w16(base + 6, info);
  const lo = (info + 0x2c + 3) & ~3;
  this.lheaps.set(sel | 1, { sel: sel | 1, free: [[lo, end - lo]], blocks: new Map(), handles: new Map(), tables: [] });
  return 1;
};
function lfind(h, size) {
  size = (size + 3) & ~3;
  for (let i = 0; i < h.free.length; i++) {
    const [a, n] = h.free[i];
    if (n >= size) { if (n === size) h.free.splice(i, 1); else h.free[i] = [a + size, n - size]; return a; }
  }
  return 0;
}
function lrelease(h, a, size) {
  size = (size + 3) & ~3; h.free.push([a, size]); h.free.sort((x, y) => x[0] - y[0]);
  for (let i = 0; i + 1 < h.free.length;) { const [a1, n1] = h.free[i], [a2, n2] = h.free[i + 1]; if (a1 + n1 === a2) { h.free[i] = [a1, n1 + n2]; h.free.splice(i + 1, 1); } else i++; }
}
P.localAlloc = function (flags, size, sel) {
  const h = this.lheap(sel), base = this.selBase(h.sel);
  const moveable = !!(flags & LMEM_MOVEABLE), want = Math.max(size, 1) + (moveable ? 2 : 0);
  const a = lfind(h, want); if (!a) return 0;
  h.blocks.set(a, (want + 3) & ~3);
  if (flags & LMEM_ZEROINIT || true) this.u8.fill(0, base + a, base + a + ((want + 3) & ~3));
  if (!moveable) return a;
  let ent = 0;
  for (const t of h.tables) { for (let k = 0; k < t.n; k++) { const e = t.at + 2 + 4 * k; if (this.u8[base + e + 3] === 0xff && this.u8[base + e + 2] === 0xff) { ent = e; break; } } if (ent) break; }
  if (!ent) {
    const n = 0x20, at = lfind(h, 4 + 4 * n); if (!at) { lrelease(h, a, want); h.blocks.delete(a); return 0; }
    h.blocks.set(at, (4 + 4 * n + 3) & ~3); this.w16(base + at, n);
    for (let k = 0; k < n; k++) this.w32(base + at + 2 + 4 * k, 0xffff0000);
    this.w16(base + at + 2 + 4 * n, 0); h.tables.push({ at, n }); ent = at + 2;
    this.w16(base + this.r16(base + 6) + 0x14, h.tables[0].at);
  }
  this.w16(base + ent, a + 2); this.u8[base + ent + 2] = (flags >> 8) & 0x0f; this.u8[base + ent + 3] = 0;
  this.w16(base + a, ent);
  h.handles.set(ent, a);
  return ent;
};
P.localPtr = function (hl, sel) {   // handle -> data offset
  const h = this.lheap(sel); hl &= 0xffff;
  if ((hl & 3) === 2 && h.handles.has(hl)) return this.r16(this.selBase(h.sel) + hl);
  return hl;
};
P.localBlockOf = function (hl, sel) { const h = this.lheap(sel); hl &= 0xffff; return (hl & 3) === 2 && h.handles.has(hl) ? h.handles.get(hl) : hl; };
P.localSize = function (hl, sel) {
  const h = this.lheap(sel), a = this.localBlockOf(hl, sel), n = h.blocks.get(a);
  if (!n) return 0; return (hl & 3) === 2 && h.handles.has(hl & 0xffff) ? n - 2 : n;
};
P.localFree = function (hl, sel) {
  const h = this.lheap(sel), base = this.selBase(h.sel); hl &= 0xffff;
  const a = this.localBlockOf(hl, sel), n = h.blocks.get(a);
  if (!n) return hl;
  h.blocks.delete(a); lrelease(h, a, n);
  if (h.handles.has(hl)) { h.handles.delete(hl); this.w32(base + hl, 0xffff0000); }
  return 0;
};
P.localReAlloc = function (hl, size, flags, sel) {
  const h = this.lheap(sel), base = this.selBase(h.sel); hl &= 0xffff;
  if (flags & LMEM_MODIFY) { if (h.handles.has(hl)) this.u8[base + hl + 2] = (flags >> 8) & 0x0f; return hl; }
  const mov = h.handles.has(hl), a = this.localBlockOf(hl, sel), old = h.blocks.get(a);
  if (!old) return 0;
  const want = (Math.max(size, 1) + (mov ? 2 : 0) + 3) & ~3;
  if (want <= old) {
    if (want < old) { h.blocks.set(a, want); lrelease(h, a + want, old - want); }
    return hl;
  }
  // grow in place when the following range is free
  const fi = h.free.findIndex(([fa, fn]) => fa === a + old && fn >= want - old);
  if (fi >= 0) {
    const [fa, fn] = h.free[fi]; if (fn === want - old) h.free.splice(fi, 1); else h.free[fi] = [fa + want - old, fn - want + old];
    h.blocks.set(a, want); if (flags & LMEM_ZEROINIT) this.u8.fill(0, base + a + old, base + a + want); return hl;
  }
  if (!mov && !(flags & LMEM_MOVEABLE)) return 0;
  const na = lfind(h, want); if (!na) return 0;
  this.u8.copyWithin(base + na, base + a, base + a + old); if (flags & LMEM_ZEROINIT) this.u8.fill(0, base + na + old, base + na + want);
  h.blocks.delete(a); lrelease(h, a, old); h.blocks.set(na, want);
  if (mov) { h.handles.set(hl, na); this.w16(base + hl, na + 2); this.w16(base + na, hl); return hl; }
  return na;
};

// ---------------------------------------------------------------- Local32 heaps (Win95 KERNEL.208..214)
const HTABLE = 0x10000, HPAGE = 0x1000, L32HDR = 0x40;
P.l32 = function (heap) { const h = this.l32heaps && this.l32heaps.get(u32(heap)); if (!h) throw new GuestError(`bad Local32 heap ${u32(heap).toString(16)}`); return h; };
P.local32Init = function (segment, tableSize, heapSize, flags) {
  let segSize = 0;
  if (segment) { segSize = this.selLimit(segment) + 1; if (segSize > 0x10000) segSize = 0x10000; }
  if (heapSize === 0xffffffff) heapSize = 1 << 20;
  heapSize = u32((heapSize + 0xffff) & 0xffff0000); segSize = (segSize + 0xfff) & ~0xfff;
  const tot = segSize + HTABLE + heapSize;
  const base = this.alloc(tot + 0x10000); const hdr = base + segSize;
  this.u8.fill(0, hdr, hdr + HTABLE);
  // header (LOCAL32HEADER): freeListFirst[16], freeListSize[16], freeListLast[16], selectorTableOffset, selectorTableSize, selectorDelta, segment, base, limit, flags, magic, heap
  this.w16(hdr + 0, L32HDR); this.w16(hdr + 64, HPAGE - 4); this.w16(hdr + 32, (HPAGE - L32HDR) / 4);
  for (let i = L32HDR; i < HPAGE - 4; i += 4) this.w32(hdr + i, i + 4);
  this.w16(hdr + 2, 0xffff);
  const nb = (tot + 0x7fff) >> 15;
  const even = this.allocSels(base, tot), odd = this.allocSels(base + 0x8000, tot - 0x8000);
  const heap = { base, hdr, size: tot, lo: hdr + HTABLE, free: [[hdr + HTABLE, heapSize]], blocks: new Map() };
  const st = this.l32alloc(heap, nb * 2);
  for (let i = 0; i < nb; i++) this.w16(st + 2 * i, (i & 1 ? odd : even) + ((i >> 1) << 3));
  this.w32(hdr + 96, st - base); this.w16(hdr + 100, nb * 4); this.w16(hdr + 102, (even - odd) & 0xffff);
  this.w32(hdr + 104, segment || even); this.w32(hdr + 108, base); this.w32(hdr + 112, HPAGE - 1); this.w32(hdr + 116, 0);
  this.w32(hdr + 120, 0x3233484c); this.w32(hdr + 124, 0);
  if (segment) {    // move the segment into the start of the new block
    const old = this.selBase(segment);
    this.u8.copyWithin(base, old, old + segSize);
    this.w32(L.LDT + (segment & 0xfff8), base); this.w32(L.LDT + (segment & 0xfff8) + 4, tot - 1);
    const gb = this.gblock(segment); if (gb) { gb.lin = base; gb.size = tot; }
    this.refreshSegs();
  }
  (this.l32heaps = this.l32heaps || new Map()).set(hdr, heap);
  return hdr;
};
P.l32alloc = function (h, size) {
  size = (Math.max(size, 1) + 7) & ~7;
  for (let i = 0; i < h.free.length; i++) {
    const [a, n] = h.free[i];
    if (n >= size) { if (n === size) h.free.splice(i, 1); else h.free[i] = [a + size, n - size]; h.blocks.set(a, size); this.u8.fill(0, a, a + size); return a; }
  }
  return 0;
};
P.l32free = function (h, a) { const n = h.blocks.get(a); if (!n) return 0; h.blocks.delete(a); lrelease(h, a, n); return 1; };
P.l32toHandle = function (h, type, addr) {   // -> [handle linear or 0, ptr linear or 0]
  const hdr = h.hdr, base = h.base;
  switch (type) {
    case -2: { const p = this.lin(addr); return [p, p]; }
    case -1: { const p = u32(base + addr); return [p, p]; }
    case 0: if (addr >= L32HDR && addr < this.r32(hdr + 112) && !(addr & 3) && this.r32(hdr + addr) >= HTABLE) return [hdr + addr, u32(base + this.r32(hdr + addr))]; return [0, 0];
    case 1: case 2: { const p = type === 1 ? this.lin(addr) : u32(base + addr), off = p - base;
      for (let a = hdr + L32HDR; a < hdr + this.r32(hdr + 112); a += 4) if (this.r32(a) === off) return [a, p];
      return [0, p]; }
  }
  return [0, 0];
};
P.l32fromHandle = function (h, type, handle, ptr) {
  switch (type) {
    case -2: case 1: { const off = ptr - h.base, st = h.base + this.r32(h.hdr + 96); return u32(((this.r16(st + 2 * (off >>> 15))) << 16) | (off & 0x7fff)); }
    case -1: case 2: return u32(ptr - h.base);
    case 0: return u32(handle - h.hdr);
  }
  return 0;
};
P.local32Alloc = function (heap, size, type, flags) {
  const h = this.l32(heap), hdr = h.hdr;
  const ptr = this.l32alloc(h, size); if (!ptr) return 0;
  let handle = ptr;
  if (type >= 0) {
    let page = 0; for (; page < 16; page++) if (this.r16(hdr + 2 * page) !== 0) break;
    if (page === 16) { this.l32free(h, ptr); return 0; }
    if (this.r16(hdr + 2 * page) === 0xffff) {
      this.w32(hdr + 112, this.r32(hdr + 112) + HPAGE);
      this.w16(hdr + 2 * page, 0); this.w16(hdr + 64 + 2 * page, HPAGE - 4); this.w16(hdr + 32 + 2 * page, HPAGE / 4);
      for (let i = 0; i < HPAGE; i += 4) this.w32(hdr + (page << 12) + i, (page << 12) + i + 4);
      if (page < 15) this.w16(hdr + 2 * (page + 1), 0xffff);
      if (page) this.w16(hdr + 2 * page, page << 12);
    }
    const first = this.r16(hdr + 2 * page); handle = hdr + first;
    const left = this.r16(hdr + 32 + 2 * page) - 1; this.w16(hdr + 32 + 2 * page, left);
    if (!left) { this.w16(hdr + 2 * page, 0); this.w16(hdr + 64 + 2 * page, 0); } else this.w16(hdr + 2 * page, this.r32(handle));
    this.w32(handle, ptr - h.base);
  } else this.w32(hdr + 116, this.r32(hdr + 116) | 1);
  return this.l32fromHandle(h, type, handle, ptr);
};
P.local32Free = function (heap, addr, type) {
  const h = this.l32(heap), hdr = h.hdr; const [handle, ptr] = this.l32toHandle(h, type, addr);
  if (!handle) return 0;
  if (type >= 0) {
    const off = handle - hdr, page = off >> 12, n = this.r16(hdr + 32 + 2 * page);
    this.w16(hdr + 32 + 2 * page, n + 1);
    if (n === 0) { this.w16(hdr + 2 * page, off); this.w16(hdr + 64 + 2 * page, off); }
    else { this.w32(hdr + this.r16(hdr + 64 + 2 * page), off); this.w16(hdr + 64 + 2 * page, off); }
    this.w32(handle, 0);
  }
  return this.l32free(h, ptr);
};
P.local32ReAlloc = function (heap, addr, type, size, flags) {
  if (!addr) return this.local32Alloc(heap, size, type, flags);
  const h = this.l32(heap); let [handle, ptr] = this.l32toHandle(h, type, addr);
  if (!handle) return 0;
  const old = h.blocks.get(ptr) || 0, np = this.l32alloc(h, size); if (!np) return 0;
  this.u8.copyWithin(np, ptr, ptr + Math.min(old, size)); this.l32free(h, ptr);
  if (type >= 0) this.w32(handle, np - h.base); else handle = np;
  return this.l32fromHandle(h, type, handle, np);
};

// ---------------------------------------------------------------- KERNEL (16-bit)
const W = (p, a, s, max) => { const b = window.W95FS.encode(s); const n = max === undefined ? b.length : Math.min(b.length, Math.max(max - 1, 0)); p.u8.set(b.subarray(0, n), a); p.u8[a + n] = 0; return n; };
const iniApi = () => window.W95Win32;
const winIni = (p, file, sec, key) => { const { iniGet } = iniApi(); return iniGet(p.fs, file, sec, key); };

def16('KERNEL', 2, 'w', 'v', function (code) { this.exitCode = code; this.host.exited(code); });                        // ExitKernel
def16('KERNEL', 3, '', 'w', () => 0x4f4);                                                                              // GetVersion (3.95)
def16('KERNEL', 4, 'www', 'w', function (sel, start, end) { const r = this.localInit(sel, start, end); this.cpu.ecx.value = lo16(this.cpu.ecx.value, r); return r; });
def16('KERNEL', 5, 'ww', 'w', function (fl, n) { const h = this.localAlloc(fl, n); this.cpu.ecx.value = lo16(this.cpu.ecx.value, h); return h; });   // also in CX
def16('KERNEL', 6, 'www', 'w', function (h, n, fl) { return this.localReAlloc(h, n, fl); });
def16('KERNEL', 7, 'w', 'w', function (h) { return this.localFree(h); });
def16('KERNEL', 8, 'w', 'w', function (h) { const lh = this.lheap(); if (lh.handles.has(h & 0xffff)) { const b = this.selBase(lh.sel); this.u8[b + h + 3]++; } return this.localPtr(h); });
def16('KERNEL', 9, 'w', 'w', function (h) { const lh = this.lheap(); if (lh.handles.has(h & 0xffff)) { const b = this.selBase(lh.sel); if (this.u8[b + h + 3]) this.u8[b + h + 3]--; return this.u8[b + h + 3]; } return 0; });
def16('KERNEL', 10, 'w', 'w', function (h) { return this.localSize(h); });
def16('KERNEL', 11, 'w', 'w', function (p) { const lh = this.lheap(); const b = this.selBase(lh.sel); if ((p & 3) === 2 && lh.blocks.has(p - 2)) return this.r16(b + p - 2); return p; });   // LocalHandle
def16('KERNEL', 12, 'w', 'w', function (h) { const lh = this.lheap(); return lh.handles.has(h & 0xffff) ? this.u8[this.selBase(lh.sel) + h + 3] | (this.u8[this.selBase(lh.sel) + h + 2] << 8) : 0; });  // LocalFlags
def16('KERNEL', 13, 'w', 'w', function () { const lh = this.lheap(); return lh.free.reduce((m, f) => Math.max(m, f[1]), 0); });   // LocalCompact
def16('KERNEL', 121, 'ww', 'w', function () { const lh = this.lheap(); return lh.free.reduce((m, f) => Math.max(m, f[1]), 0); }); // LocalShrink

def16('KERNEL', 15, 'wl', 'w', function (fl, n) { return this.globalAlloc16(fl, n); });
def16('KERNEL', 16, 'wlw', 'w', function (h, n, fl) {   // GlobalReAlloc
  const b = this.gblock(h); if (!b) return 0; n = u32(n) || 1;
  if (fl & LMEM_MODIFY) return h;
  const sel = this.gsel(h);
  if (n > b.size) {
    const cap = (this.allocs.get(b.lin) || 0) - 16;
    if (n > cap) { const nl = this.alloc(n + 16, true); this.u8.copyWithin(nl, b.lin, b.lin + b.size); b.lin = nl; }
    else this.u8.fill(0, b.lin + b.size, b.lin + n);
  }
  b.size = n;
  const need = Math.ceil(n / 0x10000);
  if (need > b.n) { this.freeSels(sel, b.n); const ns = this.allocSels(b.lin, n); if (ns !== sel) { this.ghandles.delete(sel); this.ghandles.set(ns, b); b.n = need; this.refreshSegs(); return b.flags & GMEM_MOVEABLE ? ns - 1 : ns; } b.n = need; }
  for (let k = 0; k < b.n; k++) { this.w32(L.LDT + (sel & 0xfff8) + 8 * k, b.lin + 0x10000 * k); this.w32(L.LDT + (sel & 0xfff8) + 8 * k + 4, (k ? Math.min(n - 0x10000 * k, 0x10000) : n) - 1); }
  this.refreshSegs();
  return h;
});
def16('KERNEL', 17, 'w', 'w', function (h) { const b = this.gblock(h); if (!b) return h; const sel = this.gsel(h); this.ghandles.delete(sel); this.freeSels(sel, b.n); return 0; });
def16('KERNEL', 18, 'w', 'l', function (h) {    // GlobalLock: the selector is returned in CX as well
  const b = this.gblock(h), sel = b ? this.gsel(h) : 0; if (b) b.lock++;
  this.cpu.ecx.value = lo16(this.cpu.ecx.value, sel); return u32(sel << 16);
});
def16('KERNEL', 19, 'w', 'w', function (h) { const b = this.gblock(h); if (b && b.lock) b.lock--; return b ? b.lock : 0; });
def16('KERNEL', 20, 'w', 'l', function (h) { const b = this.gblock(h); return b ? b.size : 0; });
def16('KERNEL', 21, 'w', 'l', function (s) { const b = this.gblock(s); if (!b) return 0; const sel = this.gsel(s); return u32(((b.flags & GMEM_MOVEABLE ? sel - 1 : sel) & 0xffff) | (sel << 16)); });  // GlobalHandle
def16('KERNEL', 197, 'w', 'w', function (h) { return this.gsel(h); });   // GlobalFix
def16('KERNEL', 198, 'w', 'w', function (h) { return 1; });         // GlobalUnfix
def16('KERNEL', 230, 'w', 'w', function (h) { return this.gsel(h); });   // GlobalSmartPageLock
def16('KERNEL', 231, 'w', 'w', function (h) { return this.gsel(h); });   // GlobalSmartPageUnlock
def16('KERNEL', 138, 'w', 'l', function () { return 0x00100010; });       // GetHeapSpaces
def16('KERNEL', 191, 'w', 'w', function (h) { const b = this.gblock(h); return b ? ++b.plock || 1 : 0; });   // GlobalPageLock
def16('KERNEL', 192, 'w', 'w', function (h) { const b = this.gblock(h); return b && b.plock ? --b.plock : 0; });
def16('KERNEL', 111, 'w', 'l', function (h) { const b = this.gblock(h); if (!b) return 0; b.lock++; return u32(this.gsel(h) << 16); });   // GlobalWire
def16('KERNEL', 112, 'w', 'w', function (h) { const b = this.gblock(h); if (b && b.lock) b.lock--; return 1; });
def16('KERNEL', 177, 'ww', 'w', function (src, dst) {    // PrestoChangoSelector: dst = src with code/data swapped
  const acc = this.r32(L.ACC + (src & 0xfff8)); this.setDesc(dst, this.selBase(src), this.selLimit(src), acc ^ 0x0800); this.refreshSegs(); return dst;
});
def16('KERNEL', 170, 'w', 'w', function (s) { return this.allocSels(this.selBase(s), this.selLimit(s) + 1, 0xf300); });   // AllocCStoDSAlias
def16('KERNEL', 184, 'l', 'l', function (n) {           // GlobalDOSAlloc: conventional memory, DX = paragraph, AX = selector
  n = (u32(n) + 15) & ~15; if (this.dosTop + n > 0xa0000) return 0;
  const lin = this.dosTop; this.dosTop += n; this.u8.fill(0, lin, lin + n);
  const sel = this.allocSels(lin, n); this.ghandles.set(sel, { lin, size: n, n: 1, flags: 0, lock: 0, owner: 0 });
  return u32(((lin >> 4) << 16) | sel);
});
def16('KERNEL', 185, 'w', 'w', function (s) { const b = this.gblock(s); if (b) { this.ghandles.delete(this.gsel(s)); this.freeSels(this.gsel(s), b.n); } return 0; });

def16('KERNEL', 36, '', 'w', function () { return this.currentTask(); });                 // GetCurrentTask
P.currentTask = function () {
  if (this.tdb16) return this.tdb16;
  const p = this.alloc(0x200); this.tdb16 = this.allocSels(p, 0x200);
  this.w16(p + 0xfa, 0x4454);           // 'TD'
  return this.tdb16;
};
def16('KERNEL', 47, 's', 'w', function (name) {   // GetModuleHandle
  if (typeof name === 'number') { const m = this.neByHandle(name); return m ? m.hModule : 0; }
  const n = (name || '').toUpperCase().replace(/^.*\\/, '').replace(/\.(DLL|EXE|DRV)$/, '');
  if (JS16.includes(n)) return this.jsModule(n).hModule;
  const m = this.ne.get(n); return m ? m.hModule : 0;
});
def16('KERNEL', 133, 'w', 'w', function (h) { if (h === this.kernelModule().hModule) return h; const m = this.neByHandle(h); return m ? m.hModule : 0; });   // GetExePtr
def16('KERNEL', 228, 'w', 'w', function (h) { const m = this.neByHandle(h); return m ? m.hModule : 0; });
def16('KERNEL', 50, 'wx', 'l', function (h, name) {   // GetProcAddress
  const key = name >>> 16 ? this.readA(this.lin(name)) : name & 0xffff;
  const js = [...(this.jsMods || new Map()).values()].find(m => m.hModule === (h & 0xffff));
  if (js) {
    const ord = typeof key === 'number' ? key : (NAMES16[js.name] || {})[key.toUpperCase()];
    if (!ord || !K16[`${js.name}.#${ord}`]) { console.warn('[ne16] GetProcAddress', js.name, key); return 0; }
    return this.thunk16For(`${js.name}.#${ord}`);
  }
  const m = this.neByHandle(h); return m ? this.neExport(m, key) : 0;
});
def16('KERNEL', 95, 's', 'w', function (name) { const m = this.loadLibrary16(name); return m ? m.hInstance : 2; });    // LoadLibrary
def16('KERNEL', 96, 'w', 'v', function () {});                                                                     // FreeLibrary
def16('KERNEL', 46, 'w', 'v', function () {});                                                                     // FreeModule
def16('KERNEL', 93, 'x', 'l', function (fp) { const s = fp >>> 16; const b = this.gblock(s); return b ? u32((s << 16) | (s - 1)) : 0; });   // GetCodeHandle
def16('KERNEL', 167, 'w', 'w', function () { return 0x400; });                                                     // GetExpWinVer
def16('KERNEL', 354, 'w', 'l', function () { return 0; });                                                         // GetAppCompatFlags
def16('KERNEL', 107, 'w', 'w', function (m) { const o = this.errMode16 || 0; this.errMode16 = m; return o; });     // SetErrorMode
def16('KERNEL', 147, 'l', 'v', function (e) { this.lastError = e; });
def16('KERNEL', 148, '', 'l', function () { return this.lastError || 0; });
def16('KERNEL', 324, 'wx', 'v', function (code) { console.warn('[KERNEL] LogError', code.toString(16)); });
def16('KERNEL', 327, '', 'jmp', function () {    // HandleParamError: BX = error, CX:AX = parameter; errors unwind to the handler at [BP-2]
  const err = this.cpu.ebx.value & 0xffff, ssb = this.cpu.ssb.value >>> 0, sp = this.cpu.esp.value & 0xffff;
  const ip = this.r16(ssb + sp), cs = this.r16(ssb + sp + 2);
  if (window.W95PARAMERR) window.W95PARAMERR(err, cs, ip, this);
  if (err & 0x8000) return this.retf16(0);
  const bp = this.cpu.ebp.value & 0xffff, nbp = this.r16(ssb + bp) & 0xfffe, handler = this.r16(ssb + ((bp - 2) & 0xffff));
  this.cpu.esp.value = lo16(this.cpu.esp.value, bp + 2); this.cpu.ebp.value = lo16(this.cpu.ebp.value, nbp);   // frame popped: SP at the return address
  this.cpu.eax.value = 0; this.cpu.ecx.value = 0; this.cpu.edx.value = 0; this.seg('es', 0);
  this.seg('cs', cs); return u32(this.selBase(cs) + handler);
});
def16('KERNEL', 435, 'w', 'w', () => 0x10);                                     // GetTaskFlags(hTask): every task here is Win32 (TDBF_WIN32)
def16('KERNEL', 237, '', 'v', function () {});                                 // K237 nop
def16('KERNEL', 447, '', 'v', function () {});                                 // WIN32_OldYield
def16('KERNEL', 471, '', 'l', () => 1);                                        // GetCurrentProcessId
def16('KEYBOARD', 100, 'w', 'v', function () {});                              // ScreenSwitchEnable

// selectors
def16('KERNEL', 175, 'w', 'w', function (s) { if (!s) return this.allocSels(0, 1); return this.allocSels(this.selBase(s), this.selLimit(s) + 1, this.r32(L.ACC + (s & 0xfff8))); });
def16('KERNEL', 176, 'w', 'w', function (s) { this.freeSels(s); return 0; });
def16('KERNEL', 186, 'w', 'l', function (s) { return this.selBase(s); });
def16('KERNEL', 187, 'wl', 'w', function (s, b) { this.w32(L.LDT + (s & 0xfff8), b); this.refreshSegs(); return s; });
def16('KERNEL', 188, 'w', 'l', function (s) { return this.selLimit(s); });
def16('KERNEL', 189, 'wl', 'w', function (s, l) { this.w32(L.LDT + (s & 0xfff8) + 4, l); return 0; });
def16('KERNEL', 180, 'xl', 'l', function (sp, d) { const s = sp >>> 16; this.w32(L.LDT + (s & 0xfff8), this.selBase(s) + d); this.refreshSegs(); return sp; });  // LongPtrAdd
def16('KERNEL', 357, 'x', 'l', function (sp) { return this.lin(sp); });              // MapSL
def16('KERNEL', 358, 'l', 'l', function (a) { return this.mapLS(a); });              // MapLS
def16('KERNEL', 359, 'x', 'v', function () {});                                      // UnMapLS
def16('KERNEL', 613, '', 'jmp', function () {          // HugeMapLS: EAX = linear, ECX = size -> EAX = 16:16 (tiled selectors), ECX = handle
  const lin = u32(this.cpu.eax.value), n = u32(this.cpu.ecx.value); this.cpu.cf.value = 0;
  if (!lin) { this.cpu.eax.value = 0; this.cpu.ecx.value = 0; return this.retf16(0); }
  const sel = this.allocSels(lin, Math.max(n, 1));
  this.cpu.eax.value = (sel << 16) | 0; this.cpu.ecx.value = sel | (Math.ceil(Math.max(n, 1) / 0x10000) << 16);
  return this.retf16(0);
});
def16('KERNEL', 614, '', 'jmp', function () {          // HugeUnMapLS: ECX = the handle HugeMapLS returned
  const h = u32(this.cpu.ecx.value); if (h & 0xffff) this.freeSels(h & 0xffff, h >>> 16 || 1);
  return this.retf16(0);
});
def16('KERNEL', 600, 'xxwwwl', 'w', function () { return 0; });                      // AllocCodeAlias (unused path)
def16('KERNEL', 601, 'w', 'v', function () {});

// pointer validation
const okPtr = function (sp, n) { if (!(sp >>> 16)) return 1; const s = sp >>> 16; if (!this.selValid(s)) return 1; return (sp & 0xffff) + Math.max(n, 1) - 1 > this.selLimit(s) ? 1 : 0; };
def16('KERNEL', 334, 'xw', 'w', function (sp, n) { return okPtr.call(this, sp, n); });
def16('KERNEL', 335, 'xw', 'w', function (sp, n) { return okPtr.call(this, sp, n); });
def16('KERNEL', 346, 'xl', 'w', function (sp, n) { return okPtr.call(this, sp, n); });
def16('KERNEL', 347, 'xl', 'w', function (sp, n) { return okPtr.call(this, sp, n); });
def16('KERNEL', 627, 'll', 'w', function (a, n) { return a ? 0 : 1; });             // IsBadFlatReadWritePtr

// strings
def16('KERNEL', 88, 'px', 'l', function (d, s) { const t = this.readA(this.lin(s)) || ''; W(this, d, t); return this.mapLS(d); });
def16('KERNEL', 89, 'px', 'l', function (d, s) { const a = this.readA(d) || '', t = this.readA(this.lin(s)) || ''; W(this, d, a + t); return this.mapLS(d); });
def16('KERNEL', 90, 'p', 'w', function (s) { return s ? (this.readA(s) || '').length : 0; });
def16('KERNEL', 353, 'xpw', 'l', function (dsp, s, n) { const d = this.lin(dsp); W(this, d, this.readA(s) || '', n); return dsp; });
def16('KERNEL', 87, 'pp', 'i', function (a, b) { const x = this.readA(a) || '', y = this.readA(b) || ''; return x < y ? -1 : x > y ? 1 : 0; });   // lstrcmp
def16('KERNEL', 78, 'xx', 'l', function (start, cur) { return cur > start ? cur - 1 : start; });    // AnsiPrev
def16('KERNEL', 348, 'ppl', 'v', function (d, s, n) { this.u8.copyWithin(d, s, s + n); });     // hmemcpy
def16('KERNEL', 102, '', 'jmp', function () { const r = INTS[0x21].call(this); return r === LAYOUT.SENTINEL ? r : this.retf16(0); });   // DOS3Call

// directories, profile, registry
def16('KERNEL', 134, 'pw', 'w', function (b, n) { return W(this, b, 'C:\\WINDOWS', n); });
def16('KERNEL', 135, 'pw', 'w', function (b, n) { return W(this, b, 'C:\\WINDOWS\\SYSTEM', n); });
def16('KERNEL', 57, 'ssi', 'w', function (app, key, d) { const v = winIni(this, 'WIN.INI', app, key); const n = v === null ? NaN : parseInt(v, 10); return isNaN(n) ? d & 0xffff : n & 0xffff; });
def16('KERNEL', 127, 'ssis', 'w', function (app, key, d, f) { const v = winIni(this, f, app, key); const n = v === null ? NaN : parseInt(v, 10); return isNaN(n) ? d & 0xffff : n & 0xffff; });
const profStr = function (file, app, key, d, buf, n) {
  if (!n) return 0;
  if (key === null) {   // enumerate keys of a section
    const ini = window.W95Win32.iniRead ? window.W95Win32.iniRead(this.fs, file) : new Map();
    const s = ini.get((app || '').toLowerCase()); let o = 0;
    if (s) for (const k of s.keys.values()) { const b = k.name; if (o + b.length + 2 > n) break; W(this, buf + o, b); o += b.length + 1; }
    this.u8[buf + o] = 0; return o;
  }
  const v = winIni(this, file, app, key); return W(this, buf, v === null ? (d || '') : v, n);
};
def16('KERNEL', 58, 'sssxw', 'w', function (app, key, d, buf, n) { return profStr.call(this, 'WIN.INI', app, key, d, this.lin(buf), n); });
def16('KERNEL', 128, 'sssxws', 'w', function (app, key, d, buf, n, f) { return profStr.call(this, f, app, key, d, this.lin(buf), n); });
def16('KERNEL', 59, 'sss', 'w', function (app, key, v) { try { window.W95Win32.iniSet(this.fs, 'WIN.INI', app, key, v); return 1; } catch (_) { return 0; } });
def16('KERNEL', 217, 'lpp', 'l', function (hk, sub, out) { return API.ADVAPI32.RegOpenKeyA[1].call(this, hk, sub, out); });
def16('KERNEL', 218, 'lpp', 'l', function (hk, sub, out) { return API.ADVAPI32.RegCreateKeyA ? API.ADVAPI32.RegCreateKeyA[1].call(this, hk, sub, out) : API.ADVAPI32.RegOpenKeyA[1].call(this, hk, sub, out); });
def16('KERNEL', 220, 'l', 'l', () => 0);
def16('KERNEL', 221, 'lplpl', 'l', () => 0);
def16('KERNEL', 222, 'lp', 'l', () => 2);
def16('KERNEL', 225, 'lppppp', 'l', function (hk, name, res, type, data, cb) { return API.ADVAPI32.RegQueryValueExA[1].call(this, hk, name, res, type, data, cb); });
def16('KERNEL', 226, 'lpllpl', 'l', () => 0);
def16('KERNEL', 227, 'l', 'l', () => 0);                                                              // RegFlushKey: the registry store writes through
def16('KERNEL', 216, 'llpl', 'l', function (hk, i, buf, n) { return API.ADVAPI32.RegEnumKeyA[1].call(this, hk, i, buf, n); });   // RegEnumKey
def16('KERNEL', 224, 'lppp', 'l', function (hk, sub, data, cb) { return API.ADVAPI32.RegQueryValueA[1].call(this, hk, sub, data, cb); });   // RegQueryValue

// files (DOS handles over the in-memory FS)
const OF = { READ: 0, WRITE: 1, READWRITE: 2, PARSE: 0x100, DELETE: 0x200, CREATE: 0x1000, EXIST: 0x4000 };
P.findFile16 = function (name) {
  if (/^[a-z]:\\/i.test(name) || name.startsWith('\\')) return this.fs.exists(name) ? this.fs.realpath(name) : null;
  for (const d of [this.fs.cwd, 'C:\\WINDOWS', 'C:\\WINDOWS\\SYSTEM']) { const f = window.W95FS.join(d, name); if (this.fs.exists(f)) return this.fs.realpath(f); }
  return null;
};
P.dosOpen = function (path, mode) {
  try { const fd = this.fs.open(path, mode); const h = this.nextDosFile++; this.dosFiles.set(h, { fd, path }); return h; }
  catch (e) { if (e instanceof window.W95FS.FSError) { this.lastError = e.code || 2; return 0xffff; } throw e; }
};
def16('KERNEL', 74, 'spw', 'w', function (name, of, style) {   // OpenFile
  const full = style & OF.CREATE ? (/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name)) : this.findFile16(name);
  if (of) { this.u8.fill(0, of, of + 136); this.u8[of] = 136; this.u8[of + 1] = 1; }
  if (!full) { if (of) this.w16(of + 2, 2); return 0xffff; }
  if (of) W(this, of + 8, full.toUpperCase(), 128);
  if (style & OF.PARSE) return 0;
  if (style & OF.DELETE) { try { this.fs.unlink(full); return 1; } catch (_) { return 0xffff; } }
  if (style & OF.EXIST) return 1;
  const mode = style & OF.CREATE ? 'w+' : (style & 3) === 0 ? 'r' : 'r+';
  return this.dosOpen(full, mode);
});
def16('KERNEL', 360, 'spw', 'w', function (name, of, style) { return K16['KERNEL.#74'][2].call(this, name, of, style); });   // OpenFileEx
def16('KERNEL', 85, 'sw', 'w', function (name, mode) { const f = this.findFile16(name); return f ? this.dosOpen(f, (mode & 3) === 0 ? 'r' : 'r+') : 0xffff; });  // _lopen
def16('KERNEL', 83, 'sw', 'w', function (name) { return this.dosOpen(/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name), 'w+'); });   // _lcreat
def16('KERNEL', 81, 'w', 'w', function (h) { const f = this.dosFiles.get(h); if (!f) return 0xffff; this.fs.close(f.fd); this.dosFiles.delete(h); return 0; });
const lread = function (h, buf, n) { const f = this.dosFiles.get(h); if (!f) return 0xffffffff; const b = this.fs.read(f.fd, n); this.u8.set(b, buf); return b.length; };
const lwrite = function (h, buf, n) { const f = this.dosFiles.get(h); if (!f) return 0xffffffff; return this.fs.write(f.fd, this.u8.slice(buf, buf + n)); };
def16('KERNEL', 82, 'wpw', 'w', function (h, b, n) { return lread.call(this, h, b, n); });
def16('KERNEL', 349, 'wpl', 'l', function (h, b, n) { return lread.call(this, h, b, n); });
def16('KERNEL', 86, 'wpw', 'w', function (h, b, n) { return lwrite.call(this, h, b, n); });
def16('KERNEL', 350, 'wpl', 'l', function (h, b, n) { return lwrite.call(this, h, b, n); });
def16('KERNEL', 84, 'wlw', 'l', function (h, off, how) { const f = this.dosFiles.get(h); if (!f) return 0xffffffff; return this.fs.seek(f.fd, off | 0, how); });
def16('KERNEL', 146, 's', 'w', function (n) { try { this.fs.unlink(n); return 1; } catch (_) { return 0; } });
def16('KERNEL', 92, 'w', 'w', function () { return 0x80 | 0x43; });
def16('KERNEL', 97, 'wswp', 'w', function (drv, pre, uniq, buf) { const u = uniq || ((Date.now() & 0xffff) | 1); W(this, buf, `C:\\WINDOWS\\TEMP\\~${(pre || 'TMP').slice(0, 3)}${u.toString(16).toUpperCase().padStart(4, '0')}.TMP`); return u; });

// atoms (local to DS)
P.atomTable = function () { const s = this.cpu.ds.value | 1; if (!this.atoms.has(s)) this.atoms.set(s, { byName: new Map(), byId: new Map(), next: 0xc000 }); return this.atoms.get(s); };
const atomKey = s => typeof s === 'number' ? null : s.toUpperCase();
def16('KERNEL', 68, 'w', 'w', function () { this.atomTable(); return 1; });
def16('KERNEL', 70, 's', 'w', function (s) {
  if (typeof s === 'number') return s; if (s && s[0] === '#') return parseInt(s.slice(1), 10) & 0xffff;
  const t = this.atomTable(), k = atomKey(s); let a = t.byName.get(k);
  if (!a) { a = { id: t.next++, name: s, n: 0 }; t.byName.set(k, a); t.byId.set(a.id, a); } a.n++; return a.id;
});
def16('KERNEL', 69, 's', 'w', function (s) { if (typeof s === 'number') return s; const a = this.atomTable().byName.get(atomKey(s)); return a ? a.id : 0; });
def16('KERNEL', 71, 'w', 'w', function (id) { const t = this.atomTable(), a = t.byId.get(id); if (a && !--a.n) { t.byId.delete(id); t.byName.delete(atomKey(a.name)); } return 0; });
def16('KERNEL', 72, 'wpw', 'w', function (id, buf, n) { if (id < 0xc000) return W(this, buf, '#' + id, n); const a = this.atomTable().byId.get(id); return a ? W(this, buf, a.name, n) : 0; });

// resources in NE modules
P.neResources = function (m) {
  if (m.res) return m.res;
  const d = m.file, n = rd.u32(d, 0x3c), rt = n + rd.u16(d, n + 0x24); const out = [];
  if (rd.u16(d, n + 0x24) === rd.u16(d, n + 0x26)) return (m.res = out);
  const shift = rd.u16(d, rt); let q = rt + 2;
  const nm = v => v & 0x8000 ? v & 0x7fff : String.fromCharCode(...d.subarray(rt + v + 1, rt + v + 1 + d[rt + v])).toUpperCase();
  for (;;) {
    const type = rd.u16(d, q); if (!type) break; const cnt = rd.u16(d, q + 2); q += 8;
    for (let i = 0; i < cnt; i++, q += 12) out.push({ type: nm(type), id: nm(rd.u16(d, q + 6)), off: rd.u16(d, q) << shift, len: rd.u16(d, q + 2) << shift });
  }
  return (m.res = out);
};
const resKey = function (sp) { if (!(sp >>> 16)) return sp & 0xffff; const s = this.readA(this.lin(sp)); return s[0] === '#' ? parseInt(s.slice(1), 10) : s.toUpperCase(); };
def16('KERNEL', 60, 'wxx', 'w', function (h, name, type) {     // FindResource
  const m = this.neByHandle(h); if (!m) return 0;
  const k = resKey.call(this, name), t = resKey.call(this, type);
  const i = this.neResources(m).findIndex(r => r.id === k && r.type === t);
  if (i < 0) return 0;
  (this.resHandles = this.resHandles || []).push({ m, r: m.res[i] }); return this.resHandles.length * 4;
});
def16('KERNEL', 61, 'ww', 'w', function (h, hr) {               // LoadResource
  const e = this.resHandles && this.resHandles[hr / 4 - 1]; if (!e) return 0;
  if (!e.g) { e.g = this.globalAlloc16(0, e.r.len); this.u8.set(e.m.file.subarray(e.r.off, e.r.off + e.r.len), this.gblock(e.g).lin); }
  return e.g;
});
def16('KERNEL', 62, 'w', 'l', function (h) { const b = this.gblock(h); return b ? u32(this.gsel(h) << 16) : 0; });   // LockResource
def16('KERNEL', 63, 'w', 'w', () => 0);

// USER services the 16-bit system modules call (the window manager itself is JS)
def16('USER', 176, 'wwpi', 'i', function (hInst, id, buf, n) {     // LoadString from an NE module's RT_STRING blocks
  const m = this.neByHandle(hInst); if (!m) return 0;
  const r = this.neResources(m).find(x => x.type === 6 && x.id === (id >> 4) + 1); if (!r) { if (n > 0) this.u8[buf] = 0; return 0; }
  let o = r.off;
  for (let k = 0; k < (id & 15); k++) o += 1 + m.file[o];
  const len = m.file[o], str = String.fromCharCode(...m.file.subarray(o + 1, o + 1 + len));
  return n > 0 ? W(this, buf, str, n) : len;
});
def16('USER', 275, '', 'v', function () {});        // RepaintScreen
NAMES16_INIT.USER = { LOADSTRING: 176, REPAINTSCREEN: 275 };

// Local32
def16('KERNEL', 208, 'wlll', 'l', function (seg, t, hs, fl) { return this.local32Init(seg, t, hs, fl); });
def16('KERNEL', 209, 'llil', 'l', function (heap, size, type, fl) { return this.local32Alloc(heap, size, type, fl); });
def16('KERNEL', 210, 'llill', 'l', function (heap, addr, type, size, fl) { return this.local32ReAlloc(heap, addr, type, size, fl); });
def16('KERNEL', 211, 'lli', 'w', function (heap, addr, type) { return this.local32Free(heap, addr, type); });
def16('KERNEL', 213, 'llii', 'l', function (heap, addr, t1, t2) { const h = this.l32(heap); const [hd, p] = this.l32toHandle(h, t1, addr); return hd ? this.l32fromHandle(h, t2, hd, p) : 0; });
def16('KERNEL', 214, 'lli', 'l', function (heap, addr, type) { const h = this.l32(heap); const [hd, p] = this.l32toHandle(h, type, addr); return hd ? (h.blocks.get(p) || 0) : 0; });
def16('KERNEL', 229, 'l', 'w', function (heap) { return this.r32(this.l32(heap).hdr + 104); });
def16('KERNEL', 444, 'pw', 'w', () => 0);
def16('KERNEL', 445, 'pw', 'w', () => 0);
def16('KERNEL', 446, 'p', 'w', () => 0);

// 32-bit DLL loading from 16-bit code, and the SL (16 -> 32) thunk transition
def16('KERNEL', 482, 's', 'l', function (name) {          // LoadSystemLibrary32
  const n = (name || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, '');
  const m = this.loadDll(n); if (!m) return 0;
  this.runPendingInits();
  return m.base;
});
def16('KERNEL', 619, 'wxl', 'w', function () { return 1; });                // RegisterCBClient
// IsSLThunklet: whether a far pointer addresses a 16-to-32 thunklet (push dword, push dword, jmp far), as KRNL386 checks
def16('KERNEL', 612, 'x', 'w', function (sp) {
  if (!(sp >>> 16) || !this.selValid(sp >>> 16)) return 0;
  const a = this.lin(sp);
  return this.r16(a) === 0x6866 && this.r16(a + 6) === 0x6866 && this.u8[a + 12] === 0xea ? 1 : 0;
});
// InitCBClient: the 32-bit glue routine (USER32's) that 16-to-32 callbacks of registered clients go through
def16('KERNEL', 623, 'l', 'w', function (glue) { this.cbGlueLS = glue; return 1; });
def16('KERNEL', 605, 'll', 'l', function (target, rel) { return this.slThunklet(target, rel); });   // AllocSLThunkletCallback
def16('KERNEL', 630, '', 'jmp', function () {                                 // C16ThkSL
  // the stub would load EDX from the 32-bit target table at [EDX + CX] and far-jump to the 16 -> 32 transition
  const target = this.r32(u32(this.cpu.edx.value + (this.cpu.ecx.value & 0xffff)));
  return this.enter32from16(target);
});

// ---- what USER.EXE's start-up asks of KERNEL (each read from KRNL386.EXE's own code where it has no public name)
def16('KERNEL', 340, 's', 'v', function () {});                                  // DiagOutput: boot-log text, kept only under a debugger
def16('KERNEL', 480, '', 'v', function () {});                                   // _EnterWin16Lock: one thread runs here, so nothing to exclude
def16('KERNEL', 481, '', 'v', function () {});                                   // _LeaveWin16Lock
// KRNL386's bridges to Win32 events and threads (each a thunk into KERNEL32 in the real KERNEL). One thread runs
// here: a wait finds an event signalled or times out at once, and the thread id is the one KERNEL32 reports.
const ev16 = (p, h) => { const o = p.obj(h); return o && o.kind === 'event' ? o : null; };
def16('KERNEL', 457, 'll', 'l', function (manual, initial) { return this.newHandle({ kind: 'event', manual: !!manual, set: !!initial }); });   // CreateW32Event
def16('KERNEL', 458, 'l', 'l', function (h) { const e = ev16(this, h); if (!e) return 0; e.set = true; return 1; });   // SetW32Event
def16('KERNEL', 459, 'l', 'l', function (h) { const e = ev16(this, h); if (!e) return 0; e.set = false; return 1; });  // ResetW32Event
def16('KERNEL', 460, 'll', 'l', function (h, ms) {                                                     // WaitForSingleObject
  const e = ev16(this, h); if (!e) return 0xffffffff;
  if (!e.set) return 0x102; if (!e.manual) e.set = false; return 0;
});
def16('KERNEL', 461, 'llll', 'l', function (n, ph, all, ms) {                                        // WaitForMultipleObjects
  const hs = [...Array(n)].map((_, i) => ev16(this, this.r32(this.lin(ph) + 4 * i)));
  if (all) { if (!hs.every(e => e && e.set)) return 0x102; for (const e of hs) if (!e.manual) e.set = false; return 0; }
  const i = hs.findIndex(e => e && e.set); if (i < 0) return 0x102; if (!hs[i].manual) hs[i].set = false; return i;
});
def16('KERNEL', 462, '', 'l', function () { return this.thread16 ? this.thread16.id : MAIN_TID; });       // GetCurrentThreadId (the main thread is the id KERNEL32 reports)
def16('KERNEL', 463, 'lw', 'w', function (tid, hq) { const t = thr(this, tid), old = t.queue || 0; t.queue = hq; return old; });   // SetThreadQueue
def16('KERNEL', 464, 'l', 'w', function (tid) { return thr(this, tid).queue || 0; });                     // GetThreadQueue
def16('KERNEL', 624, 'll', 'v', function (tid, hq) { thr(this, tid).queue = hq & 0xffff; });                 // SetFastQueue: the queue field (38h) of the thread
// GetFastQueue: the current thread's queue, created when it has none by USER's InitThreadInput (USER.409), which KRNL386
// keeps a pointer to and calls with (0, 4) for a 16-bit thread
def16('KERNEL', 625, '', 'w', function () {
  const t = thr(this, 0); if (t.queue) return t.queue;
  const u = this.ne.get('USER'), ep = u && u.meta && this.neExport(u, 409);
  if (!ep) return 0;
  const r = this.call16(ep >>> 16, ep & 0xffff, [['w', 0], ['w', 4]]);
  return t.queue || r.ax;
});
// Get/SetProcessDword: a process's fields by the GPD_ offsets (0 user data, -4 flags, -8 parent, -12..-32 its
// STARTUPINFO, -36 PDB, -40 THDB, -44 expected Windows version, -48 hInstance, -52 load-done event, -56 app
// compatibility flags). Nothing is set until someone sets it, but the version, which is 4.0.
const GPD = { 0: 0, '-4': 0, '-8': 0, '-12': 0, '-16': 0, '-20': 0, '-24': 0, '-28': 0, '-32': 0, '-36': 0, '-40': 0, '-44': 0x400, '-48': 0, '-52': 0, '-56': 0 };
const pdw = (p, pid, off) => {
  if (!(off in GPD)) throw new GuestError(`GetProcessDword offset ${off}`);
  p.procDword = p.procDword || new Map(); if (!p.procDword.has(pid)) p.procDword.set(pid, { ...GPD }); return p.procDword.get(pid);
};
def16('KERNEL', 485, 'li', 'l', function (pid, off) { return pdw(this, pid, off)[off] >>> 0; });
def16('KERNEL', 484, 'lil', 'v', function (pid, off, v) { pdw(this, pid, off)[off] = v; });
// VWIN32's events as KRNL386 reaches them (VWin32_EventCreate .. EventSet, and 479, which sets one unless the
// Win16Lock is held): one thread runs here, so a wait finds the event set or returns at once
def16('KERNEL', 442, '', 'l', function () { return this.newHandle({ kind: 'event', manual: false, set: false }); });   // VWin32_EventCreate
def16('KERNEL', 443, 'l', 'v', function (h) { this.handles.delete(h); });                                              // VWin32_EventDestroy
def16('KERNEL', 450, 'l', 'v', function (h) {                                                                         // VWin32_EventWait
  const e = ev16(this, h); if (!e) return;
  if (!e.set && this.thread16 && this.thread16.id !== MAIN_TID && this.depth === this.thread16.depth) { this.thread16.wait = e; return YIELD; }
  e.set = false;
});
def16('KERNEL', 451, 'l', 'v', function (h) { const e = ev16(this, h); if (e) e.set = true; });                      // VWin32_EventSet
def16('KERNEL', 479, 'l', 'v', function (h) { const e = ev16(this, h); if (e) e.set = true; });
// ---- threads. One processor runs them one at a time: a thread created here starts when the scheduler next runs
// (threads16, between slices of the main thread), runs until it waits on an event that is not set (then yields
// in the wait, resuming there once the event is set), and ends when its procedure returns.
const MAIN_TID = 0x51;
const thr = (p, tid) => {   // a thread's record by id (0 or the main thread's id: the current/main thread)
  p.threadsById = p.threadsById || new Map([[MAIN_TID, { id: MAIN_TID }]]);
  const id = tid || (p.thread16 ? p.thread16.id : MAIN_TID);
  if (!p.threadsById.has(id)) p.threadsById.set(id, { id });
  return p.threadsById.get(id);
};
def16('KERNEL', 441, 'llllll', 'l', function (attr, stack, start, param, flags, ptid) {   // CreateThread16
  thr(this, MAIN_TID);
  const id = MAIN_TID + this.threadsById.size, t = thr(this, id);
  Object.assign(t, { start, param, stack: Math.max(stack || 0, 0x4000), state: 'new', ctx: null, wait: null });
  if (ptid) this.w32(this.lin(ptid), id);
  return this.newHandle({ kind: 'thread', id });
});
const CTX = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'eip', 'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb'];
P.saveCtx16 = function () { const c = {}; for (const r of CTX) c[r] = this.cpu[r].value; c.depth = this.depth; c.stackLevel = this.stackLevel; return c; };
P.loadCtx16 = function (c) { for (const r of CTX) this.cpu[r].value = c[r]; this.depth = c.depth; this.stackLevel = c.stackLevel; };
/** run the threads that can run; the host calls this between slices of the main thread */
P.threads16 = function () {
  if (!this.threadsById || this.thread16 || this.depth) return;
  for (const t of this.threadsById.values()) {
    if (t.id === MAIN_TID || t.state === 'done' || (t.state === 'waiting' && !(t.wait && t.wait.set))) continue;
    const main = this.saveCtx16();
    this.thread16 = t;
    let r;
    try {
      if (t.state === 'new') {
        // its own flat stack, then a far call of its procedure (it returns to the sentinel)
        t.stackBase = this.alloc(t.stack); this.cpu.esp.value = t.stackBase + t.stack - 16; this.seg('ss', 0);
        this.cpu.ssb.value = 0; this.depth = 0; this.stackLevel = main.stackLevel;
        t.state = 'running';
        r = this.start16(t.start >>> 16, t.start & 0xffff, [['l', t.param]]);
      } else {
        this.loadCtx16(t.ctx); t.state = 'running'; t.wait = null;
        r = this.runAt(u32(this.cpu.eip.value));
      }
      if (r === 1) { t.ctx = this.saveCtx16(); t.state = 'waiting'; }
      else { t.state = 'done'; if (r !== 0 && this.trapped) console.warn('[ne16] thread', t.id, this.trapped); }
    } finally { this.thread16 = null; this.loadCtx16(main); }
  }
};
/** a far call into 16-bit code that may yield: returns runAt's result (0 returned, 1 yielded) and leaves the
 *  CPU state as the code left it */
P.start16 = function (sel, off, args) {
  // a thread's stack gets a selector of its own (the per-level aliases are the main thread's, redefined as it calls)
  const flat = u32(this.cpu.esp.value), base = (flat - 0xfff0) & ~0xf;
  let ssel;
  if (this.thread16) ssel = this.thread16.ssel || (this.thread16.ssel = this.allocSels(base, 0x10000));
  else { ssel = L.STK + 8 * this.stackLevel++; this.setDesc(ssel, base, 0xffff, 0xf300); }
  this.seg('ss', ssel);
  let sp = flat - 16 - base;
  for (const [t, v] of args) { if (t === 'w') { sp -= 2; this.w16(base + sp, v); } else { sp -= 4; this.w32(base + sp, v); } }
  sp -= 2; this.w16(base + sp, L.SENT); sp -= 2; this.w16(base + sp, 0);
  this.cpu.esp.value = sp; this.seg('cs', sel);
  this.depth++; if (this.thread16) this.thread16.depth = this.depth;
  return this.runAt(u32(this.selBase(sel) + off));
};
// the 32-bit modules from 16-bit code: LoadLibrary32 and GetProcAddress32 (by name, or by ordinal as a low word)
def16('KERNEL', 452, 's', 'l', function (name) {
  const n = (name || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, '');
  const m = this.byName.get(n) || this.loadDll(n); return m ? m.base : 0;
});
def16('KERNEL', 453, 'lx', 'l', function (h, name) {
  const m = this.modules.find(x => x.base === h); if (!m) return 0;
  if (!(name >>> 16)) return m.exports.get('#' + (name & 0xffff)) || 0;
  return m.exports.get(this.readA(this.lin(name))) || 0;
});
def16('KERNEL', 476, 'l', 'l', function (h) { return h; });                                            // ConvertToGlobalHandle: one process, so already global
def16('KERNEL', 474, 'l', 'w', function (h) { return this.handles.delete(h) ? 1 : 0; });               // CloseW32Handle
def16('KERNEL', 105, '', 'w', function () { return 0x0400; });                                         // GetExeVersion: system code expects Windows 4.0
def16('KERNEL', 132, '', 'l', function () { return 0x0c29; });                                         // GetWinFlags: protected mode, 486, enhanced, 80x87, paging
def16('KERNEL', 1, 'w', 'v', function (code) { throw new GuestError(`FatalExit(${code})`); });
def16('KERNEL', 22, 'w', 'w', function (h) { const b = this.gblock(h); return b ? (b.lock & 0xff) : 0; });   // GlobalFlags: the lock count
// one task runs here, so yielding, task events and priorities have nothing to act on
def16('KERNEL', 29, '', 'v', function () {});                                                          // Yield
def16('KERNEL', 117, '', 'v', function () {});                                                         // OldYield
def16('KERNEL', 150, 'w', 'v', function () {});                                                        // DirectedYield
def16('KERNEL', 30, 'w', 'w', function () { return 0; });                                              // WaitEvent
def16('KERNEL', 31, 'w', 'v', function () {});                                                         // PostEvent
def16('KERNEL', 32, 'wi', 'w', function () { return 0; });                                             // SetPriority
def16('KERNEL', 33, 'w', 'w', function () { return 0; });                                              // LockCurrentTask
def16('KERNEL', 49, 'wpi', 'w', function (h, buf, n) {                                                 // GetModuleFileName
  const m = this.neByHandle(h), f = m && m.fileName ? `C:\\WINDOWS\\SYSTEM\\${m.fileName}` : m && m.path ? m.path : (this.host && this.host.path) || '';
  return W(this, buf, f, n);
});
def16('KERNEL', 73, 'w', 'w', function (id) { return this.atomTable().byId.has(id) ? id : 0; });     // GetAtomHandle
def16('KERNEL', 129, 'ssss', 'w', function (app, key, v, f) {                                         // WritePrivateProfileString
  try { window.W95Win32.iniSet(this.fs, f, app, key === null ? null : key, v); return 1; } catch (_) { return 0; }
});
def16('KERNEL', 235, '', 'v', function () {});                                                         // InvalidateNlsCache: nothing cached
def16('KERNEL', 336, 'x', 'w', function (sp) { return okPtr.call(this, sp, 1); });                     // IsBadCodePtr
def16('KERNEL', 337, 'xw', 'w', function (sp, n) {                                                     // IsBadStringPtr
  if (!(sp >>> 16) || !this.selValid(sp >>> 16)) return 1;
  const a = this.lin(sp), lim = this.selLimit(sp >>> 16); for (let i = 0; i < n; i++) { if ((sp & 0xffff) + i > lim) return 1; if (!this.u8[a + i]) break; } return 0;
});
def16('KERNEL', 352, 'xpi', 'l', function (dsp, s, n) {                                               // lstrcatn
  const d = this.lin(dsp), a = this.readA(d) || ''; if (n > a.length) W(this, d, a + (this.readA(s) || ''), n); return dsp;
});
/** 16 -> 32 transition for SL thunks: EBX + 0x16 addresses the 16-bit arguments; the target returns with CL = argument bytes */
P.enter32from16 = function (target) {
  const ctx = { esp: this.cpu.esp.value, ebp: this.cpu.ebp.value, esi: this.cpu.esi.value, edi: this.cpu.edi.value, ebx: this.cpu.ebx.value };
  for (const [s, b] of SEGS) { ctx[s] = this.cpu[s].value; ctx[b] = this.cpu[b].value; }
  const frame = u32((this.cpu.ssb.value >>> 0) + (this.cpu.esp.value & 0xffff));
  ctx.frame = frame;
  this.ctx16.push(ctx);
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = LAYOUT.TIB;
  this.cpu.ebx.value = frame - 0x12;
  let esp = (frame - 0x80) & ~3;
  esp -= 4; this.w32(esp, this.ret16Thunk());
  this.cpu.esp.value = esp; this.cpu.ebp.value = esp;
  return target;
};
/** run a 32-bit guest call while the CPU is in a 16-bit context: switch to the flat stack below SS:SP and back */
P.callFlatFrom16 = function (addr, args) {
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  const flat = u32((this.cpu.ssb.value >>> 0) + (this.cpu.esp.value & 0xffff));
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = LAYOUT.TIB;
  this.cpu.esp.value = (flat - 0x200) & ~3;
  try { return this.call(addr, args); }
  finally {
    const eax = this.cpu.eax.value, edx = this.cpu.edx.value;
    for (const r of GPR) this.cpu[r].value = save[r]; for (const [s, b] of SEGS) { this.cpu[s].value = save[s]; this.cpu[b].value = save[b]; }
    this.cpu.eax.value = eax; this.cpu.edx.value = edx;
  }
};
P.ret16Thunk = function () { return this.thunkFor('KERNEL32', '__Return16'); };
API.KERNEL32 = API.KERNEL32 || {};
API.KERNEL32.__Return16 = ['regs', function () {
  const ctx = this.ctx16.pop(); if (!ctx) throw new GuestError('16-bit return without a thunk frame');
  const n = this.cpu.ecx.value & 0xff;
  for (const r of ['ebp', 'esi', 'edi', 'ebx']) this.cpu[r].value = ctx[r];
  for (const [s, b] of SEGS) { this.cpu[s].value = ctx[s]; this.cpu[b].value = ctx[b]; }
  const ip = this.r16(ctx.frame), cs = this.r16(ctx.frame + 2);
  this.cpu.esp.value = lo16(ctx.esp, (ctx.esp & 0xffff) + 4 + n);
  this.seg('cs', cs);
  return u32(this.selBase(cs) + ip);
}];

// ---------------------------------------------------------------- KERNEL32 thunk services used by GDI32.DLL
const K = (name, n, fn) => { API.KERNEL32[name] = [n, fn]; };
const KR = (name, fn) => { API.KERNEL32[name] = ['regs', fn]; };
const ret32 = p => { const sp = p.reg('esp'), r = p.r32(sp); p.reg('esp', sp + 4); return r; };
const push32 = (p, v) => { const sp = p.reg('esp') - 4; p.reg('esp', sp); p.w32(sp, v); };
const pop32 = p => { const sp = p.reg('esp'), v = p.r32(sp); p.reg('esp', sp + 4); return v; };
/** the module a thunk buffer names (GDI.EXE etc.), loaded if needed, and the 16-bit export holding the thunk data */
P.thunkData16 = function (dll16, name) {
  const m = this.loadLibrary16(dll16); if (!m) throw new GuestError(`thunk: cannot load ${dll16}`);
  const sp = this.neExport(m, name); if (!sp) throw new GuestError(`thunk: ${dll16} has no ${name}`);
  const td = this.lin(sp);
  if (this.r16(td + 6) === 0xffff) this.w16(td + 6, sp >>> 16);   // selector of the thunk data's own segment
  return td;
};
K('#43', 5, function (thunk, thkbuf, len, dll16) {      // ThunkInitLS
  const td = this.thunkData16(this.readA(dll16), this.readA(thkbuf)); const v = this.r32(td + 4);
  if (!v) return 0; this.w32(thunk, v); return v;
});
K('#46', 5, function (thunk, thkbuf, len, dll16) {      // ThunkInitSL
  const td = this.thunkData16(this.readA(dll16), this.readA(thkbuf));
  this.w32(this.lin(this.r32(td + 4)), thunk); return 1;
});
K('#41', 5, function (thunk, thkbuf, len, dll16) {      // ThunkInitLSF
  this.w32(thunk + 0x35, this.thunkFor('KERNEL32', '#90')); this.w32(thunk + 0x6d, this.thunkFor('KERNEL32', '#89'));
  (this.lsfRelays = this.lsfRelays || new Set()).add(u32(thunk));
  const td = this.thunkData16(this.readA(dll16), this.readA(thkbuf)); const a2 = this.lin(this.r32(td + 4));
  if (a2 >>> 16) this.w32(thunk, a2); return a2;
});
KR('#90', function () {          // QT_ThunkPrime: EAX = relay code, EDX = offset of its target table pointer, target number at [EBP-4]
  const relay = this.reg('eax'), table = this.r32(u32(relay + this.reg('edx')));
  this.reg('edx', this.r32(table + 4 * this.u8[this.reg('ebp') - 4]));
  return this.qtThunk();
});
KR('#89', function () {          // FT_PrologPrime: [ESP] = offset of the target table pointer, [ESP+4] = relay code (both popped)
  const off = pop32(this), relay = pop32(this), table = this.r32(u32(relay + off));
  this.reg('edx', this.r32(table + 4 * (this.reg('ecx') & 0xff)));
  return this.ftProlog();
});
KR('QT_Thunk', function () { return this.qtThunk(); });
KR('FT_Prolog', function () { return this.ftProlog(); });
KR('FT_Thunk', function () {
  const ret = pop32(this);
  const ebp = this.reg('ebp'), map = this.r32(ebp - 20), target = this.r32(ebp - 52);
  this.call16from32(target, this.reg('esp'), Math.min(ebp - this.reg('esp') - 0x40, 0x80), map);
  return ret;
});
for (let n = 0; n <= 56; n += 4) KR('FT_Exit' + n, function () {
  const ebp = this.reg('ebp');
  this.reg('eax', this.reg('ebx')); this.reg('ebx', this.r32(ebp - 4)); this.reg('esi', this.r32(ebp - 8)); this.reg('edi', this.r32(ebp - 12));
  this.reg('esp', ebp); this.reg('ebp', pop32(this));
  const r = pop32(this); this.reg('esp', this.reg('esp') + n); return r;
});
P.ftProlog = function () {
  // the caller jumped here from its relay code: [ESP] is the thunk function's own return address frame
  const ret = pop32(this);
  push32(this, this.reg('ebp')); this.reg('ebp', this.reg('esp'));
  const ebp = this.reg('ebp'); this.reg('esp', ebp - 64); this.u8.fill(0, ebp - 64, ebp);
  this.w32(ebp - 4, this.reg('ebx')); this.w32(ebp - 8, this.reg('esi')); this.w32(ebp - 12, this.reg('edi')); this.w32(ebp - 16, this.reg('ecx'));
  this.w32(ebp - 48, this.reg('eax')); this.w32(ebp - 52, this.reg('edx'));
  return ret;
};
P.qtThunk = function () {
  const ret = pop32(this);
  const sp = this.reg('esp'), n = Math.min(this.reg('ebp') - sp, 64);
  const r = this.call16from32(this.reg('edx'), sp, n, 0);
  this.reg('esp', this.reg('esp') + 0);   // call16from32 adjusted ESP for the bytes the callee popped
  return ret;
};
/**
 * Call a 16:16 target whose `n` argument bytes sit on the flat stack at `src`. As on Windows 95 the 16-bit stack
 * aliases the 32-bit one: SS:SP addresses the argument block in place, so anything the callee writes there is seen
 * by the 32-bit side. `map` marks argument dwords holding flat pointers into the block (converted to SS:offset).
 */
P.call16from32 = function (target, src, n, map, ret32 = false) {
  const sel = target >>> 16, off = target & 0xffff;
  const save = { ebx: this.reg('ebx'), esi: this.reg('esi'), edi: this.reg('edi'), ebp: this.reg('ebp'), esp: this.reg('esp') };
  const lvl = this.stackLevel++; const ssel = L.STK + 8 * lvl;
  const base = (src - 0xf000) & ~0xf;
  this.setDesc(ssel, base, 0xffff, 0xf300); this.seg('ss', ssel);
  let sp = src - base;
  if (map) for (let i = 0; i < 32; i++) if (map & (1 << i)) {
    const a = src + 2 * i, ptr = this.r32(a);
    this.w32(a, u32((ssel << 16) | (ptr - base)));
  }
  const sp0 = sp;
  if (ret32) { sp -= 4; this.w32(base + sp, L.SENT); sp -= 4; this.w32(base + sp, 0); }    // for a 0x66 lret
  else { sp -= 2; this.w16(base + sp, L.SENT); sp -= 2; this.w16(base + sp, 0); }
  this.reg('esp', sp); this.seg('ds', 0); this.seg('es', 0); this.seg('cs', sel);
  this.cpu.ebp.value = lo16(this.cpu.ebp.value, sp0 + n);
  this.depth++;
  const r = this.runAt(u32(this.selBase(sel) + off));
  this.depth--; this.stackLevel--;
  if (r !== 0 || this.trapped) throw new GuestError(this.trapped || `16-bit thunk target ${target.toString(16)} did not return`);
  const popped = ((this.cpu.esp.value & 0xffff) - sp0) & 0xffff;
  const ax = this.cpu.eax.value & 0xffff, dx = this.cpu.edx.value & 0xffff;
  this.last16 = { eax: u32(this.cpu.eax.value), ebx: u32(this.cpu.ebx.value), ecx: u32(this.cpu.ecx.value) };
  if (ret32) this.reg('eax', this.last16.eax); else { this.reg('eax', ((dx << 16) | ax) >>> 0); this.reg('edx', dx); }
  for (const r of ['ebx', 'esi', 'edi', 'ebp']) this.reg(r, save[r]);
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = LAYOUT.TIB;
  this.reg('esp', save.esp + popped);
  return this.reg('eax');
};
KR('#45', function () {          // Common32ThkLS: EAX = 16-bit common entry, CX = target*4 (into DI), EDX.hi = dword args
  const ret = pop32(this), n = (this.reg('edx') >>> 16) * 4, edi = this.reg('edi');
  this.reg('edi', lo16(edi, this.reg('ecx')));      // the target index goes to the 16-bit side only
  const sp = this.reg('esp');
  this.reg('esp', sp - 32);
  this.call16from32(this.reg('eax'), sp - 32, n + 32, 0, true);
  this.reg('esp', sp + (this.last16.ebx & 0xff)); this.reg('edi', edi);
  return ret;
});
// pointer mapping
KR('SMapLS', function () { const a = this.reg('eax'); this.reg('edx', a >>> 16 ? this.mapLS(a) : 0); if (a >>> 16) this.reg('eax', this.reg('edx')); return ret32(this); });
KR('SUnMapLS', function () { return ret32(this); });
for (let n = 8; n <= 40; n += 4) {
  KR('SMapLS_IP_EBP_' + n, function () { const a = this.reg('ebp') + n, v = this.r32(a); const s = v >>> 16 ? this.mapLS(v) : v; this.w32(a, s); this.reg('edx', s); this.reg('eax', s); return ret32(this); });
  KR('SUnMapLS_IP_EBP_' + n, function () { this.w32(this.reg('ebp') + n, 0); return ret32(this); });
}
K('MapSL', 1, function (sp) { return this.lin(sp); });
K('MapSLFix', 1, function (sp) { return this.lin(sp); });
K('MapLS', 1, function (a) { return this.mapLS(a); });
K('UnMapLS', 1, () => 0);
KR('UnMapSLFixArray', function () { const r = ret32(this); this.reg('esp', this.reg('esp') + 8); return r; });
K('MapHInstLS', 0, function () { return this.reg('eax'); });
KR('K32Thk1632Prolog', function () { return ret32(this); });
KR('K32Thk1632Epilog', function () { return ret32(this); });
K('#17', 0, () => 0);                                      // CommonUnimpStub
K('#18', 2, function (pid, off) { return 0; });           // GetProcessDword
K('#23', 0, () => 0);                                      // GDIReallyCares
K('#38', 0, () => 0); K('#39', 0, () => 0);
K('#48', 1, function (p) { if (p) this.w32(p, 0); return 0; });   // ReleaseThunkLock
// USER32.DLL's start-up: the Win16Lock it takes around every call into USER.EXE, and KERNEL's 16-bit system variables
// (a block USER32 writes into). One thread runs here, so the lock has nothing to exclude.
K('#93', 1, function (pp) { if (!this.win16Lock) this.win16Lock = this.alloc(0x40); this.w32(pp, this.win16Lock); return 0; });   // GetpWin16Lock
K('#92', 0, function () { if (!this.pk16SysVar) this.pk16SysVar = this.alloc(0x40); return this.pk16SysVar; });            // GetPK16SysVar
K('#86', 1, () => 0);                                                                                                        // _EnterSysLevel
K('#97', 1, () => 0);                                                                                                        // _LeaveSysLevel
K('#49', 1, () => 0);                                      // RestoreThunkLock
K('#51', 0, () => 0);
K('#68', 3, function (sp) { return this.lin(sp); });      // K32WOWGetVDMPointerFix
K('#69', 1, () => 0);
K('#86', 1, () => 0);
K('#93', 1, function (p) { if (p) this.w32(p, 0); return 0; });   // GetpWin16Lock
K('#96', 0, () => 1);
K('#97', 1, () => 0); K('#98', 1, () => 0);
K('GetProcessFlags', 1, () => 0);
K('ConvertToGlobalHandle', 1, h => h);
K('OpenEventA', 3, () => 0); K('OpenMutexA', 3, () => 0); K('ReleaseMutex', 1, () => 1); K('SetEvent', 1, () => 1);
K('EnumResourceNamesA', 4, () => 0);

/**
 * The thunk compiler's LSF relay code sits in the 32-bit DLL's data (ThunkInitLSF layout):
 *   +04: jmp +20 -> +24: call/pop eax; sub eax,25 (eax = +04); mov edx, <table ptr offset>; push QT_ThunkPrime; ret
 *   +3A: jmp +20 -> +5A: call/pop edx; sub edx,25 (edx = +3A); push edx; push <table ptr offset>; push FT_PrologPrime; ret
 * Executing it is equivalent to setting those registers and jumping to the primer.
 */
P.dataCode = function (eip) {
  if (!this.lsfRelays) return null;
  for (const r of this.lsfRelays) {
    if (eip === u32(r + 4)) { this.reg('eax', r + 4); this.reg('edx', this.r32(r + 0x30)); return this.r32(r + 0x35); }
    if (eip === u32(r + 0x3a)) { push32(this, r + 0x3a); push32(this, this.r32(r + 0x68)); return this.r32(r + 0x6d); }
  }
  return null;
};
P.slThunklet = function (target, rel) { return u32(target); };
/**
 * 16-bit code may far-jump straight into flat 32-bit code that runs on the 16-bit stack (USER.EXE into USER32's
 * InitSharedTable, as Windows 95 does). The recompiled 32-bit modules address the stack as flat memory, so on the way
 * in the stack becomes its flat alias (ESP = SS base + SP, SS flat), and on the way back into 16-bit module code the
 * 16-bit SS:SP is put back. The bytes either code touches are the same.
 */
P.modeSwitch = function (m) {
  const ss = this.cpu.ss.value & 0xffff, flatSS = !ss || ss === L.FLATDS;
  if (m.kind !== 'ne') {
    if (flatSS || !this.selValid(ss) || this.r32(L.ACC + (ss & 0xfff8)) & 0x400000) return;   // flat, or a 32-bit stack segment
    (this.stackSwaps = this.stackSwaps || []).push({ ss, ssb: u32(this.cpu.ssb.value) });
    this.cpu.esp.value = u32(this.cpu.ssb.value) + (this.cpu.esp.value & 0xffff);
    this.seg('ss', L.FLATDS);
  } else if (flatSS && this.stackSwaps && this.stackSwaps.length) {
    const s = this.stackSwaps.pop();
    this.cpu.esp.value = u32(this.cpu.esp.value) - s.ssb;
    this.seg('ss', s.ss);
  }
};
P.runPendingInits = function () { const pending = this.inits; this.inits = []; for (const m of pending) this.call(m.meta.entry, [m.base, 1, 0]); };

// ---------------------------------------------------------------- native GDI behind the Win32 personality
/** GDI.EXE, GDI32.DLL and the display driver, brought up on first use with the fonts WIN.INI lists; null without W95SYSTEM */
P.nativeGdi = function () {
  if (this.ngdi !== undefined) return this.ngdi;
  this.ngdi = null;
  const sys = window.W95SYSTEM; if (!sys || !sys.ne || !sys.ne.GDI) return null;
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [n, d] of Object.entries(sys.dlls || {})) {
    const k = n.replace(/\.DLL$/, '');
    if (!this.dlls.has(k)) this.dlls.set(k, { file: d.fileBytes || (d.fileBytes = b64(d.file)), module: d.mod || (d.mod = new WebAssembly.Module(b64(d.wasm))), meta: d.meta });
  }
  if (!this.loadLibrary16('GDI')) return null;
  const g = this.byName.get('GDI32'); if (!g) return null;
  const str = s => { const a = this.alloc(s.length + 1); this.writeA(a, s); return a; };
  const call = (n, args) => { const a = g.exports.get(n); if (!a) throw new GuestError(`GDI32 has no ${n}`); return this.call(a, args); };
  const hdc = call('CreateDCA', [str('DISPLAY'), 0, 0, 0]); if (!hdc) return null;
  // USER loads the [fonts] section of WIN.INI at startup
  const fonts = window.W95Win32.iniRead(this.fs, 'WIN.INI').get('fonts');
  for (const { value } of fonts ? fonts.keys.values() : []) call('AddFontResourceA', [str(/[\\:]/.test(value) ? value : 'C:\\WINDOWS\\FONTS\\' + value)]);
  this.nfonts = new Map();
  return (this.ngdi = { call, hdc, str });
};
/** the native DC with the native counterpart of a Win32-personality font selected; null without native GDI */
P.nativeFontDC = function (font) {
  const n = this.nativeGdi(); if (!n) return null;
  let h = this.nfonts.get(font);
  if (!h) {
    const lf = this.alloc(60);
    if (font.raw) this.u8.set(font.raw, lf);
    else { this.w32(lf, font.lf.height | 0); this.w32(lf + 16, font.lf.weight || 400); this.writeA(lf + 28, font.lf.face || 'System', 32); }
    h = n.call('CreateFontIndirectA', [lf]); this.free(lf);
    this.nfonts.set(font, h);
  }
  n.call('SelectObject', [n.hdc, h]);
  return n;
};

// names for GetProcAddress(KERNEL, "name")
const NAMES16 = { KERNEL: {}, ...NAMES16_INIT };
window.W95NE16 = { K16, NAMES16, L, def16 };
})();
