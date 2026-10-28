'use strict';
// 16-bit Windows personality for recompiled NE modules (GDI.EXE, DIBENG.DLL, the display driver).
// Segments live in the flat guest memory; selectors resolve through an LDT image at LDT_BASE that the
// recompiled code reads on every segment register load. KERNEL is implemented here (as Wine does);
// everything else is the original 16-bit code. Also provides the KERNEL32 flat-thunk entry points that
// GDI32.DLL uses to reach GDI.EXE and back.
(() => {
const { Process, API, LAYOUT, GuestError, YIELD, log } = window.W95Win32;
const P = Process.prototype;

const L = {
  LDT: 0x30000, ACC: 0x40000,                      // {base, limit} per selector; access rights at +0x10000
  FLATDS: 0x000F, FLATCS: 0x0017, SENT: 0x001F,    // fixed selectors (SENT: far returns here end a call16)
  STK: 0x0027, NSTK: 24,                           // 16-bit stack aliases of the flat stack, one per nesting level
  DYN: 0x600,                                      // first LDT index handed out dynamically (below it, the recompiled modules' selectors: to 2FFFh)
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
const taskStack = n => n && Math.max(n, 0x1000);   // a task's stack in its DGROUP (at least 4K, as the loader gives one); a library has none
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
    const dg = meta.segs[meta.autodata - 1], init = Math.min(0x10000, ((dg.minalloc || 0x10000) + rd.u16(file, n + 0x10) + taskStack(rd.u16(file, n + 0x12)) + 15) & ~15);
    this.ghandles.set(rec.dgroup | 1, { lin: dg.base, size: init, n: 1, flags: 2, lock: 0, owner: rec.hModule });
    this.w32(L.LDT + (rec.dgroup & 0xfff8) + 4, init - 1);
  }
  for (const sg of meta.segs) if (sg.num !== meta.autodata) this.ghandles.set(sg.sel | 1, { lin: sg.base, size: Math.max(sg.alloc, 1), n: 1, flags: 0, lock: 0, owner: rec.hModule, code: !(sg.flags & 1) });
  this.modules.push(rec); this.byName.set(name, rec); this.ne.set(name, rec);
  if (this.onModuleLoad) this.onModuleLoad(name, rec);   // (a watch asked for before the module came: worker.js cmd 'watch')
  return rec;
};
/** a module's data segments as its file has them again (its relocations in them made again), its DGROUP at its first
 *  size with no local heap yet: as a module freed and loaded again has them */
P.reloadData16 = function (rec) {
  const meta = rec.meta, u8 = this.u8, data = meta.segs.filter(sg => sg.flags & 1), n = rd.u32(rec.file, 0x3c);
  for (const sg of data) { u8.fill(0, sg.base, sg.base + Math.max(sg.alloc, 1)); if (sg.len) u8.set(rec.file.subarray(sg.fileoff, sg.fileoff + sg.len), sg.base); }
  const inData = lin => data.some(sg => lin >= sg.base && lin < sg.base + Math.max(sg.alloc, 1));
  for (const [lin, size, val] of meta.fixups) if (inData(lin)) { if (size === 1) u8[lin] = val; else if (size === 2) this.w16(lin, val); else this.w32(lin, val); }
  if (rec.relocSeg) for (const sg of data) rec.relocSeg(sg);   // (a module loaded from its file: its relocation records, made again)
  if (rec.dgroup) {
    const dg = meta.segs[meta.autodata - 1], init = Math.min(0x10000, ((dg.minalloc || 0x10000) + rd.u16(rec.file, n + 0x10) + taskStack(rd.u16(rec.file, n + 0x12)) + 15) & ~15);
    const g = this.ghandles.get(rec.dgroup | 1); if (g) g.size = init;
    this.w32(L.LDT + (rec.dgroup & 0xfff8) + 4, init - 1);
    if (this.lheaps) this.lheaps.delete(rec.dgroup | 1);
    // (and its atoms, kept for a segment with no local heap: Minesweeper's "Minesweeper" outlived its task, and its
    // next start found it, took itself for a second instance and quit)
    if (this.atoms) this.atoms.delete(rec.dgroup | 1);
  }
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
  name = name.replace(/\.?\s*$/, '');   // ("MMSYSTEM.", VB3's Declare ... Lib "MMSYSTEM": a name with no extension)
  const base = name.toUpperCase().replace(/^.*\\/, '').replace(/\.(DLL|EXE|DRV)$/, '');
  if (base === 'KERNEL' || base === 'KRNL386') return this.kernelModule();   // KRNL386.EXE is the module KERNEL's file
  const all = (window.W95SYSTEM && window.W95SYSTEM.ne) || {};
  const file = name.toUpperCase().replace(/^.*\\/, '');
  // a file name finds that file's module first (MSACM.DRV is the module MSACMMAP, not MSACM.DLL's MSACM)
  const byFile = /\./.test(file) && Object.values(all).find(s => s.fileName === file);
  if (byFile && this.ne.has(byFile.meta.name.toUpperCase())) return this.ne.get(byFile.meta.name.toUpperCase());
  if (!byFile && this.ne.has(base)) return this.ne.get(base);
  const sys = byFile || all[base] || Object.values(all).find(s => s.fileName === file || s.fileName === file + '.DLL');
  if (!sys) return this.loadNEFile(name);
  if (sys.onDisk && !this.findFile16(/\\/.test(name) ? name : sys.fileName)) return null;   // a module Setup leaves on the CD: once installed
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  if (this.ne.has(sys.meta.name.toUpperCase())) return this.ne.get(sys.meta.name.toUpperCase());
  const rec = this.loadNE(sys.meta.name.toUpperCase(), sys.fileBytes || (sys.fileBytes = b64(sys.file)), sys.mod || (sys.mod = new WebAssembly.Module(b64(sys.wasm))), sys.meta);
  rec.fileName = sys.fileName;
  for (const imp of sys.meta.imports || []) if (imp !== 'KERNEL' && (native || !JS16.includes(imp))) this.loadLibrary16(imp, native);
  if (defer) return rec;   // the caller runs LibEntry (initNE) once what it needs is in place
  if (!this.initNE(rec)) { log('warn', 'ne16', `${base} LibEntry failed`); }
  return rec;
};
/** start the native window system the way KRNL386 does: the drivers SYSTEM.INI's [boot] section names, in its
 *  order (system, keyboard, mouse, display, comm), then GDI and USER; returns USER's module record */
P.bootUser16 = function () {
  if (this.user16Ready === undefined) this.user16Ready = false;
  if (this.vxdBoot) this.vxdBoot();   // the static VxDs, initialized before Windows starts (vmm.js)
  for (const m of ['SYSTEM', 'KEYBOARD', 'MOUSE', this.displayDriverFile(), 'COMM', 'GDI']) this.loadLibrary16(m, true);
  // the sound driver SYSTEM.INI's [boot] names (sound.drv=mmsound.drv: the module SOUND, Windows 3.x's sound functions,
  // which Minesweeper imports), from its file, as KRNL386 loads it
  const snd = this.fs && winIni(this, 'SYSTEM.INI', 'boot', 'sound.drv');
  if (snd) { const f = this.findFile16(snd); if (f) try { this.loadLibrary16(f); } catch (e) { log('warn', 'ne16', `sound.drv ${snd} ${e && e.message}`); } }
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
  if (!user.inited) {
    user.inited = true; if (!this.initNE(user)) log('warn', 'ne16', 'USER LibEntry failed');
    // FinalUserInit (#400), as KRNL386 calls it once USER is up: GDI's FinalGdiInit takes the USER entry points GDI
    // calls through (LoadString, GetActiveWindow and the rest, which its print-to-file prompt uses)
    if (this.neExport(user, 400)) this.user16(400);
    // the fonts WIN.INI's [fonts] lists, each added (GDI's AddFontResource) as Windows starts: by its name in the Fonts
    // folder, or the path given. (Without them a face asked for by name is mapped to another: Flying Windows' Wingdings
    // logo became a dot)
    const gdi = this.ne.get('GDI'), add = gdi && this.neExport(gdi, 119);
    const fonts = add && window.W95Win32.iniRead(this.fs, 'WIN.INI').get('fonts');
    for (const { value } of fonts ? fonts.keys.values() : []) {
      const path = /[\\:]/.test(value) ? value : 'C:\\WINDOWS\\FONTS\\' + value, s = this.alloc(path.length + 1);
      this.writeA(s, path); this.call16(add >>> 16, add & 0xffff, [['l', this.mapLS(s)]]); this.free(s);
    }
  }
  this.user16Ready = true;
  this.hookIntents(user); this.hookClock(user); this.hookTaken(user);
  this.userStack();
  return user;
};
// USER's window stack: the word at DGROUP:194h counts the top-level windows USER has placed at CW_USEDEFAULT, each one
// a caption and frame down and right of the last (USER seg 11, 16E4h). Windows 95 has one USER, so one count for every
// program; each process here boots its own USER, so the processes share the count: what any of them last stepped it
// to is what the next one starts from
const STACK = 0x194, stackUsers = new Set(); let stackN = 0;
P.userStack = function () {
  const user = this.ne && this.ne.get('USER');   // (a screen saver's process has no native USER)
  if (!user || !user.inited) return;
  if (!stackUsers.has(this)) {   // this USER.EXE's (inc word ptr [194h] where it places a window)
    const s = user.meta.segs[10], at = s && s.base + 0x17a1;
    if (!s || this.u8[at] !== 0xff || this.u8[at + 1] !== 0x06 || this.r16(at + 2) !== STACK) return;
    stackUsers.add(this); this.stackSet = this.r16(this.selBase(user.dgroup) + STACK);   // its own start, not a step
  }
  for (const p of stackUsers) {
    const v = p.r16(p.selBase(p.ne.get('USER').dgroup) + STACK);
    if (v !== p.stackSet) { stackN = v; p.stackSet = v; }
    if (p.exitCode !== null || p.trapped) stackUsers.delete(p);
  }
  if (this.stackSet !== stackN) { this.w16(this.selBase(user.dgroup) + STACK, stackN); this.stackSet = stackN; }
};
/** a module from disk that has no code (fonts and other resource-only libraries) */
P.loadNEFile = function (name) {
  const full = this.findFile16(/\.[^\\]*$/.test(name) ? name : name + '.DLL'); if (!full) return null;
  const key = full.toUpperCase();
  for (const m of this.ne.values()) if (m.path === key) return m;
  const file = this.fs.readFile(full);
  if (file[0] !== 0x4d || file[1] !== 0x5a) return null;
  const n = rd.u32(file, 0x3c); if (file[n] !== 0x4e || file[n + 1] !== 0x45) return null;
  if (rd.u16(file, n + 0x1c)) return this.loadNEDynamic(key, file);   // (a module with code: mapped as the loader maps one)
  const hdrLen = Math.min(file.length - n, 0x4000), mdb = this.alloc(hdrLen + 16);
  this.u8.set(file.subarray(n, n + hdrLen), mdb);
  const rec = { name: key, path: key, kind: 'ne', file, segs: [], exports: new Map(), names: {}, meta: null, dgroup: 0 };
  rec.hModule = rec.hInstance = this.allocSels(mdb, hdrLen);
  this.ne.set(key, rec);
  return rec;
};
/** a 16-bit module nothing was recompiled for (a program or DLL the system bundle does not carry), mapped as
 *  KRNL386's loader maps one: each segment in memory of its own with a selector (code execute/read, data read/write;
 *  DGROUP 64K, its heap and stack to grow into), its relocations applied (references to its own segments and entries,
 *  imports by ordinal or by name, chains and additive ones; an import reaches a native or JS module through the 16-bit
 *  import thunks, another such module at its export), its entry table its exports; its code translated as it runs
 *  (dyn.js: no module's text is there, the dispatcher sends it there) */
// KERNEL's exports that are constants, as tools/recomp.py resolves them: __AHSHIFT, __AHINCR, __WINFLAGS, __FLATCS,
// __FLATDS, and the selectors of fixed real-mode memory (__0000H, __0040H, __A000H ... __F000H, __ROMBIOS)
const KERNEL_EQUATES = { 113: 3, 114: 8, 178: 0x0c29, 454: L.FLATCS, 455: L.FLATDS, 183: 0x107, 193: 0x10f, 174: 0x117, 181: 0x11f, 182: 0x127, 195: 0x12f, 179: 0x137, 190: 0x13f, 194: 0x147, 173: 0x147 };
P.loadNEDynamic = function (key, file) {
  const n = rd.u32(file, 0x3c), h = o => rd.u16(file, n + o), shift = h(0x32) || 9;
  const nseg = h(0x1c), segt = n + h(0x22), autodata = h(0x0e);
  const pstr = at => String.fromCharCode(...file.subarray(at + 1, at + 1 + file[at]));
  // names: the resident table (its first entry the module's name) and the non-resident one, each name -> ordinal
  const names = {}; let modName = key.replace(/^.*\\/, '').replace(/\.[^.]*$/, '');
  for (const [at, end] of [[n + h(0x26), n + h(0x28)], [rd.u32(file, n + 0x2c), rd.u32(file, n + 0x2c) + h(0x20)]]) {
    for (let p = at, first = true; p < end && file[p]; p += 3 + file[p], first = false) { const s = pstr(p).toUpperCase(); if (first && at === n + h(0x26)) modName = s.replace(/\0+$/, ''); else names[s] = rd.u16(file, p + 1 + file[p]); }
  }
  const name = modName.toUpperCase();
  if (this.ne.has(name)) return this.ne.get(name);
  // the modules it imports, by the module-reference table: each one there (loaded, the bundle's, a JS one, or a file
  // in the program's folder or Windows'), or the module is not loaded, as KRNL386 refuses one whose DLL is missing
  const mods = []; for (let i = 0; i < h(0x1e); i++) mods.push(pstr(n + h(0x2a) + rd.u16(file, n + h(0x28) + 2 * i)).toUpperCase());
  const all = (window.W95SYSTEM && window.W95SYSTEM.ne) || {}, dir = key.slice(0, key.lastIndexOf('\\'));
  const there = m => m === 'KERNEL' || JS16.includes(m) || this.ne.has(m) || all[m] || Object.values(all).some(s => s.meta && s.meta.name.toUpperCase() === m) ||
    ['.DLL', '.EXE', '.DRV'].some(x => this.findFile16(m + x) || this.fs.exists(`${dir}\\${m}${x}`));
  const missing = mods.find(m => !there(m));
  if (missing) { this.missing16 = `${missing}.DLL`; log('warn', 'ne16', `${key}: ${missing}.DLL is not found`); return null; }
  this.dirs16 = [...new Set([dir, ...(this.dirs16 || [])])].slice(0, 8);   // (its folder searched for its DLLs, as the program's own is)
  const segs = [];
  for (let i = 0; i < nseg; i++) {
    const e = segt + 8 * i, off = rd.u16(file, e) << shift, len = rd.u16(file, e + 2) || (off ? 0x10000 : 0), flags = rd.u16(file, e + 4), minalloc = rd.u16(file, e + 6) || 0x10000;
    const size = i + 1 === autodata ? 0x10000 : Math.max(len, minalloc, 1), base = this.alloc(size + 16);
    const sel = this.allocSels(base, size, flags & 1 ? 0xf300 : 0xfb00);
    if (len && off) this.u8.set(file.subarray(off, off + len), base);
    segs.push({ num: i + 1, sel, base, len, alloc: size, minalloc: rd.u16(file, e + 6), flags, fileoff: off, rel: flags & 0x100 ? off + len : 0 });
  }
  // the entry table: ordinal -> segment:offset (fixed bundles name their segment, movable ones each entry's)
  const exports = new Map();
  // (a library's export that uses its data segment (flag 2) and starts mov ax,ds or push ds/pop ax, then nop, gets
  // mov ax,DGROUP there, as KRNL386 patches the prolog: MCI.VBX's VBINITCC then runs on its own DS)
  const dgSel = (h(0x0c) & 0x8000) && autodata && segs[autodata - 1] ? segs[autodata - 1].sel : 0;
  const prolog = (sg, off, flag) => {
    const s = segs[sg - 1]; if (!dgSel || !(flag & 2) || !s || (s.flags & 1) || off + 3 > s.alloc) return;
    const a = s.base + off, w = this.r16(a);
    if ((w === 0xd88c || w === 0x581e) && this.u8[a + 2] === 0x90) { this.u8[a] = 0xb8; this.w16(a + 1, dgSel); }
  };
  for (let p = n + h(0x04), ord = 1, end = p + h(0x06); p < end && file[p];) {
    const cnt = file[p], ind = file[p + 1]; p += 2;
    if (ind === 0) { ord += cnt; continue; }
    for (let k = 0; k < cnt; k++, ord++) {
      if (ind === 0xff) { const sg = file[p + 3], off = rd.u16(file, p + 4); if (segs[sg - 1]) { exports.set(ord, u32((segs[sg - 1].sel << 16) | off)); prolog(sg, off, file[p]); } p += 6; }
      else { const off = rd.u16(file, p + 1); if (segs[ind - 1]) { exports.set(ord, u32((segs[ind - 1].sel << 16) | off)); prolog(ind, off, file[p]); } p += 3; }
    }
  }
  const meta = { name, base: segs.length ? segs[0].base : 0, segs, autodata, entry: [h(0x16), h(0x14)], exports: {}, names, imports: [], textLo: 0, textHi: 0, blocks: [], fixups: [], dynamic: true };
  const rec = { name, path: key, kind: 'ne', base: meta.base, meta, file, segs, exports, names, run: null };
  this.ne.set(name, rec); this.modules.push(rec); this.byName.set(name, rec);   // (before its imports: a module that imports this one back finds it)
  meta.imports = mods;
  const target = (mi, ordOrName) => {   // an import's far address: a module loaded here at its export, else its thunk
    const mod = mods[mi - 1] || '?'; let ord = ordOrName;
    const m = mod === 'KERNEL' ? null : this.loadLibrary16(mod, true);
    if (!m && mod !== 'KERNEL' && !JS16.includes(mod)) throw Object.assign(new Error(`${mod}.DLL could not be loaded`), { missing16: this.missing16 || `${mod}.DLL` });   // (a DLL of its own that did not load: neither does it)
    if (typeof ord === 'string') ord = (m && m.names && m.names[ord.toUpperCase()]) || (names16(mod) || {})[ord.toUpperCase()] || 0;
    if (mod === 'KERNEL' && KERNEL_EQUATES[ord] !== undefined) { const c = KERNEL_EQUATES[ord]; return u32(c << 16 | c); }   // (its constants: the value at a segment or an offset fixup)
    if (m && m.meta && m.meta.dynamic) { if (!m.inited && m !== rec) { m.inited = true; this.initNE(m); } return m.exports.get(ord) || 0; }   // (its LibEntry run as it is loaded)
    return this.thunk16For(`${m && m.kind !== 'js' ? m.name : mod}.#${ord}`);
  };
  // (a segment's relocations made in it: as it loads, and again for a data segment read again from the file, as the
  // module is loaded again after its last task, reloadData16)
  const relocSeg = sg => {
    if (!sg.rel) return;
    const cnt = rd.u16(file, sg.rel);
    for (let k = 0; k < cnt; k++) {
      const r = sg.rel + 2 + 8 * k, at = file[r], typ = file[r + 1], off = rd.u16(file, r + 2), a = rd.u16(file, r + 4), b = rd.u16(file, r + 6);
      let v;
      if ((typ & 3) === 0) { v = a & 0xff ? (a & 0xff) === 0xff ? exports.get(b) || 0 : u32((segs[(a & 0xff) - 1] ? segs[(a & 0xff) - 1].sel : 0) << 16 | b) : 0; }   // internal: segment and offset, or a movable entry's ordinal
      else if ((typ & 3) === 1) v = target(a, b);
      else if ((typ & 3) === 2) v = target(a, pstr(n + h(0x2a) + b));
      else continue;   // OS fixups (the x87's emulation): the instructions as they are
      const put = loc => {
        const lin = sg.base + loc;
        if (at === 0) this.u8[lin] = (typ & 4 ? this.u8[lin] : 0) + (v & 0xff);
        else if (at === 2) this.w16(lin, v >>> 16);
        else if (at === 3) this.w32(lin, typ & 4 ? u32(((v >>> 16) << 16) | ((this.r16(lin) + (v & 0xffff)) & 0xffff)) : v);
        else if (at === 5) this.w16(lin, (typ & 4 ? this.r16(lin) : 0) + (v & 0xffff));
      };
      if (typ & 4) { put(off); continue; }
      for (let loc = off, guard = 0; loc !== 0xffff && loc < sg.alloc && guard < 0x10000; guard++) { const next = this.r16(sg.base + loc); put(loc); loc = next; }   // (a chain: each place holds the next's offset)
    }
  };
  rec.relocSeg = relocSeg;
  try { for (const sg of segs) relocSeg(sg); } catch (e) {
    if (!e.missing16) throw e;
    this.ne.delete(name); this.byName.delete(name); this.modules = this.modules.filter(x => x !== rec);   // (not loaded after all)
    this.missing16 = e.missing16; log('warn', 'ne16', `${key}: ${e.missing16} is not found`); return null;
  }
  // its module database (a copy of its NE header) and handles, as loadNE makes them
  const hdrLen = Math.min(file.length - n, 0x4000), mdb = this.alloc(hdrLen + 16);
  this.u8.set(file.subarray(n, n + hdrLen), mdb);
  rec.hModule = this.allocSels(mdb, hdrLen);
  rec.dgroup = autodata ? segs[autodata - 1].sel : 0;
  rec.hInstance = rec.dgroup || rec.hModule;
  if (rec.dgroup) {
    const dg = segs[autodata - 1], init = Math.min(0x10000, ((dg.minalloc || 0x10000) + h(0x10) + taskStack(h(0x12)) + 15) & ~15);
    this.ghandles.set(rec.dgroup | 1, { lin: dg.base, size: init, n: 1, flags: 2, lock: 0, owner: rec.hModule });
  }
  for (const sg of segs) if (sg.num !== autodata) this.ghandles.set(sg.sel | 1, { lin: sg.base, size: sg.alloc, n: 1, flags: 0, lock: 0, owner: rec.hModule, code: !(sg.flags & 1) });
  if (this.onModuleLoad) this.onModuleLoad(name, rec);   // (a watch asked for before the module came: worker.js cmd 'watch')
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
// ---- the one way in for what arrives between two of the guest's instructions: the budget check's poll, the VM's
// hardware interrupts (vmIRQ), and the VxDs' time-outs, events, hot keys and stopped ring-0 runs (vmm.js). As the VMM
// reflects an interrupt: on a stack of its own, interrupts disabled, and a client register set of its own on the VM's
// locked stack for the VxDs' nested execution; the interrupted code's stack, flags and client registers as they were
// after. Run on the interrupted code's stack or client, their frames went below its SS:SP over what it keeps there:
// DIBENG's compiled blit keeps its line count at SS:0 of a 4Ah-byte stack, and WELCOME's blit ran from 0 at the first
// start (the sound card's interrupt, a56b40c; VTDAPI's timer event nesting MMSYSTEM's callback, e00457a)
P.asInterrupt = function (fn) {
  if (this.inInterrupt) return fn();
  const c = this.cpu, st = c.ss && { ss: c.ss.value, ssb: c.ssb.value, esp: c.esp.value }, ie = c.if ? c.if.value : 1;
  const vm = { crs: this.crs, level: this.crsLevel, pool: this.crsPool, cb: this.vmcb ? this.r32(this.vmcb + 8) : 0 };
  if (!this.intStack && st) { this.intStack = this.alloc(0x10000); this.intCrs = this.alloc(0x60); this.intCrsPool = []; }
  if (st) { c.ss.value = 0; c.ssb.value = 0; c.esp.value = this.intStack + 0x10000 - 16; this.crs = this.intCrs; this.crsLevel = 0; this.crsPool = this.intCrsPool; }
  // (the VM's client pointer and the current thread's (its TCB's), which vxdPmApi sets to the client being served)
  const th = st && this.vmcb && this.r0Thread ? this.r0Thread(this.currentThreadId()) : 0, thWas = th ? this.r32(th + 0x10) : 0;
  if (st && this.vmcb) this.w32(this.vmcb + 8, this.intCrs);
  if (th) this.w32(th + 0x10, this.intCrs);
  if (c.if) c.if.value = 0;
  this.inInterrupt = true;
  try { return fn(); } finally {
    this.inInterrupt = false;
    if (st) { c.ss.value = st.ss; c.ssb.value = st.ssb; c.esp.value = st.esp; }
    if (c.if) c.if.value = ie;
    this.crs = vm.crs; this.crsLevel = vm.level; this.crsPool = vm.pool; if (this.vmcb) this.w32(this.vmcb + 8, vm.cb);
    if (th) this.w32(th + 0x10, thWas);
  }
};
/** enter 16-bit code on an alias of the flat stack; args: [['w', v] | ['l', v]...] in Pascal order */
P.call16 = function (sel, off, args = [], regs = {}) {
  this.init16();
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  save.eip = this.cpu.eip.value;
  const lvl = this.stackLevel++; if (lvl >= L.NSTK) throw new GuestError('16-bit stack nesting too deep');
  const ssel = L.STK + 8 * lvl;
  // (the stack in use: a 16-bit one by SS:SP; the flat one by ESP, with SS null or the flat selector, as a Win32
  // thread's LoadLibrary16 has it: DCIMAN32 loading DCIMAN, whose start-up runs here)
  const ss = this.cpu.ss.value & 0xffff, flat = ss && ss !== L.FLATDS ? u32(this.cpu.ssb.value + (this.cpu.esp.value & 0xffff)) : u32(this.cpu.esp.value);
  const base = Math.max(0, flat - 0xfff0) & ~0xf;   // (64 KB below the stack top, and not below 0 for a stack low in memory)
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
  if (r === YIELD) { this.preempted = 0; return -1; }   // a thread suspended in the call: it runs the call again when resumed (it stopped there, not where its time ran out)
  if (ret === 'w' || ret === 'i') this.cpu.eax.value = lo16(this.cpu.eax.value, r | 0);   // (a word, unsigned or signed: lstrcmp's -1)
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
/** a FAT boot sector for a volume: its BPB from its size and cluster, its serial and label (INT 25h's sector 0) */
function bootSector(v) {
  const b = new Uint8Array(512), dv = new DataView(b.buffer), total = Math.max(1, Math.floor((v.total || 0) / 512)), spc = Math.max(1, Math.min(128, Math.round((v.cluster || 4096) / 512)));
  const clusters = Math.ceil(total / spc), fat32 = clusters >= 65525, spf = Math.ceil(clusters * (fat32 ? 4 : 2) / 512);
  b.set([0xeb, 0x3c, 0x90]); b.set([...'MSWIN4.1'].map(c => c.charCodeAt(0)), 3);
  dv.setUint16(11, 512, true); b[13] = spc; dv.setUint16(14, fat32 ? 32 : 1, true); b[16] = 2; dv.setUint16(17, fat32 ? 0 : 512, true);
  if (total < 0x10000 && !fat32) dv.setUint16(19, total, true); else dv.setUint32(32, total, true);
  b[21] = 0xf8; dv.setUint16(22, fat32 ? 0 : Math.min(0xffff, spf), true); dv.setUint16(24, 63, true); dv.setUint16(26, 255, true); dv.setUint32(28, 63, true);
  const ext = fat32 ? 64 : 36; if (fat32) { dv.setUint32(36, spf, true); dv.setUint32(44, 2, true); dv.setUint16(48, 1, true); }
  b[ext] = 0x80; b[ext + 2] = 0x29; dv.setUint32(ext + 3, (v.serial || 0) >>> 0, true);
  const label = String(v.label || 'NO NAME').toUpperCase().padEnd(11).slice(0, 11); for (let i = 0; i < 11; i++) b[ext + 7 + i] = label.charCodeAt(i);
  [...(fat32 ? 'FAT32   ' : 'FAT16   ')].forEach((c, i) => { b[ext + 18 + i] = c.charCodeAt(0); });
  b[510] = 0x55; b[511] = 0xaa; return b;
}
function absDisk(p, write) {
  const rm = p.rmode, at = (s, o) => (rm ? ((s & 0xffff) << 4) + (o & 0xffff) : p.lin(u32(((s & 0xffff) << 16) | (o & 0xffff))));
  const drive = String.fromCharCode(65 + (p.cpu.eax.value & 0xff)), cx = p.cpu.ecx.value & 0xffff;
  let first, n, buf;
  if (cx === 0xffff) { const pk = at(p.cpu.ds.value, p.cpu.ebx.value); first = p.r32(pk) >>> 0; n = p.r16(pk + 4); buf = at(p.r16(pk + 8), p.r16(pk + 6)); }
  else { first = p.cpu.edx.value & 0xffff; n = cx; buf = at(p.cpu.ds.value, p.cpu.ebx.value); }
  const done = (ok, err) => {
    CF(p, !ok); if (!ok) p.ax(err);
    // (the flags left pushed for the caller to pop)
    const sp = (p.cpu.esp.value - 2) & 0xffff; p.cpu.esp.value = (p.cpu.esp.value & ~0xffff) | sp; p.w16((p.cpu.ssb.value >>> 0) + sp, 0x0202 | (ok ? 0 : 1));
  };
  let v; try { v = p.fs.statvfs(drive + ':\\'); } catch (_) { return done(false, 0x8002); }   // (not ready: no such drive)
  if (write) return done(true);   // (nothing written)
  for (let i = 0; i < n; i++) { const s = first + i; if (s === 0) p.u8.set(bootSector(v), buf + 512 * i); else p.u8.fill(0, buf + 512 * i, buf + 512 * (i + 1)); }
  done(true);
}
// MSCDEX's device request (INT 2Fh AX=1510h) for the CD drive: the request header's status (+3) is set done (100h), or
// error (8000h | code: 1 unknown unit, 3 unknown command). IOCTL input (3) fills the control block at the transfer
// address (+0Eh) by its code (its first byte): 0 the device header's address, 1 the head's location, 4 the audio
// channels, 6 the device's status (cooked and raw reads, data and audio, Red Book addresses), 7 the sector size, 8 the
// volume's size, 9 media not changed, 10 the audio disc (tracks 1 to 1, the lead-out), 11 a track (a data track: its
// control byte 41h), 12 the Q channel, 15 the audio status; IOCTL output (12), open (13), close (14), and play (84h),
// stop (85h) and resume (88h), which have nothing to play on a data disc, are done
const cdRequest = p => {
  const rm = p.rmode, at = (s, o) => (rm ? ((s & 0xffff) << 4) + (o & 0xffff) : p.lin(u32(((s & 0xffff) << 16) | (o & 0xffff))));
  const hdr = at(p.cpu.es.value, p.cpu.ebx.value), drive = p.cpu.ecx.value & 0xffff;
  const status = v => p.w16(hdr + 3, v);
  // the drive's state, kept on the machine by drive (the system machine's volumes are the page's, made afresh each time
  // it asks for them: kept on one, a playing disc was idle at the next request, so CD Player went on a track at once
  // and Stop found nothing to stop). The volume is kept too: each ask is a round trip to the page, and CD Player
  // makes dozens of requests a drive at start, which the busy page answered in seconds
  const st = (p.cdDrives || (p.cdDrives = {}))[drive] || (p.cdDrives[drive] = {});
  const cd = st.vol || (st.vol = [...p.fs.vols.values()].find(v => v.kind === 'cdrom' && v.letter.charCodeAt(0) - 65 === drive));
  if (!cd) { st.vol = null; return status(0x8001); }
  // the disc: an audio disc's tracks (cdaudio.js, the volume's table of contents), or a data disc as one data track
  // whose sectors are the primary volume descriptor's volume space size (sector 16, +80), else 74 minutes
  let disc = st.toc;
  if (!disc) {
    if (cd.audio) disc = { tracks: cd.audio.tracks.map(t => ({ ...t, ctl: 0x01 })), leadout: cd.audio.leadout };
    else {
      let n = 0; try { const d = cd.disc && cd.disc.read(16, 1); n = d && d.length >= 84 ? new DataView(d.buffer, d.byteOffset).getUint32(80, true) : 0; } catch (_) { n = 0; }
      disc = { tracks: [{ number: 1, lba: 0, sectors: n || 333000, ctl: 0x41 }], leadout: n || 333000 };
    }
    st.toc = disc;
  }
  const msf = lba => { const f = lba + 150; return u32((Math.floor(f / 4500) << 16) | ((Math.floor(f / 75) % 60) << 8) | (f % 75)); };
  const bytesMsf = (b, lba) => { const f = lba + 150; p.u8[b] = Math.floor(f / 4500); p.u8[b + 1] = Math.floor(f / 75) % 60; p.u8[b + 2] = f % 75; };   // (minute, second, frame)
  // the drive's audio: playing [from, to) since t0 (its position by the clock, 75 sectors a second), or paused at pos
  const now = p.cdClock ? p.cdClock() : performance.now(), a = st.play || (st.play = { state: 'idle', from: 0, to: 0, pos: 0, t0: 0 });
  if (a.state === 'playing') { a.pos = Math.min(a.to, a.from + Math.floor((now - a.t0) * 75 / 1000)); if (a.pos >= a.to) a.state = 'idle'; }
  // (a play goes with the gain AUX1 has, where the drive's output reaches the sound card: sound.js cdAuxGain)
  const busy = a.state === 'playing' ? 0x0200 : 0, send = (op, from, to) => {
    if (op === 'play' && self.W95CDGAIN && p.cdAuxGain) self.W95CDGAIN(...p.cdAuxGain());
    if (self.W95CDAUDIO) self.W95CDAUDIO(op, from, to);
  };
  const trackAt = lba => disc.tracks.find(t => lba >= t.lba && lba < t.lba + t.sectors) || disc.tracks[0];
  const cmd = p.u8[hdr + 2];
  if (cmd === 3) {
    const t = p.r32(hdr + 0x0e), b = at(t >>> 16, t), code = p.u8[b];
    switch (code) {
      case 0: p.w32(b + 1, 0); break;
      case 1: p.u8[b + 1] = 0; p.w32(b + 2, a.pos); break;
      case 4: for (let i = 0; i < 4; i++) { p.u8[b + 1 + 2 * i] = i; p.u8[b + 2 + 2 * i] = 0xff; } break;
      case 6: p.w32(b + 1, cd.audio ? 0x0214 : 0x0a14); break;   // (a data disc is no audio disc to the drive's audio side: 0800h, no disc, with 0200h, Red Book addressing kept)
      case 7: p.u8[b + 1] = 0; p.w16(b + 2, 2048); break;
      case 8: p.w32(b + 1, disc.leadout); break;
      case 9: p.u8[b + 1] = st.seen ? 1 : 0xff; st.seen = true; break;   // (the first ask of a drive finds the disc just changed: MCICDA reads a disc's table only then, and starts with none)
      case 10: p.u8[b + 1] = disc.tracks[0].number; p.u8[b + 2] = disc.tracks[disc.tracks.length - 1].number; p.w32(b + 3, msf(disc.leadout)); break;
      case 11: { const tr = disc.tracks.find(x => x.number === p.u8[b + 1]); if (!tr) return status(0x8003); p.w32(b + 2, msf(tr.lba)); p.u8[b + 6] = tr.ctl; break; }
      case 12: {   // the Q channel: the track (BCD) and index, the time in the track, then on the disc
        const tr = trackAt(a.pos), bcd = n => ((n / 10) << 4) | (n % 10), rel = a.pos - tr.lba;
        p.u8.fill(0, b + 1, b + 11); p.u8[b + 1] = tr.ctl; p.u8[b + 2] = bcd(tr.number); p.u8[b + 3] = 1;
        p.u8[b + 4] = Math.floor(rel / 4500); p.u8[b + 5] = Math.floor(rel / 75) % 60; p.u8[b + 6] = rel % 75; bytesMsf(b + 8, a.pos);
        break;
      }
      case 15: p.u8.fill(0, b + 1, b + 11); p.w16(b + 1, a.state === 'paused' ? 1 : 0); p.w32(b + 3, msf(a.from)); p.w32(b + 7, msf(a.to)); break;
      default: return status(0x8003 | busy);
    }
    return status(0x0100 | busy);
  }
  if (cmd === 0x84) {   // play audio: from the start (+0Eh; HSG, or Red Book by the addressing mode at +0Dh) for n sectors (+12h)
    const s = p.r32(hdr + 0x0e), start = p.u8[hdr + 0x0d] ? ((s >>> 16) & 0xff) * 4500 + ((s >>> 8) & 0xff) * 75 + (s & 0xff) - 150 : s;
    const to = Math.min(disc.leadout, start + p.r32(hdr + 0x12));
    if (!cd.audio || start < 0 || start >= to) return status(0x800c);   // (a data disc has nothing to play: general failure)
    Object.assign(a, { state: 'playing', from: start, to, pos: start, t0: now }); send('play', start, to);
    return status(0x0300);
  }
  if (cmd === 0x85) {   // stop audio: pauses a playing disc; a paused one is stopped for good
    if (a.state === 'playing') a.state = 'paused'; else if (a.state === 'paused') a.state = 'idle';
    send('stop');   // (the page's drive stops whatever it still has to play, whatever the state says)
    return status(0x0100);
  }
  if (cmd === 0x88) {   // resume audio: a paused disc plays on from where it stopped
    if (a.state === 'paused' && a.pos < a.to) { Object.assign(a, { state: 'playing', from: a.pos, t0: now }); send('play', a.pos, a.to); return status(0x0300); }
    return status(0x800c);
  }
  if ([12, 13, 14].includes(cmd)) return status(0x0100 | busy);
  return status(0x8003);
};
const INTS = {
  0x3d() {},        // the x87 emulator's FWAIT (VBRUN300 has one with no OS fixup): with a coprocessor, nothing to wait for
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
    if (ah === 0x10) { this.biosPalette(); return; }
    if (ah === 0x11 || ah === 0x01 || ah === 0x02) return;
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
  0x12() { this.ax(640); },   // BIOS conventional memory size, in K
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
      case 0x19: this.ax((this.ax() & 0xff00) | (this.fs.cwd.toUpperCase().charCodeAt(0) - 65)); return;        // the current drive
      case 0x2a: { const d = new Date(this.progTime('wall', true)); this.cpu.ecx.value = lo16(this.cpu.ecx.value, d.getFullYear()); this.cpu.edx.value = lo16(this.cpu.edx.value, ((d.getMonth() + 1) << 8) | d.getDate()); this.ax((this.ax() & 0xff00) | d.getDay()); return; }
      case 0x2c: { const d = new Date(this.progTime('wall')); this.cpu.ecx.value = lo16(this.cpu.ecx.value, (d.getHours() << 8) | d.getMinutes()); this.cpu.edx.value = lo16(this.cpu.edx.value, (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10)); return; }
      case 0x33: if (al === 6) { this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0x0007); this.cpu.edx.value = lo16(this.cpu.edx.value, 0x1000); } else if (al === 0) this.cpu.edx.value &= ~0xff; return;   // true version 7.0, in HMA; Ctrl+Break checking off
      case 0x44: if (al === 0) {   // a handle's information: a file's drive (bit 7 clear; VB3 refuses a name that opens a device), else a character device
        const fh = this.dosFiles.get(this.cpu.ebx.value & 0xffff);
        if (fh && !fh.dev && fh.path) { this.cpu.edx.value = lo16(this.cpu.edx.value, (fh.path.toUpperCase().charCodeAt(0) - 65) & 0x3f); return; }
        if (!fh || !fh.dev) { this.cpu.edx.value = lo16(this.cpu.edx.value, 0x80); return; }
      } if (al === 0x0d) return this.blockIoctl();
      if (al === 0x0e || al === 0x0f) { this.ax(this.ax() & 0xff00); return; }   // the logical drive map (get, set): one letter to each drive here, AL 0
      // a block device driver's control data (4404h read, 4405h write; DriveSpace's way to its compressed volumes): the
      // drives here have no driver taking it, invalid function (1), as a plain disk's driver answers
      if (al === 0x04 || al === 0x05) { CF(this, 1); this.ax(1); this.dosError = 1; return; }
      // whether drive BL is remote (4409h: DX bit 12 for a network drive; a local one's attributes, 0802h, as DOS 7's
      // for a fixed disk with generic IOCTL), a handle's file (440Ah: DX bit 15, never); 4410h/4411h whether a generic
      // IOCTL is supported (AX 0 for those blockIoctl answers, else 1 invalid function)
      if (al === 0x09) {
        const bl = this.cpu.ebx.value & 0xff, v = this.fs.vols.get(bl ? String.fromCharCode(64 + bl) : this.fs.cwd[0].toUpperCase());
        if (!v) { CF(this, 1); this.ax(15); this.dosError = 15; return; }
        this.cpu.edx.value = lo16(this.cpu.edx.value, v.kind === 'remote' ? 0x1000 : 0x0802); this.ax(0); return;
      }
      if (al === 0x0a) { this.cpu.edx.value = lo16(this.cpu.edx.value, 0); this.ax(0); return; }
      if (al === 0x10 || al === 0x11) {
        const cx = this.cpu.ecx.value & 0xffff, ok = al === 0x11 && [0x084a, 0x086a, 0x084b, 0x086b, 0x086c, 0x0870, 0x0860, 0x0866, 0x086f].includes(cx);
        if (ok) { this.ax(0); return; } CF(this, 1); this.ax(1); this.dosError = 1; return;
      }
      if (al === 0x08) {   // whether drive BL (0 the current) is removable: AX 0 removable, 1 fixed; 15 no such drive
        const bl = this.cpu.ebx.value & 0xff, v = this.fs.vols.get(bl ? String.fromCharCode(64 + bl) : this.fs.cwd[0].toUpperCase());
        if (!v || v.kind === 'remote') { CF(this, 1); this.ax(15); this.dosError = 15; return; }
        this.ax(v.kind === 'removable' ? 0 : 1); return;
      }
      break;
      case 0x50: case 0x51: case 0x62: return;
      // the redirector's list of redirected devices (5F02h, BX the index): the drives MPR connects are the network
      // process's; none is redirected through DOS here, so the list is empty (18, no more entries)
      case 0x5f: if (al === 2) { CF(this, 1); this.ax(18); this.dosError = 18; return; } break;
      // the last call's extended error (BX 0): AX the code, BH its class, BL the suggested action, CH where it happened
      case 0x59: {
        const e = this.dosError || 0, cls = [2, 3, 15, 18].includes(e) ? 8 : e === 5 ? 3 : e ? 13 : 0;
        this.ax(e); this.cpu.ebx.value = lo16(this.cpu.ebx.value, (cls << 8) | (e ? (e === 5 ? 3 : 4) : 0)); this.cpu.ecx.value = lo16(this.cpu.ecx.value, ((e ? 2 : 0) << 8) | (this.cpu.ecx.value & 0xff)); return;
      }
      case 0x35: {   // a vector nobody has set leads to the BIOS service behind it, where there is one
        const v = ((this.dosVec = this.dosVec || {})[al]) || (BIOS_INT[al] ? this.thunk16For(`BIOSINT.#${al}`) : 0);
        this.seg('es', v >>> 16); this.cpu.ebx.value = lo16(this.cpu.ebx.value, v); return; }
      case 0x0d: return;   // disk reset: nothing is buffered
      // DOS's own data, which the file system manager reads as it takes over from DOS: the InDOS flag (34h: ES:BX),
      // the list of lists (52h: ES:BX), the swappable data area (5D06h: DS:SI, CX and DX its sizes)
      case 0x34: { const d = this.dosData(); this.seg16('es', d); this.cpu.ebx.value = lo16(this.cpu.ebx.value, d.indos - (d.seg << 4)); return; }
      case 0x52: { const d = this.dosData(); this.seg16('es', d); this.cpu.ebx.value = lo16(this.cpu.ebx.value, d.lol - (d.seg << 4)); return; }
      // a drive's parameter block (DL, 0 the current drive): C:'s is the one DOS keeps; a CD-ROM's or a network drive's
      // has none (AL FFh), as the file system that owns it answers instead
      case 0x32: {
        const dl = this.cpu.edx.value & 0xff, L = dl ? String.fromCharCode(64 + dl) : this.fs.cwd[0].toUpperCase(), v = this.fs.vols.get(L);
        if (!v || L !== 'C') { this.ax((this.ax() & 0xff00) | 0xff); return; }
        const d = this.dosData(); this.seg16('ds', d); this.cpu.ebx.value = lo16(this.cpu.ebx.value, d.dpb - (d.seg << 4)); this.ax(this.ax() & 0xff00); return;
      }
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
      case 0x4c: if (this.thread16 && this.thread16.task && this.atThreadTop()) { this.thread16.exitCode = al; return LAYOUT.SENTINEL; } break;   // a task's exit ends its thread
      // MS-DOS 7's FAT32 functions (Disk Defragmenter, ScanDisk), answered from the volume's numbers: 7302h the
      // extended DPB (DS:DX the drive's name, ES:DI the buffer, CX its size), 7303h the extended free space (DS:DX
      // the name, ES:DI the buffer, CX its size), 7304h set DPB for formatting (done), 7305h extended absolute read and
      // write (DS:BX the packet, SI bit 0 write; a read of sector 0 is the boot sector, the rest zeros; a write goes
      // nowhere: nothing here ever writes a drive's sectors)
      case 0x73: {
        const rm = this.rmode, at = (s, o) => (rm ? ((s & 0xffff) << 4) + (o & 0xffff) : this.lin(u32(((s & 0xffff) << 16) | (o & 0xffff))));
        const fail = code => { CF(this, 1); this.ax(code); };
        if (al === 2 || al === 3) {
          const name = this.readA(at(this.cpu.ds.value, this.cpu.edx.value)) || '', L = (name[0] || this.fs.cwd[0]).toUpperCase();
          let v; try { v = this.fs.statvfs(L + ':\\'); } catch (_) { return fail(0x0f); }   // (invalid drive)
          const buf = at(this.cpu.es.value, this.cpu.edx.value * 0 + (this.cpu.edi.value & 0xffff)), cx = this.cpu.ecx.value & 0xffff;
          const bs = bootSector(v), spc = bs[13], bps = 512, total = bs.length && (new DataView(bs.buffer).getUint16(19, true) || new DataView(bs.buffer).getUint32(32, true));
          const fat32 = bs[0x52] === 0x46, spf = fat32 ? new DataView(bs.buffer).getUint32(36, true) : new DataView(bs.buffer).getUint16(22, true), nfats = bs[16], res = new DataView(bs.buffer).getUint16(14, true);
          const rootSecs = fat32 ? 0 : Math.ceil(512 * 32 / bps), data0 = res + nfats * spf + rootSecs, clusters = Math.max(1, Math.floor((total - data0) / spc));
          const freeCl = Math.min(clusters, Math.floor((v.free || 0) / (spc * bps)));
          if (al === 2) {
            if (cx < 0x3f) return fail(0x18);   // (bad length: the buffer is smaller than the extended DPB)
            this.w16(buf, 0x3d); const d = buf + 2;   // (the size written, then the DPB: 3Dh bytes with the FAT32 extension)
            this.u8.fill(0, d, d + 0x3d);
            this.u8[d] = L.charCodeAt(0) - 65; this.u8[d + 1] = this.u8[d]; this.w16(d + 2, bps); this.u8[d + 4] = spc - 1; this.u8[d + 5] = Math.log2(spc) | 0;
            this.w16(d + 6, res); this.u8[d + 8] = nfats; this.w16(d + 9, fat32 ? 0 : 512); this.w16(d + 0xb, data0 & 0xffff); this.w16(d + 0xd, Math.min(0xffff, clusters + 1));
            this.w16(d + 0xf, fat32 ? 0 : spf); this.w16(d + 0x11, fat32 ? 0 : res + nfats * spf);
            this.u8[d + 0x17] = 0xf8; this.u8[d + 0x18] = 0; this.w32(d + 0x19, 0xffffffff); this.w16(d + 0x1d, 2); this.w16(d + 0x1f, Math.min(0xffff, freeCl));
            // (the FAT32 extension: flags, FS information sector, backup boot sector, first data sector, the counts as dwords)
            this.w16(d + 0x21, 0); this.w16(d + 0x23, fat32 ? 1 : 0xffff); this.w16(d + 0x25, fat32 ? 6 : 0xffff); this.w32(d + 0x27, data0); this.w32(d + 0x2b, clusters + 1);
            this.w32(d + 0x2f, spf); this.w32(d + 0x33, fat32 ? 2 : 0); this.w32(d + 0x37, freeCl); this.w32(d + 0x3b, 2);
            this.ax(0); CF(this, 0); return;
          }
          if (cx < 0x2c) return fail(0x18);
          this.u8.fill(0, buf, buf + 0x2c); this.w16(buf, 0x2c); this.w16(buf + 2, 0);
          this.w32(buf + 4, spc); this.w32(buf + 8, bps); this.w32(buf + 12, freeCl); this.w32(buf + 16, clusters);
          this.w32(buf + 20, freeCl * spc); this.w32(buf + 24, clusters * spc); this.w32(buf + 28, freeCl * spc); this.w32(buf + 32, clusters * spc);
          this.ax(0); CF(this, 0); return;
        }
        if (al === 4) { this.ax(0); CF(this, 0); return; }
        if (al === 5) {
          if ((this.cpu.ecx.value & 0xffff) !== 0xffff) return fail(1);
          const L = String.fromCharCode(64 + (this.cpu.edx.value & 0xff)), pk = at(this.cpu.ds.value, this.cpu.ebx.value), write = this.cpu.esi.value & 1;
          let v; try { v = this.fs.statvfs(L + ':\\'); } catch (_) { return fail(0x0f); }
          const first = this.r32(pk) >>> 0, n = this.r16(pk + 4), buf = at(this.r16(pk + 8), this.r16(pk + 6));
          if (!write) for (let i = 0; i < n; i++) { const s = first + i; if (s === 0) this.u8.set(bootSector(v), buf + 512 * i); else this.u8.fill(0, buf + 512 * i, buf + 512 * (i + 1)); }
          this.ax(0); CF(this, 0); return;
        }
        break;
      }
    }
    // names and directories, as DOS 7 answers them, with its long-name functions (AH=71h, the same calls with long
    // names): CF and AX = error code on failure
    if (ah === 0x71 || [0x0e, 0x11, 0x12, 0x1a, 0x2f, 0x36, 0x39, 0x3a, 0x3b, 0x41, 0x43, 0x47, 0x4e, 0x4f, 0x56].includes(ah)) {
      const lfn = ah === 0x71, fn = lfn ? al : ah, r = this.dosNames(fn, lfn);
      if (r !== false) return r;
    }
    // handle file calls, on the handles KERNEL's _lopen/OpenFile give out: BX handle, CX count, DS:DX buffer or name;
    // CF and AX = error code on failure (2 not found, 5 denied, 6 bad handle)
    // (in real mode, as a VxD's nested execution calls DOS, a segment is a paragraph number)
    if ([0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x57, 0x5b, 0x6c].includes(ah) || (ah === 0x44 && (al === 2 || al === 0) && this.dosFiles.get(this.cpu.ebx.value & 0xffff) && this.dosFiles.get(this.cpu.ebx.value & 0xffff).dev)) {
      // (a VxD's call through Exec_VxD_Int: 32-bit offsets on a flat DS)
      const flat = this.vxdFlat, off16 = r => (flat ? u32(this.cpu[r].value) : this.cpu[r].value & 0xffff);
      const bx = this.cpu.ebx.value & 0xffff, cx = flat ? u32(this.cpu.ecx.value) : this.cpu.ecx.value & 0xffff, dx = off16('edx');
      const at = off => (flat ? off : this.rmode ? ((this.cpu.ds.value & 0xffff) << 4) + off : this.lin((this.cpu.ds.value << 16) | off));
      const dsdx = () => at(dx), f = this.dosFiles.get(bx);
      const fail = code => { CF(this, 1); this.ax(code); this.dosError = code; };
      try {
        switch (ah) {
          case 0x3c: case 0x3d: {
            if (ah === 0x3d && /(^|\\)IFS\$HLP\$$/i.test(this.readA(dsdx()) || '') && this.ifshlp()) {   // the helper's character device
              const hh = 0x7f00; this.dosFiles.set(hh, { dev: 'IFS$HLP$' }); return this.ax(hh);
            }
            const name = this.readA(dsdx()) || '', full = ah === 0x3c ? (/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name)) : this.findFile16(name);
            if (self.W95TRACE16) self.W95TRACE16({ key: `INT21.${ah.toString(16)} ${name}${full ? '' : ' (not found)'}` });   // (a diagnostic: cmd 'trace')
            if (!full) return fail(2);
            const h = this.dosOpen(full, ah === 0x3c ? 'w+' : (al & 3) === 0 ? 'r' : 'r+'); return h === 0xffff ? fail(this.lastError || 2) : this.ax(h);
          }
          case 0x5b: {   // create a new file: one already there is an error (80)
            const name = this.readA(dsdx()) || '', full = this.dosFull(name);
            if (this.fs.exists(full)) return fail(80);
            const h = this.dosOpen(full, 'wx+'); return h === 0xffff ? fail(this.lastError || 5) : this.ax(h);
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
    this.trapped = `unhandled int 21h ax=${this.ax().toString(16)} bx=${(this.cpu.ebx.value & 0xffff).toString(16)} cx=${(this.cpu.ecx.value & 0xffff).toString(16)}`; return LAYOUT.SENTINEL;
  },
  0x11() { this.ax(0x0023); },
  // DOS's absolute disk read (25h) and write (26h): AL the drive (0 A:), CX sectors from DX at DS:BX, or CX FFFFh and
  // DS:BX a packet (the first sector, a dword; the count; the buffer, far). The drives here are files, not sectors: a
  // read of the boot sector (sector 0) gives the BPB DOS would have for the volume (File Manager reads it for a drive's
  // details), any other sector zeros; a write is taken and goes nowhere (Disk Defragmenter's moves: no sector of a
  // drive here is ever written). CF and AX say how it went, and the flags stay pushed, as DOS leaves them for POPF
  0x25() { absDisk(this, false); },
  0x26() { absDisk(this, true); },
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
      const id = this.cpu.ebx.value & 0xffff, routed = this.vxdApiRoute && this.vxdApiRoute(id);
      // a loaded VxD with a protected-mode API (SHELL's, which MSGSRV32 calls) answers for itself
      if (!VXD_API[id] && routed) { vxdApi(id, routed.name || `VxD ${id.toString(16)}h`, {}); VXD_API[id].routedOnly = true; }
      const api = VXD_API[id], has = api && ((id !== 0x37 && !api.routedOnly) || routed);   // ENABLE's only when its VxD is loaded
      const ep = id === 0x0a ? this.thunk16For('VDD.#0') : id === 0x11f ? this.thunk16For('VFLATD.#0') : has ? this.thunk16For(`VXD.#${id}`) : 0;
      this.cpu.edi.value = lo16(this.cpu.edi.value, ep & 0xffff); this.seg('es', ep >>> 16); return;
    }
    if (ax === 0x1686) { this.ax(0); return; }                                          // in protected mode
    // MSCDEX's interface, which the CD-ROM file system answers: 1500h the CD-ROM drives (BX how many, CX the first, 0
    // for A:), 150Bh whether drive CX is one (AX nonzero, BX ADADh), 150Ch the version (BX 2.21), 150Dh their letters
    if ((ax >> 8) === 0x15 && [0x00, 0x0b, 0x0c, 0x0d].includes(ax & 0xff)) {
      const cds = [...this.fs.vols.values()].filter(v => v.kind === 'cdrom').map(v => v.letter.charCodeAt(0) - 65).sort((a, b) => a - b);
      const reg = (r, v) => { this.cpu[r].value = lo16(this.cpu[r].value, v); };
      switch (ax & 0xff) {
        case 0x00: reg('ebx', cds.length); if (cds.length) reg('ecx', cds[0]); return;
        case 0x0b: reg('ebx', 0xadad); this.ax(cds.includes(this.cpu.ecx.value & 0xffff) ? 0x5ad8 : 0); return;
        case 0x0c: reg('ebx', 0x0215); return;
        case 0x0d: { const at = this.rmode ? ((this.cpu.es.value & 0xffff) << 4) + (this.cpu.ebx.value & 0xffff) : this.lin(((this.cpu.es.value & 0xffff) << 16) | (this.cpu.ebx.value & 0xffff)); cds.forEach((c, i) => { this.u8[at + i] = c; }); return; }
      }
    }
    // 1510h, a request to drive CX's device driver (ES:BX its request header), as MCICDA (CD Player's MCI device)
    // sends them: the disc is the CD's data disc, one data track from 0 to its lead-out, so it has no audio to play
    if (ax === 0x1510) return cdRequest(this);
    if (ax === 0x1689 || ax === 0x1680) return;
    if (ax === 0x160b) return;          // identify Windows-aware TSRs: none is loaded, so ES:DI comes back as it went in
    if (ax === 0x1607) return;          // device callout to real-mode software (a VxD asking for its TSR's API): none answers
    if ([0x11, 0xb8, 0xb7, 0x58].includes(ax >> 8)) return;   // real-mode network redirector, network, APPEND and real-mode network extension checks: none is loaded (AL comes back as it went)
    if ((ax >> 8) === 0x40) return;    // VDD save/restore and critical-section notifications
    if (ax === 0x4a32) return;         // boot progress to IO.SYS (USER reports start-up done; its answer is not read)
    // SMARTDrive's (4A10h) and DriveSpace's (4A11h) API: neither is loaded (the drives are files here), so AX comes
    // back as it went, as DOS answers a call no one claims (Disk Defragmenter asks DriveSpace about each drive)
    if (ax === 0x4a10 || ax === 0x4a11) return;
    // a multiplex number nothing in this system owns (a TSR's: INTERLNK's 56h, which Disk Defragmenter asks about):
    // none is loaded, the call comes back as it went, as DOS's chain ends. One that DOS, Windows or their drivers own
    // and is not answered above stops here, named (a gap)
    const OWNED = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x19, 0x1a, 0x40, 0x43, 0x46, 0x48, 0x4a, 0x4b, 0x55, 0x58, 0xae, 0xb7, 0xb8];
    if (!OWNED.includes(ax >> 8)) return;
    this.trapped = `unhandled int 2Fh ax=${ax.toString(16)}`; return LAYOUT.SENTINEL;
  },
};
/** INT 21h 440Dh, a block device's generic IOCTL (BL the drive, 0 the current one; CH 08h, CL the request): Get Drive
 *  Map Info (6Fh), the DRIVE_MAP_INFO at DS:DX, which says a drive runs under a protected-mode driver (1), on a physical
 *  drive (2), ejectable by software (8), its INT 13h unit and the logical drives sharing it; a drive with no block
 *  device (a network drive's, none) is not valid (15), and another request is not one this DOS has (1) */
P.blockIoctl = function () {
  const fail = e => { CF(this, 1); this.ax(e); this.dosError = e; };
  const bl = this.cpu.ebx.value & 0xff, cx = this.cpu.ecx.value & 0xffff;
  const L = bl ? String.fromCharCode(64 + bl) : this.fs.cwd[0].toUpperCase(), v = this.fs.vols.get(L);
  if (!v || v.kind === 'remote') return fail(15);
  // (the volume locks a disk utility takes before it writes sectors, logical 084Ah/086Ah, physical 084Bh/086Bh, and
  // their state, 086Ch/0870h: granted, its writes go nowhere, INT 26h; Disk Defragmenter locks C: so)
  // (each drive's lock level, kept as DOS 7 keeps it: 084Ah takes BH's level, 086Ah lets the volume go; 0870h answers
  // the level held, FFFFh none, as Disk Defragmenter asks before its own lock: answered 0, it said a disk utility had
  // C: locked)
  const locks = this.volLocks || (this.volLocks = new Map());
  if (cx === 0x084a || cx === 0x084b) { locks.set(L, (this.cpu.ebx.value >> 8) & 0xff); this.ax(0); return; }
  if (cx === 0x086a || cx === 0x086b) { const lv = locks.get(L); if (lv) locks.set(L, lv - 1); else locks.delete(L); this.ax(0); return; }
  if (cx === 0x0870) { const lv = locks.get(L); this.ax(lv === undefined ? 0xffff : lv); this.cpu.ecx.value = lo16(this.cpu.ecx.value, 0); return; }
  if (cx === 0x086c) { this.ax(0); return; }   // (the lock's access flag: nothing has written or mapped the volume since)
  const a = this.lin(((this.cpu.ds.value & 0xffff) << 16) | (this.cpu.edx.value & 0xffff));
  const vi = (() => { try { return this.fs.statvfs(L + ':\\'); } catch (_) { return null; } })();
  // 0860h the device's parameters (DS:DX: special functions, device type, attributes, cylinders, media type, then the
  // BPB, as the boot sector's, INT 25h's); 0866h its media id (info level, serial, label, file system type)
  if (cx === 0x0860 && vi) {
    const bs = bootSector(vi); this.u8[a + 1] = v.kind === 'removable' ? 7 : 5; this.w16(a + 2, v.kind === 'removable' ? 0 : 1);
    this.w16(a + 4, 1024); this.u8[a + 6] = 0; this.u8.set(bs.subarray(11, 36), a + 7); this.ax(0); return;
  }
  if (cx === 0x0866 && vi) {
    const bs = bootSector(vi), e = bs[0x52] === 0x46 ? 64 : 36;   // (the extended BPB: FAT32's further on)
    this.w16(a, 0); this.u8.set(bs.subarray(e + 3, e + 26), a + 2); this.ax(0); return;
  }
  if (cx !== 0x086f) return fail(1);
  const n = this.u8[a];
  const fixed = v.kind === 'fixed', unit = fixed ? 0x80 : v.kind === 'removable' ? 0 : 0xff;
  const info = new Uint8Array(16), dv = new DataView(info.buffer);
  info[0] = n; info[1] = 16; info[2] = 1 | 2 | (v.kind === 'cdrom' ? 8 : 0); info[3] = unit;
  dv.setUint32(4, 1 << (L.charCodeAt(0) - 65), true); dv.setUint32(8, fixed ? 63 : 0, true);
  this.u8.set(info.subarray(0, Math.max(2, Math.min(n || 16, 16))), a); this.u8[a] = n;
};
P.trapHook = function (e, code) {
  if (code === 0) return this.exception16(0, u32(e));
  if (code < 0x100) return false;
  if (code >= 0x3000000) { this.mmioRead(u32(e), code & 0xff); return true; }
  if (code >= 0x2000000) { this.mmioWrite(u32(e), code & 0xff); return true; }
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

/** INT 10h AH=10h, the VGA BIOS's palette: the attribute controller's 16 palette registers (00h one, BL to BH; 02h all
 *  and the overscan from ES:DX; 07h, 09h read them), the overscan (01h, 08h), blink or intensity (03h), the color
 *  page (13h, 1Ah), the DAC's registers (10h one: BX, red DH, green CH, blue CL; 12h a block from ES:DX, BX first, CX
 *  of them; 15h, 17h read them), its mask (18h, 19h) and the sum to gray (1Bh) */
P.biosPalette = function () {
  const a = this.adapter(), al = this.ax() & 0xff, bx = this.cpu.ebx.value & 0xffff, bl = bx & 0xff, bh = bx >> 8, cx = this.cpu.ecx.value & 0xffff;
  const esdx = () => this.rmode ? ((this.cpu.es.value & 0xffff) << 4) + (this.cpu.edx.value & 0xffff) : this.lin(((this.cpu.es.value & 0xffff) << 16) | (this.cpu.edx.value & 0xffff));
  const setBH = v => { this.cpu.ebx.value = lo16(this.cpu.ebx.value, (v & 0xff) << 8 | bl); };
  switch (al) {
    case 0x00: if (bl < 0x15) a.attr[bl] = bh; break;
    case 0x01: a.attr[0x11] = bh; break;
    case 0x02: { const p = esdx(); for (let i = 0; i < 16; i++) a.attr[i] = this.u8[p + i]; a.attr[0x11] = this.u8[p + 16]; break; }
    case 0x03: a.attr[0x10] = (a.attr[0x10] & ~8) | (bl & 1) << 3; break;
    case 0x07: setBH(a.attr[bl & 0x1f]); break;
    case 0x08: setBH(a.attr[0x11]); break;
    case 0x09: { const p = esdx(); for (let i = 0; i < 16; i++) this.u8[p + i] = a.attr[i]; this.u8[p + 16] = a.attr[0x11]; break; }
    case 0x10: { const k = 3 * (bx & 0xff); a.dac[k] = (this.cpu.edx.value >> 8) & 0x3f; a.dac[k + 1] = (cx >> 8) & 0x3f; a.dac[k + 2] = cx & 0x3f; break; }
    case 0x12: { const p = esdx(); for (let i = 0; i < cx && bx + i < 256; i++) for (let c = 0; c < 3; c++) a.dac[3 * (bx + i) + c] = this.u8[p + 3 * i + c] & 0x3f; break; }
    case 0x13: if (bl === 0) a.attr[0x10] = (a.attr[0x10] & 0x7f) | (bh & 1) << 7; else a.attr[0x14] = bh & 0x0f; break;
    case 0x15: { const k = 3 * (bx & 0xff); this.cpu.edx.value = lo16(this.cpu.edx.value, a.dac[k] << 8 | (this.cpu.edx.value & 0xff)); this.cpu.ecx.value = lo16(this.cpu.ecx.value, a.dac[k + 1] << 8 | a.dac[k + 2]); break; }
    case 0x17: { const p = esdx(); for (let i = 0; i < cx && bx + i < 256; i++) for (let c = 0; c < 3; c++) this.u8[p + 3 * i + c] = a.dac[3 * (bx + i) + c]; break; }
    case 0x18: a.pelMask = bl; break;
    case 0x19: this.cpu.ebx.value = lo16(this.cpu.ebx.value, (bx & 0xff00) | a.pelMask); break;
    case 0x1a: this.cpu.ebx.value = lo16(this.cpu.ebx.value, (a.attr[0x14] & 0x0f) << 8 | (a.attr[0x10] >> 7)); break;
    case 0x1b: for (let i = 0; i < cx && bx + i < 256; i++) { const k = 3 * (bx + i), y = Math.round(0.3 * a.dac[k] + 0.59 * a.dac[k + 1] + 0.11 * a.dac[k + 2]); a.dac[k] = a.dac[k + 1] = a.dac[k + 2] = y; } break;
  }
  a.dirty = true;
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
/** whether USER holds keyboard or mouse input no program has taken yet: the host feeds the next hardware events only
 *  then. Hardware input wakes the queue of the task in the foreground, so GetInputState is asked as that task (asked
 *  as the system, it answers for the system thread's queue, which the input never reaches: the host fed on while the
 *  program typed into still had keys to take, and the queue let some fall) */
P.inputPending = function () {
  const fg = this.user16(608).ax;                                                                     // GetForegroundWindow
  return !!this.asWindowTask(fg, () => this.user16(335).ax);                                          // GetInputState
};
/** USER's DispatchMessage (#114) watched at its entry: the mouse moves the programs take, counted (movesTaken),
 *  which paces the moves of a drag going in (worker.js feedMouse: USER keeps only the latest of those waiting) */
P.hookTaken = function (user) {
  // (#114 for a Windows program; #822, DispatchMessage32, for a Win32 one, whose USER32 hands USER a 32-bit MSG:
  // hwnd a dword, then the message; and USER32's own entry, loaded already or later, hookTaken32)
  const u32m = this.byName && this.byName.get('USER32'); if (u32m) this.hookTaken32(u32m);
  for (const [ord, msgAt] of [[114, 2], [822, 4]]) {
    const at = this.neExport(user, ord); if (!at || !this.selValid(at >>> 16)) continue;
    (this.entryHooks || (this.entryHooks = new Map())).set(u32(this.selBase(at >>> 16) + (at & 0xffff)), function () {
      const sp = this.selBase(this.cpu.ss.value) + (this.cpu.esp.value & 0xffff), off = this.r16(sp + 4), seg = this.r16(sp + 6);   // (the far return, then lpMsg)
      if (this.selValid(seg) && this.r16(this.selBase(seg) + off + msgAt) === 0x200) this.movesTaken = (this.movesTaken || 0) + 1;   // WM_MOUSEMOVE
      return undefined;   // (USER's own code goes on)
    });
  }
};
/** USER32's DispatchMessageA watched at its entry, for a Win32 program's moves taken: its USER32 reaches USER by
 *  thunks of its own, not USER's exports (the MSG a flat pointer on the stack: hwnd, then the message) */
P.hookTaken32 = function (m) {
  const at = m.exports && m.exports.get('DispatchMessageA'); if (!at) return;
  (this.entryHooks || (this.entryHooks = new Map())).set(u32(at), function () {
    const lp = this.r32(u32(this.cpu.esp.value) + 4), msg = this.r32(lp + 4);
    if (msg === 0x200) this.movesTaken = (this.movesTaken || 0) + 1;   // WM_MOUSEMOVE
    if (msg >= 0x200 && msg <= 0x209) { const c = this.msgTaken || (this.msgTaken = {}); c[msg] = (c[msg] || 0) + 1; if (msg === 0x200 && (this.r32(lp + 8) & 1)) c.movesHeld = (c.movesHeld || 0) + 1; }   // (the mouse messages taken, by message, and the moves with the left button held: the strokes diagnostic)
    return undefined;
  });
};
/** where USER's cursor is (GetCursorPos), for the pointer's hot spot in its image (null inside a call) */
P.cursorPos = function () {
  if (this.depth) return null;
  if (!this.wbufLin) this.nativeWindows();
  const a = this.wbufLin + 0x104; this.user16(17, [['l', u32((this.wbufSel << 16) + 0x104)]]);                     // GetCursorPos
  return { x: (this.r16(a) << 16) >> 16, y: (this.r16(a + 2) << 16) >> 16 };
};
/** the window under a screen point among a window's descendants (the deepest, whatever other window covers it on
 *  this screen): the window itself if none */
P.childAt = function (h, sx, sy) {
  const u = (o, args) => this.user16(o, args).ax;
  for (let n = 0; n < 32; n++) {
    const c = this.clientPoint(h, sx, sy), k = u(191, [['w', h], ['l', u32((c.y << 16) | (c.x & 0xffff))]]);   // ChildWindowFromPoint
    if (!k || k === h) break;
    h = k;
  }
  return h;
};
/** a screen point in a window's client coordinates (ScreenToClient) */
P.clientPoint = function (h, sx, sy) {
  if (!this.wbufLin) this.nativeWindows();
  const a = this.wbufLin + 0x100; this.w16(a, sx & 0xffff); this.w16(a + 2, sy & 0xffff);
  this.user16(29, [['w', h], ['l', u32((this.wbufSel << 16) + 0x100)]]);                                             // ScreenToClient
  return { x: (this.r16(a) << 16) >> 16, y: (this.r16(a + 2) << 16) >> 16 };
};
/** a mouse message posted to a window as the mouse's own would come (wParam the buttons held, lParam the point in
 *  its client coordinates), from a screen point */
P.postMouse = function (h, msg, keys, sx, sy) {
  const c = this.clientPoint(h, sx, sy);
  return this.user16(110, [['w', h], ['w', msg], ['w', keys], ['l', u32((c.y << 16) | (c.x & 0xffff))]]).ax;      // PostMessage
};
/** whether a posted message waits in the queue of the task owning a window (GetQueueStatus(QS_POSTMESSAGE) asked as it) */
P.postedPending = function (hwnd) {
  return !!(this.asWindowTask(hwnd, () => this.user16(334, [['w', 8]]).dxax) & 0x00080000);                      // (the high word: the kinds of message in the queue now)
};
/** whether the task owning a window has input in its queue it has not taken yet (GetInputState asked as that task) */
P.inputPendingFor = function (hwnd) {
  return !!this.asWindowTask(hwnd, () => this.user16(335).ax);                                        // GetInputState
};
/** fn run as the task of the started process that owns a window (as its main thread), the way that process's own
 *  calls for the window run: USER's SetActiveWindow activates only a window of the calling task */
P.asWindowTask = function (hwnd, fn) {
  const task = this.thread16 ? 0 : this.user16(224, [['w', hwnd]]).ax;                                 // GetWindowTask
  const pc = task && this.procs && [...this.procs.values()].find(c => c.tdb === task && c.main && c.main.state !== 'done');
  if (!pc) return fn();
  return this.asThread(pc.main, fn);   // (on a stack of the call's own: the task's holds its frames where it stopped)
};
/** fn run as thread t (null: as the main thread) */
P.asThread = function (t, fn) {
  if (!t || this.thread16 || t.state === 'done') return fn();
  // (as the thread's task, on a stack of the call's own: a Win16 task's stack in its DGROUP holds its own frames,
  // where it stopped)
  this.thread16 = t; this.asTask = true; this.imgUse(t.pc);
  try { return fn(); } finally { this.thread16 = null; this.asTask = false; this.imgUse(null); }
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
    // (modal: owned, its owner disabled, as DialogBox and MessageBox leave it)
    const owner = u(262, [['w', h], ['w', 4]]);
    list.push({ hwnd: h, x, y, w, h: hh, title, cls, owner, modal: !!owner && !u(35, [['w', owner]]), iconic: !!u(31, [['w', h]]), task: u(224, [['w', h]]), ex: this.user16(135, [['w', h], ['w', 0xffec]]).dxax });   // GW_OWNER, IsIconic, GetWindowTask, GWL_EXSTYLE
  }
  // the active window: the foreground window when it is one of these (another started process's window is not the
  // active window of the task calling here), else the calling task's
  const fg = u(608);                                                                                                  // GetForegroundWindow
  return { list, active: list.some(w => w.hwnd === fg) ? fg : u(60), capture: u(236) };                              // GetActiveWindow, GetCapture
};
/** a native window's screen rectangle (null: no such window) */
P.windowRect = function (h) {
  if (!this.wbufLin) this.nativeWindows();
  const u = (o, args) => this.user16(o, args).ax;
  if (!h || !u(47, [['w', h]])) return null;                                                                       // IsWindow
  const a = this.wbufLin; u(32, [['w', h], ['l', u32(this.wbufSel << 16)]]);                                       // GetWindowRect
  const s16 = o => (this.r16(a + o) << 16) >> 16, x = s16(0), y = s16(2);
  return { x, y, w: s16(4) - x, h: s16(6) - y };
};
/** where a person's button press at a screen point goes, for a shared session's input (worker.js strokes): the
 *  top-level window there (a child's topmost non-child ancestor), the root of its owner chain (the session's object:
 *  a program's main window), and, for a popup of the object's (a menu, a dialog), its class and title, by which the
 *  other machines find their own copy of that popup; the press and the rest of the stroke are kept as offsets
 *  from the top-level window's rectangle, which is the same on every machine */
P.strokeTarget = function (sx, sy) {
  const u = (o, args) => this.user16(o, args).ax;
  let h = u(30, [['l', u32((sy << 16) | (sx & 0xffff))]]);                                                          // WindowFromPoint
  if (!h) return null;
  // (a press on a window's caption, its buttons, its borders or its system menu moves, sizes, shows or closes it:
  // the window's place and state are the session's by the object sync, so the press itself is not)
  // (asked as the window's own task, as its program's calls run: a message sent into a Win32 program's window from
  // the system's context goes through its thunks on the wrong thread)
  const ht = this.asWindowTask(h, () => this.user16(111, [['w', h], ['w', 0x84], ['w', 0], ['l', u32((sy << 16) | (sx & 0xffff))]]).ax);   // SendMessage WM_NCHITTEST
  if (ht === 2 || ht === 3 || ht === 8 || ht === 9 || (ht >= 10 && ht <= 17) || ht === 20 || ht === 21 || ht === 0xffff) return null;   // HTCAPTION, HTSYSMENU, HTMINBUTTON, HTMAXBUTTON, HTLEFT..HTBOTTOMRIGHT, HTCLOSE, HTHELP, HTERROR
  for (let n = 0; n < 32; n++) {
    if (!(this.user16(135, [['w', h], ['w', 0xfff0]]).dxax & 0x40000000)) break;                                   // GWL_STYLE: WS_CHILD
    const par = u(46, [['w', h]]); if (!par) break; h = par;                                                        // GetParent
  }
  let root = h;
  for (let n = 0; n < 32; n++) { const o = u(262, [['w', root], ['w', 4]]); if (!o) break; root = o; }             // GW_OWNER
  const r = this.windowRect(h); if (!r) return null;
  let pop = null;
  if (h !== root) {
    const a = this.wbufLin, cl = u(58, [['w', h], ['l', u32(this.wbufSel << 16) + 0x180], ['w', 64]]);             // GetClassName
    const tl = this.user16(107, [['w', h], ['w', 0x0d], ['w', 160], ['l', u32(this.wbufSel << 16) + 16]]).ax;        // DefWindowProc WM_GETTEXT
    pop = { cls: cl ? this.readA(a + 0x180, cl) : '', title: tl ? this.readA(a + 16, tl) : '' };
  }
  return { hwnd: h, root, x: r.x, y: r.y, pop };
};
/** this machine's copy of another machine's popup of an object: the visible window whose owner chain ends at the
 *  object's window, of that class and title (the topmost of several); null while there is none yet */
P.findPopup = function (root, pop) {
  const u = (o, args) => this.user16(o, args).ax;
  for (const w of this.nativeWindows().list) {
    if (w.hwnd === root || w.cls !== pop.cls || w.title !== pop.title) continue;
    let o = w.hwnd; for (let n = 0; o && n < 32; n++) { const p = u(262, [['w', o], ['w', 4]]); if (!p) break; o = p; }
    if (o === root) return w.hwnd;
  }
  return null;
};
/** the visible descendants of a native window, front to back as USER links them: rectangle, class, text, control id,
 *  style and enabled state. Edits and combo boxes are asked for their text (WM_GETTEXT); buttons for their check
 *  state (BM_GETCHECK) */
P.nativeChildren = function (parent, send = true) {
  if (!this.wbufLin) this.nativeWindows();
  const a = this.wbufLin, buf = u32(this.wbufSel << 16), u = (o, args) => this.user16(o, args).ax, s16 = o => (this.r16(a + o) << 16) >> 16;
  const pl = u(58, [['w', parent], ['l', buf + 0x180], ['w', 64]]);
  if (pl && this.readA(a + 0x180, pl) === '#32768') return this.menuItems(parent);   // a popup menu's window: its items, which are no windows
  const out = [], focus = u(23);   // GetFocus
  // (what only a message tells, an edit's text, a button's check, a tab's or list's items, is asked only while no
  // thread waits on a reply to a SendMessage of its own: one sent from here then went into that thread's chain of
  // sends, and it waited for good. Then the control is `unknown`: its window text only, no check, no items)
  // (send false: nothing asked, the caller asks from a thread of its own: worker.js 'world')
  const ask = send && !this.replyAwaited();
  const walk = (p, depth) => {
    for (let h = u(262, [['w', p], ['w', 5]]), n = 0; h && n < 512; h = u(262, [['w', h], ['w', 2]]), n++) {
      if (!u(49, [['w', h]])) continue;
      u(32, [['w', h], ['l', buf]]);
      const x = s16(0), y = s16(2), w = s16(4) - x, hh = s16(6) - y;
      const cl = u(58, [['w', h], ['l', buf + 0x180], ['w', 64]]), cls = cl ? this.readA(a + 0x180, cl) : '';
      const style = this.user16(135, [['w', h], ['w', 0xfff0]]).dxax;                                            // GetWindowLong(GWL_STYLE)
      let text = '';
      if (/^(edit|combobox|richedit)$/i.test(cls) && ask) {   // SendMessage WM_GETTEXT, into a buffer the size of an edit's limit (WordPad's RICHEDIT too)
        if (!this.tbufLin) { this.tbufLin = this.alloc(0x10000); this.tbufSel = this.allocSels(this.tbufLin, 0x10000); }
        const tl = u(111, [['w', h], ['w', 0x0d], ['w', 0xffff], ['l', u32(this.tbufSel << 16)]]); text = tl ? this.readA(this.tbufLin, tl) : '';
      } else { const tl = u(107, [['w', h], ['w', 0x0d], ['w', 160], ['l', buf + 16]]); text = tl ? this.readA(a + 16, tl) : ''; }
      const c = { hwnd: h, parent: p, x, y, w, h: hh, cls, text, id: u(277, [['w', h]]), style, enabled: !!u(35, [['w', h]]), focused: h === focus, depth, ...(ask ? {} : { unknown: true }) };
      if (/^button$/i.test(cls) && [2, 3, 4, 5, 6, 9].includes(style & 0x0f)) c.checked = ask ? u(111, [['w', h], ['w', 0x400], ['w', 0], ['l', 0]]) : undefined;
      if (ask && /^SysTabControl32$/i.test(cls)) c.items = this.tabItems(h, x, y);
      if (ask && /^SysListView32$/i.test(cls)) c.items = this.listItems(h, x, y);
      out.push(c); walk(h, depth + 1);
    }
  };
  walk(parent, 0);
  return out;
};
/** whether a thread waits on the reply to a SendMessage of its own: its queue's wake mask (4Ch) asks for QS_SMRESULT */
P.replyAwaited = function () {
  for (const t of (this.threadsById || new Map()).values()) {
    if (!t.queue || !t.state || t.state === 'done' || !this.selValid(t.queue)) continue;
    if (this.r16(this.selBase(t.queue) + 0x4c) & 0x8000) return true;
  }
  return false;
};
/** the OS's objects a shared session keeps the same on every machine (win95.js): each program's top-level windows
 *  (not the shell's, not owned popups) with their program and command line, place, size and shown state, and the
 *  contents of their edits, combo boxes and check boxes and radio buttons */
// (the shell's and the system's own, and Setup's first-run programs, which each machine runs, or has run, itself)
// (Explorer's folder windows are the session's too: `folder`, opened elsewhere as the shell opens one)
const FOLDER_CLS = /^(CabinetWClass|ExploreWClass)$/;
P.osWorld = function () {
  const u = (o, args) => this.user16(o, args).ax, procs = [...(this.procs || new Map()).values()];
  const out = [], list = this.nativeWindows().list, shown = new Set(list.map(w => w.hwnd));
  for (const w of list) {
    // (an owned window is its owner's popup, unless the owner is not shown: RUNDLL32's property sheets, Display
    // Properties among them, are owned by its hidden window)
    if ((w.owner && shown.has(w.owner)) || !w.title) continue;
    // (a Win32 program's process; a Windows 3.x program's task: Solitaire)
    const k = w.task && !procs.some(c => c.tdb === w.task) && [...(this.threadsById || new Map()).values()].find(t => t.tdb === w.task && t.task && t.task.cmdLine && t.state !== 'done');
    const pc = w.task && (procs.find(c => c.tdb === w.task) || (k && { pid: 0x10000 + w.task, ...k.task })); if (!pc) continue;
    const base = String(pc.path || '').split('\\').pop().toUpperCase(), folder = FOLDER_CLS.test(w.cls);
    if (!folder && self.W95OSClass.program(base) !== 'shared') continue;   // (the machine's own programs, and Setup's: osclass.js)
    // (its controls whose contents only a message tells: listed here, asked by the caller from a thread of its own,
    // each [key, control, 'text' or 'check'])
    const ask = [];
    for (const c of this.nativeChildren(w.hwnd, false)) {
      if (c.depth || !c.id) continue;
      if (/^(edit|combobox)$/i.test(c.cls)) ask.push([`${c.id}:${c.cls.toLowerCase()}`, c.hwnd, 'text']);
      else if (/^button$/i.test(c.cls) && [2, 3, 4, 5, 6, 9].includes(c.style & 0x0f)) ask.push([`${c.id}:button`, c.hwnd, 'check']);
    }
    out.push({ hwnd: w.hwnd, pid: pc.pid, path: pc.path, cmd: pc.cmdLine !== undefined ? pc.cmdLine : pc.cmdPtr ? this.readA(pc.cmdPtr) : '', t0: pc.t0 || null, cls: w.cls, title: w.title, folder,
      x: w.x, y: w.y, w: w.w, h: w.h, min: w.iconic, max: !!u(272, [['w', w.hwnd]]), ask });   // IsZoomed
  }
  // (and the windows closed here under a remote cause, another machine's person having closed them there, worker.js
  // 'end' and 'close': the page sends no close of its own for one of these, oslogic.js read. Each is kept until it has
  // been gone for two reads: the page reads a window's going after it went)
  const rc = this.remoteClosed || (this.remoteClosed = new Map()), closed = [];
  for (const [h, rec] of rc) { if (shown.has(h) && rec.gone) { rc.delete(h); continue; } closed.push(h); if (!shown.has(h) && ++rec.gone > 2) rc.delete(h); }   // (a handle shown again after it went is a new window's)
  return { list: out, area: this.workArea(), closed };   // (and the work area they are placed in, which each machine's own screen sets)
};
/** a window this machine closes because another machine's person closed it there (cause 'remote'): remembered for
 *  osWorld, and the effects log */
P.remoteClose = function (hwnd) {
  (this.remoteClosed || (this.remoteClosed = new Map())).set(hwnd, { gone: 0 });
  const by = this.thread16; this.thread16 = { id: 0, remote: true };
  try { this.effect('close', `hwnd ${hwnd}`); } finally { this.thread16 = by; }
};
// ---- a shared session's intents: a setting this machine's person makes, as the call that makes it, which every other
// machine makes too (worker.js 'intent'), each its own Windows then writing its own registry and INI files and telling
// its own programs. Only a setting kept (SPIF_UPDATEINIFILE) is one; a thread applying another machine's (remote) makes
// none. this.onIntent: the machine's (worker.js), given { key, kind, ... }; the key is the setting, the last one wins
// (SystemParametersInfo's settings, by action: osclass.js SPI)
/** what a call now comes of (its cause): 'remote', another machine's person (a thread applying their change, or a
 *  program started for them that this machine's person has not acted on since); 'input', this machine's person (once
 *  they have pressed a key or a button: personActed, worker.js); 'boot', Windows' own start before that; 'host', no
 *  thread (the host's own: the display's mode for its page) */
P.causeOf = function () {
  const t = this.thread16;
  if (!t) return 'host';
  if (t.remote) return 'remote';
  const rec = t.pc || t.task, id = t.pc ? t.pc.pid : t.tdb;
  if (rec && rec.origin === 'remote' && this.personOn !== id) return 'remote';
  return this.personActed ? 'input' : 'boot';
};
/** this machine's person's input, as it goes in: the program it goes to (the window under a button pressed, the active
 *  window's for a key), which is theirs to act on from then (causeOf) */
P.personInput = function (flags, x, y) {
  const u = (o, a) => this.user16(o, a).ax;
  let h;
  if (flags === undefined) h = u(60, []);                                                   // GetActiveWindow
  else if (flags & 0x8000) {                                                                 // (a button, at an absolute place)
    const sx = Math.floor(x * u(179, [['w', 0]]) / 65536), sy = Math.floor(y * u(179, [['w', 1]]) / 65536);
    h = u(30, [['l', u32((sy << 16) | (sx & 0xffff))]]);                                     // WindowFromPoint
  } else return;
  const task = h && u(224, [['w', h]]), pc = task && [...(this.procs || new Map()).values()].find(c => c.tdb === task);
  this.personOn = pc ? pc.pid : task || null;
};
/** what the machine did, with its cause, for a session's convolutions to be found by (cmd 'effects'): a program
 *  started, an intent made or passed over, a call osclass.js classes (once a process) */
P.effect = function (kind, what) {
  const t = this.thread16, pid = t ? (t.pc ? t.pc.pid : t.tdb) : 0;
  if (kind !== 'exec' && kind !== 'intent' && kind !== 'echo') {
    const seen = this.effectSeen || (this.effectSeen = new Set()), k = `${pid}|${what}`;
    if (seen.has(k)) return; seen.add(k);
  }
  const l = this.effects || (this.effects = []);
  l.push({ t: Date.now(), kind, what, cause: this.causeOf(), pid }); if (l.length > 500) l.shift();
};
/** whether a call now makes no intent: one that is not this machine's person's (causeOf) */
P.intentQuiet = function () { return !this.onIntent || this.causeOf() !== 'input'; };
/** USER's SystemParametersInfo (#483) watched where another module enters it (win32.js dispatch), once USER is up */
// ---- a program's clock: one started here for a shared session reads the clock of the machine that started it, as of
// its start there (its t0: { tick, wall }), so what it makes of the time (a seed: Solitaire's deal, srand(time())) is
// what it made there. The offsets go on the process (Win32) or the task (Win16) as it starts (startClock); the reads a
// program makes take them (win32.js clockOf): KERNEL32's GetTickCount, QueryPerformanceCounter, GetLocalTime,
// GetSystemTime(AsFileTime), MS-DOS's date and time (INT 21h 2Ah, 2Ch), and USER's GetTickCount and GetCurrentTime,
// answered where another module enters them (hookClock). USER's own time (message times, timers) stays the machine's
/** the start of a program: its t0 and its clock's offsets, from the machine that started it for the session
 *  (this.nextClock, worker.js 'run'), else this machine's own (no offsets) */
P.startClock = function () {
  const c = this.nextClock; this.nextClock = null;
  const tick = u32(this.now() - this.t0 + 3600000), wall = Date.now() + (this.wallSkew || 0);   // (the session's wall clock, win32.js progTime)
  return c ? { t0: c, clock: { tick: (c.tick - tick) | 0, wall: c.wall - wall } } : { t0: { tick, wall }, clock: null };
};
P.hookClock = function (user) {
  for (const ord of [13, 15]) {   // GetTickCount, GetCurrentTime
    const at = this.neExport(user, ord); if (!at) continue;
    (this.entryHooks || (this.entryHooks = new Map())).set(u32(this.selBase(at >>> 16) + (at & 0xffff)), P.clockCall);
  }
};
P.clockCall = function () {
  // (a program on this machine's own clock, outside a shared session: USER answers)
  const t = this.thread16, rec = t && (t.pc || t.task);
  if (!rec || !rec.t0 || (!this.sessionClock && !this.clockOf().tick)) return undefined;
  const v = u32(this.progTime('tick'));
  this.ax(v & 0xffff); this.cpu.edx.value = lo16(this.cpu.edx.value, v >>> 16);
  return this.retf16(0);
};
// TAPI32's lineInitialize, answered here as it is entered: no line devices (this machine has no modem; the no-modem
// path is each program's own, HyperTerminal's "You need to install a modem"). Its own code thunks to the 16-bit
// TAPI.DLL, which starts TAPIEXE.EXE and waits for it to initialize: the first call of a session came back
// LINEERR_OPERATIONFAILED ("general TAPI error"), later ones with no devices. The app handle is a handle of this
// process's; lineShutdown takes it back; lineNegotiateAPIVersion and lineGetDevCaps answer LINEERR_BADDEVICEID
P.hookTapi = function (m) {
  const x = m && m.exports; if (!x || !x.get('lineInitialize')) return;
  const ans = (nargs, fn) => function () {
    const sp = u32(this.cpu.esp.value), ret = this.r32(sp), args = []; for (let i = 1; i <= nargs; i++) args.push(this.r32(sp + 4 * i));
    this.cpu.eax.value = u32(fn.call(this, ...args)); this.cpu.esp.value = sp + 4 + 4 * nargs; return u32(ret);
  };
  const hook = (name, nargs, fn) => { const at = x.get(name); if (at) (this.entryHooks || (this.entryHooks = new Map())).set(u32(at), ans(nargs, fn)); };
  hook('lineInitialize', 5, function (ph, hInst, cb, name, pn) { if (ph) this.w32(ph, this.newHandle({ kind: 'lineapp', hInst, cb })); if (pn) this.w32(pn, 0); return 0; });
  hook('lineShutdown', 1, function (h) { const o = this.obj(h); if (!o || o.kind !== 'lineapp') return 0x80000015; this.handles.delete(h); return 0; });   // (LINEERR_INVALAPPHANDLE)
  hook('lineNegotiateAPIVersion', 6, () => 0x80000002);
  hook('lineGetDevCaps', 4, () => 0x80000002);
};
// an exclusive device (osclass.js exclusive-device: the wave and MIDI devices, MCI) is one machine's: a program
// started here because another machine's person started it there (origin remote, causeOf) cannot open one, and is
// answered MMSYSERR_ALLOCATED (4) at the export's entry, as it is answered when another program holds the device.
// WINMM's 32-bit exports (stdcall: the arguments popped) and MMSYSTEM's 16-bit ones (Pascal: their bytes popped)
P.hookExclusive = function (m) {
  const hooks = this.entryHooks || (this.entryHooks = new Map());
  const remote = () => P.intentQuiet.call(this) && this.causeOf() === 'remote';
  if (m.name === 'WINMM' && m.exports) {
    for (const [nm, nargs] of [['waveOutOpen', 6], ['waveInOpen', 6], ['midiOutOpen', 5], ['midiInOpen', 5], ['mciSendCommandA', 4], ['mciSendStringA', 4]]) {
      const at = m.exports.get(nm); if (!at) continue;
      hooks.set(u32(at), function () {
        if (!remote()) return undefined;
        this.effect('exclusive-device', `WINMM!${nm} refused`);
        const sp = u32(this.cpu.esp.value), ret = this.r32(sp); this.cpu.eax.value = 4; this.cpu.esp.value = sp + 4 + 4 * nargs; return u32(ret);
      });
    }
  }
  if (m.name === 'MMSYSTEM' && m.meta) {
    for (const [nm, bytes] of [['WAVEOUTOPEN', 22], ['WAVEINOPEN', 22], ['MIDIOUTOPEN', 18], ['MIDIINOPEN', 18], ['MCISENDCOMMAND', 12], ['MCISENDSTRING', 12]]) {
      const a = this.neExport(m, nm); if (!a || !this.selValid(a >>> 16)) continue;
      hooks.set(u32(this.selBase(a >>> 16) + (a & 0xffff)), function () {
        if (!remote()) return undefined;
        this.effect('exclusive-device', `MMSYSTEM!${nm} refused`);
        this.ax(4); this.cpu.edx.value = lo16(this.cpu.edx.value, 0); return this.retf16(bytes);
      });
    }
  }
};
P.hookIntents = function (user) {
  const hooks = this.entryHooks || (this.entryHooks = new Map());
  const wasLoad = this.onModuleLoad; this.onModuleLoad = (name, m) => { if (wasLoad) wasLoad.call(this, name, m); if (name === 'TAPI32') this.hookTapi(m); if (name === 'WINMM' || name === 'MMSYSTEM') this.hookExclusive(m); if (name === 'USER32') this.hookTaken32(m); };
  for (const n of ['WINMM', 'MMSYSTEM']) { const m = this.byName && this.byName.get(n); if (m) this.hookExclusive(m); }   // (one loaded already)
  for (const [ord, fn] of [[483, P.spiIntent], [181, P.colorsIntent]]) {   // SystemParametersInfo, SetSysColors
    const at = this.neExport(user, ord); if (at) hooks.set(u32(this.selBase(at >>> 16) + (at & 0xffff)), fn);
  }
  // (USER32's SystemParametersInfoA, for the settings a structure carries: where it is entered, once it is loaded)
  const hook32 = m => { const at = m && m.exports && m.exports.get('SystemParametersInfoA'); if (at) hooks.set(u32(at), P.spiStructIntent); };
  hook32(this.byName && this.byName.get('USER32'));
  const was = this.onDllLoad; this.onDllLoad = (name, m) => { if (was) was.call(this, name, m); if (name === 'USER32') hook32(m); };
};
/** USER32's SystemParametersInfoA(uiAction, uiParam, pvParam, fWinIni) as it is entered (stdcall: its arguments after
 *  the return address), for a setting a structure carries (osclass.js spiStruct): the structure's bytes with it */
P.spiStructIntent = function () {
  if (!this.onIntent) return;
  const sp = u32(this.cpu.esp.value), action = this.r32(sp + 4), ui = this.r32(sp + 8), pv = this.r32(sp + 12), flags = this.r32(sp + 16);
  if (!self.W95OSClass.spiStruct(action) || !(flags & 1) || !pv) return;
  const key = `spi:${action}`;
  if (P.intentQuiet.call(this)) { if (this.causeOf() === 'remote') this.effect('echo', key); return; }
  const n = Math.min(action === 34 ? ui : this.r32(pv), 1024); if (!n) return;
  this.effect('intent', key);
  this.onIntent({ key, kind: 'spi', action, ui, flags, bytes: Array.from(this.u8.subarray(pv, pv + n)) });
};
/** USER's SetSysColors(nChanges, lpSysColor, lpColorValues) as it is entered (Pascal: the last argument nearest): each
 *  colour an intent of its own (the last for each element wins) */
P.colorsIntent = function () {
  if (!this.onIntent) return;
  const s = this.selBase(this.cpu.ss.value & 0xffff) + (this.cpu.esp.value & 0xffff);
  const rgb = this.r32(s + 4), idx = this.r32(s + 8), n = this.r16(s + 12);
  if (!n || n > 64 || !this.selValid(rgb >>> 16) || !this.selValid(idx >>> 16)) return;
  const quiet = P.intentQuiet.call(this), remote = quiet && this.causeOf() === 'remote';
  for (let k = 0; k < n; k++) {
    const index = this.r16(this.lin(idx) + 2 * k), color = this.r32(this.lin(rgb) + 4 * k) >>> 0, key = `color:${index}`;
    if (quiet) { if (remote) this.effect('echo', key); continue; }
    this.effect('intent', key); this.onIntent({ key, kind: 'color', index, rgb: color });
  }
};
/** a registry value written by a program, as an intent if it is one osclass.js REG names (none other is shared) */
P.regIntent = function (path, name, value) {
  if (!this.onIntent || self.W95OSClass.reg(path, name) !== 'shared') return;
  const key = `reg:${path}:${String(name).toLowerCase()}`;
  if (P.intentQuiet.call(this)) { if (this.causeOf() === 'remote') this.effect('echo', key); return; }
  this.effect('intent', key);
  this.onIntent({ key, kind: 'reg', path, name, type: value.type, data: Array.from(value.data || []) });
};
/** SystemParametersInfo(uiAction, uiParam, pvParam, fWinIni) as it is entered: its words on the stack after the far
 *  return address (Pascal order: fWinIni first) */
P.spiIntent = function () {
  if (!this.onIntent) return;
  const s = this.selBase(this.cpu.ss.value & 0xffff) + (this.cpu.esp.value & 0xffff);
  const flags = this.r16(s + 4), pv = this.r32(s + 6), ui = this.r16(s + 10), action = this.r16(s + 12), kind = self.W95OSClass.spi(action);
  if (!kind || !(flags & 1)) return;
  if (P.intentQuiet.call(this)) { if (this.causeOf() === 'remote') this.effect('echo', `spi:${action}`); return; }   // (another machine's, made here: not sent back)
  this.effect('intent', `spi:${action}`);
  const i = { key: `spi:${action}`, kind: 'spi', action, ui, flags };
  const lin = pv >>> 16 && this.selValid(pv >>> 16) ? this.lin(pv) : 0;
  if (kind === 'str') i.str = lin ? this.readA(lin) : null;
  if (kind === 'mouse') i.ints = lin ? [0, 2, 4].map(o => (this.r16(lin + o) << 16) >> 16) : null;
  this.onIntent(i);
};
/** a far call's caller, for a stand-in: the module its return address is in */
P.caller16 = function () { const s = this.selBase(this.cpu.ss.value & 0xffff) + (this.cpu.esp.value & 0xffff); return this.neByHandle(this.r16(s + 2)); };
/** a write to WIN.INI or SYSTEM.INI, the system's settings files, as an intent; not USER's own, which a setting it
 *  keeps writes (that setting is the intent) */
P.iniIntent = function (file, app, key, value, by) {
  if (!this.onIntent || (by && /^(USER|GDI)$/.test(by.name))) return;
  const f = String(file || 'WIN.INI').split('\\').pop().toUpperCase();
  if (self.W95OSClass.ini(f) !== 'shared' || !app) return;
  const k = `ini:${f}:${String(app).toLowerCase()}:${String(key || '').toLowerCase()}`;
  if (P.intentQuiet.call(this)) { if (this.causeOf() === 'remote') this.effect('echo', k); return; }
  this.effect('intent', k);
  this.onIntent({ key: `ini:${f}:${String(app).toLowerCase()}:${String(key || '').toLowerCase()}`, kind: 'ini', file: f, app, name: key, value });
};
/** the desktop's work area, the screen less the taskbar: USER's SystemParametersInfo(SPI_GETWORKAREA), as x, y, w, h */
P.workArea = function () {
  if (!this.wbufLin) this.nativeWindows();
  const a = this.wbufLin + 0x1c0, s16 = o => (this.r16(a + o) << 16) >> 16;
  this.user16(483, [['w', 0x30], ['w', 0], ['l', u32((this.wbufSel << 16) + 0x1c0)], ['w', 0]]);
  return { x: s16(0), y: s16(2), w: s16(4) - s16(0), h: s16(6) - s16(2) };
};
/** a popup menu's items (the Start menu, a context menu, a menu bar's dropped menu: USER's #32768 window), each its
 *  text, its state and its rectangle on screen: the menu handle from the window (MN_GETHMENU), the items by position
 *  (GetMenuItemCount, GetMenuString, GetMenuState), the rectangles from USER32's GetMenuItemRect, or laid out at the
 *  menu's item height when that is not there */
P.menuItems = function (h) {
  const a = this.wbufLin, buf = u32(this.wbufSel << 16), u = (o, args) => this.user16(o, args).ax, s16 = o => (this.r16(a + o) << 16) >> 16;
  const x32 = this.byName && this.byName.get('USER32'), rectFn = x32 && x32.exports && x32.exports.get('GetMenuItemRect'), infoFn = x32 && x32.exports && x32.exports.get('GetMenuItemInfoA');
  u(32, [['w', h], ['l', buf]]); const wx = s16(0), wy = s16(2), ww = s16(4) - wx, wh = s16(6) - wy;   // GetWindowRect
  const rc = a + 0x100;
  // an item's rectangle on screen, as USER32 places it for the menu shown in this window; null for a menu it does not show there
  const rect = (hm, i) => {
    if (!rectFn) return null;
    this.u8.fill(0, rc, rc + 16); if (!this.call(rectFn, [h, hm, i, rc])) return null;
    const l = this.r32(rc) | 0, t = this.r32(rc + 4) | 0, r = { x: l, y: t, w: (this.r32(rc + 8) | 0) - l, h: (this.r32(rc + 12) | 0) - t };
    return r.w > 0 && r.h > 0 && l >= wx && t >= wy && l < wx + ww && t < wy + wh ? r : null;
  };
  // the menu: what the window answers (MN_GETHMENU), else, as this USER does not answer it, the popup menu whose items
  // USER32 places in this window, all of them, the last ending at the window's foot (the handles are few: a scan of the
  // range is quick). A window's menu bar is never asked: GetMenuItemRect with a popup's window lays the bar out at that
  // window's width, and USER keeps that layout and draws the bar wrapped (its items in rows over the window). A popup
  // window shows one menu after another, so the one found before is asked again as any other
  let hm = this.user16(111, [['w', h], ['w', 0x1e1], ['w', 0], ['l', 0]]).ax;
  if (!hm && rectFn) {
    const bars = new Set();
    for (let w = u(262, [['w', u(286, [])], ['w', 5]]), k = 0; w && k < 512; w = u(262, [['w', w], ['w', 2]]), k++) { const m = u(157, [['w', w]]); if (m) bars.add(m); }   // GetDesktopWindow, GW_CHILD, GW_HWNDNEXT; GetMenu
    // (how far the menu is from filling the window: its last item at the window's foot, inside the border, else not
    // shown here; then how much narrower than the window its items are, as Explorer's Start menu's banner takes some)
    const fit = (m, n) => { const f = rect(m, 0), l = n > 1 ? rect(m, n - 1) : f; return f && l && Math.abs(wy + wh - (l.y + l.h)) <= 4 ? Math.abs(ww - f.w) : -1; };
    let best = -1;
    for (let m = 4; m < 0x8000; m += 4) {
      if (bars.has(m) || !u(358, [['w', m]])) continue;   // (IsMenu)
      const n = u(263, [['w', m]]), d = n ? fit(m, n) : -1;
      if (d >= 0 && (best < 0 || d < best)) { hm = m; best = d; }
    }
  }
  if (!hm) return [];
  const n = Math.min(u(263, [['w', hm]]), 64), out = [];   // GetMenuItemCount
  let y = wy + 3;
  for (let i = 0; i < n; i++) {
    const fl = u(250, [['w', hm], ['w', i], ['w', 0x400]]);   // GetMenuState, MF_BYPOSITION
    const tl = u(161, [['w', hm], ['w', i], ['l', buf + 16], ['w', 128], ['w', 0x400]]); let text = tl ? this.readA(a + 16, tl) : '';   // GetMenuString (none for an owner-drawn item: Explorer's Start menu draws its own)
    const separator = !!(fl & 0x800);
    // an owner-drawn item (its type, MIIM_TYPE: GetMenuState gives a submenu's item count in its high byte, over the
    // flag) has no string; Explorer's Start menu items keep theirs in their data (MIIM_DATA), a pointer 16 bytes in
    let data = 0, owner = false;
    if (infoFn) {
      const mi = a + 0x180; this.u8.fill(0, mi, mi + 44); this.w32(mi, 44); this.w32(mi + 4, 0x30);
      if (this.call(infoFn, [hm, i, 1, mi])) { owner = !!(this.r32(mi + 8) & 0x100); data = owner ? this.r32(mi + 32) >>> 0 : 0; }
    }
    if (owner && !text && data) text = this.menuDataText(data);
    const r = rect(hm, i) || { x: wx + 3, y, w: ww - 6, h: separator ? 9 : 19 };
    y = r.y + r.h;
    out.push({ hwnd: h, parent: h, cls: 'menuitem', text, ...r, id: i, style: fl, enabled: !(fl & 3), checked: !!(fl & 8), submenu: !!(fl & 0x10), separator, ownerdraw: owner || !!(fl & 0x100), data, focused: false, depth: 0 });
  }
  return out;
};
/** an owner-drawn Start menu item's text, from its data (SHELL32's file menu item): the string it points to 16 bytes
 *  in (Programs, Run...), else the name in the ID list it points to 12 bytes in (a folder or a shortcut of the Programs
 *  folder: its file system item, type 30h-3Fh, the long name at 14), shown as the shell shows it, a shortcut's
 *  extension hidden; '' when there is none */
P.menuDataText = function (data) {
  const ok = p => p > 0x10000 && p < this.u8.length - 256;
  if (!ok(data)) return '';
  const p = this.r32(data + 16) >>> 0; if (ok(p)) { const s = this.readA(p, 128); if (s) return s; }
  const id = this.r32(data + 12) >>> 0; if (!ok(id) || this.r16(id) < 16 || (this.u8[id + 2] & 0xf0) !== 0x30) return '';
  return this.readA(id + 14, 128).replace(/\.(lnk|pif|url)$/i, '');
};
/** a list view's items (COMCTL32's, in a 32-bit program: the desktop's icons, a folder window's files), each its
 *  bounds on screen (the control at x, y), its label and whether it is selected, from the control's own messages
 *  with flat buffers (as tabItems) */
P.listItems = function (h, x, y) {
  const a = this.wbufLin, send = (m, wp, lp) => this.user16(111, [['w', h], ['w', m], ['w', wp], ['l', lp]]).dxax | 0;
  const n = Math.min(send(0x1004, 0, 0), 256), out = [];   // LVM_GETITEMCOUNT
  const rc = a + 0x100, it = a + 0x110, txt = a + 0x140;
  for (let i = 0; i < n; i++) {
    this.w32(rc, 0);   // LVIR_BOUNDS
    if (!send(0x100e, i, rc)) continue;   // LVM_GETITEMRECT
    const s32 = o => this.r32(rc + o) | 0, l = s32(0), t = s32(4);
    this.u8.fill(0, it, it + 36); this.w32(it, 1); this.w32(it + 4, i); this.w32(it + 20, txt); this.w32(it + 24, 64); this.u8[txt] = 0;   // LVIF_TEXT, pszText, cchTextMax
    const len = send(0x102d, i, it);   // LVM_GETITEMTEXTA
    const text = len > 0 ? this.readA(txt, Math.min(len, 63)) : '';
    out.push({ x: x + l, y: y + t, w: s32(8) - l, h: s32(12) - t, text, index: i, selected: !!(send(0x102c, i, 2) & 2) });   // LVM_GETITEMSTATE, LVIS_SELECTED
  }
  return out;
};
/** item `i` of list view `h` selected and focused alone (LVM_SETITEMSTATE), and opened as Enter opens it (the list's
 *  owner opens the selection: a folder window opens the folder, the file) */
P.listItem = function (h, i, open) {
  const it = this.wbufLin + 0x110, set = (n, state) => { this.u8.fill(0, it, it + 36); this.w32(it + 12, state); this.w32(it + 16, 3); this.user16(111, [['w', h], ['w', 0x102b], ['w', n & 0xffff], ['l', it]]); };
  set(-1, 0); set(i, 3);   // (every item's selection and focus off, then this one's on: LVIS_FOCUSED | LVIS_SELECTED)
  if (open) { this.user16(110, [['w', h], ['w', 0x100], ['w', 0x0d], ['l', 0x001c0001]]); this.user16(110, [['w', h], ['w', 0x101], ['w', 0x0d], ['l', 0xc01c0001]]); }   // PostMessage WM_KEYDOWN, WM_KEYUP VK_RETURN
  return true;
};
/** a tab control's tabs (COMCTL32's, in a 32-bit program: Explorer's task switcher), each its rectangle on screen (the
 *  control at x, y), its text and whether it is the selected one, from the control's own messages with flat buffers
 *  (a message past WM_USER goes to the 32-bit window with lParam as it is). A tab without text (Explorer's task
 *  buttons draw themselves) is named by the window its lParam holds */
P.tabItems = function (h, x, y) {
  const a = this.wbufLin, buf = u32(this.wbufSel << 16), send = (m, wp, lp) => this.user16(111, [['w', h], ['w', m], ['w', wp], ['l', lp]]).dxax | 0;
  const n = Math.min(send(0x1304, 0, 0), 64), sel = send(0x130b, 0, 0), out = [];   // TCM_GETITEMCOUNT, TCM_GETCURSEL
  const rc = a + 0x100, it = a + 0x110, txt = a + 0x140;
  for (let i = 0; i < n; i++) {
    if (!send(0x130a, i, rc)) continue;   // TCM_GETITEMRECT
    const s16 = o => (this.r16(rc + o) << 16) >> 16, l = s16(0), t = s16(4);
    this.u8.fill(0, it, it + 28); this.w32(it, 1 | 8); this.w32(it + 12, txt); this.w32(it + 16, 64); this.u8[txt] = 0;   // TCIF_TEXT | TCIF_PARAM
    send(0x1305, i, it);   // TCM_GETITEMA
    let text = this.readA(txt, 64);
    const wnd = this.r32(it + 24) & 0xffff;
    if (!text && wnd && this.user16(47, [['w', wnd]]).ax) {   // IsWindow: GetWindowText of the window the tab stands for
      const tl = this.user16(36, [['w', wnd], ['l', buf + 0x40], ['w', 160]]).ax; text = tl ? this.readA(a + 0x40, tl) : '';
    }
    out.push({ x: x + l, y: y + t, w: s16(8) - l, h: s16(12) - t, text, selected: i === sel });
  }
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
vxdApi(0x0037, 'ENABLE', {});   // Accessibility: the recompiled ENABLE.VXD answers when it is loaded
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
  // the monitor, which the display adapter enumerates (Enum\Monitor): a child of the adapter's devnode
  const display = out.find(d => /^display$/i.test(d.cls));
  if (display) for (const dev of W.regKids('hklm\\enum\\monitor')) for (const inst of W.regKids(`hklm\\enum\\monitor\\${dev}`)) {
    const key = `hklm\\enum\\monitor\\${dev}\\${inst}`;
    if (!W.regGet(key, 'Driver')) continue;
    const dn = { handle: 0xc1000000 + 0x100 * out.length, id: `MONITOR\\${dev}\\${inst}`.toUpperCase(), key, cls: regStr(W.regGet(key, 'Class')), driver: regStr(W.regGet(key, 'Driver')), parent: display, children: [] };
    out.push(dn); (display.children = display.children || []).push(dn);
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
  else if (f === 6) { if (this.sound16) this.sound16(true); const c = this.dmaCount ? this.dmaCount(this.cpu.ebx.value & 0xffff) : null; if (c === null) { r = 0xffff; ok = false; } else r = c; }
  else { this.trapped = `unimplemented MSSNDSYS (VxD 45Fh) API function ${f.toString(16)}h`; return LAYOUT.SENTINEL; }
  this.cpu.eax.value = lo16(this.cpu.eax.value, r); this.cpu.cf.value = ok ? 0 : 1;
  return this.retf16(0);
});
// CONFIGMG's protected-mode API: the function (its service number) in AX, its arguments where the CONFIGMG.H helpers
// leave them, on the caller's cdecl frame at SS:BP+4 (dwords; pointers 16:16); AX = the CONFIGRET. The resources a
// devnode is given are the ones its card decodes (the emulated hardware's ports, IRQ and DMA channel, P.cards)
const cmArgs = p => { const a = p.cpu.ssb.value + (p.cpu.ebp.value & 0xffff) + 4; return i => p.r32(a + 4 * i); };
/** a CONFIGMG API call made as ring-0 code makes it (vmm.js): the arguments at the indexes in far, 16:16 pointers
 *  here, flat there (a null pointer stays null) */
const cmFar = (p, n, far) => { const arg = cmArgs(p); return p.cmService(n, i => far.includes(i) ? (arg(i) ? p.lin(arg(i)) : 0) : arg(i)); };
const CR = { SUCCESS: 0, INVALID_POINTER: 3, INVALID_DEVNODE: 5, NO_SUCH_DEVNODE: 0x0d, NO_MORE_LOG_CONF: 0x0e, NO_MORE_RES_DES: 0x0f, BUFFER_SMALL: 0x1a, NO_SUCH_VALUE: 0x25, REGISTRY_ERROR: 0x1d, DLVXD_NOT_FOUND: 0x0c, FAILURE: 0x13 };
/** a devnode's registry key under HKLM (CM_REGISTRY_SOFTWARE: its driver's key; else its Enum key), with a subkey */
P.cmKey = function (dn, sub, flags) {
  const drv = dn.driver || (dn.key ? regStr(window.W95Win32.regGet(dn.key, 'Driver')) : '');   // (a devnode made since boot: as Setup has written it)
  const k = flags & 1 ? (drv ? 'System\\CurrentControlSet\\Services\\Class\\' + drv : null) : 'Enum\\' + dn.id;
  return k && (sub ? `${k}\\${sub}` : k);
};
vxdApi(0x0033, 'CONFIGMG', {
  0() { return 0x400; },   // Get_Version
  // Lock(flags), Unlock(): the tree held against changes while a caller walks it; nothing here changes it meanwhile
  0x16() { return CR.SUCCESS; }, 0x17() { return CR.SUCCESS; },
  // Create_DevNode(far *dn, far device ID, parent, flags): a devnode for a device Setup installs (Root\Printer\0000
  // for a printer), its Enum key made; 10h for an ID the tree has
  0x0b() {
    const arg = cmArgs(this), id = (this.readA(this.lin(arg(1))) || '').toUpperCase(); if (!id) return CR.INVALID_POINTER;
    const all = this.devnodes(); if (all.some(d => d.id === id)) return 0x10;   // CR_ALREADY_SUCH_DEVNODE
    const parent = this.cmNode(arg(2)) || this.cmTree();
    const key = 'hklm\\enum\\' + id.toLowerCase(), dn = { handle: 0xc1000000 + 0x100 * all.length, id, key, cls: '', driver: '', parent, children: [] };
    all.push(dn); (parent.children = parent.children || []).push(dn); window.W95Win32.regSet('hklm\\Enum\\' + id, null);
    this.w32(this.lin(arg(0)), dn.handle); return CR.SUCCESS;
  },
  // Setup_DevNode(dn, flags), Reenumerate_DevNode(dn, flags), Disable_DevNode, Enable_DevNode: a printer's devnode has
  // no driver to start or stop; its software key says what it is
  0x34() { const arg = cmArgs(this); return this.devnode(arg(0)) ? CR.SUCCESS : CR.INVALID_DEVNODE; },
  0x33() { const arg = cmArgs(this); return this.devnode(arg(0)) ? CR.SUCCESS : CR.INVALID_DEVNODE; },
  0x40() { const arg = cmArgs(this); return this.devnode(arg(0)) ? CR.SUCCESS : CR.INVALID_DEVNODE; },
  0x41() { const arg = cmArgs(this); return this.devnode(arg(0)) ? CR.SUCCESS : CR.INVALID_DEVNODE; },
  // Locate_DevNode(far *dn, far device ID or NULL for the root, flags)
  2() { const arg = cmArgs(this), id = arg(1) ? (this.readA(this.lin(arg(1))) || '').toUpperCase() : null; const dn = id ? this.devnodes().find(d => d.id === id) : this.cmTree(); if (!dn) return CR.NO_SUCH_DEVNODE; this.w32(this.lin(arg(0)), dn.handle); return CR.SUCCESS; },
  // Get_Parent, Get_Child, Get_Sibling(far *dn, dn, flags): the tree vmm.js keeps (the root, HTREE\ROOT\0, over the
  // ROOT-enumerated devnodes and those their enumerators make)
  3() { const arg = cmArgs(this), dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; if (!dn.parent) return CR.NO_SUCH_DEVNODE; this.w32(this.lin(arg(0)), dn.parent.handle); return CR.SUCCESS; },
  4() { const arg = cmArgs(this), dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; const c = (dn.children || [])[0]; if (!c) return CR.NO_SUCH_DEVNODE; this.w32(this.lin(arg(0)), c.handle); return CR.SUCCESS; },
  5() {
    const arg = cmArgs(this), dn = this.cmNode(arg(1)); if (!dn || !dn.parent) return CR.INVALID_DEVNODE;
    const sib = dn.parent.children, n = sib[sib.indexOf(dn) + 1]; if (!n) return CR.NO_SUCH_DEVNODE; this.w32(this.lin(arg(0)), n.handle); return CR.SUCCESS;
  },
  // the logical configurations and their resource descriptors, as CONFIGMG gives them to ring-0 callers (vmm.js), the
  // pointers here 16:16: Add_Empty_Log_Conf(far *lc, dn, priority, flags), Get_First_Log_Conf(far *lc, dn, flags),
  // Get_Next_Log_Conf(far *lc, lc, flags), Add_Res_Des(far *rd, lc, resource, far data, len, flags),
  // Get_Next_Res_Des(far *rd, lc or rd, resource, far *resource, flags), Get_Res_Des_Data_Size(far *len, rd, flags),
  // Get_Res_Des_Data(rd, far buf, len, flags)
  0x18() { return cmFar(this, 0x18, [0]); }, 0x1a() { return cmFar(this, 0x1a, [0]); }, 0x1b() { return cmFar(this, 0x1b, [0]); },
  0x1c() { return cmFar(this, 0x1c, [0, 3]); }, 0x1f() { return cmFar(this, 0x1f, [0, 3]); }, 0x21() { return cmFar(this, 0x21, [0]); },
  0x22() { return cmFar(this, 0x22, [1]); },
  // Get_Device_ID_Size(far *len, dn, flags), Get_Device_ID(dn, far buf, len, flags)
  6() { const arg = cmArgs(this), dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; this.w32(this.lin(arg(0)), dn.id.length); return CR.SUCCESS; },
  7() { const arg = cmArgs(this), dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; if (arg(2) <= dn.id.length) return CR.BUFFER_SMALL; this.writeA(this.lin(arg(1)), dn.id, arg(2)); return CR.SUCCESS; },
  // Get_HW_Prof_Flags(far device ID, config (0: the current one), far *flags, flags): the device's CSConfigFlags in
  // the configuration's Enum key (CSCONFIGFLAG_DISABLED 1, _REMOVED 2, _DO_NOT_CREATE 4), none when it has none
  0x4a() {
    const arg = cmArgs(this), id = arg(0) ? this.readA(this.lin(arg(0))) || '' : ''; if (!id) return CR.INVALID_POINTER;
    const cfg = String(arg(1) || 1).padStart(4, '0'), v = window.W95Win32.regGet(`hklm\\config\\${cfg}\\enum\\${id.toLowerCase()}`, 'CSConfigFlags');
    this.w32(this.lin(arg(2)), typeof v === 'number' ? v : v && v.data && v.data.length >= 4 ? new DataView(v.data.buffer, v.data.byteOffset).getUint32(0, true) : 0);
    return CR.SUCCESS;
  },
  // Get_Hardware_Profile_Info(index (FFFFFFFFh: the current one), far HWPROFILEINFO, flags): the profile's number, its
  // friendly name (80 bytes) and flags, from the profiles CONFIGMG recorded at boot (Control\IDConfigDB); past the
  // last, CR_NO_MORE_HW_PROFILES (35h)
  0x52() {
    const arg = cmArgs(this), W = window.W95Win32, idc = 'hklm\\system\\currentcontrolset\\control\\idconfigdb';
    const all = W.regVals(idc).map(([n]) => /^friendlyname(\d{4})$/.exec(n)).filter(Boolean).map(m => +m[1]).sort((x, y) => x - y);
    const cur = parseInt(regStr(W.regGet(idc, 'CurrentConfig')) || '1', 10), i = u32(arg(0));
    const n = i === 0xffffffff ? cur : all[i]; if (n === undefined || !all.includes(n)) return 0x35;
    const a = this.lin(arg(1)); this.u8.fill(0, a, a + 88);
    this.w32(a, n); this.writeA(a + 4, regStr(W.regGet(idc, 'FriendlyName' + String(n).padStart(4, '0'))), 80); this.w32(a + 84, 0);
    return CR.SUCCESS;
  },
  // Get_DevNode_Status(far *status, far *problem, dn, flags): started (DN_STARTED 8 | DN_DRIVER_LOADED 2 | DN_HAS_PROBLEM no)
  0x36() { const arg = cmArgs(this), dn = this.cmNode(arg(2)); if (!dn) return CR.INVALID_DEVNODE; this.w32(this.lin(arg(0)), 0x0a | (dn.started ? 0 : 0)); if (arg(1)) this.w32(this.lin(arg(1)), 0); return CR.SUCCESS; },
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
/** CMCONFIG for a devnode: memory windows (9: bases, lengths, attributes), I/O ports (20), IRQs (7), DMA channels (7),
 *  as Config_Buff_s lays them out */
P.cmConfig = function (dn, a) {
  const hw = this.cards && this.cards().find(c => c.devnode === dn.id);
  this.u8.fill(0, a, a + 0xd8);
  if (!hw) return CR.NO_MORE_LOG_CONF;
  const io = a + 2 + 36 + 36 + 18, irq = io + 2 + 40 + 40, dma = irq + 2 + 14, mem = hw.mem || [];
  this.w16(a, mem.length); mem.forEach(([b, n], i) => { this.w32(a + 2 + 4 * i, b); this.w32(a + 38 + 4 * i, n); });
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
  const w = (this.host && this.host.width) || ini('x_resolution', 640), h = (this.host && this.host.height) || ini('y_resolution', 480);
  // the depth as Windows records it for the current configuration (Display\Settings, which a change in Display
  // Properties rewrites before USER re-enables the driver); the display VxD's own setting without one
  const reg = parseInt(regStr(window.W95Win32.regGet('hkcc\\display\\settings', 'BitsPerPixel')), 10), bpp = reg || ini('BitsPerPixel', 8);
  return { ...this.displaySlot(w, h, bpp), bpp };
};
/** the display driver for the configured mode, as USER's loader (PNPDRVR) finds it: the display devnode's software
 *  key names one for the depth and size (MODES\<bpp>\<w>,<h>: TSENG's 16-color modes are VGA.DRV's and
 *  SUPERVGA.DRV's) or else its own (DEFAULT\drv); with no devnode, the DISPLAY module the build has */
P.displayDriverFile = function () {
  const W = window.W95Win32, dn = this.devnodes().find(d => /^display$/i.test(d.cls)), sw = this.devSoftKey(dn); if (!sw) return 'DISPLAY';
  const c = this.displayConfig();
  return (regStr(W.regGet(`${sw}\\modes\\${c.bpp}\\${c.w},${c.h}`, 'drv')) || regStr(W.regGet(sw + '\\default', 'drv')) || 'DISPLAY').toUpperCase();
};
// the display driver's own list of resolutions; a size not on it is the configured size of the adapter's custom mode
const FB_SIZES = [[320, 200], [320, 240], [512, 384], [640, 400], [640, 480], [800, 600], [1024, 768], [1280, 1024], [1600, 1200]];
// the driver's entry that stands for the custom size at a depth: its largest the depth has a mode for (TSENG.DRV's
// 24-bit modes stop at 800x600, BIOS mode 30h), the entry's index in its resolution tables and its BIOS mode
const CUSTOM_SLOTS = [{ i: 6, w: 1024, h: 768, mode: 0x38 }, { i: 5, w: 800, h: 600, mode: 0x30 }];
/** the size the display driver is told for a configured w by h at bpp bits: its own when it is one of its list;
 *  otherwise its largest entry for the depth stands for the custom size, and the driver's records for that entry are
 *  made to say w by h, so the driver enables, and GDI's desktop is, the configured size */
P.displaySlot = function (w, h, bpp = 8) {
  if (FB_SIZES.some(([x, y]) => x === w && y === h) || w > 1024 || h > 1024) { this.customMode = null; this.customRestore(); return { w, h }; }
  const slot = CUSTOM_SLOTS[bpp >= 24 ? 1 : 0];
  this.customMode = { w, h, mode: slot.mode }; this.customEntry(w, h, slot);
  return { w: slot.w, h: slot.h };
};
/** the display driver's records as it has them, back (customEntry saved them before changing any) */
P.customRestore = function () { for (const [a, bytes] of (this.customRecs && this.customRecs.saved) || []) this.u8.set(bytes, a); };
/** the offsets in [b, b + n) where the words run as given (null: any word) */
const findWords = (u8, b, n, words) => {
  const out = [];
  for (let o = b; o + 2 * words.length <= b + n; o++) if (words.every((v, i) => v === null || (u8[o + 2 * i] | u8[o + 2 * i + 1] << 8) === v)) out.push(o);
  return out;
};
/** the display driver's records for an entry (slot: its index and size, 1024x768 unless given), found by what they
 *  hold in its second segment before any is changed: the resolution tables it looks the configured size up in and
 *  sets the mode from (320x200 first), its GDIINFO for each entry (GDI 4.0, 208 by 156 mm, the entry's size), and the
 *  scan line lengths of each depth where the driver keeps them (TSENG.DRV: a flags and length pair for each entry, 8
 *  entries to a depth: 8 bits 320, 320, 512 ... 1280, then 16 bits twice those) */
P.customEntry = function (w, h, slot = CUSTOM_SLOTS[0]) {
  const m = this.ne && this.ne.get('DISPLAY'), sg = m && m.segs && m.segs.find(g => g.num === 2); if (!sg) return false;
  if (!this.customRecs) {
    const b = sg.base, n = sg.len || 0x10000;
    this.customRecs = { tables: findWords(this.u8, b, n, [320, 200, 320, 240, 512, 384, 640, 400, 640, 480, 800, 600, 1024, 768]),
      gdi: new Map(CUSTOM_SLOTS.map(s => [s.i, findWords(this.u8, b, n, [0x400, 1, 208, 156, s.w, s.h])[0]])),
      pitch: findWords(this.u8, b, n, [320, 320, 512, 640, 640, 800, 1024, 1280, 640, 640, 1024, 1280, 1280, 1600, 2048].flatMap(l => [null, l]))[0] };
    // (and the description of each depth's screen in its data segment, which the DIB engine draws by: width, height,
    // bytes a line and bits a pixel, as dwords; TSENG.DRV: 1024x768 at 8 and 16 bits, 800x600 at 8, 16 and 24)
    const r = this.customRecs;
    r.desc = new Map(CUSTOM_SLOTS.map(s => [s.i, m.segs.filter(g => g.flags & 1).flatMap(g => [1, 2, 3, 4].flatMap(px =>
      findWords(this.u8, g.base, g.len || 0, [s.w, 0, s.h, 0, s.w * px, 0, 8 * px, 0]).map(at => ({ at, px }))))]));
    // (the records as the driver has them, to put back before another entry stands for the custom size, or none does)
    const keep = (a, n) => [a, this.u8.slice(a, a + n)];
    r.saved = [...r.tables.map(t => keep(t, 4 * 8)), ...[...r.gdi.values()].filter(g => g !== undefined).map(g => keep(g, 0x58)), ...(r.pitch !== undefined ? [keep(r.pitch, 32 * 4)] : []),
      ...[...r.desc.values()].flat().map(x => keep(x.at, 12))];
  }
  const { tables, pitch } = this.customRecs, gdi = this.customRecs.gdi.get(slot.i);
  if (!tables.length || gdi === undefined) return false;   // (another display driver: nothing to do)
  this.customRestore();
  for (const t of tables) { this.w16(t + 4 * slot.i, w); this.w16(t + 4 * slot.i + 2, h); }
  // (a scan line the CRTC's offset register holds: 8-byte units. The driver keeps the cursor's 1K image just past the
  // screen, at h scan lines, and writes it through the 64K window without changing bank part way: a line long enough
  // that the image ends in the bank it starts in)
  const line = px => { let l = (w * px + 7) & ~7; while (((h * l) & 0xffff) > 0xfc00) l += 8; return l; };
  if (pitch !== undefined) for (let px = 1; px <= 4; px++) this.w16(pitch + 32 * (px - 1) + 4 * slot.i + 2, line(px));
  for (const { at, px } of this.customRecs.desc.get(slot.i) || []) { this.w32(at, w); this.w32(at + 4, h); this.w32(at + 8, line(px)); }
  const X = Math.round(w * 254 / 640), Y = Math.round(h * 127 / 480);
  for (const [o, v] of [[8, w], [0xa, h], [0x34, w], [0x36, -h], [0x3c, w], [0x3e, -h], [0x44, X], [0x46, -X], [0x4c, Y], [0x4e, -Y], [0x54, Y], [0x56, -Y]]) this.w16(gdi + o, v & 0xffff);
  return true;
};
def16('VDD', 0, '', 'jmp', function () {
  const fn = u32(this.cpu.eax.value);
  switch (fn) {
    case 0x80: this.cpu.eax.value = this.cpu.ecx.value; break;          // VDD_DRIVER_REGISTER: VRAM the visible screen uses
    case 0x83: {                                                         // the W32's MMU and accelerator at EDX (B8000h): a selector for them in EDX
      const a = this.adapter();
      if (u32(this.cpu.edx.value) === MMU) {
        if (!a.mmuSel) { this.u8.fill(0, MMU, MMU + 0x8000); a.mmuSel = this.allocSels(MMU, 0x8000); }
        this.cpu.edx.value = a.mmuSel;
      }
      this.cpu.eax.value = 0; break;
    }
    case 0x81: case 0x82: case 0x84: case 0x86: case 0x87: case 0x88: case 0x89: this.cpu.eax.value = 0; break;
    case 0x85: {                                                         // VDD_GET_DISPLAY_CONFIG -> DISPLAYINFO at ES:EDI
      // (the display's devnode and the driver its software key names, DEFAULT\drv: USER restarts Windows for a mode
      // whose driver is not the one loaded; with no devnode, the loaded driver's file)
      const a = this.lin((this.cpu.es.value << 16) | (this.cpu.edi.value & 0xffff)), n = Math.min(this.cpu.ecx.value & 0xffff, 0x4a), c = this.displayConfig();
      const dn = this.devnodes().find(d => /^display$/i.test(d.cls)), drv = this.displayDriverFile().toLowerCase();
      this.u8.fill(0, a, a + n); this.w16(a, n); this.w32(a + 4, dn ? dn.handle : 0); this.writeA(a + 8, drv, 16);
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
const ET_MODES = { 0x03: [720, 400, 0], 0x13: [320, 200, 8], 0x2e: [640, 480, 8], 0x2f: [640, 400, 8], 0x30: [800, 600, 8], 0x38: [1024, 768, 8], 0x3d: [1280, 1024, 8],
  // the 16-color planar modes: the VGA's 640x480 (12h, VGA.DRV's) and the 800x600 ones (Tseng's 29h, VESA's 6Ah)
  0x12: [640, 480, 4], 0x29: [800, 600, 4], 0x6a: [800, 600, 4] };
// the 16-color modes' attribute palette as the BIOS loads it (the EGA's colors), and the DAC's first 64 entries: the
// EGA's 64 colors, each of red, green and blue at 0, 1/3 (secondary bit), 2/3 (primary bit) or full
const EGA_ATTR = [0, 1, 2, 3, 4, 5, 0x14, 7, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f];
const egaDac = i => [(i >> 2 & 1) * 0x2a + (i >> 5 & 1) * 0x15, (i >> 1 & 1) * 0x2a + (i >> 4 & 1) * 0x15, (i & 1) * 0x2a + (i >> 3 & 1) * 0x15];
// the card as MSDISP.INF's VGA.LogConfig gives the W32 (*PNP0912) its resources: the VGA's ports 3B0h-3BBh and
// 3C0h-3DFh, its memory windows A0000h-AFFFFh and B8000h-BFFFFh (the W32's MMU there) and the video BIOS at C0000h.
// Its devnode is the one Setup made for it (win95.js setupDisplay)
P.cards = function () { return [{ devnode: 'ROOT\\*PNP0912\\0000', io: [[0x3b0, 0x0c], [0x3c0, 0x20]], irq: [], dma: [], mem: [[0xa0000, 0x10000], [0xb8000, 0x8000], [0xc0000, 0x8000]] }]; };
const VRAM_SIZE = 4 << 20, WIN = 0xa0000;   // (a W32p with 4 MB: the largest custom mode at 16 bits, with the driver's off-screen caches, fits)
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
  const a = this.adapter(); b &= (VRAM_SIZE >> 16) - 1;   // (the W32's banks reach all its memory: segment select 2 adds their high bits)
  if (b === a.bank) return;
  if (a.flat || a.planar) { a.bank = b; return; }     // VFLATD presents VRAM linearly; the window is no longer the access path (nor is it in the planar modes: each access goes through the graphics controller, vgaRead/vgaWrite)
  const u8 = this.u8; a.vram = u8.subarray(a.vramLin, a.vramLin + VRAM_SIZE);
  a.vram.set(u8.subarray(WIN, WIN + 0x10000), a.bank << 16);
  u8.set(a.vram.subarray(b << 16, (b << 16) + 0x10000), WIN);
  a.bank = b; a.dirty = true;
};
/** VRAM with the window flushed: what the CRTC scans out */
P.scanout = function () {
  const a = this.adapter();
  a.vram = this.u8.subarray(a.vramLin, a.vramLin + VRAM_SIZE);
  if (!a.flat && !a.planar) a.vram.set(this.u8.subarray(WIN, WIN + 0x10000), a.bank << 16);
  if (a.crtc[0x13]) a.pitch = (a.crtc[0x13] | ((a.crtc[0x3f] & 0x80) << 1)) * (a.planar ? 2 : 8);   // CRTC offset register: bytes per scanline / 8 (/ 2 a plane's in the planar modes)
  return a;
};
/** the W32 hardware sprite as the CRTC overlays it: on (F7h bit 7), its screen position (E0h/E1h, E4h/E5h), the
 *  preset into the 64x64 image where display starts (E2h, E6h), and the image in VRAM at the start address (E8h-EAh,
 *  in dwords) with EBh quadwords per row, 2 bits a pixel, low bit first: bit 0 XOR, bit 1 AND (screen kept). The
 *  sprite counts the CRTC's pixel clocks, as many to a screen pixel as its bytes at high color (cpp): the X position,
 *  the X preset and the image's columns are clocks there (TSENG.DRV doubles them at 16 bits) */
P.sprite = function () {
  const a = this.adapter(), r = a.ima;
  if (!(r[0xf7] & 0x80)) return null;
  const start = ((r[0xea] & 0x0f) << 16 | r[0xe9] << 8 | r[0xe8]) * 4, row = (r[0xeb] || 2) * 8;
  const vram = this.scanout().vram, cpp = a.bpp > 8 ? a.bpp >> 3 : 1;
  return { x: Math.floor((r[0xe1] << 8 | r[0xe0]) / cpp), y: r[0xe5] << 8 | r[0xe4], px: r[0xe2] & 0x3f, py: r[0xe6] & 0x3f, cpp, bits: vram.subarray(start, start + 64 * row), row };
};
// The W32's MMU and accelerator (ACL), memory-mapped at B8000h, which the Tseng driver reaches through the selector VDD
// service 83h gives it: three 8K apertures (0000h, 2000h, 4000h) onto VRAM at the base addresses in 7F00h-7F0Bh, an
// aperture in accelerator mode when its bit in the MMU control register (7F13h) is set, where a write starts an
// operation whose destination is that address, and the ACL registers from 7F30h. The driver's stores there come here
// once they are made (recomp.py --mmio); an operation runs to completion at once, so the status (7F36h) reads idle.
const MMU = 0xb8000;
P.mmioWrite = function (lin, size) {
  if (lin >= WIN && lin < WIN + 0x10000) return this.vgaWrite(lin, size);
  const a = this.adapter(), off = lin - MMU, u8 = this.u8;
  if (off >= 0x7f00) { u8[MMU + 0x7f36] = 0; return; }
  if (off >= 0x6000) return;
  const ap = off >> 13, dst = (this.r32(MMU + 0x7f00 + 4 * ap) + (off & 0x1fff)) & (VRAM_SIZE - 1), vram = this.scanout().vram;
  if (u8[MMU + 0x7f13] & (1 << ap)) {
    if (!a.acl) a.acl = this.aclStart(vram, dst);
    if (a.acl.cpuMix) { let v = 0; for (let i = size - 1; i >= 0; i--) v = v * 256 + u8[lin + i]; this.aclMix(a, v, 8 * size); }
    else { this.aclRun(a.acl); a.acl = null; }
  } else for (let i = 0; i < size; i++) vram[(dst + i) & (VRAM_SIZE - 1)] = u8[lin + i];
  if (!a.flat) u8.set(vram.subarray(a.bank << 16, (a.bank << 16) + 0x10000), WIN);
  a.dirty = true;
};
/** a load from device memory, before it is made (recomp.py mmio_load): the VGA's window in the planar modes puts the
 *  read's result there; the W32's registers read as they are kept */
P.mmioRead = function (lin, size) { if (lin >= WIN && lin < WIN + 0x10000) this.vgaRead(lin, size); };
// The VGA's graphics controller in the 16-color planar modes: the four planes are VRAM's first four 64K (plane p at
// p * 10000h), each byte of the A0000h window one byte of each plane. A read loads the four latches and returns, in
// read mode 0 (GC 5 bit 3 clear), the plane GC 4 selects, in read mode 1 the bits whose color matches GC 2 in the
// planes GC 7 cares about. A write goes to the planes the sequencer's map mask (SEQ 2) enables, as write mode
// (GC 5 bits 1-0) says: 0 the byte rotated (GC 3 bits 2-0), or set/reset's (GC 0) where GC 1 enables it, then the
// logical operation with the latches (GC 3 bits 4-3: replace, AND, OR, XOR) and the bit mask (GC 8: latch bits kept
// where clear); 1 the latches as they are; 2 the byte's low four bits, a plane each, through the operation and mask;
// 3 set/reset through the operation, the rotated byte ANDed with the bit mask the mask. Outside the planar modes
// the window is RAM, banked into VRAM (setBank)
P.vgaRead = function (lin, size) {
  const a = this.adapter(); if (!a.planar) return;
  const v = a.vram, g = a.gc, l = a.latch || (a.latch = new Uint8Array(4));
  for (let i = 0; i < size; i++) {
    const off = lin + i - WIN;
    for (let p = 0; p < 4; p++) l[p] = v[p << 16 | off];
    let r;
    if (g[5] & 8) { r = 0xff; for (let p = 0; p < 4; p++) if (g[7] >> p & 1) r &= ~(l[p] ^ (g[2] >> p & 1 ? 0xff : 0)); }
    else r = l[g[4] & 3];
    this.u8[lin + i] = r & 0xff;
  }
};
P.vgaWrite = function (lin, size) {
  const a = this.adapter(); if (!a.planar) return;
  const v = a.vram, g = a.gc, l = a.latch || (a.latch = new Uint8Array(4)), mode = g[5] & 3, rot = g[3] & 7, fn = g[3] >> 3 & 3, mask = g[8], mm = a.seq[2];
  const alu = (d, q) => (fn === 0 ? d : fn === 1 ? d & q : fn === 2 ? d | q : d ^ q);
  for (let i = 0; i < size; i++) {
    const off = lin + i - WIN, b = this.u8[lin + i], r = ((b >> rot) | (b << (8 - rot))) & 0xff;
    for (let p = 0; p < 4; p++) {
      if (!(mm >> p & 1)) continue;
      const q = l[p], sr = g[0] >> p & 1 ? 0xff : 0;
      let d;
      if (mode === 1) d = q;
      else if (mode === 2) d = (alu(b >> p & 1 ? 0xff : 0, q) & mask) | (q & ~mask);
      else if (mode === 3) { const m = r & mask; d = (alu(sr, q) & m) | (q & ~m); }
      else d = (alu(g[1] >> p & 1 ? sr : r, q) & mask) | (q & ~mask);
      v[p << 16 | off] = d & 0xff;
    }
  }
  a.dirty = true;
};
// raster operation r (the ternary ROP code) on pattern, source and destination bytes
const rop3 = (r, p, s, d) => {
  if (r === 0xf0) return p; if (r === 0xcc) return s; if (r === 0xaa) return d;
  let v = 0;
  for (let k = 0; k < 8; k++) if (r >> k & 1) v |= (k & 4 ? p : ~p) & (k & 2 ? s : ~s) & (k & 1 ? d : ~d);
  return v & 0xff;
};
// pattern and source wrap (7F90h, 7F92h): bits 0-2 the width in bytes (7: none), bits 4-6 the lines (4 and up: none)
const WRAP_X = [1, 1, 4, 8, 16, 32, 64, 0], WRAP_Y = [1, 2, 4, 8, 0, 0, 0, 0];
/** where an operand's bytes come from as the operation walks: its address (7F80h pattern, 7F84h source), Y offset
 *  (bytes a line - 1) and wrap. A wrapped operand starts at its address's place in the wrap block */
const aclOperand = (addr, yoff, wrap) => {
  const wx = WRAP_X[wrap & 7], wy = WRAP_Y[wrap >> 4 & 7], stride = yoff + 1;
  const x0 = wx ? addr % wx : 0, base = addr - x0;
  const y0 = wx && wy ? Math.floor(base / wx) % wy : 0, back = wx && wy ? base - (base % (wx * wy)) : base;
  return (x, y) => {
    const cx = wx ? (((x0 + x) % wx) + wx) % wx : x;
    return wy ? back + ((((y0 + y) % wy) + wy) % wy) * stride + cx : base + y * stride + cx;
  };
};
/** an ACL operation onto VRAM at dst as its registers program it: X count + 1 bytes (7F98h) by Y count + 1 lines
 *  (7F9Ah), each byte a raster operation of the pattern, source and destination bytes, walking down or up and right or
 *  left as the X/Y direction register (7F8Fh) says, lines apart by the destination Y offset + 1 (7F8Ch). The routing
 *  control (7F9Ch) says what the CPU feeds it: nothing (0), when every byte takes the foreground operation (7F9Fh), or
 *  the mix (2), a bit for each byte through the accelerator aperture, set for the foreground operation and clear for
 *  the background one (7F9Eh) */
P.aclStart = function (vram, dst) {
  const R = MMU + 0x7f00, u8 = this.u8, M = VRAM_SIZE - 1, routing = u8[R + 0x9c];
  if (routing & 0x0f & ~2) log('warn', 'w32', `ACL routing ${routing.toString(16)}h: CPU data other than the mix`);
  const dir = u8[R + 0x8f];
  return { vram, dst, cpuMix: (routing & 7) === 2, x: 0, y: 0,
    pat: aclOperand(this.r32(R + 0x80) & M, this.r16(R + 0x88), u8[R + 0x90]),
    src: aclOperand(this.r32(R + 0x84) & M, this.r16(R + 0x8a), u8[R + 0x92]),
    dstride: this.r16(R + 0x8c) + 1, xs: dir & 1 ? -1 : 1, ys: dir & 2 ? -1 : 1,
    w: this.r16(R + 0x98) + 1, h: this.r16(R + 0x9a) + 1, fg: u8[R + 0x9f], bg: u8[R + 0x9e] };
};
/** the byte at the operation's place, by raster operation r */
const aclByte = (op, r) => {
  const { vram, xs, ys, x, y } = op, M = VRAM_SIZE - 1, d = (op.dst + ys * y * op.dstride + xs * x) & M;
  const p = ((r >> 4) ^ r) & 0x0f ? vram[op.pat(xs * x, ys * y) & M] : 0, s = ((r >> 2) ^ r) & 0x33 ? vram[op.src(xs * x, ys * y) & M] : 0;
  vram[d] = rop3(r, p, s, vram[d]);
};
/** an operation the CPU feeds nothing, run whole */
P.aclRun = function (op) {
  for (op.y = 0; op.y < op.h; op.y++) for (op.x = 0; op.x < op.w; op.x++) aclByte(op, op.fg);
};
/** n bits of mix data the CPU wrote (low bit first), a byte of the operation each: the line's end drops the rest of
 *  the write, and the last line's ends the operation */
P.aclMix = function (a, v, n) {
  const op = a.acl;
  for (let i = 0; i < n; i++, v = Math.floor(v / 2)) {
    aclByte(op, v % 2 ? op.fg : op.bg);
    if (++op.x < op.w) continue;
    op.x = 0;
    if (++op.y >= op.h) a.acl = null;
    return;
  }
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
  if (this.customMode && a.mode === this.customMode.mode) [a.w, a.h] = [this.customMode.w, this.customMode.h];   // the adapter's custom mode: the configured size (displaySlot), in the entry that stands for it at the depth
  if (hicolor) a.bpp = hicolor;
  a.planar = a.bpp === 4;
  a.pitch = a.planar ? a.w >> 3 : a.w * (a.bpp >> 3);
  // the register values the BIOS loads for the mode: sequencer memory mode (chain-4 for the packed-pixel modes; the
  // 16-color modes' four planes each at the same address, odd/even off), the CRTC's horizontal and vertical display
  // end (with their overflow bits in 07h and Tseng's 35h) and its offset
  const vde = a.h - 1, off = a.planar ? a.pitch >> 1 : a.bpp ? (a.pitch + 7) >> 3 : a.w >> 3;   // (the offset register counts 8 bytes, words in the planar modes: a line is never shorter than its pixels)
  a.misc = 0x63; a.seq[4] = a.planar ? 0x06 : a.bpp ? 0x0e : 0x02;
  if (a.planar) {   // (all four planes written, write mode 0, no set/reset, every bit; the EGA's palette)
    a.seq[2] = 0x0f; a.gc.fill(0, 0, 9); a.gc[6] = 0x05; a.gc[7] = 0x0f; a.gc[8] = 0xff; a.latch = new Uint8Array(4);
    EGA_ATTR.forEach((v, i) => { a.attr[i] = v; }); a.attr[0x10] = 0x01; a.attr[0x12] = 0x0f; a.attr[0x14] = 0;
    for (let i = 0; i < 64; i++) a.dac.set(egaDac(i), 3 * i);
  }
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
  if (this.lptIO && this.lptIO(port, size, isIn)) return;   // the printer port (parallel.js)
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
      case 0x3cd: this.setBank((val & 0x0f) | ((a.segsel2 || 0) & 3) << 4); a.segsel = val; return;
      // the W32's segment select 2: the bank's high bits (1-0 for writes, 5-4 for reads), past the first megabyte; the
      // Tseng driver tells a W32 from an ET4000 by it keeping what is written
      case 0x3cb: a.segsel2 = val & 0x33; this.setBank(((a.segsel === undefined ? a.bank : a.segsel) & 0x0f) | (val & 3) << 4); return;
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
    case 0x3cb: r = a.segsel2 || 0; break;
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
// a global block's size as KRNL386 gives it: rounded up to 32 bytes, so GlobalSize answers that (VB3's sub-heaps
// walk a block to the end GlobalSize gives, in even steps)
const gsize = n => u32((Math.max(u32(n), 1) + 31) & ~31);
P.globalAlloc16 = function (flags, size, owner = 0) {
  size = gsize(size);
  const lin = this.alloc(size + 16, !!(flags & GMEM_ZEROINIT) || true);
  const sel = this.allocSels(lin, size);
  this.ghandles.set(sel, { lin, size, n: Math.ceil(size / 0x10000), flags, lock: 0, owner, heap: true });   // (heap: its memory is the heap's, given back by GlobalFree)
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
// GetVersionEx(far OSVERSIONINFO): 4.0 build 950, Windows (KERNEL32's GetVersionExA answers the same); SETUPX takes the
// export's presence for an installed system rather than Setup's
def16('KERNEL', 149, 'l', 'w', function (fp) { const p = this.lin(fp); if (!p || this.r32(p) < 148) return 0; this.w32(p + 4, 4); this.w32(p + 8, 0); this.w32(p + 12, 950); this.w32(p + 16, 1); this.writeA(p + 20, ' B'); return 1; });
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
// LocalHeapSize: the bytes DS's local heap spans, from its heap info block (DS:6 points to it: the first byte at +6, the
// last block's at +0Ah, as localInit writes them)
def16('KERNEL', 162, '', 'w', function () {
  this.lheap(); const base = this.selBase(this.cpu.ds.value & 0xffff), info = this.r16(base + 6);
  return (this.r16(base + info + 0xa) + 4 - this.r16(base + info + 6)) & 0xffff;
});
// GlobalLRUOldest: the block made the first to discard; nothing here is discarded for memory, so its order is nothing to
// keep: the handle back, as it does
def16('KERNEL', 163, 'w', 'w', h => h);
// FarSetOwner (KRNL386's 403, unnamed): the global block's owner is the given module or task (COMPOBJ hands its blocks to
// the task they are for), so the block goes when that one does
def16('KERNEL', 403, 'ww', 'v', function (h, owner) { const g = this.ghandles && (this.ghandles.get(h | 1) || this.ghandles.get(h)); if (g) g.owner = owner; });
// KRNL386's 700 (unnamed): whether the stack is a 32-bit thread's big stack (a thunk's), as COMPOBJ asks before it
// switches stacks; a Windows 3.x task's stack never is
def16('KERNEL', 700, '', 'w', () => 0);
// FileCDR: File Manager's callback for files deleted or renamed by others, kept for the task; TRUE, installed (the
// callback is the task's to have; the shell's own change notices tell the folders here)
def16('KERNEL', 130, 'x', 'w', function (fp) { const t = this.thread16 && this.thread16.task; if (t) t.fileCDR = fp >>> 0 === 0xffffffff ? null : fp; return 1; });
// NetBIOSCall: INT 5Ch with the NCB at ES:BX; no NetBIOS is loaded here (the network is the redirector's), so the
// NCB's return code, and AL, are NRC_OPENERR's "NetBIOS not loaded", FBh
def16('KERNEL', 103, '', 'jmp', function () {
  const ncb = this.selValid(this.cpu.es.value & 0xffff) ? this.selBase(this.cpu.es.value & 0xffff) + (this.cpu.ebx.value & 0xffff) : 0;
  if (ncb) { this.u8[ncb + 1] = 0xfb; this.u8[ncb + 49] = 0xfb; }   // (ncb_retcode, ncb_cmd_cplt)
  this.cpu.eax.value = (this.cpu.eax.value & ~0xff) | 0xfb; return this.retf16(0);
});
def16('KERNEL', 161, '', 'w', function () { const lh = this.lheap(); return Math.min(0xffff, lh.free.reduce((s, f) => s + f[1], 0)); });   // LocalCountFree: the free bytes in DS's local heap

def16('KERNEL', 15, 'wl', 'w', function (fl, n) { return this.globalAlloc16(fl, n); });
def16('KERNEL', 16, 'wlw', 'w', function (h, n, fl) {   // GlobalReAlloc
  const b = this.gblock(h); if (!b) return 0; n = gsize(n);
  if (fl & LMEM_MODIFY) return h;
  const sel = this.gsel(h);
  if (n > b.size) {
    const cap = (this.allocs.get(b.lin) || 0) - 16;
    if (n > cap) { const nl = this.alloc(n + 16, true); this.u8.copyWithin(nl, b.lin, b.lin + b.size); if (b.heap) this.free(b.lin); b.lin = nl; b.heap = true; }
    else this.u8.fill(0, b.lin + b.size, b.lin + n);
  }
  b.size = n;
  const need = Math.ceil(n / 0x10000);
  if (need > b.n) { this.freeSels(sel, b.n); const ns = this.allocSels(b.lin, n); if (ns !== sel) { this.ghandles.delete(sel); this.ghandles.set(ns, b); b.n = need; this.refreshSegs(); return b.flags & GMEM_MOVEABLE ? ns - 1 : ns; } b.n = need; }
  for (let k = 0; k < b.n; k++) { this.w32(L.LDT + (sel & 0xfff8) + 8 * k, b.lin + 0x10000 * k); this.w32(L.LDT + (sel & 0xfff8) + 8 * k + 4, (k ? Math.min(n - 0x10000 * k, 0x10000) : n) - 1); }
  this.refreshSegs();
  return h;
});
def16('KERNEL', 17, 'w', 'w', function (h) { const b = this.gblock(h); if (!b) return h; const sel = this.gsel(h); this.ghandles.delete(sel); this.freeSels(sel, b.n); if (b.heap) this.free(b.lin); return 0; });
def16('KERNEL', 18, 'w', 'l', function (h) {    // GlobalLock: the selector is returned in CX as well
  const b = this.gblock(h), sel = b ? this.gsel(h) : 0; if (b) b.lock++;
  this.cpu.ecx.value = lo16(this.cpu.ecx.value, sel); return u32(sel << 16);
});
def16('KERNEL', 19, 'w', 'w', function (h) { const b = this.gblock(h); if (b && b.lock) b.lock--; return b ? b.lock : 0; });
def16('KERNEL', 20, 'w', 'l', function (h) { const b = this.gblock(h); return b ? b.size : 0; });
def16('KERNEL', 21, 'w', 'l', function (s) { const b = this.gblock(s); if (!b) return 0; const sel = this.gsel(s); return u32(((b.flags & GMEM_MOVEABLE ? sel - 1 : sel) & 0xffff) | (sel << 16)); });  // GlobalHandle
def16('KERNEL', 197, 'w', 'w', function (h) { return this.gsel(h); });   // GlobalFix
def16('KERNEL', 198, 'w', 'w', function (h) { return 1; });         // GlobalUnfix
def16('KERNEL', 199, 'w', 'w', function (n) { return Math.min(n, 255); });   // SetHandleCount: the task's file handles, up to 255
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
def16('KERNEL', 171, 'w', 'w', function (s) { return this.allocSels(this.selBase(s), this.selLimit(s) + 1, 0xfb00); });   // AllocDStoCSAlias
def16('KERNEL', 184, 'l', 'l', function (n) {           // GlobalDOSAlloc: conventional memory, DX = paragraph, AX = selector
  n = (u32(n) + 15) & ~15; if (this.dosTop + n > 0xa0000) return 0;
  const lin = this.dosTop; this.dosTop += n; this.u8.fill(0, lin, lin + n);
  const sel = this.allocSels(lin, n); this.ghandles.set(sel, { lin, size: n, n: 1, flags: 0, lock: 0, owner: 0 });
  return u32(((lin >> 4) << 16) | sel);
});
def16('KERNEL', 185, 'w', 'w', function (s) { const b = this.gblock(s); if (b) { this.ghandles.delete(this.gsel(s)); this.freeSels(this.gsel(s), b.n); } return 0; });

def16('KERNEL', 36, '', 'w', function () { return this.currentTask(); });                 // GetCurrentTask
def16('KERNEL', 37, '', 'w', function () { const t = this.thread16; return (t && t.task && t.task.psp) || 0; });   // GetCurrentPDB: the task's PSP
def16('KERNEL', 501, 'w', 'w', function (v) { const old = this.k501 || 0; this.k501 = v & 0xff; return old; });   // (no name): KRNL386 swaps a byte of its data (19E3h) with the argument and returns the old one; MMSYSTEM sets 1 around loading a driver
def16('KERNEL', 159, 'w', 'l', function (sel) { return K16['KERNEL.#21'][2].call(this, sel); });   // GlobalHandleNoRIP: GlobalHandle without the debug-system complaint
def16('KERNEL', 122, '', 'w', () => 0);   // IsTaskLocked: no task has locked the system (LockCurrentTask)
def16('KERNEL', 491, 'll', 'l', () => 1);   // RegisterServiceProcess: the task is left out of the task list; there is no task list to leave
def16('KERNEL', 320, 'w', 'w', function (h) { return h && (h === this.currentTask() || [...(this.threadsById || new Map()).values()].some(t => t.tdb === h && t.state !== 'done')) ? 1 : 0; });   // IsTask (an ended task is none: MMSYSTEM waits for MMTASK's end so as Windows exits)
/** a task database: the process's (its Win32 threads share it), or a Win16 task's own (MMTASK.TSK), laid out as
 *  Windows 3.1's TDB, which TOOLHELP reads (TaskFirst, TaskNext, TaskFindHandle): the next task at 0, the task's
 *  SS:SP at 2 and 4, hInstance at 1Ch, hModule at 1Eh, hQueue at 20h, the module name (8 characters) at F2h, 'TD' at
 *  FAh. Each is linked into KERNEL's task list (THHOOK's HeadTDB) as it is made and taken out as its task ends
 *  (tdbPrune); CurTDB is the running task's (tdbCurrent) */
const newTdb = (p, info) => {
  // (TOOLHELP takes a task's selector for a TDB only with 204h bytes or more behind it: a TDB's size on Windows 3.1)
  const a = p.alloc(0x220); p.u8.fill(0, a, a + 0x220); p.w16(a + 0xfa, 0x4454);
  const sel = p.allocSels(a, 0x220);
  if (info) { p.w16(a + 0x1c, info.hInst || 0); p.w16(a + 0x1e, info.hModule || 0); const nm = String(info.name || '').toUpperCase().slice(0, 8).padEnd(8, ' '); for (let i = 0; i < 8; i++) p.u8[a + 0xf2 + i] = nm.charCodeAt(i); }
  p.tdbLink(sel);
  return sel;
};
// KERNEL's THHOOK block (its export 332, a data pointer: TOOLHELP's way into the kernel's lists): hGlobalHeap 0,
// pGlobalHeap 2, hExeHead 4, hExeSweep 6, TopPDB 8, HeadPDB 0Ah, TopSizePDB 0Ch, HeadTDB 0Eh, CurTDB 10h, LoadTDB 12h,
// LockTDB 14h, SelTableLen 16h, SelTableStart 18h
P.thhook = function () {
  if (!this.thhookSel) {
    const a = this.alloc(0x40); this.u8.fill(0, a, a + 0x40);
    this.thhookSel = this.allocSels(a, 0x40); this.thhookLin = a;
    const m = this.masterSel || (K16['KERNEL.#28'][2].call(this) & 0xffff);
    this.w16(a, m); this.w16(a + 2, m); this.w16(a + 4, this.kernelModule().hModule || 0);
    for (const sel of this.tdbList || []) if (!this.r16(a + 0xe)) { this.w16(a + 0xe, sel); }
  }
  return u32(this.thhookSel << 16);
};
P.tdbLink = function (sel) {
  const l = this.tdbList || (this.tdbList = []);
  this.w16(this.selBase(sel), l[0] || 0); l.unshift(sel);
  if (this.thhookLin) this.w16(this.thhookLin + 0xe, sel);
};
P.tdbUnlink = function (sel) {
  const l = this.tdbList; if (!l) return; const i = l.indexOf(sel); if (i < 0) return;
  l.splice(i, 1);
  if (i === 0) { if (this.thhookLin) this.w16(this.thhookLin + 0xe, l[0] || 0); } else this.w16(this.selBase(l[i - 1]), l[i] || 0);
};
/** the tasks that ended, out of the list (their threads done, their processes ended) */
P.tdbPrune = function () {
  const l = this.tdbList; if (!l || !l.length) return;
  const live = new Set([this.tdb16]);
  for (const t of (this.threadsById || new Map()).values()) if (t.state && t.state !== 'done') { if (t.tdb) live.add(t.tdb); if (t.pc && t.pc.exitCode === null) live.add(t.pc.tdb); }
  for (const pc of (this.procs || new Map()).values()) if (pc.exitCode === null) live.add(pc.tdb);
  for (const sel of l.slice()) if (!live.has(sel)) this.tdbUnlink(sel);
};
/** the running task's, as THHOOK's CurTDB and its TDB's SS:SP (a switch to it, ne16.js threads16) */
P.tdbCurrent = function (t) {
  const sel = t ? (t.tdb || (t.pc && t.pc.tdb)) : this.tdb16; if (!sel || !this.thhookLin) return;
  this.w16(this.thhookLin + 0x10, sel);
  if (t && t.ctx && t.ctx.ss) { const b = this.selBase(sel); this.w16(b + 2, t.ctx.esp & 0xffff); this.w16(b + 4, t.ctx.ss & 0xffff); }
};
P.currentTask = function () {
  const t = this.thread16;
  // a Win16 task (LoadModule: MMTASK) is a task of its own, whoever started it: MCISEQ's task tells the driver its
  // handle (mmGetCurrentTask) and the driver posts the sequencer's commands to it (PostAppMessage)
  if (t && t.task) { if (!t.tdb) { t.tdb = newTdb(this, { hInst: t.task.hInst, hModule: t.task.mod && t.task.mod.hModule, name: t.task.mod && t.task.mod.name }); this.w16(this.selBase(t.tdb) + 0x20, t.queue || 0); } return t.tdb; }
  if (t && t.pc) { t.tdb = t.pc.tdb; return t.pc.tdb; }
  return this.tdb16 || (this.tdb16 = newTdb(this, { name: 'KERNEL' }));
};
// the ToolHelp hooks KERNEL keeps for TOOLHELP.DLL: each set answers the one before it; HasGPHandler: no task has a
// fault handler of its own (TOOLHELP's InterruptRegister would)
def16('KERNEL', 318, 'l', 'l', function (fn) { const o = this.fatalExitHook || 0; this.fatalExitHook = fn >>> 0; return o; });   // FatalExitHook
def16('KERNEL', 341, 'l', 'l', function (fn) { const o = this.toolHelpHook || 0; this.toolHelpHook = fn >>> 0; return o; });      // ToolHelpHook
def16('KERNEL', 338, 'w', 'w', () => 0);                                                                                           // HasGPHandler
def16('KERNEL', 47, 's', 'w', function (name) {   // GetModuleHandle
  if (typeof name === 'number') { const m = this.neByHandle(name); return m ? m.hModule : 0; }
  const n = (name || '').toUpperCase().replace(/^.*\\/, '').replace(/\.(DLL|EXE|DRV)$/, '');
  const m = this.ne.get(n);
  if (JS16.includes(n) && !(m && m.meta)) return this.jsModule(n).hModule;   // natively loaded only in a native-USER session
  // a program's module goes with its last task (MMSYSTEM waits for MMTASK's to go as Windows exits)
  if (m && m.taskModule && ![...(this.threadsById || new Map()).values()].some(t => t.task && t.task.mod === m && t.state !== 'done')) return 0;
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
    if (js.name === 'KERNEL' && ord === 332) return this.thhook();   // (THHOOK: a pointer to data, not code)
    if (!ord || !K16[`${js.name}.#${ord}`]) { log('warn', 'ne16', `GetProcAddress ${js.name} ${key}`); return 0; }
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
def16('KERNEL', 95, 's', 'w', function (name) {    // LoadLibrary (KERNEL's: its module handle), a module from disk's LibEntry run as it loads
  const m = this.loadLibrary16(name);
  if (!m) { if (this.missing16) { log('warn', 'ne16', `LoadLibrary ${name}: ${this.missing16} is not found`); this.missing16 = null; return 2; } return this.loadError16(name); }
  if (m.meta && m.meta.dynamic && !m.inited) { m.inited = true; if (!this.initNE(m)) { log('warn', 'ne16', `LoadLibrary ${name}: LibEntry failed`); return 20; } }
  return m.hInstance || m.hModule;
});
def16('KERNEL', 96, 'w', 'v', function () {});                                                                     // FreeLibrary
def16('KERNEL', 46, 'w', 'v', function () {});                                                                     // FreeModule
def16('KERNEL', 93, 'x', 'l', function (fp) { const s = fp >>> 16; const b = this.gblock(s); return b ? u32((s << 16) | (s - 1)) : 0; });   // GetCodeHandle
def16('KERNEL', 167, 'w', 'w', function (h) { const m = this.neByHandle(h), f = m && m.file; return f ? rd.u16(f, rd.u32(f, 0x3c) + 0x3e) || 0x400 : 0x400; });   // GetExpWinVer: the version of Windows the module's header expects (USER holds a 3.0 program to 3.0's rules)
def16('KERNEL', 354, 'w', 'l', function () { return 0; });                                                         // GetAppCompatFlags
def16('KERNEL', 107, 'w', 'w', function (m) { const o = this.errMode16 || 0; this.errMode16 = m; return o; });     // SetErrorMode
def16('KERNEL', 147, 'l', 'v', function (e) { this.lastError = e; });
def16('KERNEL', 148, '', 'l', function () { return this.lastError || 0; });
def16('KERNEL', 361, '', 'v', function () {});                                                         // PIGLET_361: KRNL386's entry is a bare RETF
// ThunkTerminateProcess (KRNL386's thunk 18h into KERNEL32), which USER's ExitWindows calls after a Win32 thread's
// windows took WM_ENDSESSION(TRUE) (USER seg16 B64h), in that thread, as ExitProcess for a Win16 process's (B56h):
// its process ends and the thread unwinds, as Windows ends a program at a log off (EWX_LOGOFF: the machine goes on,
// and Welcome stayed over the logon form). The thread that runs ExitWindows never gets here (B15h) and goes on to the
// logon or ExitKernel
def16('KERNEL', 362, '', 'jmp', function () {
  const t = this.thread16;
  if (!t || !t.pc) return LAYOUT.SENTINEL;
  this.endProcess(t.pc, 0); t.exitCode = 0; return LAYOUT.SENTINEL;
});
// ExitProcess(WORD code): USER's ExitWindows calls it in a thread whose own window took WM_ENDSESSION(TRUE) (USER
// seg16 B56h): the thread's process ends, its other threads with it (endProcess), and the thread itself unwinds as
// KERNEL32's ExitThread ends one, while the thread that runs ExitWindows goes on to ExitKernel. The system's own
// task (MSGSRV32, as Display Properties restarts Windows) takes the message in a call from that thread's SendMessage:
// that call ends, and the system ends at ExitKernel; only at its own top level does its exit end the machine
def16('KERNEL', 466, '', 'jmp', function () {
  const code = this.r16(this.cpu.ssb.value + (this.cpu.esp.value & 0xffff) + 4), t = this.thread16;
  if (!t) { if (!this.depth) { this.exitCode = code; this.host.exited(code); } return LAYOUT.SENTINEL; }
  if (t.pc) this.endProcess(t.pc, code);
  t.exitCode = code; return LAYOUT.SENTINEL;
});
// BUNNY_351: KRNL386 calls VWIN32's protected-mode API, function 0Dh (KRNL386 seg1 DB9h), as USER's ExitWindows
// finishes (USER seg16 14FDh), before the session's end. VWIN32 is this personality's: the Win32 side ends with the
// machine. UNCONFIRMED: what VWIN32's function 0Dh does is not read from its code
def16('KERNEL', 351, '', 'v', function () {});
def16('KERNEL', 323, 'w', 'w', function () { return 0; });                                    // IsRomModule: no module runs from ROM
// LogError: logged with who called it (the module and offset its far return goes to) and on which thread, in the fault
// log too: "LogError 44" alone named no window and no program
def16('KERNEL', 324, 'wx', 'v', function (code) {
  const sp = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), ip = this.r16(sp), cs = this.r16(sp + 2), m = this.neByHandle(cs), sg = m && m.segs.find(s => (s.sel | 1) === (cs | 1));
  const from = m ? `${m.name} ${sg ? sg.num : '?'}:${ip.toString(16)}` : `${cs.toString(16)}:${ip.toString(16)}`, t = this.thread16;
  const who = t ? (t.pc ? t.pc.path : t.task && t.task.path) || `thread ${t.id}` : 'main';
  log('warn', 'KERNEL', `LogError ${code.toString(16)} from ${from} in ${who}`);
  (this.faultLog || (this.faultLog = [])).push({ why: `LogError ${code.toString(16)}`, at: from, thread: who });
});
def16('KERNEL', 327, '', 'jmp', function () {    // HandleParamError: BX = error, CX:AX = parameter; errors unwind to the handler at [BP-2]
  const err = this.cpu.ebx.value & 0xffff, ssb = this.cpu.ssb.value >>> 0, sp = this.cpu.esp.value & 0xffff;
  const ip = this.r16(ssb + sp), cs = this.r16(ssb + sp + 2);
  if (window.W95PARAMERR) window.W95PARAMERR(err, cs, ip, this);
  // (in the machine's fault log as the debug KERNEL reports one: the error, the parameter, the caller; cmd 'faults')
  const fm = this.neByHandle(cs), ps = this.cpu.ecx.value & 0xffff, pm = this.neByHandle(ps), pg = pm && pm.segs && pm.segs.find(s => (s.sel | 1) === (ps | 1)), gh = this.ghandles && this.ghandles.get(ps | 1);
  // (and who called the function that checked it: the far return in its frame, [BP+2]; the thread, its program)
  const fbp = this.cpu.ebp.value & 0xffff, rip = this.r16(ssb + ((fbp + 2) & 0xffff)), rcs = this.r16(ssb + ((fbp + 4) & 0xffff)), rm = this.neByHandle(rcs), t16 = this.thread16;
  (this.faultLog || (this.faultLog = [])).push({ why: `parameter error ${err.toString(16)}, parameter ${(ps << 16 | (this.cpu.eax.value & 0xffff)).toString(16)} (${pm ? `${pm.name} segment ${pg ? `${pg.num}, flags ${pg.flags.toString(16)}` : '?'}` : gh ? `a global block of ${gh.size} bytes${gh.code ? ', code' : ''}` : 'no module'})`, at: `${fm ? fm.name : cs.toString(16)} ${cs.toString(16)}:${ip.toString(16)}`,
    from: `${rm ? rm.name : rcs.toString(16)} ${rcs.toString(16)}:${rip.toString(16)}`, thread: t16 ? `${t16.id} ${t16.pc ? t16.pc.path : t16.task ? t16.task.cmdLine || 'task' : t16.remote !== undefined ? 'host call' : '?'}` : 'host' });
  if (this.faultLog.length > 50) this.faultLog.shift();
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
function oldYield() {
  const t = thr(this, 0), top = !this.asTask && (this.thread16 ? this.depth === this.thread16.depth : this.depth === 0);
  if (top && !t.yielded) { t.yielded = true; return YIELD; }
  t.yielded = false;
}
def16('KERNEL', 447, '', 'v', oldYield);
// OldYield: the same for a Win16 task (USER's PeekMessage calls it when the queue is empty, as for MSGSRV32 polling
// while MMTASK plays its sound)
def16('KERNEL', 117, '', 'v', oldYield);
def16('KERNEL', 471, '', 'l', function () { return this.thread16 && this.thread16.pc ? this.thread16.pc.pid : this.inSystem && this.inSystem() ? SYS_PID : MAIN_PID; });   // GetCurrentProcessId: KERNEL32's ids
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
// a profile's sections (GetPrivateProfileSectionNames), one section's lines (GetPrivateProfileSection, as key=value,
// each ending in a null, the list in another), a section written whole (WritePrivateProfileSection)
const multiSz = (p, buf, n, items) => { let o = 0; for (const t of items) { if (o + t.length + 2 > n) break; W(p, buf + o, t); o += t.length + 1; } p.u8[buf + o] = 0; if (!o) p.u8[buf + 1] = 0; return o; };
def16('KERNEL', 143, 'pws', 'w', function (buf, n, f) { if (!n) return 0; return multiSz(this, buf, n, [...window.W95Win32.iniRead(this.fs, f || 'WIN.INI').values()].map(x => x.name)); });
def16('KERNEL', 418, 'spws', 'w', function (app, buf, n, f) { if (!n) return 0; const sec = window.W95Win32.iniRead(this.fs, f || 'WIN.INI').get((app || '').toLowerCase()); return multiSz(this, buf, n, sec ? sec.lines.map(k => (k.raw !== undefined ? k.raw : `${k.name}=${k.value}`)) : []); });
def16('KERNEL', 416, 'sps', 'w', function (app, lines, f) {
  try { for (let a = lines; a && this.u8[a]; ) { const l = this.readA(a); a += l.length + 1; const i = l.indexOf('='); if (i > 0) window.W95Win32.iniSet(this.fs, f || 'WIN.INI', app, l.slice(0, i).trim(), l.slice(i + 1).trim()); } return 1; } catch (_) { return 0; }
});
// KRNL386's Win32-style directory calls for 16-bit code: GetCurrentDirectory(size, buffer) (the length, or the size
// needed), SetCurrentDirectory, and FindFirstFile / FindNextFile / FindClose on a WIN32_FIND_DATA (FILETIMEs, the long
// name and the 8.3 one), with a 16-bit search handle (FFFFh for none)
def16('KERNEL', 411, 'lp', 'l', function (n, buf) { const c = this.fs.cwd; if (n <= c.length) return c.length + 1; this.writeA(buf, c, n); return c.length; });
def16('KERNEL', 412, 's', 'w', function (d) { try { this.fs.chdir(this.dosFull(d)); return 1; } catch (_) { this.lastError = 3; return 0; } });
P.findData16 = function (a, e) {
  const ft = (o, ms) => { const v = (BigInt(Math.round(ms)) + FT_EPOCH) * 10000n; this.w32(a + o, Number(v & 0xffffffffn)); this.w32(a + o + 4, Number(v >> 32n)); };
  this.u8.fill(0, a, a + 318); this.w32(a, e.attrs | (e.isDir ? 0x10 : 0));
  ft(4, e.ctime); ft(12, e.atime); ft(20, e.mtime); this.w32(a + 32, e.size);
  this.writeA(a + 44, e.name, 260); if (e.shortName && e.shortName !== e.name) this.writeA(a + 304, e.shortName, 14);
};
def16('KERNEL', 413, 'sp', 'w', function (pat, data) {
  const full = this.dosFull(pat), i = full.lastIndexOf('\\'), dir = i <= 2 ? full.slice(0, 3) : full.slice(0, i), mask = full.slice(i + 1) || '*';
  let list; try { list = this.fs.readdir(dir, mask === '*.*' ? '*' : mask); } catch (_) { list = []; }
  if (!list.length) { this.lastError = 2; return 0xffff; }
  this.findData16(data, list[0]);
  this.finds16 = this.finds16 || new Map(); const h = 0x4800 + (this.findNext16 = ((this.findNext16 || 0) + 1) & 0x3ff); this.finds16.set(h, { list, i: 1 }); return h;
});
def16('KERNEL', 414, 'wp', 'w', function (h, data) { const f = this.finds16 && this.finds16.get(h); if (!f || f.i >= f.list.length) { this.lastError = 18; return 0; } this.findData16(data, f.list[f.i++]); return 1; });
def16('KERNEL', 415, 'w', 'w', function (h) { return this.finds16 && this.finds16.delete(h) ? 1 : 0; });
// GetFileAttributes: the attributes, -1 for a name that is not there
def16('KERNEL', 420, 's', 'l', function (name) { const f = this.findFile16(name) || (name && this.fs.exists(this.dosFull(name)) ? this.dosFull(name) : null); if (!f) { this.lastError = this.dosError = 2; return 0xffffffff; } const i = this.fs.stat(f); return i.attrs | (i.isDir ? 0x10 : 0); });
// GetDriveType(0 for A:): 2 removable, 3 fixed, 4 remote (Win16 reports CD-ROM drives as remote), 0 no such drive
def16('KERNEL', 136, 'w', 'w', function (d) { const v = this.fs.vols.get(String.fromCharCode(65 + (d & 0xff))); return !v ? 0 : v.kind === 'removable' ? 2 : v.kind === 'fixed' ? 3 : 4; });
// GlobalCompact: the largest free block the global heap could give (its arena here grows on demand)
def16('KERNEL', 25, 'l', 'l', () => 0x00ff0000);
// IsDBCSLeadByte: no byte leads a double-byte character in code page 1252
def16('KERNEL', 207, 'w', 'w', () => 0);
// FatalAppExit(action, message): the program ends with the message
def16('KERNEL', 137, 'ws', 'v', function (a, msg) { throw new GuestError(`FatalAppExit: ${msg || ''}`); });
def16('KERNEL', 59, 'sss', 'w', function (app, key, v) { P.iniIntent.call(this, 'WIN.INI', app, key, v, P.caller16.call(this)); try { window.W95Win32.iniSet(this.fs, 'WIN.INI', app, key, v); return 1; } catch (_) { return 0; } });
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
/** a DOS name as a full path: relative to the current directory (or a drive's root), . and .. folded */
P.dosFull = function (name) {
  const W = window.W95FS; let p = String(name || '').replace(/\//g, '\\');
  if (/^[a-z]:\\/i.test(p) || p.startsWith('\\\\')) { /* full */ } else if (/^[a-z]:/i.test(p)) p = W.join(p.slice(0, 2) + '\\', p.slice(2));
  else if (p.startsWith('\\')) p = this.fs.cwd.slice(0, 2) + p; else p = W.join(this.fs.cwd, p);
  const unc = p.startsWith('\\\\'), parts = p.split('\\').filter((x, i) => x !== '' || i === 0), out = [];
  for (const x of parts) { if (x === '.') continue; if (x === '..') { if (out.length > 1) out.pop(); continue; } out.push(x); }
  return unc ? '\\' + out.join('\\') : out.length === 1 ? out[0] + '\\' : out.join('\\');
};
// DOS's name and directory functions (fn: AH, or AL of the long-name call 71h); false for one not answered here
const FT_EPOCH = 11644473600000n;
P.dosNames = function (fn, lfn) {
  const W = window.W95FS, flat = this.vxdFlat;
  const off16 = r => (flat ? u32(this.cpu[r].value) : this.cpu[r].value & 0xffff);
  const at = (seg, off) => (flat ? off : this.rmode ? ((this.cpu[seg].value & 0xffff) << 4) + off : this.lin((this.cpu[seg].value << 16) | off));
  const dsdx = () => at('ds', off16('edx')), dssi = () => at('ds', off16('esi')), esdi = () => at('es', off16('edi'));
  const fail = code => { CF(this, 1); this.ax(code); this.dosError = code; };
  const reg = (r, v) => { this.cpu[r].value = lo16(this.cpu[r].value, v); };
  const cx = this.cpu.ecx.value & 0xffff, bl = this.cpu.ebx.value & 0xff;
  const dosTime = ms => { const d = new Date(ms); return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()]; };
  const fileTime = (a, ms) => { const v = (BigInt(Math.round(ms)) + FT_EPOCH) * 10000n; this.w32(a, Number(v & 0xffffffffn)); this.w32(a + 4, Number(v >> 32n)); };
  // a search: the names in the folder matching the pattern, with the attributes allowed (CL) and required (CH, long names)
  const search = (pat, allow, need) => {
    const full = this.dosFull(pat), i = full.lastIndexOf('\\'), dir = i <= 2 ? full.slice(0, 3) : full.slice(0, i), mask = full.slice(i + 1) || '*.*';
    const ok = e => { const a = e.attrs | (e.isDir ? 0x10 : 0); return !(a & 0x16 & ~allow) && (a & need) === need; };
    return this.fs.readdir(dir, mask === '*.*' ? '*' : mask).filter(ok);
  };
  try {
    switch (fn) {
      // reset drive DX (710Dh, CX: flush, invalidate, remount), the long-name form of disk reset (0Dh, above): no buffers
      // are held for a drive here, each write is in place as it is made
      case 0x0d: if (cx <= 2) return; return fail(1);
      case 0x0e: { const d = String.fromCharCode(65 + (this.cpu.edx.value & 0xff)); if (this.fs.vols.has(d)) { try { this.fs.chdir(d + ':\\'); } catch (_) { } } this.ax((this.ax() & 0xff00) | 26); return; }
      case 0x1a: this.dta = at('ds', off16('edx')); this.dtaFar = [this.cpu.ds.value & 0xffff, off16('edx')]; return;
      // FCB find first (11h) and next (12h): DS:DX an unopened FCB (an extended one, FFh first, with the attributes to
      // allow at 6); the entry found to the DTA as its FCB (the extended header again, then the drive and the 32-byte
      // directory entry); AL 0, else FFh. A volume label (attribute 8) is the drive's label (File Manager reads it so)
      case 0x11: case 0x12: {
        const fcb = dsdx(), ext = this.u8[fcb] === 0xff, f = ext ? fcb + 7 : fcb, allow = ext ? this.u8[fcb + 6] : 0, dta = this.dta;
        const notFound = () => { this.ax((this.ax() & 0xff00) | 0xff); };
        if (!dta) return notFound();
        const drv = this.u8[f], d = drv ? String.fromCharCode(64 + drv) : this.fs.cwd[0].toUpperCase();
        let s;
        if (fn === 0x11) {
          const nm = String.fromCharCode(...this.u8.subarray(f + 1, f + 9)).trimEnd(), ex = String.fromCharCode(...this.u8.subarray(f + 9, f + 12)).trimEnd();
          let list;
          if (allow & 8) { let label = ''; try { label = (this.fs.statvfs(d + ':\\').label || ''); } catch (_) { } list = label ? [{ shortName: label.slice(0, 11).toUpperCase(), name: label, attrs: 8, isDir: false, mtime: Date.now(), size: 0, label: true }] : []; }
          else {   // (the 11 characters of the name, blank-padded, each '?' any character, the padding too, as DOS matches them)
            const want = String.fromCharCode(...this.u8.subarray(f + 1, f + 12)).toUpperCase();
            const pad = n => { const s = n.toUpperCase(), i = s.lastIndexOf('.'), b = i < 0 ? s : s.slice(0, i), x = i < 0 ? '' : s.slice(i + 1); return b.padEnd(8).slice(0, 8) + x.padEnd(3).slice(0, 3); };
            const ok = e => { const a = e.attrs | (e.isDir ? 0x10 : 0), n = pad(e.shortName || e.name); return !(a & 0x16 & ~allow) && [...want].every((c, i) => c === '?' || c === n[i]); };
            const cur = this.fs.cwd[0].toUpperCase() === d ? this.fs.cwd : d + ':\\';   // (the drive's current folder)
            try { list = this.fs.readdir(cur).filter(ok); } catch (e) { if (e instanceof W.FSError) list = []; else throw e; }   // (FCB calls answer AL FFh, not an error code)
          }
          s = { list, i: 0 }; (this.dosFinds = this.dosFinds || []).push(s);
          this.w16(f + 12, this.dosFinds.length - 1); this.w16(f + 14, 0x4346);   // (the search, in the FCB's block and record-size words)
        } else { s = this.r16(f + 14) === 0x4346 && (this.dosFinds || [])[this.r16(f + 12)]; if (!s) return notFound(); }
        const e = s.list[s.i++]; if (!e) return notFound();
        let o = dta; if (ext) { this.u8.set(this.u8.subarray(fcb, fcb + 7), dta); o += 7; }
        this.u8.fill(0x20, o + 1, o + 12); this.u8.fill(0, o + 12, o + 33); this.u8[o] = drv || (d.charCodeAt(0) - 64);
        const sn = (e.shortName || e.name).toUpperCase(), dot = e.label ? -1 : sn.lastIndexOf('.'), base = dot < 0 ? sn : sn.slice(0, dot), x = dot < 0 ? '' : sn.slice(dot + 1);
        if (e.label) for (let i = 0; i < Math.min(11, sn.length); i++) this.u8[o + 1 + i] = sn.charCodeAt(i);
        else { for (let i = 0; i < Math.min(8, base.length); i++) this.u8[o + 1 + i] = base.charCodeAt(i); for (let i = 0; i < Math.min(3, x.length); i++) this.u8[o + 9 + i] = x.charCodeAt(i); }
        const [t, dt] = dosTime(e.mtime);
        this.u8[o + 12] = e.attrs | (e.isDir ? 0x10 : 0); this.w16(o + 23, t); this.w16(o + 25, dt); this.w32(o + 29, e.size >>> 0);
        this.ax(this.ax() & 0xff00); return;
      }
      case 0x2f: { const [sg, o] = this.dtaFar || [0, 0]; if (this.rmode) this.cpu.es.value = sg; else this.seg('es', sg); reg('ebx', o); return; }
      case 0x36: {   // free space: AX sectors a cluster, BX free clusters, CX bytes a sector, DX clusters
        const dl = this.cpu.edx.value & 0xff, d = dl ? String.fromCharCode(64 + dl) : this.fs.cwd[0];
        let v; try { v = this.fs.statvfs(d + ':\\'); } catch (_) { this.ax(0xffff); return; }
        const spc = Math.max(1, Math.round((v.cluster || 4096) / 512)), cl = spc * 512;
        this.ax(spc); reg('ebx', Math.min(0xffff, Math.floor(v.free / cl))); reg('ecx', 512); reg('edx', Math.min(0xffff, Math.floor(v.total / cl))); return;
      }
      case 0x39: this.fs.mkdir(this.dosFull(this.readA(dsdx()))); return;
      case 0x3a: this.fs.rmdir(this.dosFull(this.readA(dsdx()))); return;
      case 0x3b: this.fs.chdir(this.dosFull(this.readA(dsdx()))); return;
      case 0x41: this.fs.unlink(this.dosFull(this.readA(dsdx()))); return;
      case 0x43: {   // attributes: AL (long names: BL) 0 get into CX, 1 set from CX; long names' other forms change nothing
        const op = lfn ? bl : this.ax() & 0xff, f = this.dosFull(this.readA(dsdx()));
        if (op === 0) { const i = this.fs.stat(f); reg('ecx', i.attrs | (i.isDir ? 0x10 : 0)); this.ax(i.attrs | (i.isDir ? 0x10 : 0)); return; }
        if (op === 1) { this.fs.setAttrs(f, cx); return; }
        this.fs.stat(f); reg('ecx', 0); reg('edi', 0); return;
      }
      case 0x47: {   // the current directory of drive DL (0 the current one), without its drive and first backslash, at DS:SI
        const dl = this.cpu.edx.value & 0xff, d = dl ? String.fromCharCode(64 + dl) : this.fs.cwd[0];
        const cur = this.fs.cwd[0].toUpperCase() === d.toUpperCase() ? this.fs.cwd : d + ':\\';
        let path = cur.slice(3); if (!lfn) { try { path = this.fs.stat(cur).shortPath.slice(3); } catch (_) { } }
        this.writeA(dssi(), path, lfn ? 260 : 64); this.ax(0x0100); return;
      }
      case 0x4e: case 0x4f: {
        if (!lfn) {   // the DTA's search: 21 bytes of state (here an index into this machine's searches), then the entry
          const dta = this.dta; if (!dta) return fail(18);
          let s;
          if (fn === 0x4e) { s = { list: search(this.readA(dsdx()), cx & 0xff, 0), i: 0 }; (this.dosFinds = this.dosFinds || []).push(s); this.w16(dta, this.dosFinds.length - 1); this.w16(dta + 2, 0x5346); }
          else { s = this.r16(dta + 2) === 0x5346 && (this.dosFinds || [])[this.r16(dta)]; if (!s) return fail(18); }
          const e = s.list[s.i++]; if (!e) return fail(18);
          const [t, d] = dosTime(e.mtime);
          this.u8[dta + 21] = e.attrs | (e.isDir ? 0x10 : 0); this.w16(dta + 22, t); this.w16(dta + 24, d); this.w32(dta + 26, e.size);
          this.writeA(dta + 30, (e.shortName || e.name).toUpperCase(), 13); this.ax(0); return;
        }
        // long names: 4Eh CL allowed, CH required, DS:DX the pattern, SI the time format, ES:DI the WIN32_FIND_DATA; AX a
        // handle for 4Fh (BX) and A1h
        let s, h;
        if (fn === 0x4e) { s = { list: search(this.readA(dsdx()), cx & 0xff, cx >> 8), i: 0 }; if (!s.list.length) return fail(2); this.lfnFinds = this.lfnFinds || new Map(); h = 0x4600 + (this.lfnNext = ((this.lfnNext || 0) + 1) & 0xff); this.lfnFinds.set(h, s); }
        else { h = this.cpu.ebx.value & 0xffff; s = this.lfnFinds && this.lfnFinds.get(h); if (!s) return fail(6); }
        const e = s.list[s.i++]; if (!e) return fail(18);
        const a = esdi(), dos = (this.cpu.esi.value & 0xffff) === 1;
        this.u8.fill(0, a, a + 318); this.w32(a, e.attrs | (e.isDir ? 0x10 : 0));
        for (const [o, ms] of [[4, e.ctime], [12, e.atime], [20, e.mtime]]) { if (dos) { const [t, d] = dosTime(ms); this.w16(a + o, t); this.w16(a + o + 2, d); } else fileTime(a + o, ms); }
        this.w32(a + 32, e.size); this.writeA(a + 44, e.name, 260); if (e.shortName && e.shortName !== e.name) this.writeA(a + 304, e.shortName, 14);
        this.ax(fn === 0x4e ? h : 0); return;
      }
      case 0xa1: if (this.lfnFinds) this.lfnFinds.delete(this.cpu.ebx.value & 0xffff); return;
      case 0x56: { const from = this.dosFull(this.readA(dsdx())), to = this.dosFull(this.readA(esdi())); this.fs.rename(from, to); return; }
      case 0x60: {   // the full name of DS:SI at ES:DI: CL 0 as given (expanded), 1 its short form, 2 its long form
        const full = this.dosFull(this.readA(dssi())), how = cx & 0xff;
        let out = full;
        if (how === 1 || how === 2) { const i = this.fs.stat(full); out = how === 1 ? i.shortPath : i.path; }
        this.writeA(esdi(), how === 1 ? out.toUpperCase() : out, 261); this.ax(0); return;
      }
      case 0xa0: {   // the volume's file system: DS:DX its root, ES:DI the name (CX long), BX flags, CX longest name, DX longest path
        const root = this.dosFull(this.readA(dsdx())).slice(0, 3); let v; try { v = this.fs.statvfs(root); } catch (_) { return fail(15); }
        if (cx) this.writeA(esdi(), v.fsname || 'FAT', cx);
        reg('ebx', 0x4006); reg('ecx', 255); reg('edx', 260); return;
      }
    }
  } catch (e) { if (e instanceof W.FSError) return fail(e.code || 5); throw e; }
  return false;
};
P.findFile16 = function (name) {
  if (/^[a-z]:\\/i.test(name) || name.startsWith('\\')) return this.fs.exists(name) ? this.fs.realpath(name) : null;
  for (const d of [this.fs.cwd, 'C:\\WINDOWS', 'C:\\WINDOWS\\SYSTEM', ...(this.dirs16 || [])]) { const f = window.W95FS.join(d, name); if (this.fs.exists(f)) return this.fs.realpath(f); }
  return null;
};
P.dosOpen = function (path, mode) {
  try { const fd = this.fs.open(path, mode); const h = this.nextDosFile++; this.dosFiles.set(h, { fd, path }); return h; }
  catch (e) { if (e instanceof window.W95FS.FSError) { this.lastError = this.dosError = e.code || 2; return 0xffff; } throw e; }
};
def16('KERNEL', 74, 'spw', 'w', function (name, of, style) {   // OpenFile
  const full = style & OF.CREATE ? (/^[a-z]:\\/i.test(name) ? name : window.W95FS.join(this.fs.cwd, name)) : this.findFile16(name);
  if (of) { this.u8.fill(0, of, of + 136); this.u8[of] = 136; this.u8[of + 1] = 1; }
  if (!full) { if (of) this.w16(of + 2, 2); this.lastError = this.dosError = 2; return 0xffff; }
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
def16('KERNEL', 85, 'sw', 'w', function (name, mode) { const f = this.findFile16(name); if (!f) { this.lastError = this.dosError = 2; return 0xffff; } return this.dosOpen(f, (mode & 3) === 0 ? 'r' : 'r+'); });  // _lopen (a name not found: error 2, as INT 21h 59h then reports)
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

// atoms (local to DS), as KRNL386 keeps them in the local heap: DS:[8] the table (a count, then that many chain
// heads), each atom's entry a fixed block { next, usage count, length byte, the name } on a 4-byte boundary, the atom
// C000h | entry >> 2. Programs reach into the entries (SETUPX's string table counts its own references in the usage
// word, finds an entry at atom << 2). A DS with no local heap keeps its atoms in a table here
P.atomTable = function () { const s = this.cpu.ds.value | 1; if (!this.atoms.has(s)) this.atoms.set(s, { byName: new Map(), byId: new Map(), next: 0xc000 }); return this.atoms.get(s); };
const atomKey = s => typeof s === 'number' ? null : s.toUpperCase();
const atomHash = (s, n) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h ^ (s.toUpperCase().charCodeAt(i) + i)) & 0xffff; return h % n; };
/** the DS's atom table's offset (made with 37 chains the first time), or 0 when the DS has no local heap */
P.latoms = function (n = 37) {
  const ds = this.cpu.ds.value & 0xffff; if (!this.lheaps.has(ds | 1)) return 0;
  const base = this.selBase(ds); let t = this.r16(base + 8);
  if (!t || !this.lheap(ds).blocks.has(t)) {
    t = this.localAlloc(0x40, 2 + 2 * n, ds); if (!t) return 0;
    this.w16(this.selBase(ds) + t, n); this.w16(this.selBase(ds) + 8, t);
  }
  return t;
};
/** an atom's entry offset for its name in the DS's table, and the chain head's offset */
P.latomFind = function (t, s) {
  const base = this.selBase(this.cpu.ds.value & 0xffff), n = this.r16(base + t), head = t + 2 + 2 * atomHash(s, n), k = s.toUpperCase();
  for (let e = this.r16(base + head); e; e = this.r16(base + e)) if (this.u8[base + e + 4] === s.length && this.readA(base + e + 5, s.length).toUpperCase() === k) return { e, head };
  return { e: 0, head };
};
const intAtom = s => (typeof s === 'number' ? s : s && s[0] === '#' ? parseInt(s.slice(1), 10) & 0xffff : null);
def16('KERNEL', 68, 'w', 'w', function (n) { if (this.lheaps.has((this.cpu.ds.value & 0xffff) | 1)) { const base = this.selBase(this.cpu.ds.value & 0xffff); if (!this.r16(base + 8)) return this.latoms(n || 37) ? 1 : 0; return 1; } this.atomTable(); return 1; });   // InitAtomTable
def16('KERNEL', 70, 's', 'w', function (s) {   // AddAtom
  const i = intAtom(s); if (i !== null) return i;
  const t = this.latoms();
  if (!t) { const tb = this.atomTable(), k = atomKey(s); let a = tb.byName.get(k); if (!a) { a = { id: tb.next++, name: s, n: 0 }; tb.byName.set(k, a); tb.byId.set(a.id, a); } a.n++; return a.id; }
  s = s.slice(0, 255);
  const f = this.latomFind(t, s); let base = this.selBase(this.cpu.ds.value & 0xffff);
  if (f.e) { this.w16(base + f.e + 2, (this.r16(base + f.e + 2) + 1) & 0xffff); return 0xc000 | (f.e >> 2); }
  const e = this.localAlloc(0x40, 6 + s.length, this.cpu.ds.value & 0xffff); if (!e || (e & 3)) return 0;
  base = this.selBase(this.cpu.ds.value & 0xffff);
  this.w16(base + e, this.r16(base + f.head)); this.w16(base + e + 2, 1); this.u8[base + e + 4] = s.length; this.writeA(base + e + 5, s, s.length + 1);
  this.w16(base + f.head, e);
  return 0xc000 | (e >> 2);
});
def16('KERNEL', 69, 's', 'w', function (s) {   // FindAtom
  const i = intAtom(s); if (i !== null) return i;
  const t = this.latoms(); if (!t) { const a = this.atomTable().byName.get(atomKey(s)); return a ? a.id : 0; }
  const f = this.latomFind(t, s.slice(0, 255)); return f.e ? 0xc000 | (f.e >> 2) : 0;
});
def16('KERNEL', 71, 'w', 'w', function (id) {   // DeleteAtom: 0 once done
  if (id < 0xc000) return 0;
  const t = this.latoms(); if (!t) { const tb = this.atomTable(), a = tb.byId.get(id); if (a && !--a.n) { tb.byId.delete(id); tb.byName.delete(atomKey(a.name)); } return 0; }
  const base = this.selBase(this.cpu.ds.value & 0xffff), e = (id & 0x3fff) << 2, n = this.r16(base + e + 2);
  if (n > 1) { this.w16(base + e + 2, n - 1); return 0; }
  const s = this.readA(base + e + 5, this.u8[base + e + 4]), head = t + 2 + 2 * atomHash(s, this.r16(base + t));
  for (let at = head, x = this.r16(base + at); x; at = x, x = this.r16(base + x)) if (x === e) { this.w16(base + at, this.r16(base + e)); this.localFree(e, this.cpu.ds.value & 0xffff); return 0; }
  return id;
});
def16('KERNEL', 72, 'wpw', 'w', function (id, buf, n) {   // GetAtomName
  if (id < 0xc000) return W(this, buf, '#' + id, n);
  const t = this.latoms(); if (!t) { const a = this.atomTable().byId.get(id); return a ? W(this, buf, a.name, n) : 0; }
  const base = this.selBase(this.cpu.ds.value & 0xffff), e = (id & 0x3fff) << 2; return W(this, buf, this.readA(base + e + 5, this.u8[base + e + 4]), n);
});

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
def16('KERNEL', 64, 'ww', 'w', function (h, hr) {               // AccessResource: the module's file opened for reading at the resource
  const e = this.resHandles && this.resHandles[hr / 4 - 1]; if (!e || !e.m || !e.m.path) return 0xffff;
  const fh = this.dosOpen(e.m.path, 'r'), f = this.dosFiles.get(fh); if (f) this.fs.seek(f.fd, e.r.off, 0);
  return fh;
});

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
  if (!target) return 0;   // a NULL procedure stays NULL (KRNL386 seg3:1DFD), as a callback USER32 passes none of
  this.thunklets = this.thunklets || new Map();
  const ls = this.lsThunklets && this.lsThunklets.get(u32(target));
  if (ls && ls.relay === u32(relay)) return ls.target;
  const key = `${u32(target)}:${u32(relay)}`; if (this.thunklets.has(key)) return this.thunklets.get(key);
  if (!this.thunkletSeg || this.thunkletSeg.used + 17 > 0x10000) {
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
  if (!target) return 0;   // (KRNL386 seg3:1DAB)
  this.lsThunklets = this.lsThunklets || new Map();
  const sl = this.slThunklets && this.slThunklets.get(u32(target));
  if (sl && sl.relay === u32(relay)) return sl.target;
  for (const [a, t] of this.lsThunklets) if (t.target === u32(target) && t.relay === u32(relay)) return a;
  const a = this.alloc(17);   // (17 bytes: the jump's displacement ends at +17)
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
// the generic thunks' module calls (#513-#515): a Win32 library loaded, freed and its exports found from 16-bit code,
// as KERNEL32's LoadLibraryExA, FreeLibrary and GetProcAddress do
def16('KERNEL', 513, 'sll', 'l', function (name) { const n = this.alloc(name.length + 1); this.writeA(n, name); try { return API.KERNEL32.LoadLibraryA[1].call(this, n); } finally { this.free(n); } });
def16('KERNEL', 514, 'l', 'w', () => 1);
def16('KERNEL', 515, 'lx', 'l', function (h, name) {
  if (!(name >>> 16)) return API.KERNEL32.GetProcAddress[1].call(this, h, name & 0xffff);
  const s = this.readA(this.lin(name)), n = this.alloc(s.length + 1); this.writeA(n, s);
  try { return API.KERNEL32.GetProcAddress[1].call(this, h, n); } finally { this.free(n); }
});
// _CallProcEx32W (#518): CallProc32W's C form: (n, conversion mask, proc, then the n parameters in order), bit i of the
// mask converting the i-th from 16:16 to linear; the caller removes the arguments
def16('KERNEL', 518, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), f = ssb + (this.cpu.esp.value & 0xffff);
  const n = this.r32(f + 4) & 0x7fffffff, mask = this.r32(f + 8), proc = this.r32(f + 12);
  const args = []; for (let i = 0; i < n; i++) { const v = this.r32(f + 16 + 4 * i); args.push(mask & (1 << i) ? this.lin(v) : v); }
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  save.done = function (c) {
    const r = u32(this.cpu.eax.value); if (window.W95CP32) window.W95CP32(proc, args, r);
    for (const g of GPR) this.cpu[g].value = c[g]; for (const [s, b] of SEGS) { this.cpu[s].value = c[s]; this.cpu[b].value = c[b]; }
    this.cpu.eax.value = r | 0; this.cpu.edx.value = lo16(this.cpu.edx.value, r >>> 16);
    return this.retf16(0);
  };
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
// DDE data between the sides, as USER passes a DDE message's block to a window of the other side (KRNL386 seg3:0DA2
// #533, a Win32 block into a 16-bit one; seg3:0E71 #534, a 16-bit block into a Win32 one; GRPCONV's Program Manager
// DDE to the shell): the block copied, as #531/#532 copy clipboard data. For WM_DDE_EXECUTE and WM_DDE_ACK (3E8h, 3E4h)
// a block that came across already is given back as its other side's, so the ACK carries the EXECUTE's own handle.
// (KRNL386 converts a METAFILEPICT's handle inside WM_DDE_DATA and WM_DDE_POKE blocks too; none are sent here)
const DDE_SAME = new Set([0x3e8, 0x3e4]);
def16('KERNEL', 533, '', 'jmp', function () {   // (hMem32: dword, msg: word) -> hMem16
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), h = this.r32(f + 4), msg = this.r16(f + 8);
  let r = 0;
  if (h) {
    const had = DDE_SAME.has(msg) ? [...clip32(this)].find(([, w]) => w === h) : null;
    if (had) r = this.globalHandleOf(had[0]);
    if (!r) {
      const n = this.allocs.get(h) || 0;
      r = this.globalAlloc16(0x2002, n);
      if (r && n) this.u8.copyWithin(this.gblock(r).lin, h, h + n);
      if (r) clip32(this).set(this.gsel(r), h);
    }
  }
  this.cpu.eax.value = r; this.cpu.edx.value = 0;
  return this.retf16(6);
});
// KRNL386 seg3:0F80 (#537): whether a 16-bit block holds a DDE execute command ("[command]", with the ']' ending the
// string: a '[' first and a "]\0" word somewhere after it, in a block of three bytes or more that is not discarded)
def16('KERNEL', 537, '', 'jmp', function () {   // (word, hMem16: word) -> 1 or 0
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), h = this.r16(f + 6), b = h && this.gblock(h);
  let r = 0;
  if (b && b.size >= 3 && this.u8[b.lin] === 0x5b) for (let i = 1; i < b.size - 2; i++) if (this.u8[b.lin + i] === 0x5d && this.u8[b.lin + i + 1] === 0) { r = 1; break; }
  this.cpu.eax.value = r;
  return this.retf16(4);
});
def16('KERNEL', 534, '', 'jmp', function () {   // (hMem16: word, msg: word) -> a Win32 block, in EAX and DX:AX
  const f = this.cpu.ssb.value + (this.cpu.esp.value & 0xffff), h = this.r16(f + 4), msg = this.r16(f + 6);
  let r = 0;
  const b = h && this.gblock(h), sel = b && this.gsel(h);
  if (b) {
    const old = clip32(this).get(sel);
    if (old && DDE_SAME.has(msg)) r = old;
    else {
      if (old) this.free(old);
      r = this.alloc(b.size); this.u8.copyWithin(r, b.lin, b.lin + b.size); clip32(this).set(sel, r);
    }
  }
  this.cpu.eax.value = r | 0; this.cpu.edx.value = r >>> 16;
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
// GetModuleUsage: a program's count is its live instances (0 once its last task or process has ended: a VB3 program
// that Shells another polls it for 0 to know the other is done, MSBDEMOS's chooser after a video); a library loaded, 1
def16('KERNEL', 48, 'w', 'w', function (h) {
  const h32 = this.hinst32(h);
  if (h32) return [...(this.procs || new Map()).values(), this.pc0].filter(pc => pc && pc.exe && pc.exe.base === h32 && (pc === this.pc0 ? this.exitCode : pc.exitCode) === null).length;   // (the machine's own program: its exit code is the machine's)
  const m = this.neByHandle(h); if (!m) return 0;
  if (!m.taskModule) return 1;
  return [...(this.threadsById || new Map()).values()].filter(t => t.task && t.task.mod === m && t.state !== 'done').length;
});
// MakeProcInstance: protected mode needs no thunk; the procedure's own address back in DX:AX (a far pointer, 'l': it
// came back as no return at all, PROGMAN's message hook a stray DX:AX, SetWindowsHook's error 7008)
def16('KERNEL', 51, 'xw', 'l', fp => fp);
def16('KERNEL', 52, 'x', 'v', () => {});                                               // FreeProcInstance
def16('KERNEL', 65, 'ww', 'l', function (h, hr) {                                      // SizeofResource
  const e = this.resHandles && this.resHandles[hr / 4 - 1]; if (!e) return 0;
  return e.data ? e.data.length : e.r ? e.r.size || e.r.len || 0 : 0;
});
// OutputDebugString: the machine's log (the Debug Monitor, DevTools), tagged with the task's module or the program
def16('KERNEL', 115, 'x', 'v', function (sp) {
  const t = this.thread16, m = t && t.task && t.task.hInst && this.neByHandle(t.task.hInst);
  log('info', (m && m.name) || (t && t.pc && t.pc.path ? t.pc.path.replace(/^.*\\/, '') : 'KERNEL'), (sp >>> 16 ? this.readA(this.lin(sp)) || '' : '').replace(/\r?\n$/, ''));
});
def16('KERNEL', 131, '', 'l', function () {                                            // GetDOSEnvironment
  if (!this.dosEnv) { const s = 'COMSPEC=C:\\COMMAND.COM\0PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND\0TEMP=C:\\WINDOWS\\TEMP\0windir=C:\\WINDOWS\0\0';
    const g = this.globalAlloc16(0, s.length + 16), a = this.gblock(g).lin; for (let i = 0; i < s.length; i++) this.u8[a + i] = s.charCodeAt(i); this.dosEnv = this.gsel(g); }
  return u32(this.dosEnv << 16);
});
def16('KERNEL', 157, 'l', 'l', () => 0);                                              // GetCurPID
// GetNumTasks: the tasks running, a Win32 process's among them (each has its task database)
def16('KERNEL', 152, '', 'w', function () { return Math.max(1, new Set([...(this.threadsById || new Map()).values()].filter(t => t.tdb && t.state && t.state !== 'done').map(t => t.tdb)).size); });
// GetInstanceData: cb bytes at the same offset of another instance's DGROUP into the caller's (DS); the count copied
def16('KERNEL', 54, 'www', 'w', function (hInst, off, cb) {
  if (!this.selValid(hInst) || !cb) return 0;
  const n = Math.min(cb, Math.max(0, this.selLimit(hInst) + 1 - off), Math.max(0, this.selLimit(this.cpu.ds.value & 0xffff) + 1 - off));
  this.u8.copyWithin(this.selBase(this.cpu.ds.value & 0xffff) + off, this.selBase(hInst) + off, this.selBase(hInst) + off + n);
  return n;
});
/** whether a started process is idle, as WinExec waits for it to be before it returns (KERNEL32's WinExec: until the
 *  process calls GetMessage, or a time-out): its main thread ended, or waits for input (WaitEvent, a wait on nothing
 *  but its queue, or a plain object wait once its work is handed to another thread); a wait that pumps while holding
 *  a handle is still start-up (the shell waiting on RUNONCE's "Windows is now setting up" screen) */
P.processIdle = function (pc) {
  const t = pc && pc.main;
  if (!t) return true;
  if (t.state === 'done' || t.state === 'hung' || pc.exitCode !== null) return true;
  if (t.state !== 'waiting' || t.preempted) return false;
  if (t.slept) return true;
  const w = t.waitOn; return !!w && (!w.msg || !w.hs.length);
};
def16('KERNEL', 166, 'sw', 'w', function (cmd, show) {   // WinExec: the started program's instance, else its error (2 not found)
  const t = this.thread16;
  if (t && t.execWait) {   // the call resumed: the program it started earlier, waited for at the thread's top
    const pc = t.execWait;
    if (!this.processIdle(pc) && this.now() < t.execUntil) return YIELD;
    t.execWait = null; return this.hinst16(pc.exe.base);
  }
  const r = this.host && this.host.exec ? this.host.exec(cmd, show) : 2;
  if (typeof r !== 'object') return r;
  if (r.elsewhere) return 33;   // (a second instance, in a machine of its own)
  // the new process runs as the caller gives up its slices (the machine goes on: its screen, its other threads),
  // until it is idle or 60 s have passed; inside a call, where the caller cannot give up its slice, it runs here
  if (t && this.atThreadTop()) { t.execWait = r; t.execUntil = this.now() + 60000; return YIELD; }
  this.runUntilIdle(r); return this.hinst16(r.exe.base);
});
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
// OkWithKernelToChangeUsers (#653): USER's ExitWindows asks before a log off (EWX_LOGOFF) ends the user's programs;
// nothing of KERNEL's stands in the way
def16('KERNEL', 653, '', 'w', function () { return 1; });
// C16ThkSL01 (#631): a thunk-compiler stub's 16 -> 32 call. EDX = 16:16 of its ThunkDataSL16, CX = target number * 4,
// the caller's return address on top of the stack. The target is entry CX/4 of the 32-bit half's table (at its
// ThunkDataSL32 + the offset at +20h); a table entry that is no code of that module means the target is not there, and
// the call returns the error value the 16-bit API database (ThunkDataSL16 +28h: {argument bytes, error value} per
// target) gives, dropping the arguments, as for a 32-bit half that never connected.
def16('KERNEL', 631, '', 'jmp', function () {
  const td = this.lin(u32(this.cpu.edx.value)), cx = this.cpu.ecx.value & 0xffff, rec = this.sl01 && this.sl01.get(td);
  if (rec && !rec.mod && rec.dll32) {
    // (the 32-bit half loaded here, as LoadLibrary loads it: its DllMain runs, whose ThunkConnect32 gives the record
    // its module and target table; MSVIDEO's first call to MSVFW32 found neither and every ICOpen failed)
    const m = this.loadDll(String(rec.dll32 || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, ''));
    if (m) { this.runPendingInits(); for (const d of this.importClosure(m)) this.attach(d); }
    const td32 = m && m.exports.get(rec.name32);
    if (td32 && !rec.mod) Object.assign(rec, { mod: m, table: u32(td32 + (this.r32(td32 + 0x20) | 0)) });
  }
  const tgt = rec && rec.table ? this.r32(rec.table + cx) : 0;
  if (rec && rec.mod && tgt >= rec.mod.meta.textLo && tgt < rec.mod.meta.textHi) return this.enter32from16(tgt);
  const db = this.lin(this.r32(td + 0x28)), nargs = db ? this.r32(db + 2 * cx) : 0, err = db ? this.r32(db + 2 * cx + 4) : 0;
  const ssb = u32(this.cpu.ssb.value), sp = this.cpu.esp.value & 0xffff, ip = this.r16(ssb + sp), cs = this.r16(ssb + ((sp + 2) & 0xffff));
  this.cpu.eax.value = lo16(this.cpu.eax.value, err & 0xffff); this.cpu.edx.value = lo16(this.cpu.edx.value, err >>> 16);
  this.cpu.esp.value = lo16(this.cpu.esp.value, sp + 4 + nargs);
  this.seg('cs', cs); return u32(this.selBase(cs) + ip);
});
/** the module a task handle stands for: a Win16 task's own (MMTASK), or a process's program (this machine's, or one
 *  started in it: MMSYSTEM's PlaySound asks for the caller's), whose name is its file's */
P.taskModuleName = function (h) {
  h &= 0xffff; if (!h) return null;
  const t = [...(this.threadsById || new Map()).values()].find(x => x.tdb === h);
  if (t && t.task) { const m = this.neByHandle(t.task.hInst); return m ? m.name : null; }
  if (t && t.pc) return t.pc.path.replace(/^.*\\/, '').replace(/\.[^.]*$/, '').toUpperCase() || null;
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
function cbClientThunkSL() {
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
}
def16('KERNEL', 620, '', 'jmp', function () { return cbClientThunkSL.call(this); });
// CBClientThunkSLEx (#621, KRNL386 seg2:760F): the same relay for a callback whose 16-bit caller has its stack segment
// locked while it runs. As KRNL386 does: 28h bytes more of frame, the caller's four dwords copied to its bottom, then
// a return to the unlocking code (CBEXRET below) and the dword above them; on as CBClientThunkSL. Selectors here are
// never moved, so the lock count KRNL386 keeps (seg1:7A28) has nothing to hold
def16('KERNEL', 621, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), old = this.cpu.esp.value & 0xffff, sp = (old - 0x28) & 0xffff, at = o => ssb + (o & 0xffff);
  const ret = this.thunk16For('KRNL.#1');
  let si = old, di = sp;
  for (let i = 0; i < 4; i++, si += 4, di += 4) this.w32(at(di), this.r32(at(si)));
  this.w32(at(di), ret); di += 4;
  for (let i = 0; i < 6; i++, di += 4) this.w32(at(di), 0);
  this.w32(at(di), this.r32(at(si)));
  this.cpu.esp.value = (this.cpu.esp.value & ~0xffff) | sp;
  return cbClientThunkSL.call(this);
});
// CBClientThunkSLEx's return (KRNL386 seg2:7648): past the zero words to the caller's return address, which it returns
// to, removing the 28h bytes of frame
def16('KRNL', 1, '', 'jmp', function () {
  const ssb = u32(this.cpu.ssb.value), sp = this.cpu.esp.value & 0xffff, at = o => ssb + (o & 0xffff);
  let q = sp; while (!this.r16(at(q)) && q - sp < 0x28) q += 2;
  const top = (sp + 0x24) & 0xffff;
  this.w32(at(top), this.r32(at(q)));
  this.cpu.esp.value = (this.cpu.esp.value & ~0xffff) | top;
  return this.retf16(0);
});
// IsSLThunklet: whether a far pointer addresses a 16-to-32 thunklet (push dword, push dword, jmp far), as KRNL386 checks
def16('KERNEL', 612, 'x', 'w', function (sp) {
  if (!(sp >>> 16) || !this.selValid(sp >>> 16)) return 0;
  const a = this.lin(sp) >>> 0; if (a + 13 > this.u8.length) return 0;   // (a JS entry point's selector: no code there)
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
// GetpWin16Lock: a far pointer to the Win16Lock's SYSLEVEL, which DCIMAN's start-up keeps for its _EnterSysLevel and
// _LeaveSysLevel around the display driver's DCI calls; entering and leaving it are as the Win16Lock's (480, 481)
def16('KERNEL', 449, '', 'l', function () {
  if (!this.win16LockSeg) { const a = this.alloc(0x40); this.u8.fill(0, a, a + 0x40); this.win16LockSeg = u32(this.allocSels(a, 0x40) << 16); }
  return this.win16LockSeg;
});
def16('KERNEL', 439, 'l', 'v', function () {});                                  // _EnterSysLevel
def16('KERNEL', 440, 'l', 'v', function () {});                                  // _LeaveSysLevel
// KRNL386's bridges to Win32 events and threads (each a thunk into KERNEL32 in the real KERNEL). One thread runs
// here: a wait finds an event signalled or times out at once, and the thread id is the one KERNEL32 reports.
// a waitable object: an event, or a thread, which is signalled once it has ended (it stays signalled)
const ev16 = (p, h) => {
  const o = p.obj(h); if (!o) return null;
  if (o.kind === 'event') return o;
  if (o.kind === 'thread') { const t = p.threadsById && p.threadsById.get(o.id); return { manual: true, get set() { return !t || t.state === 'done'; }, set set(_) {} }; }
  if (o.kind === 'process' && o.task) return { manual: true, get set() { return o.task.state === 'done'; }, set set(_) {} };   // (a Win16 task's: once it has ended)
  if (o.kind === 'process') return { manual: true, get set() { return !(p.procs && p.procs.has(o.pid)); }, set set(_) {} };   // (signalled once the process has ended)
  // a semaphore: signalled while its count is above zero; a wait it satisfies takes one (MPR's request queue, which
  // MPREXE's server threads wait on through USER's MsgWaitForMultipleObjects)
  if (o.kind === 'semaphore') return { manual: false, get set() { return o.count > 0; }, set set(v) { if (!v && o.count > 0) o.count--; } };
  return null;
};
/** set an event and make the threads blocked on it runnable (they check their wait again when they run) */
P.signal = function (e) { if (!e) return; e.set = true; this.wakeWaiters(e); };
P.wakeWaiters = function (o) {
  if (o.waiters) { for (const t of o.waiters) t.blocked = false; o.waiters.clear(); }
  if (o.state === 'done' && o.queue) this.queueGone(o);   // (an ended thread: the sends waiting on its queue answered)
};
def16('KERNEL', 457, 'll', 'l', function (manual, initial) { return this.newHandle({ kind: 'event', manual: !!manual, set: !!initial }); });   // CreateW32Event
def16('KERNEL', 458, 'l', 'l', function (h) { const e = ev16(this, h); if (!e) return 0; this.signal(e); return 1; });   // SetW32Event
// ResetW32Event. USER sleeps a Win32 thread's queue by arming its wake mask, resetting the queue's event and waiting on
// it; a thread that sends or posts to the queue in between clears the mask and sets the event, and the reset then took
// that wake away: the queue slept for good with the mask clear and the message waiting (Explorer's thread with a
// SendMessage pending, the busy pointer for good). A queue USER has woken keeps its event set
def16('KERNEL', 459, 'l', 'l', function (h) { const e = ev16(this, h); if (!e) return 0; if (!P.queueWoken.call(this, h)) e.set = false; return 1; });
/** a thread has ended: each SendMessage another thread waits on to its queue is answered (0), as USER answers them when
 *  a queue goes. A sender's queue holds its send's record at 4Eh, in USER's data: the receiving queue at 12h, the result
 *  at 20h, the flags at 24h (1: replied), which USER's send loop waits on (USER 4:1E70). The sender is woken as USER's
 *  SetWakeBit2 wakes a queue: QS_SMRESULT in its wake bits (48h) and changed bits (4Ah), its mask (4Ch) cleared, its
 *  event (0Ch) set. A thread that ended with a send to it waiting left the sender waiting for good (Display
 *  Properties' hourglass after a screen saver's preview ended) */
P.queueGone = function (t) {
  if (!t || !t.queue) return;
  for (const s of (this.threadsById || new Map()).values()) if (s !== t) this.answerSend(s, q => q === t.queue);
};
/** thread s's SendMessage answered (0) when the queue it went to is `gone(queue)`; true if it was */
P.answerSend = function (s, gone) {
  const u = this.ne && this.ne.get('USER'), ds = u && u.segs && u.segs.find(x => x.num === 32);
  if (!ds || !this.selValid(ds.sel) || !s.queue || !s.state || s.state === 'done' || !this.selValid(s.queue)) return false;
  const d = this.selBase(ds.sel), q = this.selBase(s.queue), rec = this.r16(q + 0x4e);
  if (!rec || !(this.r16(q + 0x4c) & 0x8000) || (this.u8[d + rec + 0x24] & 1) || !gone(this.r16(d + rec + 0x12))) return false;
  this.w32(d + rec + 0x20, 0); this.u8[d + rec + 0x24] |= 1;
  this.w16(q + 0x48, this.r16(q + 0x48) | 0x8000); this.w16(q + 0x4a, this.r16(q + 0x4a) | 0x8000); this.w16(q + 0x4c, 0);
  const e = ev16(this, this.r32(q + 0xc)); if (e) this.signal(e);
  return true;
};
/** the current thread, about to wait on its SendMessage, to a queue no thread that goes on has (one that ended before
 *  the send was made, its queue left behind): answered now */
P.sendToGone = function () {
  const s = this.thread16; if (!s || !s.queue || !this.threadsById) return;
  // (the main and system threads, which have no state, go on)
  const live = new Set(); for (const t of this.threadsById.values()) if (t.queue && t.state !== 'done') live.add(t.queue);
  P.answerSend.call(this, s, q => q && !live.has(q));
};
/** whether `h` is the event of a thread's queue that USER has woken since it was armed: its wake mask (4Ch) cleared by
 *  the waker, its wake bits (48h) set */
P.queueWoken = function (h) {
  for (const t of (this.threadsById || new Map()).values()) {
    if (!t.queue || !this.selValid(t.queue)) continue;
    const q = this.selBase(t.queue); if (this.r32(q + 0xc) !== u32(h)) continue;
    return !this.r16(q + 0x4c) && !!this.r16(q + 0x48);
  }
  return false;
};
// WaitForSingleObject: a thread waiting at its top level for an event that is not set gives up its slice (the other
// threads, the system thread among them, run) and waits again when resumed; elsewhere the wait times out at once
/** a wait at a thread's top level for an object not yet set: the thread gives up its slice until it is set, or until
 *  the time-out (ms, INFINITE for none) has run out (WAIT_TIMEOUT then); 0 once ready */
const waitTop = (p, ms) => {
  const t = p.thread16 || (p.mainWait = p.mainWait || {});
  if (ms === 0xffffffff) return YIELD;
  if (!t.wake) t.wake = p.now() + ms;
  else if (p.now() >= t.wake) { t.wake = 0; return 0x102; }
  return YIELD;
};
const waitDone = p => { const t = p.thread16 || p.mainWait; if (t) { t.wake = 0; t.waitOn = null; } };
def16('KERNEL', 460, 'll', 'l', function (h, ms) {
  const e = ev16(this, h); if (!e) return 0xffffffff;
  P.sendToGone.call(this);
  if (!e.set && P.queueWoken.call(this, h)) e.set = true;   // (a queue USER has woken: its event as the waker set it, however it was taken since)
  if (this.thread16) this.thread16.waitOn = { hs: [h], all: 0, ms };   // (for a probe)
  if (!e.set && ms && this.atThreadTop()) { P.idle.call(this); return waitTop(this, ms); }
  if (!e.set && ms) this.waitNested(() => e.set);
  waitDone(this);
  if (!e.set) return 0x102; if (!e.manual) e.set = false; return 0;
});
/** the running program's thread waits with nothing to do (its message loop's wait): its start is over, and its clock
 *  runs on from where its start left it (win32.js progTime) */
P.idle = function () { const t = this.thread16, rec = t && (t.pc || t.task); if (rec && !rec.idle) rec.idle = true; };
/** a wait inside a call (the waiting code cannot give up its slice): each other thread and task gets one turn, up to
 *  its next wait, as the processor would pass to them; the caller then finds the object set or not */
P.waitNested = function (done) {
  if (!done()) this.threads16(true);
};
// (a call the host makes as a thread (asThread) is never that thread's top level: the thread is stopped where it was)
P.atThreadTop = function () { return this.asTask ? false : this.thread16 ? this.depth === this.thread16.depth : this.depth === 0 && !this.inSystem(); };
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
  hs.forEach((e, i) => { if (e && !e.set && P.queueWoken.call(this, this.r32(this.lin(ph) + 4 * i))) e.set = true; });   // (as #460)
  const ready = all ? hs.every(e => e && e.set) : hs.some(e => e && e.set);
  if (this.thread16) this.thread16.waitOn = { hs: [...Array(n)].map((_, i) => this.r32(this.lin(ph) + 4 * i)), all, ms, msg: true };   // (what the thread waits on: USER's MsgWaitForMultipleObjects, a wait that pumps)
  if (!ready && ms && this.atThreadTop()) return waitTop(this, ms);   // as #460: a thread at its top level gives up its slice
  if (!ready && ms) this.waitNested(() => (all ? hs.every(e => e && e.set) : hs.some(e => e && e.set)));
  waitDone(this);
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
  // 1: a Win32 thread (THDB flags bit 0): the program's main thread and every thread of a Win32 process (USER gives its
  // queue an event, which a sent message, a reply or input sets); a Win16 task's and USER's start-up's are the system's
  const t16 = this.thread16, win32 = t16 ? !t16.task && !!(t16.flat || t16.pc) : !this.inSystem();
  const r = this.call16(ep >>> 16, ep & 0xffff, [['w', 0], ['w', win32 ? 5 : 4]]);
  return t.queue || r.ax;
});
// Get/SetProcessDword: a process's fields by the GPD_ offsets (0 user data, -4 flags, -8 parent, -12..-32 its
// STARTUPINFO, -36 PDB, -40 THDB, -44 expected Windows version, -48 hInstance, -52 load-done event, -56 app
// compatibility flags). Nothing is set until someone sets it, but the version, which is 4.0, and the instance.
const GPD = { 0: 0, '-4': 0, '-8': 0, '-12': 0, '-16': 0, '-20': 0, '-24': 0, '-28': 0, '-32': 0, '-36': 0, '-40': 0, '-44': 0x400, '-48': 0, '-52': 0, '-56': 0 };
const pdw = (p, pid, off) => {
  if (!(off in GPD)) throw new GuestError(`GetProcessDword offset ${off}`);
  pid = pid || (p.thread16 && p.thread16.pc ? p.thread16.pc.pid : p.inSystem() ? SYS_PID : MAIN_PID);   // USER's start-up runs as the system process, not the program's
  p.procDword = p.procDword || new Map();
  if (!p.procDword.has(pid)) {
    // the process's instance (-48), as KERNEL32 keeps it: its program's 16-bit alias (ShellExecute answers with it for a
    // DDE server's process)
    const pc = p.procs && p.procs.get(pid), exe = pc ? pc.exe : pid === MAIN_PID ? p.exe : null;
    // the Win16 tasks' process (MSGSRV32, PROGMAN: GetCurrentProcessId from their threads is the system's, or the
    // machine's own where the machine is the system's and has no program) has fWin16Process (8) in its flags, as
    // KERNEL32 marks the process Win16 programs run in (GRPCONV asks it of the process behind a Progman window)
    const win16 = pid === SYS_PID || (pid === MAIN_PID && !!(p.host && p.host.system));
    p.procDword.set(pid, { ...GPD, '-4': win16 ? 8 : 0, '-48': exe ? p.hinst16(exe.base) : 0 });
  }
  return p.procDword.get(pid);
};
def16('KERNEL', 485, 'li', 'l', function (pid, off) { return pdw(this, pid, off)[off] >>> 0; });
def16('KERNEL', 484, 'lil', 'v', function (pid, off, v) { pdw(this, pid, off)[off] = v; });
// GetModuleFileName32 (KERNEL.487: a 32-bit module's file, into a 16-bit buffer, its length), as USER asks for a
// 32-bit module's file (a combo box's drop-down list in a 32-bit program's dialog: MMSYS.CPL's Sounds); KERNEL32's
// GetModuleFileNameA answers it
def16('KERNEL', 486, 'l', 'w', function () { return 1; });   // FreeLibrary32: the module stays, as KERNEL32's FreeLibrary keeps them here
def16('KERNEL', 487, 'lpw', 'w', function (h, buf, n) { return window.W95Win32.API.KERNEL32.GetModuleFileNameA[1].call(this, h, buf, n) & 0xffff; });
// MapProcessHandle: the id of the process a handle names (GetCurrentProcess's the caller's); an id is taken as it is
def16('KERNEL', 483, 'l', 'l', function (h) {
  if (h === 0xffffffff) return this.thread16 && this.thread16.pc ? this.thread16.pc.pid : this.inSystem() ? SYS_PID : MAIN_PID;
  if (h === SYS_PID || h === MAIN_PID || (this.procs && this.procs.has(h))) return h;
  const o = this.obj(h); if (o && o.kind === 'process') return o.pid;
  this.lastError = 6; return 0;   // ERROR_INVALID_HANDLE
});
// VWIN32's events as KRNL386 reaches them (VWin32_EventCreate .. EventSet, and 479, which sets one unless the
// Win16Lock is held): one thread runs here, so a wait finds the event set or returns at once
def16('KERNEL', 442, '', 'l', function () { return this.newHandle({ kind: 'event', manual: false, set: false }); });   // VWin32_EventCreate
def16('KERNEL', 443, 'l', 'v', function (h) { this.handles.delete(h); });                                              // VWin32_EventDestroy
def16('KERNEL', 450, 'l', 'v', function (h) {                                                                         // VWin32_EventWait
  const e = ev16(this, h); if (!e) return;
  if (!e.set && this.thread16 && this.thread16.id !== MAIN_TID && this.atThreadTop()) { this.thread16.wait = e; return YIELD; }
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
  if (this.thread16 && this.thread16.pc) t.pc = this.thread16.pc;   // a thread of the process that creates it
  return t;
};
// ---- processes a program starts (WinExec, CreateProcess): another program's image in this address space (each
// program is built at a base of its own) under the same window system, as Windows 95 runs every process on one USER.
// Its main thread starts as KERNEL32 starts a process's: a task of its own, USER's InitApp for it, USER told the GUI
// process has loaded (SignalProc32), then its entry point
let nextPid = 0x60;
P.spawn = function (file, module, meta, path, cmdline) {
  const pc = { pid: nextPid, path, exitCode: null, tdb: newTdb(this, { name: String(path || '').replace(/^.*\\/, '').replace(/\.[^.]*$/, '') }), started: false, parent: (this.thread16 && this.thread16.pc) || null };   // (parent: the process whose thread starts it)
  nextPid += 4;
  // a second instance of a program already running here: one image, as code, with each process's own copy of its
  // data (as each Win32 process has its own address space), the running one's put by as the new one's is laid out;
  // the copy in place is the one of the process whose thread runs (imgUse)
  const live = [...(this.procs || new Map()).values()].find(x => x.exe.base === meta.base && x.exitCode === null);
  if (live) {
    const rec = live.exe, g = rec.inst || (rec.inst = { cur: live, bufs: new Map() }), exe0 = this.byName.get('EXE');
    if (g.cur) g.bufs.set(g.cur, this.u8.slice(rec.base, rec.base + rec.size));
    const fresh = this.loadImage(file, module, meta, 'EXE');
    this.modules = this.modules.filter(m => m !== fresh); if (exe0) this.byName.set('EXE', exe0);
    pc.exe = rec; g.cur = pc;
    // the thread that started it goes on with its own process's data in place (the shell starting Explorer from the
    // Start menu), the new instance's put by until its own thread runs
    const by = this.thread16 && this.thread16.pc; if (by && by !== pc && by.exe === rec) this.imgUse(by);
  } else {
    // (its DLLs the bundle does not carry looked for in its own folder first, win32.js diskDll)
    this.loadDirs = [String(path || '').replace(/\\[^\\]*$/, '')];
    try { pc.exe = this.loadImage(file, module, meta, 'EXE'); } finally { this.loadDirs = null; }
  }
  pc.cmdPtr = this.alloc(cmdline.length + 1); this.writeA(pc.cmdPtr, cmdline);
  pc.cmdLine = cmdline;   // (as it was started: the program can change its copy, RUNDLL32 cuts its at the comma)
  Object.assign(pc, this.startClock(), { origin: this.nextOrigin || 'here' }); this.effect('exec', cmdline);
  this.inits = [];   // its DLLs attach to it as its main thread starts (pcStart)
  const t = this.newThread(meta.entry, 0, 0x100000, true, false); t.pc = pc; t.tdb = pc.tdb; pc.main = t;
  (this.procs || (this.procs = new Map())).set(pc.pid, pc);
  return pc;
};
/** the image data of process pc in place, when its image is shared with another instance (spawn) */
P.imgUse = function (pc) {
  this.dllUse(pc);   // (and its private-arena DLLs' data, win32.js; the system's for a thread of no started process)
  const rec = pc && pc.exe, g = rec && rec.inst; if (!g || g.cur === pc || !g.bufs.has(pc)) return;
  if (g.cur) g.bufs.set(g.cur, this.u8.slice(rec.base, rec.base + rec.size));
  this.u8.set(g.bufs.get(pc), rec.base); g.bufs.delete(pc); g.cur = pc;
};
/** WinExec's start, as Win16's loader gives it: the new process runs until its main thread first waits for input
 *  (or ends), so it has made its windows by the time WinExec returns */
P.runUntilIdle = function (pc, rounds = 500) {
  for (let k = 0; k < rounds && !this.processIdle(pc) && !this.trapped; k++) this.threads16(true);
};
/** a thread of a started process has ended: the process ends with its last thread (a thread returning from its
 *  start, the main one too, ends that thread only), unless ExitProcess ended it already */
P.pcThreadEnded = function (t) {
  const pc = t.pc; if (pc.exitCode !== null) return;
  if (![...this.threadsById.values()].some(x => x.pc === pc && x.state && x.state !== 'done')) this.endProcess(pc, t.exitCode || 0);
  else this.threadExitUser(t);
};
/** USER told of the end of one thread of a process that goes on, as KERNEL32 tells it from the exiting thread
 *  (SignalProc32, USIG_THREAD_EXIT): the thread's windows and queue go, and what was sent to it is answered. Told only
 *  as a whole process ended, an Explorer folder window's thread that ended left its queue behind, and the folder's
 *  window never filled (the busy pointer for good) */
P.threadExitUser = function (t) {
  // (a thread of no started process, one the host made (worker.js netBatch), is the system process's)
  const pc = t.pc, exe = pc ? pc.started && pc.exe : this.exe, u = exe && this.ne && this.ne.get('USER'), sig = u && u.meta && this.neExport(u, 391);
  if (!sig || !t.queue || t.userExited) return;
  t.userExited = true;
  const by = this.thread16; this.thread16 = t;
  try { this.user16(391, [['l', 0x20], ['l', t.id], ['l', 3], ['w', this.hinst16(exe.base)]]); } catch (e) { console.error(e); } finally { this.thread16 = by; }
};
/** a fault in a Windows 3.x program the system runs (a task of its own, not the system's first task): that program
 *  ends and is named in the fault dialog, as Windows 95 closes the one program; the system goes on. Charged to the
 *  machine, the fault named MSGSRV32 and its Close ended Windows. Whether it was one */
P.taskFault = function (t, why, fault) {
  if (!this.noMain || !t.task || t.pc || t === this.appyThread) return false;
  // its windows go first, destroyed as its own thread (DestroyWindow, as USER takes down an ending task's windows),
  // so what they covered is repainted: told only that the thread had ended, USER let them go and the screen kept
  // their pixels (Disk Defragmenter's window, after its fault)
  // (the stop is taken here: USER's calls do not run while it stands, and the windows stayed)
  this.trapped = null;
  const by = this.thread16; this.thread16 = t;
  try { for (const h of this.taskWindows(t.tdb).reverse()) if (this.user16(47, [['w', h]]).ax) this.user16(53, [['w', h]]); }   // (IsWindow: one an owner's destruction took is gone)
  catch (e) { console.error(e); this.trapped = null; } finally { this.thread16 = by; }
  t.state = 'done'; this.wakeWaiters(t);
  if (this.win16Held && this.win16Held.who === t) this.win16Held = null;
  (this.pcFaults || (this.pcFaults = [])).push({ pc: { path: t.task.path }, fault: fault || null, why });
  this.threadExitUser(t); this.taskModuleEnded(t);
  return true;
};
/** a Win16 task's end that leaves its program's module with no task: KERNEL frees the module and tells USER
 *  (SignalProc32, USIG_DLL_UNLOAD_WIN16 1, the module's handle), which drops what the module registered, its window classes among it. Kept, the
 *  next start's RegisterClass failed (Minesweeper's class there already) and the program quit at once */
P.taskModuleEnded = function (t) {
  if (t.modEnded) return; t.modEnded = true;
  if (this.fgWanted) this.fgWanted.delete(t.tdb);   // (one that showed no window)
  const m = t.task && t.task.mod, u = this.ne && this.ne.get('USER');
  if (!m || !m.taskModule || !u || !u.meta || !this.neExport(u, 391)) return;
  if ([...this.threadsById.values()].some(x => x !== t && x.task && x.task.mod === m && x.state !== 'done')) return;
  const by = this.thread16; this.thread16 = t;
  try { this.user16(391, [['l', 1], ['l', m.hModule], ['l', 0], ['w', m.hModule]]); } catch (e) { console.error(e); } finally { this.thread16 = by; }
};
/** a started process's end (ExitProcess, or its last thread): its threads stop */
P.endProcess = function (pc, code) {
  if (pc.exitCode !== null) return;
  pc.exitCode = code >>> 0;
  // USER hears of its end as KERNEL32 tells it (SignalProc32: USIG_THREAD_EXIT 20h for each thread, USIG_PROCESS_EXIT
  // 300h, USIG_PROCESS_DESTROY 400h): the windows and queues of its threads go there. A thread's end is signalled on
  // that thread while it still is one (its stack and information block not yet freed), as KERNEL32 signals it from
  // the exiting thread: USER's DestroyWindow goes on only for a window of the current thread's queue
  const u = pc.started && pc.exe && this.ne && this.ne.get('USER'), sig = u && u.meta && this.neExport(u, 391), h = sig && this.hinst16(pc.exe.base);
  const signal = (s, id) => this.user16(391, [['l', s], ['l', id], ['l', 3], ['w', h]]);
  if (sig) try {
    const by = this.thread16;
    for (const t of (this.threadsById || new Map()).values()) if (t.pc === pc) {
      if (t.state === 'done' && t !== by) { signal(0x20, t.id); continue; }   // (one that ended already: its queue is the one USER finds by its id)
      this.thread16 = t; try { signal(0x20, t.id); } finally { this.thread16 = by; }
    }
  } catch (e) { console.error(e); }
  for (const t of (this.threadsById || new Map()).values()) if (t.pc === pc && t !== this.thread16 && t.state !== 'done') {
    t.state = 'done'; this.wakeWaiters(t); if (this.win16Held && this.win16Held.who === t) this.win16Held = null;
    if (t.flat && t.stackBase) { this.free(t.stackBase); this.free(t.tib); t.stackBase = t.tib = 0; }   // (its stack and thread information block go with it)
  }
  // the address space it reserved (VirtualAlloc) goes with it, as its private arena does on Windows 95
  for (const [b, r] of this.vregions || new Map()) if (r.pc === pc) { this.vregions.delete(b); if (r.heap) this.free(r.heap); else (this.vspare || (this.vspare = [])).push({ base: b, size: r.size }); }
  for (const [h, dc] of this.glNativeDCs || new Map()) if (dc.pc === pc) { if (dc.bits) this.free(dc.bits); this.glNativeDCs.delete(h); }   // (gl.js: its frames' DIBs)
  for (const ctx of [...(this.glContexts || [])]) if (ctx.pc === pc) { if (this.glctx === ctx) this.glctx = null; window.W95GL.releaseContext(this, ctx); }   // (and its GPU contexts)
  if (this.thread16 && this.thread16.pc === pc) this.thread16.exitCode = code >>> 0;
  const destroy = window.W95Win32 && window.W95Win32.API.USER32.DestroyWindow;
  if (destroy) for (const w of [...(this.windows || new Map()).values()]) if (w.pc === pc && (!w.parentWin || w.parentWin.pc !== pc)) {
    try { destroy[1].call(this, w.hwnd); } catch (_) { /* process teardown continues */ }
  }
  if (this.w32DesktopSurface && this.w32DesktopSurface.pc === pc) this.w32DesktopSurface = null;
  if (sig) try { signal(0x300, pc.pid); signal(0x400, pc.pid); } catch (e) { console.error(e); }
  if (this.procs) this.procs.delete(pc.pid);
  (this.exitCodes || (this.exitCodes = new Map())).set(pc.pid, pc.exitCode);   // (GetExitCodeProcess after it has gone)
  this.wakeWaiters(pc);   // (the threads waiting on its process handle)
  const g = pc.exe && pc.exe.inst; if (g) { g.bufs.delete(pc); if (g.cur === pc) g.cur = null; }   // (its copy of a shared image's data goes)
  this.dllForget(pc);   // (and its copies of its DLLs' data)
  if (pc.onExit) pc.onExit(pc.exitCode);
};
// USER hears of a process as KERNEL32 tells it (SignalProc32: USIG_PROCESS_CREATE 100h, USIG_PROCESS_INIT 200h,
// USIG_THREAD_INIT 10h for its thread, then USIG_PROCESS_LOADED 600h and USIG_PROCESS_RUNNING 500h once its DLLs are
// attached; flags Win32 and GUI): its per-process state, its global classes among it, is made there
P.pcStart = function (pc) {
  pc.started = true;
  const u = this.ne.get('USER'), sig = u && u.meta && this.neExport(u, 391), h = this.hinst16(pc.exe.base);
  const signal = (s, id) => { if (sig) this.user16(391, [['l', s], ['l', id], ['l', 3], ['w', h]]); };
  signal(0x100, pc.pid); signal(0x200, pc.pid); signal(0x10, pc.main.id);
  for (const m of this.importClosure(pc.exe)) if (m !== pc.exe) this.attach(m);   // DllMain(DLL_PROCESS_ATTACH) of each DLL its image uses, dependencies first
  this.user16(5, [['w', h]]);   // InitApp
  signal(0x600, pc.pid); signal(0x500, pc.pid);
};
P.currentThreadId = function () { return this.thread16 ? this.thread16.id : this.inSystem && this.inSystem() ? SYS_TID : MAIN_TID; };
def16('KERNEL', 441, 'llllll', 'l', function (attr, stack, start, param, flags, ptid) {   // CreateThread16
  thr(this, MAIN_TID);
  const id = MAIN_TID + this.threadsById.size, t = thr(this, id);
  Object.assign(t, { start, param, stack: Math.max(stack || 0, 0x4000), state: 'new', ctx: null, wait: null });
  if (ptid) this.w32(this.lin(ptid), id);
  return this.newHandle({ kind: 'thread', id });
});
P.saveCtx16 = function () { return this.saveFull(); };   // (a thread's time can run out between any two blocks: all of it)
P.loadCtx16 = function (c) { this.loadFull(c); this.rebaseGlobals(); };
/** a stopped thread going on: a segment register holding a global block's selector takes the block's base as its
 *  descriptor has it now, as reloading the register on a task switch does. GlobalReAlloc moves a block that grows past
 *  its memory, and a thread stopped with the old base (DIBENG's blit stack segment, its line count at SS:0) ran on in
 *  memory the block had left: the count was never reached, and WELCOME blitted for good at the first start. The
 *  per-call stack aliases keep the base they were saved with (another call redefines them). EIP is linear here: CS's
 *  block moved (DIBENG grows the buffer it compiles blits into), the thread goes on at the same offset in the block,
 *  not at the address the block left (a jump there is a page fault: "exception eh" at the old address) */
P.rebaseGlobals = function () {
  if (!this.ghandles) return;
  for (const [s, b] of SEGS) {
    const v = this.cpu[s].value & 0xffff; if (!(v & 0xfff8) || (s === 'fsel')) continue;
    if (!this.gblock(v)) continue;
    const old = u32(this.cpu[b].value), now = u32(this.selBase(v));
    this.cpu[b].value = now;
    if (s === 'cs' && old !== now) this.cpu.eip.value = u32(this.cpu.eip.value) - old + now;
  }
};
/** run the threads that can run; the host calls this between slices of the main thread. Inside a thread's run
 *  (nested: a Yield or a wait inside a call, or with `only` a task its creator's LoadModule hands the processor to) the
 *  other threads each get a slice of their own, as the processor passes to them, and the caller's run goes on as it
 *  was (its context, its image, what the processor was stopped for); the threads up the nesting are left alone */
P.threads16 = function (nested = false, only = null) {
  // a wait inside a call is code waiting: the sound card plays on and interrupts as the clock on the wall says
  // (between slices the host lets it run; a wait on a wave's end made inside a call would otherwise never see it)
  if (nested && this.sound16) this.sound16();
  if (!this.threadsById || (!nested && (this.thread16 || this.depth)) || (this.threadsNest || 0) >= 4) return;
  // (the threads run here run as themselves: a call the host makes as the caller (asTask) is the caller's alone)
  const caller = this.thread16, wasIn = this.inThreads, wasPreempted = this.preempted, t0 = this.runT0, wasAs = this.asTask;
  this.inThreads = true; this.threadsNest = (this.threadsNest || 0) + 1; this.asTask = false; if (caller) this.runT0 = this.now();
  if (this.tdbList && this.tdbList.length && !nested) this.tdbPrune();   // (the tasks that ended, out of KERNEL's task list)
  try { for (const t of only ? [only] : [...this.threadsById.values()]) {   // the threads there are as the pass starts: one created in it starts in the next
    if (t === caller || t.state === 'running' || t.blocked || (t.id === MAIN_TID && !caller) || (t.id === MAIN_TID && caller) || !t.state || t.state === 'done' || t.state === 'hung' || t.state === 'suspended' || (t.state === 'waiting' && t.wait && !t.wait.set)) continue;   // a thread that yielded with no event to wait for (in WaitEvent) runs again
    if (this.win16Held && this.win16Held.who !== t && !(caller && this.win16Held.who === caller)) continue;   // another thread holds the Win16Lock (a caller that yields hands its own over)
    const main = this.saveCtx16();
    this.thread16 = t; t.sliceStart = this.now(); this.preempted = 0; this.imgUse(t.pc); if (this.thhookLin) this.tdbCurrent(t);
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
        if (t.pc && !t.pc.started) this.pcStart(t.pc);
        r = this.runTop(u32(t.start));
        if (r === 0 && t.exitCode === undefined) t.exitCode = u32(this.cpu.eax.value);
        if (r !== 1 && t.pc) { t.state = 'done'; this.pcThreadEnded(t); }
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
        r = this.runTop(u32(this.cpu.eip.value));
      }
      // a thread that stopped in a wait gave up the processor there (the call's YIELD clears what its time running out
      // earlier in the run left) and lets the Win16Lock go; one whose time ran out in code keeps it. Its wait flags do
      // not say which: a thread whose last wait left `wake` set and that then ran out of time inside DIBENG's blit let
      // the lock go, another thread blitted on DIBENG's one blit stack (its line count at SS:0 run down to 0), and
      // WELCOME's blit went on from 0: `dec dword ss:[0]` 4 billion times, the hourglass at the first start
      t.preempted = r === 1 && !!this.preempted; this.holdWin16(t);
      if (r === 1) { t.ctx = this.saveCtx16(); t.state = 'waiting'; }
      else {
        t.state = 'done'; this.wakeWaiters(t);
        // a fault in a program the system started ends that program, as Windows 95 closes the one program that
        // performed an illegal operation; the system and the other programs go on
        // (a stop the emulator made, trapped, ends the run as the sentinel does, r 0: a VxD service it lacks)
        if (this.trapped && t.pc && this.noMain) { t.pc.trapped = this.trapped; (this.pcFaults || (this.pcFaults = [])).push({ pc: t.pc, why: this.trapped }); this.trapped = null; this.endProcess(t.pc, 0xffffffff); }
        else if (this.trapped && this.taskFault(t, this.trapped)) this.trapped = null;
        if (t.pc) this.pcThreadEnded(t); else { this.threadExitUser(t); this.taskModuleEnded(t); } if (r !== 0 && this.trapped) log('warn', 'ne16', `thread ${t.id} ${this.trapped}`); if (t.onDone) t.onDone(t);
        if (t.flat && t.stackBase) { this.free(t.stackBase); this.free(t.tib); t.stackBase = t.tib = 0; }   // (its stack and thread information block go with it)
      }   // onDone: the host's, for a thread it started
    } catch (e) {
      if (e instanceof window.W95Win32.FaultError) {   // a processor exception nothing in it handled
        t.state = 'done'; this.wakeWaiters(t);
        if (this.win16Held && this.win16Held.who === t) this.win16Held = null;   // (an ended thread's Win16Lock is let go, as its task's end releases it)
        // a program the system started ends alone (KERNEL32's fault dialog for it); the program this machine runs, or
        // ring 0, takes the machine's answer
        if (t.pc && this.noMain && e.fault.ring !== 0) { t.pc.fault = e.fault; t.pc.main.fault = e.fault; (this.pcFaults || (this.pcFaults = [])).push({ pc: t.pc, fault: e.fault, why: e.fault.why }); this.endProcess(t.pc, 0xffffffff); }
        else if (e.fault.ring === 0 || !this.taskFault(t, e.fault.why, e.fault)) this.faulted(e.fault);
        return;
      }
      // what the emulator cannot do for a program the system started (a VxD service it lacks, run-time code it cannot
      // take) ends that program, as a fault of its own: thrown on, it stopped the system's machine, and Windows with it
      // (HyperTerminal's thread ran into a missing import, its fault handling into garbage, "unimplemented VxD service")
      if (e instanceof window.W95Win32.GuestError && !(e instanceof window.W95Win32.HangError) && this.noMain && (t.pc || t.task)) {
        t.state = 'done'; this.wakeWaiters(t);
        if (this.win16Held && this.win16Held.who === t) this.win16Held = null;
        log('warn', 'ne16', `thread ${t.id} ended: ${e.message}`);
        if (t.pc) { t.pc.trapped = e.message; (this.pcFaults || (this.pcFaults = [])).push({ pc: t.pc, why: e.message }); this.endProcess(t.pc, 0xffffffff); }
        else this.taskFault(t, e.message);
        return;
      }
      if (!(e instanceof window.W95Win32.HangError)) throw e;
      if (t.pc && t.pc.saverMode) {
        t.state = 'done'; t.pc.trapped = e.message;
        this.endProcess(t.pc, 0xffffffff);   // a saver must not hold the system's process-wide Win16 lock
      } else { t.state = 'hung'; this.hung(t, e); }   // it stays where it hung, holding what it held
    } finally { this.thread16 = caller; this.loadCtx16(main); }
  }
  // the lock the caller handed over comes back before it goes on: a thread whose time ran out in 16-bit code (inside
  // DIBENG's blit) holds it, and runs until it lets go, as the caller waits for the Win16Mutex
  for (let k = 0, h; caller && (h = this.win16Held && this.win16Held.who) && typeof h === 'object' && h !== caller && h.state === 'waiting' && k < 1000 && !this.trapped; k++) this.threads16(true, h);
  } finally { this.inThreads = wasIn; this.threadsNest--; this.asTask = wasAs; if (caller) { this.preempted = wasPreempted; this.runT0 = t0; this.imgUse(caller.pc); } else this.imgUse(null); }
};
/** a far call into 16-bit code that may yield: returns runAt's result (0 returned, 1 yielded) and leaves the
 *  CPU state as the code left it */
P.start16 = function (sel, off, args) {
  // a thread's stack gets a selector of its own (the per-level aliases are the main thread's, redefined as it calls);
  // a Win16 task's is in its own DGROUP, above its data and local heap, as the loader places it (SS = DS: its
  // exported functions take DS from SS)
  const k = !this.asTask && this.thread16 && this.thread16.task && this.thread16.task.dgStack ? this.thread16.task : null;
  const flat = u32(this.cpu.esp.value), base = k ? this.selBase(k.dgroup) : (flat - 0xfff0) & ~0xf;
  let ssel;
  if (k) ssel = k.dgroup;
  else if (this.thread16 && !this.asTask) ssel = this.thread16.ssel || (this.thread16.ssel = this.allocSels(base, 0x10000));
  else { ssel = L.STK + 8 * this.stackLevel++; this.setDesc(ssel, base, 0xffff, 0xf300); }
  this.seg('ss', ssel);
  let sp = k ? k.sp : flat - 16 - base;
  for (const [t, v] of args) { if (t === 'w') { sp -= 2; this.w16(base + sp, v); } else { sp -= 4; this.w32(base + sp, v); } }
  sp -= 2; this.w16(base + sp, L.SENT); sp -= 2; this.w16(base + sp, 0);
  this.cpu.esp.value = sp; this.seg('cs', sel);
  this.depth++; if (this.thread16 && !this.asTask) this.thread16.depth = this.depth;   // (a call made as a thread leaves the thread's own depth as it is)
  return this.runTop(u32(this.selBase(sel) + off));
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
// GlobalMasterHandle: DX:AX the selector of KERNEL's global heap information block (the Burgermaster), which TOOLHELP
// reads to walk the global heap; this KERNEL keeps its heap in its own tables, so the block is empty: an arena of no
// entries, whose counts read zero
def16('KERNEL', 28, '', 'l', function () {
  if (!this.masterSel) { const a = this.alloc(0x10000); this.u8.fill(0, a, a + 0x10000); this.masterSel = this.allocSels(a, 0x10000); }
  return (this.masterSel << 16) | this.masterSel;
});
def16('KERNEL', 202, 'l', 'l', () => 0);                                                               // RegisterPtrace: no debugger
def16('KERNEL', 29, '', 'v', function () {                                                             // Yield: as OldYield (#447)
  const t = thr(this, 0), top = !this.asTask && (this.thread16 ? this.depth === this.thread16.depth : this.depth === 0);
  // a message another task sent waiting in the task's queue (its wake bits' QS_SENDMESSAGE): received through USER's
  // UserYield, as KRNL386's Yield does for a task with a queue (MCIAVI's worker creates its window, sending to the
  // playing task, which yields in a loop until the worker is up)
  const user = t.task && t.queue && this.selValid(t.queue) && !t.userYield && (this.r16(this.selBase(t.queue) + 0x4a) & 0x40) && this.ne && this.ne.get('USER');
  if (user && user.meta && this.neExport(user, 332)) { t.userYield = true; try { this.user16(332, []); } finally { t.userYield = false; } return; }
  if (top && !t.yielded) { t.yielded = true; return YIELD; }
  if (!top) this.threads16(true);   // inside a call: the other tasks and threads run now, as Yield switches to them
  t.yielded = false;
});
def16('KERNEL', 150, 'w', 'v', function () { if (!this.atThreadTop()) this.threads16(true); });         // DirectedYield: inside a call, the other tasks run now (at the top level the host's scheduler runs them next)
// WaitEvent: the task sleeps until an event is posted to it. A thread that is not inside a call JS made gives up
// its slice once (timers, input and the other threads run) and the wait then ends; USER checks its queue again.
// LoadModule(name, parameter block { environment, far command tail, far show command, - }): a library loads as
// LoadLibrary loads it; a task (MMSYSTEM's MMTASK.TSK) gets an instance, a PSP with the command tail at 80h and a
// thread of its own that starts at its entry point the way the Win16 loader starts a task (DS its DGROUP, ES its PSP,
// DI its instance, BX its stack size, CX its heap size). Errors as LoadLibrary's
// AX the instance and, for a task, DX its task handle (as KRNL386 returns them; MMSYSTEM's mmTaskCreate takes DX)
def16('KERNEL', 45, 'sp', 'l', function (name, pb) {
  const rec = this.loadLibrary16(name, true, true);
  if (!rec && this.missing16) { this.missing16 = null; return 2; }   // (a DLL it needs is missing: file not found, as KRNL386 answers)
  if (!rec || !rec.meta) return this.loadError16(name);
  const hdr = rd.u32(rec.file, 0x3c), flags = rd.u16(rec.file, hdr + 0x0c);
  if (flags & 0x8000) { if (!rec.inited) { rec.inited = true; this.initNE(rec); } return rec.hInstance; }
  // a program whose last task has ended: KERNEL freed its module then, and loads it again from its file, so its data
  // starts as the file has it (kept, Minesweeper's ended game was its next start's, which quit at once)
  if (rec.taskModule && !K16['KERNEL.#48'][2].call(this, rec.hModule)) this.reloadData16(rec);
  const psp = this.alloc(0x100), pspSel = this.allocSels(psp, 0x100);
  this.u8.fill(0, psp, psp + 0x100); this.w16(psp, 0x20cd);
  let show = 1;
  if (pb) {
    const tail = this.lin(this.r32(pb + 2)), cs = this.lin(this.r32(pb + 6));
    // (the tail a Windows task's InitTask hands it, ES:BX: null-terminated, as KERNEL leaves it for WinMain's lpCmdLine)
    if (tail) { const n = Math.min(this.u8[tail], 126); this.u8[psp + 0x80] = n; this.u8.copyWithin(psp + 0x81, tail + 1, tail + 1 + n); this.u8[psp + 0x81 + n] = 0; }
    if (cs) show = this.r16(cs + 2);
  }
  const m = rec.meta, t = this.newThread(u32((m.segs[m.entry[0] - 1].sel << 16) | m.entry[1]), 0, 0x4000, false);
  if (self.W95_TASK_OWN_PC !== false) t.pc = null;   // a Win16 task is the Win16 process's (the system's), whoever starts it (GRPCONV's PROGMAN), not a thread of its starter
  t.task = { psp: pspSel, hInst: rec.hInstance, show, stack: rd.u16(rec.file, hdr + 0x12), heap: rd.u16(rec.file, hdr + 0x10), dgroup: rec.dgroup, mod: rec };
  rec.taskModule = true;
  // (the program as it was started, for a shared session's world: its file and command line, and its clock)
  const file = String(rec.fileName || rec.path || name).replace(/^.*\\/, '').toUpperCase(), tail = this.readA(psp + 0x81, 127).trim();
  Object.assign(t.task, { path: rec.path || `C:\\WINDOWS\\${file}`, cmdLine: tail ? `${file} ${tail}` : file, origin: this.nextOrigin || 'here' }, this.startClock());
  this.effect('exec', t.task.cmdLine);
  // its DGROUP: the data, then the stack (SP its top), then the local heap InitTask makes at the segment's end
  const dg = m.segs[m.autodata - 1], data = dg ? (Math.max(dg.minalloc || 0, dg.len || 0) + 15) & ~15 : 0;
  Object.assign(t.task, { sp: Math.min(0xfff0, (data + taskStack(t.task.stack || 1) + 15) & ~15) });
  // the module's one DGROUP holds the stack of its first live task only: a second instance (MMSYSTEM starts MMTASK
  // more than once) keeps a stack of its own, as this loader gives each module one DGROUP, not one per instance
  t.task.dgStack = ![...this.threadsById.values()].some(x => x !== t && x.task && x.task.dgStack && x.task.dgroup === rec.dgroup && x.state !== 'done');
  t.tdb = newTdb(this, { hInst: rec.hInstance, hModule: rec.hModule, name: rec.name });
  // (its first window brought to the front, worker.js frame; not a program another machine started in a shared session)
  if (t.task.origin !== 'remote') (this.fgWanted || (this.fgWanted = new Set())).add(t.tdb);
  // one event posted, as KERNEL starts a task: its first WaitEvent returns at once
  t.events = 1;
  // a task another task starts runs before LoadModule returns, until it first waits for a message or yields, as
  // KERNEL's start of a task yields to it (MMSYSTEM's sound task has its queue before PlaySound signals it)
  if (this.thread16 || this.depth) for (let k = 0; k < 500 && t.state !== 'done' && t.state !== 'hung' && !(t.state === 'waiting' && (t.slept || t.yielded || (t.wait && !t.wait.set))) && !this.trapped; k++) this.threads16(true, t);
  return u32((t.tdb << 16) | rec.hInstance);
});
/** a task's top-level windows, hidden ones too, front to back */
P.taskWindows = function (task) {
  const u = (o, args) => this.user16(o, args).ax, out = [];
  for (let h = u(262, [['w', u(286)], ['w', 5]]), n = 0; h && n < 512; h = u(262, [['w', h], ['w', 2]]), n++) if (u(224, [['w', h]]) === task) out.push(h);   // GW_CHILD, GW_HWNDNEXT, GetWindowTask
  return out;
};
/** a Windows program of the system bundle's 16-bit modules started as WinExec starts one: LoadModule with its command
 *  tail and show command (LOADPARMS). Its instance, else LoadModule's error */
P.winExec16 = function (name, tail = '', show = 1) {
  this.init16();
  const a = this.alloc(0x120), sel = this.allocSels(a, 0x120), t = String(tail).slice(0, 126);
  this.u8[a + 0x20] = t.length; for (let i = 0; i < t.length; i++) this.u8[a + 0x21 + i] = t.charCodeAt(i) & 0xff; this.u8[a + 0x21 + t.length] = 0x0d;
  this.w16(a + 0x10, 2); this.w16(a + 0x12, show);                                       // the show block: 2, nCmdShow
  this.w16(a, 0); this.w32(a + 2, u32((sel << 16) | 0x20)); this.w32(a + 6, u32((sel << 16) | 0x10)); this.w32(a + 10, 0);
  let r; try { r = K16['KERNEL.#45'][2].call(this, name, a); } finally { this.freeSels(sel); this.free(a); }   // (the tail is the task's PSP's now)
  return r > 32 ? r & 0xffff : r;
};
/** a 16-bit task started as KERNEL's LoadModule starts one (the system's first task, MSGSRV32.EXE): its task handle */
/** the system's first task (MSGSRV32.EXE), started as the system comes up: its thread is the appy-time thread (vmm.js appyCall) */
P.startTask16 = function (name) {
  this.init16(); const r = K16['KERNEL.#45'][2].call(this, name, 0); if (r <= 32) return 0;
  this.appyThread = [...this.threadsById.values()].find(t => t.tdb === r >>> 16) || null;
  return r >>> 16;
};
// InitTask: the starting task's registers (AX 1, ES:BX its command tail, CX its stack, DX its show command, SI its
// previous instance, DI its instance)
def16('KERNEL', 91, '', 'jmp', function () {
  const k = this.thread16 && this.thread16.task;
  if (!k) { this.ax(0); return this.retf16(0); }
  // the task's local heap, LocalInit(DS, 0, heap size) as KRNL386's InitTask makes it: at the end of the DGROUP as it
  // is now (VB3's startup has grown it and copied its runtime's data to its bottom), and its stack's bounds in the
  // DGROUP's header from the caller's SP (pStackTop, pStackMin, pStackBottom)
  if (!k.inited && k.dgStack) {
    k.inited = true; const ds = this.selBase(k.dgroup), sp = ((this.cpu.esp.value & 0xffff) + 4) & 0xffff;
    if (k.heap && !this.lheaps.has(k.dgroup | 1)) this.localInit(k.dgroup, 0, k.heap);
    this.w16(ds + 0x0a, Math.max(0x10, sp - taskStack(k.stack || 1))); this.w16(ds + 0x0c, sp); this.w16(ds + 0x0e, sp);
  }
  this.ax(1); this.seg('es', k.psp); this.cpu.ebx.value = lo16(this.cpu.ebx.value, 0x81); this.cpu.ecx.value = lo16(this.cpu.ecx.value, k.stack);
  this.cpu.edx.value = lo16(this.cpu.edx.value, k.show); this.cpu.esi.value = lo16(this.cpu.esi.value, 0); this.cpu.edi.value = lo16(this.cpu.edi.value, k.hInst);
  return this.retf16(0);
});
def16('KERNEL', 30, 'w', 'w', function () {
  const t = thr(this, 0), top = !this.asTask && (this.thread16 ? this.depth === this.thread16.depth : this.depth === 0);
  if (t.events > 0) { t.events--; t.slept = false; return 0; }   // an event posted to the task (PostEvent, its start): no wait
  if (top && !t.slept) { t.slept = true; P.idle.call(this); return YIELD; }
  if (!top) this.threads16(true);   // inside a call: the other tasks run, as the wait would let them
  t.slept = false; return 0;
});
// PostEvent: a Win16 task's next WaitEvent returns at once (an event counted on the task); a Win32 thread of the task
// waits on its queue's event instead (USER's MsgWaitForMultipleObjects adds it when the queue is woken by PostEvent,
// as USER's SetWakeBit2 does for such a queue), which is set
def16('KERNEL', 31, 'w', 'v', function (h) {
  const task = h || this.currentTask();
  for (const t of (this.threadsById || new Map()).values()) {
    if (t.tdb !== task || !t.state || t.state === 'done') continue;
    if (t.task) t.events = (t.events || 0) + 1;   // a Win16 task's next WaitEvent returns at once
    if (!t.queue || !this.selValid(t.queue)) continue;
    const e = ev16(this, this.r32(this.selBase(t.queue) + 0xc)); if (e) this.signal(e);
  }
});
def16('KERNEL', 32, 'wi', 'w', function () { return 0; });                                             // SetPriority
def16('KERNEL', 33, 'w', 'w', function () { return 0; });                                              // LockCurrentTask
def16('KERNEL', 49, 'wpi', 'w', function (h, buf, n) {                                                 // GetModuleFileName
  const m = this.neByHandle(h), f = m && m.fileName ? `C:\\WINDOWS\\SYSTEM\\${m.fileName}` : m && m.path ? m.path : (this.host && this.host.path) || '';
  return W(this, buf, f, n);
});
def16('KERNEL', 73, 'w', 'w', function (id) { if (id < 0xc000) return 0; if (this.latoms()) return (id & 0x3fff) << 2; return this.atomTable().byId.has(id) ? id : 0; });     // GetAtomHandle: the atom's entry
def16('KERNEL', 129, 'ssss', 'w', function (app, key, v, f) {                                         // WritePrivateProfileString
  P.iniIntent.call(this, f, app, key, v, P.caller16.call(this));
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
    // a 16-bit half already loaded (USER, GDI, KERNEL) is bound now: the 32-bit side's own code reads the target table
    // straight from its data (USER32's CreateWindowExA), not only through the relays
    const loaded = this.ne && this.ne.get(name.replace(/\.(EXE|DRV)$/, '')); if (loaded && loaded.meta) rel.bind();
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
  const who = () => (this.thread16 && this.thread16.pc && this.thread16.pc.path) || (this.thread16 ? 'thread ' + this.thread16.id : 'main');
  // (a connect that fails is kept for the probe too: the worker's console does not reach the page)
  const failed = why => { (this.thunkFails || (this.thunkFails = [])).push({ dll: this.readA(m32), to: name, f16: f16name, why, who: who() }); return 0; };
  const t16 = find(); if (!t16) { log('warn', 'ne16', `ThunkConnect32 ${this.readA(m32)} ${magic} no ${name} ${f16name} in ${who()}`); return failed('no 16-bit half'); }
  if (this.r32(t16) !== this.r32(td) || this.r32(t16 + 4) !== this.r32(td + 4)) { log('warn', 'ne16', `ThunkConnect32 ${this.readA(m32)} ${magic} ${name} ${f16name} checksum ${this.r32(td + 4).toString(16)} ${this.r32(t16 + 4).toString(16)} td ${td.toString(16)} in ${who()}`); return failed(`checksum ${this.r32(td + 4).toString(16)} ${this.r32(t16 + 4).toString(16)}`); }   // magic and checksum
  if (magic === 'LS01') {
    const table = this.lin(this.r32(t16 + 8)); this.w32(td + 8, table);
    (this.thunkConns || (this.thunkConns = [])).push({ dll: this.readA(m32), to: name, td, far: this.r32(t16 + 8), table, who: who() });   // (for the probe)
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
  // a Win16 task's flat stack is in its DGROUP (CallProc32W runs the 32-bit side there): the callback's SS is the
  // DGROUP itself, as Windows keeps a task's stack (its code takes DS from SS), not another selector for that memory
  const k = this.thread16 && this.thread16.task && this.thread16.task.dgStack ? this.thread16.task : null, dgb = k ? this.selBase(k.dgroup) : 0;
  const inDg = !!k && src >= dgb + 0x100 && src < dgb + this.selLimit(k.dgroup);
  const base = inDg ? dgb : (src - 0xf000) & ~0xf, ssel = inDg ? k.dgroup : this.stackSel(base);
  const rec = { ebx: this.reg('ebx'), esi: this.reg('esi'), edi: this.reg('edi'), ebp: this.reg('ebp'), esp: this.reg('esp'), ret32, done, ssel: inDg ? 0 : ssel };
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
  const to = u32(rec.done.call(this, rec));
  if (to < 0x10000) (this.nullJumps || (this.nullJumps = [])).push({ ret16: true, to, esp: rec.esp, popped, sp: this.cpu.esp.value & 0xffff, sp0: rec.sp0, ss: this.cpu.ss.value & 0xffff, ssel: rec.ssel, ret32: rec.ret32 });   // (diagnostic: a thunk's way back that goes nowhere)
  return to;
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
K('#91', 1, function (buf) { this.writeA(buf, ''); });
// K32WOW*: the 16-bit memory and handles a Win32 program reaches through WOW32.DLL (whose exports jump here), as
// WinHelp reads the request block a 16-bit WinHelp call hands it. Far pointers are selector:offset; handles of USER and
// GDI objects are the same 16-bit values on both sides
const segptr = (p, h) => (p.gblock(h) ? (p.gsel(h) << 16) >>> 0 : 0);
K('#60', 1, function (h) { return segptr(this, h); });                                                                      // WOWGlobalLock16
K('#61', 1, function (h) { return this.gblock(h) ? 1 : 0; });                                                               // WOWGlobalUnlock16
K('#65', 2, function (h, pcb) { const b = this.gblock(h); if (pcb) this.w32(pcb, b ? b.size : 0); return segptr(this, h); });   // WOWGlobalLockSize16
K('#59', 2, function (flags, n) { return this.globalAlloc16(flags & 0xffff, n); });                                         // WOWGlobalAlloc16
K('#62', 1, function (h) { return K16['KERNEL.#17'][2].call(this, h & 0xffff); });                                         // WOWGlobalFree16
K('#63', 3, function (flags, n, ph) { const h = this.globalAlloc16(flags & 0xffff, n); if (ph) this.w16(ph, h); return segptr(this, h); });   // WOWGlobalAllocLock16
K('#64', 1, function (vp) { return K16['KERNEL.#17'][2].call(this, vp >>> 16) ? 0 : 1; });                                 // WOWGlobalUnlockFree16
K('#56', 3, function (vp, n, pm) { return pm ? this.lin(vp) : ((vp >>> 16) << 4) + (vp & 0xffff); });                     // WOWGetVDMPointer
K('#68', 3, function (vp, n, pm) { return pm ? this.lin(vp) : ((vp >>> 16) << 4) + (vp & 0xffff); });                     // WOWGetVDMPointerFix
K('#69', 1, () => 0);                                                                                                       // WOWGetVDMPointerUnfix
K('#57', 2, function (h) { return h & 0xffff; });                                                                           // WOWHandle32
K('#58', 2, function (h) { return h & 0xffff; });                                                                           // WOWHandle16
K('#66', 0, () => 0);                                                                                                       // WOWYield16: the host's scheduler runs the others between slices
K('#67', 1, () => 0);                                                                                                       // WOWDirectedYield16
// WOWCallback16(16:16 function, dword): the function called with the dword (Pascal), DX:AX back; WOWCallback16Ex
// (function, flags, argument bytes, arguments, return code): the arguments as words or dwords as given, Pascal or C
K('#54', 2, function (fn, arg) { return this.call16(fn >>> 16, fn & 0xffff, [['l', arg]]).dxax >>> 0; });
K('#55', 5, function (fn, flags, cb, pargs, pret) {
  const n = cb >>> 2, args = []; for (let i = 0; i < n; i++) args.push(['l', this.r32(pargs + 4 * i)]);
  if (!(flags & 1)) args.reverse();   // WCB16_PASCAL (0): the first argument pushed first
  const r = this.call16(fn >>> 16, fn & 0xffff, args).dxax >>> 0; if (pret) this.w32(pret, r); return 1;
});                                                       // PK16FNF: no prefix for 16-bit file names
KR('K32Thk1632Epilog', function () { return ret32(this); });
K('#17', 0, () => 0);                                      // CommonUnimpStub
K('#18', 2, function (pid, off) { return pdw(this, pid, off | 0)[off | 0] >>> 0; });   // GetProcessDword
// the daylight-saving check Explorer makes at start and on each WM_TIMECHANGE: a nonzero answer when KERNEL32 has just
// moved the clock across the zone's transition (Explorer then broadcasts the time change). The host's clock already
// carries the zone's offset, so KERNEL32 never moves it
K('#99', 1, () => 0);
K('#23', 1, () => 0);                                      // GDIReallyCares (marks a handle's object as one GDI tracks)
K('#38', 0, () => 0); K('#39', 0, () => 0);
KR('#33', function () { return ret32(this); });    // frees 16-bit blocks a thread queued for release (thread flag 20h); none are queued here
K('#48', 1, function (p) { if (p) this.w32(p, 0); return 0; });   // ReleaseThunkLock
// USER32.DLL's start-up: the Win16Lock it takes around every call into USER.EXE, and KERNEL's 16-bit system variables
// (a block USER32 writes into). One thread runs here, so the lock has nothing to exclude.
K('#93', 1, function (pp) { if (!this.win16Lock) this.win16Lock = this.alloc(0x40); this.w32(pp, this.win16Lock); return 0; });   // GetpWin16Lock
K('#92', 0, function () { if (!this.pk16SysVar) this.pk16SysVar = this.alloc(0x40); return this.pk16SysVar; });            // GetPK16SysVar
// _EnterSysLevel / _LeaveSysLevel: the levels a thread holds (the Win16Lock among them), which it keeps when its time
// runs out there (holdWin16)
K('#86', 1, function () { this.sysLevel = (this.sysLevel || 0) + 1; return 0; });
// (EAX is the caller's across both, as KERNEL32's own keep it: GDI32 takes the lock around an object's lookup and
// returns the result it has in EAX straight after leaving: GetObjectType)
K('#97', 1, function () { this.sysLevel = Math.max(0, (this.sysLevel || 0) - 1); return this.reg('eax'); });
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
K('#93', 1, function (p) { if (p) this.w32(p, 0); return 0; });   // GetpWin16Lock
K('#96', 0, () => 1);
K('#98', 1, function () { return this.reg('eax'); });
K('GetProcessFlags', 1, () => 0);
K('ConvertToGlobalHandle', 1, h => h);
K('ReleaseMutex', 1, () => 1);   // one processor runs every thread here: a mutex has no one to keep out
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
  if (this.thread16) this.thread16.waitOn = { hs, all, ms };   // (for a probe)
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
  // inside a call (the waiting code cannot give up its slice): the other threads and processes each get a turn, as
  // the wait would let them run, and the objects are looked at again
  if (ms && !top && this.waitNested) {
    this.waitNested(() => (all ? objs.every(isSet) : objs.some(isSet)));
    if (all ? objs.every(isSet) : objs.some(isSet)) {
      t.wake = 0;
      if (all) { for (const e of objs) if (e && !e.manual) e.set = false; return 0; }
      const i = objs.findIndex(isSet); if (objs[i] && !objs[i].manual) objs[i].set = false; return i;
    }
  }
  if (!ms || !top) { t.wake = 0; return 0x102; }
  // a wait without end, in a thread: blocked until one of its objects is set, an APC arrives (alertable) or a thread
  // it waits for ends; the scheduler does not run it until then, and it checks its wait again when it runs
  if (ms === 0xffffffff && this.thread16) {
    t.blocked = true; t.alertWait = alertable;
    for (const h of hs) { const o = this.obj(h); if (o) (o.waiters = o.waiters || new Set()).add(t); const w = o && (o.kind === 'thread' ? this.threadsById && this.threadsById.get(o.id) : o.kind === 'process' ? o.task || (this.procs && this.procs.get(o.pid)) : null); if (w) (w.waiters = w.waiters || new Set()).add(t); }
    return YIELD;
  }
  if (!t.wake) t.wake = ms === 0xffffffff ? Infinity : this.now() + ms;
  else if (this.now() >= t.wake) { t.wake = 0; return 0x102; }
  return YIELD;
}
// SleepEx alertable: the thread's queued APCs run first and it returns WAIT_IO_COMPLETION, as the waits do (a wave's
// completion routine, itself run as an APC, sleeps alertably for the buffers still to complete: their APCs run here)
const sleep32 = API.KERNEL32.SleepEx[1];
K('SleepEx', 2, function (ms, alertable) {
  if (alertable && native32(this)) {
    const q = apcs(this, this.currentThreadId());
    if (q.length) { const t = this.thread16 || (this.mainSleep = this.mainSleep || {}); t.wake = 0; for (const a of q.splice(0)) this.call(a.proc, [a.data]); return 0xc0; }
  }
  return sleep32.call(this, ms, alertable);
});
K('WaitForSingleObject', 2, function (h, ms) { return wait32.call(this, [h], false, ms, false); });
K('WaitForSingleObjectEx', 3, function (h, ms, al) { return wait32.call(this, [h], false, ms, !!al); });
K('WaitForMultipleObjects', 4, function (n, ph, all, ms) { return wait32.call(this, [...Array(n)].map((_, i) => this.r32(ph + 4 * i)), !!all, ms, false); });
K('WaitForMultipleObjectsEx', 5, function (n, ph, all, ms, al) { return wait32.call(this, [...Array(n)].map((_, i) => this.r32(ph + 4 * i)), !!all, ms, !!al); });
// critical sections, owned by a thread (recursively) until it leaves them as often as it entered: one another thread
// owns blocks the caller, which gives up the processor at its top level and enters once the owner has left (MPR's
// client and MPREXE's server hand each request over by them, made global). Inside a call that cannot give up its
// slice the other threads each get a turn first, and the section is then taken as it is
const crit = (p, cs) => { p.critSecs = p.critSecs || new Map(); if (!p.critSecs.has(cs)) p.critSecs.set(cs, { owner: 0, count: 0, waiters: new Set() }); return p.critSecs.get(cs); };
K('EnterCriticalSection', 1, function (cs) {
  const c = crit(this, cs), tid = this.currentThreadId();
  if (c.owner && c.owner !== tid && !(this.threadsById && this.threadsById.get(c.owner) && this.threadsById.get(c.owner).state === 'done')) {
    if (this.thread16 && native32(this) && this.atThreadTop()) { c.waiters.add(this.thread16); this.thread16.blocked = true; return YIELD; }
    if (this.waitNested) this.waitNested(() => !c.owner);
  }
  if (c.owner !== tid) { c.owner = tid; c.count = 0; }
  c.count++;
});
K('LeaveCriticalSection', 1, function (cs) {
  const c = crit(this, cs); if (c.owner !== this.currentThreadId()) return;
  if (--c.count > 0) return;
  c.owner = 0; for (const t of c.waiters) t.blocked = false; c.waiters.clear();
});
// (a section made new, or deleted, while threads wait on it: they are let go, and enter it as it is now. A DLL's start in
// another process makes the sections in its shared data again, SHELL32's as RUNDLL32 loads it, while a thread of this
// one waited on them: it waited for good)
const critDrop = (p, cs) => { const c = p.critSecs && p.critSecs.get(cs); if (!c) return; for (const t of c.waiters) t.blocked = false; p.critSecs.delete(cs); };
const critInit = function (cs) { this.u8.fill(0, cs, cs + 24); critDrop(this, cs); };
K('InitializeCriticalSection', 1, critInit);
K('ReinitializeCriticalSection', 1, critInit);
K('DeleteCriticalSection', 1, function (cs) { critDrop(this, cs); });
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
  let loaded = [...(this.vxds || new Map()).values()].find(v => v.inited && v.name.toUpperCase() === m[1].toUpperCase());   // any VxD loaded by that name
  // else a dynamic VxD of that name, loaded as VWIN32 loads it for the open (SYS_DYNAMIC_DEVICE_INIT)
  if (!loaded && !VXD_FILES[m[1].toUpperCase()] && this.vxdLoad && ((window.W95SYSTEM || {}).vxds || {})[m[1].toUpperCase() + '.VXD']) loaded = this.vxdLoad(m[1].toUpperCase() + '.VXD');
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
window.W95NE16 = { K16, NAMES16, names16, L, def16, INTS, VXD_API, CR, regStr, KERNEL_EQUATES };
})();
