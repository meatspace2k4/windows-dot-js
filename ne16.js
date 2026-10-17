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
/** the DOS kernel's data in conventional memory, as DOS 7 lays it out: the critical-error and InDOS flags, the list
 *  of lists (C:'s drive parameter block, the system file tables, the current-directory structures for A: to Z:, LASTDRIVE Z and
 *  the NUL device's header), the swappable data area. A segment (`seg`) addresses all of it */
P.dosData = function () {
  if (this.dosD) return this.dosD;
  const a = (this.dosTop + 15) & ~15, size = 0x1300; this.dosTop = a + size; this.u8.fill(0, a, a + size);
  const seg = a >>> 4, off = x => x - a, far = (at, x) => { this.w16(at, off(x)); this.w16(at + 2, seg); };
  // (the swappable data area begins with the critical-error flag, InDOS after it, as DOS's does: what the InDOS
  // pointer is, minus one, is where its current PSP and DTA are found)
  const d = { seg, indos: a + 0x1001, lol: a + 0x20, sft: a + 0x100, fcb: a + 0x240, cds: a + 0x340, sda: a + 0x1000 };
  this.w16(d.lol - 2, 0xffff);                                  // first MCB: none walked
  // the drive parameter blocks (DOS 7.1's, 3Dh bytes): the hard disk's, C:, on a block device whose header is IO.SYS's
  d.dpb = a + 0xc40; d.blk = a + 0xc90; far(d.lol, d.dpb);
  this.u8[d.dpb] = 2; this.w16(d.dpb + 2, 512); this.u8[d.dpb + 4] = 15; this.u8[d.dpb + 5] = 4; this.w16(d.dpb + 6, 32); this.u8[d.dpb + 8] = 2;
  this.w16(d.dpb + 9, 512); far(d.dpb + 0x13, d.blk); this.u8[d.dpb + 0x17] = 0xf8; this.u8[d.dpb + 0x18] = 0xff; this.w32(d.dpb + 0x19, 0xffffffff);
  this.w32(d.blk, 0xffffffff); this.w16(d.blk + 4, 0x0842); this.u8[d.blk + 10] = 1;
  // the system file tables: DOS's first, its five entries (3Bh bytes each), and the FCB table of FCBS=4
  far(d.lol + 4, d.sft); this.w32(d.sft, 0xffffffff); this.w16(d.sft + 4, 5);
  this.w32(d.fcb, 0xffffffff); this.w16(d.fcb + 4, 4);
  this.w32(d.lol + 8, 0xffffffff); this.w32(d.lol + 0xc, 0xffffffff); this.w16(d.lol + 0x10, 512);
  this.w32(d.lol + 0x12, 0xffffffff); far(d.lol + 0x16, d.cds); far(d.lol + 0x1a, d.fcb);
  this.u8[d.lol + 0x20] = 0; this.u8[d.lol + 0x21] = 26;        // block devices, LASTDRIVE
  this.w32(d.lol + 0x22, 0xffffffff); this.w16(d.lol + 0x26, 0x8004); this.writeA(d.lol + 0x2c, 'NUL     ');
  // CDS entries (58h bytes each): the path "X:\", flags (4000h physical for the drives the shell has), the root's length
  for (let i = 0; i < 26; i++) {
    const e = d.cds + 0x58 * i, l = String.fromCharCode(65 + i), has = this.fs && this.fs.vols && this.fs.vols.has(l);
    this.writeA(e, l + ':\\'); this.w16(e + 0x43, has ? 0x4000 : 0); this.w32(e + 0x45, 0xffffffff); this.w16(e + 0x4f, 2);
  }
  // the process's PSP (in conventional memory, after the data): INT 20h, its file table of 20 handles (all free) and
  // the far pointer to it, the parent its own; the swappable area names it as the current PSP
  d.psp = a + 0x1100; d.pspSeg = d.psp >>> 4;
  this.w16(d.psp, 0x20cd); this.w16(d.psp + 2, 0x9fff); this.w16(d.psp + 0x16, d.pspSeg);
  this.u8.fill(0xff, d.psp + 0x18, d.psp + 0x18 + 20); this.w16(d.psp + 0x32, 20); this.w16(d.psp + 0x34, 0x18); this.w16(d.psp + 0x36, d.pspSeg);
  this.w16(d.sda + 0x10, d.pspSeg); this.w16(d.sda + 0x0c, 0x80); this.w16(d.sda + 0x0e, d.pspSeg); this.u8[d.sda + 0x16] = 2;   // PSP, DTA (PSP:80h), drive C:
  return (this.dosD = d);
};
/** IFSHLP.SYS, the real-mode helper IO.SYS loads for the file system manager: its image in conventional memory (the
 *  character device IFS$HLP$, its data block at offset 24h) and its entry point (offset 20Ch), which the personality
 *  answers for as DOS's own real-mode code: function 0 the data block's address; 1 and 2 hook and unhook the real-mode
 *  vectors it lists (flag 2 in its word at 1Ah, the caller's far pointer kept at 12h); 3 and 4 a printer port's
 *  status word in the BIOS data area; 6 and 7 set and clear flag 1, 8 reads the flags */
P.ifshlp = function () {
  if (this.ifsHlp !== undefined) return this.ifsHlp;
  const b64 = (window.W95SYSTEM.dos || {})['IFSHLP.SYS']; if (!b64) return (this.ifsHlp = null);
  const img = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), a = (this.dosTop + 15) & ~15;
  this.dosTop = a + ((img.length + 0x100 + 15) & ~15); this.u8.set(img, a);
  const seg = a >>> 4, w = o => this.r16(a + o), sw = (o, v) => this.w16(a + o, v);
  const h = this.ifsHlp = { seg, lin: a, entry: 0x20c };
  // its initialization (the device's INIT command) as it fills its data: its own segment, its far pointers to its
  // hook stubs, its three request blocks, and DOS's critical-error/InDOS flags, list of lists and NUL device
  const dd = this.dosData(), dos = dd.seg, rel = x => x - (dos << 4);
  sw(0x14, seg); sw(0x48, 0xa50); sw(0x4a, seg); sw(0x1f4, 0x60f); sw(0x1f6, seg); sw(0x1ee, seg); sw(0x1ec, 0xac0);
  for (let i = 0; i < 3; i++) { const r = 0x156 + 0x10 * i; this.u8[a + r] = 0xff; this.u8[a + r + 1] = 1; sw(0x4c + 2 * i, r); }
  sw(0x24, rel(dd.indos) - 1); sw(0x26, dos); sw(0xa4e, dos);
  sw(0x30, rel(dd.lol)); sw(0x32, dos); sw(0x20, rel(dd.lol) + 0x22); sw(0x22, dos);
  (this.rmEntries = this.rmEntries || new Map()).set(u32((seg << 16) | 0x20c), (fn, arg) => {
    switch (fn) {
      case 0: return u32((seg << 16) | 0x24);
      case 1: if (w(0x14) !== seg) return 1; sw(0x1a, w(0x1a) | 2); sw(0x12, arg & 0xffff); sw(0x14, arg >>> 16); this.u8[a + 0x34] = 3;
        sw(0x40, 0xffff); sw(0x42, 0x7fff); sw(0x44, 0xffff); sw(0x46, 0x7fff); this.u8[a + 0x37] = 0; return 0;
      case 2: case 5: if (w(0x14) === seg) return 1; sw(0x1a, w(0x1a) & ~2); sw(0x12, 0x1c); sw(0x14, seg); return 0;
      case 3: case 4: { const at = 0x408 + 2 * (arg & 0xffff), v = this.r16(at); if (fn === 3 && v === 0) this.w16(at, 2); if (fn === 4 && v === 2) this.w16(at, 0); return 0; }
      case 6: if (w(0x1a) & 1) return 1; sw(0x1a, w(0x1a) | 1); return 0;
      case 7: if (!(w(0x1a) & 1)) return 1; sw(0x1a, w(0x1a) & ~1); return 0;
      case 8: return w(0x1a);
      default: return 1;
    }
  });
  return h;
};
/** a segment register loaded with the DOS data's segment (in real mode) or a selector for it */
P.seg16 = function (r, d) { if (this.rmode) this.cpu[r].value = d.seg; else this.seg(r, d.sel || (d.sel = this.allocSels(d.seg << 4, 0x1300))); };
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
  if (name === 'SYSTEM' || name === 'MMSYSTEM') rec.clock = true;   // they read the timer's counts from memory
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
  // then, as KRNL386 does for a library that exports one, its DllEntryPoint(DLL_PROCESS_ATTACH, hInstance, DS, heap
  // size, 0, 0) for the process that loaded it (MSACM.DLL makes its per-process instance there)
  const dep = r.ax && this.neExport(rec, 'DLLENTRYPOINT');
  if (dep) this.call16(dep >>> 16, dep & 0xffff, [['l', 1], ['w', rec.hInstance], ['w', rec.dgroup], ['w', heap], ['l', 0], ['w', 0]], { ds: rec.dgroup });
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
  const all = (window.W95SYSTEM && window.W95SYSTEM.ne) || {};
  const file = name.toUpperCase().replace(/^.*\\/, '');
  // a file name finds that file's module first (MSACM.DRV is the module MSACMMAP, not MSACM.DLL's MSACM)
  const byFile = /\./.test(file) && Object.values(all).find(s => s.fileName === file);
  if (byFile && this.ne.has(byFile.meta.name.toUpperCase())) return this.ne.get(byFile.meta.name.toUpperCase());
  if (!byFile && this.ne.has(base)) return this.ne.get(base);
  const sys = byFile || all[base] || Object.values(all).find(s => s.fileName === file || s.fileName === file + '.DLL');
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
  if (this.user16Ready === undefined) this.user16Ready = false;
  if (this.vxdBoot) this.vxdBoot();   // the static VxDs, initialized before Windows starts (vmm.js)
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
    this.runPendingInits();
  }
  if (!user.inited) { user.inited = true; if (!this.initNE(user)) console.warn('[ne16] USER LibEntry failed'); }
  this.user16Ready = true;
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
P.tick16 = function () {
  if (this.timeLin) this.w32(this.timeLin, u32(this.now() - this.t0 + 3600000));
  if (this.vmmTimeLin) this.w32(this.vmmTimeLin, u32(this.sysTime()));   // VMM's system time (Get_System_Time_Address)
};
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
      case 0x33: if (al === 6) { this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0x0007); this.cpu.edx.value = lo16(this.cpu.edx.value, 0x1000); } else if (al === 0) this.cpu.edx.value &= ~0xff; return;   // true version 7.0, in HMA; Ctrl+Break checking off
      case 0x44: if (al === 0) { this.cpu.edx.value = lo16(this.cpu.edx.value, 0x80); return; } break;
      case 0x50: case 0x51: case 0x62: return;
      case 0x35: {   // a vector nobody has set leads to the BIOS service behind it, where there is one
        const v = ((this.dosVec = this.dosVec || {})[al]) || (BIOS_INT[al] ? this.thunk16For(`BIOSINT.#${al}`) : 0);
        this.seg('es', v >>> 16); this.cpu.ebx.value = lo16(this.cpu.ebx.value, v); return; }
      case 0x0d: return;   // disk reset: nothing is buffered
      // DOS's own data, which the file system manager reads as it takes over from DOS: the InDOS flag (34h: ES:BX),
      // the list of lists (52h: ES:BX), the swappable data area (5D06h: DS:SI, CX and DX its sizes)
      case 0x34: { const d = this.dosData(); this.seg16('es', d); this.cpu.ebx.value = lo16(this.cpu.ebx.value, d.indos - (d.seg << 4)); return; }
      case 0x52: { const d = this.dosData(); this.seg16('es', d); this.cpu.ebx.value = lo16(this.cpu.ebx.value, d.lol - (d.seg << 4)); return; }
      case 0x5d: if (al === 6) { const d = this.dosData(); this.seg16('ds', d); this.cpu.esi.value = lo16(this.cpu.esi.value, d.sda - (d.seg << 4)); this.cpu.ecx.value = lo16(this.cpu.ecx.value, 0x80); this.cpu.edx.value = lo16(this.cpu.edx.value, 0x18); return; } break;
      case 0xea: return;   // a NetWare shell's function: none is loaded
      // the machine name DOS keeps for the network (5E01h: CH 0 to clear it, CL its NetBIOS number, DS:DX the name
      // padded to 15; 5E00h: copied to DS:DX, CH whether it is set, CL its number)
      case 0x5e: if (al === 0 || al === 1) {
        const at = this.rmode ? ((this.cpu.ds.value & 0xffff) << 4) + (this.cpu.edx.value & 0xffff) : this.lin((this.cpu.ds.value << 16) | (this.cpu.edx.value & 0xffff)), cx = this.cpu.ecx.value & 0xffff;
        if (al === 1) { this.dosMachine = cx >> 8 ? { name: (this.readA(at, 15) || '').padEnd(15).slice(0, 15), num: cx & 0xff } : null; return; }
        const m = this.dosMachine; this.writeA(at, m ? m.name : ''.padEnd(15), 16); this.cpu.ecx.value = lo16(this.cpu.ecx.value, m ? 0x100 | m.num : 0); return;
      } break;
      case 0x25: (this.dosVec = this.dosVec || {})[al] = u32((this.cpu.ds.value << 16) | (this.cpu.edx.value & 0xffff)); return;
      case 0x4c: if (this.thread16 && this.thread16.task && this.depth === this.thread16.depth) { this.thread16.exitCode = al; return LAYOUT.SENTINEL; } break;   // a task's exit ends its thread
    }
    // handle file calls, on the handles KERNEL's _lopen/OpenFile give out: BX handle, CX count, DS:DX buffer or name;
    // CF and AX = error code on failure (2 not found, 5 denied, 6 bad handle)
    // (in real mode, as a VxD's nested execution calls DOS, a segment is a paragraph number)
    if ([0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x57, 0x6c].includes(ah) || (ah === 0x44 && (al === 2 || al === 0) && this.dosFiles.get(this.cpu.ebx.value & 0xffff) && this.dosFiles.get(this.cpu.ebx.value & 0xffff).dev)) {
      // (a VxD's call through Exec_VxD_Int: 32-bit offsets on a flat DS)
      const flat = this.vxdFlat, off16 = r => (flat ? u32(this.cpu[r].value) : this.cpu[r].value & 0xffff);
      const bx = this.cpu.ebx.value & 0xffff, cx = flat ? u32(this.cpu.ecx.value) : this.cpu.ecx.value & 0xffff, dx = off16('edx');
      const at = off => (flat ? off : this.rmode ? ((this.cpu.ds.value & 0xffff) << 4) + off : this.lin((this.cpu.ds.value << 16) | off));
      const dsdx = () => at(dx), f = this.dosFiles.get(bx);
      const fail = code => { CF(this, 1); this.ax(code); };
      try {
        switch (ah) {
          case 0x3c: case 0x3d: {
            if (ah === 0x3d && /(^|\\)IFS\$HLP\$$/i.test(this.readA(dsdx()) || '') && this.ifshlp()) {   // the helper's character device
              const hh = 0x7f00; this.dosFiles.set(hh, { dev: 'IFS$HLP$' }); return this.ax(hh);
            }
            const name = this.readA(dsdx()) || '', full = ah === 0x3c ? (/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name)) : this.findFile16(name);
            if (!full) return fail(2);
            const h = this.dosOpen(full, ah === 0x3c ? 'w+' : (al & 3) === 0 ? 'r' : 'r+'); return h === 0xffff ? fail(this.lastError || 2) : this.ax(h);
          }
          case 0x44: {   // a device's IOCTL: 0 its information (a character device), 2 read its control data (the helper:
            // given its signature in the 8 bytes at DS:DX, its own and its entry point)
            if (al === 0) { this.cpu.edx.value = lo16(this.cpu.edx.value, 0xc080); return; }
            const b = dsdx(), hp = this.ifshlp();
            if (cx !== 8 || this.r16(b) !== 0xe970 || this.r16(b + 2) !== 0x3735) return fail(1);
            this.w16(b, 0x3735); this.w16(b + 2, 0xef70); this.w16(b + 4, hp.entry); this.w16(b + 6, hp.seg); return this.ax(8);
          }
          case 0x6c: {   // extended open: BX the mode, CX attributes, DX the action (low nibble if it exists: 1 open, 2
            // replace; high nibble if not: 1 create), DS:SI the name; AX the handle, CX what was done (1 opened, 2 created, 3 replaced)
            const name = this.readA(at(off16('esi'))) || '', found = this.findFile16(name);
            const full = found || (/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name));
            const act = found ? dx & 0xf : (dx >> 4) & 0xf; if (!act) return fail(found ? 80 : 2);
            const mode = !found || act === 2 ? 'w+' : (bx & 3) === 0 ? 'r' : 'r+';
            const h = this.dosOpen(full, mode); if (h === 0xffff) return fail(this.lastError || 2);
            this.cpu.ecx.value = lo16(this.cpu.ecx.value, !found ? 2 : act === 2 ? 3 : 1); return this.ax(h);
          }
          case 0x3e: if (!f) return fail(6); if (!f.dev) this.fs.close(f.fd); this.dosFiles.delete(bx); return;
          case 0x3f: { if (!f) return fail(6); const b = this.fs.read(f.fd, cx); this.u8.set(b, dsdx()); return this.ax(b.length); }
          case 0x40: if (!f) return fail(6); return this.ax(this.fs.write(f.fd, this.u8.slice(dsdx(), dsdx() + cx)));
          case 0x41: this.fs.unlink(this.readA(dsdx()) || ''); return;
          case 0x57: {   // file dates: AL 0 written, 4 accessed, 6 created (CX time, DX date); the setters change nothing
            if (!f) return fail(6); if (al & 1) return;
            const i = this.fs.fstat(f.fd), d = new Date(al === 4 ? i.atime : al === 6 ? i.ctime : i.mtime);
            this.cpu.ecx.value = lo16(this.cpu.ecx.value, al === 4 ? 0 : (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1));
            this.cpu.edx.value = lo16(this.cpu.edx.value, ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
            return;
          }
          case 0x42: { if (!f) return fail(6); const pos = this.fs.seek(f.fd, (((this.cpu.ecx.value & 0xffff) << 16) | (this.cpu.edx.value & 0xffff)) | 0, al); this.ax(pos & 0xffff); this.cpu.edx.value = lo16(this.cpu.edx.value, pos >>> 16); return; }
        }
      } catch (e) { if (e instanceof window.W95FS.FSError) return fail(e.code || 5); throw e; }
    }
    this.trapped = `unhandled int 21h ax=${this.ax().toString(16)}`; return LAYOUT.SENTINEL;
  },
  0x11() { this.ax(0x0023); },
  0x41() {},   // the kernel debugger's interface: no debugger is present, so every notification goes unheard
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
    if (ax === 0x160b) return;          // identify Windows-aware TSRs: none is loaded, so ES:DI comes back as it went in
    if (ax === 0x1607) return;          // device callout to real-mode software (a VxD asking for its TSR's API): none answers
    if ([0x11, 0xb8, 0xb7, 0x58].includes(ax >> 8)) return;   // real-mode network redirector, network, APPEND and real-mode network extension checks: none is loaded (AL comes back as it went)
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
    const v = this.vxdApiRoute && this.vxdApiRoute(id); if (v) return this.vxdPmApi(v);   // the recompiled VxD (vmm.js)
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
  // asked by USER's first-task start-up; a zero answer has USER rewrite the mouse's SYSTEM.INI entries for a mouse
  // VMD has not set up (an unconfirmed reading of USER seg21:29E5), which this PS/2 mouse is not
  0x103() { this.cpu.cf.value = 0; return 1; },
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
/** call an export of the native USER.EXE by ordinal (args in Pascal order, as call16 takes them) */
P.user16 = function (ord, args = []) {
  const u = this.ne && this.ne.get('USER'), ep = u && u.meta && this.neExport(u, ord);
  if (!ep) throw new GuestError(`USER.${ord} is not loaded`);
  return this.call16(ep >>> 16, ep & 0xffff, args);
};
/** the native USER's visible top-level windows, topmost first, with their screen rectangles, owners, classes and
 *  titles; and the active window and the window holding the mouse capture */
P.nativeWindows = function () {
  if (!this.wbufLin) { this.wbufLin = this.alloc(0x200); this.wbufSel = this.allocSels(this.wbufLin, 0x200); }
  const a = this.wbufLin, buf = u32(this.wbufSel << 16), u = (o, args) => this.user16(o, args).ax, s16 = o => (this.r16(a + o) << 16) >> 16;
  const list = [];
  for (let h = u(262, [['w', u(286)], ['w', 5]]), n = 0; h && n < 256; h = u(262, [['w', h], ['w', 2]]), n++) {   // GW_CHILD, GW_HWNDNEXT
    if (!u(49, [['w', h]])) continue;                                                                                 // IsWindowVisible
    u(32, [['w', h], ['l', buf]]);                                                                                    // GetWindowRect
    const x = s16(0), y = s16(2), w = s16(4) - x, hh = s16(6) - y;
    const tl = this.user16(107, [['w', h], ['w', 0x0d], ['w', 160], ['l', buf + 16]]).ax, title = tl ? this.readA(a + 16, tl) : '';   // DefWindowProc WM_GETTEXT: USER's own copy, no message sent
    const cl = u(58, [['w', h], ['l', buf + 0x180], ['w', 64]]), cls = cl ? this.readA(a + 0x180, cl) : '';          // GetClassName
    list.push({ hwnd: h, x, y, w, h: hh, title, cls, owner: u(262, [['w', h], ['w', 4]]), iconic: !!u(31, [['w', h]]) });   // GW_OWNER, IsIconic
  }
  return { list, active: u(60), capture: u(236) };                                                                    // GetActiveWindow, GetCapture
};
/** the visible descendants of a native window, front to back as USER links them: rectangle, class, text, control id,
 *  style and enabled state. Edits and combo boxes are asked for their text (WM_GETTEXT); buttons for their check
 *  state (BM_GETCHECK) */
P.nativeChildren = function (parent) {
  if (!this.wbufLin) this.nativeWindows();
  const a = this.wbufLin, buf = u32(this.wbufSel << 16), u = (o, args) => this.user16(o, args).ax, s16 = o => (this.r16(a + o) << 16) >> 16;
  const out = [], focus = u(23);   // GetFocus
  const walk = (p, depth) => {
    for (let h = u(262, [['w', p], ['w', 5]]), n = 0; h && n < 512; h = u(262, [['w', h], ['w', 2]]), n++) {
      if (!u(49, [['w', h]])) continue;
      u(32, [['w', h], ['l', buf]]);
      const x = s16(0), y = s16(2), w = s16(4) - x, hh = s16(6) - y;
      const cl = u(58, [['w', h], ['l', buf + 0x180], ['w', 64]]), cls = cl ? this.readA(a + 0x180, cl) : '';
      const style = this.user16(135, [['w', h], ['w', 0xfff0]]).dxax;                                            // GetWindowLong(GWL_STYLE)
      let text = '';
      if (/^(edit|combobox)$/i.test(cls)) {   // SendMessage WM_GETTEXT, into a buffer the size of an edit's limit
        if (!this.tbufLin) { this.tbufLin = this.alloc(0x10000); this.tbufSel = this.allocSels(this.tbufLin, 0x10000); }
        const tl = u(111, [['w', h], ['w', 0x0d], ['w', 0xffff], ['l', u32(this.tbufSel << 16)]]); text = tl ? this.readA(this.tbufLin, tl) : '';
      } else { const tl = u(107, [['w', h], ['w', 0x0d], ['w', 160], ['l', buf + 16]]); text = tl ? this.readA(a + 16, tl) : ''; }
      const c = { hwnd: h, parent: p, x, y, w, h: hh, cls, text, id: u(277, [['w', h]]), style, enabled: !!u(35, [['w', h]]), focused: h === focus, depth };
      if (/^button$/i.test(cls) && [2, 3, 4, 5, 6, 9].includes(style & 0x0f)) c.checked = u(111, [['w', h], ['w', 0x400], ['w', 0], ['l', 0]]);
      out.push(c); walk(h, depth + 1);
    }
  };
  walk(parent, 0);
  return out;
};
/** a key into USER's keybd_event (USER.289), as KEYBOARD.DRV reports one: AL = virtual key, AH = 80h on release,
 *  BL = scan code, BH = 1 for an extended key */
P.keyEvent16 = function (vk, scan, up, ext = false) {
  const u = this.ne && this.ne.get('USER'), ep = u && u.meta && this.neExport(u, 289);
  if (!ep || this.depth) return false;
  this.tick16(); this.call16(ep >>> 16, ep & 0xffff, [], { ax: (up ? 0x8000 : 0) | (vk & 0xff), bx: (ext ? 0x100 : 0) | (scan & 0xff), si: 0, di: 0 });
  return true;
};
vxdApi(0x0017, 'SHELL', {});
vxdApi(0x0037, 'VxD 37h', {});
vxdApi(0x0442, 'VTDAPI', {
  // MMSYSTEM's timer services (timeGetDevCaps, timeBeginPeriod/EndPeriod, timeGetTime, timeSetEvent/KillEvent):
  // 0 the periods it can keep, ES:BX -> { ?, min ms, max ms } (dwords)
  0() { const a = this.lin((this.cpu.es.value << 16) | (this.cpu.ebx.value & 0xffff)); this.w32(a + 4, 1); this.w32(a + 8, 0xffff); return 0; },
  1() { return 0; },   // begin a minimum period (CX ms): every period is kept to the millisecond here
  2() { return 0; },   // end it
  // the system time in milliseconds, DX:AX (the same clock as the time selector of function 9)
  4() { const t = u32(this.now() - this.t0 + 3600000); this.cpu.edx.value = lo16(this.cpu.edx.value, t >>> 16); if (this.sound16) this.sound16(); return t & 0xffff; },   // (code waiting on the clock lets the sound hardware run)
  // a timer event, ES:BX -> { delay, resolution (words), far callback, dwUser, flags (bit 0 periodic) }: the callback
  // gets (id, 0, dwUser, 0, 0) as TimeProc takes them, from timers16() like the periodic callbacks; AX = its id
  5() {
    const a = this.lin((this.cpu.es.value << 16) | (this.cpu.ebx.value & 0xffff));
    const ms = Math.max(1, this.r16(a)), id = this.nextTimerEvent = ((this.nextTimerEvent || 0) % 0xfffe) + 1;
    (this.vtdEvents = this.vtdEvents || new Map()).set(id, { id, ms, off: this.r16(a + 4), sel: this.r16(a + 6), user: this.r32(a + 8), periodic: !!(this.r16(a + 12) & 1), due: this.now() + ms });
    return id;
  },
  6() { const id = this.cpu.ecx.value & 0xffff; return this.vtdEvents && this.vtdEvents.delete(id) ? 0 : 0x61; },   // kill one (TIMERR_NOCANDO)
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
// ---------------------------------------------------------------- Plug and Play
// CONFIGMG's device tree as the registry's Enum branch records it: a devnode for each HKLM\Enum\<enumerator>\<device>\
// <instance>, with its class and its driver (software key under Services\Class), and a handle as CONFIGMG hands them out
// (a ring-0 address)
const regStr = v => (v && v.type === 1 ? window.W95FS.decode(v.data).replace(/\0[\s\S]*$/, '') : typeof v === 'string' ? v : '');
P.devnodes = function () {
  if (this.devTree) return this.devTree;
  const W = window.W95Win32, out = [];
  // (only ROOT's: the devnodes of other enumerators, as the Network devnodes NDIS makes for the protocols and clients
  // bound to a card, appear as their enumerator creates them, CONFIGMG's Create_DevNode)
  for (const bus of W.regKids('hklm\\enum').filter(b => b.toLowerCase() === 'root')) for (const dev of W.regKids(`hklm\\enum\\${bus}`)) for (const inst of W.regKids(`hklm\\enum\\${bus}\\${dev}`)) {
    const key = `hklm\\enum\\${bus}\\${dev}\\${inst}`;
    out.push({ handle: 0xc1000000 + 0x100 * out.length, id: `${bus}\\${dev}\\${inst}`.toUpperCase(), key, cls: regStr(W.regGet(key, 'Class')), driver: regStr(W.regGet(key, 'Driver')) });
  }
  return (this.devTree = out);
};
P.devnode = function (h) { return this.devnodes().find(d => d.handle === u32(h)) || null; };
/** a devnode's software key (Services\Class\<driver>), or null */
P.devSoftKey = function (dn) { return dn && dn.driver ? 'hklm\\system\\currentcontrolset\\services\\class\\' + dn.driver.toLowerCase() : null; };
// MMDEVLDR, the device loader of MEDIA devnodes (DevLoader=mmdevldr.vxd in their software keys): it starts each one at
// appy time, once MMSYSTEM.DLL is loaded, through MMSYSTEM's RING3_DEVLOADER(devnode, 1), which loads the drivers the
// software key's Drivers subkeys name. The host runs this between slices, as the system's appy-time events run
P.appy16 = function () {
  if (this.depth) return;
  if (this.vxdRunEvents) this.vxdRunEvents();
  if (!this.user16Ready) return;
  if (this.host && this.host.net) { this.vxdAppy(); return; }   // the network's process starts no media devices
  if (this.vxd && window.W95SYSTEM.vxds && window.W95SYSTEM.vxds['MMDEVLDR.VXD']) { this.vxdDevLoaders(); this.vxdAppy(); return; }   // the recompiled device loader (vmm.js)
  if (this.mmdevStarted) return;
  const mm = this.ne.get('MMSYSTEM'), ep = mm && mm.meta && this.neExport(mm, 2001); if (!ep) return;   // RING3_DEVLOADER
  this.mmdevStarted = true;
  for (const dn of this.devnodes()) {
    const sw = this.devSoftKey(dn);
    if (!sw || !/^mmdevldr\.vxd$/i.test(regStr(window.W95Win32.regGet(sw, 'DevLoader')))) continue;
    this.mmdevMigrate(dn);
    dn.started = true; this.tick16();
    this.call16(ep >>> 16, ep & 0xffff, [['l', dn.handle], ['l', 1]]);
  }
};
/** MMDEVLDR's migration of a devnode (VxD 30B28h): each driver its software key's Drivers\<class>\<driver> names gets an
 *  entry MediaResources\<class>\<driver><<instance>> holding the driver key's values and subkeys, its SOFTWAREKEY,
 *  DeviceID (the Enum key) and DevNode; a driver or class marked NotPresent=1 loses its entry. Drivers\DevNode and
 *  MIGRATED=1 record it done; once migrated, only the entries' DevNode is brought up to date */
P.mmdevMigrate = function (dn) {
  const W = window.W95Win32, sw = this.devSoftKey(dn), drv = sw + '\\drivers', MR = 'hklm\\system\\currentcontrolset\\control\\mediaresources\\';
  const dword = v => ({ type: 3, data: new Uint8Array(new Uint32Array([v]).buffer) }), str = v => ({ type: 1, data: window.W95FS.encode(v + '\0') });
  const dnOf = v => (v && v.data && v.data.length >= 4 ? new DataView(v.data.buffer, v.data.byteOffset).getUint32(0, true) : null);
  const migrated = regStr(W.regGet(drv, 'MIGRATED'))[0] === '1';
  if (migrated && dnOf(W.regGet(drv, 'DevNode')) === dn.handle) return;
  W.regSet(drv, 'DevNode', dword(dn.handle));
  const inst = `<${dn.driver.split('\\').pop()}>`, copy = (from, to) => { for (const [n, v] of W.regVals(from)) W.regSet(to, (v && v.name) || n, v); for (const k of W.regKids(from)) copy(`${from}\\${k}`, `${to}\\${k}`); };
  for (const cls of W.regKids(drv)) {
    const ck = `${drv}\\${cls}`, present = regStr(W.regGet(ck, 'NotPresent'))[0] !== '1';
    for (const d of W.regKids(ck)) {
      const dk = `${ck}\\${d}`, entry = `${MR}${cls}\\${d}${inst}`;
      if (migrated) { W.regSet(entry, 'DevNode', dword(dn.handle)); continue; }
      if (!present || regStr(W.regGet(dk, 'NotPresent'))[0] === '1') { W.regDel(entry); continue; }
      W.regSet(entry, 'SOFTWAREKEY', str(this.cmKey(dn, null, 1)));
      W.regSet(entry, 'DeviceID', str(dn.id));
      W.regSet(entry, 'DevNode', dword(dn.handle));
      copy(dk, entry);
    }
  }
  W.regSet(drv, 'MIGRATED', str('1'));
};
// MMDEVLDR's protected-mode API, function in DX, its arguments on the caller's stack (dwords, the far return already
// taken), AX = 0 or an error with the carry set. 0 and 1 have it call MMSYSTEM at appy time again (nothing is pending
// here); 2 (devnode, far WORD list, far count) lists a devnode's sub-devices, which these cards do not have
const mmdevArgs = p => { const sp = p.cpu.ssb.value + (p.cpu.esp.value & 0xffff) + 4; return i => p.r32(sp + 4 * i); };
def16('VXD', 0x44a, '', 'jmp', function () {
  const v = this.vxdApiRoute && this.vxdApiRoute(0x44a); if (v) return this.vxdPmApi(v);   // the recompiled MMDEVLDR (vmm.js)
  const f = this.cpu.edx.value & 0xffff, arg = mmdevArgs(this);
  let r;
  if (f === 0 || f === 1) r = 0;
  else if (f === 2) { const n = this.lin(arg(2)); if (n) this.w32(n, 0); r = 0; }
  else if (f === 3) { this.queueApc(arg(2) & 0xffff, arg(0), arg(1)); r = 0; }   // VWIN32_QueueUserApc(proc, data, ring-0 thread)
  else if (f === 4) { const e = this.r0Event(arg(0)); this.signal(e); r = 0; }                 // VWIN32_SetWin32Event(ring-0 event)
  else { this.trapped = `unimplemented MMDEVLDR (VxD 44Ah) API function ${f}`; return LAYOUT.SENTINEL; }
  this.cpu.eax.value = lo16(this.cpu.eax.value, r); this.cpu.cf.value = r ? 1 : 0;
  return this.retf16(0);
});
VXD_API[0x44a] = { name: 'MMDEVLDR', fns: {} };
// MSSNDSYS.VXD's protected-mode API, which MSSNDSYS.DRV calls: DH a group, DL a function. The VxD keeps a record for each
// card it started, as its CONFIG_START handler fills it from the devnode's resources (VxD 402ACh): 4 flags, 6 the
// configuration port, 8 IRQ, 9/A playback and capture DMA channels, B the codec's version byte, C the VxD's version,
// E the configuration register's ID bits, 10/14/18/1C its DMA buffer (linear address, physical address, -, size),
// 20 a selector to the buffer, 22 the OPL3's port, 42 the codec's port, 4C the codec type (1: AD1848), 4E a second
// codec's port (FFFFh: none), 52 more flags (40h: one DMA channel), 54 the devnode
P.wssRecord = function (dn) {
  this.wssRecs = this.wssRecs || new Map();
  if (this.wssRecs.has(dn.handle)) return this.wssRecs.get(dn.handle);
  const hw = this.cards && this.cards().find(c => c.devnode === dn.id && c.wss); if (!hw) return null;
  const size = 0x4000, a = (this.dosTop + 0xffff) & ~0xffff;   // in conventional memory, within one 64K DMA page
  if (a + size > 0xa0000) return null;
  this.dosTop = a + size; this.u8.fill(0, a, a + size);
  const r = new Uint8Array(0xba), dv = new DataView(r.buffer), w = hw.wss;
  dv.setUint16(4, 0, true); dv.setUint16(6, w.cfg, true); r[8] = w.irq; r[9] = w.dma; r[0xa] = w.dma; r[0xb] = 0x0a;
  dv.setUint16(0xc, 0x400, true); dv.setUint16(0xe, 4, true);
  dv.setUint32(0x10, a, true); dv.setUint32(0x14, a, true); dv.setUint32(0x1c, size, true);
  dv.setUint16(0x20, this.allocSels(a, size), true); dv.setUint16(0x22, 0, true);
  dv.setUint16(0x42, w.codec, true); dv.setUint16(0x4c, 1, true); dv.setUint16(0x4e, 0xffff, true);
  dv.setUint16(0x52, 0x40, true); dv.setUint32(0x54, dn.handle, true);
  this.wssRecs.set(dn.handle, r); return r;
};
vxdApi(0x045f, 'MSSNDSYS', {});
def16('VXD', 0x45f, '', 'jmp', function () {
  const v = this.vxdApiRoute && this.vxdApiRoute(0x45f); if (v) return this.vxdPmApi(v);   // the recompiled MSSNDSYS.VXD (vmm.js)
  const f = this.cpu.edx.value & 0xffff, ax = this.cpu.eax.value & 0xffff;
  let r, ok = true;
  if (f === 0) r = 0x400;                                                             // version
  else if (f === 1) {                                                                 // a card's record, ES:BX -> { size, ... }; AX bit 0: the one of devnode ECX
    const dn = ax & 1 ? this.devnode(this.cpu.ecx.value) : this.devnodes().find(d => this.wssRecord(d));
    const rec = dn && this.wssRecord(dn), b = this.lin((this.cpu.es.value << 16) | (this.cpu.ebx.value & 0xffff)), n = b && this.r32(b);
    if (!rec || !n || n > 0xba) { r = 0; ok = false; } else { this.u8.set(rec.subarray(0, n), b); r = 1; }
  } else if (f === 2 || f === 3) r = 0;                                               // acquire / release the codec at port AX for this VM
  // 200h links the driver with another by name (MSOPLMXD: the OPL synthesizer's mixer lines); with no such driver
  // loaded there is no link: DX:AX = 0. 201h ends a link
  else if (f === 0x200) { r = 0; ok = false; this.cpu.edx.value = lo16(this.cpu.edx.value, 0); }
  else if (f === 0x201) r = 0;
  // 6: the count left on the card's playback (BX 1) or capture DMA channel, as VDMAD_Get_Phys_Count reads it
  else if (f === 6) { if (this.sound16) this.sound16(); const c = this.dmaCount ? this.dmaCount(this.cpu.ebx.value & 0xffff) : null; if (c === null) { r = 0xffff; ok = false; } else r = c; }
  else { this.trapped = `unimplemented MSSNDSYS (VxD 45Fh) API function ${f.toString(16)}h`; return LAYOUT.SENTINEL; }
  this.cpu.eax.value = lo16(this.cpu.eax.value, r); this.cpu.cf.value = ok ? 0 : 1;
  return this.retf16(0);
});
// CONFIGMG's protected-mode API: the function (its service number) in AX, its arguments where the CONFIGMG.H helpers
// leave them, on the caller's cdecl frame at SS:BP+4 (dwords; pointers 16:16); AX = the CONFIGRET. The resources a
// devnode is given are the ones its card decodes (the emulated hardware's ports, IRQ and DMA channel, P.cards)
const cmArgs = p => { const a = p.cpu.ssb.value + (p.cpu.ebp.value & 0xffff) + 4; return i => p.r32(a + 4 * i); };
const CR = { SUCCESS: 0, INVALID_POINTER: 3, INVALID_DEVNODE: 5, NO_SUCH_DEVNODE: 0x0d, NO_MORE_LOG_CONF: 0x0e, NO_MORE_RES_DES: 0x0f, BUFFER_SMALL: 0x1a, NO_SUCH_VALUE: 0x25, REGISTRY_ERROR: 0x1d, DLVXD_NOT_FOUND: 0x0c, FAILURE: 0x13 };
/** a devnode's registry key under HKLM (CM_REGISTRY_SOFTWARE: its driver's key; else its Enum key), with a subkey */
P.cmKey = function (dn, sub, flags) {
  const k = flags & 1 ? (dn.driver ? 'System\\CurrentControlSet\\Services\\Class\\' + dn.driver : null) : 'Enum\\' + dn.id;
  return k && (sub ? `${k}\\${sub}` : k);
};
vxdApi(0x0033, 'CONFIGMG', {
  0() { return 0x400; },   // Get_Version
  // Locate_DevNode(far *dn, far device ID or NULL for the root, flags)
  2() { const arg = cmArgs(this), id = arg(1) ? (this.readA(this.lin(arg(1))) || '').toUpperCase() : null; const dn = id && this.devnodes().find(d => d.id === id); if (!dn) return CR.NO_SUCH_DEVNODE; this.w32(this.lin(arg(0)), dn.handle); return CR.SUCCESS; },
  // Get_Device_ID_Size(far *len, dn, flags), Get_Device_ID(dn, far buf, len, flags)
  6() { const arg = cmArgs(this), dn = this.devnode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; this.w32(this.lin(arg(0)), dn.id.length); return CR.SUCCESS; },
  7() { const arg = cmArgs(this), dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; if (arg(2) <= dn.id.length) return CR.BUFFER_SMALL; this.writeA(this.lin(arg(1)), dn.id, arg(2)); return CR.SUCCESS; },
  // Get_DevNode_Status(far *status, far *problem, dn, flags): started (DN_STARTED 8 | DN_DRIVER_LOADED 2 | DN_HAS_PROBLEM no)
  0x36() { const arg = cmArgs(this), dn = this.devnode(arg(2)); if (!dn) return CR.INVALID_DEVNODE; this.w32(this.lin(arg(0)), 0x0a | (dn.started ? 0 : 0)); if (arg(1)) this.w32(this.lin(arg(1)), 0); return CR.SUCCESS; },
  // Get_Alloc_Log_Conf(far CMCONFIG, dn, flags): the resources the devnode was given
  0x3b() { const arg = cmArgs(this), dn = this.devnode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; return this.cmConfig(dn, this.lin(arg(0))); },
  // Get_DevNode_Key_Size(far *len, dn, far subkey, flags), Get_DevNode_Key(dn, far subkey, far buf, len, flags)
  0x3c() { const arg = cmArgs(this), dn = this.devnode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; const k = this.cmKey(dn, arg(2) && this.readA(this.lin(arg(2))), arg(3)); if (!k) return CR.REGISTRY_ERROR; this.w32(this.lin(arg(0)), k.length + 1); return CR.SUCCESS; },
  0x3d() { const arg = cmArgs(this), dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; const k = this.cmKey(dn, arg(1) && this.readA(this.lin(arg(1))), arg(4)); if (!k) return CR.REGISTRY_ERROR; if (arg(3) <= k.length) return CR.BUFFER_SMALL; this.writeA(this.lin(arg(2)), k, arg(3)); return CR.SUCCESS; },
  // Read_Registry_Value(dn, far subkey, far name, type, far buf, far *len, flags), Write_Registry_Value(dn, far subkey, far name, type, far buf, len, flags)
  0x3e() {
    const arg = cmArgs(this), dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
    const k = this.cmKey(dn, arg(1) && this.readA(this.lin(arg(1))), arg(6)); if (!k) return CR.REGISTRY_ERROR;
    const v = window.W95Win32.regGet('hklm\\' + k, (arg(2) && this.readA(this.lin(arg(2)))) || ''); if (v === undefined) return CR.NO_SUCH_VALUE;
    const data = typeof v === 'string' ? window.W95FS.encode(v + '\0') : typeof v === 'number' ? new Uint8Array(new Uint32Array([v]).buffer) : v.data;
    const pn = this.lin(arg(5)), n = this.r32(pn); this.w32(pn, data.length); if (n < data.length) return CR.BUFFER_SMALL;
    this.u8.set(data, this.lin(arg(4))); return CR.SUCCESS;
  },
  0x3f() {
    const arg = cmArgs(this), dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
    const k = this.cmKey(dn, arg(1) && this.readA(this.lin(arg(1))), arg(6)); if (!k) return CR.REGISTRY_ERROR;
    const b = this.lin(arg(4)), n = arg(5);
    window.W95Win32.regSet('hklm\\' + k, (arg(2) && this.readA(this.lin(arg(2)))) || '', { type: arg(3), data: this.u8.slice(b, b + n) }); return CR.SUCCESS;
  },
});
/** CMCONFIG for a devnode: memory windows (9), I/O ports (20), IRQs (7), DMA channels (7), as Config_Buff_s lays them out */
P.cmConfig = function (dn, a) {
  const hw = this.cards && this.cards().find(c => c.devnode === dn.id);
  this.u8.fill(0, a, a + 0xd8);
  if (!hw) return CR.NO_MORE_LOG_CONF;
  const io = a + 2 + 36 + 36 + 18, irq = io + 2 + 40 + 40, dma = irq + 2 + 14;
  this.w16(io, hw.io.length); hw.io.forEach(([b, n], i) => { this.w16(io + 2 + 2 * i, b); this.w16(io + 42 + 2 * i, n); });
  this.w16(irq, hw.irq.length); hw.irq.forEach((n, i) => { this.u8[irq + 2 + i] = n; });
  this.w16(dma, hw.dma.length); hw.dma.forEach((n, i) => { this.u8[dma + 2 + i] = n; });
  return CR.SUCCESS;
};

/** call the VTDAPI periodic callbacks that are due; the host runs this between slices of guest code */
P.timers16 = function () {
  if (!(this.vtdCallbacks || this.vtdEvents) || this.depth) return;
  this.vtdCallbacks = this.vtdCallbacks || [];
  const now = this.now();
  for (const c of this.vtdCallbacks) if (now >= c.due) { c.due = Math.max(c.due + c.ms, now); this.tick16(); this.call16(c.sel, c.off, []); }
  for (const e of this.vtdEvents ? [...this.vtdEvents.values()] : []) {
    if (now < e.due || !this.vtdEvents.has(e.id)) continue;
    if (e.periodic) e.due = Math.max(e.due + e.ms, now); else this.vtdEvents.delete(e.id);
    this.tick16(); this.call16(e.sel, e.off, [['w', e.id], ['w', 0], ['l', e.user], ['l', 0], ['l', 0]]);
  }
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

// ---------------------------------------------------------------- display adapter: Tseng ET4000/W32p with a Sierra HiColor DAC
// The register file the drivers probe and program, 1 MB of VRAM behind a 64K window at A0000h selected through the
// segment select register (3CDh), the Tseng video BIOS modes, and the W32's hardware sprite (the CRTCB/sprite
// registers behind the IMA port 217Ah/217Bh).
const ET_MODES = { 0x03: [720, 400, 0], 0x13: [320, 200, 8], 0x2e: [640, 480, 8], 0x30: [800, 600, 8], 0x38: [1024, 768, 8] };
const VRAM_SIZE = 1 << 20, WIN = 0xa0000;
P.adapter = function () {
  if (this.et) return this.et;
  this.init16();
  const vramLin = this.alloc(VRAM_SIZE + 0x1000, true);
  return (this.et = { vramLin, vram: this.u8.subarray(vramLin, vramLin + VRAM_SIZE), flat: false, bank: 0, misc: 0x67, seq: new Uint8Array(256), gc: new Uint8Array(256), crtc: new Uint8Array(256),
    attr: new Uint8Array(256), idx: { seq: 0, gc: 0, crtc: 0, attr: 0 }, flip: 0, dacW: 0, dacR: 0, dac: new Uint8Array(768), pelMask: 0xff,
    hicolor: 0, hidden: 0, status: 0, mode: 3, w: 720, h: 400, bpp: 0, pitch: 0, dirty: true, ima: new Uint8Array(256), imaIdx: 0 });
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
/** the W32 hardware sprite as the CRTC overlays it: on (F7h bit 7), its screen position (E0h/E1h, E4h/E5h), the
 *  preset into the 64x64 image where display starts (E2h, E6h), and the image in VRAM at the start address (E8h-EAh,
 *  in dwords) with EBh quadwords per row, 2 bits a pixel, low bit first: bit 0 XOR, bit 1 AND (screen kept) */
P.sprite = function () {
  const a = this.adapter(), r = a.ima;
  if (!(r[0xf7] & 0x80)) return null;
  const start = ((r[0xea] & 0x0f) << 16 | r[0xe9] << 8 | r[0xe8]) * 4, row = (r[0xeb] || 2) * 8;
  const vram = this.scanout().vram;
  return { x: r[0xe1] << 8 | r[0xe0], y: r[0xe5] << 8 | r[0xe4], px: r[0xe2] & 0x3f, py: r[0xe6] & 0x3f, bits: vram.subarray(start, start + 64 * row), row };
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
  // the register values the BIOS loads for the mode: sequencer memory mode (chain-4 for the packed-pixel modes), the
  // CRTC's horizontal and vertical display end (with their overflow bits in 07h and Tseng's 35h) and its offset
  const vde = a.h - 1, off = a.bpp ? a.pitch >> 3 : a.w >> 3;
  a.misc = 0x63; a.seq[4] = a.bpp ? 0x0e : 0x02;
  a.crtc[0x01] = (a.w >> 3) - 1; a.crtc[0x12] = vde & 0xff;
  a.crtc[0x07] = (a.crtc[0x07] & ~0x42) | ((vde >> 8 & 1) << 1) | ((vde >> 9 & 1) << 6);
  a.crtc[0x35] = (a.crtc[0x35] & ~0x04) | ((vde >> 10 & 1) << 2);
  a.crtc[0x13] = off & 0xff; a.crtc[0x3f] = (a.crtc[0x3f] & 0x7f) | ((off >> 8 & 1) << 7);
  if (clear) { a.vram.fill(0); this.u8.fill(0, WIN, WIN + 0x10000); }
  a.bank = 0; a.dirty = true;
  if (a.bpp === 8 && clear) for (let i = 0; i < 256; i++) { a.dac[3 * i] = a.dac[3 * i + 1] = a.dac[3 * i + 2] = 0; }
  return true;
};
P.portIO = function (port, size, isIn) {
  if (window.W95PORTTRACE) window.W95PORTTRACE(port, size, isIn, this);
  if (this.vxdTrapIO && this.vxdTrapIO(port, size, isIn)) return;   // a port a VxD traps (vmm.js)
  if (this.soundIO && this.soundIO(port, size, isIn)) return;   // the sound card, DMA and interrupt controllers (sound.js)
  if (this.nicIO && this.nicIO(port, size, isIn)) return;   // the network card (lan.js)
  const a = this.adapter(), eax = this.cpu.eax.value;
  if (port >= 0x3b0 && port <= 0x3bf && port !== 0x3bf && !(a.misc & 1) === false) port += 0x20;   // mono CRTC aliases
  if (!isIn) {
    let val = size === 1 ? eax & 0xff : size === 2 ? eax & 0xffff : u32(eax);
    if (size === 2 && [0x3c4, 0x3ce, 0x3d4, 0x3c0, 0x217a].includes(port)) { this.portIO(port, 1, false); this.cpu.eax.value = (eax & ~0xff) | (val >> 8); this.portIO(port + 1, 1, false); this.cpu.eax.value = eax; return; }
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
      case 0x217a: a.imaIdx = val; return;
      case 0x217b: a.ima[a.imaIdx] = val; return;
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
    case 0x3da: a.flip = 0; a.status ^= 0x0b; r = a.status; break;   // display enable, vertical retrace and the blank bit toggle as the beam runs
    case 0x217a: r = a.imaIdx; break;
    case 0x217b: r = a.imaIdx === 0xec ? (a.ima[0xec] & 0x0f) | 0x30 : a.ima[a.imaIdx]; break;   // ECh's high nibble: the W32p revision
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
/** a free range of `size` bytes in a local heap; when none is left the heap's segment grows (up to 64K) as
 *  LocalAlloc grows it through GlobalReAlloc, and the new room joins the free list */
P.lget = function (h, size) {
  const a = lfind(h, size); if (a) return a;
  const b = this.gblock(h.sel); if (!b || b.size >= 0xfff0) return 0;
  const base = this.selBase(h.sel), info = this.r16(base + 6), end = this.r16(base + info + 0xa) + 4;
  const grow = Math.min(0xfff0, (Math.max(b.size, end) + ((size + 3) & ~3) + 0x200 + 0xff) & ~0xff);
  if (grow <= b.size || !K16['KERNEL.#16'][2].call(this, h.sel, grow, 0)) return 0;
  const nb = this.selBase(h.sel), nend = grow & ~3;
  this.w16(nb + info + 0xa, nend - 4);
  lrelease(h, end, nend - end);
  return lfind(h, size);
};
/** compact a local heap as KRNL386's LocalCompact does: each moveable block nobody has locked slides down over the free
 *  range below it (its handle entry and back-pointer following it), so the free space gathers above the blocks that
 *  stay put; true if anything moved */
P.localCompact = function (h) {
  const base = this.selBase(h.sel), byAddr = new Map([...h.handles].map(([ent, a]) => [a, ent]));
  let moved = false;
  for (let again = true; again;) {
    again = false;
    for (const a of [...h.blocks.keys()].sort((x, y) => x - y)) {
      const ent = byAddr.get(a); if (ent === undefined || this.u8[base + ent + 3]) continue;   // fixed, or locked
      const fi = h.free.findIndex(([fa, fn]) => fa + fn === a); if (fi < 0) continue;
      const [fa] = h.free[fi], n = h.blocks.get(a);
      this.u8.copyWithin(base + fa, base + a, base + a + n);
      h.blocks.delete(a); h.blocks.set(fa, n); h.handles.set(ent, fa); byAddr.delete(a); byAddr.set(fa, ent);
      this.w16(base + ent, fa + 2);
      h.free.splice(fi, 1); lrelease(h, fa + n, a - fa);
      moved = again = true;
    }
  }
  return moved;
};
P.localAlloc = function (flags, size, sel) {
  const h = this.lheap(sel);
  const moveable = !!(flags & LMEM_MOVEABLE), want = Math.max(size, 1) + (moveable ? 2 : 0);
  const a = this.lget(h, want) || (this.localCompact(h) && this.lget(h, want)); if (!a) return 0;
  let base = this.selBase(h.sel);
  h.blocks.set(a, (want + 3) & ~3);
  if (flags & LMEM_ZEROINIT || true) this.u8.fill(0, base + a, base + a + ((want + 3) & ~3));
  if (!moveable) return a;
  let ent = 0;
  for (const t of h.tables) { for (let k = 0; k < t.n; k++) { const e = t.at + 2 + 4 * k; if (this.u8[base + e + 3] === 0xff && this.u8[base + e + 2] === 0xff) { ent = e; break; } } if (ent) break; }
  if (!ent) {
    const n = 0x20, at = this.lget(h, 4 + 4 * n); if (!at) { lrelease(h, a, want); h.blocks.delete(a); return 0; }
    base = this.selBase(h.sel);
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
  const h = this.lheap(sel); let base = this.selBase(h.sel); hl &= 0xffff;
  if (flags & LMEM_MODIFY) { if (h.handles.has(hl)) this.u8[base + hl + 2] = (flags >> 8) & 0x0f; return hl; }
  const mov = h.handles.has(hl), a = this.localBlockOf(hl, sel), old = h.blocks.get(a);
  if (!old) return 0;
  const want = (Math.max(size, 1) + (mov ? 2 : 0) + 3) & ~3;
  if (want <= old) {
    if (want < old) { h.blocks.set(a, want); lrelease(h, a + want, old - want); }
    return hl;
  }
  // grown in place when the range after it is free: as it is, once the segment has grown (the new room follows the
  // heap's last block), and once the heap is compacted (the block may itself have moved down)
  const inPlace = () => {
    const at = mov ? h.handles.get(hl) : a, fi = h.free.findIndex(([fa, fn]) => fa === at + old && fn >= want - old);
    if (fi < 0) return false;
    const [fa, fn] = h.free[fi]; if (fn === want - old) h.free.splice(fi, 1); else h.free[fi] = [fa + want - old, fn - want + old];
    h.blocks.set(at, want); base = this.selBase(h.sel); if (flags & LMEM_ZEROINIT) this.u8.fill(0, base + at + old, base + at + want);
    return true;
  };
  if (inPlace()) return hl;
  if (!mov && !(flags & LMEM_MOVEABLE)) return 0;
  let na = this.lget(h, want);
  if (!na && inPlace()) return hl;
  if (!na && this.localCompact(h)) { if (inPlace()) return hl; na = this.lget(h, want); }
  if (!na) return 0;
  base = this.selBase(h.sel);
  const from = mov ? h.handles.get(hl) : a;
  this.u8.copyWithin(base + na, base + from, base + from + old); if (flags & LMEM_ZEROINIT) this.u8.fill(0, base + na + old, base + na + want);
  h.blocks.delete(from); lrelease(h, from, old); h.blocks.set(na, want);
  if (mov) { h.handles.set(hl, na); this.w16(base + hl, na + 2); this.w16(base + na, hl); return hl; }
  return na;
};

// ---------------------------------------------------------------- Local32 heaps (Win95 KERNEL.208..214)
const HTABLE = 0x10000, HPAGE = 0x1000, L32HDR = 0x80;   // handles start past the 80h-byte LOCAL32HEADER
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
def16('KERNEL', 13, 'w', 'w', function () { const lh = this.lheap(); this.localCompact(lh); return lh.free.reduce((m, f) => Math.max(m, f[1]), 0); });   // LocalCompact
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
// GetHeapSpaces(hModule): LOWORD = bytes free in its DGROUP's local heap, HIWORD = the size it can have (64K), the
// room the segment can still grow by counted as free
def16('KERNEL', 138, 'w', 'l', function (hm) {
  const m = this.neByHandle(hm), sel = m ? m.dgroup : hm, h = sel && this.lheaps.get(sel | 1);
  if (!h) return 0;
  const b = this.gblock(sel), size = b ? b.size : this.selLimit(sel) + 1;
  let free = Math.max(0, 0xfff0 - size); for (const [, n] of h.free) free += n;
  return u32((0xffff << 16) | Math.min(free, 0xffff));
});
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
def16('KERNEL', 501, 'w', 'w', function (v) { const old = this.k501 || 0; this.k501 = v & 0xff; return old; });   // (no name): KRNL386 swaps a byte of its data (19E3h) with the argument and returns the old one; MMSYSTEM sets 1 around loading a driver
def16('KERNEL', 159, 'w', 'l', function (sel) { return K16['KERNEL.#21'][2].call(this, sel); });   // GlobalHandleNoRIP: GlobalHandle without the debug-system complaint
def16('KERNEL', 122, '', 'w', () => 0);   // IsTaskLocked: no task has locked the system (LockCurrentTask)
def16('KERNEL', 491, 'll', 'l', () => 1);   // RegisterServiceProcess: the task is left out of the task list; there is no task list to leave
def16('KERNEL', 320, 'w', 'w', function (h) { return h && (h === this.currentTask() || [...(this.threadsById || new Map()).values()].some(t => t.tdb === h)) ? 1 : 0; });   // IsTask
/** a task database: the process's (its Win32 threads share it), or a Win16 task's own (MMTASK.TSK); the queue at 20h,
 *  'TD' at FAh */
const newTdb = p => { const a = p.alloc(0x200); p.u8.fill(0, a, a + 0x200); p.w16(a + 0xfa, 0x4454); return p.allocSels(a, 0x200); };
P.currentTask = function () {
  const t = this.thread16;
  if (t && t.task) { if (!t.tdb) { t.tdb = newTdb(this); this.w16(this.selBase(t.tdb) + 0x20, t.queue || 0); } return t.tdb; }
  return this.tdb16 || (this.tdb16 = newTdb(this));
};
def16('KERNEL', 47, 's', 'w', function (name) {   // GetModuleHandle
  if (typeof name === 'number') { const m = this.neByHandle(name); return m ? m.hModule : 0; }
  const n = (name || '').toUpperCase().replace(/^.*\\/, '').replace(/\.(DLL|EXE|DRV)$/, '');
  const m = this.ne.get(n);
  if (JS16.includes(n) && !(m && m.meta)) return this.jsModule(n).hModule;   // natively loaded only in a native-USER session
  return m ? m.hModule : 0;
});
def16('KERNEL', 133, 'w', 'w', function (h) {   // GetExePtr (a Win32 module's 16-bit handle is its own module)
  if (h === this.kernelModule().hModule) return h; if (this.hinst32 && this.hinst32(h)) return h;
  const m = this.neByHandle(h); return m ? m.hModule : 0;
});
def16('KERNEL', 228, 'w', 'w', function (h) { const m = this.neByHandle(h); return m ? m.hModule : 0; });
def16('KERNEL', 50, 'wx', 'l', function (h, name) {   // GetProcAddress
  const key = name >>> 16 ? this.readA(this.lin(name)) : name & 0xffff;
  const js = [...(this.jsMods || new Map()).values()].find(m => m.hModule === (h & 0xffff));
  if (js) {
    const ord = typeof key === 'number' ? key : names16(js.name)[key.toUpperCase()];
    if (!ord || !K16[`${js.name}.#${ord}`]) { console.warn('[ne16] GetProcAddress', js.name, key); return 0; }
    return this.thunk16For(`${js.name}.#${ord}`);
  }
  const m = this.neByHandle(h); return m ? this.neExport(m, key) : 0;
});
/** LoadLibrary's error for a module it could not load, as KRNL386's LoadModule gives it: 2 not found, 21 a Win32 image
 *  (which needs 32-bit Windows; SHELL32 tells 32-bit Control Panel files by it), 11 any other file */
P.loadError16 = function (name) {
  const full = this.findFile16(/\.[^\\]*$/.test(name) ? name : name + '.DLL'); if (!full) return 2;
  let f; try { f = this.fs.readFile(full); } catch (_) { return 2; }
  const n = f.length > 0x40 ? rd.u32(f, 0x3c) : 0;
  return f[0] === 0x4d && f[1] === 0x5a && n + 2 < f.length && f[n] === 0x50 && f[n + 1] === 0x45 ? 21 : 11;
};
def16('KERNEL', 95, 's', 'w', function (name) { const m = this.loadLibrary16(name); return m ? m.hInstance : this.loadError16(name); });    // LoadLibrary
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
// WIN32_OldYield: USER's PeekMessage calls it when the queue is empty. A thread not inside a call JS made gives up
// its slice once, so a loop polling PeekMessage (SHELL32's drag loop, for one) lets input and the other threads run.
def16('KERNEL', 447, '', 'v', function () {
  const t = thr(this, 0), top = this.thread16 ? this.depth === this.thread16.depth : this.depth === 0;
  if (top && !t.yielded) { t.yielded = true; return YIELD; }
  t.yielded = false;
});
def16('KERNEL', 471, '', 'l', function () { return this.inSystem && this.inSystem() ? SYS_PID : MAIN_PID; });   // GetCurrentProcessId: KERNEL32's ids
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
// MapLS (KRNL386 seg1:588F): a new selector based at the address itself, 64K limit; EAX = sel:0000, DX = sel. An
// address below 64K is returned as it is. Callers count on the zero offset (USER's 32->16 message thunk leaves AX
// from it in place when it calls a window procedure that takes its DS from AX). UnMapLS frees the selector.
def16('KERNEL', 358, '', 'jmp', function () {
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), a = this.r32(f + 4);
  if (a >>> 16) {
    const sel = this.allocSels(a, 0x10000);
    (this.mapped16 = this.mapped16 || new Set()).add(sel);
    this.cpu.eax.value = (sel << 16) >>> 0; this.cpu.edx.value = sel;
  } else this.cpu.eax.value = a;
  return this.retf16(4);
});
def16('KERNEL', 359, 'x', 'v', function (sp) {                                    // UnMapLS
  const sel = (sp >>> 16) & 0xfff8 | 7;
  if (this.mapped16 && this.mapped16.has(sel)) { this.mapped16.delete(sel); this.freeSels(sel, 1); }
});
def16('KERNEL', 613, '', 'jmp', function () {          // HugeMapLS: EAX = linear, ECX = size -> ECX = first tiled selector << 16 | selector count (GDI keeps it as deBits' selector and the unmap handle), EAX = 16:16
  const lin = u32(this.cpu.eax.value), n = u32(this.cpu.ecx.value); this.cpu.cf.value = 0;
  if (!lin) { this.cpu.eax.value = 0; this.cpu.ecx.value = 0; return this.retf16(0); }
  const sel = this.allocSels(lin, Math.max(n, 1));
  this.cpu.eax.value = (sel << 16) | 0; this.cpu.ecx.value = ((sel << 16) | Math.ceil(Math.max(n, 1) / 0x10000)) >>> 0;
  return this.retf16(0);
});
def16('KERNEL', 614, '', 'jmp', function () {          // HugeUnMapLS: ECX = the handle HugeMapLS returned
  const h = u32(this.cpu.ecx.value); if (h >>> 16) this.freeSels(h >>> 16, h & 0xffff || 1);
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
def16('KERNEL', 627, 'xlw', 'w', function (sp, n) { return okPtr.call(this, sp, n); });   // IsBadFlatReadWritePtr(16:16 from HugeMapLS, size, write)

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
def16('KERNEL', 219, 'lp', 'l', function (hk, sub) { return API.ADVAPI32.RegDeleteKeyA[1].call(this, hk, sub); });                // RegDeleteKey
def16('KERNEL', 220, 'l', 'l', function (hk) { return API.ADVAPI32.RegCloseKey[1].call(this, hk); });                                // RegCloseKey
def16('KERNEL', 221, 'lplpl', 'l', function (hk, sub, type, data, n) { return API.ADVAPI32.RegSetValueA[1].call(this, hk, sub, type, data, n); });   // RegSetValue
def16('KERNEL', 222, 'lp', 'l', function (hk, name) { return API.ADVAPI32.RegDeleteValueA[1].call(this, hk, name); });             // RegDeleteValue
def16('KERNEL', 223, 'llpppppp', 'l', function (hk, i, name, cbn, res, type, data, cb) { return API.ADVAPI32.RegEnumValueA[1].call(this, hk, i, name, cbn, res, type, data, cb); });   // RegEnumValue
def16('KERNEL', 225, 'lppppp', 'l', function (hk, name, res, type, data, cb) { return API.ADVAPI32.RegQueryValueExA[1].call(this, hk, name, res, type, data, cb); });
def16('KERNEL', 226, 'lpllpl', 'l', function (hk, name, res, type, data, n) { return API.ADVAPI32.RegSetValueExA[1].call(this, hk, name, res, type, data, n); });   // RegSetValueEx
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
// OpenFileEx: OpenFile with an OFSTRUCTEX (WORD size, BYTE fixed disk, WORD error, 4 reserved, a MAX_PATH path at 9)
def16('KERNEL', 360, 'spw', 'w', function (name, of, style) {
  const r = K16['KERNEL.#74'][2].call(this, name, 0, style), full = style & OF.CREATE ? (/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name)) : this.findFile16(name);
  if (of) {
    this.u8.fill(0, of, of + 9 + 260); this.w16(of, 9 + 260); this.u8[of + 2] = 1;
    if (full) W(this, of + 9, full.toUpperCase(), 260); else this.w16(of + 3, 2);
  }
  return r;
});
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
// a Win32 menu template (Unicode) in the 16-bit layout: the same items with ANSI text
const menu16 = d => {
  const out = [], ver = d[0] | d[1] << 8, hs = d[2] | d[3] << 8;
  let o = 4; out.push(d[0], d[1], d[2], d[3]); for (let k = 0; k < hs; k++) out.push(d[o++]);
  const text = () => { const c = []; for (;;) { const ch = d[o] | d[o + 1] << 8; o += 2; if (!ch || o > d.length) break; c.push(ch); } out.push(...window.W95FS.encode(String.fromCharCode(...c)), 0); };
  // items as KRNL386 converts them: standard items keep flags, id (none for MF_POPUP) and the text in ANSI; MENUEX
  // items become type, state, a word id, a byte resinfo and ANSI text, unaligned, popups followed by their help id
  for (let level = 1; level && o + 2 <= d.length;) {
    if (!ver) {
      const fl = d[o] | d[o + 1] << 8; o += 2; out.push(fl & 0xff, fl >> 8);
      if (fl & 0x10) level++; else { out.push(d[o], d[o + 1]); o += 2; }
      text();
      if (fl & 0x80) level--;
    } else {
      for (let k = 0; k < 8; k++) out.push(d[o++]);
      out.push(d[o], d[o + 1]); o += 4;
      const fl = d[o] | d[o + 1] << 8; o += 2; out.push(fl & 0xff);
      text(); o = (o + 3) & ~3;
      if (fl & 1) { for (let k = 0; k < 4; k++) out.push(d[o++]); level++; }
      if (fl & 0x80) level--;
    }
  }
  return new Uint8Array(out);
};
// a Win32 dialog template (DLGTEMPLATE, or DLGTEMPLATEEX by its signature FFFF0001) in the layout 16-bit USER reads,
// as KRNL386's converter (seg2:785E) writes it: a byte item count, items as x, y, cx, cy, id, style, predefined
// classes as one byte, ANSI strings (characters with no ANSI form become '_'); the extended form keeps its extra
// fields and word-sized extra counts. Items are DWORD-aligned in the source.
const dialog16 = d => {
  const out = []; let i = 0;
  const r16 = () => { const v = d[i] | d[i + 1] << 8; i += 2; return v; }, r32 = () => { const v = (d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24) >>> 0; i += 4; return v; };
  const b = v => out.push(v & 0xff), w16 = v => out.push(v & 0xff, (v >> 8) & 0xff), w32 = v => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const copy = n => { for (let k = 0; k < n; k++) out.push(d[i + k]); i += n; };
  const str = () => {
    const c = []; for (;;) { const ch = r16(); if (!ch || i > d.length) break; c.push(ch); }
    const t = window.W95FS.encode(String.fromCharCode(...c)); for (let k = 0; k < t.length; k++) b(c[k] < 0x80 || t[k] !== 0x3f ? t[k] : 0x5f); b(0);
  };
  const szOrOrd = () => { const v = d[i] | d[i + 1] << 8; if (!v) { i += 2; b(0); } else if ((v & 0xff) === 0xff) { i += 2; b(0xff); copy(2); } else str(); };
  let style = r32(); const ex = style === 0xffff0001;
  if (ex) { w32(style); copy(8); style = r32(); }
  w32(style);
  if (!ex) i += 4;
  let n = r16() & 0xff; b(n); copy(8);
  szOrOrd(); szOrOrd(); str();
  if (style & 0x40) { copy(2); if (ex) copy(4); str(); }
  for (; n; n--) {
    i = (i + 3) & ~3;
    if (ex) copy(24);
    else { const st = (d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24) >>> 0; i += 8; copy(10); w32(st); }
    const c = d[i] | d[i + 1] << 8;
    if (!c) { i += 2; b(0); } else if (c === 0xffff) { i += 2; b(r16() & 0xff); } else str();   // class
    szOrOrd();                                                                                     // text
    const extra = r16(); if (ex) w16(extra); else b(extra & 0xff);
    if (extra) copy(extra);
  }
  return new Uint8Array(out);
};
// a Win32 module's resources, reached through its 16-bit handle (USER loading for a Win32 program); returned in the
// layout 16-bit USER reads: accelerator tables go from 8-byte to 5-byte entries, menus and dialogs to ANSI text
const res32 = (p, h32, id, type) => {
  const mod = p.moduleFor(h32); if (!mod || mod.base !== h32) return null;
  const r = p.findResource(type, id, mod); if (!r) return null;
  let data = p.u8.slice(r.addr, r.addr + r.size);
  if (type === 9) {   // RT_ACCELERATOR
    const out = []; for (let o = 0; o + 8 <= data.length; o += 8) { out.push(data[o], data[o + 2], data[o + 3], data[o + 4], data[o + 5]); if (data[o] & 0x80) break; }
    data = new Uint8Array(out);
  }
  if (type === 6) {   // RT_STRING: 16 strings of WORD length and UTF-16 text -> BYTE length and ANSI text
    const out = [];
    for (let o = 0, k = 0; k < 16 && o + 2 <= data.length; k++) {
      const n = data[o] | data[o + 1] << 8, c = []; o += 2;
      for (let j = 0; j < n && o + 1 < data.length; j++, o += 2) c.push(data[o] | data[o + 1] << 8);
      const t = window.W95FS.encode(String.fromCharCode(...c)).subarray(0, 255); out.push(t.length, ...t);
    }
    data = new Uint8Array(out);
  }
  if (type === 4) data = menu16(data);   // RT_MENU
  if (type === 5) data = dialog16(data); // RT_DIALOG
  return data;
};
def16('KERNEL', 60, 'wxx', 'w', function (h, name, type) {     // FindResource
  const h32 = this.hinst32 && this.hinst32(h);
  if (h32) {
    const data = res32(this, h32, resKey.call(this, name), resKey.call(this, type)); if (!data) return 0;
    (this.resHandles = this.resHandles || []).push({ data }); return this.resHandles.length * 4;
  }
  const m = this.neByHandle(h); if (!m) return 0;
  const k = resKey.call(this, name), t = resKey.call(this, type);
  const i = this.neResources(m).findIndex(r => r.id === k && r.type === t);
  if (i < 0) return 0;
  (this.resHandles = this.resHandles || []).push({ m, r: m.res[i] }); return this.resHandles.length * 4;
});
def16('KERNEL', 168, 'www', 'w', function (h, type, size) { return this.globalAlloc16(GMEM_MOVEABLE, size); });   // DirectResAlloc
def16('KERNEL', 61, 'ww', 'w', function (h, hr) {               // LoadResource
  const e = this.resHandles && this.resHandles[hr / 4 - 1]; if (!e) return 0;
  if (!e.g && e.data) { e.g = this.globalAlloc16(0, e.data.length || 1); this.u8.set(e.data, this.gblock(e.g).lin); }
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
def16('KERNEL', 444, 'pw', 'w', function (info, sel) {   // Local32Info -> LOCAL32INFO of the heap in segment `sel`
  const h = this.l32heaps && [...this.l32heaps.values()].find(x => (this.r32(x.hdr + 104) | 7) === (sel | 7));
  if (!h || !info) return 0;
  let free = 0, big = 0; for (const [, n] of h.free) { free += n; big = Math.max(big, n); }
  let used = 0; for (const n of h.blocks.values()) used += n;
  this.w32(info + 4, free + used); this.w32(info + 8, free + used); this.w32(info + 12, free); this.w32(info + 16, big); this.w32(info + 20, free >>> 12);
  return 1;
});
def16('KERNEL', 445, 'pw', 'w', () => 0);
def16('KERNEL', 446, 'p', 'w', () => 0);

// 32-bit DLL loading from 16-bit code, and the SL (16 -> 32) thunk transition
def16('KERNEL', 482, 's', 'l', function (name) {          // LoadSystemLibrary32
  const n = (name || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, '');
  const m = this.loadDll(n); if (!m) return 0;
  this.runPendingInits();
  return m.base;
});
def16('KERNEL', 619, 'wxl', 'w', function (id, relay16, relay32) {         // RegisterCBClient: a callback client's 16-bit entry and 32-bit relay table
  (this.cbClients = this.cbClients || new Map()).set(id, { relay16, relay32 }); return 1;
});
// AllocSLThunkletCallbackEx: a 16:16 entry that calls a 32-bit function through a callback client's relay. The
// thunklet is code as Windows 95 writes it (push dword target, push dword relay, jmp far glue), so IsSLThunklet
// knows it and 16-bit code calls it like any far function; `relay` is the client id (high word) and relay index.
// A target that is itself an LS thunklet with this relay is the 16-bit function it wraps (KRNL386 seg3:1D42), so a
// procedure handed out to 32-bit code and given back (SetWindowLong of the old window procedure) is the original one.
def16('KERNEL', 568, 'llw', 'l', function (target, relay, owner) {
  this.thunklets = this.thunklets || new Map();
  const ls = this.lsThunklets && this.lsThunklets.get(u32(target));
  if (ls && ls.relay === u32(relay)) return ls.target;
  const key = `${u32(target)}:${u32(relay)}`; if (this.thunklets.has(key)) return this.thunklets.get(key);
  if (!this.thunkletSeg || this.thunkletSeg.used + 16 > 0x10000) {
    const lin = this.alloc(0x10000); this.thunkletSeg = { lin, sel: this.allocSels(lin, 0x10000, 0xfb00), used: 0 };
  }
  const t = this.thunkletSeg, off = t.used, a = t.lin + off, glue = this.thunk16For('THUNKLET.#1');
  this.u8.set([0x66, 0x68], a); this.w32(a + 2, target); this.u8.set([0x66, 0x68], a + 6); this.w32(a + 8, relay);
  this.u8[a + 12] = 0xea; this.w16(a + 13, glue & 0xffff); this.w16(a + 15, glue >>> 16);
  t.used += 17;
  const sp = u32((t.sel << 16) | off); this.thunklets.set(key, sp);
  (this.slThunklets = this.slThunklets || new Map()).set(sp, { target: u32(target), relay: u32(relay) });
  return sp;
});
// AllocLSThunkletCallback (#561): a 32-bit entry for a 16-bit function, laid out as Windows 95 writes one (nop; push
// dword target; nop; push dword relay; jmp glue) so 32-bit code can call it and recognise it; the glue is the 32-bit
// routine InitCBClient registered (USER32's), which calls the target through the relay. Run by dataCode.
// (and, as KRNL386 seg3:1CEF does, an SL thunklet with this relay given back is the 32-bit function it wraps)
def16('KERNEL', 561, 'll', 'l', function (target, relay) {
  this.lsThunklets = this.lsThunklets || new Map();
  const sl = this.slThunklets && this.slThunklets.get(u32(target));
  if (sl && sl.relay === u32(relay)) return sl.target;
  for (const [a, t] of this.lsThunklets) if (t.target === u32(target) && t.relay === u32(relay)) return a;
  const a = this.alloc(16);
  this.u8.set([0x90, 0x68], a); this.w32(a + 2, target); this.u8.set([0x90, 0x68], a + 6); this.w32(a + 8, relay);
  this.u8[a + 12] = 0xe9; this.w32(a + 13, u32((this.cbGlueLS || 0) - (a + 17)));
  this.lsThunklets.set(a, { target: u32(target), relay: u32(relay) });
  return a;
});
// AllocSLThunkletCallback (#562): #568 for the current owner, as KRNL386 forwards it
def16('KERNEL', 562, 'll', 'l', function (target, relay) { return K16['KERNEL.#568'][2].call(this, target, relay, 0); });
// The glue every thunklet jumps to (KRNL386 seg2:75E6, which InitCBClient installs). On entry the 16-bit stack holds
// [relay index][client id][target][return CS:IP][arguments]; it saves BP, SI, DI and DS with BP at the saved BP and
// jumps to the client's 16-bit relay for that index (RegisterCBClient's table), which moves on to the 32-bit side.
def16('THUNKLET', 1, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), push16 = v => { const sp = (this.cpu.esp.value - 2) & 0xffff; this.cpu.esp.value = lo16(this.cpu.esp.value, sp); this.w16(ssb + sp, v); };
  push16(this.cpu.ebp.value & 0xffff);
  const bp = this.cpu.esp.value & 0xffff; this.cpu.ebp.value = lo16(this.cpu.ebp.value, bp);
  push16(this.cpu.esi.value & 0xffff); push16(this.cpu.edi.value & 0xffff); push16(this.cpu.ds.value & 0xffff);
  this.seg('gsel', 0);
  const index = this.r16(ssb + ((bp + 2) & 0xffff)), id = this.r16(ssb + ((bp + 4) & 0xffff));
  const c = this.cbClients && this.cbClients.get(id);
  if (!c) throw new GuestError(`thunklet for callback client ${id}, which is not registered`);
  const relay = this.r32(this.lin(c.relay16) + 4 * index);
  this.seg('ds', c.relay16 >>> 16);
  this.seg('cs', relay >>> 16);
  return u32(this.selBase(relay >>> 16) + (relay & 0xffff));
});
// CallProc32W (#517): calls a 32-bit stdcall function with `n` DWORD parameters pushed in Pascal order after
// (n, conversion mask, proc); mask bit i converts the i-th parameter from the stack top from 16:16 to linear.
// Returns the result in DX:AX and removes everything the caller pushed.
def16('KERNEL', 517, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), f = ssb + (this.cpu.esp.value & 0xffff);
  const n = this.r32(f + 4) & 0x7fffffff, mask = this.r32(f + 8), proc = this.r32(f + 12);
  const args = new Array(n);
  for (let i = 0; i < n; i++) { const v = this.r32(f + 16 + 4 * i); args[n - 1 - i] = mask & (1 << i) ? this.lin(v) : v; }
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  save.done = function (c) {
    const r = u32(this.cpu.eax.value); if (window.W95CP32) window.W95CP32(proc, args, r);
    for (const g of GPR) this.cpu[g].value = c[g]; for (const [s, b] of SEGS) { this.cpu[s].value = c[s]; this.cpu[b].value = c[b]; }
    this.cpu.eax.value = r | 0; this.cpu.edx.value = lo16(this.cpu.edx.value, r >>> 16);
    return this.retf16(12 + 4 * n);
  };
  // on the flat alias of the 16-bit stack, as KRNL386's 16 -> 32 callbacks run
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor();
  let esp = f & ~3;
  for (let i = n - 1; i >= 0; i--) { esp -= 4; this.w32(esp, args[i]); }
  esp -= 4; this.w32(esp, this.thunkFor('KERNEL32', '__Ret32.' + this.retToken(save)));
  this.cpu.esp.value = esp;
  return proc;
});
// VWin32_BoostThreadGroup / VWin32_BoostThreadStatic (#535, #536): scheduler priority boosts through VWIN32; one
// thread runs here, so there is nothing to boost
def16('KERNEL', 535, 'll', 'v', function () {});
def16('KERNEL', 536, 'll', 'v', function () {});
// clipboard and DDE data between the 32-bit and 16-bit sides (KRNL386 seg3, #531/#532/#542). A GDI object's handle
// (bitmap, palette, enhanced metafile and their display formats) is the same on both sides. Memory is copied: a Win32
// block into a new 16-bit one (#531, as SetClipboardData hands it over), a 16-bit block into a new Win32 one (#532, as
// GetClipboardData hands it out). Each 16-bit block remembers the Win32 block it came from or went to, which the
// clipboard owns from then on; #542 (with the 16-bit handle, as USER empties or closes the clipboard) frees that Win32
// block, and the 16-bit block stays
const CLIP_GDI = new Set([2, 9, 0x0e, 0x82, 0x8e]), CLIP_MFP = new Set([3, 0x83]);
const clip32 = p => p.clip32 || (p.clip32 = new Map());   // 16-bit selector -> its Win32 block
def16('KERNEL', 531, '', 'jmp', function () {   // (fmt, hMem32, flag) -> a 16-bit global handle holding a copy
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), h = this.r32(f + 6), fmt = this.r16(f + 10);
  let r = 0;
  if (CLIP_GDI.has(fmt)) r = h & 0xffff;
  else if (!CLIP_MFP.has(fmt) && h >>> 16) {
    const n = this.allocs.get(h) || 0;
    r = this.globalAlloc16(0x2002, n);
    if (r && n) this.u8.copyWithin(this.gblock(r).lin, h, h + n);
    if (r) clip32(this).set(this.gsel(r), h);
  }
  this.cpu.eax.value = r; this.cpu.edx.value = 0;
  return this.retf16(8);
});
def16('KERNEL', 532, '', 'jmp', function () {   // (fmt, hMem16, flag) -> a Win32 block holding a copy
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), h = this.r16(f + 6), fmt = this.r16(f + 8);
  let r = 0;
  if (CLIP_GDI.has(fmt)) r = h;
  else if (!CLIP_MFP.has(fmt)) {
    const b = this.gblock(h), sel = this.gsel(h), old = clip32(this).get(sel);
    if (b) {
      if (old) this.free(old);   // the copy handed out before: the clipboard's, replaced by this one
      r = this.alloc(b.size); this.u8.copyWithin(r, b.lin, b.lin + b.size); clip32(this).set(sel, r);
    }
  }
  this.cpu.eax.value = r | 0; this.cpu.edx.value = r >>> 16;   // in EAX (USER's thunk returns it to USER32 as is) and DX:AX
  return this.retf16(6);
});
def16('KERNEL', 542, '', 'jmp', function () {   // (handle16): free the Win32 block that goes with a 16-bit block
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), h = this.r32(f + 4) & 0xffff, sel = this.gsel(h), w = h && clip32(this).get(sel);
  if (w) { clip32(this).delete(sel); this.free(w); }
  this.cpu.eax.value = 0;
  return this.retf16(4);
});
// KRNL386 seg2:7A70 (#618): the size in bytes of a Win32 dialog template, DLGTEMPLATE or DLGTEMPLATEEX (signature
// FFFF0001), as USER needs it to copy one; items are DWORD-aligned
def16('KERNEL', 618, 'x', 'w', function (sp) {
  const a = this.lin(sp); let o = 0;
  const w = () => { const v = this.r16(a + o); o += 2; return v; }, d = () => { const v = this.r32(a + o); o += 4; return v; };
  const skipStr = () => { while (w()); };
  const szOrOrd = () => { const v = w(); if (!v) return; if ((v & 0xff) === 0xff) w(); else skipStr(); };
  let style = d(); const ex = u32(style) === 0xffff0001;
  if (ex) { o += 8; style = d(); } else d();
  let n = w() & 0xff; o += 8;
  szOrOrd(); szOrOrd(); skipStr();
  if (style & 0x40) { w(); if (ex) d(); skipStr(); }
  for (; n; n--) {
    o = (o + 3) & ~3;
    o += ex ? 24 : 18;
    { const v = w(); if (v) { if (v === 0xffff) w(); else skipStr(); } }   // class
    szOrOrd();                                                            // title
    let extra = w(); if (!ex) extra &= 0xff; o += extra;
  }
  return o & 0xffff;
});
// KRNL386 seg2:785E (#615): a Win32 dialog template at flat `src` written at flat `dst` in the layout 16-bit USER
// reads (dialog16)
def16('KERNEL', 615, 'lll', 'v', function (src, size, dst) {
  const out = dialog16(this.u8.subarray(u32(src), u32(src) + (size || 0x10000)));
  this.u8.set(out, u32(dst));
});
// GetDummyModuleHandleDS (#602): for a Win32 task, AX and DS = the selector of its stand-in module (0 otherwise)
def16('KERNEL', 602, '', 'jmp', function () {
  const sel = this.exe && this.nativeUser16() && !this.thread16 ? this.hinst16(this.exe.base) : 0;
  this.cpu.eax.value = lo16(this.cpu.eax.value, sel); if (sel) this.seg('ds', sel);
  return this.retf16(0);
});
// ---- what SHELL.DLL and COMMCTRL.DLL ask of KERNEL
def16('KERNEL', 48, 'w', 'w', () => 1);                                                // GetModuleUsage
def16('KERNEL', 51, 'xw', 'x', fp => fp);                                              // MakeProcInstance: protected mode needs no thunk
def16('KERNEL', 52, 'x', 'v', () => {});                                               // FreeProcInstance
def16('KERNEL', 65, 'ww', 'l', function (h, hr) {                                      // SizeofResource
  const e = this.resHandles && this.resHandles[hr / 4 - 1]; if (!e) return 0;
  return e.data ? e.data.length : e.r ? e.r.size || e.r.len || 0 : 0;
});
def16('KERNEL', 115, 'x', 'v', () => {});                                              // OutputDebugString
def16('KERNEL', 131, '', 'l', function () {                                            // GetDOSEnvironment
  if (!this.dosEnv) { const s = 'COMSPEC=C:\\COMMAND.COM\0PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND\0TEMP=C:\\WINDOWS\\TEMP\0windir=C:\\WINDOWS\0\0';
    const g = this.globalAlloc16(0, s.length + 16), a = this.gblock(g).lin; for (let i = 0; i < s.length; i++) this.u8[a + i] = s.charCodeAt(i); this.dosEnv = this.gsel(g); }
  return u32(this.dosEnv << 16);
});
def16('KERNEL', 157, 'l', 'l', () => 0);                                              // GetCurPID
def16('KERNEL', 166, 'sw', 'w', function (cmd, show) { return this.host && this.host.exec ? this.host.exec(cmd, show) : 2; });   // WinExec: 2 = file not found
def16('KERNEL', 169, 'w', 'l', () => 0x01000000);                                     // GetFreeSpace: 16 MB
def16('KERNEL', 328, '', 'jmp', function () { return this.retf16(0); });              // _DebugOutput (cdecl): kept only under a debugger
// Catch / Throw: the registers a Throw goes back to, in the 9-word CATCHBUF (IP, CS, SP after Catch returns, BP, SI,
// DI, DS, 0, SS); Catch returns 0, and returns again with Throw's value
def16('KERNEL', 55, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), sp = this.cpu.esp.value & 0xffff, f = ssb + sp, buf = this.lin(this.r32(f + 4));
  [this.r16(f), this.r16(f + 2), (sp + 8) & 0xffff, this.cpu.ebp.value & 0xffff, this.cpu.esi.value & 0xffff, this.cpu.edi.value & 0xffff,
   this.cpu.ds.value & 0xffff, 0, this.cpu.ss.value & 0xffff].forEach((v, i) => this.w16(buf + 2 * i, v));
  this.ax(0); return this.retf16(4);
});
def16('KERNEL', 56, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), f = ssb + (this.cpu.esp.value & 0xffff), v = this.r16(f + 4), buf = this.lin(this.r32(f + 6));
  const w = i => this.r16(buf + 2 * i);
  this.seg('ss', w(8)); this.cpu.esp.value = lo16(this.cpu.esp.value, w(2));
  this.cpu.ebp.value = lo16(this.cpu.ebp.value, w(3)); this.cpu.esi.value = lo16(this.cpu.esi.value, w(4)); this.cpu.edi.value = lo16(this.cpu.edi.value, w(5));
  this.seg('ds', w(6)); this.ax(v);
  this.seg('cs', w(1)); return u32(this.selBase(w(1)) + w(0));
});
// KRNL386 seg1:5CD0 (#490): exchanges a KERNEL word (its data at 121Ah) with the argument, returning the old value
def16('KERNEL', 490, 'w', 'w', function (v) { const o = this.k490 || 0; this.k490 = v; return o; });
// ThunkConnect16 (#651): a thunk-compiler DLL's 16-bit half announcing itself (SHELL.DLL). Its 32-bit half connected
// already or connects late, so there is nothing to record here.
// For 'SL01' thunk data (16 -> 32 calls, VER.DLL to VERSION.DLL) the names are kept for C16ThkSL01 to find the 32-bit
// half's target table by.
def16('KERNEL', 651, 'sswlxsw', 'w', function (dll16, dll32, hinst, reason, td, name32) {
  if (reason === 1 && td >>> 16 && this.readA(this.lin(td), 4) === 'SL01') { const sl = this.sl01 || (this.sl01 = new Map()); sl.set(this.lin(td), Object.assign(sl.get(this.lin(td)) || {}, { dll32, name32 })); }
  return 1;
});
// C16ThkSL01 (#631): a thunk-compiler stub's 16 -> 32 call. EDX = 16:16 of its ThunkDataSL16, CX = target number * 4,
// the caller's return address on top of the stack. The target is entry CX/4 of the 32-bit half's table (at its
// ThunkDataSL32 + the offset at +20h); a table entry that is no code of that module means the target is not there, and
// the call returns the error value the 16-bit API database (ThunkDataSL16 +28h: {argument bytes, error value} per
// target) gives, dropping the arguments, as for a 32-bit half that never connected.
def16('KERNEL', 631, '', 'jmp', function () {
  const td = this.lin(u32(this.cpu.edx.value)), cx = this.cpu.ecx.value & 0xffff, rec = this.sl01 && this.sl01.get(td);
  if (rec && !rec.mod && rec.dll32) {
    const m = this.loadDll(String(rec.dll32 || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, ''));
    const td32 = m && m.exports.get(rec.name32);
    if (td32) Object.assign(rec, { mod: m, table: u32(td32 + (this.r32(td32 + 0x20) | 0)) });
  }
  const tgt = rec && rec.table ? this.r32(rec.table + cx) : 0;
  if (rec && rec.mod && tgt >= rec.mod.meta.textLo && tgt < rec.mod.meta.textHi) return this.enter32from16(tgt);
  const db = this.lin(this.r32(td + 0x28)), nargs = db ? this.r32(db + 2 * cx) : 0, err = db ? this.r32(db + 2 * cx + 4) : 0;
  const ssb = u32(this.cpu.ssb.value), sp = this.cpu.esp.value & 0xffff, ip = this.r16(ssb + sp), cs = this.r16(ssb + ((sp + 2) & 0xffff));
  this.cpu.eax.value = lo16(this.cpu.eax.value, err & 0xffff); this.cpu.edx.value = lo16(this.cpu.edx.value, err >>> 16);
  this.cpu.esp.value = lo16(this.cpu.esp.value, sp + 4 + nargs);
  this.seg('cs', cs); return u32(this.selBase(cs) + ip);
});
/** the module a task handle stands for: a Win16 task's own (MMTASK), or the process's program, whose name is its file's */
P.taskModuleName = function (h) {
  h &= 0xffff; if (!h) return null;
  const t = [...(this.threadsById || new Map()).values()].find(x => x.tdb === h);
  if (t && t.task) { const m = this.neByHandle(t.task.hInst); return m ? m.name : null; }
  if (h === this.tdb16 && this.exe) { const f = (this.host && this.host.path) || this.meta.name || ''; return f.replace(/^.*\\/, '').replace(/\.[^.]*$/, '').toUpperCase() || null; }
  return null;
};
def16('KERNEL', 27, 'wpw', 'w', function (h, buf, n) { const m = this.neByHandle(h), name = m ? m.name : this.taskModuleName(h); return name ? W(this, buf, name, n) : 0; });   // GetModuleName (of a module, an instance or a task)
// GetCodeInfo (#104): the SEGINFO of the module segment a code pointer is in (file sector, length, flags, allocation,
// handle, alignment shift), with ES = the module, as KRNL386 leaves it; 0 when the pointer is in no module's segment
def16('KERNEL', 104, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), f = ssb + (this.cpu.esp.value & 0xffff);
  const info = this.r32(f + 4), proc = this.r32(f + 8), sel = (proc >>> 16) | 7;
  let found = null;
  for (const m of this.ne.values()) { const sg = m.meta && m.segs && m.segs.find(x => (x.sel | 7) === sel); if (sg) { found = { m, sg }; break; } }
  if (found && info >>> 16) {
    const a = this.lin(info), { m, sg } = found;
    this.w16(a, 0); this.w16(a + 2, sg.len || 0); this.w16(a + 4, sg.flags || 0); this.w16(a + 6, sg.alloc || sg.len || 0);
    this.w16(a + 8, sg.sel); this.w16(a + 10, 4);
    this.seg('es', m.hModule);
  }
  this.ax(found ? 1 : 0);
  return this.retf16(8);
});
// KRNL386 seg1:7A28 (#365): adds `delta` (+1 or -1) to the lock count of the global block a selector belongs to; the
// callback relays lock the caller's stack segment while 32-bit code holds pointers into it
def16('KERNEL', 365, 'wi', 'v', function (sel, delta) {
  const b = this.gblock(sel | 1); if (!b) return;
  b.lock = Math.max(0, Math.min(0xff, (b.lock || 0) + delta));
});
// CBClientThunkSL (#620, KRNL386 seg2:7667): a callback client's 16-bit relay moving to its 32-bit side. It pushes the
// 16:16 SS:SP, makes EBX the flat address of that pair and EBP the flat BP (the relay word, client id high and index
// low, at [EBP+2]), moves to the flat stack, and goes to the client's 32-bit relay for that index, which comes back
// with `lss sp, [ebx]`.
def16('KERNEL', 620, '', 'jmp', function () {
  const ss = this.cpu.ss.value & 0xffff, ssb = u32(this.cpu.ssb.value), n = this.cpu.esp.value & 0xffff;
  const sp = (n - 4) & 0xffff; this.w16(ssb + sp, n); this.w16(ssb + ((sp + 2) & 0xffff), ss);
  const ebx = u32(ssb + sp), ebp = u32(ebx + (((this.cpu.ebp.value & 0xffff) - sp) & 0xffff));
  const word = this.r32(ebp + 2), c = this.cbClients && this.cbClients.get(word >>> 16);
  if (!c) throw new GuestError(`callback relay for client ${word >>> 16}, which is not registered`);
  const relay = this.r32(c.relay32 + 4 * (word & 0xffff));
  this.cpu.ebx.value = ebx | 0; this.cpu.ebp.value = ebp | 0;
  for (const [s2, b] of SEGS) { this.cpu[s2].value = 0; if (s2 !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor();
  this.cpu.esp.value = (ebx & ~3) | 0;
  return u32(relay);
});
// IsSLThunklet: whether a far pointer addresses a 16-to-32 thunklet (push dword, push dword, jmp far), as KRNL386 checks
def16('KERNEL', 612, 'x', 'w', function (sp) {
  if (!(sp >>> 16) || !this.selValid(sp >>> 16)) return 0;
  const a = this.lin(sp);
  return this.r16(a) === 0x6866 && this.r16(a + 6) === 0x6866 && this.u8[a + 12] === 0xea ? 1 : 0;
});
// InitCBClient: the 32-bit glue routine (USER32's) that 16-to-32 callbacks of registered clients go through
def16('KERNEL', 623, 'l', 'w', function (glue) { this.cbGlueLS = glue; return 1; });
def16('KERNEL', 605, 'll', 'l', function (target, rel) { return this.slThunklet(target, rel); });   // AllocSLThunkletCallback
// FindSLThunkletCallback: the thunklet already made for this target and relay, else a new one (KRNL386 looks it up,
// then allocates); thunklets here are the target itself, so both are the same
def16('KERNEL', 610, 'll', 'l', function (target, rel) { return this.slThunklet(target, rel); });
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
// a waitable object: an event, or a thread, which is signalled once it has ended (it stays signalled)
const ev16 = (p, h) => {
  const o = p.obj(h); if (!o) return null;
  if (o.kind === 'event') return o;
  if (o.kind === 'thread') { const t = p.threadsById && p.threadsById.get(o.id); return { manual: true, get set() { return !t || t.state === 'done'; }, set set(_) {} }; }
  return null;
};
/** set an event and make the threads blocked on it runnable (they check their wait again when they run) */
P.signal = function (e) { if (!e) return; e.set = true; this.wakeWaiters(e); };
P.wakeWaiters = function (o) { if (o.waiters) { for (const t of o.waiters) t.blocked = false; o.waiters.clear(); } };
def16('KERNEL', 457, 'll', 'l', function (manual, initial) { return this.newHandle({ kind: 'event', manual: !!manual, set: !!initial }); });   // CreateW32Event
def16('KERNEL', 458, 'l', 'l', function (h) { const e = ev16(this, h); if (!e) return 0; this.signal(e); return 1; });   // SetW32Event
def16('KERNEL', 459, 'l', 'l', function (h) { const e = ev16(this, h); if (!e) return 0; e.set = false; return 1; });  // ResetW32Event
// WaitForSingleObject: a thread waiting at its top level for an event that is not set gives up its slice (the other
// threads, the system thread among them, run) and waits again when resumed; elsewhere the wait times out at once
def16('KERNEL', 460, 'll', 'l', function (h, ms) {
  const e = ev16(this, h); if (!e) return 0xffffffff;
  if (!e.set && ms && this.atThreadTop()) return YIELD;
  if (!e.set && ms) this.waitNested(() => e.set);
  if (!e.set) return 0x102; if (!e.manual) e.set = false; return 0;
});
/** a wait inside a call (the waiting code cannot give up its slice): each other thread and task gets one turn, up to
 *  its next wait, as the processor would pass to them; the caller then finds the object set or not */
P.waitNested = function (done) {
  if (!done()) this.threads16(true);
};
P.atThreadTop = function () { return this.thread16 ? this.depth === this.thread16.depth : this.depth === 0 && !this.inSystem(); };
/** whether USER is running as the system thread: its start-up, and its message loop between slices (systemPump) */
P.inSystem = function () { return this.user16Ready === false || !!this.sysPumping; };
/**
 * The system thread's message loop, which Windows 95 runs in its own thread: messages for the windows USER made at
 * start-up (the desktop's among them), including the ones a program's thread sends and waits on. The host runs it
 * between slices.
 */
P.systemPump = function () {
  if (!this.user16Ready || this.depth || this.thread16 || this.sysPumping) return;
  const sys = this.threadsById && this.threadsById.get(SYS_TID); if (!sys || !sys.queue) return;
  if (!this.msgLin) { this.msgLin = this.alloc(32); this.msgSel = this.allocSels(this.msgLin, 32); }
  const msg = u32(this.msgSel << 16);
  this.sysPumping = true; const tibq = this.r16(LAYOUT.TIB + 0x28);
  this.w16(LAYOUT.TIB + 0x28, sys.queue);   // the system thread's queue while its loop runs
  try {
    for (let n = 0; n < 64; n++) {
      if (!this.user16(109, [['l', msg], ['w', 0], ['w', 0], ['w', 0], ['w', 1]]).ax) break;   // PeekMessage, PM_REMOVE
      this.user16(113, [['l', msg]]); this.user16(114, [['l', msg]]);                             // TranslateMessage, DispatchMessage
    }
  } finally { this.sysPumping = false; this.w16(LAYOUT.TIB + 0x28, tibq); }
};
def16('KERNEL', 461, 'llll', 'l', function (n, ph, all, ms) {                                        // WaitForMultipleObjects
  const hs = [...Array(n)].map((_, i) => ev16(this, this.r32(this.lin(ph) + 4 * i)));
  const ready = all ? hs.every(e => e && e.set) : hs.some(e => e && e.set);
  if (!ready && ms && this.atThreadTop()) return YIELD;   // as #460: a thread at its top level gives up its slice
  if (!ready && ms) this.waitNested(() => (all ? hs.every(e => e && e.set) : hs.some(e => e && e.set)));
  if (!(all ? hs.every(e => e && e.set) : hs.some(e => e && e.set))) return 0x102;
  if (all) { for (const e of hs) if (!e.manual) e.set = false; return 0; }
  const i = hs.findIndex(e => e && e.set); if (!hs[i].manual) hs[i].set = false; return i;
});
def16('KERNEL', 462, '', 'l', function () { return this.thread16 ? this.thread16.id : this.inSystem() ? SYS_TID : MAIN_TID; });       // GetCurrentThreadId (the main thread is the id KERNEL32 reports)
def16('KERNEL', 463, 'lw', 'w', function (tid, hq) { const t = thr(this, tid), old = t.queue || 0; t.queue = hq; this.tibQueue(t); return old; });   // SetThreadQueue
// GetThreadQueue: a thread's queue; a task handle in place of the id (USER's PostAppMessage) gives that task's
def16('KERNEL', 464, 'l', 'w', function (tid) {
  const tasks = [...(this.threadsById || new Map()).values()], k = tid && tid <= 0xffff && tasks.find(t => t.tdb === tid);
  if (k) return k.queue || 0;
  if (tid && tid === this.tdb16) return this.r16(this.selBase(tid) + 0x20);
  return thr(this, tid).queue || 0;
});
def16('KERNEL', 624, 'll', 'v', function (tid, hq) { const t = thr(this, tid); t.queue = hq & 0xffff; this.tibQueue(t); });   // SetFastQueue: the queue field (38h) of the thread
// the program's thread keeps its queue in its TIB too (FS:[28h], USER32 reads it there), and TIB flags bit 0 marks it Win32
/** the thread information block FS addresses in flat code: the running Win32 thread's own, else the program's */
P.tibFor = function () { return (this.thread16 && this.thread16.tib) || LAYOUT.TIB; };
P.tibQueue = function (t) { if (t.tib) this.w16(t.tib + 0x28, t.queue || 0); if (t.tdb) this.w16(this.selBase(t.tdb) + 0x20, t.queue || 0); if (t.id === MAIN_TID) { this.w16(LAYOUT.TIB + 0x28, t.queue || 0); this.w16(this.selBase(this.tdb16 || (this.tdb16 = newTdb(this))) + 0x20, t.queue || 0); this.w16(LAYOUT.TIB + 0x1c, this.r16(LAYOUT.TIB + 0x1c) | 1); } };
// GetFastQueue: the current thread's queue, created when it has none by USER's InitThreadInput (USER.409), which KRNL386
// keeps a pointer to and calls with (0, 4 | 1 for a Win32 thread)
def16('KERNEL', 625, '', 'w', function () {
  const t = thr(this, 0); if (t.queue) return t.queue;
  const u = this.ne.get('USER'), ep = u && u.meta && this.neExport(u, 409);
  if (!ep) return 0;
  const r = this.call16(ep >>> 16, ep & 0xffff, [['w', 0], ['w', this.thread16 || this.inSystem() ? 4 : 5]]);   // 1: a Win32 thread (THDB flags bit 0), its own process record; USER's start-up is the system's
  return t.queue || r.ax;
});
// Get/SetProcessDword: a process's fields by the GPD_ offsets (0 user data, -4 flags, -8 parent, -12..-32 its
// STARTUPINFO, -36 PDB, -40 THDB, -44 expected Windows version, -48 hInstance, -52 load-done event, -56 app
// compatibility flags). Nothing is set until someone sets it, but the version, which is 4.0.
const GPD = { 0: 0, '-4': 0, '-8': 0, '-12': 0, '-16': 0, '-20': 0, '-24': 0, '-28': 0, '-32': 0, '-36': 0, '-40': 0, '-44': 0x400, '-48': 0, '-52': 0, '-56': 0 };
const pdw = (p, pid, off) => {
  if (!(off in GPD)) throw new GuestError(`GetProcessDword offset ${off}`);
  pid = pid || (p.inSystem() ? SYS_PID : MAIN_PID);   // USER's start-up runs as the system process, not the program's
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
def16('KERNEL', 451, 'l', 'v', function (h) { this.signal(ev16(this, h)); });                      // VWin32_EventSet
def16('KERNEL', 479, 'l', 'v', function (h) { this.signal(ev16(this, h)); });
// ---- threads. One processor runs them one at a time: a thread created here starts when the scheduler next runs
// (threads16, between slices of the main thread), runs until it waits on an event that is not set (then yields
// in the wait, resuming there once the event is set), and ends when its procedure returns.
const MAIN_TID = 0x51, SYS_TID = 0x41, MAIN_PID = 0x50, SYS_PID = 0x40;   // the program's thread, and the system thread USER starts up on
const thr = (p, tid) => {   // a thread's record by id (0 or the main thread's id: the current/main thread)
  p.threadsById = p.threadsById || new Map([[MAIN_TID, { id: MAIN_TID }]]);
  const id = tid || (p.thread16 ? p.thread16.id : p.inSystem() ? SYS_TID : MAIN_TID);
  if (!p.threadsById.has(id)) p.threadsById.set(id, { id });
  return p.threadsById.get(id);
};
/** a new thread record for CreateThread (flat: a Win32 procedure) and CreateThread16; it starts when threads16 next runs */
P.newThread = function (start, param, stack, flat, suspended) {
  thr(this, MAIN_TID);
  const id = MAIN_TID + this.threadsById.size, t = thr(this, id);
  Object.assign(t, { start, param, stack: Math.max(stack || 0, 0x10000), state: suspended ? 'suspended' : 'new', flat, ctx: null, wait: null });
  return t;
};
P.currentThreadId = function () { return this.thread16 ? this.thread16.id : this.inSystem && this.inSystem() ? SYS_TID : MAIN_TID; };
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
P.threads16 = function (nested = false) {
  if (!this.threadsById || (!nested && (this.thread16 || this.depth)) || this.inThreads) return;
  const caller = this.thread16;
  this.inThreads = true;
  try { for (const t of this.threadsById.values()) {
    if (t === caller || t.blocked || (t.id === MAIN_TID && !caller) || (t.id === MAIN_TID && caller) || !t.state || t.state === 'done' || t.state === 'suspended' || (t.state === 'waiting' && t.wait && !t.wait.set)) continue;   // a thread that yielded with no event to wait for (in WaitEvent) runs again
    const main = this.saveCtx16();
    this.thread16 = t; t.sliceStart = this.now();
    let r;
    try {
      if (t.state === 'new' && t.flat) {
        // a Win32 thread (CreateThread): its own stack and thread information block, then its procedure called
        // with its parameter in flat mode; returning to the sentinel ends it
        t.stackBase = this.alloc(t.stack); t.tib = this.alloc(0x100);
        this.u8.copyWithin(t.tib, LAYOUT.TIB, LAYOUT.TIB + 0x100);
        this.w32(t.tib, 0xffffffff); this.w32(t.tib + 4, t.stackBase + t.stack); this.w32(t.tib + 8, t.stackBase); this.w32(t.tib + 0x18, t.tib);
        this.w16(t.tib + 0x28, 0);
        for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
        this.cpu.fs.value = t.tib; this.depth = 0; t.depth = 0; this.stackLevel = main.stackLevel;
        let esp = t.stackBase + t.stack - 16; esp -= 4; this.w32(esp, t.param); esp -= 4; this.w32(esp, LAYOUT.SENTINEL);
        this.cpu.esp.value = esp; t.state = 'running';
        r = this.runAt(u32(t.start));
        if (r === 0 && t.exitCode === undefined) t.exitCode = u32(this.cpu.eax.value);
      } else if (t.state === 'new') {
        // its own flat stack, then a far call of its procedure (it returns to the sentinel)
        t.stackBase = this.alloc(t.stack); this.cpu.esp.value = t.stackBase + t.stack - 16; this.seg('ss', 0);
        this.cpu.ssb.value = 0; this.depth = 0; this.stackLevel = main.stackLevel;
        t.state = 'running';
        if (t.task) {   // a task's start: no arguments, its registers as the loader sets them (KERNEL.45)
          const k = t.task; this.seg('ds', k.dgroup); this.seg('es', k.psp);
          for (const [r, v] of [['edi', k.hInst], ['esi', 0], ['ebx', k.stack], ['ecx', k.heap], ['eax', 0], ['edx', 0]]) this.cpu[r].value = v;
        }
        r = this.start16(t.start >>> 16, t.start & 0xffff, t.task ? [] : [['l', t.param]]);
      } else {
        // it yielded at its top level, so it holds no 16-bit stack aliases: it takes them from the level in use now
        this.loadCtx16(t.ctx); this.stackLevel = main.stackLevel; t.state = 'running'; t.wait = null;
        r = this.runAt(u32(this.cpu.eip.value));
      }
      if (r === 1) { t.ctx = this.saveCtx16(); t.state = 'waiting'; }
      else { t.state = 'done'; this.wakeWaiters(t); if (r !== 0 && this.trapped) console.warn('[ne16] thread', t.id, this.trapped); }
    } finally { this.thread16 = caller; this.loadCtx16(main); }
  } } finally { this.inThreads = false; }
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
// MapHInstLS / MapHInstSL take and return registers, as KRNL386's do (seg3:07DC, seg3:0811): EAX = Win32 handle ->
// AX = 16-bit handle (a value of 64K or less is already one; 0 is the current task's), and AX = 16-bit handle ->
// EAX = the Win32 module it stands in for (the 16-bit handle itself when it is not one)
def16('KERNEL', 472, '', 'jmp', function () {
  const h = u32(this.cpu.eax.value), r = h > 0xffff ? this.hinst16(h) : h || (this.exe ? this.hinst16(this.exe.base) : 0);
  this.cpu.eax.value = lo16(this.cpu.eax.value, r); return this.retf16(0);
});
def16('KERNEL', 473, '', 'jmp', function () {
  const h = this.cpu.eax.value & 0xffff, h16 = h || (this.exe ? this.hinst16(this.exe.base) : 0);
  this.cpu.eax.value = (this.hinst32(h16) || h) | 0; return this.retf16(0);
});
def16('KERNEL', 476, 'l', 'l', function (h) { return h; });                                            // ConvertToGlobalHandle: one process, so already global
def16('KERNEL', 474, 'l', 'w', function (h) { return this.handles.delete(h) ? 1 : 0; });               // CloseW32Handle
def16('KERNEL', 105, '', 'w', function () { return 0x0400; });                                         // GetExeVersion: system code expects Windows 4.0
def16('KERNEL', 132, '', 'l', function () { return 0x0c29; });                                         // GetWinFlags: protected mode, 486, enhanced, 80x87, paging
def16('KERNEL', 1, 'w', 'v', function (code) { throw new GuestError(`FatalExit(${code})`); });
def16('KERNEL', 22, 'w', 'w', function (h) { const b = this.gblock(h); return b ? (b.lock & 0xff) : 0; });   // GlobalFlags: the lock count
// LockSegment / UnlockSegment: a segment's lock count, -1 meaning the caller's DS; the segment's selector, or 0 when
// it is not a global block
const segOf = (p, seg) => ((seg & 0xffff) === 0xffff ? p.cpu.ds.value : seg) & 0xffff;
def16('KERNEL', 23, 'w', 'w', function (seg) { const s = segOf(this, seg), b = this.gblock(s); if (!b) return 0; b.lock = (b.lock || 0) + 1; return this.gsel(s); });
def16('KERNEL', 24, 'w', 'w', function (seg) { const s = segOf(this, seg), b = this.gblock(s); if (!b) return 0; if (b.lock) b.lock--; return b.lock ? this.gsel(s) : 0; });   // 0 once unlocked
// one task runs here, so yielding, task events and priorities have nothing to act on
def16('KERNEL', 29, '', 'v', function () {                                                             // Yield: as OldYield (#447)
  const t = thr(this, 0), top = this.thread16 ? this.depth === this.thread16.depth : this.depth === 0;
  if (top && !t.yielded) { t.yielded = true; return YIELD; }
  if (!top) this.threads16(true);   // inside a call: the other tasks and threads run now, as Yield switches to them
  t.yielded = false;
});
def16('KERNEL', 117, '', 'v', function () {});                                                         // OldYield
def16('KERNEL', 150, 'w', 'v', function () { if (!this.atThreadTop()) this.threads16(true); });         // DirectedYield: inside a call, the other tasks run now (at the top level the host's scheduler runs them next)
// WaitEvent: the task sleeps until an event is posted to it. A thread that is not inside a call JS made gives up
// its slice once (timers, input and the other threads run) and the wait then ends; USER checks its queue again.
// LoadModule(name, parameter block { environment, far command tail, far show command, - }): a library loads as
// LoadLibrary loads it; a task (MMSYSTEM's MMTASK.TSK) gets an instance, a PSP with the command tail at 80h and a
// thread of its own that starts at its entry point the way the Win16 loader starts a task (DS its DGROUP, ES its PSP,
// DI its instance, BX its stack size, CX its heap size). Errors as LoadLibrary's
// AX the instance and, for a task, DX its task handle (as KRNL386 returns them; MMSYSTEM's mmTaskCreate takes DX)
def16('KERNEL', 45, 'sp', 'l', function (name, pb) {
  const rec = this.loadLibrary16(name, true, true); if (!rec || !rec.meta) return this.loadError16(name);
  const hdr = rd.u32(rec.file, 0x3c), flags = rd.u16(rec.file, hdr + 0x0c);
  if (flags & 0x8000) { if (!rec.inited) { rec.inited = true; this.initNE(rec); } return rec.hInstance; }
  const psp = this.alloc(0x100), pspSel = this.allocSels(psp, 0x100);
  this.u8.fill(0, psp, psp + 0x100); this.w16(psp, 0x20cd);
  let show = 1;
  if (pb) {
    const tail = this.lin(this.r32(pb + 2)), cs = this.lin(this.r32(pb + 6));
    if (tail) { const n = Math.min(this.u8[tail], 126); this.u8[psp + 0x80] = n; this.u8.copyWithin(psp + 0x81, tail + 1, tail + 1 + n); this.u8[psp + 0x81 + n] = 0x0d; }
    if (cs) show = this.r16(cs + 2);
  }
  const m = rec.meta, t = this.newThread(u32((m.segs[m.entry[0] - 1].sel << 16) | m.entry[1]), 0, 0x4000, false);
  t.task = { psp: pspSel, hInst: rec.hInstance, show, stack: rd.u16(rec.file, hdr + 0x12), heap: rd.u16(rec.file, hdr + 0x10), dgroup: rec.dgroup };
  t.tdb = newTdb(this);
  return u32((t.tdb << 16) | rec.hInstance);
});
// InitTask: the starting task's registers (AX 1, ES:BX its command tail, CX its stack, DX its show command, SI its
// previous instance, DI its instance)
def16('KERNEL', 91, '', 'jmp', function () {
  const k = this.thread16 && this.thread16.task;
  if (!k) { this.ax(0); return this.retf16(0); }
  this.ax(1); this.seg('es', k.psp); this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0x81); this.cpu.ecx.value = lo16(this.cpu.ecx.value, k.stack);
  this.cpu.edx.value = lo16(this.cpu.edx.value, k.show); this.cpu.esi.value = lo16(this.cpu.esi.value, 0); this.cpu.edi.value = lo16(this.cpu.edi.value, k.hInst);
  return this.retf16(0);
});
def16('KERNEL', 30, 'w', 'w', function () {
  const t = thr(this, 0), top = this.thread16 ? this.depth === this.thread16.depth : this.depth === 0;
  if (top && !t.slept) { t.slept = true; return YIELD; }
  if (!top) this.threads16(true);   // inside a call: the other tasks run, as the wait would let them
  t.slept = false; return 0;
});
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
// ---- 16 <-> 32-bit transitions as continuations. Each transition records what the way back needs and leaves
// through a return thunk of its own (one per transition in flight), so no JS frame waits on the callee: code that
// blocks below it (USER's WaitEvent in GetMessage) suspends the whole guest until a later slice, and threads that
// interleave their transitions each come back to their own.
const NRET = 256;
P.retToken = function (rec) {
  if (!this.retFree) { this.retFree = []; for (let k = NRET - 1; k >= 0; k--) this.retFree.push(k); this.retRecs = []; }
  const k = this.retFree.pop(); if (k === undefined) throw new GuestError('too many 16/32-bit transitions in flight');
  this.retRecs[k] = rec; return k;
};
P.retTake = function (k) {
  const rec = this.retRecs && this.retRecs[k]; if (!rec) throw new GuestError('return through a transition that is not in flight');
  this.retRecs[k] = null; this.retFree.push(k); if (rec.ssel) this.stkFree.push(rec.ssel);
  return rec;
};
/** a 64K stack alias selector for a transition, based at `base` */
P.stackSel = function (base) {
  this.stkFree = this.stkFree || [];
  const sel = this.stkFree.pop() || this.allocSels(base, 0x10000);
  this.setDesc(sel, base, 0xffff, 0xf300); return sel;
};
for (let k = 0; k < NRET; k++) def16('RET16', k, '', 'jmp', function () { return this.return16to32(this.retTake(k)); });
API.KERNEL32 = API.KERNEL32 || {};
for (let k = 0; k < NRET; k++) {
  API.KERNEL32['__Ret32.' + k] = ['regs', function () { const rec = this.retTake(k); return rec.done.call(this, rec); }];
}
/** 16 -> 32 transition for SL thunks: EBX + 0x16 addresses the 16-bit arguments; the target returns with CL = argument bytes */
P.enter32from16 = function (target) {
  const ctx = { esp: this.cpu.esp.value, ebp: this.cpu.ebp.value, esi: this.cpu.esi.value, edi: this.cpu.edi.value, ebx: this.cpu.ebx.value };
  for (const [s, b] of SEGS) { ctx[s] = this.cpu[s].value; ctx[b] = this.cpu[b].value; }
  const frame = u32((this.cpu.ssb.value >>> 0) + (this.cpu.esp.value & 0xffff));
  ctx.frame = frame;
  ctx.done = function (c) {   // back to the 16-bit caller, dropping CL bytes of its arguments
    const n = this.cpu.ecx.value & 0xff;
    for (const r of ['ebp', 'esi', 'edi', 'ebx']) this.cpu[r].value = c[r];
    for (const [s, b] of SEGS) { this.cpu[s].value = c[s]; this.cpu[b].value = c[b]; }
    const ip = this.r16(c.frame), cs = this.r16(c.frame + 2);
    this.cpu.esp.value = lo16(c.esp, (c.esp & 0xffff) + 4 + n);
    this.seg('cs', cs);
    return u32(this.selBase(cs) + ip);
  };
  const back = this.thunkFor('KERNEL32', '__Ret32.' + this.retToken(ctx));
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor();
  this.cpu.ebx.value = frame - 0x12;
  let esp = (frame - 0x80) & ~3;
  esp -= 4; this.w32(esp, back);
  this.cpu.esp.value = esp; this.cpu.ebp.value = esp;
  return target;
};
/** run a 32-bit guest call while the CPU is in a 16-bit context: switch to the flat stack below SS:SP and back */
P.callFlatFrom16 = function (addr, args) {
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  const flat = u32((this.cpu.ssb.value >>> 0) + (this.cpu.esp.value & 0xffff));
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor();
  this.cpu.esp.value = (flat - 0x200) & ~3;
  try { return this.call(addr, args); }
  finally {
    const eax = this.cpu.eax.value, edx = this.cpu.edx.value;
    for (const r of GPR) this.cpu[r].value = save[r]; for (const [s, b] of SEGS) { this.cpu[s].value = save[s]; this.cpu[b].value = save[b]; }
    this.cpu.eax.value = eax; this.cpu.edx.value = edx;
  }
};
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
// ThunkConnect32: a thunk-compiler DLL's 32-bit thunk data (magic LS01, calls from 32 to 16 bits) joined to its 16-bit
// half's, which is the export `f16` of `m16`. The 16-bit side's target table becomes the 32-bit side's, and the relay
// code the 32-bit data holds at its QT_Thunk and FT_Prolog offsets (Windows 95 writes `mov edx, [table + 4 * n]` and a
// jump to QT_Thunk / FT_Prolog there) is run by dataCode. Other reasons than attach have nothing to undo.
K('ThunkConnect32', 6, function (td, f16, m16, m32, hmod, reason) {
  if (reason !== 1) return 1;
  const magic = this.readA(td, 4), name = (this.readA(m16) || '').toUpperCase().replace(/\.DLL$/, '');
  // late binding ('LB01' in the 32-bit data): the 16-bit half is found when a thunk is first called
  const late = this.readA(td + 0xc, 4) === 'LB01', f16name = this.readA(f16);
  const find = () => { const m = this.loadLibrary16(name, true); const sp = m && this.neExport(m, f16name); return sp ? this.lin(sp) : 0; };
  if (late && magic === 'LS01') {
    this.lsRelays = this.lsRelays || new Map();
    const rel = { ft: false, table: 0, bind: () => { if (!rel.table) { const t16 = find(); if (!t16) throw new GuestError(`thunk to ${name}: no ${f16name}`); rel.table = this.lin(this.r32(t16 + 8)); this.w32(td + 8, rel.table); } return rel.table; } };
    this.lsRelays.set(u32(td + this.r32(td + 0x1c)), rel);
    this.lsRelays.set(u32(td + this.r32(td + 0x20)), { ft: true, get table() { return rel.bind(); } });
    return 1;
  }
  // 16 -> 32: the 32-bit half's target table, for the 16-bit half (ThunkConnect16's record, made now if its half has
  // not announced itself yet) to call through
  if (magic === 'SL01') {
    const t16 = find(); if (!t16) return 1;
    const sl = this.sl01 || (this.sl01 = new Map()), rec = sl.get(t16) || {}; sl.set(t16, rec);
    rec.mod = this.modules.find(x => x.base === hmod) || this.modules.find(x => td >= x.base && td < x.base + (x.size || 0x100000));
    rec.table = u32(f16 + (this.r32(td + 0x20) | 0));   // the thunk compiler's table lies before the 16-bit half's name
    return 1;
  }
  const t16 = find(); if (!t16) return 0;
  if (this.r32(t16) !== this.r32(td) || this.r32(t16 + 4) !== this.r32(td + 4)) return 0;   // magic and checksum
  if (magic === 'LS01') {
    const table = this.lin(this.r32(t16 + 8)); this.w32(td + 8, table);
    this.lsRelays = this.lsRelays || new Map();
    this.lsRelays.set(u32(td + this.r32(td + 0x1c)), { ft: false, table });
    this.lsRelays.set(u32(td + this.r32(td + 0x20)), { ft: true, table });
    return 1;
  }
  throw new GuestError(`ThunkConnect32 for ${magic} thunks (${this.readA(m32)})`);
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
  return this.enter16from32(target, this.reg('esp'), Math.min(ebp - this.reg('esp') - 0x40, 0x80), map, false, () => ret);
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
  return this.enter16from32(this.reg('edx'), sp, n, 0, false, () => ret);
};
/**
 * Enter a 16:16 target whose `n` argument bytes sit on the flat stack at `src`. As on Windows 95 the 16-bit stack
 * aliases the 32-bit one: SS:SP addresses the argument block in place, so anything the callee writes there is seen
 * by the 32-bit side. `map` marks argument dwords holding flat pointers into the block (converted to SS:offset).
 * The callee's far return comes back through a return thunk (return16to32), which puts the 32-bit registers back,
 * moves ESP past the bytes the callee popped and continues where `done` says. `ret32`: the callee returns with a
 * 32-bit far return (66h lret).
 */
P.enter16from32 = function (target, src, n, map, ret32, done) {
  const sel = target >>> 16, off = target & 0xffff;
  const base = (src - 0xf000) & ~0xf, ssel = this.stackSel(base);
  const rec = { ebx: this.reg('ebx'), esi: this.reg('esi'), edi: this.reg('edi'), ebp: this.reg('ebp'), esp: this.reg('esp'), ret32, done, ssel };
  this.seg('ss', ssel);
  let sp = src - base;
  if (map) for (let i = 0; i < 32; i++) if (map & (1 << i)) {
    const a = src + 2 * i, ptr = this.r32(a);
    this.w32(a, u32((ssel << 16) | (ptr - base)));
  }
  rec.sp0 = sp;
  const back = this.thunk16For('RET16.#' + this.retToken(rec));
  if (ret32) { sp -= 4; this.w32(base + sp, back >>> 16); sp -= 4; this.w32(base + sp, back & 0xffff); }
  else { sp -= 2; this.w16(base + sp, back >>> 16); sp -= 2; this.w16(base + sp, back & 0xffff); }
  this.reg('esp', sp); this.seg('ds', 0); this.seg('es', 0); this.seg('cs', sel);
  this.cpu.ebp.value = lo16(this.cpu.ebp.value, rec.sp0 + n);
  return u32(this.selBase(sel) + off);
};
P.return16to32 = function (rec) {
  const popped = ((this.cpu.esp.value & 0xffff) - rec.sp0) & 0xffff;
  const ax = this.cpu.eax.value & 0xffff, dx = this.cpu.edx.value & 0xffff;
  this.last16 = { eax: u32(this.cpu.eax.value), ebx: u32(this.cpu.ebx.value), ecx: u32(this.cpu.ecx.value) };
  if (rec.ret32) this.reg('eax', this.last16.eax); else { this.reg('eax', ((dx << 16) | ax) >>> 0); this.reg('edx', dx); }
  for (const r of ['ebx', 'esi', 'edi', 'ebp']) this.reg(r, rec[r]);
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor();
  this.reg('esp', rec.esp + popped);
  return u32(rec.done.call(this, rec));
};
KR('#45', function () {          // Common32ThkLS: EAX = 16-bit common entry, CX = target*4 (into DI), EDX.hi = dword args
  const ret = pop32(this), n = (this.reg('edx') >>> 16) * 4, edi = this.reg('edi');
  this.reg('edi', lo16(edi, this.reg('ecx')));      // the target index goes to the 16-bit side only
  const sp = this.reg('esp');
  this.reg('esp', sp - 32);
  return this.enter16from32(this.reg('eax'), sp - 32, n + 32, 0, true, function () {
    this.reg('esp', sp + (this.last16.ebx & 0xff)); this.reg('edi', edi);
    return ret;
  });
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
K('MapHInstLS', 0, function () { const h = this.reg('eax'); return this.nativeUser16() ? this.hinst16(h) : h; });
K('MapHInstLS_PN', 0, function () { const h = this.reg('eax'); return h ? (this.nativeUser16() ? this.hinst16(h) : h) : 0; });
/** whether this process runs the native USER.EXE (then Win32 module handles need 16-bit counterparts) */
P.nativeUser16 = function () { const u = this.ne && this.ne.get('USER'); return !!(u && u.meta); };
/** the 16-bit handle USER uses for a Win32 module (as Windows 95 gives each one), made on first use */
P.hinst16 = function (h32) {
  this.h16of = this.h16of || new Map(); this.h32of = this.h32of || new Map();
  if (this.h16of.has(h32)) return this.h16of.get(h32);
  // a module database as KERNEL makes one for a Win32 module: 'NE', and flags with NE_FFLAGS_WIN32 (10h) and single
  // data, plus the library bit for a DLL
  const mod = this.moduleFor(h32), pe = mod && mod.base === h32 ? this.r32(h32 + 0x3c) : 0;
  const dll = pe && (this.r16(h32 + pe + 0x16) & 0x2000);
  const mdb = this.alloc(0x40); this.u8.set([0x4e, 0x45], mdb); this.w16(mdb + 0x0c, 0x0011 | (dll ? 0x8000 : 0));
  const sel = this.allocSels(mdb, 0x40);
  this.h16of.set(h32, sel); this.h32of.set(sel & 0xfffe, h32);
  return sel;
};
/** KERNEL32 starting a Win32 program under the native USER: USER's InitApp (USER.5) for its task, as a 16-bit program
 *  calls it itself. The first one also runs USER's first-task start-up: the installable drivers SYSTEM.INI's [boot]
 *  drivers= names (MMSYSTEM.DLL) */
P.initApp16 = function () {
  if (!this.user16Ready || this.appInited16) return;
  this.appInited16 = true;
  this.user16(5, [['w', this.hinst16(this.exe.base)]]);
  this.appy16();   // the system's devices are started by the time a program runs (MMDEVLDR's appy-time start)
  // KERNEL32 then tells USER the GUI process has loaded: SignalProc32(USIG_PROCESS_LOADED, process id,
  // USIG_FLAGS_WIN32 | USIG_FLAGS_GUI, 0). USER takes the sound devices' state there (and plays Open program)
  if (this.ne.get('USER').meta && this.neExport(this.ne.get('USER'), 391)) this.user16(391, [['l', 0x600], ['l', MAIN_PID], ['l', 3], ['w', 0]]);
};
P.hinst32 = function (h16) { return (this.h32of && this.h32of.get(h16 & 0xfffe)) || 0; };
KR('K32Thk1632Prolog', function () { return ret32(this); });
// CallbackNN (NN = 12..64 argument bytes): calls the function in the last argument with the others, stdcall, as
// KERNEL32's trampolines do (the return address takes the function's slot and a bare `ret` returns through it)
KR('__CallbackRet', function () { return ret32(this); });
for (let n = 12; n <= 64; n += 4) KR('Callback' + n, function () {
  const ret = pop32(this), sp = this.reg('esp'), fn = this.r32(sp + n - 4);
  this.w32(sp + n - 4, ret); push32(this, this.thunkFor('KERNEL32', '__CallbackRet'));
  return fn;
});
// KERNEL32's 16-bit helpers by ordinal: copies of 32-bit blocks as 16-bit global memory, and 16-bit libraries
K('#19', 1, function (h) {                                                                                     // ThunkTheTemplateHandle
  const n = this.allocs.get(h) || 0; if (!n) return 0;
  const g = this.globalAlloc16(0, n); this.u8.copyWithin(this.gblock(g).lin, h, h + n); return g;
});
K('#31', 1, function (h) { return K16['KERNEL.#17'][2].call(this, h & 0xffff); });                            // GlobalFree16
K('#35', 1, function (name) { const n = this.readA(name) || '', m = this.loadLibrary16(n, true); return m ? (m.hInstance || m.hModule) : this.loadError16(n); });   // LoadLibrary16
K('#36', 1, () => 0);                                                                                          // FreeLibrary16
K('#37', 2, function (h, name) {                                                                               // GetProcAddress16
  const m = this.neByHandle(h & 0xffff); if (!m || !m.meta) return 0;
  return this.neExport(m, name >>> 16 ? this.readA(name) : name & 0xffff) || 0;
});
K('#91', 1, function (buf) { this.writeA(buf, ''); });                                                       // PK16FNF: no prefix for 16-bit file names
KR('K32Thk1632Epilog', function () { return ret32(this); });
K('#17', 0, () => 0);                                      // CommonUnimpStub
K('#18', 2, function (pid, off) { return pdw(this, pid, off | 0)[off | 0] >>> 0; });   // GetProcessDword
K('#23', 1, () => 0);                                      // GDIReallyCares (marks a handle's object as one GDI tracks)
K('#38', 0, () => 0); K('#39', 0, () => 0);
KR('#33', function () { return ret32(this); });    // frees 16-bit blocks a thread queued for release (thread flag 20h); none are queued here
K('#48', 1, function (p) { if (p) this.w32(p, 0); return 0; });   // ReleaseThunkLock
// USER32.DLL's start-up: the Win16Lock it takes around every call into USER.EXE, and KERNEL's 16-bit system variables
// (a block USER32 writes into). One thread runs here, so the lock has nothing to exclude.
K('#93', 1, function (pp) { if (!this.win16Lock) this.win16Lock = this.alloc(0x40); this.w32(pp, this.win16Lock); return 0; });   // GetpWin16Lock
K('#92', 0, function () { if (!this.pk16SysVar) this.pk16SysVar = this.alloc(0x40); return this.pk16SysVar; });            // GetPK16SysVar
K('#86', 1, () => 0);                                                                                                        // _EnterSysLevel
K('#97', 1, () => 0);                                                                                                        // _LeaveSysLevel
K('#49', 1, () => 0);                                      // RestoreThunkLock
K('#51', 0, () => 0);
// W32S_BackTo32 (KERNEL32 #51), as USER32's thunklet relays use it under native USER: entered by a jump with [ESP] the
// 32-bit target and [ESP+4] where to return; calls the target with the ten DWORDs above those as its arguments and
// returns there with the target's EAX, the target's own argument pops undone (KERNEL32 restores ESP with LEAVE)
API.KERNEL32['#51'] = ['regs', function () {
  if (!this.nativeUser16()) { const sp = this.reg('esp'), r = this.r32(sp); this.reg('esp', sp + 4); this.reg('eax', 0); return r; }
  // as a continuation, so a target that waits (a message box's loop) can give up the processor: the arguments are
  // copied below, the target returns through a return thunk, which moves ESP back and goes on at `ret`
  const esp = this.reg('esp'), target = this.r32(esp), ret = this.r32(esp + 4);
  let sp = esp - 40; this.u8.copyWithin(sp, esp + 8, esp + 48);
  sp -= 4; this.w32(sp, this.thunkFor('KERNEL32', '__Ret32.' + this.retToken({ done() { this.reg('esp', esp + 8); return ret; } })));
  this.reg('esp', sp);
  return target;
}];
K('#68', 3, function (sp) { return this.lin(sp); });      // K32WOWGetVDMPointerFix
K('#69', 1, () => 0);
K('#86', 1, () => 0);
K('#93', 1, function (p) { if (p) this.w32(p, 0); return 0; });   // GetpWin16Lock
K('#96', 0, () => 1);
K('#97', 1, () => 0); K('#98', 1, () => 0);
K('GetProcessFlags', 1, () => 0);
K('ConvertToGlobalHandle', 1, h => h);
K('OpenEventA', 3, () => 0); K('OpenMutexA', 3, () => 0); K('ReleaseMutex', 1, () => 1);
// ---- Win32 waits, events and user APCs under the native USER, on the threads threads16 runs. A wait that cannot be
// satisfied gives up the processor at the thread's top level and is made again when the thread resumes (until it is
// satisfied or its time runs out); an alertable wait runs the thread's queued APCs first and returns
// WAIT_IO_COMPLETION. Objects that are not waitable here count as signalled, as before. Outside a native-USER
// session there is one thread, and a wait finds the object set or times out at once
const native32 = p => p.nativeUser16 && p.nativeUser16();
P.queueApc = function (tid, proc, data) { apcs(this, tid).push({ proc, data }); const t = this.threadsById && this.threadsById.get(tid); if (t && t.alertWait) t.blocked = false; };
const apcs = (p, tid) => { p.apcQ = p.apcQ || new Map(); if (!p.apcQ.has(tid)) p.apcQ.set(tid, []); return p.apcQ.get(tid); };
function wait32(hs, all, ms, alertable) {
  const objs = hs.map(h => ev16(this, h)), top = native32(this) && this.atThreadTop();
  const t = this.thread16 || (this.mainWait = this.mainWait || {});
  if (alertable && native32(this)) {
    const q = apcs(this, this.currentThreadId());
    if (q.length) { t.wake = 0; for (const a of q.splice(0)) this.call(a.proc, [a.data]); return 0xc0; }   // WAIT_IO_COMPLETION
  }
  const isSet = e => !e || e.set;
  const ready = all ? objs.every(isSet) : objs.some(isSet);
  if (ready) {
    t.wake = 0;
    if (all) { for (const e of objs) if (e && !e.manual) e.set = false; return 0; }
    const i = objs.findIndex(isSet); if (objs[i] && !objs[i].manual) objs[i].set = false; return i;
  }
  if (!ms || !top) { t.wake = 0; return 0x102; }
  // a wait without end, in a thread: blocked until one of its objects is set, an APC arrives (alertable) or a thread
  // it waits for ends; the scheduler does not run it until then, and it checks its wait again when it runs
  if (ms === 0xffffffff && this.thread16) {
    t.blocked = true; t.alertWait = alertable;
    for (const h of hs) { const o = this.obj(h); if (o) (o.waiters = o.waiters || new Set()).add(t); const w = o && o.kind === 'thread' && this.threadsById && this.threadsById.get(o.id); if (w) (w.waiters = w.waiters || new Set()).add(t); }
    return YIELD;
  }
  if (!t.wake) t.wake = ms === 0xffffffff ? Infinity : this.now() + ms;
  else if (this.now() >= t.wake) { t.wake = 0; return 0x102; }
  return YIELD;
}
K('WaitForSingleObject', 2, function (h, ms) { return wait32.call(this, [h], false, ms, false); });
K('WaitForSingleObjectEx', 3, function (h, ms, al) { return wait32.call(this, [h], false, ms, !!al); });
K('WaitForMultipleObjects', 4, function (n, ph, all, ms) { return wait32.call(this, [...Array(n)].map((_, i) => this.r32(ph + 4 * i)), !!all, ms, false); });
K('WaitForMultipleObjectsEx', 5, function (n, ph, all, ms, al) { return wait32.call(this, [...Array(n)].map((_, i) => this.r32(ph + 4 * i)), !!all, ms, !!al); });
K('SetEvent', 1, function (h) { this.signal(ev16(this, h)); return 1; });
K('ResetEvent', 1, function (h) { const e = ev16(this, h); if (e) e.set = false; return 1; });
K('PulseEvent', 1, function (h) { const e = ev16(this, h); if (e) { e.set = false; this.wakeWaiters(e); } return 1; });
K('GetExitCodeThread', 2, function (h, p) {
  const o = this.obj(h), t = o && o.kind === 'thread' && this.threadsById && this.threadsById.get(o.id);
  if (p) this.w32(p, t && t.state !== 'done' ? 0x103 : (t && t.exitCode) || 0); return 1;   // STILL_ACTIVE while it runs
});
K('TerminateThread', 2, function (h, code) {
  const o = this.obj(h), t = o && o.kind === 'thread' && this.threadsById && this.threadsById.get(o.id);
  if (!t || t === this.thread16) return 0; t.state = 'done'; t.exitCode = code; return 1;
});
// OpenVxDHandle: the ring-0 handle VxDs signal a Win32 event by (VWIN32_SetWin32Event, MMDEVLDR's function 4)
/** the thread a ring-0 thread handle is (its control block's TCB_ThreadId) */
P.r0Tid = function (h) { const m = this.thcbs; if (m) for (const [tid, a] of m) if (a === u32(h)) return tid; return u32(h) & 0xffffff; };
K('QueueUserAPC', 3, function (fn, h, data) { const o = this.obj(h), tid = o && o.kind === 'thread' ? o.id : this.currentThreadId(); this.queueApc(tid, fn, data); return 1; });
K('RegisterServiceProcess', 2, () => 1);   // a process that outlives the user's logon (MPREXE): nothing ends processes at logoff here
K('OpenVxDHandle', 1, function (h) { return ev16(this, h) ? u32(0xc4000000 | (h & 0xffffff)) : 0; });
P.r0Event = function (r0) { return (u32(r0) & 0xff000000) === 0xc4000000 ? ev16(this, r0 & 0xffffff) : null; };
// a Win32 thread's ring-0 handle (VMM Get_Cur_Thread_Handle), which VWIN32_QueueUserApc takes
/** a thread's ring-0 handle: its thread control block (TCB_Flags, TCB_Signature 'THCB' at 0Ch, TCB_ClientPtr at 10h,
 *  TCB_VMHandle at 14h, TCB_ThreadId at 18h; the slots VxDs allocate follow from 100h) */
P.r0Thread = function (tid) {
  const m = this.thcbs || (this.thcbs = new Map());
  if (!m.has(tid)) {
    const a = this.alloc(0x1000); this.u8.fill(0, a, a + 0x1000);
    this.w32(a + 0xc, 0x42434854); this.w32(a + 0x14, this.sysVM ? this.sysVM() : 0); this.w32(a + 0x10, this.sysVM ? this.r32(this.sysVM() + 8) : 0); this.w16(a + 0x18, tid & 0xffff);
    m.set(tid, a);
  }
  return m.get(tid);
};
// devices opened by name (\\.\NAME): MMDEVLDR, which WINMM's threads talk to by DeviceIoControl, and any recompiled
// VxD loaded by that name (VREDIR, IFSMGR, which MSNET32 asks); others are absent
const VXD_FILES = { MMDEVLDR: 0x44a, VTDAPI: 0x442 };
const createFile = API.KERNEL32.CreateFileA[1];
K('CreateFileA', 7, function (name, ...rest) {
  const n = this.readA(name) || '', m = /^\\\\\.\\([^\\.]+)(\.vxd)?$/i.exec(n);
  if (!m) return createFile.call(this, name, ...rest);
  const loaded = [...(this.vxds || new Map()).values()].find(v => v.inited && v.name.toUpperCase() === m[1].toUpperCase());   // any VxD loaded by that name
  const id = VXD_FILES[m[1].toUpperCase()] || (loaded && loaded.id);
  if (!id) { this.lastError = 2; return 0xffffffff; }
  const vx = this.vxdById && this.vxdById(id);   // a recompiled VxD (vmm.js) is asked first (DIOC_OPEN)
  if (vx) { const e = this.vxdIoctl(vx, 0, 0, 0, 0, 0, 0, 0); if (e) { this.lastError = e; return 0xffffffff; } }
  return this.newHandle({ kind: 'vxd', name: m[1].toUpperCase(), id });
});
const devIoctl = API.KERNEL32.DeviceIoControl[1];
K('DeviceIoControl', 8, function (h, code, inb, nin, outb, nout, pret, ovl) {
  const o = this.obj(h);
  if (!o || o.kind !== 'vxd') return devIoctl.call(this, h, code, inb, nin, outb, nout, pret, ovl);
  const vx = this.vxdById && this.vxdById(o.id);
  if (vx) { const e = this.vxdIoctl(vx, code, inb, nin, outb, nout, pret, h); if (e) { this.lastError = e; return 0; } return 1; }   // the recompiled VxD (vmm.js)
  const out = v => { if (outb && nout >= 4) this.w32(outb, v); if (pret) this.w32(pret, 4); return 1; };
  const arg = i => this.r32(inb + 4 * i);
  switch (code) {   // MMDEVLDR's W32_DEVICEIOCONTROL (VxD 3015Ah)
    case 0: return out(0x100);                                                       // version
    case 1: return out(u32(arg(0) << 12));   // _LinPageLock(page, pages, flags): the locked region's linear address (the same memory: one address space here)
    case 2: if (pret) this.w32(pret, 0); return 1;                                   // unlock them
    case 3: return out(this.r0Thread(this.currentThreadId()));                        // the calling thread's ring-0 handle
    case 4: this.queueApc(this.r0Tid(arg(2)), arg(0), arg(1)); return out(1);   // VWIN32_QueueUserApc(proc, data, thread)
    case 5: if (!this.mmdevCount) { this.mmdevCount = this.alloc(4); this.w32(this.mmdevCount, this.devnodes().filter(d => d.started).length); } return out(this.mmdevCount);
    case 6: return out(1);                                                           // close a ring-0 event handle
    case 7: {                                                                        // _PageAllocate(pages, flags): { linear, handle, -, physical }
      const n = arg(1) * 4096, a = this.alloc(n); this.u8.fill(0, a, a + n);
      if (nout >= 16) { this.w32(outb, a); this.w32(outb + 4, a); this.w32(outb + 8, 0); this.w32(outb + 12, a); }
      if (pret) this.w32(pret, 4); return 1;
    }
    case 8: return out(1);                                                           // _PageFree
    case 9: {   // a device's state by its ID: 0 none, 1 started, 2 not started (3: disabled)
      const id = (this.readA(inb) || '').toUpperCase(), dn = this.devnodes().find(d => d.id === id);
      return out(!dn ? 0 : dn.started ? 1 : 2);
    }
  }
  throw new GuestError(`MMDEVLDR DeviceIoControl ${code}`);
});
K('EnumResourceNamesA', 4, () => 0);

/**
 * The thunk compiler's LSF relay code sits in the 32-bit DLL's data (ThunkInitLSF layout):
 *   +04: jmp +20 -> +24: call/pop eax; sub eax,25 (eax = +04); mov edx, <table ptr offset>; push QT_ThunkPrime; ret
 *   +3A: jmp +20 -> +5A: call/pop edx; sub edx,25 (edx = +3A); push edx; push <table ptr offset>; push FT_PrologPrime; ret
 * Executing it is equivalent to setting those registers and jumping to the primer.
 */
P.dataCode = function (eip) {
  const tl = this.lsThunklets && this.lsThunklets.get(u32(eip));
  if (tl) { push32(this, tl.target); push32(this, tl.relay); return this.cbGlueLS; }
  const ls = this.lsRelays && this.lsRelays.get(u32(eip));
  if (ls) {   // ThunkConnect32's relays: target n (CL, or the byte at [EBP-4] for QT_Thunk) of the table into EDX
    const n = ls.ft ? this.reg('ecx') & 0xff : this.u8[u32(this.reg('ebp') - 4)];
    this.reg('edx', this.r32((ls.bind ? ls.bind() : ls.table) + 4 * n));
    if (!ls.ft) this.reg('ecx', n);
    return ls.ft ? this.ftProlog() : this.qtThunk();
  }
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

// ---------------------------------------------------------------- native GDI behind the Win32 personality
/** GDI.EXE, GDI32.DLL and the display driver, brought up on first use with the fonts WIN.INI lists; null without W95SYSTEM */
P.nativeGdi = function () {
  if (this.ngdi !== undefined) return this.ngdi;
  this.ngdi = null;
  const sys = window.W95SYSTEM; if (!sys || !sys.ne || !sys.ne.GDI) return null;
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [n, d] of Object.entries(sys.dlls || {})) {
    const k = n.replace(/\.DLL$/, '');
    if (k !== 'GDI32') continue;   // the rest of the bundle's DLLs need the native USER (bootUser16)
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
/** a personality module's export names: the CD module's own (the system bundle's names16) and the ones listed here */
const names16 = mod => ({ ...((window.W95SYSTEM && window.W95SYSTEM.names16) || {})[mod], ...NAMES16[mod] });
window.W95NE16 = { K16, NAMES16, names16, L, def16, INTS, VXD_API, CR, regStr };
})();
