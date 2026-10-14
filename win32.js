'use strict';
// Win32 personality for statically recompiled guest code (see tools/recomp.py).
// Loads a PE image from the in-memory file system into wasm linear memory,
// binds its imports to JS implementations of the KERNEL32/USER32/GDI32 subset
// the Windows 95 screen savers use, and runs the recompiled blocks. GDI output
// goes to a Canvas 2D surface.
(() => {
// guest address space: low runtime area, stack, images at 0x400000/0x1000000, native DLLs from 0x1800000,
// heap, then per-module block lookup tables from 0x6000000
const LAYOUT = { SENTINEL: 0xFFFFFFF0, THUNK: 0xFFFF0000, THUNK16: 0xFFFE0000, FPU: 0x10000, TIB: 0x11000, SCRATCH: 0x12000,
  STACK_LO: 0x100000, STACK_TOP: 0x3ffff0, HEAP: 0x02000000, HEAP_END: 0x06000000 };
const YIELD = Symbol('yield');   // returned by an API implementation to suspend the guest at depth 0
const TICK_MS = 65536 * 1000 / 1193182;   // PIT channel 0 period, 54.925 ms
const CPU_REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb'];
const WM = { NULL: 0, CREATE: 1, DESTROY: 2, MOVE: 3, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, KILLFOCUS: 8, PAINT: 0xf, CLOSE: 0x10,
  QUIT: 0x12, ERASEBKGND: 0x14, SHOWWINDOW: 0x18, ACTIVATEAPP: 0x1c, SETCURSOR: 0x20, NCCREATE: 0x81, NCDESTROY: 0x82,
  NCACTIVATE: 0x86, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102, SYSKEYDOWN: 0x104, SYSCOMMAND: 0x112, TIMER: 0x113,
  MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, RBUTTONDOWN: 0x204, MBUTTONDOWN: 0x207, INITDIALOG: 0x110, COMMAND: 0x111 };

class GuestError extends Error {}

// ---------------------------------------------------------------- small helpers
const u32 = v => v >>> 0;
const rgbOf = c => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff];
const css = ([r, g, b]) => `rgb(${r},${g},${b})`;

// ---------------------------------------------------------------- process
class Process {
  /**
   * file/module/meta: the executable image, its recompiled module and metadata.
   * dlls: Map of upper-case DLL name -> { file, module, meta } for Microsoft DLLs that run natively;
   * imports from any other DLL bind to the JS implementations in API.
   * host: { fs, width, height, surface(hwnd, w, h) -> CanvasRenderingContext2D, now(), cursor() -> {x,y}, exited(code) }
   */
  constructor(file, module, meta, host, cmdline, dlls = new Map()) {
    this.meta = meta; this.host = host; this.fs = host.fs; this.dlls = dlls;
    this.mem = new WebAssembly.Memory({ initial: meta.layout.pages, maximum: meta.layout.pages });
    this.cpu = {};
    for (const n of CPU_REGS) this.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'fcw' ? 0x37f : 0);
    this.depth = 0; this.exitCode = null; this.trapped = null; this.waiting = false; this.lastYield = 0;
    this.t0 = host.now();
    this.thunks = []; this.thunkByName = new Map();
    this.handles = new Map(); this.nextHandle = 0x100;
    this.windows = new Map(); this.classes = new Map(); this.queue = []; this.timers = []; this.quit = null;
    this.heapTop = LAYOUT.HEAP; this.freeList = new Map(); this.allocs = new Map();
    const math = { fsin: Math.sin, fcos: Math.cos, ftan: Math.tan, fatan2: Math.atan2, fexp2: x => Math.pow(2, x), flog2: Math.log2,
      fmod: (a, b) => a % b, frem: (a, b) => a - b * Math.round(a / b), f80load: a => this.f80load(a), f80store: (a, v) => this.f80store(a, v), btrace: e => { if (window.W95BTRACE) window.W95BTRACE(e >>> 0); } };
    this.imports = { env: { mem: this.mem, api: e => this.api(e), trap: (e, c) => this.trap(e, c), ...math }, cpu: this.cpu };
    this.modules = []; this.byName = new Map(); this.inits = [];
    this.exe = this.loadImage(file, module, meta, 'EXE');
    this.base = this.exe.base;
    this.setupStack(cmdline);
    for (const m of this.inits) this.call(m.meta.entry, [m.base, 1, 0]);      // DllMain(DLL_PROCESS_ATTACH)
    this.inits = [];
  }
  get u8() { return new Uint8Array(this.mem.buffer); }
  get dv() { return new DataView(this.mem.buffer); }
  r32(a) { return this.dv.getUint32(a, true); }
  w32(a, v) { this.dv.setUint32(a, v >>> 0, true); }
  r16(a) { return this.dv.getUint16(a, true); }
  w16(a, v) { this.dv.setUint16(a, v & 0xffff, true); }
  r8(a) { return this.u8[a]; }
  i32(a) { return this.dv.getInt32(a, true); }
  readA(p, max = 65536) { if (!p) return null; const u = this.u8; let s = ''; for (let i = 0; i < max && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; }
  readW(p, max = 65536) { if (!p) return null; let s = ''; for (let i = 0; i < max; i++) { const c = this.r16(p + 2 * i); if (!c) break; s += String.fromCharCode(c); } return s; }
  writeA(p, s, max) {
    const b = window.W95FS.encode(s), n = max === undefined ? b.length : Math.min(b.length, max - 1);
    this.u8.set(b.subarray(0, n), p); this.u8[p + n] = 0; return n;
  }
  reg(n, v) { if (v === undefined) return this.cpu[n].value >>> 0; this.cpu[n].value = v | 0; }

  // ---- loading: map sections, relocate, bind imports, instantiate the recompiled module
  loadImage(f, module, meta, name) {
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength), u8 = this.u8;
    const p = dv.getUint32(0x3c, true), opt = p + 24, pref = dv.getUint32(opt + 28, true), base = meta.base;
    u8.set(f.subarray(0, dv.getUint32(opt + 60, true)), base);
    const nsec = dv.getUint16(p + 6, true), shdr = opt + dv.getUint16(p + 20, true);
    for (let i = 0; i < nsec; i++) {
      const o = shdr + 40 * i, vs = dv.getUint32(o + 8, true), va = dv.getUint32(o + 12, true), rs = dv.getUint32(o + 16, true), ro = dv.getUint32(o + 20, true);
      u8.fill(0, base + va, base + va + Math.max(vs, rs));
      u8.set(f.subarray(ro, ro + Math.min(rs, vs || rs)), base + va);
    }
    const dir = k => dv.getUint32(opt + 96 + 8 * k, true);
    if (base !== pref) {
      const delta = (base - pref) >>> 0;
      for (let o = base + dir(5), end = o + dv.getUint32(opt + 96 + 5 * 8 + 4, true); o < end;) {
        const page = this.r32(o), sz = this.r32(o + 4); if (!sz) break;
        for (let k = 8; k < sz; k += 2) { const e = this.r16(o + k); if (e >> 12 === 3) { const a = base + page + (e & 0xfff); this.w32(a, this.r32(a) + delta); } }
        o += sz;
      }
    }
    const rec = { name, base, size: dv.getUint32(opt + 56, true), meta, rsrc: dir(2), exports: new Map(), run: null };
    this.modules.push(rec); this.byName.set(name, rec);
    const ex = dir(0);
    if (ex) {
      const e = base + ex, nf = this.r32(e + 20), nn = this.r32(e + 24), fa = base + this.r32(e + 28), na = base + this.r32(e + 32), oa = base + this.r32(e + 36), obase = this.r32(e + 16);
      for (let k = 0; k < nf; k++) { const r = this.r32(fa + 4 * k); if (r) rec.exports.set('#' + (obase + k), base + r); }
      for (let k = 0; k < nn; k++) { const r = this.r32(fa + 4 * this.r16(oa + 2 * k)); if (r) rec.exports.set(this.readA(base + this.r32(na + 4 * k)), base + r); }
    }
    for (let d = base + dir(1); dir(1) && this.r32(d + 12); d += 20) {
      const dll = this.readA(base + this.r32(d + 12)).toUpperCase().replace(/\.DLL$/, '');
      const iat = base + this.r32(d + 16); let lut = base + (this.r32(d) || this.r32(d + 16));
      const native = this.loadDll(dll);
      for (let k = 0; ; k++, lut += 4) {
        const v = this.r32(lut); if (!v) break;
        const nm = v & 0x80000000 ? '#' + (v & 0xffff) : this.readA(base + v + 2);
        const addr = native && native.exports.get(nm);
        this.w32(iat + 4 * k, addr || this.thunkFor(dll, nm));
      }
    }
    rec.run = new WebAssembly.Instance(module, this.imports).exports.run;
    const look = new Uint32Array(this.mem.buffer, meta.lookup, meta.textHi - meta.textLo);
    meta.blocks.forEach((a, i) => { look[a - meta.textLo] = i + 1; });
    if (name !== 'EXE' && meta.entry) this.inits.push(rec);
    return rec;
  }
  loadDll(name) {
    if (this.byName.has(name)) return this.byName.get(name);
    const d = this.dlls.get(name); if (!d) return null;
    return this.loadImage(d.file, d.module, d.meta, name);
  }
  moduleFor(h) { return this.modules.find(m => m.base === h) || this.exe; }
  thunkFor(dll, nm) {
    const key = dll + '!' + nm;
    if (this.thunkByName.has(key)) return this.thunkByName.get(key);
    const def = (API[dll] || {})[nm];
    const t = LAYOUT.THUNK + this.thunks.length * 4;
    this.thunks.push({ dll, nm, def }); this.thunkByName.set(key, t);
    return t;
  }
  setupStack(cmdline) {
    const t = LAYOUT.TIB;
    this.w32(t, 0xffffffff); this.w32(t + 4, LAYOUT.STACK_TOP); this.w32(t + 8, LAYOUT.STACK_LO); this.w32(t + 0x18, t);
    this.cpu.fs.value = t;
    this.cmdPtr = LAYOUT.SCRATCH; this.writeA(this.cmdPtr, cmdline);
    this.reg('esp', LAYOUT.STACK_TOP);
    this.push(LAYOUT.SENTINEL);
    this.resumeEip = this.exe.meta.entry;
  }
  push(v) { const sp = this.reg('esp') - 4; this.reg('esp', sp); this.w32(sp, v); }

  // ---- execution
  /** Dispatch across modules until the sentinel (0), a yield (1) or a fault (2). */
  runAt(eip) {
    for (;;) {
      eip >>>= 0;
      if (eip === LAYOUT.SENTINEL) return 0;
      const m = eip >= LAYOUT.THUNK16 ? this.modules[0] : this.modules.find(x => eip >= x.meta.textLo && eip < x.meta.textHi);
      if (!m) {
        const next = this.dataCode && this.dataCode(eip);
        if (next !== undefined && next !== null) { eip = next; continue; }
        this.trapped = this.trapped || `jump to unmapped address ${eip.toString(16)}`; return 2;
      }
      const r = m.run(eip);
      if (r !== 3) return r;
      eip = this.reg('eip');
    }
  }
  /** Run until the guest blocks for messages or exits. Returns false once the process has exited. */
  slice() {
    if (this.exitCode !== null) return false;
    if (this.trapped) { this.fail(this.trapped); return false; }
    this.depth = 0; this.waiting = false; this.lastYield = this.now();
    const r = this.runAt(this.resumeEip);
    if (r === 1) { this.resumeEip = this.reg('eip'); return true; }
    if (r === 2 || this.trapped) { this.fail(this.trapped || `bad address ${this.reg('eip').toString(16)}`); return false; }
    if (this.exitCode === null) this.exitCode = this.reg('eax');
    this.host.exited(this.exitCode); return false;
  }
  /** Call a guest function (stdcall) from inside an API implementation. */
  call(addr, args) {
    if (!addr) return 0;
    if (this.cpu.ss.value & 0xffff) return this.callFlatFrom16(addr, args);
    const save = { esp: this.reg('esp'), eip: this.reg('eip') };
    for (let i = args.length - 1; i >= 0; i--) this.push(args[i]);
    this.push(LAYOUT.SENTINEL);
    this.depth++;
    const r = this.runAt(addr);
    this.depth--;
    if (r !== 0 || this.trapped) throw new GuestError(this.trapped || `guest callback did not return (${r} at ${this.reg('eip').toString(16)})`);
    const ret = this.reg('eax');
    this.reg('esp', save.esp); this.cpu.eip.value = save.eip;
    return ret;
  }
  fail(why) {
    if (this.failed) return;
    this.failed = true; this.trapped = why;
    console.error(`[win32] ${this.meta.name || ''} stopped: ${why}`);
    this.host.exited(-1, why);
  }
  trap(eip, code) {
    if (this.trapHook && this.trapHook(eip, code)) return;
    this.trapped = `${['divide error', 'unsupported instruction', 'jump to unmapped address', 'breakpoint'][code] || 'trap'} at ${u32(eip).toString(16)}`;
    if (code === 0) this.cpu.eip.value = LAYOUT.SENTINEL | 0;
  }
  api(eip) {
    if (u32(eip) < LAYOUT.THUNK) return this.api16(u32(eip));
    const t = this.thunks[(u32(eip) - LAYOUT.THUNK) >> 2];
    if (!t || !t.def) { this.trapped = `unimplemented import ${t ? t.dll + '!' + t.nm : u32(eip).toString(16)}`; return LAYOUT.SENTINEL; }
    const [nargs, fn] = t.def, sp = this.reg('esp');
    if (window.W95TRACE) window.W95TRACE(t, this);
    if (nargs === 'regs') {   // register-convention entry: the implementation moves ESP and picks the continuation
      try { return u32(fn.call(this)); }
      catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } throw e; }
    }
    const a = []; for (let i = 0; i < (nargs < 0 ? 8 : nargs); i++) a.push(this.r32(sp + 4 + 4 * i));
    let r;
    try { r = fn.apply(this, a); }
    catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } throw e; }
    if (r === YIELD) return -1;
    if (this.exitCode !== null) return LAYOUT.SENTINEL;
    this.reg('eax', r === undefined ? 0 : r);
    const ret = this.r32(sp);
    this.reg('esp', sp + 4 + (nargs < 0 ? 0 : 4 * nargs));
    return ret;
  }
  f80load(a) {
    const lo = this.r32(a), hi = this.r32(a + 4), se = this.r16(a + 8);
    const sign = se & 0x8000 ? -1 : 1, exp = se & 0x7fff;
    if (!exp && !lo && !hi) return 0 * sign;
    return sign * (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
  }
  f80store(a, v) {
    const s = v < 0 || Object.is(v, -0) ? 0x8000 : 0; v = Math.abs(v);
    if (v === 0) { this.w32(a, 0); this.w32(a + 4, 0); this.w16(a + 8, s); return; }
    const e = Math.floor(Math.log2(v)); const m = v / Math.pow(2, e - 63);
    this.w32(a, m % 4294967296); this.w32(a + 4, Math.floor(m / 4294967296)); this.w16(a + 8, s | (e + 16383));
  }

  // ---- heap
  alloc(n, zero = true) {
    n = (Math.max(n, 1) + 15) & ~15;
    const list = this.freeList.get(n);
    let p = list && list.length ? list.pop() : 0;
    if (!p) { p = this.heapTop; this.heapTop += n; if (this.heapTop > LAYOUT.HEAP_END) throw new GuestError('out of memory'); }
    this.allocs.set(p, n); if (zero) this.u8.fill(0, p, p + n);
    return p;
  }
  free(p) { const n = this.allocs.get(p); if (!n) return false; this.allocs.delete(p); if (!this.freeList.has(n)) this.freeList.set(n, []); this.freeList.get(n).push(p); return true; }
  realloc(p, n) { if (!p) return this.alloc(n); const old = this.allocs.get(p) || 0; if (n <= old) return p; const q = this.alloc(n, true); this.u8.copyWithin(q, p, p + old); this.free(p); return q; }

  // ---- handles
  newHandle(obj) { const h = this.nextHandle; this.nextHandle += 4; this.handles.set(h, obj); obj.handle = h; return h; }
  obj(h) { return this.handles.get(h) || STOCK.get(h) || null; }

  // ---- resources
  findResource(type, id, mod = this.exe) {
    if (!mod.rsrc) return null;
    const root = mod.base + mod.rsrc;
    const find = (dir, key) => {
      const nn = this.r16(dir + 12), ni = this.r16(dir + 14);
      for (let i = 0; i < nn + ni; i++) {
        const e = dir + 16 + 8 * i, nm = this.r32(e), off = this.r32(e + 4);
        let match;
        if (nm & 0x80000000) { const s = root + (nm & 0x7fffffff); match = typeof key === 'string' && this.readW(s + 2, this.r16(s)).toUpperCase() === key.toUpperCase(); }
        else match = key === undefined || nm === key;
        if (match) return off;
      }
      return null;
    };
    let o = find(root, type); if (o === null || !(o & 0x80000000)) return null;
    o = find(root + (o & 0x7fffffff), id); if (o === null || !(o & 0x80000000)) return null;
    o = find(root + (o & 0x7fffffff)); if (o === null) return null;
    const de = root + (o & 0x7fffffff);
    return { addr: mod.base + this.r32(de), size: this.r32(de + 4) };
  }
  resName(p) { return p >>> 16 ? this.readA(p) : p; }
  loadString(id, mod = this.exe) {
    const r = this.findResource(6, (id >> 4) + 1, mod); if (!r) return null;
    let a = r.addr;
    for (let i = 0; i < (id & 15); i++) a += 2 + 2 * this.r16(a);
    const n = this.r16(a); let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.r16(a + 2 + 2 * i));
    return s;
  }

  // ---- windows and messages
  absPos(w) { let x = 0, y = 0; for (let v = w; v; v = v.parentWin) { x += v.x; y += v.y; } return [x, y]; }
  post(hwnd, msg, wp = 0, lp = 0) { this.queue.push({ hwnd, msg, wp: u32(wp), lp: u32(lp) }); }
  sendMsg(hwnd, msg, wp = 0, lp = 0) {
    const w = this.windows.get(hwnd); if (!w) return 0;
    if (w.kind === 'control') return ctlMessage(this, w, msg, u32(wp), u32(lp));
    return this.call(w.proc, [hwnd, msg, u32(wp), u32(lp)]);
  }
  nextMessage(filter, remove) {
    const now = this.now();
    let i = this.queue.findIndex(m => !filter || m.hwnd === filter);
    if (i >= 0) { const m = this.queue[i]; if (remove) this.queue.splice(i, 1); return m; }
    if (this.quit !== null) return { hwnd: 0, msg: WM.QUIT, wp: this.quit, lp: 0 };
    for (const w of this.windows.values()) if (w.dirty && (!filter || w.hwnd === filter)) { return { hwnd: w.hwnd, msg: WM.PAINT, wp: 0, lp: 0 }; }
    for (const t of this.timers) if (now >= t.due && (!filter || t.hwnd === filter)) {
      if (remove) { t.due += t.ms; if (t.due <= now) t.due = now + t.ms; }   // late ticks coalesce, as WM_TIMER does
      return { hwnd: t.hwnd, msg: WM.TIMER, wp: t.id, lp: t.proc };
    }
    return null;
  }
  writeMsg(p, m) {
    this.w32(p, m.hwnd); this.w32(p + 4, m.msg); this.w32(p + 8, m.wp); this.w32(p + 12, m.lp);
    this.w32(p + 16, (this.now() - this.t0) | 0); const c = this.host.cursor(); this.w32(p + 20, c.x); this.w32(p + 24, c.y);
  }
  /** Earliest time something becomes deliverable, for the host scheduler. */
  now() { return this.host.now(); }
  /** Charge the guest instructions retired since the last call (counted by the translated code). */
  ready() {
    if (this.exitCode !== null || this.trapped) return false;
    if (this.dlgDone) return true;
    if (this.modal) return false;
    if (!this.waiting) return true;
    return !!this.nextMessage(0, false);
  }
  dispatchInput(msg, wp, lp) { for (const w of this.windows.values()) if (!w.parent || w.child) { this.post(w.hwnd, msg, wp, lp); break; } }
}

// ---------------------------------------------------------------- GDI objects
class Pen { constructor(style, width, color) { this.kind = 'pen'; this.style = style; this.width = Math.max(1, width); this.color = color; } }
class Brush { constructor(color, nul) { this.kind = 'brush'; this.color = color; this.nul = !!nul; } }
class Font { constructor(lf) { this.kind = 'font'; this.lf = lf; } }
class Palette { constructor(entries) { this.kind = 'palette'; this.entries = entries; } }
// Bitmaps start black (all bits zero). Monochrome bitmaps hold only black and white pixels.
class Bitmap {
  constructor(w, h, bpp = 32) {
    this.kind = 'bitmap'; this.w = w; this.h = h; this.bpp = bpp; this.mono = bpp === 1; this.ver = 0; this.conv = null;
    this.canvas = mkCanvas(Math.max(1, w), Math.max(1, h));
    const g = this.canvas.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
function mkCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return c;
}
const STOCK = new Map();
STOCK.set(0x8000 | 0, new Brush(0xffffff)); STOCK.set(0x8000 | 1, new Brush(0xc0c0c0)); STOCK.set(0x8000 | 2, new Brush(0x808080));
STOCK.set(0x8000 | 3, new Brush(0x404040)); STOCK.set(0x8000 | 4, new Brush(0)); STOCK.set(0x8000 | 5, new Brush(0, true));
STOCK.set(0x8000 | 6, new Pen(0, 1, 0xffffff)); STOCK.set(0x8000 | 7, new Pen(0, 1, 0)); STOCK.set(0x8000 | 8, new Pen(5, 1, 0));
for (const i of [10, 11, 12, 13, 14, 16, 17]) STOCK.set(0x8000 | i, new Font({ height: -11, weight: 400, face: 'MS Sans Serif' }));
STOCK.set(0x8000 | 15, new Palette(Array.from({ length: 20 }, (_, i) => [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [192, 220, 192], [166, 202, 240], [255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]][i])));
for (const [h, o] of STOCK) o.handle = h;

class DC {
  constructor(proc, ctx, w, h, hwnd) {
    this.kind = 'dc'; this.proc = proc; this.ctx = ctx; this.w = w; this.h = h; this.hwnd = hwnd;
    this.pen = STOCK.get(0x8007); this.brush = STOCK.get(0x8000); this.font = STOCK.get(0x800d); this.pal = STOCK.get(0x800f);
    this.bitmap = null; this.text = 0; this.bk = 0xffffff; this.bkMode = 2; this.align = 0; this.x = 0; this.y = 0;
    if (ctx) ctx.imageSmoothingEnabled = false;
  }
  rgb(c) {
    c = u32(c);
    const v = (c >>> 24) === 1 ? (this.pal.entries[c & 0xffff] || [0, 0, 0]) : rgbOf(c);
    if (this.bitmap && this.bitmap.mono) return v[0] + v[1] + v[2] > 382 ? [255, 255, 255] : [0, 0, 0];
    return v;
  }
  color(c) { return css(this.rgb(c)); }
  touch() { if (this.bitmap) this.bitmap.ver++; }
  // Window DCs draw relative to the window's screen position and are clipped to it.
  win() { return !this.bitmap && this.hwnd ? this.proc.windows.get(this.hwnd) : null; }
  origin() { const w = this.win(); return w ? this.proc.absPos(w) : [0, 0]; }
  pre() {
    const g = this.ctx, w = this.win();
    if (!w || !w.parentWin) { g.setTransform(1, 0, 0, 1, 0, 0); return g; }
    const [x, y] = this.proc.absPos(w);
    g.save(); g.setTransform(1, 0, 0, 1, x, y); g.beginPath(); g.rect(0, 0, w.w, w.h); g.clip(); this.clipped = true;
    return g;
  }
  post() { if (this.clipped) { this.ctx.restore(); this.clipped = false; } }
  // Win95 GDI lines are not antialiased: rasterize with Bresenham into 1px spans.
  line(x0, y0, x1, y1) {
    const p = this.pen; if (p.style === 5 || !this.ctx) return;
    const g = this.pre(); g.fillStyle = this.color(p.color); g.beginPath();
    const wd = p.width, o = wd >> 1;
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    let x = x0, y = y0, runX = x, runY = y, len = 0;
    const horiz = dx >= -dy;
    const flush = () => { if (!len) return; if (horiz) g.rect(Math.min(runX, runX + (len - 1) * sx) - o, runY - o, len + wd - 1, wd); else g.rect(runX - o, Math.min(runY, runY + (len - 1) * sy) - o, wd, len + wd - 1); };
    // end point excluded, like LineTo
    while (!(x === x1 && y === y1)) {
      if (!len) { runX = x; runY = y; }
      len++;
      const e2 = 2 * err; let mx = false, my = false;
      if (e2 >= dy) { err += dy; x += sx; mx = true; }
      if (e2 <= dx) { err += dx; y += sy; my = true; }
      if ((horiz && my) || (!horiz && mx)) { flush(); len = 0; }
    }
    flush(); g.fill(); this.post(); this.touch();
  }
  fill(x, y, w, h, color) { if (!this.ctx || w <= 0 || h <= 0) return; const g = this.pre(); g.fillStyle = this.color(color); g.fillRect(x, y, w, h); this.post(); this.touch(); }
  fontCss() {
    // lfHeight < 0: character (em) height; > 0: cell height = ascent + descent
    const lf = this.font.lf, face = FONT_MAP[(lf.face || '').toLowerCase()] || lf.face || 'W95 Arial';
    const style = `${lf.italic ? 'italic ' : ''}${lf.weight >= 600 ? 'bold ' : ''}`;
    const h = lf.height || -13, size = h < 0 ? -h : h * emPerCell(style, face);
    return `${style}${Math.max(1, Math.round(size))}px "${face}", "W95 Arial"`;
  }
}
const FONT_MAP = { 'ms sans serif': 'W95 Arial', 'times new roman': 'W95 Times', arial: 'W95 Arial', 'courier new': 'W95 Courier', wingdings: 'W95 Wingdings', system: 'W95 Arial' };

function dcOf(p, h) { const o = p.obj(h); if (!o || o.kind !== 'dc') throw new GuestError(`bad DC ${h}`); return o; }
function readRect(p, a) { return { l: p.i32(a), t: p.i32(a + 4), r: p.i32(a + 8), b: p.i32(a + 12) }; }
function writeRect(p, a, l, t, r, b) { p.w32(a, l); p.w32(a + 4, t); p.w32(a + 8, r); p.w32(a + 12, b); }
function readLogFont(p, a) {
  return { height: p.i32(a), width: p.i32(a + 4), escapement: p.i32(a + 8), weight: p.i32(a + 16), italic: p.r8(a + 20), underline: p.r8(a + 21),
    charset: p.r8(a + 23), face: p.readA(a + 28, 32) };
}
function wsprintf(p, fmt, argp) {
  let i = 0;
  const next = () => { const v = p.r32(argp + 4 * i); i++; return v; };
  return fmt.replace(/%([-#0 +]*)(\d*)(?:\.(\d+))?(h|l|ll)?([diuxXcsS%])/g, (m, flags, width, prec, len, t) => {
    if (t === '%') return '%';
    let s;
    if (t === 'd' || t === 'i') s = String(next() | 0);
    else if (t === 'u') s = String(next() >>> 0);
    else if (t === 'x' || t === 'X') { s = (next() >>> 0).toString(16); if (t === 'X') s = s.toUpperCase(); if (flags.includes('#')) s = '0x' + s; }
    else if (t === 'c') s = String.fromCharCode(next() & 0xff);
    else s = p.readA(next()) ?? '(null)';
    if (prec && 'sS'.includes(t)) s = s.slice(0, +prec);
    if (width && s.length < +width) s = flags.includes('-') ? s.padEnd(+width) : s.padStart(+width, flags.includes('0') && !'sS'.includes(t) ? '0' : ' ');
    return s;
  });
}

// ---------------------------------------------------------------- INI files and registry on the in-memory FS
function iniPath(file) {
  const f = file || 'WIN.INI';
  return /[\\:]/.test(f) ? f : 'C:\\WINDOWS\\' + f;
}
function iniRead(fs, file) {
  const out = new Map(); let cur = null;
  let text = ''; try { text = fs.readText(iniPath(file)); } catch (_) { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); let m;
    if ((m = /^\[(.*)\]$/.exec(l))) { cur = m[1]; if (!out.has(cur.toLowerCase())) out.set(cur.toLowerCase(), { name: cur, keys: new Map() }); cur = out.get(cur.toLowerCase()); }
    else if (cur && (m = /^([^=;]+?)\s*=\s*(.*)$/.exec(l))) cur.keys.set(m[1].toLowerCase(), { name: m[1], value: m[2] });
  }
  return out;
}
function iniGet(fs, file, sec, key) { const s = iniRead(fs, file).get((sec || '').toLowerCase()); const k = s && s.keys.get((key || '').toLowerCase()); return k ? k.value : null; }
function iniSet(fs, file, sec, key, value) {
  const ini = iniRead(fs, file); const sk = sec.toLowerCase();
  if (!ini.has(sk)) ini.set(sk, { name: sec, keys: new Map() });
  const s = ini.get(sk);
  if (key === null) ini.delete(sk);
  else if (value === null) s.keys.delete(key.toLowerCase());
  else s.keys.set(key.toLowerCase(), { name: key, value });
  let text = '';
  for (const v of ini.values()) { text += `[${v.name}]\r\n`; for (const k of v.keys.values()) text += `${k.name}=${k.value}\r\n`; text += '\r\n'; }
  fs.writeFile(iniPath(file), text);
}
const REGISTRY = new Map([
  ['hkcu\\control panel\\desktop', new Map([['screensaveusepassword', 0]])],
  ['hkcu\\control panel\\colors', new Map()],
]);
// the registry is saved with the disk; regOn hears every change
const regSubs = new Set();
const regOn = fn => { regSubs.add(fn); return () => regSubs.delete(fn); };
const regChanged = () => { for (const f of regSubs) { try { f(); } catch (e) { console.error(e); } } };
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const regDump = () => [...REGISTRY].map(([k, m]) => [k, [...m].map(([n, v]) => [n, v && v.data ? { type: v.type, name: v.name, data: b64(v.data) } : v])]);
const regRestore = list => {
  REGISTRY.clear();
  for (const [k, vals] of list) REGISTRY.set(k, new Map(vals.map(([n, v]) =>
    [n, v && typeof v.data === 'string' ? { type: v.type, name: v.name, data: Uint8Array.from(atob(v.data), c => c.charCodeAt(0)) } : v])));
};
const HKEY = { 0x80000000: 'hkcr', 0x80000001: 'hkcu', 0x80000002: 'hklm', 0x80000003: 'hku', 0x80000005: 'hkcc', 0x80000006: 'hkdd', 1: 'hkcr', 2: 'hkcu', 3: 'hklm' };

// ---------------------------------------------------------------- API table: [argc, impl]; argc < 0 = cdecl varargs
const API = {};
const def = (dll, name, n, fn) => { (API[dll] = API[dll] || {})[name] = [n, fn]; };
const TRUE = 1, FALSE = 0;

// KERNEL32
def('KERNEL32', 'GetCommandLineA', 0, function () { return this.cmdPtr; });
def('KERNEL32', 'GetStartupInfoA', 1, function (p) { this.u8.fill(0, p, p + 68); this.w32(p, 68); });
def('KERNEL32', 'GetModuleHandleA', 1, function (name) {
  if (!name) return this.exe.base;
  const m = this.byName.get((this.readA(name) || '').toUpperCase().replace(/\.DLL$/, '')); return m ? m.base : 0;
});
def('KERNEL32', 'GetModuleFileNameA', 3, function (h, buf, n) { return this.writeA(buf, this.host.path || 'C:\\WINDOWS\\SCRNSAVE.SCR', n); });
def('KERNEL32', 'ExitProcess', 1, function (code) { this.exitCode = code; this.host.exited(code); return 0; });
def('KERNEL32', 'TerminateProcess', 2, function (h, code) { this.exitCode = code; this.host.exited(code); return 1; });
def('KERNEL32', 'GetCurrentProcess', 0, () => 0xffffffff);
def('KERNEL32', 'GetTickCount', 0, function () { return (this.now() - this.t0 + 3600000) >>> 0; });
def('KERNEL32', 'Sleep', 1, function () { return 0; });
def('KERNEL32', 'GetVersion', 0, () => 0xc0000004);
def('KERNEL32', 'GetVersionExA', 1, function (p) { this.w32(p + 4, 4); this.w32(p + 8, 0); this.w32(p + 12, 950); this.w32(p + 16, 1); this.writeA(p + 20, ' B'); return 1; });
def('KERNEL32', 'LoadLibraryA', 1, function (n) {
  const name = (this.readA(n) || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, '');
  const native = this.loadDll(name);
  if (native) { const pending = this.inits; this.inits = []; for (const m of pending) this.call(m.meta.entry, [m.base, 1, 0]); return native.base; }
  return 0x10000000 | (this.newHandle({ kind: 'module', name }) & 0xffff);
});
def('KERNEL32', 'FreeLibrary', 1, () => 1);
def('KERNEL32', 'GetProcAddress', 2, function (h, name) {
  const nm = name >>> 16 ? this.readA(name) : '#' + name;
  const native = this.modules.find(x => x.base === h);
  if (native) return native.exports.get(nm) || 0;
  const m = this.obj(0x0000ffff & h) || { name: 'KERNEL32' };
  return API[m.name] && API[m.name][nm] ? this.thunkFor(m.name, nm) : 0;
});
def('KERNEL32', 'RtlUnwind', 4, () => 0);
def('KERNEL32', 'UnhandledExceptionFilter', 1, () => 1);
def('KERNEL32', 'SetUnhandledExceptionFilter', 1, () => 0);
def('KERNEL32', 'GetLastError', 0, function () { return this.lastError || 0; });
def('KERNEL32', 'SetLastError', 1, function (e) { this.lastError = e; });
def('KERNEL32', 'LocalAlloc', 2, function (f, n) { return this.alloc(n); });
def('KERNEL32', 'LocalFree', 1, function (p) { this.free(p); return 0; });
def('KERNEL32', 'GlobalAlloc', 2, function (f, n) { return this.alloc(n); });
def('KERNEL32', 'GlobalFree', 1, function (p) { this.free(p); return 0; });
def('KERNEL32', 'GlobalLock', 1, p => p);
def('KERNEL32', 'GlobalUnlock', 1, () => 1);
def('KERNEL32', 'HeapCreate', 3, () => 0x5000);
def('KERNEL32', 'HeapDestroy', 1, () => 1);
def('KERNEL32', 'GetProcessHeap', 0, () => 0x5000);
def('KERNEL32', 'HeapAlloc', 3, function (h, f, n) { return this.alloc(n, true); });
def('KERNEL32', 'HeapReAlloc', 4, function (h, f, p, n) { return this.realloc(p, n); });
def('KERNEL32', 'HeapFree', 3, function (h, f, p) { return this.free(p) ? 1 : 0; });
def('KERNEL32', 'HeapSize', 3, function (h, f, p) { return this.allocs.get(p) || 0; });
def('KERNEL32', 'VirtualAlloc', 4, function (a, n) { return this.alloc(n, true); });
def('KERNEL32', 'VirtualFree', 3, function (p) { this.free(p); return 1; });
def('KERNEL32', 'lstrlenA', 1, function (p) { return p ? this.readA(p).length : 0; });
def('KERNEL32', 'lstrcpyA', 2, function (d, s) { this.writeA(d, this.readA(s) || ''); return d; });
def('KERNEL32', 'lstrcpynA', 3, function (d, s, n) { this.writeA(d, this.readA(s) || '', n); return d; });
def('KERNEL32', 'lstrcatA', 2, function (d, s) { this.writeA(d, (this.readA(d) || '') + (this.readA(s) || '')); return d; });
def('KERNEL32', 'lstrcmpiA', 2, function (a, b) { const x = (this.readA(a) || '').toLowerCase(), y = (this.readA(b) || '').toLowerCase(); return x < y ? -1 >>> 0 : x > y ? 1 : 0; });
def('KERNEL32', 'lstrcmpA', 2, function (a, b) { const x = this.readA(a) || '', y = this.readA(b) || ''; return x < y ? -1 >>> 0 : x > y ? 1 : 0; });
def('KERNEL32', 'GetPrivateProfileIntA', 4, function (sec, key, dflt, file) {
  const v = iniGet(this.fs, this.readA(file), this.readA(sec), this.readA(key));
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
});
def('KERNEL32', 'GetProfileStringA', 5, function (sec, key, dflt, buf, n) { return API.KERNEL32.GetPrivateProfileStringA[1].call(this, sec, key, dflt, buf, n, 0); });
def('KERNEL32', 'GetSystemDirectoryA', 2, function (b, n) { return this.writeA(b, 'C:\\WINDOWS\\SYSTEM', n); });
def('KERNEL32', 'IsBadReadPtr', 2, function (a, n) { return !a || a + n > this.mem.buffer.byteLength ? 1 : 0; });
def('KERNEL32', 'IsBadWritePtr', 2, function (a, n) { return !a || a + n > this.mem.buffer.byteLength ? 1 : 0; });
def('KERNEL32', 'RtlMoveMemory', 3, function (d, s, n) { this.u8.copyWithin(d, s, s + n); });
def('KERNEL32', 'IsDBCSLeadByte', 1, () => 0);    // code page 1252 has no lead bytes
def('KERNEL32', 'MulDiv', 3, function (a, b, c) {    // rounded (a*b)/c, -1 on overflow or division by zero
  a |= 0; b |= 0; c |= 0; if (!c) return -1;
  const p = BigInt(a) * BigInt(b), C = BigInt(c), neg = (p < 0n) !== (C < 0n), ap = p < 0n ? -p : p, ac = C < 0n ? -C : C;
  let q = (ap + ac / 2n) / ac; if (neg) q = -q;
  return q > 2147483647n || q < -2147483648n ? -1 : Number(q);
});
def('KERNEL32', 'GetPrivateProfileStringA', 6, function (sec, key, dflt, buf, n, file) {
  const v = iniGet(this.fs, this.readA(file), this.readA(sec), this.readA(key));
  return this.writeA(buf, v === null ? (this.readA(dflt) || '') : v, n);
});
def('KERNEL32', 'WritePrivateProfileStringA', 4, function (sec, key, val, file) {
  try { iniSet(this.fs, this.readA(file), this.readA(sec), key ? this.readA(key) : null, val ? this.readA(val) : null); return 1; } catch (_) { return 0; }
});
def('KERNEL32', 'GetPrivateProfileStructA', 5, function (sec, key, buf, n, file) {
  const v = iniGet(this.fs, this.readA(file), this.readA(sec), this.readA(key));
  if (!v || v.length !== 2 * n + 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const b = parseInt(v.substr(2 * i, 2), 16); this.u8[buf + i] = b; sum += b; }
  return (sum & 0xff) === parseInt(v.substr(2 * n, 2), 16) ? 1 : 0;
});
def('KERNEL32', 'WritePrivateProfileStructA', 5, function (sec, key, buf, n, file) {
  let s = '', sum = 0;
  for (let i = 0; i < n; i++) { const b = this.u8[buf + i]; sum += b; s += b.toString(16).toUpperCase().padStart(2, '0'); }
  s += (sum & 0xff).toString(16).toUpperCase().padStart(2, '0');
  try { iniSet(this.fs, this.readA(file), this.readA(sec), this.readA(key), s); return 1; } catch (_) { return 0; }
});
def('KERNEL32', 'GetWindowsDirectoryA', 2, function (b, n) { return this.writeA(b, 'C:\\WINDOWS', n); });
def('KERNEL32', 'GetLocalTime', 1, function (p) {
  const d = new Date(); [d.getFullYear(), d.getMonth() + 1, d.getDay(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()].forEach((v, i) => this.w16(p + 2 * i, v));
});
def('KERNEL32', 'GetACP', 0, () => 1252);
def('KERNEL32', 'GetOEMCP', 0, () => 437);
def('KERNEL32', 'GetCPInfo', 2, function (cp, p) { this.u8.fill(0, p, p + 20); this.w32(p, 1); this.u8[p + 4] = 63; return 1; });
def('KERNEL32', 'GetEnvironmentStrings', 0, function () { const p = this.alloc(32); this.writeA(p, 'windir=C:\\WINDOWS'); return p; });
def('KERNEL32', 'GetEnvironmentStringsW', 0, () => 0);
def('KERNEL32', 'FreeEnvironmentStringsA', 1, () => 1);
def('KERNEL32', 'FreeEnvironmentStringsW', 1, () => 1);
def('KERNEL32', 'GetStdHandle', 1, () => 0xffffffff);
def('KERNEL32', 'GetFileType', 1, () => 0);
def('KERNEL32', 'SetHandleCount', 1, n => n);
def('KERNEL32', 'GetStringTypeA', 5, () => 0);
def('KERNEL32', 'GetStringTypeW', 4, () => 0);
def('KERNEL32', 'LCMapStringA', 6, () => 0);
def('KERNEL32', 'LCMapStringW', 6, () => 0);
def('KERNEL32', 'MultiByteToWideChar', 6, () => 0);
def('KERNEL32', 'WideCharToMultiByte', 8, () => 0);
def('KERNEL32', 'GetPriorityClass', 1, () => 0x20);
def('KERNEL32', 'SetPriorityClass', 2, () => 1);
def('KERNEL32', 'FindResourceA', 3, function (m, name, type) {
  const r = this.findResource(this.resName(type), this.resName(name)); if (!r) return 0;
  return this.newHandle({ kind: 'res', ...r });
});
def('KERNEL32', 'LoadResource', 2, function (m, h) { return h; });
def('KERNEL32', 'LockResource', 1, function (h) { const r = this.obj(h); return r ? r.addr : 0; });
def('KERNEL32', 'FreeResource', 1, () => 0);
def('KERNEL32', 'SizeofResource', 2, function (m, h) { const r = this.obj(h); return r ? r.size : 0; });

// threads, TLS, synchronization (one guest thread)
def('KERNEL32', 'InitializeCriticalSection', 1, function (p) { this.u8.fill(0, p, p + 24); });
def('KERNEL32', 'DeleteCriticalSection', 1, () => 0);
def('KERNEL32', 'EnterCriticalSection', 1, () => 0);
def('KERNEL32', 'LeaveCriticalSection', 1, () => 0);
def('KERNEL32', 'GetCurrentThreadId', 0, () => 0x51);
def('KERNEL32', 'GetCurrentProcessId', 0, () => 0x50);
def('KERNEL32', 'GetCurrentThread', 0, () => 0xfffffffe);
def('KERNEL32', 'TlsAlloc', 0, function () { this.tls = this.tls || []; this.tls.push(0); return this.tls.length - 1; });
def('KERNEL32', 'TlsFree', 1, () => 1);
def('KERNEL32', 'TlsGetValue', 1, function (i) { return (this.tls || [])[i] || 0; });
def('KERNEL32', 'TlsSetValue', 2, function (i, v) { this.tls = this.tls || []; this.tls[i] = v; return 1; });
def('KERNEL32', 'SetConsoleCtrlHandler', 2, () => 1);
def('KERNEL32', 'SetErrorMode', 1, () => 0);
def('KERNEL32', 'RaiseException', 4, function (code) { throw new GuestError(`exception ${u32(code).toString(16)}`); });
def('KERNEL32', 'FatalAppExitA', 2, function (a, m) { throw new GuestError(`FatalAppExit: ${this.readA(m)}`); });
def('KERNEL32', 'Beep', 2, () => 1);
def('KERNEL32', 'HeapValidate', 3, () => 1);
def('KERNEL32', 'HeapLock', 1, () => 1);
def('KERNEL32', 'HeapUnlock', 1, () => 1);
def('KERNEL32', 'HeapCompact', 2, () => 0);
def('KERNEL32', 'HeapWalk', 2, () => 0);
def('KERNEL32', 'LocalReAlloc', 3, function (p, n) { return this.realloc(p, n); });
def('KERNEL32', 'GlobalReAlloc', 3, function (p, n) { return this.realloc(p, n); });
def('KERNEL32', 'lstrlenW', 1, function (p) { return p ? this.readW(p).length : 0; });
def('KERNEL32', 'lstrcpyW', 2, function (d, s) { const t = this.readW(s) || ''; for (let i = 0; i <= t.length; i++) this.w16(d + 2 * i, i < t.length ? t.charCodeAt(i) : 0); return d; });
def('KERNEL32', 'GetUserDefaultLCID', 0, () => 0x409);
def('KERNEL32', 'GetSystemDefaultLCID', 0, () => 0x409);
def('KERNEL32', 'IsValidCodePage', 1, cp => (cp === 1252 || cp === 437 ? 1 : 0));
def('KERNEL32', 'GetLocaleInfoW', 4, () => 0);
def('KERNEL32', 'GetLocaleInfoA', 4, () => 0);
def('KERNEL32', 'CompareStringW', 6, () => 2);
def('KERNEL32', 'CompareStringA', 6, function (lc, f, a, na, b, nb) {
  const x = this.readA(a, na < 0 ? 65536 : na) || '', y = this.readA(b, nb < 0 ? 65536 : nb) || '';
  const ci = f & 1, X = ci ? x.toLowerCase() : x, Y = ci ? y.toLowerCase() : y; return X < Y ? 1 : X > Y ? 3 : 2;
});
def('KERNEL32', 'SetEnvironmentVariableA', 2, () => 1);
def('KERNEL32', 'GetEnvironmentVariableA', 3, () => 0);
const ftNow = () => BigInt(Date.now()) * 10000n + 116444736000000000n;
def('KERNEL32', 'GetSystemTime', 1, function (p) {
  const d = new Date(); [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].forEach((v, i) => this.w16(p + 2 * i, v));
});
def('KERNEL32', 'GetSystemTimeAsFileTime', 1, function (p) { const t = ftNow(); this.w32(p, Number(t & 0xffffffffn)); this.w32(p + 4, Number(t >> 32n)); });
def('KERNEL32', 'GetTimeZoneInformation', 1, function (p) { this.u8.fill(0, p, p + 172); this.w32(p, new Date().getTimezoneOffset()); return 0; });
def('KERNEL32', 'FileTimeToSystemTime', 2, function (ft, st) {
  const t = (BigInt(this.r32(ft + 4)) << 32n) | BigInt(this.r32(ft)), d = new Date(Number((t - 116444736000000000n) / 10000n));
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].forEach((v, i) => this.w16(st + 2 * i, v)); return 1;
});
def('KERNEL32', 'SystemTimeToFileTime', 2, function (st, ft) {
  const ms = Date.UTC(this.r16(st), this.r16(st + 2) - 1, this.r16(st + 6), this.r16(st + 8), this.r16(st + 10), this.r16(st + 12), this.r16(st + 14));
  const t = BigInt(ms) * 10000n + 116444736000000000n; this.w32(ft, Number(t & 0xffffffffn)); this.w32(ft + 4, Number(t >> 32n)); return 1;
});
def('KERNEL32', 'FileTimeToLocalFileTime', 2, function (a, b) { this.w32(b, this.r32(a)); this.w32(b + 4, this.r32(a + 4)); return 1; });

// file I/O on the in-memory disk. Win32 handles wrap W95FS file descriptors.
const FERR = e => (e && e.code) || 5;
function fsCall(p, fn, fail = 0) {
  try { const r = fn(); p.lastError = 0; return r; } catch (e) { if (!(e instanceof window.W95FS.FSError)) throw e; p.lastError = FERR(e); return fail; }
}
const fileOf = (p, h) => { const o = p.obj(h); return o && o.kind === 'file' ? o : null; };
const writeFindData = (p, a, i) => {
  p.u8.fill(0, a, a + 320); p.w32(a, i.attrs);
  const ft = (o, ms) => { const t = BigInt(Math.round(ms)) * 10000n + 116444736000000000n; p.w32(a + o, Number(t & 0xffffffffn)); p.w32(a + o + 4, Number(t >> 32n)); };
  ft(4, i.ctime); ft(12, i.atime); ft(20, i.mtime); p.w32(a + 32, i.size); p.writeA(a + 44, i.name, 260); p.writeA(a + 304, i.shortName || '', 14);
};
def('KERNEL32', 'CreateFileA', 7, function (name, access, share, sa, disp, flags) {
  const path = this.readA(name); const write = !!(access & 0x40000000), read = !!(access & 0x80000000) || !write;
  return fsCall(this, () => {
    const exists = this.fs.exists(path);
    if (disp === 1 && exists) throw new window.W95FS.FSError(80, path);           // CREATE_NEW
    if ((disp === 3 || disp === 5) && !exists) throw new window.W95FS.FSError(2, path); // OPEN_EXISTING / TRUNCATE_EXISTING
    if (exists && this.fs.stat(path).isDir) return this.newHandle({ kind: 'dirhandle', path });
    const mode = disp === 2 || disp === 5 ? (read ? 'w+' : 'w') : !exists ? (read ? 'w+' : 'w') : write ? 'r+' : 'r';
    return this.newHandle({ kind: 'file', fd: this.fs.open(path, mode), path });
  }, 0xffffffff);
});
def('KERNEL32', 'CloseHandle', 1, function (h) { const f = fileOf(this, h); if (f) fsCall(this, () => this.fs.close(f.fd)); this.handles.delete(h); return 1; });
def('KERNEL32', 'ReadFile', 5, function (h, buf, n, got) {
  const f = fileOf(this, h); if (!f) return 0;
  return fsCall(this, () => { const b = this.fs.read(f.fd, n); this.u8.set(b, buf); if (got) this.w32(got, b.length); return 1; });
});
def('KERNEL32', 'WriteFile', 5, function (h, buf, n, put) {
  const f = fileOf(this, h); if (!f) { if (put) this.w32(put, n); return 1; }
  return fsCall(this, () => { const k = this.fs.write(f.fd, this.u8.slice(buf, buf + n)); if (put) this.w32(put, k); return 1; });
});
def('KERNEL32', 'SetFilePointer', 4, function (h, lo, hip, how) { const f = fileOf(this, h); if (!f) return 0xffffffff; return fsCall(this, () => this.fs.seek(f.fd, lo | 0, how), 0xffffffff); });
def('KERNEL32', 'GetFileSize', 2, function (h, hi) { const f = fileOf(this, h); if (hi) this.w32(hi, 0); return f ? this.fs.fstat(f.fd).size : 0xffffffff; });
def('KERNEL32', 'SetEndOfFile', 1, function (h) { const f = fileOf(this, h); return f ? fsCall(this, () => (this.fs.truncate(f.fd), 1)) : 0; });
def('KERNEL32', 'FlushFileBuffers', 1, () => 1);
def('KERNEL32', 'LockFile', 5, () => 1);
def('KERNEL32', 'UnlockFile', 5, () => 1);
def('KERNEL32', 'GetFileInformationByHandle', 2, function (h, p) {
  const f = fileOf(this, h); if (!f) return 0; const i = this.fs.fstat(f.fd); this.u8.fill(0, p, p + 52); this.w32(p, i.attrs); this.w32(p + 36, i.size); this.w32(p + 40, 1); return 1;
});
def('KERNEL32', 'SetFileTime', 4, () => 1);
def('KERNEL32', 'GetFileAttributesA', 1, function (n) { return fsCall(this, () => this.fs.stat(this.readA(n)).attrs, 0xffffffff); });
def('KERNEL32', 'SetFileAttributesA', 2, function (n, a) { return fsCall(this, () => (this.fs.setAttrs(this.readA(n), a), 1)); });
def('KERNEL32', 'DeleteFileA', 1, function (n) { return fsCall(this, () => (this.fs.unlink(this.readA(n)), 1)); });
def('KERNEL32', 'MoveFileA', 2, function (a, b) { return fsCall(this, () => (this.fs.rename(this.readA(a), this.readA(b)), 1)); });
def('KERNEL32', 'CopyFileA', 3, function (a, b, fail) { return fsCall(this, () => (this.fs.copy(this.readA(a), this.readA(b), { overwrite: !fail }), 1)); });
def('KERNEL32', 'CreateDirectoryA', 2, function (n) { return fsCall(this, () => (this.fs.mkdir(this.readA(n)), 1)); });
def('KERNEL32', 'RemoveDirectoryA', 1, function (n) { return fsCall(this, () => (this.fs.rmdir(this.readA(n)), 1)); });
def('KERNEL32', 'GetCurrentDirectoryA', 2, function (n, b) { return this.writeA(b, this.fs.cwd.replace(/\\$/, (m, o) => (o > 2 ? '' : m)), n); });
def('KERNEL32', 'SetCurrentDirectoryA', 1, function (n) { return fsCall(this, () => (this.fs.chdir(this.readA(n)), 1)); });
def('KERNEL32', 'GetDriveTypeA', 1, function (n) { const l = ((this.readA(n) || this.fs.cwd)[0] || 'C').toUpperCase(); const v = this.fs.vols.get(l); return !v ? 1 : { removable: 2, fixed: 3, cdrom: 5 }[v.kind] || 3; });
def('KERNEL32', 'GetLogicalDrives', 0, function () { let m = 0; for (const v of this.fs.vols.values()) m |= 1 << (v.letter.charCodeAt(0) - 65); return m; });
def('KERNEL32', 'GetDiskFreeSpaceA', 5, function (n, spc, bps, free, total) {
  return fsCall(this, () => { const v = this.fs.statvfs(this.readA(n) || this.fs.cwd); const c = v.cluster;
    if (spc) this.w32(spc, c / 512); if (bps) this.w32(bps, 512); if (free) this.w32(free, Math.floor(v.free / c)); if (total) this.w32(total, Math.floor(v.total / c)); return 1; });
});
def('KERNEL32', 'FindFirstFileA', 2, function (pat, data) {
  const s = this.readA(pat); const dir = s.includes('\\') ? s.slice(0, s.lastIndexOf('\\')) || s.slice(0, 3) : this.fs.cwd, mask = s.slice(s.lastIndexOf('\\') + 1);
  return fsCall(this, () => {
    const list = this.fs.readdir(dir.length === 2 ? dir + '\\' : dir, mask);
    if (!list.length) throw new window.W95FS.FSError(2, s);
    writeFindData(this, data, list[0]); return this.newHandle({ kind: 'find', list, i: 1 });
  }, 0xffffffff);
});
def('KERNEL32', 'FindNextFileA', 2, function (h, data) { const f = this.obj(h); if (!f || f.i >= f.list.length) { this.lastError = 18; return 0; } writeFindData(this, data, f.list[f.i++]); return 1; });
def('KERNEL32', 'FindClose', 1, function (h) { this.handles.delete(h); return 1; });
def('KERNEL32', 'SearchPathA', 6, function (path, file, ext, n, buf, part) {
  const f = this.readA(file) + (ext && !/\.[^\\]*$/.test(this.readA(file)) ? this.readA(ext) : '');
  // an absolute name is only checked; a given path is the only place searched
  const dirs = /^([a-z]:)?\\/i.test(f) ? [''] : path ? this.readA(path).split(';') : [this.fs.cwd, 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS'];
  for (const d of dirs) {
    const full = d ? window.W95FS.join(d, f) : f;
    if (this.fs.exists(full)) { const r = this.fs.realpath(full); this.writeA(buf, r, n); if (part) this.w32(part, buf + r.lastIndexOf('\\') + 1); this.lastError = 0; return r.length; }
  }
  this.lastError = 2; return 0;
});
def('KERNEL32', 'CreateFileMappingA', 6, function (h) { const f = fileOf(this, h); return f ? this.newHandle({ kind: 'mapping', path: f.path }) : 0; });
def('KERNEL32', 'MapViewOfFile', 5, function (h) {
  const m = this.obj(h); if (!m) return 0;
  return fsCall(this, () => { const b = this.fs.readFile(m.path); const p = this.alloc(b.length + 1); this.u8.set(b, p); return p; });
});
def('KERNEL32', 'UnmapViewOfFile', 1, function (p) { this.free(p); return 1; });
def('KERNEL32', 'CreateFileW', 7, () => 0xffffffff);
def('KERNEL32', 'GetFullPathNameA', 4, function (n, len, buf, part) {
  const s = this.readA(n); const full = /^[a-z]:/i.test(s) ? s : window.W95FS.join(this.fs.cwd, s); this.writeA(buf, full, len);
  if (part) this.w32(part, buf + full.lastIndexOf('\\') + 1); return full.length;
});
def('KERNEL32', 'SetStdHandle', 2, () => 1);
def('KERNEL32', 'GetConsoleMode', 2, () => 0);
def('KERNEL32', 'SetConsoleMode', 2, () => 0);
def('KERNEL32', 'WriteConsoleA', 5, () => 1);
def('KERNEL32', 'DuplicateHandle', 7, function (a, h, b, out) { if (out) this.w32(out, h); return 1; });
def('KERNEL32', 'WaitForSingleObject', 2, () => 0);
def('KERNEL32', 'GetExitCodeProcess', 2, () => 0);
def('KERNEL32', 'CreateThread', 6, () => 0);
def('KERNEL32', 'ExitThread', 1, function (c) { this.exitCode = c; this.host.exited(c); });
def('KERNEL32', 'ResumeThread', 1, () => 0);
def('KERNEL32', 'SetLocalTime', 1, () => 0);
def('KERNEL32', 'CreatePipe', 4, () => 0);
def('KERNEL32', 'CreateProcessA', 10, () => 0);
def('KERNEL32', 'ReadConsoleA', 5, () => 0);
def('KERNEL32', 'ReadConsoleInputA', 4, () => 0);
def('KERNEL32', 'PeekConsoleInputA', 4, () => 0);
def('KERNEL32', 'GetNumberOfConsoleInputEvents', 2, () => 0);
def('KERNEL32', 'OutputDebugStringA', 1, () => 0);

// ADVAPI32: registry. Keys are lower-case paths under the root names; values keep their type and bytes.
const regKey = (path, create) => { if (!REGISTRY.has(path)) { if (!create) return null; const parts = path.split('\\'); for (let k = 1; k <= parts.length; k++) { const q = parts.slice(0, k).join('\\'); if (!REGISTRY.has(q)) REGISTRY.set(q, new Map()); } regChanged(); } return REGISTRY.get(path); };
const regPath = (p, hk, sub) => { const root = HKEY[hk] || (p.obj(hk) || {}).path; if (!root) return null; const s = sub ? (p.readA(sub) || '').toLowerCase().replace(/^\\+|\\+$/g, '') : ''; return s ? `${root}\\${s}` : root; };
const regVal = v => typeof v === 'number' ? { type: 4, data: new Uint8Array(new Uint32Array([v]).buffer) } : typeof v === 'string' ? { type: 1, data: window.W95FS.encode(v + '\0') } : v;
const regOpen = function (hk, sub, out, create) {
  const path = regPath(this, hk, sub); if (!path || !regKey(path, create)) return 2;
  if (out) this.w32(out, this.newHandle({ kind: 'key', path })); return 0;
};
def('ADVAPI32', 'RegOpenKeyA', 3, function (hk, sub, out) { return regOpen.call(this, hk, sub, out, false); });
def('ADVAPI32', 'RegOpenKeyExA', 5, function (hk, sub, opt, sam, out) { return regOpen.call(this, hk, sub, out, false); });
def('ADVAPI32', 'RegCreateKeyA', 3, function (hk, sub, out) { return regOpen.call(this, hk, sub, out, true); });
def('ADVAPI32', 'RegCreateKeyExA', 9, function (hk, sub, res, cls, opt, sam, sa, out, disp) {
  const path = regPath(this, hk, sub); const existed = REGISTRY.has(path);
  const r = regOpen.call(this, hk, sub, out, true); if (!r && disp) this.w32(disp, existed ? 2 : 1); return r;
});
def('ADVAPI32', 'RegCloseKey', 1, function (h) { if (!HKEY[h]) this.handles.delete(h); return 0; });
def('ADVAPI32', 'RegDeleteKeyA', 2, function (hk, sub) { const path = regPath(this, hk, sub); if (!REGISTRY.has(path)) return 2; for (const k of [...REGISTRY.keys()]) if (k === path || k.startsWith(path + '\\')) REGISTRY.delete(k); regChanged(); return 0; });
def('ADVAPI32', 'RegDeleteValueA', 2, function (hk, name) { const m = regKey(regPath(this, hk, 0)); if (!m) return 2; if (!m.delete((this.readA(name) || '').toLowerCase())) return 2; regChanged(); return 0; });
const regQuery = function (m, n, type, data, cb) {
  if (!m || !m.has(n)) return 2;
  const v = regVal(m.get(n)), size = v.data.length;
  if (type) this.w32(type, v.type);
  if (data && cb && this.r32(cb) < size) { this.w32(cb, size); return 234; }
  if (data) this.u8.set(v.data, data);
  if (cb) this.w32(cb, size);
  return 0;
};
def('ADVAPI32', 'RegQueryValueExA', 6, function (hk, name, res, type, data, cb) {
  return regQuery.call(this, regKey(regPath(this, hk, 0)), (this.readA(name) || '').toLowerCase(), type, data, cb);
});
def('ADVAPI32', 'RegQueryValueA', 4, function (hk, sub, data, cb) { return regQuery.call(this, regKey(regPath(this, hk, sub)), '', 0, data, cb); });
def('ADVAPI32', 'RegSetValueExA', 6, function (hk, name, res, type, data, n) {
  const m = regKey(regPath(this, hk, 0), true); m.set((this.readA(name) || '').toLowerCase(), { type, data: this.u8.slice(data, data + n), name: this.readA(name) || '' }); regChanged(); return 0;
});
def('ADVAPI32', 'RegSetValueA', 5, function (hk, sub, type, data, n) { const m = regKey(regPath(this, hk, sub), true); m.set('', { type: 1, data: window.W95FS.encode((this.readA(data) || '') + '\0') }); regChanged(); return 0; });
def('ADVAPI32', 'RegEnumKeyA', 4, function (hk, i, buf, n) {
  const path = regPath(this, hk, 0); const kids = [...REGISTRY.keys()].filter(k => k.startsWith(path + '\\') && !k.slice(path.length + 1).includes('\\'));
  if (i >= kids.length) return 259; this.writeA(buf, kids[i].slice(path.length + 1), n); return 0;
});
def('ADVAPI32', 'RegEnumValueA', 8, function (hk, i, name, cbName, res, type, data, cb) {
  const m = regKey(regPath(this, hk, 0)); if (!m) return 2; const e = [...m.entries()][i]; if (!e) return 259;
  const nm = (e[1] && e[1].name) || e[0]; this.writeA(name, nm, this.r32(cbName)); this.w32(cbName, nm.length);
  return regQuery.call(this, m, e[0], type, data, cb);
});
def('ADVAPI32', 'RegQueryInfoKeyA', 12, function (hk, cls, ccls, res, nsub, maxsub, maxcls, nval, maxname, maxval, sd, ft) {
  const path = regPath(this, hk, 0), m = regKey(path); if (!m) return 2;
  const kids = [...REGISTRY.keys()].filter(k => k.startsWith(path + '\\') && !k.slice(path.length + 1).includes('\\'));
  if (ccls) this.w32(ccls, 0); if (nsub) this.w32(nsub, kids.length); if (maxsub) this.w32(maxsub, Math.max(0, ...kids.map(k => k.length - path.length)));
  if (maxcls) this.w32(maxcls, 0); if (nval) this.w32(nval, m.size);
  if (maxname) this.w32(maxname, Math.max(0, ...[...m.keys()].map(k => k.length)));
  if (maxval) this.w32(maxval, Math.max(0, ...[...m.values()].map(v => regVal(v).data.length)));
  if (ft) { this.w32(ft, 0); this.w32(ft + 4, 0); } return 0;
});

// USER32
const SM = { 0: 'w', 1: 'h', 16: 'w', 17: 'h' };
def('USER32', 'GetSystemMetrics', 1, function (i) {
  if (SM[i]) return SM[i] === 'w' ? this.host.width : this.host.height;
  return { 2: 16, 3: 16, 4: 18, 5: 1, 6: 1, 7: 3, 8: 3, 11: 32, 12: 32, 13: 32, 14: 32, 15: 18, 32: 4, 33: 4 }[i] || 0;
});
def('USER32', 'SystemParametersInfoA', 4, function (act, ui, pv) {
  if (act === 14 && pv) this.w32(pv, this.host.saverTimeout || 600);
  if (act === 16 && pv) this.w32(pv, 1);
  return 1;
});
def('USER32', 'RegisterClassA', 1, function (p) {
  const cls = { style: this.r32(p), proc: this.r32(p + 4), extra: this.r32(p + 12), icon: this.r32(p + 20), cursor: this.r32(p + 24), brush: this.r32(p + 28), name: this.resName(this.r32(p + 36)) };
  this.classes.set(String(cls.name).toLowerCase(), cls); return 0xc000 + this.classes.size;
});
def('USER32', 'RegisterWindowMessageA', 1, function () { return 0xc100 + (this.nextHandle & 0xff); });
def('USER32', 'CreateWindowExA', 12, function (ex, cls, title, style, x, y, w, h, parent, menu, inst, param) {
  const c = this.classes.get(String(this.resName(cls)).toLowerCase());
  if (!c) return 0;
  const win = { kind: 'window', cls: c, proc: c.proc, style, ex, x: x | 0, y: y | 0, w: w | 0, h: h | 0, parent, child: !!(style & 0x40000000), dirty: true, title: this.readA(title) || '', extra: new Map() };
  const hwnd = this.newHandle(win); win.hwnd = hwnd; this.windows.set(hwnd, win);
  const pw = win.child ? this.windows.get(parent) : null;
  if (pw) { win.parentWin = pw; win.ctx = pw.ctx; } else win.ctx = this.host.surface(hwnd, win.w, win.h, win);
  const cs = this.alloc(48);
  [param, inst, menu, parent, h, w, y, x, style, title, cls, ex].forEach((v, i) => this.w32(cs + 4 * i, v));
  this.sendMsg(hwnd, WM.NCCREATE, 0, cs);
  if ((this.sendMsg(hwnd, WM.CREATE, 0, cs) | 0) === -1) { this.windows.delete(hwnd); return 0; }
  this.free(cs);
  this.sendMsg(hwnd, WM.SIZE, 0, (win.h << 16) | (win.w & 0xffff));
  if (style & 0x10000000) { this.sendMsg(hwnd, WM.SHOWWINDOW, 1, 0); this.sendMsg(hwnd, WM.ACTIVATEAPP, 1, 0); this.sendMsg(hwnd, WM.ACTIVATE, 1, 0); }
  return hwnd;
});
def('USER32', 'DestroyWindow', 1, function (h) {
  const w = this.windows.get(h); if (!w) return 0;
  this.sendMsg(h, WM.DESTROY); this.sendMsg(h, WM.NCDESTROY);
  this.windows.delete(h); this.timers = this.timers.filter(t => t.hwnd !== h);
  this.host.destroyed && this.host.destroyed(h);
  return 1;
});
def('USER32', 'ShowWindow', 2, function (h, cmd) { const w = wOf(this, h); if (w && w.kind === 'control') w.visible = cmd !== 0; return 1; });
def('USER32', 'UpdateWindow', 1, () => 1);
function moveWindow(p, h, x, y, w, hh, flags) {
  const win = p.windows.get(h); if (!win || win.kind === 'control') return 1;
  const sized = !(flags & 1) && (w !== win.w || hh !== win.h), moved = !(flags & 2) && (x !== win.x || y !== win.y);
  if (!(flags & 2)) { win.x = x | 0; win.y = y | 0; }
  if (!(flags & 1)) { win.w = w | 0; win.h = hh | 0; }
  if (moved) p.sendMsg(h, WM.MOVE, 0, ((win.y & 0xffff) << 16) | (win.x & 0xffff));
  if (sized) p.sendMsg(h, WM.SIZE, 0, ((win.h & 0xffff) << 16) | (win.w & 0xffff));
  return 1;
}
def('USER32', 'SetWindowPos', 7, function (h, after, x, y, w, hh, flags) { return moveWindow(this, h, x | 0, y | 0, w | 0, hh | 0, flags); });
def('USER32', 'MoveWindow', 6, function (h, x, y, w, hh) { return moveWindow(this, h, x | 0, y | 0, w | 0, hh | 0, 0); });
def('USER32', 'DefWindowProcA', 4, function (h, msg, wp, lp) {
  const w = this.windows.get(h);
  if (msg === WM.CLOSE) return API.USER32.DestroyWindow[1].call(this, h);
  if (msg === WM.ERASEBKGND && w) { const dc = new DC(this, w.ctx, w.w, w.h, h); const b = this.obj(w.cls.brush); if (b && !b.nul) dc.fill(0, 0, w.w, w.h, b.color); return 1; }
  if (msg === WM.NCCREATE || msg === WM.NCACTIVATE) return 1;
  if (msg === WM.PAINT && w) { const ps = this.alloc(64); API.USER32.BeginPaint[1].call(this, h, ps); API.USER32.EndPaint[1].call(this, h, ps); this.free(ps); return 0; }
  if (msg === WM.SETCURSOR) { this.host.setCursor && this.host.setCursor(w && w.cls.cursor); return 1; }
  return 0;
});
def('USER32', 'GetMessageA', 4, function (p, hwnd) {
  const m = this.nextMessage(hwnd, true);
  if (!m) {
    if (this.depth === 0) { this.waiting = true; return YIELD; }
    this.writeMsg(p, { hwnd: 0, msg: 0, wp: 0, lp: 0 }); return 1;
  }
  this.writeMsg(p, m); return m.msg === WM.QUIT ? 0 : 1;
});
def('USER32', 'PeekMessageA', 5, function (p, hwnd, a, b, remove) {
  if (this.depth === 0 && this.now() - this.lastYield > 15) { this.waiting = false; return YIELD; }
  const m = this.nextMessage(hwnd, remove & 1);
  if (!m) return 0;
  this.writeMsg(p, m); return 1;
});
def('USER32', 'TranslateMessage', 1, () => 0);
def('USER32', 'DispatchMessageA', 1, function (p) {
  const h = this.r32(p), msg = this.r32(p + 4), wp = this.r32(p + 8), lp = this.r32(p + 12);
  if (msg === WM.TIMER && lp) return this.call(lp, [h, msg, wp, this.r32(p + 16)]);
  const w = this.windows.get(h); if (!w) return 0;
  if (msg === WM.PAINT) {
    const r = this.call(w.proc, [h, msg, wp, lp]);
    w.dirty = false; return r;
  }
  return this.call(w.proc, [h, msg, wp, lp]);
});
def('USER32', 'SendMessageA', 4, function (h, msg, wp, lp) { return this.sendMsg(h, msg, wp, lp); });
def('USER32', 'PostMessageA', 4, function (h, msg, wp, lp) { this.post(h, msg, wp, lp); return 1; });
def('USER32', 'PostQuitMessage', 1, function (code) { this.quit = code; return 0; });
def('USER32', 'SetTimer', 4, function (h, id, ms, proc) {
  this.timers = this.timers.filter(t => !(t.hwnd === h && t.id === id));
  // Win95 USER timers run off the 18.2 Hz system tick: intervals round up to whole 54.925 ms ticks.
  const q = Math.max(1, Math.ceil(ms / TICK_MS)) * TICK_MS;
  // with a window the caller's id is used as given (0 included); only window-less timers get a generated id
  const tid = h ? id : (0x7000 + this.timers.length);
  this.timers.push({ hwnd: h, id: tid, ms: q, proc, due: this.now() + q }); return h ? (id || 1) : tid;
});
def('USER32', 'KillTimer', 2, function (h, id) { this.timers = this.timers.filter(t => !(t.hwnd === h && t.id === id)); return 1; });
def('USER32', 'GetClientRect', 2, function (h, p) {
  const w = this.windows.get(h);
  if (!w && h && h === this.host.previewParent) { writeRect(this, p, 0, 0, this.host.previewW, this.host.previewH); return 1; }
  writeRect(this, p, 0, 0, w ? w.w : this.host.width, w ? w.h : this.host.height); return 1;
});
def('USER32', 'GetWindowRect', 2, function (h, p) {
  const w = this.windows.get(h);
  if (w && w.kind !== 'control') { const [x, y] = this.absPos(w); writeRect(this, p, x, y, x + w.w, y + w.h); }
  else writeRect(this, p, 0, 0, this.host.width, this.host.height);
  return 1;
});
def('USER32', 'GetDC', 1, function (h) {
  const w = this.windows.get(h);
  return this.newHandle(new DC(this, w ? w.ctx : this.host.surface(0, this.host.width, this.host.height), w ? w.w : this.host.width, w ? w.h : this.host.height, h));
});
def('USER32', 'ReleaseDC', 2, function (h, dc) { this.handles.delete(dc); return 1; });
def('USER32', 'BeginPaint', 2, function (h, ps) {
  const w = this.windows.get(h); const dc = API.USER32.GetDC[1].call(this, h);
  this.u8.fill(0, ps, ps + 64); this.w32(ps, dc); this.w32(ps + 4, 1); writeRect(this, ps + 8, 0, 0, w ? w.w : 0, w ? w.h : 0);
  if (w && w.erase !== false) this.sendMsg(h, WM.ERASEBKGND, dc, 0);
  if (w) { w.dirty = false; w.erase = true; }
  return dc;
});
def('USER32', 'EndPaint', 2, function (h, ps) { this.handles.delete(this.r32(ps)); return 1; });
def('USER32', 'InvalidateRect', 3, function (h, r, erase) { const w = this.windows.get(h); if (w) { w.dirty = true; w.erase = !!erase; } return 1; });
def('USER32', 'RedrawWindow', 4, function (h) { const w = this.windows.get(h); if (w) w.dirty = true; return 1; });
def('USER32', 'GetUpdateRect', 3, function (h, r) { const w = this.windows.get(h); if (r && w) writeRect(this, r, 0, 0, w.w, w.h); return w && w.dirty ? 1 : 0; });
def('USER32', 'ValidateRect', 2, function (h) { const w = this.windows.get(h); if (w) w.dirty = false; return 1; });
def('USER32', 'FillRect', 3, function (hdc, r, br) {
  const dc = dcOf(this, hdc), rc = readRect(this, r);
  let b = this.obj(br); if (!b && br > 0 && br <= 31) b = new Brush(SYS_COLORS[br - 1] ?? 0);
  if (b && !b.nul) dc.fill(rc.l, rc.t, rc.r - rc.l, rc.b - rc.t, b.color);
  return 1;
});
def('USER32', 'GetCursorPos', 1, function (p) { const c = this.host.cursor(); this.w32(p, c.x); this.w32(p + 4, c.y); return 1; });
def('USER32', 'SetCursor', 1, function (h) { this.host.setCursor && this.host.setCursor(h); return 0; });
def('USER32', 'ShowCursor', 1, () => 0);
def('USER32', 'LoadCursorA', 2, function (i, id) { return this.newHandle({ kind: 'cursor', id }); });
def('USER32', 'LoadIconA', 2, function (i, id) { return this.newHandle({ kind: 'icon', id }); });
def('USER32', 'FindWindowA', 2, () => 0);
def('USER32', 'GetForegroundWindow', 0, function () { for (const h of this.windows.keys()) return h; return 0; });
def('USER32', 'SetForegroundWindow', 1, () => 1);
def('USER32', 'GetFocus', 0, function () { for (const h of this.windows.keys()) return h; return 0; });
def('USER32', 'SetFocus', 1, () => 0);
def('USER32', 'IsWindow', 1, function (h) { return this.windows.has(h) || h === this.host.previewParent ? 1 : 0; });
def('USER32', 'GetParent', 1, function (h) { const w = this.windows.get(h); return w ? w.parent : 0; });
def('USER32', 'LoadStringA', 4, function (inst, id, buf, n) { const s = this.loadString(id, this.moduleFor(inst)); if (s === null) { if (n) this.u8[buf] = 0; return 0; } return this.writeA(buf, s, n); });
def('USER32', 'CharNextA', 1, function (p) { return this.u8[p] ? p + 1 : p; });
def('USER32', 'CharUpperA', 1, function (p) { if (p >>> 16) { this.writeA(p, this.readA(p).toUpperCase()); return p; } return String.fromCharCode(p).toUpperCase().charCodeAt(0); });
def('USER32', 'wsprintfA', -1, function (buf, fmt) { return this.writeA(buf, wsprintf(this, this.readA(fmt), this.reg('esp') + 12)); });
def('USER32', 'MessageBeep', 1, () => 1);
def('USER32', 'MessageBoxA', 4, function (h, text, cap) { console.warn('[win32] MessageBox:', this.readA(cap), this.readA(text)); return 1; });
def('USER32', 'InflateRect', 3, function (p, dx, dy) { const r = readRect(this, p); writeRect(this, p, r.l - dx, r.t - dy, r.r + (dx | 0), r.b + (dy | 0)); return 1; });
def('USER32', 'GetSysColor', 1, i => SYS_COLORS[i] ?? 0);
def('USER32', 'SetSysColors', 3, () => 1);
def('USER32', 'WinHelpA', 4, () => 1);
def('USER32', 'ChangeDisplaySettingsA', 2, () => 0);
def('USER32', 'GetWindowTextA', 3, function (h, buf, n) { const w = this.windows.get(h); return this.writeA(buf, w ? w.title : '', n); });
def('USER32', 'SetWindowTextA', 2, function (h, s) { const w = this.windows.get(h); if (w) w.title = this.readA(s); return 1; });
def('USER32', 'GetWindowLongA', 2, function (h, i) { const w = this.windows.get(h); return w ? (w.extra.get(i) || 0) : 0; });
def('USER32', 'SetWindowLongA', 3, function (h, i, v) { const w = this.windows.get(h); if (!w) return 0; const o = w.extra.get(i) || 0; w.extra.set(i, v); return o; });
// ---- dialogs: templates from the image's resources, driven by the guest dialog procedure
const DLG_CLASS = { 0x80: 'button', 0x81: 'edit', 0x82: 'static', 0x83: 'listbox', 0x84: 'scrollbar', 0x85: 'combobox' };
class Dialog {
  constructor(proc, tmpl, parent, dlgProc, param) {
    this.kind = 'dialog'; this.proc = dlgProc; this.p = proc; this.parent = parent; this.param = param;
    this.ctls = []; this.extra = new Map(); this.result = null; this.title = '';
    this.parse(tmpl);
    this.hwnd = proc.newHandle(this); proc.windows.set(this.hwnd, this);
    for (const c of this.ctls) { c.hwnd = proc.newHandle(c); c.dlg = this; proc.windows.set(c.hwnd, c); }
    // up-down controls with UDS_AUTOBUDDY take the previous control as buddy
    this.ctls.forEach((c, i) => { if (c.cls === 'msctls_updown32' && c.style & 0x10 && i) c.buddy = this.ctls[i - 1]; });
  }
  parse(a) {
    const p = this.p, sz = () => { const v = p.r16(a); if (v === 0) { a += 2; return ''; } if (v === 0xffff) { const o = p.r16(a + 2); a += 4; return o; } const s = p.readW(a); a += 2 * (s.length + 1); return s; };
    const ex = p.r16(a + 2) === 0xffff && p.r16(a) === 1;
    let n;
    if (ex) { this.style = p.r32(a + 12); n = p.r16(a + 16); this.x = p.dv.getInt16(a + 18, true); this.y = p.dv.getInt16(a + 20, true); this.cx = p.dv.getInt16(a + 22, true); this.cy = p.dv.getInt16(a + 24, true); a += 26; }
    else { this.style = p.r32(a); n = p.r16(a + 8); this.x = p.dv.getInt16(a + 10, true); this.y = p.dv.getInt16(a + 12, true); this.cx = p.dv.getInt16(a + 14, true); this.cy = p.dv.getInt16(a + 16, true); a += 18; }
    sz(); sz(); this.title = sz();
    if (this.style & 0x40) { this.pt = p.r16(a); a += ex ? 6 : 2; this.face = p.readW(a); a += 2 * (this.face.length + 1); }
    for (let i = 0; i < n; i++) {
      a = (a + 3) & ~3;
      const c = { kind: 'control', extra: new Map(), items: [], data: [], sel: -1, check: 0, pos: 0, min: 0, max: 100, enabled: true, visible: true, limit: 0 };
      if (ex) { c.style = p.r32(a + 8); c.x = p.dv.getInt16(a + 12, true); c.y = p.dv.getInt16(a + 14, true); c.cx = p.dv.getInt16(a + 16, true); c.cy = p.dv.getInt16(a + 18, true); c.id = p.r32(a + 20); a += 24; }
      else { c.style = p.r32(a); c.x = p.dv.getInt16(a + 8, true); c.y = p.dv.getInt16(a + 10, true); c.cx = p.dv.getInt16(a + 12, true); c.cy = p.dv.getInt16(a + 14, true); c.id = p.r16(a + 16); a += 18; }
      const cls = sz(); c.cls = typeof cls === 'number' ? DLG_CLASS[cls] || String(cls) : cls.toLowerCase();
      const t = sz(); c.text = typeof t === 'number' ? '' : t; c.res = typeof t === 'number' ? t : null;
      const extra = p.r16(a); a += 2 + extra;
      c.enabled = !(c.style & 0x08000000); c.visible = !!(c.style & 0x10000000);
      this.ctls.push(c);
    }
  }
  ctl(id) { return this.ctls.find(c => c.id === id) || null; }
  send(msg, wp, lp) { return this.p.call(this.proc, [this.hwnd, msg, u32(wp), u32(lp)]); }
  command(c, code = 0) { this.send(WM.COMMAND, (code << 16) | (c ? c.id : 0), c ? c.hwnd : 0); }
  // user interaction entry points (called by the shell)
  click(c) {
    const t = c.style & 0xf;
    if (c.cls === 'button') {
      if (t === 3 || t === 6) c.check = c.check ? 0 : 1;
      if (t === 9) this.radio(c);
    }
    this.command(c, 0);
  }
  radio(c) {
    const i = this.ctls.indexOf(c);
    let s = i; while (s > 0 && !(this.ctls[s].style & 0x20000)) s--;
    for (let k = s; k < this.ctls.length; k++) {
      const o = this.ctls[k]; if (k > s && o.style & 0x20000) break;
      if (o.cls === 'button' && ((o.style & 0xf) === 9 || (o.style & 0xf) === 4)) o.check = o === c ? 1 : 0;
    }
  }
  edited(c) { this.command(c, c.cls === 'combobox' ? 5 : 0x300); }
  selected(c) { this.command(c, 1); }
  scrolled(c, code) { this.send(c.style & 1 ? 0x115 : 0x114, ((c.pos & 0xffff) << 16) | code, c.hwnd); }
  spun(c, d) {
    const lo = Math.min(c.min, c.max), hi = Math.max(c.min, c.max);
    c.pos = Math.max(lo, Math.min(hi, c.pos + (c.min > c.max ? -d : d)));
    if (c.buddy && c.style & 2) { c.buddy.text = String(c.pos); this.edited(c.buddy); }
    this.send(0x115, ((c.pos & 0xffff) << 16) | 4, c.hwnd);
  }
}
function ctlMessage(p, c, msg, wp, lp) {
  switch (msg) {
    case 0x0c: c.text = p.readA(lp) || ''; return 1;
    case 0x0d: return p.writeA(lp, c.text || '', wp);
    case 0x0e: return (c.text || '').length;
    case 0x30: case 0xc5: case 0x415: case 0x414: case 0x417: case 0xb1: case 0x401 + 0x13: return 0;
    case 0xf0: return c.check;
    case 0xf1: c.check = wp; return 0;
    case 0x400: return c.pos;
    case 0x401: return c.min;
    case 0x402: return c.max;
    case 0x405: c.pos = lp | 0; return 0;
    case 0x406: c.min = lp & 0xffff; c.max = lp >>> 16; return 0;
    case 0x407: c.min = lp | 0; return 0;
    case 0x408: c.max = lp | 0; return 0;
    case 0x465: c.max = (lp << 16) >> 16; c.min = lp >> 16; return 0;
    case 0x466: return ((c.max & 0xffff) | (c.min << 16)) >>> 0;
    case 0x467: c.pos = (lp << 16) >> 16; if (c.buddy && c.style & 2) c.buddy.text = String(c.pos); return 0;
    case 0x468: return c.pos & 0xffff;
    case 0x469: { const o = c.buddy; c.buddy = p.windows.get(wp) || null; return o ? o.hwnd : 0; }
    case 0x143: case 0x180: c.items.push(p.readA(lp) || ''); c.data.push(0); return c.items.length - 1;
    case 0x14a: case 0x181: { const i = (wp | 0) < 0 ? c.items.length : wp; c.items.splice(i, 0, p.readA(lp) || ''); c.data.splice(i, 0, 0); return i; }
    case 0x14b: case 0x184: c.items = []; c.data = []; c.sel = -1; return 0;
    case 0x14e: case 0x186: c.sel = (wp | 0) < c.items.length ? wp | 0 : -1; if (c.cls === 'combobox') c.text = c.items[c.sel] || ''; return c.sel;
    case 0x147: case 0x188: return c.sel >>> 0;
    case 0x148: case 0x189: return p.writeA(lp, c.items[wp] || '');
    case 0x149: case 0x18a: return (c.items[wp] || '').length;
    case 0x146: case 0x18b: return c.items.length;
    case 0x150: case 0x199: return c.data[wp] || 0;
    case 0x151: case 0x19a: c.data[wp] = lp; return 1;
    case 0x158: case 0x14c: case 0x18f: { const s = (p.readA(lp) || '').toLowerCase(); return c.items.findIndex(x => (msg === 0x158 ? x.toLowerCase() === s : x.toLowerCase().startsWith(s))) >>> 0; }
    case 0x14d: { const s = (p.readA(lp) || '').toLowerCase(); const i = c.items.findIndex(x => x.toLowerCase().startsWith(s)); if (i >= 0) { c.sel = i; c.text = c.items[i]; } return i >>> 0; }
    case 0x0a: c.enabled = !!wp; return 0;
  }
  return 0;
}
const wOf = (p, h) => p.windows.get(h);
def('USER32', 'DialogBoxParamA', 5, function (inst, name, parent, proc, param) {
  if (this.dlgDone) { const r = this.dlgDone.result; this.dlgDone = null; return r; }
  const r = this.findResource(5, this.resName(name)); if (!r) return u32(-1);
  const d = new Dialog(this, r.addr, parent, proc, param);
  if (!this.host.dialog) return u32(-1);
  this.modal = d;
  this.host.dialog(this, d);
  d.send(WM.INITDIALOG, (d.ctls.find(c => c.enabled && c.visible) || {}).hwnd || 0, param);
  if (d.result !== null) { this.modal = null; this.host.closeDialog && this.host.closeDialog(d); this.windows.delete(d.hwnd); return d.result; }
  this.waiting = true;
  return YIELD;
});
def('USER32', 'EndDialog', 2, function (h, r) {
  const d = wOf(this, h); if (!d || d.kind !== 'dialog') return 0;
  d.result = r;
  if (this.modal === d) {
    this.modal = null; this.dlgDone = d;
    for (const c of d.ctls) this.windows.delete(c.hwnd);
    this.windows.delete(d.hwnd);
    this.host.closeDialog && this.host.closeDialog(d);
  }
  return 1;
});
def('USER32', 'GetDlgItem', 2, function (h, id) { const d = wOf(this, h); const c = d && d.ctl && d.ctl(id); return c ? c.hwnd : 0; });
def('USER32', 'GetDlgCtrlID', 1, function (h) { const c = wOf(this, h); return c && c.kind === 'control' ? c.id : 0; });
def('USER32', 'SendDlgItemMessageA', 5, function (h, id, msg, wp, lp) { const d = wOf(this, h); const c = d && d.ctl && d.ctl(id); return c ? ctlMessage(this, c, msg, wp, lp) : 0; });
def('USER32', 'SetDlgItemInt', 4, function (h, id, v, signed) { const d = wOf(this, h); const c = d && d.ctl(id); if (c) c.text = String(signed ? v | 0 : v >>> 0); return 1; });
def('USER32', 'GetDlgItemInt', 4, function (h, id, ok, signed) {
  const d = wOf(this, h); const c = d && d.ctl(id); const n = c ? parseInt(c.text, 10) : NaN;
  if (ok) this.w32(ok, Number.isNaN(n) ? 0 : 1); return Number.isNaN(n) ? 0 : n >>> 0;
});
def('USER32', 'SetDlgItemTextA', 3, function (h, id, s) { const d = wOf(this, h); const c = d && d.ctl(id); if (c) c.text = this.readA(s) || ''; return 1; });
def('USER32', 'GetDlgItemTextA', 4, function (h, id, buf, n) { const d = wOf(this, h); const c = d && d.ctl(id); return this.writeA(buf, c ? c.text : '', n); });
def('USER32', 'CheckDlgButton', 3, function (h, id, v) { const d = wOf(this, h); const c = d && d.ctl(id); if (c) c.check = v; return 1; });
def('USER32', 'IsDlgButtonChecked', 2, function (h, id) { const d = wOf(this, h); const c = d && d.ctl(id); return c ? c.check : 0; });
def('USER32', 'CheckRadioButton', 4, function (h, a, b, id) {
  const d = wOf(this, h); if (!d) return 0;
  for (const c of d.ctls) if (c.id >= a && c.id <= b) c.check = c.id === id ? 1 : 0;
  return 1;
});
def('USER32', 'EnableWindow', 2, function (h, en) { const w = wOf(this, h); if (!w) return 0; const o = w.enabled === false; w.enabled = !!en; return o ? 1 : 0; });
def('USER32', 'IsWindowEnabled', 1, function (h) { const w = wOf(this, h); return w && w.enabled !== false ? 1 : 0; });
def('COMCTL32', '#17', 0, () => 0);
def('COMCTL32', 'InitCommonControls', 0, () => 0);
def('COMDLG32', 'ChooseColorA', 1, () => 0);
def('COMDLG32', 'ChooseFontA', 1, () => 0);
def('COMDLG32', 'GetOpenFileNameA', 1, () => 0);
const SYS_COLORS = [0xc0c0c0, 0x808000, 0x800000, 0x808080, 0xc0c0c0, 0xffffff, 0x000000, 0x000000, 0x000000, 0xffffff, 0xc0c0c0, 0xc0c0c0,
  0x808080, 0x800000, 0xffffff, 0xc0c0c0, 0x808080, 0x808080, 0x000000, 0xc0c0c0, 0xffffff, 0x000000, 0xdfdfdf, 0x000000, 0xe1ffff];

// GDI32
def('GDI32', 'GetStockObject', 1, i => 0x8000 | i);
def('GDI32', 'CreatePen', 3, function (s, w, c) { return this.newHandle(new Pen(s, w, c)); });
def('GDI32', 'CreatePenIndirect', 1, function (p) { return this.newHandle(new Pen(this.r32(p), this.r32(p + 4), this.r32(p + 12))); });
def('GDI32', 'CreateSolidBrush', 1, function (c) { return this.newHandle(new Brush(c)); });
def('GDI32', 'CreateFontIndirectA', 1, function (p) { const f = new Font(readLogFont(this, p)); f.raw = this.u8.slice(p, p + 60); return this.newHandle(f); });
def('GDI32', 'CreateFontA', 14, function (h, w, esc, or, wt, it, ul, so, cs, op, cp, q, pf, face) {
  const f = new Font({ height: h | 0, width: w | 0, escapement: esc | 0, weight: wt, italic: it, underline: ul, charset: cs, face: this.readA(face) || '' });
  const raw = new Uint8Array(60), v = new DataView(raw.buffer);
  [h, w, esc, or, wt].forEach((x, i) => v.setInt32(4 * i, x | 0, true));
  raw.set([it, ul, so, cs, op, cp, q, pf].map(x => x & 0xff), 20); raw.set(window.W95FS.encode(f.lf.face).subarray(0, 31), 28);
  f.raw = raw; return this.newHandle(f);
});
// outline fonts come from the native TrueType rasterizer in GDI32/GDI.EXE
def('GDI32', 'GetOutlineTextMetricsA', 3, function (hdc, cb, p) { const n = this.nativeFontDC && this.nativeFontDC(dcOf(this, hdc).font); return n ? n.call('GetOutlineTextMetricsA', [n.hdc, cb, p]) : 0; });
def('GDI32', 'GetGlyphOutlineA', 7, function (hdc, c, fmt, gm, cb, buf, mat) { const n = this.nativeFontDC && this.nativeFontDC(dcOf(this, hdc).font); return n ? n.call('GetGlyphOutlineA', [n.hdc, c, fmt, gm, cb, buf, mat]) : -1; });
def('GDI32', 'SelectObject', 2, function (hdc, h) {
  const dc = dcOf(this, hdc), o = this.obj(h); if (!o) return 0;
  const slot = { pen: 'pen', brush: 'brush', font: 'font', bitmap: 'bitmap' }[o.kind]; if (!slot) return 0;
  const old = dc[slot]; dc[slot] = o;
  if (slot === 'bitmap') { dc.ctx = o.canvas.getContext('2d', { willReadFrequently: true }); dc.ctx.imageSmoothingEnabled = false; dc.w = o.w; dc.h = o.h; }
  return old ? old.handle : 0;
});
def('GDI32', 'GetCurrentObject', 2, function (hdc, t) { const dc = dcOf(this, hdc); return ({ 1: dc.pen, 2: dc.brush, 6: dc.font, 7: dc.bitmap, 5: dc.pal }[t] || {}).handle || 0; });
def('GDI32', 'DeleteObject', 1, function (h) { if (!STOCK.has(h)) this.handles.delete(h); return 1; });
def('GDI32', 'GetObjectType', 1, function (h) { const o = this.obj(h); return o ? { pen: 1, brush: 2, dc: 3, palette: 5, font: 6, bitmap: 7 }[o.kind] || 0 : 0; });
def('GDI32', 'GetObjectA', 3, function (h, n, p) {
  const o = this.obj(h); if (!o) return 0;
  if (o.kind === 'palette') { if (p) this.w16(p, o.entries.length); return 2; }
  if (o.kind === 'bitmap' && p && o.dib) {
    this.u8.fill(0, p, p + n); this.w32(p + 4, o.w); this.w32(p + 8, o.h); this.w32(p + 12, o.dib.stride); this.w16(p + 16, 1); this.w16(p + 18, o.dib.bpp); this.w32(p + 20, o.dib.ptr);
    if (n >= 84) { this.w32(p + 24, 40); this.w32(p + 28, o.w); this.w32(p + 32, o.dib.topdown ? -o.h : o.h); this.w16(p + 36, 1); this.w16(p + 38, o.dib.bpp); this.w32(p + 44, o.dib.stride * o.h); return 84; }
    return 24;
  }
  if (o.kind === 'bitmap' && p) { this.u8.fill(0, p, p + n); this.w32(p + 4, o.w); this.w32(p + 8, o.h); this.w32(p + 12, o.mono ? ((o.w + 15) >> 4) << 1 : o.w * 4); this.w16(p + 16, 1); this.w16(p + 18, o.mono ? 1 : 32); return 24; }
  if (o.kind === 'font' && p) { this.u8.fill(0, p, p + n); this.w32(p, o.lf.height); this.w32(p + 16, o.lf.weight); this.writeA(p + 28, o.lf.face, 32); return 60; }
  return 0;
});
def('GDI32', 'MoveToEx', 4, function (hdc, x, y, old) { const dc = dcOf(this, hdc); if (old) { this.w32(old, dc.x); this.w32(old + 4, dc.y); } dc.x = x | 0; dc.y = y | 0; return 1; });
def('GDI32', 'LineTo', 3, function (hdc, x, y) { const dc = dcOf(this, hdc); dc.line(dc.x, dc.y, x | 0, y | 0); dc.x = x | 0; dc.y = y | 0; return 1; });
def('GDI32', 'Polyline', 3, function (hdc, pts, n) {
  const dc = dcOf(this, hdc);
  for (let i = 1; i < n; i++) dc.line(this.i32(pts + 8 * (i - 1)), this.i32(pts + 8 * (i - 1) + 4), this.i32(pts + 8 * i), this.i32(pts + 8 * i + 4));
  return 1;
});
// Bezier flattening by recursive subdivision to within half a pixel, then GDI lines.
def('GDI32', 'PolyBezier', 3, function (hdc, pts, n) {
  const dc = dcOf(this, hdc), P = i => [this.i32(pts + 8 * i), this.i32(pts + 8 * i + 4)];
  let cur = P(0);
  const seg = (a, b, c, d, depth) => {
    const flat = Math.abs(a[0] + c[0] - 2 * b[0]) + Math.abs(a[1] + c[1] - 2 * b[1]) + Math.abs(b[0] + d[0] - 2 * c[0]) + Math.abs(b[1] + d[1] - 2 * c[1]);
    if (flat <= 1 || depth > 10) { const e = [Math.round(d[0]), Math.round(d[1])]; dc.line(cur[0], cur[1], e[0], e[1]); cur = e; return; }
    const m = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
    const ab = m(a, b), bc = m(b, c), cd = m(c, d), abc = m(ab, bc), bcd = m(bc, cd), q = m(abc, bcd);
    seg(a, ab, abc, q, depth + 1); seg(q, bcd, cd, d, depth + 1);
  };
  for (let i = 1; i + 2 < n; i += 3) seg(P(i - 1), P(i), P(i + 1), P(i + 2), 0);
  return 1;
});
const ROP = { PATCOPY: 0xF00021, BLACKNESS: 0x42, WHITENESS: 0xFF0062, SRCCOPY: 0xCC0020 };
// Source image of a blit as the destination sees it: mono -> color uses the destination's text
// (0 bits) and background (1 bits) colors; color -> mono maps the source's background color to white.
function blitSource(s, d) {
  const sb = s.bitmap, sm = !!(sb && sb.mono), dm = !!(d.bitmap && d.bitmap.mono);
  if (sm === dm) return s.ctx.canvas;
  const key = sm ? `${sb.ver}|${d.rgb(d.text)}|${d.rgb(d.bk)}` : `${s.bitmap ? s.bitmap.ver : Math.random()}|${s.rgb(s.bk)}`;
  const holder = sb || s;
  if (holder.conv && holder.conv.key === key) return holder.conv.canvas;
  const c = s.ctx.canvas, out = mkCanvas(c.width, c.height), g = out.getContext('2d');
  const id = s.ctx.getImageData(0, 0, c.width, c.height), px = id.data;
  if (sm) {
    const fg = d.rgb(d.text), bg = d.rgb(d.bk);
    for (let k = 0; k < px.length; k += 4) { const v = px[k] ? bg : fg; px[k] = v[0]; px[k + 1] = v[1]; px[k + 2] = v[2]; px[k + 3] = 255; }
  } else {
    const [br, bgc, bb] = s.rgb(s.bk);
    for (let k = 0; k < px.length; k += 4) { const v = px[k] === br && px[k + 1] === bgc && px[k + 2] === bb ? 255 : 0; px[k] = px[k + 1] = px[k + 2] = v; px[k + 3] = 255; }
  }
  g.putImageData(id, 0, 0);
  holder.conv = { key, canvas: out };
  return out;
}
// General ternary raster operation on (pattern, source, destination), bit for bit.
function rop3(d, x, y, w, h, src, sx, sy, rop) {
  const g = d.ctx, idx = (rop >>> 16) & 0xff, [ox, oy] = d.origin();
  x = (x | 0) + ox; y = (y | 0) + oy; w |= 0; h |= 0;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(g.canvas.width, x + w), y1 = Math.min(g.canvas.height, y + h);
  if (x1 <= x0 || y1 <= y0) return;
  const dd = g.getImageData(x0, y0, x1 - x0, y1 - y0), D = dd.data;
  let S = null;
  if (src) {
    const tmp = mkCanvas(x1 - x0, y1 - y0).getContext('2d');
    tmp.fillStyle = '#000'; tmp.fillRect(0, 0, x1 - x0, y1 - y0);
    tmp.drawImage(src, (sx | 0) + (x0 - x), (sy | 0) + (y0 - y), x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    S = tmp.getImageData(0, 0, x1 - x0, y1 - y0).data;
  }
  const P = d.brush.nul ? [0, 0, 0] : d.rgb(d.brush.color);
  for (let k = 0; k < D.length; k += 4) {
    for (let c = 0; c < 3; c++) {
      const p = P[c], sv = S ? S[k + c] : 0, dv = D[k + c]; let r = 0;
      for (let t = 0; t < 8; t++) {
        if (!((idx >> t) & 1)) continue;
        r |= ((t & 4) ? p : ~p) & ((t & 2) ? sv : ~sv) & ((t & 1) ? dv : ~dv);
      }
      D[k + c] = r & 0xff;
    }
    D[k + 3] = 255;
  }
  g.putImageData(dd, x0, y0);
}
def('GDI32', 'PatBlt', 6, function (hdc, x, y, w, h, rop) {
  const dc = dcOf(this, hdc); x |= 0; y |= 0; w |= 0; h |= 0;
  if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; }
  if (!dc.ctx) return 1;
  if (rop === ROP.BLACKNESS) dc.fill(x, y, w, h, 0);
  else if (rop === ROP.WHITENESS) dc.fill(x, y, w, h, 0xffffff);
  else if (rop === ROP.PATCOPY) { if (!dc.brush.nul) dc.fill(x, y, w, h, dc.brush.color); }
  else { rop3(dc, x, y, w, h, null, 0, 0, rop); dc.touch(); }
  return 1;
});
def('GDI32', 'CreateCompatibleDC', 1, function (hdc) { const d = new DC(this, null, 1, 1, 0); d.bitmap = new Bitmap(1, 1, 1); this.newHandle(d.bitmap); d.ctx = d.bitmap.canvas.getContext('2d', { willReadFrequently: true }); d.mem = true; return this.newHandle(d); });
def('GDI32', 'CreateICA', 4, function () { return this.newHandle(new DC(this, null, this.host.width, this.host.height, 0)); });
def('GDI32', 'CreateDCA', 4, function () { return this.newHandle(new DC(this, this.host.surface(0, this.host.width, this.host.height), this.host.width, this.host.height, 0)); });
def('GDI32', 'DeleteDC', 1, function (h) { this.handles.delete(h); return 1; });
def('GDI32', 'CreateBitmap', 5, function (w, h, planes, bpp, bits) {
  const b = new Bitmap(w, h, planes * bpp === 1 ? 1 : 32);
  if (bits && b.mono) {
    const g = b.canvas.getContext('2d'), id = g.createImageData(w, h), stride = ((w + 15) >> 4) << 1;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const on = (this.u8[bits + yy * stride + (xx >> 3)] >> (7 - (xx & 7))) & 1, o = (yy * w + xx) * 4;
      id.data[o] = id.data[o + 1] = id.data[o + 2] = on ? 255 : 0; id.data[o + 3] = 255;
    }
    g.putImageData(id, 0, 0);
  }
  return this.newHandle(b);
});
def('GDI32', 'CreateCompatibleBitmap', 3, function (hdc, w, h) {
  const dc = this.obj(hdc); const mono = dc && dc.mem && (!dc.bitmap || dc.bitmap.mono);
  return this.newHandle(new Bitmap(w, h, mono ? 1 : 32));
});
def('GDI32', 'BitBlt', 9, function (hd, x, y, w, h, hs, sx, sy, rop) {
  const d = dcOf(this, hd);
  const usesSrc = (((rop >>> 16) & 0xff) >> 2 & 0x33) !== (((rop >>> 16) & 0xff) & 0x33);
  if (!hs || !usesSrc) return API.GDI32.PatBlt[1].call(this, hd, x, y, w, h, rop);
  const s = dcOf(this, hs); if (!s.ctx || !d.ctx) return 1;
  dibIn(this, s.bitmap); if (d.bitmap !== s.bitmap) dibIn(this, d.bitmap);
  const src = blitSource(s, d);
  if (rop === ROP.SRCCOPY) { const g = d.pre(); g.drawImage(src, sx | 0, sy | 0, w | 0, h | 0, x | 0, y | 0, w | 0, h | 0); d.post(); }
  else rop3(d, x, y, w, h, src, sx, sy, rop);
  dibOut(this, d.bitmap); d.touch(); return 1;
});
def('GDI32', 'StretchBlt', 11, function (hd, x, y, w, h, hs, sx, sy, sw, sh) {
  const d = dcOf(this, hd), s = dcOf(this, hs); if (!s.ctx || !d.ctx) return 1;
  dibIn(this, s.bitmap); if (d.bitmap !== s.bitmap) dibIn(this, d.bitmap);
  const g = d.pre(); g.drawImage(blitSource(s, d), sx | 0, sy | 0, sw | 0, sh | 0, x | 0, y | 0, w | 0, h | 0); d.post(); dibOut(this, d.bitmap); d.touch(); return 1;
});
// ---- device-independent bitmaps
function readBmi(p, a) {
  const size = p.r32(a), w = p.i32(a + 4), h = p.i32(a + 8), bpp = p.r16(a + 14), comp = p.r32(a + 16), used = p.r32(a + 32);
  const ncol = bpp <= 8 ? (used || (1 << bpp)) : comp === 3 ? 3 : 0, pal = [];
  for (let i = 0; i < (bpp <= 8 ? ncol : 0); i++) pal.push([p.r8(a + size + 4 * i + 2), p.r8(a + size + 4 * i + 1), p.r8(a + size + 4 * i)]);
  const masks = comp === 3 ? [p.r32(a + size), p.r32(a + size + 4), p.r32(a + size + 8)] : null;
  return { size, w, h: Math.abs(h), topdown: h < 0, bpp, comp, pal, masks, stride: ((w * bpp + 31) >> 5) << 2 };
}
const maskShift = m => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++; } let b = 0; while (m & 1) { m >>>= 1; b++; } return [s, b]; };
function decodeDIB(p, bits, d, lines = d.h, start = 0) {
  const out = new ImageData(d.w, d.h), px = out.data, u = p.u8, dv = p.dv;
  const ms = d.masks ? d.masks.map(maskShift) : d.bpp === 16 ? [[10, 5], [5, 5], [0, 5]] : null;
  for (let row = start; row < start + lines && row < d.h; row++) {
    const y = d.topdown ? row : d.h - 1 - row, src = bits + (row - start) * d.stride;
    for (let x = 0; x < d.w; x++) {
      let r, g, b; const o = (y * d.w + x) * 4;
      if (d.bpp <= 8) {
        const bit = x * d.bpp, v = (u[src + (bit >> 3)] >> (8 - d.bpp - (bit & 7))) & ((1 << d.bpp) - 1);
        [r, g, b] = d.pal[v] || [0, 0, 0];
      } else if (d.bpp === 24) { b = u[src + 3 * x]; g = u[src + 3 * x + 1]; r = u[src + 3 * x + 2]; }
      else if (d.bpp === 32 && !d.masks) { b = u[src + 4 * x]; g = u[src + 4 * x + 1]; r = u[src + 4 * x + 2]; }
      else {
        const v = d.bpp === 16 ? dv.getUint16(src + 2 * x, true) : dv.getUint32(src + 4 * x, true);
        [r, g, b] = ms.map(([s, n]) => (((v >>> s) & ((1 << n) - 1)) * 255 / ((1 << n) - 1)) | 0);
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  return out;
}
function encodeDIB(p, bits, d, img, lines = d.h, start = 0) {
  const u = p.u8, dv = p.dv, px = img.data;
  // nearest palette index, memoized per color (DIB sections are written back every frame)
  const memo = d.memo && d.memo.pal === d.pal ? d.memo.map : (d.memo = { pal: d.pal, map: new Map() }).map;
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b; let bi = memo.get(key);
    if (bi !== undefined) return bi;
    let bd = 1e9; bi = 0;
    for (let i = 0; i < d.pal.length; i++) { const [pr, pg, pb] = d.pal[i], e = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2; if (e < bd) { bd = e; bi = i; } }
    memo.set(key, bi); return bi;
  };
  for (let row = start; row < start + lines && row < d.h; row++) {
    const y = d.topdown ? row : d.h - 1 - row, dst = bits + (row - start) * d.stride;
    if (d.bpp <= 8) u.fill(0, dst, dst + d.stride);
    for (let x = 0; x < d.w; x++) {
      const o = (y * img.width + x) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
      if (d.bpp <= 8) { const v = nearest(r, g, b), bit = x * d.bpp; u[dst + (bit >> 3)] |= v << (8 - d.bpp - (bit & 7)); }
      else if (d.bpp === 24) { u[dst + 3 * x] = b; u[dst + 3 * x + 1] = g; u[dst + 3 * x + 2] = r; }
      else if (d.bpp === 32) { u[dst + 4 * x] = b; u[dst + 4 * x + 1] = g; u[dst + 4 * x + 2] = r; u[dst + 4 * x + 3] = 0; }
      else dv.setUint16(dst + 2 * x, ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), true);
    }
  }
}
// DIB sections keep their pixels in guest memory; GDI operations read and write them through.
function dibIn(p, bm) { if (bm && bm.dib) bm.canvas.getContext('2d').putImageData(decodeDIB(p, bm.dib.ptr, bm.dib), 0, 0); }
function dibOut(p, bm) { if (bm && bm.dib) encodeDIB(p, bm.dib.ptr, bm.dib, bm.canvas.getContext('2d').getImageData(0, 0, bm.w, bm.h)); }
def('GDI32', 'CreateDIBSection', 6, function (hdc, bmi, usage, ppv) {
  const d = readBmi(this, bmi), ptr = this.alloc(d.stride * d.h, true);
  const b = new Bitmap(d.w, d.h, d.bpp === 1 ? 1 : 32); b.dib = { ...d, ptr };
  if (ppv) this.w32(ppv, ptr);
  return this.newHandle(b);
});
def('GDI32', 'CreateDIBitmap', 6, function (hdc, bih, init, bits, bmi) {
  const d = readBmi(this, bmi || bih), b = new Bitmap(d.w, d.h, 32);
  if (init & 4 && bits) b.canvas.getContext('2d').putImageData(decodeDIB(this, bits, d), 0, 0);
  return this.newHandle(b);
});
def('GDI32', 'SetDIBits', 7, function (hdc, hbm, start, lines, bits, bmi) {
  const b = this.obj(hbm); if (!b || b.kind !== 'bitmap') return 0;
  const d = readBmi(this, bmi), img = decodeDIB(this, bits, { ...d }, lines, start);
  dibIn(this, b); const g = b.canvas.getContext('2d'); g.putImageData(img, 0, 0); dibOut(this, b); b.ver++;
  return lines;
});
def('GDI32', 'GetDIBits', 7, function (hdc, hbm, start, lines, bits, bmi) {
  const b = this.obj(hbm); if (!b || b.kind !== 'bitmap') return 0;
  if (!this.r16(bmi + 14)) {                       // query: describe the bitmap
    const bpp = b.mono ? 1 : 32;
    this.w32(bmi + 4, b.w); this.w32(bmi + 8, b.h); this.w16(bmi + 12, 1); this.w16(bmi + 14, bpp);
    this.w32(bmi + 16, 0); this.w32(bmi + 20, (((b.w * bpp + 31) >> 5) << 2) * b.h);
    return b.h;
  }
  const d = readBmi(this, bmi);
  if (d.bpp <= 8 && !d.pal.length) {
    const pal = b.mono ? [[0, 0, 0], [255, 255, 255]] : Array.from({ length: 1 << d.bpp }, (_, i) => [i, i, i]);
    pal.forEach(([r, g, bb], i) => { this.u8[bmi + d.size + 4 * i] = bb; this.u8[bmi + d.size + 4 * i + 1] = g; this.u8[bmi + d.size + 4 * i + 2] = r; this.u8[bmi + d.size + 4 * i + 3] = 0; });
    d.pal = pal;
  }
  if (!bits) return 1;
  dibIn(this, b);
  encodeDIB(this, bits, { ...d, w: Math.min(d.w, b.w), h: d.h }, b.canvas.getContext('2d').getImageData(0, 0, b.w, b.h), lines, start);
  return lines;
});
def('GDI32', 'SetDIBColorTable', 4, function (hdc, start, n, rgb) {
  const dc = dcOf(this, hdc), b = dc.bitmap; if (!b || !b.dib) return 0;
  for (let i = 0; i < n; i++) b.dib.pal[start + i] = [this.r8(rgb + 4 * i + 2), this.r8(rgb + 4 * i + 1), this.r8(rgb + 4 * i)];
  return n;
});
def('GDI32', 'StretchDIBits', 13, function (hdc, x, y, w, h, sx, sy, sw, sh, bits, bmi) {
  const dc = dcOf(this, hdc), d = readBmi(this, bmi), c = mkCanvas(d.w, d.h);
  c.getContext('2d').putImageData(decodeDIB(this, bits, d), 0, 0);
  const g = dc.pre(); g.drawImage(c, sx | 0, (d.h - (sy | 0) - (sh | 0)), sw | 0, sh | 0, x | 0, y | 0, w | 0, h | 0); dc.post(); dc.touch();
  return h;
});
def('GDI32', 'SetDIBitsToDevice', 12, function (hdc, x, y, w, h, sx, sy, start, lines, bits, bmi) {
  const dc = dcOf(this, hdc), d = readBmi(this, bmi), c = mkCanvas(d.w, d.h);
  c.getContext('2d').putImageData(decodeDIB(this, bits, d, lines, start), 0, 0);
  const g = dc.pre(); g.drawImage(c, sx | 0, sy | 0, w | 0, h | 0, x | 0, y | 0, w | 0, h | 0); dc.post(); dc.touch();
  return lines;
});
def('GDI32', 'SetBkColor', 2, function (hdc, c) { const dc = dcOf(this, hdc); const o = dc.bk; dc.bk = c; return o; });
def('GDI32', 'SetBkMode', 2, function (hdc, m) { const dc = dcOf(this, hdc); const o = dc.bkMode; dc.bkMode = m; return o; });
def('GDI32', 'SetTextColor', 2, function (hdc, c) { const dc = dcOf(this, hdc); const o = dc.text; dc.text = c; return o; });
def('GDI32', 'SetTextAlign', 2, function (hdc, a) { const dc = dcOf(this, hdc); const o = dc.align; dc.align = a; return o; });
// Win95 GDI scan-converts TrueType glyphs without smoothing: rasterize through a canvas,
// then threshold coverage at 50% into solid pixels of the text color.
const glyphCache = new Map();
function textBitmap(fontCss, s, color) {
  const key = fontCss + '\u0001' + s + '\u0001' + color;
  let e = glyphCache.get(key);
  if (e) return e;
  if (glyphCache.size > 2000) glyphCache.clear();
  const g = measureCtx(); g.font = fontCss;
  const m = g.measureText(s), asc = Math.ceil(m.fontBoundingBoxAscent ?? 10), desc = Math.ceil(m.fontBoundingBoxDescent ?? 3);
  const w = Math.max(1, Math.ceil(m.width)), h = Math.max(1, asc + desc);
  const c = mkCanvas(w, h), cx = c.getContext('2d', { willReadFrequently: true });
  cx.font = fontCss; cx.fillStyle = '#000'; cx.textBaseline = 'alphabetic'; cx.fillText(s, 0, asc);
  const id = cx.getImageData(0, 0, w, h), d = id.data, [r, gg, b] = color;
  for (let k = 0; k < d.length; k += 4) { const on = d[k + 3] >= 128; d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = on ? 255 : 0; }
  cx.putImageData(id, 0, 0);
  e = { canvas: c, w, h, asc, desc, width: m.width };
  glyphCache.set(key, e);
  return e;
}
function drawText(p, dc, x, y, s, opaqueRect) {
  if (!dc.ctx) return;
  if (opaqueRect) dc.fill(opaqueRect.l, opaqueRect.t, opaqueRect.r - opaqueRect.l, opaqueRect.b - opaqueRect.t, dc.bk);
  if (!s) return;
  const col = dc.rgb(dc.text);
  const t = textBitmap(dc.fontCss(), s, col);
  const ha = dc.align & 6, va = dc.align & 24;          // TA_CENTER=6, TA_RIGHT=2 ; TA_BASELINE=24, TA_BOTTOM=8, TA_TOP=0
  const tx = Math.round(ha === 6 ? x - t.w / 2 : ha === 2 ? x - t.w : x);
  const top = va === 24 ? y - t.asc : va === 8 ? y - t.h : y;
  if (dc.bkMode === 2 && !opaqueRect) dc.fill(tx, top, t.w, t.h, dc.bk);
  const g = dc.pre(); g.drawImage(t.canvas, tx, top); dc.post();
  dc.touch();
}
def('GDI32', 'TextOutA', 5, function (hdc, x, y, s, n) { drawText(this, dcOf(this, hdc), x | 0, y | 0, this.readA(s, n)); return 1; });
def('GDI32', 'ExtTextOutA', 8, function (hdc, x, y, opt, rc, s, n) {
  const dc = dcOf(this, hdc); const r = rc && (opt & 2) ? readRect(this, rc) : null;
  drawText(this, dc, x | 0, y | 0, n ? this.readA(s, n) : '', r); return 1;
});
def('GDI32', 'GetTextExtentPointA', 4, function (hdc, s, n, sz) {
  const dc = dcOf(this, hdc), g = measureCtx(); g.font = dc.fontCss(); const m = g.measureText(this.readA(s, n));
  this.w32(sz, Math.ceil(m.width)); this.w32(sz + 4, Math.ceil((m.fontBoundingBoxAscent || 10) + (m.fontBoundingBoxDescent || 3))); return 1;
});
def('GDI32', 'GetTextExtentPoint32A', 4, function () { return API.GDI32.GetTextExtentPointA[1].apply(this, arguments); });
def('GDI32', 'GetTextMetricsA', 2, function (hdc, p) {
  const dc = dcOf(this, hdc), g = measureCtx(); g.font = dc.fontCss(); const m = g.measureText('Mg');
  const asc = Math.ceil(m.fontBoundingBoxAscent || 10), desc = Math.ceil(m.fontBoundingBoxDescent || 3);
  this.u8.fill(0, p, p + 53); this.w32(p, asc + desc); this.w32(p + 4, asc); this.w32(p + 8, desc);
  this.w32(p + 20, Math.ceil(g.measureText('x').width)); this.w32(p + 24, Math.ceil(g.measureText('W').width)); this.w32(p + 28, dc.font.lf.weight || 400);
  this.u8[p + 44] = 32; this.u8[p + 45] = 255; this.u8[p + 46] = 32; this.u8[p + 47] = 32; this.u8[p + 51] = 6; return 1;
});
def('GDI32', 'GetCharABCWidthsA', 4, function (hdc, a, b, p) {
  const dc = dcOf(this, hdc), g = measureCtx(); g.font = dc.fontCss();
  for (let c = a; c <= b; c++) { this.w32(p + 12 * (c - a), 0); this.w32(p + 12 * (c - a) + 4, Math.ceil(g.measureText(String.fromCharCode(c)).width)); this.w32(p + 12 * (c - a) + 8, 0); }
  return 1;
});
def('GDI32', 'GetTextFaceA', 3, function (hdc, n, buf) { return this.writeA(buf, dcOf(this, hdc).font.lf.face || 'Arial', n); });
def('GDI32', 'GetRasterizerCaps', 2, function (p) { this.w16(p, 4); this.w16(p + 2, 3); this.w16(p + 4, 0); return 1; });
def('GDI32', 'GetDeviceCaps', 2, function (hdc, i) {
  return { 2: 0x400, 4: 320, 6: 240, 8: this.host.width, 10: this.host.height, 12: 24, 14: 1, 24: -1, 38: 0x7e99, 88: 96, 90: 96, 104: 0, 106: 20, 108: 24 }[i] ?? 0;
});
let mctx = null;
const cellRatio = new Map();
function emPerCell(style, face) {
  const k = style + face; if (cellRatio.has(k)) return cellRatio.get(k);
  const g = measureCtx(); g.font = `${style}100px "${face}", "W95 Arial"`;
  const m = g.measureText('M'), cell = (m.fontBoundingBoxAscent || 90) + (m.fontBoundingBoxDescent || 22);
  const r = 100 / cell; cellRatio.set(k, r); return r;
}
function measureCtx() { if (!mctx) mctx = mkCanvas(1, 1).getContext('2d'); return mctx; }
// Palettes: logical palettes resolve PALETTEINDEX colors at draw time.
def('GDI32', 'CreatePalette', 1, function (p) {
  const n = this.r16(p + 2), e = [];
  for (let i = 0; i < n; i++) e.push([this.r8(p + 4 + 4 * i), this.r8(p + 5 + 4 * i), this.r8(p + 6 + 4 * i)]);
  return this.newHandle(new Palette(e));
});
def('GDI32', 'CreateHalftonePalette', 1, function () {
  const e = []; for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) e.push([r * 51, g * 51, b * 51]);
  return this.newHandle(new Palette(e));
});
def('GDI32', 'SelectPalette', 3, function (hdc, h) { const dc = dcOf(this, hdc); const o = dc.pal; const p = this.obj(h); if (p) dc.pal = p; return o ? o.handle : 0; });
def('GDI32', 'RealizePalette', 1, function (hdc) { return dcOf(this, hdc).pal.entries.length; });
def('GDI32', 'UnrealizeObject', 1, () => 1);
def('GDI32', 'GetPaletteEntries', 4, function (h, start, n, p) {
  const pal = this.obj(h); if (!pal) return 0;
  if (!p) return pal.entries.length;
  let k = 0; for (; k < n && start + k < pal.entries.length; k++) { const [r, g, b] = pal.entries[start + k]; this.u8[p + 4 * k] = r; this.u8[p + 4 * k + 1] = g; this.u8[p + 4 * k + 2] = b; this.u8[p + 4 * k + 3] = 0; }
  return k;
});
def('GDI32', 'AnimatePalette', 4, function (h, start, n, p) {
  const pal = this.obj(h); if (!pal) return 0;
  for (let k = 0; k < n && start + k < pal.entries.length; k++) pal.entries[start + k] = [this.r8(p + 4 * k), this.r8(p + 4 * k + 1), this.r8(p + 4 * k + 2)];
  return 1;
});
def('GDI32', 'GetNearestPaletteIndex', 2, function (h, c) {
  const pal = this.obj(h); if (!pal) return 0; const [r, g, b] = rgbOf(c); let best = 0, bd = 1e9;
  pal.entries.forEach(([pr, pg, pb], i) => { const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
});
def('GDI32', 'GetSystemPaletteEntries', 4, function (hdc, s, n, p) { return API.GDI32.GetPaletteEntries[1].call(this, 0x800f, s, n, p); });
def('GDI32', 'GetSystemPaletteUse', 1, () => 1);
def('GDI32', 'SetSystemPaletteUse', 2, () => 1);
def('GDI32', 'GdiFlush', 0, () => 1);

// Read a string resource straight from PE file bytes (used to list savers by description).
function peString(bytes, id) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), p = dv.getUint32(0x3c, true), opt = p + 24;
    const nsec = dv.getUint16(p + 6, true), shdr = opt + dv.getUint16(p + 20, true), rsrc = dv.getUint32(opt + 96 + 16, true);
    const off = rva => { for (let i = 0; i < nsec; i++) { const o = shdr + 40 * i, va = dv.getUint32(o + 12, true), sz = Math.max(dv.getUint32(o + 8, true), dv.getUint32(o + 16, true)); if (rva >= va && rva < va + sz) return rva - va + dv.getUint32(o + 20, true); } return -1; };
    const root = off(rsrc);
    const find = (dir, key) => {
      const n = dv.getUint16(dir + 12, true) + dv.getUint16(dir + 14, true);
      for (let i = 0; i < n; i++) { const e = dir + 16 + 8 * i, nm = dv.getUint32(e, true), o = dv.getUint32(e + 4, true); if (key === undefined || nm === key) return o; }
      return null;
    };
    let o = find(root, 6); o = find(root + (o & 0x7fffffff), (id >> 4) + 1); o = find(root + (o & 0x7fffffff));
    const de = root + (o & 0x7fffffff); let a = off(dv.getUint32(de, true));
    for (let i = 0; i < (id & 15); i++) a += 2 + 2 * dv.getUint16(a, true);
    let str = ''; const n = dv.getUint16(a, true);
    for (let i = 0; i < n; i++) str += String.fromCharCode(dv.getUint16(a + 2 + 2 * i, true));
    return str;
  } catch (_) { return null; }
}

window.W95Win32 = { regOn, regDump, regRestore, Process, API, LAYOUT, WM, YIELD, iniGet, iniSet, iniRead, peString, def, dcOf, GuestError, mkCanvas, dibOut };
})();
