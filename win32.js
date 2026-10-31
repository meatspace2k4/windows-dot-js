'use strict';
// Win32 personality for statically recompiled guest code (see tools/recomp.py).
// Loads a PE image from the in-memory file system into wasm linear memory,
// binds its imports to JS implementations of the KERNEL32/USER32/GDI32 subset
// the Windows 95 screen savers use, and runs the recompiled blocks. GDI output
// goes to a Canvas 2D surface.
(() => {
// guest address space: low runtime area, stack, images at 0x400000/0x1000000, native DLLs from 0x1800000,
// heap, then per-module block lookup tables from 0x5600000
const LAYOUT = { SENTINEL: 0xFFFFFFF0, THUNK: 0xFFFF0000, THUNK16: 0xFFFE0000, FPU: 0x10000, TIB: 0x11000, SCRATCH: 0x12000,
  STACK_LO: 0x100000, STACK_TOP: 0x3ffff0, HEAP: 0x02000000, HEAP_END: 0x05500000,
  // a byte a 4 KB page of the address space, nonzero where ring 3 has no access (the null page, the VxDs' images, the
  // frame buffer's ring-0 mapping): ring-3 code's accesses are checked against it (dyn.js guard), protect() sets it
  PROT: 0x05500000 };
const YIELD = Symbol('yield');   // returned by an API implementation to suspend the guest at depth 0
const NO_CLOCK = Object.freeze({ tick: 0, wall: 0 });   // (a program reading this machine's own clock: Process.clockOf)
const TICK_MS = 65536 * 1000 / 1193182;   // PIT channel 0 period, 54.925 ms
const CPU_REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget',
  // the interrupt flag (IF): cleared by CLI, set by STI, popped by POPF and IRET (dyn.js); the hardware's interrupts
  // wait while it is clear, as the processor holds them (sound.js raiseIRQ, vmm.js vmIrqDeliver)
  'if'];
// the processor is the host's: every BUDGET blocks the dispatcher asks it (tick) whether the guest goes on. A run that
// can give up the processor (a thread at its top level) does after SLICE_MS; one inside a call the host made cannot,
// and runs on, as a processor would: its machine is a worker's (worker.js), so it holds nothing but that machine, whose
// interrupts (the keys, the mouse, the timer) still come at each check
const BUDGET = 0x4000, SLICE_MS = 40;
const WM = { NULL: 0, CREATE: 1, DESTROY: 2, MOVE: 3, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, KILLFOCUS: 8, PAINT: 0xf, CLOSE: 0x10,
  QUIT: 0x12, ERASEBKGND: 0x14, SHOWWINDOW: 0x18, ACTIVATEAPP: 0x1c, SETCURSOR: 0x20, NCCREATE: 0x81, NCDESTROY: 0x82,
  NCACTIVATE: 0x86, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102, SYSKEYDOWN: 0x104, SYSCOMMAND: 0x112, TIMER: 0x113,
  MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, RBUTTONDOWN: 0x204, RBUTTONUP: 0x205, MBUTTONDOWN: 0x207, MBUTTONUP: 0x208, INITDIALOG: 0x110, COMMAND: 0x111 };

class GuestError extends Error {}
/** a thread that runs on and on inside a call the host made: the host takes its processor back, and the thread stays
 *  where it is, never to run again (as a thread spinning forever leaves it) */
class HangError extends Error {}
/** a processor exception nothing in the program handled (or one at ring 0): `fault` says what, where and the state the
 *  processor was in, for the system's answer to it (KERNEL32's fault dialog, VWIN32's blue screen) */
class FaultError extends Error { constructor(f) { super(f.why); this.fault = f; } }
// the trap codes the recompiled code raises (0 #DE, 1 #UD, 2 no code at the address: #PF, 3 #BP, 4 #GP) as vectors, and
// the Win32 exception code each is to a program's handlers
const TRAP_VEC = [0, 6, 14, 3, 13];
const EXC_CODE = { 0: 0xc0000094, 3: 0x80000003, 6: 0xc000001d, 13: 0xc0000005, 14: 0xc0000005 };

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
    // host.vmPages more 64 KiB pages above the layout's, for the address space VirtualAlloc reserves (VMEM)
    const pages = meta.layout.pages + (host.vmPages || 0);
    this.mem = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: !!host.shared });   // (shared: a machine in a worker, whose screen the page reads)
    this.vmLo = this.vmTop = host.vmTop || meta.layout.pages * 0x10000;
    this.cpu = {};
    for (const n of CPU_REGS) this.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'fcw' ? 0x37f : n === 'budget' ? BUDGET : n === 'if' ? 1 : 0);
    this.runLevel = 0; this.yieldLevel = -1;
    this.depth = 0; this.exitCode = null; this.trapped = null; this.waiting = false; this.lastYield = 0;
    // counters a benchmark reads: timer messages taken, GL frames presented, time spent running guest code
    this.stats = { timers: 0, presents: 0, slices: 0, guestMs: 0 };
    this.t0 = host.now();
    this.thunks = []; this.thunkByName = new Map();
    this.handles = new Map(); this.nextHandle = 0x100;
    this.windows = new Map(); this.classes = new Map(); this.queue = []; this.timers = []; this.quit = null;
    this.heapTop = LAYOUT.HEAP; this.freeList = new Map(); this.allocs = new Map();
    this.protect(0, 0x1000);   // (the null page: no program's)
    if (host.memWatch) this.memWatch(host.memWatch[0], host.memWatch[1] || 4);   // (a write watch from the first instruction: ?memwatch=lo,len in hex)
    const math = { fsin: Math.sin, fcos: Math.cos, ftan: Math.tan, fatan2: Math.atan2, fexp2: x => Math.pow(2, x), flog2: Math.log2,
      fmod: (a, b) => a % b, frem: (a, b) => a - b * Math.round(a / b), f80load: a => this.f80load(a), f80store: (a, v) => this.f80store(a, v), btrace: e => { if (window.W95BTRACE) window.W95BTRACE(e >>> 0); } };
    this.imports = { env: { mem: this.mem, api: e => this.api(e), trap: (e, c) => this.trap(e, c), tick: e => this.tick(e), smc: a => this.smc(a), ...math }, cpu: this.cpu };
    this.modules = []; this.byName = new Map(); this.inits = [];
    // a host that runs the native window system brings it up first, as Windows is up before any program starts
    if (host.boot) {
      const t = LAYOUT.TIB; this.w32(t, 0xffffffff); this.w32(t + 4, LAYOUT.STACK_TOP); this.w32(t + 8, LAYOUT.STACK_LO); this.w32(t + 0x18, t);
      this.cpu.fs.value = t; this.reg('esp', LAYOUT.STACK_TOP); this.push(LAYOUT.SENTINEL);
      host.boot(this);
    }
    // the system's process (no image: its first task is a 16-bit one, and programs start in it): nothing of its own runs
    if (!file) { this.noMain = true; return; }
    this.exe = this.loadImage(file, module, meta, 'EXE');
    this.base = this.exe.base;
    this.setupStack(cmdline);
    this.runPendingInits();
    if (host.boot && this.initApp16) this.initApp16();   // the program's start under the native USER (ne16.js)
  }
  // ---- processes: the program this one was started for (pc0), and those it starts (spawn), each with its image,
  // command line, file and id. The running thread's process is the current one; outside any thread, pc0
  get pc() { const t = this.thread16; return (t && t.pc) || this.pc0 || (this.pc0 = { pid: 0x50 }); }
  get exe() { return this.pc.exe; }
  set exe(v) { (this.pc0 || (this.pc0 = { pid: 0x50 })).exe = v; }
  get cmdPtr() { return this.pc.cmdPtr; }
  set cmdPtr(v) { (this.pc0 || (this.pc0 = { pid: 0x50 })).cmdPtr = v; }
  /** the whole pages in [lo, hi) as ring 0's only (`on`), or given back to ring 3: LAYOUT.PROT */
  protect(lo, hi, on = true) { const a = (lo + 0xfff) >>> 12, b = hi >>> 12; if (b > a) this.u8.fill(on ? 1 : 0, LAYOUT.PROT + a, LAYOUT.PROT + b); }
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
    const rec = { name, base, pref, size: dv.getUint32(opt + 56, true), meta, rsrc: dir(2), exports: new Map(), run: null, deps: [] };
    // a DLL Windows 95 loads below 2 GB, in a process's private arena (OLE32, SHELL32, MFC: not the shared arena's,
    // KERNEL32, USER32, GDI32, COMCTL32, based at 80000000h and up): its writable sections are each process's own,
    // but a section marked shared (IMAGE_SCN_MEM_SHARED). One copy for every process, OLE32's "registered" state from
    // Explorer's OleInitialize was Paint's too, while USER keeps the class it registered as Explorer's: Paint's
    // OleInitialize made no class, its window could not be made, and Paint said OLE 2.0 was unable to start
    if (name !== 'EXE' && pref < 0x80000000) {
      const ranges = [];
      for (let i = 0; i < nsec; i++) {
        const o = shdr + 40 * i, ch = dv.getUint32(o + 36, true), vs = dv.getUint32(o + 8, true) || dv.getUint32(o + 16, true), va = dv.getUint32(o + 12, true);
        if (ch & 0x80000000 && !(ch & 0x10000000) && vs) ranges.push([base + va, base + va + vs]);   // (MEM_WRITE, not MEM_SHARED)
      }
      if (ranges.length) rec.priv = { ranges, init: null, cur: null, bufs: new Map() };
    }
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
      const native = this.loadDll(dll); if (native && !rec.deps.includes(native)) rec.deps.push(native);
      // (a DLL that is neither a module here, one implemented here, nor a file: the image is not loaded, as Windows'
      // loader refuses it, "Cannot find ... (or one of its components)"; bound to dead thunks, the program ran into
      // them and its fault's handling stopped the machine)
      if (!native && !API[dll] && !this.peResolve) {   // (a ring-0 image's imports: vmm.js PELDR's own)
        this.modules = this.modules.filter(m => m !== rec); if (this.byName.get(name) === rec) this.byName.delete(name);
        throw Object.assign(new Error(`${name}: ${dll}.DLL is not found`), { missingDll: dll + '.DLL' });
      }
      if (!native && STAND_IN.has(dll)) (this.jsImported || (this.jsImported = new Set())).add(dll);   // (a stand-in for a DLL file that an image imports is loaded: GetModuleHandle finds it)
      for (let k = 0; ; k++, lut += 4) {
        const v = this.r32(lut); if (!v) break;
        const nm = v & 0x80000000 ? '#' + (v & 0xffff) : this.readA(base + v + 2);
        const addr = (native && native.exports.get(nm)) || (this.peResolve && this.peResolve(dll, nm));   // a ring-0 image's (vmm.js PELDR)
        // (who imports an export by ordinal: the name cmd 'watch' gives one that has none, MFC30's)
        if (native && nm[0] === '#') { const by = native.importers || (native.importers = new Map()); if (!by.has(nm)) by.set(nm, new Set()); by.get(nm).add(name === 'EXE' ? (meta.name || name) : name); }
        this.w32(iat + 4 * k, addr || this.thunkFor(dll, nm));
      }
    }
    if (rec.priv) rec.priv.init = rec.priv.ranges.map(([lo, hi]) => this.u8.slice(lo, hi));   // (as a process that attaches first finds it)
    // (an image nothing was recompiled for, a program the system bundle does not carry: no module, its code translated
    // as it runs, dyn.js, as the dispatcher sends any address outside a translated module's text there)
    if (module) {
      rec.run = new WebAssembly.Instance(module, this.imports).exports.run;
      const look = new Uint32Array(this.mem.buffer, meta.lookup, meta.textHi - meta.textLo);
      meta.blocks.forEach((a, i) => { look[a - meta.textLo] = i + 1; });
    }
    if (name !== 'EXE' && meta.entry) { this.inits.push(rec); (this.initOrder || (this.initOrder = [])).push(rec); }
    return rec;
  }
  loadDll(name) {
    if (this.byName.has(name)) return this.byName.get(name);
    const d = this.dlls.get(name) || this.diskDll(name); if (!d) return null;
    const m = this.loadImage(d.file, d.module, d.meta, name);
    if (m && this.onDllLoad) this.onDllLoad(name, m);   // (a module watched as it comes: a shared session's intents, ne16.js)
    if (m && this.onModuleLoad) this.onModuleLoad(name, m);   // (a watch asked for before the module came: worker.js cmd 'watch')
    return m;
  }
  /** where each module is in memory: a PE image from its base for its size; a 16-bit module, each of its segments (its
   *  record has no size: an image's room was looked for as if USER's code at 1A00000h were free, and a program mapped
   *  there wrote over it) */
  moduleSpans(which = () => true) {
    const out = [];
    for (const m of this.modules) {
      if (!which(m)) continue;
      if (m.segs) { for (const s of m.segs) out.push([s.base, s.base + Math.max(s.alloc || 0, s.len || 0, 1)]); }
      else if (m.size) out.push([m.base, m.base + m.size]);
    }
    return out;
  }
  /** room for an image of `size` bytes in the arena below the heap (400000h-2000000h): at `pref` when nothing is there,
   *  else, for one that can be relocated, the first 64 KiB boundary with room; 0 when there is none. A program's own
   *  image (`own`) goes over other programs' images: each process has its own view of that range (arenaClaim) */
  imageRoom(pref, size, relocatable, own = false) {
    const spans = own ? this.moduleSpans(m => m.name !== 'EXE') : this.moduleSpans(), free = a => a >= 0x400000 && a + size <= 0x02000000 && !spans.some(([lo, hi]) => a < hi && lo < a + size);
    if (free(pref)) return pref;
    if (relocatable) for (let a = 0x00620000; a + size <= 0x02000000; a += 0x10000) if (free(a)) return a;
    return 0;
  }
  /** a DLL an image imports or LoadLibrary names that the system bundle does not carry, from its file, as Windows'
   *  loader finds it: the program's folder, SYSTEM, the Windows folder. Mapped where there is room, its code translated
   *  as it runs (dyn.js); null when there is no such file or it is no Win32 DLL. (Bound to no DLL, Paint's imports of
   *  MFC30.DLL were dead thunks: the first call faulted, and its handling ran garbage until the machine stopped) */
  diskDll(name) {
    // (one this system implements, the personality's KERNEL32, ADVAPI32, ...: that one, never its file)
    if (!this.fs || API[name] || STAND_IN.has(name) || !/^[A-Z0-9_$~!#%&'()@^`{}-]+(\.[A-Z0-9]+)?$/i.test(name)) return null;
    const file = /\./.test(name) ? name : name + '.DLL';
    const dirs = [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS'];
    let f = null;
    for (const d of dirs) { try { f = this.fs.readFile(d + '\\' + file); break; } catch (_) { /* not there */ } }
    if (!f || f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return null;
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength), pe = dv.getUint32(0x3c, true);
    if (pe + 0xf8 > f.length || dv.getUint32(pe, true) !== 0x4550 || !(dv.getUint16(pe + 22, true) & 0x2000)) return null;   // (IMAGE_FILE_DLL)
    const opt = pe + 24, pref = dv.getUint32(opt + 28, true), size = dv.getUint32(opt + 56, true), ep = dv.getUint32(opt + 16, true);
    const relocatable = !(dv.getUint16(pe + 22, true) & 1) && dv.getUint32(opt + 96 + 5 * 8 + 4, true) > 0;
    const base = this.imageRoom(pref, size, relocatable);
    if (!base) { log('warn', 'win32', `${file}: no room for its image at ${pref.toString(16)}`); return null; }
    const d = { file: f, module: null, meta: { base, entry: ep ? base + ep : 0, textLo: 0, textHi: 0, blocks: [], size, dynamic: true } };
    this.dlls.set(name, d);
    return d;
  }
  /** a module handle as the running process sees it: its program at the base the program's header prefers (where
   *  every Windows 95 process has its own, in its private arena), which here may be elsewhere in the shared space */
  hmod(h) { const e = this.exe; return e && e.pref && h === e.pref && e.base !== e.pref ? e.base : h; }
  /** the module handle of a DLL implemented here (OPENGL32), one per name: LoadLibrary's and GetModuleHandle's */
  jsDll(name) {
    const m = this.jsDlls || (this.jsDlls = new Map());
    if (!m.has(name)) m.set(name, 0x10000000 | (this.newHandle({ kind: 'module', name }) & 0xffff));
    return m.get(name);
  }
  moduleFor(h) { h = this.hmod(h); const e = this.exe; return e && e.base === h ? e : this.modules.find(m => m.base === h && !m.hidden) || e; }   // (the running process's own program first: another's may be at its base, arenaClaim)
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

  /** DllMain(DLL_PROCESS_ATTACH) for the DLLs loaded since the last run. SHELL32 is then told OLE is available
   *  (SHLoadOLE #151, SHELLNOTIFY_OLELOADED), as Explorer tells it on Windows 95, where SHELL32's state is shared by
   *  every process: until then its clipboard and drag and drop calls fail */
  runPendingInits() {
    const pending = this.inits; this.inits = [];
    for (const m of pending) this.attach(m);
  }
  /** DllMain(DLL_PROCESS_ATTACH) of a DLL for the current process, once: each process attaches to every DLL it uses,
   *  as Windows 95 attaches them, though the image is loaded once in this address space */
  /** the DLLs a module imports, and theirs, dependencies first (the order DllMain runs in) */
  importClosure(m, out = [], seen = new Set()) {
    if (seen.has(m)) return out; seen.add(m);
    for (const d of m.deps || []) this.importClosure(d, out, seen);
    out.push(m); return out;
  }
  attach(m) {
    const pc = this.pc, done = pc.attached || (pc.attached = new Set());
    if (done.has(m) || !m.meta || m.clock) return;
    done.add(m);
    // (its data as a new process gets it, a DLL of the private arena's: as loaded, the attached ones' put by)
    const v = m.priv;
    if (v && v.init) {
      if (v.cur === null) v.cur = pc;
      else if (v.cur !== pc) { if (v.cur !== GONE) v.bufs.set(v.cur, v.ranges.map(([lo, hi]) => this.u8.slice(lo, hi))); v.ranges.forEach(([lo], i) => this.u8.set(v.init[i], lo)); v.cur = pc; }
    }
    if (!m.meta.entry) return;
    this.call(m.meta.entry, [m.base, 1, 0]);
    const ole = m.name === 'SHELL32' && m.exports.get('#151');
    if (ole) { this.shellNotifyList(m); this.call(ole, [2]); }
  }
  /** the private-arena DLLs' data of process `pc` (the system's when null) in place, as the thread that runs is that
   *  process's (ne16.js imgUse) */
  dllUse(pc) {
    const key = pc || this.pc0 || (this.pc0 = { pid: 0x50 });
    for (const m of this.modules || []) {
      const v = m.priv; if (!v || !v.init || v.cur === key || !v.bufs.has(key)) continue;
      if (v.cur !== GONE && v.cur !== null) v.bufs.set(v.cur, v.ranges.map(([lo, hi]) => this.u8.slice(lo, hi)));
      const mine = v.bufs.get(key); v.bufs.delete(key); v.ranges.forEach(([lo], i) => this.u8.set(mine[i], lo)); v.cur = key;
    }
  }
  /** a process's end: its copies of the DLLs' data go */
  dllForget(pc) { for (const m of this.modules || []) { const v = m.priv; if (!v) continue; v.bufs.delete(pc); if (v.cur === pc) v.cur = GONE; } }
  /** a range of the arena where programs' images overlap, Windows 95 mapping each process's at the base its header
   *  names in an address space of its own (400000h-7FFFFFFFh): two programs linked at 400000h without relocations run
   *  at once, and two instances of one program each have their own data. A slot keeps one copy of [lo, hi) per view:
   *  the process's own (`own`) for those whose image was mapped over it, view 0 for every other process's; the copy in
   *  place is the view of the process whose thread runs (arenaUse), and the image of a process whose view is put by is
   *  `hidden` from the dispatcher. The new process `pc`'s view, as its image is about to be mapped at [lo, hi) */
  arenaClaim(pc, lo, hi) {
    const arena = this.arena || (this.arena = []);
    let s = arena.find(v => v.lo < hi && lo < v.hi);
    if (!s) {
      if (![...(this.procs || new Map()).values()].some(x => x !== pc && x.exitCode === null && x.exe && x.exe.base < hi && lo < x.exe.base + x.exe.size)) return;
      s = { lo, hi, cur: 0, own: new Set(), bufs: new Map(), spare: null }; arena.push(s);
    }
    if (lo < s.lo || hi > s.hi) {   // (grown over the new image: each copy put by takes what is in place there now)
      const nlo = Math.min(lo, s.lo), nhi = Math.max(hi, s.hi);
      for (const [k, b] of s.bufs) { const g = this.u8.slice(nlo, nhi); g.set(b, s.lo - nlo); s.bufs.set(k, g); }
      s.lo = nlo; s.hi = nhi; s.spare = null;
    }
    if (s.cur !== null) s.bufs.set(s.cur, this.u8.slice(s.lo, s.hi));
    s.own.add(pc); s.cur = pc;
    this.arenaHide(s);
  }
  /** the views of process `pc` (view 0 for the system's context, null) in place */
  arenaUse(pc) {
    for (const s of this.arena || []) {
      const key = pc && s.own.has(pc) ? pc : 0, mine = s.bufs.get(key);
      if (s.cur === key || !mine) continue;
      if (s.cur !== null) { const put = s.spare && s.spare.length === mine.length ? s.spare : new Uint8Array(mine.length); put.set(this.u8.subarray(s.lo, s.hi)); s.bufs.set(s.cur, put); }
      this.u8.set(mine, s.lo); s.bufs.delete(key); s.spare = mine; s.cur = key;
      this.arenaHide(s);
    }
  }
  /** which programs' images in slot s are in place: those of the processes whose view is */
  arenaHide(s) {
    const live = [...(this.procs || new Map()).values()].filter(x => x.exitCode === null && x.exe && x.exe.base < s.hi && s.lo < x.exe.base + x.exe.size);
    for (const x of live) x.exe.hidden = true;
    for (const x of live) if (s.own.has(x) ? s.cur === x : s.cur === 0) x.exe.hidden = false;
  }
  /** a process's end: its view goes, and its image's record with it when no process goes on with that image; a slot
   *  no process has a view of its own in any more is view 0's again */
  arenaForget(pc) {
    for (const s of [...(this.arena || [])]) {
      if (!s.own.has(pc)) continue;
      s.own.delete(pc); s.bufs.delete(pc); if (s.cur === pc) s.cur = null;
      if (pc.exe && ![...(this.procs || new Map()).values()].some(x => x.exe === pc.exe && x.exitCode === null)) this.modules = this.modules.filter(m => m !== pc.exe);
      if (s.own.size) { this.arenaHide(s); continue; }
      if (s.cur === null && s.bufs.has(0)) { this.u8.set(s.bufs.get(0), s.lo); s.cur = 0; }
      this.arenaHide(s);
      this.arena = this.arena.filter(v => v !== s);
    }
  }
  /** SHELL32's change notification clients (a DSA of 0x18-byte entries in its shared data), which SHLoadOLE walks to
   *  tell each that OLE is loaded. On Windows 95 Explorer's registration made it before any process loads OLE; here
   *  each process has its own copy of SHELL32's data, so a process gets the empty list Explorer's own would hold */
  shellNotifyList(m) {
    const at = m.base + 0x18045, slot = this.u8[at] === 0xa1 && this.r32(at + 1);   // mov eax, [list]
    const dsa = this.byName.get('COMCTL32') && this.byName.get('COMCTL32').exports.get('#320');      // DSA_Create
    if (slot && dsa && !this.r32(slot)) this.w32(slot, this.call(dsa, [0x18, 8]));
  }

  // ---- execution
  /** Dispatch across modules until the sentinel (0), a yield (1) or a fault (2). */
  runAt(eip) {
    if (this.runLevel++ === 0) this.runT0 = this.now();   // the host's processor is the guest's from here
    try { return this.dispatch(eip); } finally { this.runLevel--; }
  }
  /** run at `eip` as a thread's top level: a run that can give up the processor when its time is up (1) */
  runTop(eip) {
    const was = this.yieldLevel; this.yieldLevel = this.runLevel + 1;
    try { return this.runAt(eip); } finally { this.yieldLevel = was; }
  }
  /** a module's code written over (code that patches itself): the block holding the address is translated again from
   *  what is there now, at run time (dyn.js), from here on */
  smc(a) {
    a = u32(a);
    const m = this.modules.find(x => x.meta && x.meta.lookup && a >= x.meta.textLo && a < x.meta.textHi); if (!m) return;
    const bl = m.meta.blocks; let lo = 0, hi = bl.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bl[mid] <= a) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    const look = new Uint32Array(this.mem.buffer, m.meta.lookup, m.meta.textHi - m.meta.textLo);
    for (let i = Math.max(0, at); i < bl.length && bl[i] < a + 4; i++) look[bl[i] - m.meta.textLo] = 0;
  }
  /** the dispatcher's question when the block budget runs out: 1 to give the processor back to the host here */
  tick(eip) {
    this.cpu.budget.value = BUDGET;
    if (this.inputPoll && !this.inPoll) { this.inPoll = true; try { this.inputPoll(); } finally { this.inPoll = false; } }   // interrupts: the keyboard's and the mouse's
    if (this.runLevel === this.yieldLevel && !this.noPreempt) {
      if (this.now() - this.runT0 < SLICE_MS) return 0;
      this.preempted = u32(eip); return 1;
    }
    return 0;   // (inside a call the host made it cannot stop: it runs on)
  }
  /** no code at `at` the processor can run (nothing mapped there: #PF; an instruction run-time translation cannot
   *  take: #UD): the exception's continuation, or null for a stop of the emulator's own (trapped) */
  noCode(at) {
    const t = this.trapped || '';
    (this.faultLog || (this.faultLog = [])).push({ at: u32(at).toString(16), atIn: this.whereOf(at), why: t, esp: u32(this.cpu.esp.value).toString(16), from: u32(this.lastBlock || 0).toString(16), fromIn: this.whereOf(this.lastBlock || 0), cs: (this.cpu.cs.value & 0xffff).toString(16), ss: (this.cpu.ss.value & 0xffff).toString(16), thread: this.thread16 ? this.thread16.id : 'main' }); if (this.faultLog.length > 50) this.faultLog.shift();   // (a diagnostic: cmd 'faults')
    if (/^run-time code/.test(t)) { log('warn', 'win32', t); this.trapped = null; return this.raise(6, at); }   // (an emulator gap: named)
    if (t && !/^jump to unmapped address/.test(t)) return null;
    this.trapped = null; return this.raise(14, at, at);
  }
  // ---- diagnostics (worker.js cmd 'watch', 'memwatch', 'probe', 'faults'; SCRIPTING.md, Diagnostics)
  /** a linear address as a symbol: a thunk's import, a 16-bit module's segment:offset, or a 32-bit module's offset,
   *  with the nearest export at or before it (its name and the offset past it) when the module has one */
  whereOf(lin) {
    lin = u32(lin);
    const N = window.W95NE16, T16 = N && N.L.T16;
    if (T16 && lin >= T16 && lin < T16 + 0x10000 && this.th16) { const th = this.th16[(lin - T16) >> 2]; if (th) return `thunk ${th.key}`; }
    if (lin >= LAYOUT.THUNK && this.thunks) { const t = this.thunks[(lin - LAYOUT.THUNK) >> 2]; if (t) return `${t.dll}!${t.nm}`; }
    for (const m of this.ne ? this.ne.values() : []) {
      for (const g of m.segs || []) {
        const live = g.sel && this.selValid && this.selValid(g.sel), b = live ? u32(this.selBase(g.sel)) : g.base, len = g.len || (live ? this.selLimit(g.sel) + 1 : 0);
        if (!b || lin < b || lin >= b + len) continue;
        const off = lin - b, s = this.neSym(m, g, off);
        return `${m.name} ${g.num}:${off.toString(16)}${s ? ` (${s})` : ''}`;
      }
    }
    for (const m of this.modules || []) {
      if (!m.base || !m.size || lin < m.base || lin >= m.base + m.size) continue;
      const s = this.peSym(m, lin);
      return `${m.name || '?'}+${(lin - m.base).toString(16)}${s ? ` (${s})` : ''}`;
    }
    return lin.toString(16);
  }
  /** the export of 32-bit module `m` at or before `lin`, as name+offset; '' with none */
  peSym(m, lin) {
    if (!m.exports || !m.exports.size) return '';
    if (!m.symList) m.symList = [...m.exports].filter(([, a]) => typeof a === 'number' && a >= m.base && a < m.base + m.size).sort((x, y) => x[1] - y[1]);
    const l = m.symList; let lo = 0, hi = l.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (l[mid][1] <= lin) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0) return '';
    const [nm, a] = l[at]; return lin === a ? nm : `${nm}+${(lin - a).toString(16)}`;
  }
  /** the export of 16-bit module `m` in segment `g` at or before offset `off`, as name (or #ordinal)+offset */
  neSym(m, g, off) {
    if (!m.exports || !m.exports.size || !g.sel) return '';
    if (!m.symList) {
      const byOrd = new Map(); for (const [k, v] of Object.entries(m.names || {})) { if (typeof v === 'number') byOrd.set(v, k); else if (/^\d+$/.test(k)) byOrd.set(+k, v); }
      m.symList = [...m.exports].map(([ord, a]) => [byOrd.get(ord) || `#${ord}`, a >>> 16, a & 0xffff]).sort((x, y) => x[1] - y[1] || x[2] - y[2]);
    }
    let best = null;
    for (const e of m.symList) { if ((e[1] | 1) !== (g.sel | 1)) continue; if (e[2] <= off) best = e; else break; }
    if (!best) return '';
    return off === best[2] ? best[0] : `${best[0]}+${(off - best[2]).toString(16)}`;
  }
  /** `fn` run as execution reaches linear `at` through the dispatcher (an export another module enters, a return
   *  address another module returns to), beside any hook there already; the function that removes it. A hook that
   *  answers where to go on (ne16.js clockCall) ends the chain */
  addEntryHook(at, fn) {
    at = u32(at);
    const hooks = this.entryHooks || (this.entryHooks = new Map()), lists = this.entryLists || (this.entryLists = new Map());
    let l = lists.get(at);
    if (!l) {
      l = { fns: [], was: hooks.get(at) || null }; lists.set(at, l);
      hooks.set(at, function () { for (const f of l.fns.slice()) { const to = f.call(this); if (to !== undefined) return to; } return l.was ? l.was.call(this) : undefined; });
    }
    l.fns.push(fn);
    return () => { const i = l.fns.indexOf(fn); if (i >= 0) l.fns.splice(i, 1); if (!l.fns.length) { lists.delete(at); if (l.was) hooks.set(at, l.was); else hooks.delete(at); } };
  }
  /** at an export's entry: `fn(eax, edx)` once the call returns to its caller (the return address on the stack now:
   *  a 32-bit near return, or a 16-bit far one), matched by thread and stack depth so nested and concurrent calls
   *  each find their own. Only a return that comes back through the dispatcher is seen (one from another module) */
  onReturn(fn) {
    const seg = !!(this.cpu.ss.value & 0xffff), sp = seg ? u32(this.cpu.ssb.value) + (this.cpu.esp.value & 0xffff) : u32(this.cpu.esp.value);
    const ret = seg ? u32(this.selBase(this.r16(sp + 2)) + this.r16(sp)) : u32(this.r32(sp)), th = this.thread16 ? this.thread16.id : 'main', self_ = this;
    const pend = this.retPend || (this.retPend = new Map()), key = ret, list = pend.get(key) || [];
    if (!list.length) pend.set(key, list);
    const rec = { th, sp, fn };
    list.push(rec);
    if (list.length === 1) {
      list.off = this.addEntryHook(ret, function () {
        const now = (this.cpu.ss.value & 0xffff) ? u32(this.cpu.ssb.value) + (this.cpu.esp.value & 0xffff) : u32(this.cpu.esp.value), me = this.thread16 ? this.thread16.id : 'main';
        let k = -1; for (let i = list.length - 1; i >= 0; i--) if (list[i].th === me && now > list[i].sp) { k = i; break; }
        if (k < 0) return undefined;
        const [r] = list.splice(k, 1);
        if (!list.length) { pend.delete(key); list.off(); }
        try { r.fn.call(self_, u32(this.cpu.eax.value), u32(this.cpu.edx.value)); } catch (e) { console.error(e); }
        return undefined;
      });
    }
  }
  /** a write watch on linear [lo, lo+len): the range is compared with its last contents at each dispatch (a block of a
   *  recompiled module, a stand-in's call) and each run-time block, and the first change since, with what ran last,
   *  goes in `hits` (cmd 'memwatch'); null ends it */
  memWatch(lo, len) {
    this.memW = lo == null ? null : { lo: u32(lo), len: len | 0, snap: this.u8.slice(u32(lo), u32(lo) + (len | 0)), hits: [], n: 0 };
    return this.memW;
  }
  memCheck(by) {
    const w = this.memW, u8 = this.u8, s = w.snap, lo = w.lo, n = w.len; let i = 0;
    for (; i < n; i++) if (u8[lo + i] !== s[i]) break;
    if (i === n) return;
    let j = n - 1; while (j > i && u8[lo + j] === s[j]) j--;
    w.n++;
    if (w.hits.length < 50) w.hits.push({ at: (lo + i).toString(16), n: j - i + 1, was: Array.from(s.subarray(i, Math.min(j + 1, i + 16))), now: Array.from(u8.subarray(lo + i, Math.min(lo + j + 1, lo + i + 16))),
      by: by || this.whereOf(this.lastBlock || 0), thread: this.thread16 ? this.thread16.id : 'main', t: Math.round(this.now()),
      // (the return addresses on the stack then, as symbols: who the code that wrote was called by)
      stack: Array.from({ length: 48 }, (_, k) => this.r32(u32(this.cpu.esp.value) + 4 * k)).filter(v => this.modules.some(m => m.meta && v >= m.meta.textLo && v < m.meta.textHi)).map(v => this.whereOf(v)) });
    s.set(u8.subarray(lo, lo + n));
  }
  dispatch(eip) {
    for (;;) {
      eip >>>= 0;
      if (eip === LAYOUT.SENTINEL) return 0;
      if (this.runHook) this.runHook(eip);   // debugging: set from the page to watch every dispatch
      if (this.memW) this.memCheck();
      // (an export another module enters, watched: a shared session's intents, ne16.js hookIntents; a hook that answers
      // the call itself gives where it returns to: a program's clock, ne16.js hookClock)
      if (this.entryHooks) { const h = this.entryHooks.get(eip); if (h) { const to = h.call(this); if (to !== undefined) { eip = to; continue; } } }
      const m = eip >= LAYOUT.THUNK16 ? this.modules[0] : this.modules.find(x => eip >= x.meta.textLo && eip < x.meta.textHi && !x.hidden);   // (not a program whose process's view is put by: arenaUse)
      if (!m) {
        if (eip < 0x10000) (this.nullJumps || (this.nullJumps = [])).push({ at: eip, from: this.lastBlock >>> 0, cs: this.cpu.cs ? this.cpu.cs.value & 0xffff : null });
        const next = this.dataCode && this.dataCode(eip);
        if (next !== undefined && next !== null) { eip = next; continue; }
        const dyn = this.dynRun && this.dynRun(eip);   // code generated at run time (dyn.js)
        if (dyn === -1) return 1;   // its time was up
        if (dyn !== undefined && dyn !== null) { eip = dyn; continue; }
        const go = this.noCode(eip); if (go === null) return 2;
        eip = go; continue;
      }
      if (this.modeSwitch && eip < LAYOUT.THUNK16) this.modeSwitch(m);
      if (m.clock) this.tick16();   // SYSTEM.DRV reads the time the timer VxD keeps current
      let r;
      this.lastBlock = eip;
      try { r = m.run(eip); } catch (e) {
        // an access past the end of memory (a pointer that is no address the machine has): a page fault where the guest
        // made it, for its own handlers or its fault dialog, as the processor raises one; not the machine's end
        if (!(e instanceof WebAssembly.RuntimeError) || !/out of bounds/.test(e.message)) throw e;
        const at = u32(this.cpu.eip.value);
        log('warn', 'win32', `${m.name || '?'}: memory access out of bounds in the block at ${at.toString(16)} (thread ${this.thread16 ? this.thread16.id : 'main'})`);
        eip = this.raise(14, at, 0xffffffff); continue;
      }
      if (r === 2 && this.dynWant !== undefined) {   // no translated block there: code written at run time
        const at = this.dynWant; this.dynWant = undefined;
        const dyn = this.dynRun(at);
        if (dyn === null) { const go = this.noCode(at); if (go === null) return 2; eip = go; continue; }
        if (dyn === -1) return 1;
        eip = dyn; continue;
      }
      if (r !== 3) return r;
      eip = this.reg('eip');
    }
  }
  /** Run until the guest blocks for messages or exits. Returns false once the process has exited. */
  slice() {
    if (this.exitCode !== null || this.fault) return false;
    if (this.trapped) { this.fail(this.trapped); return false; }
    if (this.noMain) { if (this.userStack) this.userStack(); return true; }   // the system's process: its threads run (threads16)
    if (this.win16Held && this.win16Held.who !== 'main') return true;   // another thread holds the Win16Lock: this one waits for it
    if (this.hungMain) return true;   // the main thread hung: it never runs again
    this.depth = 0; this.waiting = false; this.lastYield = this.now();
    if (this.userStack) this.userStack();
    let r; this.preempted = 0;
    if (this.mainCtx) { this.loadFull(this.mainCtx); this.mainCtx = null; if (this.rebaseGlobals) { this.rebaseGlobals(); this.resumeEip = u32(this.cpu.eip.value); } }   // where its time ran out, every register as it was (a global block's segment at the block's base now, EIP at the same offset in it)
    try { r = this.runTop(this.resumeEip); }
    catch (e) {
      if (e instanceof FaultError) { this.depth = 0; this.faulted(e.fault); return false; }
      if (!(e instanceof HangError)) throw e; this.hungMain = true; this.depth = 0; this.hung('main', e); return true;
    }
    if (r === 1) { this.resumeEip = this.reg('eip'); if (this.preempted) this.mainCtx = this.saveFull(); this.holdWin16('main'); return true; }
    this.holdWin16('main');
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
  /** the whole processor state, for a thread stopped between any two blocks (its flags and FPU stack live) */
  saveFull() {
    const c = {}; for (const r of CPU_REGS) if (r !== 'budget') c[r] = this.cpu[r].value;
    c.fpu = this.u8.slice(LAYOUT.FPU, LAYOUT.FPU + 64); c.depth = this.depth; c.stackLevel = this.stackLevel; c.sysLevel = this.sysLevel || 0;
    return c;
  }
  loadFull(c) {
    for (const r of CPU_REGS) if (r !== 'budget') this.cpu[r].value = c[r];
    this.u8.set(c.fpu, LAYOUT.FPU); this.depth = c.depth; this.stackLevel = c.stackLevel; this.sysLevel = c.sysLevel;
  }
  /** the Win16Lock after a thread's run: a thread that gave up the processor in 16-bit code, or inside a system level it
   *  entered (_EnterSysLevel), keeps it, and no other thread enters 16-bit code until it lets it go; one that hung keeps
   *  it for good. The host reads `win16Held` (who, since when, the processor time it has run holding it, hung) */
  holdWin16(who, hung = false) {
    const holds = hung || (this.preempted && ((this.cpu.cs.value & 0xffff) !== 0 || this.sysLevel > 0));
    const ran = this.now() - this.runT0;   // the processor time it had in this run, holding the lock
    if (holds) {
      if (!this.win16Held || this.win16Held.who !== who) this.win16Held = { who, since: this.now(), hung, cpu: ran };
      else { this.win16Held.cpu += ran; if (hung) this.win16Held.hung = true; }
    }
    else if (this.win16Held && this.win16Held.who === who) this.win16Held = null;
  }
  /** a thread hung (HangError): it stays as it is, holding the Win16Lock, and the system is frozen behind it */
  hung(who, e) {
    log('warn', 'win32', `${typeof who === 'string' ? who : 'thread ' + who.id} ${e.message}`);
    this.holdWin16(who, true);
  }
  /** a processor exception that ends the program (or, at ring 0, the system's answer first): the host reads `fault` */
  faulted(f) {
    if (this.fault) return;
    this.fault = f;
    log('error', 'win32', `${this.meta.name || ''} ${f.ring === 0 ? 'fatal exception' : 'fault'}: ${f.why} in ${f.module}`);
    // (in the fault log too, with the processor's state and the address a page fault was at: cmd 'faults')
    (this.faultLog || (this.faultLog = [])).push({ why: f.why, at: f.eip.toString(16), atIn: this.whereOf(f.eip), cr2: f.cr2.toString(16), ring: f.ring, module: f.module,
      regs: Object.fromEntries(Object.entries(f.regs).map(([k, v]) => [k, v.toString(16)])), stack: f.stack.slice(0, 12).map(v => `${v.toString(16)} ${this.whereOf(v) || ''}`.trim()), thread: this.thread16 ? this.thread16.id : 'main' });
  }
  fail(why) {
    if (this.failed) return;
    this.failed = true; this.trapped = why;
    log('error', 'win32', `${this.meta.name || ''} stopped: ${why}`);
    this.host.exited(-1, why);
  }
  /** processor exception `n` at `eip` (cr2: the address a page fault was at), as Windows 95 takes one: at ring 0 it is
   *  fatal (VWIN32's blue screen); in 16-bit code it goes to the client's exception handler (DPMI 0203h, KERNEL's),
   *  in 32-bit code to the thread's structured handlers; one nothing handles ends the program (KERNEL32's fault
   *  dialog). Returns where to go on (the handler's continuation); throws FaultError when nothing takes it */
  raise(n, eip, cr2 = 0) {
    const f = this.faultInfo(n, eip, cr2);
    if (f.ring === 0) throw new FaultError(f);
    if (f.seg) {
      if (this.exception16 && this.exception16(n, eip)) return u32(this.cpu.eip.value);
      throw new FaultError(f);
    }
    if (!this.r32(this.cpu.fs.value) || this.r32(this.cpu.fs.value) === 0xffffffff) throw new FaultError(f);
    const r = sehDispatch(this, EXC_CODE[n] || 0xc0000005, eip, n === 14 || n === 13 ? [this.pfWrite ? 1 : 0, cr2] : [], f);
    if (r === null) throw new FaultError(f);
    return r;
  }
  /** the processor's state at an exception, as the fault dialog's details and the blue screen give it */
  faultInfo(n, eip, cr2) {
    const cs = this.cpu.cs.value & 0xffff, m = this.modules.find(x => x.meta && eip >= x.meta.textLo && eip < x.meta.textHi);
    const ring = this.r0Depth > 0 || (m && m.kind === 'vxd') ? 0 : 3;
    const regs = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp']) regs[r] = u32(this.cpu[r].value);
    let flags = 0x202; for (const [r, b] of [['cf', 0], ['pf', 2], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) flags |= (this.cpu[r].value & 1) << b;
    let module = '<unknown>', at = eip, sel = cs || (ring ? 0x137 : 0x28);
    if (cs && this.neByHandle) {   // 16-bit: the module's file and the segment's number, the offset in it
      const ne = this.neByHandle(cs); const sg = ne && ne.meta && ne.meta.segs && ne.meta.segs.findIndex(x => x.sel === (cs & ~7) || x.sel === cs);
      if (ne) { module = (ne.fileName || ne.name + '.EXE').toUpperCase(); if (sg >= 0) sel = sg + 1; at = (eip - u32(this.selBase(cs))) >>> 0; }
    } else {
      // (the image the address is in, its code translated as it runs too (dyn.js): a program the bundle does not carry)
      const im = m || this.modules.find(x => !x.hidden && !x.segs && x.size && eip >= x.base && eip < x.base + x.size);
      const of = im && im.name === 'EXE' && (im === this.exe ? this.pc : [...(this.procs || new Map()).values()].find(x => x.exe === im));
      if (im) module = im.kind === 'vxd' ? im.name : im.name === 'EXE' ? (of && of.path ? of.path.replace(/^.*\\/, '') : (this.meta.name || 'EXE') + '.EXE').toUpperCase() : (typeof im.file === 'string' ? im.file : im.name + '.DLL').toUpperCase();   // (a DLL's file is its image's bytes)
    }
    const bytes = [], stack = [];
    for (let i = 0; i < 16; i++) bytes.push(eip + i < this.u8.length ? this.u8[eip + i] : 0);
    const sp = this.stackLin ? this.stackLin() : regs.esp;
    for (let i = 0; i < 32; i++) stack.push(sp + 4 * i + 4 <= this.u8.length ? this.r32(sp + 4 * i) : 0);
    const segs = {}; for (const r of ['ds', 'es', 'ss', 'fsel', 'gsel']) segs[r] = this.cpu[r].value & 0xffff;
    return { n, eip, cr2, ring, seg: !!cs, cs: sel, module, offset: m && m.kind === 'vxd' ? eip - m.base : at, vxd: m && m.kind === 'vxd' ? m.name : null,
      regs, flags, segs, bytes, stack, program: this.pc && this.pc.path ? this.pc.path : null, why: `exception ${n.toString(16)}h at ${eip.toString(16)}` };
  }
  trap(eip, code) {
    if (code === 2 && this.dynRun) { this.dynWant = u32(eip); return; }
    if (code === 1) log('warn', 'win32', `unsupported instruction at ${u32(eip).toString(16)} (cs ${(this.cpu.cs.value & 0xffff).toString(16)})`);   // (an emulator gap: named)
    if (code <= 4) { this.cpu.eip.value = this.raise(TRAP_VEC[code], u32(eip), code === 2 ? u32(eip) : 0) | 0; return; }
    // (ring-3 code's access to a page it has no access to, dyn.js guard: a page fault at the instruction, the address
    // the access was to in CR2, a write's flagged in the exception's information)
    if ((code & ~0x10) === 0x4000000) {
      // (the pages below the thread's stack, ne16.js stackAlloc: the stack has run out, a stack fault the program does
      // not get to handle, as nothing can be pushed for a handler)
      const limit = this.r32(this.cpu.fs.value + 8) >>> 0;
      if (u32(eip) < limit && u32(eip) >= limit - 0x10000) {
        log('warn', 'win32', `stack fault: thread ${this.thread16 ? this.thread16.id : 'main'}'s stack ran out at ${u32(eip).toString(16)}`);
        throw new FaultError(Object.assign(this.faultInfo(12, u32(this.cpu.eip.value), u32(eip)), { why: `stack fault at ${u32(this.cpu.eip.value).toString(16)}` }));
      }
      this.pfWrite = !!(code & 0x10);
      (this.faultLog || (this.faultLog = [])).push({ why: `ring 3 ${this.pfWrite ? 'write' : 'read'} at ${u32(eip).toString(16)}, a protected page`, at: u32(this.cpu.eip.value).toString(16), atIn: this.whereOf(this.cpu.eip.value), thread: this.thread16 ? this.thread16.id : 'main',
        stack: Array.from({ length: 16 }, (_, k) => this.r32(u32(this.cpu.esp.value) + 4 * k)).map(v => this.whereOf(v)).filter(s => s && /[A-Z]/.test(s)) }); if (this.faultLog.length > 50) this.faultLog.shift();
      try { this.cpu.eip.value = this.raise(14, u32(this.cpu.eip.value), u32(eip)) | 0; } finally { this.pfWrite = false; }
      return;
    }
    if (this.trapHook && this.trapHook(eip, code)) return;
    this.trapped = `${['divide error', 'unsupported instruction', 'jump to unmapped address', 'breakpoint'][code] || 'trap'} at ${u32(eip).toString(16)}`;
    if (code === 0) this.cpu.eip.value = LAYOUT.SENTINEL | 0;
  }
  api(eip) {
    // debugging: window.W95WATCHDOG (ms) stops a slice that runs that long without returning to the host
    if (window.W95WATCHDOG && (++this.wdCount & 1023) === 0 && this.now() - (this.lastYield || this.t0) > window.W95WATCHDOG) {
      const ret = this.r32(this.reg('esp')), t = u32(eip) < LAYOUT.THUNK ? null : this.thunks[(u32(eip) - LAYOUT.THUNK) >> 2], m = this.modules.find(x => x.size && ret >= x.base && ret < x.base + x.size);
      this.trapped = `watchdog: guest ran ${Math.round(this.now() - (this.lastYield || this.t0))} ms in one slice (calling ${t ? t.dll + '!' + t.nm : u32(eip).toString(16)} from ${m ? (m === this.exe || m.name === 'EXE' ? (this.pc.path || 'EXE') : m.name) + '+' + (ret - m.base).toString(16) : ret.toString(16)}, thread ${this.thread16 ? this.thread16.id : 'main'})`;
      return LAYOUT.SENTINEL;
    }
    if (u32(eip) < LAYOUT.THUNK) return this.api16(u32(eip));
    const t = this.thunks[(u32(eip) - LAYOUT.THUNK) >> 2];
    if (!t || !t.def) {   // a call into an import with nothing behind it: a page fault at its address, from where it was called
      log('warn', 'win32', `unimplemented import ${t ? t.dll + '!' + t.nm : u32(eip).toString(16)}`);
      try { return this.raise(14, u32(eip), u32(eip)); } catch (e) { if (e instanceof FaultError) e.fault.import = t ? t.dll + '!' + t.nm : ''; throw e; }
    }
    const [nargs, fn] = t.def, sp = this.reg('esp');
    if (window.W95TRACE) window.W95TRACE(t, this);
    // (a call osclass.js classes: in the effects log, with its cause, once a process; ne16.js effect)
    if (t.cls === undefined) t.cls = (window.W95OSClass && window.W95OSClass.api(t.nm)) || null;
    if (t.cls && this.effect) this.effect(t.cls, `${t.dll}!${t.nm}`);
    if (nargs === 'regs') {   // register-convention entry: the implementation moves ESP and picks the continuation
      try { return u32(fn.call(this)); }
      catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } throw e; }
    }
    const a = []; for (let i = 0; i < (nargs < 0 ? 8 : nargs); i++) a.push(this.r32(sp + 4 + 4 * i));
    const pc = this.thread16 && this.thread16.pc;
    if (pc && /\.SCR$/i.test(pc.path || '') && t.dll === 'USER32' && /^(IsWindow|GetForegroundWindow|GetParent|GetClientRect|GetDC|CreateWindowExA|GetSystemMetrics|ChangeDisplaySettingsA)$/.test(t.nm))
      (pc.user32Calls || (pc.user32Calls = [])).push({ name: t.nm, args: a.slice(0, 4) });
    let r;
    try { r = fn.apply(this, a); }
    catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } throw e; }
    if (r === YIELD) { this.preempted = 0; return -1; }   // (stopped in the call, not where its time ran out)
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
    if (!p) {
      p = this.heapTop; this.heapTop += n;
      if (this.heapTop > LAYOUT.HEAP_END) {   // (the report says what holds the heap: live blocks by size, and what idles on the free lists)
        const by = new Map(); let live = 0; for (const [, s] of this.allocs) { by.set(s, (by.get(s) || 0) + s); live += s; }
        let idle = 0; for (const [s, l] of this.freeList) idle += s * l.length;
        const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, t]) => `${s}x${t / s}`).join(' ');
        throw new GuestError(`out of memory: ${(live >> 20)} MB live in ${this.allocs.size} blocks (${top}), ${idle >> 20} MB idle on the free lists; big blocks: ${(this.bigAllocs || []).join(' | ')}`);
      }
    }
    this.allocs.set(p, n); if (zero) this.u8.fill(0, p, p + n);
    if (n >= 8 << 20) (this.bigAllocs || (this.bigAllocs = [])).push(`${n} bytes at ${p.toString(16)}: ${(new Error().stack || '').split('\n').slice(2, 7).map(s => s.trim()).join(' < ')}`);   // (who takes a block of 8 MB or more: the out-of-memory report)
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
    // the language: neutral, then US English, then any (multilingual system DLLs list Arabic and others first)
    const ld = root + (o & 0x7fffffff);
    o = find(ld, 0); if (o === null) o = find(ld, 0x409); if (o === null) o = find(ld); if (o === null) return null;
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
      if (remove) { t.due += t.ms; if (t.due <= now) t.due = now + t.ms; this.stats.timers++; }   // late ticks coalesce, as WM_TIMER does
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
  /** the clock the running program reads, as an offset from this machine's ({ tick, wall } ms): a program started here
   *  for a shared session reads the clock of the machine that started it, as of its start there (ne16.js startClock) */
  clockOf() { const t = this.thread16, c = t && (t.pc ? t.pc.clock : t.task && t.task.clock); return c || NO_CLOCK; }
  /** the time the running program reads, in ms ('tick': since Windows started; 'wall': since 1970): this machine's,
   *  offset to the starting machine's (clockOf). In a shared session, until a program first waits with nothing to do
   *  (ne16.js idle: its start is over), its clock is its start's time (its t0) and one more ms for each read, the
   *  same on every machine however long each takes to start it: a seed it takes as it starts and deals (Solitaire's
   *  srand(GetCurrentTime()), twice) is the same wherever it runs, and a wait timed by the clock still ends. From
   *  then on it runs on from there. `peek` reads without counting (MS-DOS's date, read with its time) */
  progTime(kind, peek) {
    // (the wall clock in a shared session: the server's, this machine's plus its skew to it, so every machine shows one time)
    const t = this.thread16, rec = t && (t.pc || t.task), local = kind === 'tick' ? this.now() - this.t0 + 3600000 : Date.now() + (this.wallSkew || 0);
    if (!rec) return local;
    if (!this.sessionClock || !rec.t0) return local + (rec.clock ? rec.clock[kind] : 0);
    const v = (rec.vt || (rec.vt = {}))[kind] || (rec.vt[kind] = { n: 0, from: null });
    if (!rec.idle) { const r = rec.t0[kind] + v.n; if (!peek) v.n++; return r; }
    if (v.from === null) v.from = local;
    return rec.t0[kind] + v.n + (local - v.from);
  }
  /** Charge the guest instructions retired since the last call (counted by the translated code). */
  ready() {
    if (this.exitCode !== null || this.trapped) return false;
    if (this.dlgDone) return true;
    if (this.modal) return false;
    if (!this.waiting) return true;
    return !!this.nextMessage(0, false);
  }
  dispatchInput(msg, wp, lp) {
    for (const w of this.windows.values()) if (!w.noInput && (!w.parent || w.child)) {
      if ([WM.MOUSEMOVE, WM.LBUTTONDOWN, WM.LBUTTONUP, WM.RBUTTONDOWN, WM.RBUTTONUP, WM.MBUTTONDOWN, WM.MBUTTONUP].includes(msg)) {
        const [x, y] = this.absPos(w), sx = lp & 0xffff, sy = lp >>> 16;
        lp = (((sy - y) & 0xffff) << 16) | ((sx - x) & 0xffff);
      }
      this.post(w.hwnd, msg, wp, lp); break;
    }
  }
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
  touch() {
    if (this.bitmap) this.bitmap.ver++;
    else {
      const w = this.win();
      if (w) for (let v = w; v; v = v.parentWin) v.surfaceVersion = (v.surfaceVersion || 0) + 1;
      else if (!this.hwnd && this.proc.host.surfaceChanged) this.proc.host.surfaceChanged(0, this.proc.pc);
    }
  }
  // Window DCs draw relative to the window's screen position and are clipped to it.
  win() { return !this.bitmap && this.hwnd ? this.proc.windows.get(this.hwnd) : null; }
  origin() { const w = this.win(); return w ? this.proc.absPos(w) : [0, 0]; }
  pre() {
    const g = this.ctx, w = this.win();
    if (!w || !w.parentWin) { g.setTransform(1, 0, 0, 1, 0, 0); return g; }
    const [x, y] = w.previewChild ? [0, 0] : this.proc.absPos(w);
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
/** an INI file's sections in order: each its keys (by lower-case name, the first of a name) and its lines in order,
 *  key=value lines and the others (a SETUP.INI group's items) alike; comments and blank lines are not kept */
function iniRead(fs, file) {
  const out = new Map(); let cur = null;
  let text = ''; try { text = fs.readText(iniPath(file)); } catch (_) { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); let m;
    if ((m = /^\[(.*)\]$/.exec(l))) { cur = m[1]; if (!out.has(cur.toLowerCase())) out.set(cur.toLowerCase(), { name: cur, keys: new Map(), lines: [] }); cur = out.get(cur.toLowerCase()); }
    else if (!cur || !l || l[0] === ';') continue;
    else if ((m = /^([^=;]+?)\s*=\s*(.*)$/.exec(l))) { const e = { name: m[1], value: m[2] }; if (!cur.keys.has(m[1].toLowerCase())) cur.keys.set(m[1].toLowerCase(), e); cur.lines.push(e); }
    else cur.lines.push({ raw: l });
  }
  return out;
}
function iniGet(fs, file, sec, key) { const s = iniRead(fs, file).get((sec || '').toLowerCase()); const k = s && s.keys.get((key || '').toLowerCase()); return k ? k.value : null; }
function iniSet(fs, file, sec, key, value) {
  const ini = iniRead(fs, file); const sk = sec.toLowerCase();
  if (!ini.has(sk)) ini.set(sk, { name: sec, keys: new Map(), lines: [] });
  const s = ini.get(sk), e = key === null ? null : s.keys.get(key.toLowerCase());
  if (key === null) ini.delete(sk);
  else if (value === null) { if (e) { s.keys.delete(key.toLowerCase()); s.lines = s.lines.filter(x => x !== e); } }
  else if (e) e.value = value;
  else { const n = { name: key, value }; s.keys.set(key.toLowerCase(), n); s.lines.push(n); }
  let text = '';
  for (const v of ini.values()) { text += `[${v.name}]\r\n`; for (const k of v.lines) text += k.raw !== undefined ? `${k.raw}\r\n` : `${k.name}=${k.value}\r\n`; text += '\r\n'; }
  fs.writeFile(iniPath(file), text);
}
const REGISTRY = new Map([
  ['hkcu\\control panel\\desktop', new Map([['screensaveusepassword', 0]])],
  ['hkcu\\control panel\\colors', new Map()],
]);
// Registry writes go through to a store when one is attached (regAttach): each key created or deleted and each value
// set or deleted, as it happens. Values are numbers, strings, or { type, name, data } with the raw bytes.
let regStore = null, regQuiet = false;
const regWatchers = new Set();   // the page's: each change, for the machines' copies in their workers
// (regQuiet true: nothing told; 'remote': a change another person's machine made, from the shared session's server
// (shared.js): this page's machines told, the store not, the server having it already)
const regChanged = op => { if (regQuiet === true) return; if (regStore && !regQuiet) regStore.op(op); for (const f of regWatchers) f(op); };
// each key's name as it was created (RegEnumKey gives it back so: SPOOLSS finds its "Windows 4.0" environment by a
// case-sensitive compare); the registry's paths themselves are lower case
const KEYNAME = new Map();
/** create the keys along `path` (lower case) that are missing, each named from `orig` (the same path as given) */
const regMake = (path, orig) => {
  const parts = path.split('\\'), names = String(orig || '').split('\\');
  for (let k = 1; k <= parts.length; k++) {
    const q = parts.slice(0, k).join('\\'); if (REGISTRY.has(q)) continue;
    REGISTRY.set(q, new Map());
    const name = names.length === parts.length && names[k - 1].toLowerCase() === parts[k - 1] && names[k - 1] !== parts[k - 1] ? names[k - 1] : null;
    if (name) KEYNAME.set(q, name);
    regChanged(name ? { op: 'key', path: q, name } : { op: 'key', path: q });
  }
};
const keyName = (path, k) => KEYNAME.get(k) || k.slice(path.length + 1);
const regAttach = store => {
  regStore = store;
  const held = store.load();
  if (!held) { for (const [path, m] of REGISTRY) { store.op({ op: 'key', path }); for (const [name, value] of m) store.op({ op: 'set', path, name, value }); } return false; }
  REGISTRY.clear(); KEYNAME.clear();
  for (const [path, vals, name] of held) { REGISTRY.set(path, new Map(vals)); if (name) KEYNAME.set(path, name); }
  return true;
};
/** the registry as it is now, in the form a store's load gives it ([path, values, name]), for a machine in a worker */
const regDump = () => [...REGISTRY].map(([path, m]) => [path, [...m], KEYNAME.get(path) || null]);
/** a change another copy of the registry made (a machine's in its worker, or the page's): applied here, and passed on
 *  to this copy's store unless `quiet` ('remote': another person's, to this page's machines but not its store) */
const regApply = (o, quiet) => {
  const was = regQuiet; if (quiet) regQuiet = quiet === 'remote' ? 'remote' : true;
  try {
    if (o.op === 'key') {   // (its name with it, to this copy's store too: the case a later load gives back)
      const had = REGISTRY.has(o.path);
      regMake(o.path, o.name ? o.path.slice(0, o.path.length - o.name.length) + o.name : null);
      if (o.name) { KEYNAME.set(o.path, o.name); if (had) regChanged(o); }
    }
    else if (o.op === 'set') regSet(o.path, o.name, o.value);
    else if (o.op === 'del') { const m = REGISTRY.get(o.path); if (m) m.delete(o.name); regChanged(o); }
    else if (o.op === 'delkey') regDel(o.path);
  } finally { regQuiet = was; }
};
// the shell's own registry reads and writes (Explorer's settings), through the same store as a program's
/** the names of a key's subkeys, as stored (lower case) */
const regKids = path => { path = path.toLowerCase(); return [...REGISTRY.keys()].filter(k => k.startsWith(path + '\\') && !k.slice(path.length + 1).includes('\\')).map(k => k.slice(path.length + 1)); };
/** a key's values as [name, value] pairs, and a key removed with its subkeys */
const regVals = path => [...(REGISTRY.get(path.toLowerCase()) || new Map()).entries()];
const regDel = path => { path = path.toLowerCase(); let any = false; for (const k of [...REGISTRY.keys()]) if (k === path || k.startsWith(path + '\\')) { REGISTRY.delete(k); KEYNAME.delete(k); any = true; } if (any) regChanged({ op: 'delkey', path }); };
const regGet = (path, name) => { const m = REGISTRY.get(path.toLowerCase()); return m ? m.get(name.toLowerCase()) : undefined; };
const regSet = (path, name, value) => {
  const orig = path; path = path.toLowerCase(); regMake(path, orig);
  if (name === null) return;   // the key alone
  REGISTRY.get(path).set(name.toLowerCase(), value); regChanged({ op: 'set', path, name: name.toLowerCase(), value });
};
const HKEY = { 0x80000000: 'hkcr', 0x80000001: 'hkcu', 0x80000002: 'hklm', 0x80000003: 'hku', 0x80000005: 'hkcc', 0x80000006: 'hkdd', 1: 'hkcr', 2: 'hkcu', 3: 'hklm' };

// ---------------------------------------------------------------- API table: [argc, impl]; argc < 0 = cdecl varargs
// ---------------------------------------------------------------- the machine's log
// One log for everything the machine and its programs say: the emulator's own messages ([win32], [ne16], [vxd]), what
// programs write with OutputDebugString, KERNEL's LogError. Each line has a level, and goes three ways: to the
// console with that level's method (debug, info, warn, error: DevTools' level filter sorts them), to the ring the page
// reads (win95.log(), cmd 'log'), and to anything listening (the Debug Monitor, dbwin.js). A worker's lines are
// posted to the page by the worker (worker.js, 'log'), which keeps the page's ring; the console gets them from the
// worker's own console, as DevTools shows a worker's console with the page's
const LOG_RING = 2000, logRing = [], logWatchers = new Set();
let logSeq = 0, logLast = null, logBurst = { t: 0, n: 0 };
// (a line said again at once is counted, not repeated; past 50 lines in a second the rest go to the ring only, with
// one line saying how many: a program writing debug output in a loop must not slow the machine or fill the console)
function log(level, tag, text) {
  text = String(text);
  if (logLast && logLast.tag === tag && logLast.text === text && logLast.level === level) { logLast.repeat = (logLast.repeat || 1) + 1; return logLast; }
  const line = logLast = { n: ++logSeq, t: Date.now(), level, tag, text };
  logRing.push(line); if (logRing.length > LOG_RING) logRing.shift();
  const sec = (line.t / 1000) | 0; if (sec !== logBurst.t) { if (logBurst.n > 50) console.info(`[log] ${logBurst.n - 50} more lines in that second, in the ring only`); logBurst = { t: sec, n: 0 }; }
  if (++logBurst.n <= 50) { const f = console[level === 'debug' ? 'debug' : level === 'info' ? 'info' : level === 'error' ? 'error' : 'warn']; if (f) f.call(console, `[${tag}] ${text}`); }
  for (const w of logWatchers) { try { w(line); } catch (_) { /* a watcher's own trouble */ } }
  return line;
}
log.lines = (since = 0) => logRing.filter(l => l.n > since);
log.watch = f => { logWatchers.add(f); return () => logWatchers.delete(f); };
log.put = line => { logRing.push(line); if (logRing.length > LOG_RING) logRing.shift(); for (const w of logWatchers) { try { w(line); } catch (_) {} } };   // (a line made elsewhere: a worker's, kept in the page's ring)
const API = {};
// the DLLs implemented here in place of a DLL file a program can find by name (gl.js: OPENGL32, the installable client
// driver GDI32's pixel-format calls look up with GetModuleHandle); the personality's own (KERNEL32, ADVAPI32, ...) are
// not found that way, as before
const STAND_IN = new Set();
const GONE = { gone: true };   // (a private-arena DLL's data in place belonged to a process that has ended: Process.dllForget)
// (defined again, as a script reloaded into the running machine defines it: changed in place, so the thunks already
// made for it, which hold its entry, call the new function)
const def = (dll, name, n, fn) => { const m = API[dll] = API[dll] || {}, e = m[name]; if (e) { e[0] = n; e[1] = fn; } else m[name] = [n, fn]; };
const TRUE = 1, FALSE = 0;

// KERNEL32
// the command line in Unicode, as Windows 95's KERNEL32 keeps a copy of it for each process
def('KERNEL32', 'GetCommandLineW', 0, function () {
  const pc = this.pc; if (pc.cmdPtrW) return pc.cmdPtrW;
  const s = this.readA(this.cmdPtr) || '', w = this.alloc(2 * s.length + 2);
  for (let i = 0; i < s.length; i++) this.w16(w + 2 * i, s.charCodeAt(i)); this.w16(w + 2 * s.length, 0);
  return (pc.cmdPtrW = w);
});
def('KERNEL32', 'GetCommandLineA', 0, function () {
  const pc = this.thread16 && this.thread16.pc, ptr = this.cmdPtr;
  if (pc && /\.SCR$/i.test(pc.path || '')) pc.commandLineSeen = this.readA(ptr);
  return ptr;
});
def('KERNEL32', 'GetStartupInfoA', 1, function (p) { this.u8.fill(0, p, p + 68); this.w32(p, 68); });
def('KERNEL32', 'GetModuleHandleA', 1, function (name) {
  if (!name) return this.exe.base;
  const n = (this.readA(name) || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, ''), m = this.byName.get(n);
  // (a DLL implemented here is loaded once an image imported it or LoadLibrary loaded it: GDI32's ChoosePixelFormat
  // and SwapBuffers find OPENGL32 by GetModuleHandle, and give up without it)
  if (m) return m.base;
  return (this.jsDlls && this.jsDlls.get(n)) || (this.jsImported && this.jsImported.has(n) ? this.jsDll(n) : 0);
});
def('KERNEL32', 'GetModuleFileNameA', 3, function (h, buf, n) {
  h = this.hmod(h);
  const m = h && this.modules.find(x => x.base === h && x !== this.exe && x.kind !== 'ne');   // a DLL: its file in SYSTEM; another program: its file
  const other = m && m.name === 'EXE' && [this.pc0, ...(this.procs || new Map()).values()].find(x => x && x.exe === m);
  // (a module named with its own extension, DESK.CPL or WINSPOOL.DRV, is that file; the others are .DLL)
  return this.writeA(buf, other ? other.path || this.host.path : m ? `C:\\WINDOWS\\SYSTEM\\${/\.[A-Z0-9]{1,3}$/i.test(m.name) ? m.name : m.name + '.DLL'}` : this.pc.path || this.host.path || 'C:\\WINDOWS\\SCRNSAVE.SCR', n);
});
def('KERNEL32', 'ExitProcess', 'regs', function () {
  const code = this.r32(this.reg('esp') + 4), pc = this.pc;
  if (pc !== this.pc0) {
    const esp = this.reg('esp'), ret = this.r32(esp);
    pc.exitDebug = { code, cmd: this.readA(pc.cmdPtr), eip: this.reg('eip'), esp, ret,
      retBytes: Array.from(this.u8.slice(ret, ret + 24), b => b.toString(16).padStart(2, '0')).join(''),
      stack: Array.from({ length: 8 }, (_, i) => this.r32(esp + 4 + i * 4)),
      modules: this.modules.map(m => ({ name: m.name, base: m.base, size: m.size })) };
    this.endProcess(pc, code); return LAYOUT.SENTINEL;
  }   // a process this one started: its threads end
  this.exitCode = code; this.host.exited(code); return LAYOUT.SENTINEL;
});
def('KERNEL32', 'TerminateProcess', 2, function (h, code) { this.exitCode = code; this.host.exited(code); return 1; });
def('KERNEL32', 'GetCurrentProcess', 0, () => 0xffffffff);
def('KERNEL32', 'DisableThreadLibraryCalls', 1, () => 1);
// KERNEL32 #14: LoadStringA for a 32-bit module (USER32's LoadString of a Win32 instance comes here): the string
// converted to ANSI, at most n-1 characters and a terminator; its length, or 0 with no buffer
def('KERNEL32', '#14', 4, function (h, id, buf, n) {
  if (!buf || !n) return 0;
  const s = this.loadString(id, this.moduleFor(h)) || ''; const k = Math.min(s.length, n - 1);
  this.writeA(buf, s.slice(0, k)); return k;
});   // one thread: there are no thread attach notices to stop
// A Win32 thread the scheduler runs (ne16.js threads16) that polls the clock in a loop gives up the processor here
// once its slice is used: the call comes back when the thread is next scheduled
def('KERNEL32', 'GetTickCount', 0, function () {
  const t = this.thread16;
  if (t && t.flat && this.depth === 0 && this.now() - (t.sliceStart || 0) > 8) { if (!t.preempt) { t.preempt = true; return YIELD; } }
  if (t) t.preempt = false;
  return this.progTime('tick') >>> 0;
});
// Sleep: a thread at its top level gives up the processor until the time is up (the call is made again when it
// resumes, and returns once its wake-up time has passed); elsewhere it returns at once
function sleep(ms) {
  const t = this.thread16 || (this.mainSleep = this.mainSleep || {});
  if (!(this.atThreadTop ? this.atThreadTop() : this.depth === 0)) { t.wake = 0; if (ms && this.threads16) this.threads16(true); return 0; }   // inside a call: the others get a turn
  if (!t.wake) { t.wake = this.now() + (ms >>> 0 === 0xffffffff ? 1e12 : ms); return YIELD; }
  if (this.now() < t.wake) return YIELD;
  t.wake = 0; return 0;
}
def('KERNEL32', 'Sleep', 1, function (ms) { return sleep.call(this, ms); });
def('KERNEL32', 'SleepEx', 2, function (ms) { return sleep.call(this, ms); });
def('KERNEL32', 'GetVersion', 0, () => 0xc0000004);
def('KERNEL32', 'GetVersionExA', 1, function (p) {
  this.w32(p + 4, 4); this.w32(p + 8, 0); this.w32(p + 12, 950); this.w32(p + 16, 1); this.writeA(p + 20, ' B');
  const pc = this.thread16 && this.thread16.pc;
  if (pc && /\.SCR$/i.test(pc.path || '')) pc.versionInfoSeen = { size: this.r32(p), major: this.r32(p + 4), minor: this.r32(p + 8), build: this.r32(p + 12), platform: this.r32(p + 16) };
  return 1;
});
def('KERNEL32', 'LoadLibraryA', 1, function (n) {
  // (a name in quotes, as RUNDLL32 passes the one on its command line: "C:\WINDOWS\SYSTEM\DESK.CPL")
  const name = (this.readA(n) || '').trim().replace(/^"(.*)"$/, '$1').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, '');
  const native = this.loadDll(name);
  // the process attaches to the library and to every DLL it uses, dependencies first, as Windows 95's LoadLibrary
  // does (a DLL another process loaded is attached to this one too: RUNDLL32 ran MMSYS.CPL on WINMM before the
  // shell's thread had attached WINMM, so WINMM's thunks to MMSYSTEM were not connected and it crashed in them)
  if (native) { this.runPendingInits(); for (const m of this.importClosure(native)) this.attach(m); return native.base; }
  if (!API[name]) { this.lastError = 126; return 0; }   // ERROR_MOD_NOT_FOUND: neither a system DLL here nor one implemented in JS
  return this.jsDll(name);
});
def('KERNEL32', 'FreeLibrary', 1, () => 1);
def('KERNEL32', 'GetProcAddress', 2, function (h, name) {
  const nm = name >>> 16 ? this.readA(name) : '#' + name;
  const native = this.modules.find(x => x.base === this.hmod(h));
  if (native) return native.exports.get(nm) || 0;
  const m = this.obj(0x0000ffff & h) || { name: 'KERNEL32' };
  return API[m.name] && API[m.name][nm] ? this.thunkFor(m.name, nm) : 0;
});
// ---- structured exceptions. RaiseException hands the exception to the handlers on the thread's chain (FS:[0]) as
// the system's dispatcher does: each gets (record, its frame, context, dispatcher context) and answers continue
// execution (0: resume where the context says) or continue search (1: the next frame). A handler that takes the
// exception (MSVC's _except_handler3) unwinds and jumps into its __except block instead of returning: the program
// then runs on from there, and when it returns past the frame this call was made in, that is where this call ends
const SEH_END = 0xffffffff, CTX = { edi: 0x9c, esi: 0xa0, ebx: 0xa4, edx: 0xa8, ecx: 0xac, eax: 0xb0, ebp: 0xb4 };
/** call an exception handler (cdecl, 4 arguments) with the registers a callee keeps restored after; 'escaped' if it
 *  did not return (the program ran on past the caller's frame `top` and returned there) */
function sehCall(p, fn, args, top) {
  const keep = ['ebx', 'esi', 'edi', 'ebp'].map(r => [r, p.reg(r)]), sp = p.reg('esp');
  for (let i = args.length - 1; i >= 0; i--) p.push(args[i]);
  p.push(LAYOUT.SENTINEL); p.depth++;
  let r; try { r = p.runAt(fn); } finally { p.depth--; }
  if (r !== 0 || p.trapped) throw new GuestError(p.trapped || `exception handler ${u32(fn).toString(16)} did not return`);
  if (u32(p.reg('esp')) > u32(top)) return 'escaped';
  const v = p.reg('eax'); p.reg('esp', sp); for (const [r2, x] of keep) p.reg(r2, x);
  return v;
}
function sehContext(p, at, eip, esp) {
  p.u8.fill(0, at, at + 0x2cc); p.w32(at, 0x10007);   // CONTEXT_FULL
  for (const [r, o] of Object.entries(CTX)) p.w32(at + o, p.reg(r));
  p.w32(at + 0xb8, eip); p.w32(at + 0xc4, esp); p.w32(at + 0xc0, 0x202);
}
/** an exception (code, at `eip`, its parameters) through the thread's structured handlers, as KERNEL32 dispatches one:
 *  the address to go on at (a handler continued it), SENTINEL when a handler took it and the program ran on past
 *  here, null when none handled it */
function sehDispatch(p, code, eip, params, fault, flags = 0) {
  p.sehFault = fault;
  const sp = u32(p.reg('esp')), rec = (sp - 0x400) & ~15, ctx = rec + 0x60, n = Math.min(params.length, 15);
  // (a stack pointer that is no address the machine has: nothing can be pushed for a handler, the fault is not
  // handled, the program's fault dialog takes it rather than the machine ending)
  if (sp < 0x10000 || sp > p.u8.length) return null;
  p.u8.fill(0, rec, rec + 0x50);
  p.w32(rec, code); p.w32(rec + 4, flags & 1); p.w32(rec + 12, eip); p.w32(rec + 16, n);
  for (let i = 0; i < n; i++) p.w32(rec + 20 + 4 * i, params[i]);
  sehContext(p, ctx, eip, sp);
  p.reg('esp', rec - 0x40);
  // a frame off the thread's stack (the TIB's top and limit; past the end of memory) ends the chain, as KERNEL32
  // takes it: what the frames before it did not handle is not handled
  const tib = p.cpu.fs.value, end = p.mem.buffer.byteLength, top = p.r32(tib + 4), limit = p.r32(tib + 8);
  const onStack = f => f + 8 <= end && !(top > limit && (f < limit || f + 8 > top));
  // (an exception raised inside a handler, nested: its search starts above the frame whose handler is running, as
  // KERNEL32's dispatcher skips the frames it is already in, EXCEPTION_NESTED_CALL. Searched from the chain's head, a
  // handler that faulted was asked about its own fault, and again, until the page's stack ran out)
  const active = p.sehActive || (p.sehActive = []), nested = active.length ? active[active.length - 1] : 0;
  if (nested) p.w32(rec + 4, (flags & 1) | 0x10);
  for (let f = nested ? p.r32(nested) : p.r32(tib); f !== SEH_END && f && onStack(f); f = p.r32(f)) {
    active.push(f);
    let r; try { r = sehCall(p, p.r32(f + 4), [rec, f, ctx, 0], sp); } finally { active.pop(); }
    if (r === 'escaped') return LAYOUT.SENTINEL;
    if (r === 0) {   // continue execution where the context says
      for (const [rg, o] of Object.entries(CTX)) p.reg(rg, p.r32(ctx + o));
      p.reg('esp', p.r32(ctx + 0xc4)); return p.r32(ctx + 0xb8);
    }
  }
  p.reg('esp', sp);
  return null;
}
def('KERNEL32', 'RaiseException', 'regs', function () {
  const sp = u32(this.reg('esp')), ret = this.r32(sp), code = this.r32(sp + 4), flags = this.r32(sp + 8), n = Math.min(this.r32(sp + 12), 15), argv = this.r32(sp + 16);
  const params = []; for (let i = 0; i < n; i++) params.push(this.r32(argv + 4 * i));
  this.reg('esp', sp + 20);
  const r = sehDispatch(this, code, ret, params, null, flags);
  if (r !== null) return r;
  // nothing handled it: KERNEL32's unhandled-exception path ends the program with its fault dialog
  const f = this.faultInfo(0, ret, 0); f.code = code; f.why = `exception ${u32(code).toString(16)} at ${u32(ret).toString(16)}`;
  throw new FaultError(f);
});
// RtlUnwind(target frame, target IP, record, return value): the handlers of the frames above the target are called
// with the record marked unwinding (2; and 4 when there is no target: the whole chain), each frame taken off the chain
// as its handler returns; then back to the caller with EAX the return value
// the Unicode file and process functions Windows 95 leaves unimplemented: they fail with ERROR_CALL_NOT_IMPLEMENTED
for (const [nm, n, ret] of [['CreateDirectoryW', 2, 0], ['CreateProcessW', 10, 0], ['DeleteFileW', 1, 0], ['FindFirstFileW', 2, 0xffffffff],
  ['FindNextFileW', 2, 0], ['FormatMessageW', 7, 0], ['GetCurrentDirectoryW', 2, 0], ['GetDriveTypeW', 1, 0], ['GetFileAttributesW', 1, 0xffffffff],
  ['GetFullPathNameW', 4, 0], ['GetModuleFileNameW', 3, 0], ['MoveFileW', 2, 0], ['RemoveDirectoryW', 1, 0], ['SetCurrentDirectoryW', 1, 0],
  ['SetEnvironmentVariableW', 2, 0], ['SetFileAttributesW', 2, 0]])
  def('KERNEL32', nm, n, function () { this.lastError = 120; return ret; });
def('KERNEL32', 'AreFileApisANSI', 0, () => 1);
def('KERNEL32', 'GetComputerNameA', 2, function (buf, pn) { const s = 'WIN95'; if (this.r32(pn) <= s.length) { this.w32(pn, s.length + 1); this.lastError = 111; return 0; } this.writeA(buf, s); this.w32(pn, s.length); return 1; });
def('KERNEL32', 'GetTempPathA', 2, function (n, buf) { const s = 'C:\\WINDOWS\\TEMP\\'; if (n > s.length) this.writeA(buf, s); return s.length; });
def('KERNEL32', 'GetSystemInfo', 1, function (p) {   // one 486, 4K pages, applications from 4 MB to 2 GB
  this.u8.fill(0, p, p + 36); this.w32(p + 4, 0x1000); this.w32(p + 8, 0x400000); this.w32(p + 12, 0x7fffffff); this.w32(p + 16, 1); this.w32(p + 20, 1);
  this.w32(p + 24, 486); this.w32(p + 28, 0x10000); this.w16(p + 32, 4);
});
def('KERNEL32', 'GlobalMemoryStatus', 1, function (p) {   // 16 MB of RAM, as GetFreeSpace reports
  this.w32(p, 32); this.w32(p + 4, 50); this.w32(p + 8, 0x1000000); this.w32(p + 12, 0x800000); this.w32(p + 16, 0x2000000); this.w32(p + 20, 0x1800000);
  this.w32(p + 24, 0x7fc00000); this.w32(p + 28, 0x7f000000);
});
def('KERNEL32', 'QueryPerformanceCounter', 1, function (p) { const t = Math.floor((this.progTime('tick') - 3600000) * 1193.182); this.w32(p, t % 4294967296); this.w32(p + 4, Math.floor(t / 4294967296)); return 1; });
def('KERNEL32', 'QueryPerformanceFrequency', 1, function (p) { this.w32(p, 1193182); this.w32(p + 4, 0); return 1; });
def('KERNEL32', 'IsBadStringPtrW', 2, function (a) { return !a || a >= this.mem.buffer.byteLength ? 1 : 0; });
def('KERNEL32', 'LocalHandle', 1, p => p);
def('KERNEL32', 'RtlFillMemory', 3, function (d, n, v) { this.u8.fill(v & 0xff, d, d + n); });
// #87: whether the calling thread holds the Win16 lock (never for a Win32 thread); #88 (bytes of arguments, flags,
// function, arguments...): the function called with the arguments, on the caller's stack for a Win32 thread
def('KERNEL32', '#87', 0, () => 0);
def('KERNEL32', '#88', -1, function (cb, flags, fn) { const sp = this.reg('esp'), a = []; for (let i = 0; i < cb >> 2; i++) a.push(this.r32(sp + 16 + 4 * i)); return this.call(fn, a); });
def('KERNEL32', 'RtlUnwind', 'regs', function () {
  const sp = u32(this.reg('esp')), ret = this.r32(sp), target = this.r32(sp + 4), given = this.r32(sp + 12), value = this.r32(sp + 16);
  const keep = ['ebx', 'esi', 'edi', 'ebp'].map(r => [r, this.reg(r)]);
  const rec = (sp - 0x400) & ~15, ctx = rec + 0x60;
  if (given) this.u8.copyWithin(rec, given, given + 0x50); else { this.u8.fill(0, rec, rec + 0x50); this.w32(rec, 0xc0000027); this.w32(rec + 12, ret); }
  this.w32(rec + 4, this.r32(rec + 4) | (target ? 2 : 6));
  sehContext(this, ctx, ret, sp + 20);
  this.reg('esp', rec - 0x40);
  const tib = this.cpu.fs.value;
  for (let f = this.r32(tib); f !== SEH_END && f && f !== target; f = this.r32(tib)) {
    const r = sehCall(this, this.r32(f + 4), [rec, f, ctx, 0], sp);
    if (r === 'escaped') return LAYOUT.SENTINEL;
    this.w32(tib, this.r32(f));
  }
  for (const [r, x] of keep) this.reg(r, x);
  this.reg('eax', value); this.reg('esp', sp + 20); return ret;
});
// UnhandledExceptionFilter(EXCEPTION_POINTERS): the program's own top-level filter first (SetUnhandledExceptionFilter),
// else KERNEL32's fault dialog for the exception being dispatched; EXCEPTION_EXECUTE_HANDLER (1): the program ends
def('KERNEL32', 'UnhandledExceptionFilter', 1, function (ptrs) {
  if (this.topFilter) { const r = this.call(this.topFilter, [ptrs]); if (r !== 0) return r; }
  const rec = this.r32(ptrs), ctx = this.r32(ptrs + 4);
  const f = this.sehFault && this.sehFault.eip === this.r32(rec + 12) ? this.sehFault : this.faultInfo(0, this.r32(rec + 12), 0);
  if (!this.sehFault || f !== this.sehFault) { f.code = this.r32(rec); for (const [r, o] of Object.entries(CTX)) f.regs[r] = this.r32(ctx + o); }
  if (this.host.faultDialog) this.host.faultDialog(f);
  return 1;
});
def('KERNEL32', 'SetUnhandledExceptionFilter', 1, function (fn) { const was = this.topFilter || 0; this.topFilter = fn; return was; });
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
// VirtualAlloc: a new region (MEM_RESERVE, or a commit with no address), zeroed, or pages committed inside one already
// reserved (an address within it: the region's memory is there already, as it was left); VirtualFree releases a region
// (MEM_RELEASE) or decommits pages, which stay in it
// Regions start on 64 KiB boundaries, as Windows' do: in the process's address space above the layout's memory when
// the host gave it some (released regions are reused by size), else from the heap
const vregion = (p, a) => { for (const [b, r] of p.vregions || []) if (a >= b && a < b + r.size) return b; return 0; };
def('KERNEL32', 'VirtualAlloc', 4, function (a, n, type) {
  if (a && vregion(this, a)) return a & ~0xfff;
  const size = (n + 0xffff) & ~0xffff, regions = this.vregions || (this.vregions = new Map()), end = this.mem.buffer.byteLength;
  let b = 0, heap = null;
  const spare = (this.vspare || []).findIndex(r => r.size >= size);
  if (spare >= 0) { b = this.vspare.splice(spare, 1)[0].base; this.u8.fill(0, b, b + size); }
  else if (this.vmTop + size <= end) { b = this.vmTop; this.vmTop += size; }
  else { heap = this.alloc(size + 0xffff, true); b = (heap + 0xffff) & ~0xffff; }
  // (pc: the process whose own program reserved it, the caller's return address in its image: it goes when that
  // process ends. What a DLL reserves (SHELL32's, DESK.CPL's) is the DLL's, kept: the DLLs are one copy here, shared)
  const pc = this.pc, e = pc && pc.exe, ret = this.r32(this.reg('esp'));
  regions.set(b, { size, heap, pc: e && ret >= e.base && ret < e.base + (e.size || 0) ? pc : null });
  return b;
});
def('KERNEL32', 'VirtualFree', 3, function (p, n, type) {
  const r = type & 0x8000 && this.vregions && this.vregions.get(p);
  if (r) { this.vregions.delete(p); if (r.heap) this.free(r.heap); else (this.vspare || (this.vspare = [])).push({ base: p, size: r.size }); }
  return 1;
});
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
// GetPrivateProfileSection: the section's lines, each NUL-terminated, then a NUL; its length without the last NUL (the
// buffer's size less 2 when they do not all fit)
def('KERNEL32', 'GetPrivateProfileSectionA', 4, function (sec, buf, n, file) {
  if (n < 2) return 0;
  const s = iniRead(this.fs, this.readA(file)).get((this.readA(sec) || '').toLowerCase());
  let o = 0;
  for (const e of s ? s.lines : []) {
    const l = e.raw !== undefined ? e.raw : `${e.name}=${e.value}`;
    if (o + l.length + 2 > n) { this.writeA(buf + o, l, n - 1 - o); this.u8[buf + n - 2] = 0; this.u8[buf + n - 1] = 0; return n - 2; }
    this.writeA(buf + o, l, l.length + 1); o += l.length + 1;
  }
  this.u8[buf + o] = 0; if (!o) this.u8[buf + 1] = 0;
  return o;
});
def('KERNEL32', 'GetProfileSectionA', 3, function (sec, buf, n) { return API.KERNEL32.GetPrivateProfileSectionA[1].call(this, sec, buf, n, 0); });
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
  if (!sec || !key) {   // a null section lists the sections, a null key the section's keys: each NUL-terminated, then a NUL
    if (!n) return 0;
    const ini = iniRead(this.fs, this.readA(file)), s = sec && ini.get(this.readA(sec).toLowerCase());
    const names = sec ? (s ? [...s.keys.values()].map(k => k.name) : []) : [...ini.values()].map(v => v.name);
    let o = 0;
    for (const nm of names) { if (o + nm.length + 2 > n) break; this.writeA(buf + o, nm, nm.length + 1); o += nm.length + 1; }
    this.u8[buf + o] = 0; if (!o && n > 1) this.u8[buf + 1] = 0;
    return o;
  }
  const v = iniGet(this.fs, this.readA(file), this.readA(sec), this.readA(key));
  return this.writeA(buf, v === null ? (this.readA(dflt) || '') : v, n);
});
def('KERNEL32', 'WritePrivateProfileStringA', 4, function (sec, key, val, file) {
  if (this.iniIntent) this.iniIntent(file ? this.readA(file) : 'WIN.INI', this.readA(sec), key ? this.readA(key) : null, val ? this.readA(val) : null, null);
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
  const d = new Date(this.progTime('wall')); [d.getFullYear(), d.getMonth() + 1, d.getDay(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()].forEach((v, i) => this.w16(p + 2 * i, v));
});
def('KERNEL32', 'GetACP', 0, () => 1252);
def('KERNEL32', 'GetOEMCP', 0, () => 437);
def('KERNEL32', 'GetCPInfo', 2, function (cp, p) { this.u8.fill(0, p, p + 20); this.w32(p, 1); this.u8[p + 4] = 63; return 1; });
// the process's environment, as AUTOEXEC.BAT and Windows leave it (the DOS side's, KERNEL's GetDOSEnvironment):
// COMSPEC, PATH (the Windows folder and its COMMAND folder: where the shell finds programs named without a path,
// for its shortcuts and its applets), TEMP and TMP, windir; SetEnvironmentVariable changes this process's copy
const ENV0 = [['COMSPEC', 'C:\\COMMAND.COM'], ['PATH', 'C:\\WINDOWS;C:\\WINDOWS\\COMMAND'], ['TEMP', 'C:\\WINDOWS\\TEMP'], ['TMP', 'C:\\WINDOWS\\TEMP'], ['windir', 'C:\\WINDOWS']];
const envOf = p => p.env32 || (p.env32 = new Map(ENV0.map(([k, v]) => [k.toUpperCase(), { name: k, value: v }])));
def('KERNEL32', 'GetEnvironmentStrings', 0, function () {
  const s = [...envOf(this).values()].map(e => `${e.name}=${e.value}`).join('\0') + '\0\0';
  const p = this.alloc(s.length); for (let i = 0; i < s.length; i++) this.u8[p + i] = s.charCodeAt(i); return p;
});
def('KERNEL32', 'GetEnvironmentStringsW', 0, () => 0);
def('KERNEL32', 'FreeEnvironmentStringsA', 1, () => 1);
def('KERNEL32', 'FreeEnvironmentStringsW', 1, () => 1);
def('KERNEL32', 'GetStdHandle', 1, function (n) { const c = conHandles(this); if (!c) return 0xffffffff; return { 0xfffffff6: c[0], 0xfffffff5: c[1], 0xfffffff4: c[2] }[n >>> 0] || 0xffffffff; });
def('KERNEL32', 'GetFileType', 1, function (h) { return conOf(this, h) ? 2 : fileOf(this, h) ? 1 : 0; });   // FILE_TYPE_CHAR, FILE_TYPE_DISK
def('KERNEL32', 'SetHandleCount', 1, n => n);
// character types (CT_CTYPE1: upper 1, lower 2, digit 4, space 8, punct 10h, control 20h, blank 40h, xdigit 80h, alpha 100h)
def('KERNEL32', 'GetStringTypeA', 5, function (lc, type, src, n, out) {
  const len = n === 0xffffffff || n === -1 ? this.readA(src).length + 1 : n;
  const t = new TextDecoder('windows-1252').decode(this.u8.slice(src, src + len));
  for (let i = 0; i < t.length; i++) {
    const c = t[i], up = c !== c.toLowerCase(), lo = c !== c.toUpperCase(); let v = 0;
    if (up) v |= 0x101; if (lo) v |= 0x102; if (/[0-9]/.test(c)) v |= 0x84; if (/[a-f]/i.test(c)) v |= 0x80;
    if (/\s/.test(c)) v |= 8; if (c === ' ' || c === '\t') v |= 0x40; if (c.charCodeAt(0) < 32) v |= 0x20;
    if (!v && c.charCodeAt(0) > 32 && c.charCodeAt(0) !== 127) v |= 0x10;
    this.w16(out + 2 * i, v);
  }
  return 1;
});
def('KERNEL32', 'GetStringTypeW', 4, () => 0);
// (with the locale first, as GetStringTypeA takes it: the same; the wide one's text in UTF-16)
def('KERNEL32', 'GetStringTypeExA', 5, function (lc, type, src, n, out) { return API.KERNEL32.GetStringTypeA[1].call(this, lc, type, src, n, out); });
def('KERNEL32', 'GetStringTypeExW', 5, function (lc, type, src, n, out) {
  if (type !== 1) { this.lastError = 120; return 0; }   // (CT_CTYPE1 only)
  const len = n === 0xffffffff || n === -1 ? (this.readW(src) || '').length + 1 : n;
  for (let i = 0; i < len; i++) {
    const c = String.fromCharCode(this.r16(src + 2 * i)), code = c.charCodeAt(0); let v = 0;
    if (c !== c.toLowerCase()) v |= 0x101; if (c !== c.toUpperCase()) v |= 0x102; if (/[0-9]/.test(c)) v |= 0x84; if (/[a-f]/i.test(c)) v |= 0x80;
    if (/\s/.test(c)) v |= 8; if (c === ' ' || c === '\t') v |= 0x40; if (code < 32) v |= 0x20;
    if (!v && code > 32 && code !== 127) v |= 0x10;
    this.w16(out + 2 * i, v);
  }
  return 1;
});
// case mapping (LCMAP_LOWERCASE 100h, LCMAP_UPPERCASE 200h); a sort key (400h) is the upper-cased text; a zero
// output size asks for the size needed
def('KERNEL32', 'LCMapStringA', 6, function (lc, fl, src, n, dst, max) {
  const len = n === 0xffffffff || n === -1 ? this.readA(src).length + 1 : n;
  let t = new TextDecoder('windows-1252').decode(this.u8.slice(src, src + len));
  if (fl & 0x100) t = t.toLowerCase(); else if (fl & 0x600) t = t.toUpperCase();
  const b = window.W95FS.encode(t); if (!max) return b.length;
  const k = Math.min(b.length, max); this.u8.set(b.subarray(0, k), dst); return k;
});
def('KERNEL32', 'LCMapStringW', 6, () => 0);
// code page 1252 <-> UTF-16; a zero output size asks for the size needed
def('KERNEL32', 'MultiByteToWideChar', 6, function (cp, fl, src, n, dst, max) {
  const len = n === 0xffffffff || n === -1 ? this.readA(src).length + 1 : n, b = this.u8.slice(src, src + len);
  const t = new TextDecoder('windows-1252').decode(b);
  if (!max) return t.length;
  const k = Math.min(t.length, max); for (let i = 0; i < k; i++) this.w16(dst + 2 * i, t.charCodeAt(i));
  return k;
});
def('KERNEL32', 'WideCharToMultiByte', 8, function (cp, fl, src, n, dst, max, dflt, used) {
  let t = '';
  if (n === 0xffffffff || n === -1) { for (let a = src; ; a += 2) { const c = this.r16(a); t += String.fromCharCode(c); if (!c) break; } }
  else for (let i = 0; i < n; i++) t += String.fromCharCode(this.r16(src + 2 * i));
  const b = window.W95FS.encode(t); if (used) this.w32(used, 0);
  if (!max) return b.length;
  const k = Math.min(b.length, max); this.u8.set(b.subarray(0, k), dst); return k;
});
def('KERNEL32', 'GetPriorityClass', 1, () => 0x20);
def('KERNEL32', 'SetPriorityClass', 2, () => 1);
def('KERNEL32', 'FindResourceA', 3, function (m, name, type) {
  const r = this.findResource(this.resName(type), this.resName(name), this.moduleFor(m)); if (!r) return 0;
  return this.newHandle({ kind: 'res', ...r });
});
// a loaded resource is its data's address, as on Win32 (code hands LoadResource's result on without LockResource)
def('KERNEL32', 'LoadResource', 2, function (m, h) { const r = this.obj(h); return r && r.kind === 'res' ? r.addr : 0; });
def('KERNEL32', 'LockResource', 1, function (h) { const r = this.obj(h); return r && r.kind === 'res' ? r.addr : h; });
def('KERNEL32', 'FreeResource', 1, () => 0);
def('KERNEL32', 'SizeofResource', 2, function (m, h) { const r = this.obj(h); return r ? r.size : 0; });

// threads, TLS, synchronization (one guest thread)
def('KERNEL32', 'InitializeCriticalSection', 1, function (p) { this.u8.fill(0, p, p + 24); });
def('KERNEL32', 'ReinitializeCriticalSection', 1, function (p) { this.u8.fill(0, p, p + 24); });
def('KERNEL32', 'UninitializeCriticalSection', 1, () => 0);
def('KERNEL32', 'InterlockedIncrement', 1, function (p) { const v = (this.r32(p) + 1) | 0; this.w32(p, v); return v; });
def('KERNEL32', 'InterlockedDecrement', 1, function (p) { const v = (this.r32(p) - 1) | 0; this.w32(p, v); return v; });
def('KERNEL32', 'IsBadStringPtrA', 2, function (a, n) { if (!a || a >= this.mem.buffer.byteLength) return 1; return 0; });
def('KERNEL32', 'IsDBCSLeadByteEx', 2, () => 0);                   // code page 1252 has no lead bytes
def('KERNEL32', 'IsValidLocale', 2, (lcid) => (lcid & 0xffff) === 0x409 || (lcid & 0xffff) === 0x400 || (lcid & 0xffff) === 0x800 ? 1 : 0);
def('KERNEL32', 'GetProcessVersion', 1, () => 0x00040000);          // a 4.0 program
def('KERNEL32', 'LocalLock', 1, p => p);
def('KERNEL32', 'LocalUnlock', 1, () => 1);
def('KERNEL32', 'GetTempFileNameA', 4, function (dir, pre, uniq, out) {
  const u = uniq || ((Date.now() & 0xffff) | 1), d = this.readA(dir) || 'C:\\WINDOWS\\TEMP';
  const name = `${d.replace(/\\$/, '')}\\${(this.readA(pre) || '').slice(0, 3)}${u.toString(16).toUpperCase().padStart(4, '0')}.TMP`;
  if (!uniq) fsCall(this, () => this.fs.writeFile(name, new Uint8Array(0)));
  this.writeA(out, name, 260); return u;
});
// dates and times in the user's format (en-US: M/d/yy and h:mm:ss tt), or the one asked for
const fmtDT = (p, st, fmt, isTime) => {
  const d = st ? { y: p.r16(st), M: p.r16(st + 2), d: p.r16(st + 6), h: p.r16(st + 8), m: p.r16(st + 10), s: p.r16(st + 12), wd: p.r16(st + 4) } : (() => { const n = new Date(); return { y: n.getFullYear(), M: n.getMonth() + 1, d: n.getDate(), h: n.getHours(), m: n.getMinutes(), s: n.getSeconds(), wd: n.getDay() }; })();
  const f = fmt || (isTime ? 'h:mm:ss tt' : 'M/d/yy');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const two = n => String(n).padStart(2, '0');
  return f.replace(/'([^']*)'|dddd|ddd|dd|d|MMMM|MMM|MM|M|yyyy|yy|y|hh|h|HH|H|mm|m|ss|s|tt|t/g, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case 'dddd': return days[d.wd]; case 'ddd': return days[d.wd].slice(0, 3); case 'dd': return two(d.d); case 'd': return String(d.d);
      case 'MMMM': return months[d.M - 1]; case 'MMM': return months[d.M - 1].slice(0, 3); case 'MM': return two(d.M); case 'M': return String(d.M);
      case 'yyyy': return String(d.y); case 'yy': case 'y': return two(d.y % 100);
      case 'hh': return two(d.h % 12 || 12); case 'h': return String(d.h % 12 || 12); case 'HH': return two(d.h); case 'H': return String(d.h);
      case 'mm': return two(d.m); case 'm': return String(d.m); case 'ss': return two(d.s); case 's': return String(d.s);
      case 'tt': return d.h < 12 ? 'AM' : 'PM'; case 't': return d.h < 12 ? 'A' : 'P';
    }
    return t;
  });
};
const outStr = (p, s, buf, n) => { if (!n) return s.length + 1; if (n < s.length + 1) return 0; p.writeA(buf, s, n); return s.length + 1; };
// the US locale's formats; DATE_LONGDATE (2) the long one. The time's flags: TIME_NOMINUTESORSECONDS (1), TIME_NOSECONDS
// (2), TIME_NOTIMEMARKER (4), TIME_FORCE24HOURFORMAT (8), each dropping a part with the separator before it
def('KERNEL32', 'GetDateFormatA', 6, function (lcid, flags, st, fmt, buf, n) { return outStr(this, fmtDT(this, st, this.readA(fmt) || (flags & 2 ? 'dddd, MMMM dd, yyyy' : null), false), buf, n); });
const timeFmt = (f, flags) => {
  if (flags & 1) f = f.replace(/[^hHt']*m+[^hHt']*s*|[^hHt']*s+/g, ' ').replace(/\s+(?=\s|$)/g, '').replace(/^\s+/, '');
  else if (flags & 2) f = f.replace(/[:.]?s+/g, '');
  if (flags & 4) f = f.replace(/\s*t+/g, '');
  if (flags & 8) f = f.replace(/h+/g, m => m.toUpperCase());
  return f;
};
def('KERNEL32', 'GetTimeFormatA', 6, function (lcid, flags, st, fmt, buf, n) { return outStr(this, fmtDT(this, st, timeFmt(this.readA(fmt) || 'h:mm:ss tt', flags), true), buf, n); });
def('KERNEL32', 'DeleteCriticalSection', 1, () => 0);
def('KERNEL32', 'EnterCriticalSection', 1, () => 0);
def('KERNEL32', 'LeaveCriticalSection', 1, () => 0);
def('KERNEL32', 'GetCurrentThreadId', 0, function () { return this.currentThreadId ? this.currentThreadId() : 0x51; });
def('KERNEL32', 'GetCurrentProcessId', 0, function () { return this.pc.pid; });
def('KERNEL32', 'GetCurrentThread', 0, () => 0xfffffffe);
// TLS slots are the process's; the values are each thread's (a thread the scheduler runs keeps its own)
const tlsOf = p => (p.thread16 && p.thread16.flat ? (p.thread16.tls = p.thread16.tls || []) : (p.tls = p.tls || []));
def('KERNEL32', 'TlsAlloc', 0, function () { this.tls = this.tls || []; this.tlsN = Math.max(this.tlsN || 0, this.tls.length); this.tls[this.tlsN] = 0; return this.tlsN++; });
def('KERNEL32', 'TlsFree', 1, () => 1);
def('KERNEL32', 'TlsGetValue', 1, function (i) { return tlsOf(this)[i] || 0; });
def('KERNEL32', 'TlsSetValue', 2, function (i, v) { tlsOf(this)[i] = v; return 1; });
def('KERNEL32', 'SetConsoleCtrlHandler', 2, () => 1);
def('KERNEL32', 'SetErrorMode', 1, () => 0);
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
def('KERNEL32', 'GetUserDefaultLangID', 0, () => 0x409);
// the date and time formats of English (United States), each given to the callback until it answers FALSE, as
// KERNEL32's EnumDateFormatsA (DATE_SHORTDATE 1, DATE_LONGDATE 2) and EnumTimeFormatsA list them
const DATE_FORMATS = { 1: ['M/d/yy', 'M/d/yyyy', 'MM/dd/yy', 'MM/dd/yyyy', 'yy/MM/dd', 'dd-MMM-yy'], 2: ['dddd, MMMM dd, yyyy', 'MMMM dd, yyyy', 'dddd, dd MMMM, yyyy', 'dd MMMM, yyyy'] };
const TIME_FORMATS = ['h:mm:ss tt', 'hh:mm:ss tt', 'H:mm:ss', 'HH:mm:ss'];
function enumFormats(p, proc, list) {
  if (!proc || !list) { p.lastError = 87; return 0; }
  const buf = p.alloc(64);
  try { for (const f of list) { p.writeA(buf, f); if (!p.call(proc, [buf])) break; } } finally { p.free(buf); }
  return 1;
}
def('KERNEL32', 'EnumDateFormatsA', 3, function (proc, lc, flags) { return enumFormats(this, proc, DATE_FORMATS[flags & 3]); });
def('KERNEL32', 'EnumTimeFormatsA', 3, function (proc) { return enumFormats(this, proc, TIME_FORMATS); });
def('KERNEL32', 'GetSystemDefaultLCID', 0, () => 0x409);
def('KERNEL32', 'IsValidCodePage', 1, cp => (cp === 1252 || cp === 437 ? 1 : 0));
def('KERNEL32', 'GetLocaleInfoW', 4, () => 0);
// the locale's settings, as Windows 95 has them for English (United States) (1033); LOCALE_NOUSEROVERRIDE (80000000h)
// changes nothing, as no user overrides are kept
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LOCALE_US = {
  0x01: '0409', 0x02: 'English (United States)', 0x1001: 'English', 0x03: 'ENU', 0x04: 'English', 0x05: '1', 0x06: 'United States',
  0x1002: 'United States', 0x07: 'USA', 0x08: 'United States', 0x09: '0409', 0x0a: '1', 0x0b: '437', 0x1004: '1252', 0x0c: ',', 0x0d: '1',
  0x0e: '.', 0x0f: ',', 0x10: '3;0', 0x11: '2', 0x12: '1', 0x1010: '1', 0x13: '0123456789', 0x14: '$', 0x15: 'USD', 0x16: '.', 0x17: ',',
  0x18: '3;0', 0x19: '2', 0x1a: '2', 0x1b: '0', 0x1c: '0', 0x1d: '/', 0x1e: ':', 0x1f: 'M/d/yy', 0x20: 'dddd, MMMM dd, yyyy', 0x1003: 'h:mm:ss tt',
  0x21: '0', 0x22: '0', 0x23: '0', 0x1005: '0', 0x24: '0', 0x25: '0', 0x26: '0', 0x27: '0', 0x28: 'AM', 0x29: 'PM', 0x1009: '1', 0x100b: '0',
  0x100c: '6', 0x100d: '0', 0x100e: '', 0x50: '', 0x51: '-', 0x52: '3', 0x53: '0', 0x54: '1', 0x55: '0', 0x56: '1', 0x57: '0',
};
DAYS.forEach((d, i) => { LOCALE_US[0x2a + i] = d; LOCALE_US[0x31 + i] = d.slice(0, 3); });
MONTHS.forEach((m, i) => { LOCALE_US[0x38 + i] = m; LOCALE_US[0x44 + i] = m.slice(0, 3); });
def('KERNEL32', 'GetLocaleInfoA', 4, function (lc, type, buf, n) {
  const v = LOCALE_US[type & 0x7fffffff]; if (v === undefined) { this.lastError = 87; return 0; }
  if (!n) return v.length + 1;
  if (n < v.length + 1) { this.lastError = 122; return 0; }
  this.writeA(buf, v, n); return v.length + 1;
});
def('KERNEL32', 'CompareStringW', 6, () => 2);
def('KERNEL32', 'CompareStringA', 6, function (lc, f, a, na, b, nb) {
  const x = this.readA(a, na < 0 ? 65536 : na) || '', y = this.readA(b, nb < 0 ? 65536 : nb) || '';
  const ci = f & 1, X = ci ? x.toLowerCase() : x, Y = ci ? y.toLowerCase() : y; return X < Y ? 1 : X > Y ? 3 : 2;
});
def('KERNEL32', 'SetEnvironmentVariableA', 2, function (name, value) {
  const k = this.readA(name); if (!k) return 0;
  if (value) envOf(this).set(k.toUpperCase(), { name: k, value: this.readA(value) }); else envOf(this).delete(k.toUpperCase());
  return 1;
});
// GetEnvironmentVariableA: the value's length, copied when the buffer holds it with its NUL (else the size needed);
// 0 and ERROR_ENVVAR_NOT_FOUND for a variable that is not set
def('KERNEL32', 'GetEnvironmentVariableA', 3, function (name, buf, n) {
  const e = envOf(this).get((this.readA(name) || '').toUpperCase());
  if (!e) { this.lastError = 203; return 0; }
  if (!buf || n <= e.value.length) return e.value.length + 1;
  this.writeA(buf, e.value, n); return e.value.length;
});
const ftNow = p => BigInt(Math.floor(p.progTime('wall'))) * 10000n + 116444736000000000n;
def('KERNEL32', 'GetSystemTime', 1, function (p) {
  const d = new Date(this.progTime('wall')); [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].forEach((v, i) => this.w16(p + 2 * i, v));
});
def('KERNEL32', 'GetSystemTimeAsFileTime', 1, function (p) { const t = ftNow(this); this.w32(p, Number(t & 0xffffffffn)); this.w32(p + 4, Number(t >> 32n)); });
def('KERNEL32', 'GetTimeZoneInformation', 1, function (p) { this.u8.fill(0, p, p + 172); this.w32(p, new Date().getTimezoneOffset()); return 0; });
def('KERNEL32', 'FileTimeToSystemTime', 2, function (ft, st) {
  const t = (BigInt(this.r32(ft + 4)) << 32n) | BigInt(this.r32(ft)), d = new Date(Number((t - 116444736000000000n) / 10000n));
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].forEach((v, i) => this.w16(st + 2 * i, v)); return 1;
});
def('KERNEL32', 'SystemTimeToFileTime', 2, function (st, ft) {
  const ms = Date.UTC(this.r16(st), this.r16(st + 2) - 1, this.r16(st + 6), this.r16(st + 8), this.r16(st + 10), this.r16(st + 12), this.r16(st + 14));
  const t = BigInt(ms) * 10000n + 116444736000000000n; this.w32(ft, Number(t & 0xffffffffn)); this.w32(ft + 4, Number(t >> 32n)); return 1;
});
// UTC <-> local by the offset the host's clock is in at that moment (the offset GetTimeZoneInformation reports)
const ftShift = (p, a, b, sign) => {
  const t = ft64(p, a), ms = Number(t - 116444736000000000n) / 10000, off = new Date(ms).getTimezoneOffset();
  ftPut(p, b, t + BigInt(sign * off * 60) * 10000000n); return 1;
};
def('KERNEL32', 'FileTimeToLocalFileTime', 2, function (a, b) { return ftShift(this, a, b, -1); });
def('KERNEL32', 'LocalFileTimeToFileTime', 2, function (a, b) { return ftShift(this, a, b, 1); });

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
// the communications ports (COM1-9, LPT1-9, or \\.\ before one): KERNEL32 serves them through VCOMM's Win32 services,
// each port's own driver (LPT.VXD, SERIAL.VXD) under it. The service a stub VWIN32 calls is given the client registers
// it answers in (EAX, EDX) and the calling VM. VCOMM Win32 services: 1 OpenComm(name), 2 SetupComm, 3 EscapeCommFunction,
// 4 GetCommMask, 5 GetCommProperties, 6 GetCommState, 7 GetCommTimeouts, 8 PurgeComm, 9 SetCommMask, 10 SetCommState,
// 11 SetCommTimeouts, 12 TransmitCommChar, 14 GetCommModemStatus, 15 WriteComm, 16 ReadComm, 17 ClearCommError,
// 18 CloseComm
const VCOMM = 0x2b, COMM_NAME = /^(?:\\\\\.\\)?((?:COM|LPT)[1-9]):?$/i;
function vcomm(p, n, args) {
  const t = p.w32Svcs && p.w32Svcs.get(VCOMM); if (!t || n >= p.r32(t)) return null;
  const crs = p.vcommCrs || (p.vcommCrs = p.alloc(0x60));
  return p.vxdCdecl(p.r32(t + 8 + 8 * n), [crs, p.sysVM(), ...args]).eax >>> 0;
}
const commOf = (p, h) => { const o = p.obj(h); return o && o.kind === 'comm' ? o : null; };
const commCall = (n, nargs) => function (h, ...a) { const c = commOf(this, h); if (!c) { this.lastError = 6; return 0; } const r = vcomm(this, n, [c.vh, ...a.slice(0, nargs)]); return r ? 1 : 0; };
def('KERNEL32', 'SetupComm', 3, commCall(2, 2));
def('KERNEL32', 'EscapeCommFunction', 2, commCall(3, 1));
def('KERNEL32', 'GetCommMask', 2, commCall(4, 1));
def('KERNEL32', 'GetCommProperties', 2, commCall(5, 1));
def('KERNEL32', 'GetCommState', 2, commCall(6, 1));
def('KERNEL32', 'GetCommTimeouts', 2, commCall(7, 1));
def('KERNEL32', 'PurgeComm', 2, commCall(8, 1));
def('KERNEL32', 'SetCommMask', 2, commCall(9, 1));
def('KERNEL32', 'SetCommState', 2, commCall(10, 1));
def('KERNEL32', 'SetCommTimeouts', 2, commCall(11, 1));
def('KERNEL32', 'TransmitCommChar', 2, commCall(12, 1));
def('KERNEL32', 'GetCommModemStatus', 2, commCall(14, 1));
def('KERNEL32', 'ClearCommError', 3, commCall(17, 2));
def('KERNEL32', 'WaitCommEvent', 3, commCall(13, 2));   // (VCOMM's service 13: the mask and the OVERLAPPED)
// (a break: EscapeCommFunction's SETBREAK 8 and CLRBREAK 9, as KERNEL32's SetCommBreak and ClearCommBreak make it)
def('KERNEL32', 'SetCommBreak', 1, function (h) { return API.KERNEL32.EscapeCommFunction[1].call(this, h, 8); });
def('KERNEL32', 'ClearCommBreak', 1, function (h) { return API.KERNEL32.EscapeCommFunction[1].call(this, h, 9); });
// a port's COMMCONFIG (dwSize, wVersion 1, its DCB at 8, dwProviderSubType PST_RS232 1, no provider data: 52 bytes) from
// its state, and its state from one
const CC_SIZE = 52;
def('KERNEL32', 'GetCommConfig', 3, function (h, cc, pn) {
  if (!commOf(this, h)) { this.lastError = 6; return 0; }
  const have = pn ? this.r32(pn) : 0; if (pn) this.w32(pn, CC_SIZE);
  if (!cc || have < CC_SIZE) { this.lastError = 122; return 0; }   // ERROR_INSUFFICIENT_BUFFER: the size it needs
  this.u8.fill(0, cc, cc + CC_SIZE); this.w32(cc, CC_SIZE); this.w16(cc + 4, 1); this.w32(cc + 8, 28);
  if (!API.KERNEL32.GetCommState[1].call(this, h, cc + 8)) return 0;
  this.w32(cc + 36, 1); return 1;
});
def('KERNEL32', 'SetCommConfig', 3, function (h, cc) { return cc ? API.KERNEL32.SetCommState[1].call(this, h, cc + 8) : 0; });
// the port's settings dialog: its provider's, the serial port's SERIALUI.DLL (drvCommConfigDialog), as KERNEL32 finds
// it for a port of class Ports
def('KERNEL32', 'CommConfigDialogA', 3, function (name, hwnd, cc) {
  const ui = this.loadDll('SERIALUI'), fn = ui && ui.exports.get('drvCommConfigDialog');
  if (!fn) { this.lastError = 2; return 0; }
  this.runPendingInits(); for (const m of this.importClosure(ui)) this.attach(m);
  const r = this.call(fn, [name, hwnd, cc]); this.lastError = r; return r ? 0 : 1;   // (it answers an error code)
});
// an overlapped operation's result: the port's and the files' operations here finish before their call returns, so
// it is the OVERLAPPED's (Internal, its status; InternalHigh, the bytes)
def('KERNEL32', 'GetOverlappedResult', 4, function (h, ov, pn) {
  if (!ov) { this.lastError = 87; return 0; }
  if (pn) this.w32(pn, this.r32(ov + 4));
  const st = this.r32(ov) >>> 0; if (st && st !== 0x103) { this.lastError = st; return 0; }
  return 1;
});
def('KERNEL32', 'CreateFileA', 7, function (name, access, share, sa, disp, flags) {
  const path = this.readA(name); const write = !!(access & 0x40000000), read = !!(access & 0x80000000) || !write;
  const cm = COMM_NAME.exec(path || '');
  if (cm) {   // a port: VCOMM opens it (its driver loaded as the port is first opened)
    const s = this.alloc(8); this.writeA(s, cm[1].toUpperCase());
    const vh = vcomm(this, 1, [s]);
    if (vh === null || vh >= 0xfffffff6) { this.lastError = vh === 0xfffffffe ? 5 : 2; return 0xffffffff; }   // IE_OPEN (in use): access denied
    this.lastError = 0; return this.newHandle({ kind: 'comm', vh, path: cm[1].toUpperCase() });
  }
  return fsCall(this, () => {
    const exists = this.fs.exists(path);
    if (disp === 1 && exists) throw new window.W95FS.FSError(80, path);           // CREATE_NEW
    if ((disp === 3 || disp === 5) && !exists) throw new window.W95FS.FSError(2, path); // OPEN_EXISTING / TRUNCATE_EXISTING
    if (exists && this.fs.stat(path).isDir) return this.newHandle({ kind: 'dirhandle', path });
    const mode = disp === 2 || disp === 5 ? (read ? 'w+' : 'w') : !exists ? (read ? 'w+' : 'w') : write ? 'r+' : 'r';
    return this.newHandle({ kind: 'file', fd: this.fs.open(path, mode), path });
  }, 0xffffffff);
});
def('KERNEL32', 'CloseHandle', 1, function (h) { const f = fileOf(this, h); if (f) fsCall(this, () => this.fs.close(f.fd)); const c = commOf(this, h); if (c) vcomm(this, 18, [c.vh]); this.handles.delete(h); return 1; });
// ---- consoles: a Win32 console program's, which an MS-DOS machine's window is (a DOS box is a console, as CONAGENT makes
// one in Windows 95); the process's console is the one it was started with (pc.console, worker.js spawnProgram), its
// standard handles console handles. What it writes goes to the page (host.console), what is typed comes back in lines
// (conIn) and a read waits for one as a thread waits (YIELD: the machine's other threads run on)
const conOf = (p, h) => { const o = p.obj(h); return o && o.kind === 'con' ? o : null; };
const conHandles = p => {
  const pc = p.pc; if (!pc || pc.console === undefined || pc.console === null) return null;
  return pc.conH || (pc.conH = ['in', 'out', 'err'].map(io => p.newHandle({ kind: 'con', io, console: pc.console })));
};
const conWrite = (p, o, buf, n) => { const s = String.fromCharCode(...p.u8.subarray(buf, buf + n)); if (p.host.console) p.host.console(o.console, s); return n; };
const conRead = (p, o, buf, n, got) => {
  const q = p.conIn && p.conIn.get(o.console) || '';
  const inMode = (p.pc && p.pc.conH && (p.obj(p.pc.conH[0]) || {}).mode);
  if (inMode !== undefined && !(inMode & 2) && q) {   // (no line input: what keys have come, at once)
    const k = Math.min(n, q.length); for (let i = 0; i < k; i++) p.u8[buf + i] = q.charCodeAt(i) & 0xff;
    p.conIn.set(o.console, q.slice(k)); if (got) p.w32(got, k); return 1;
  }
  const nl = q.indexOf('\n');
  if (nl < 0) { if (p.host.consoleExited && p.host.consoleExited(o.console)) { if (got) p.w32(got, 0); return 1; } return p.atThreadTop && p.atThreadTop() ? YIELD : (p.threads16 && p.threads16(true), YIELD); }
  const line = q.slice(0, nl + 1).replace(/\n$/, '\r\n'), k = Math.min(n, line.length);
  for (let i = 0; i < k; i++) p.u8[buf + i] = line.charCodeAt(i) & 0xff;
  p.conIn.set(o.console, line.length > k ? line.slice(k).replace(/\r\n$/, '\n') + q.slice(nl + 1) : q.slice(nl + 1));
  if (got) p.w32(got, k); return 1;
};
def('KERNEL32', 'ReadFile', 5, function (h, buf, n, got) {
  const co = conOf(this, h); if (co) return conRead(this, co, buf, n, got);
  const f = fileOf(this, h); if (!f) return 0;
  return fsCall(this, () => { const b = this.fs.read(f.fd, n); this.u8.set(b, buf); if (got) this.w32(got, b.length); return 1; });
});
def('KERNEL32', 'WriteFile', 5, function (h, buf, n, put, ovl) {
  const co = conOf(this, h); if (co) { conWrite(this, co, buf, n); if (put) this.w32(put, n); return 1; }
  const c = commOf(this, h);
  if (c) {   // WriteComm: the request completes into the OVERLAPPED's InternalHigh; a write without one waits for it
    const pw = put || this.alloc(4), o = ovl || this.commOvl || (this.commOvl = this.alloc(20));
    this.w32(pw, 0); if (!ovl) this.w32(o + 4, 0xffffffff);
    const r = vcomm(this, 15, [c.vh, buf, n, pw, 0, o]);
    for (let i = 0; r && !ovl && this.r32(o + 4) === 0xffffffff && i < 100000; i++) if (!this.r0Pump() && !(this.r0Skip && this.r0Skip())) break;
    if (!ovl && this.r32(o + 4) !== 0xffffffff) this.w32(pw, this.r32(o + 4));
    return r ? 1 : 0;
  }
  const f = fileOf(this, h); if (!f) { if (put) this.w32(put, n); return 1; }
  return fsCall(this, () => { const k = this.fs.write(f.fd, this.u8.slice(buf, buf + n)); if (put) this.w32(put, k); return 1; });
});
def('KERNEL32', 'SetFilePointer', 4, function (h, lo, hip, how) { const f = fileOf(this, h); if (!f) return 0xffffffff; return fsCall(this, () => this.fs.seek(f.fd, lo | 0, how), 0xffffffff); });
def('KERNEL32', 'GetFileSize', 2, function (h, hi) { const f = fileOf(this, h); if (hi) this.w32(hi, 0); return f ? this.fs.fstat(f.fd).size : 0xffffffff; });
def('KERNEL32', 'SetEndOfFile', 1, function (h) { const f = fileOf(this, h); return f ? fsCall(this, () => (this.fs.truncate(f.fd), 1)) : 0; });
def('KERNEL32', 'FlushFileBuffers', 1, () => 1);
// the Win16-style file calls (_lopen and friends) as Win32 has them: handles from the same table, -1 (HFILE_ERROR) on failure
const lfile = (p, path, mode) => fsCall(p, () => p.newHandle({ kind: 'file', fd: p.fs.open(path, mode), path }), 0xffffffff);
def('KERNEL32', '_lopen', 2, function (name, mode) { const m = mode & 3; return lfile(this, this.readA(name), m === 0 ? 'r' : 'r+'); });
def('KERNEL32', '_lcreat', 2, function (name, attr) { return lfile(this, this.readA(name), 'w+'); });
def('KERNEL32', '_lclose', 1, function (h) { const f = fileOf(this, h); if (!f) return 0xffffffff; fsCall(this, () => this.fs.close(f.fd)); this.handles.delete(h); return 0; });
def('KERNEL32', '_lread', 3, function (h, buf, n) {
  const co = conOf(this, h); if (co) { const g = this.scratch4 || (this.scratch4 = this.alloc(4)), r = conRead(this, co, buf, n, g); return r === YIELD ? r : this.r32(g); }   // (the console: XCOPY32 reads its answers so)
  const f = fileOf(this, h); if (!f) return 0xffffffff; return fsCall(this, () => { const b = this.fs.read(f.fd, n); this.u8.set(b, buf); return b.length; }, 0xffffffff); });
def('KERNEL32', '_lwrite', 3, function (h, buf, n) {
  const co = conOf(this, h); if (co) return conWrite(this, co, buf, n);   // (the console: XCOPY32 writes so)
  const f = fileOf(this, h); if (!f) return 0xffffffff;
  return fsCall(this, () => { if (!n) { this.fs.truncate(f.fd); return 0; } return this.fs.write(f.fd, this.u8.slice(buf, buf + n)); }, 0xffffffff);   // 0 bytes truncates there
});
def('KERNEL32', '_llseek', 3, function (h, off, how) { const f = fileOf(this, h); if (!f) return 0xffffffff; return fsCall(this, () => this.fs.seek(f.fd, off | 0, how), 0xffffffff); });
// OpenFile: the Win16 open by name, filling an OFSTRUCT (length, fixed-disk flag, DOS error, date/time, full path).
// A name without a directory is looked for as Windows does: current directory, WINDOWS, SYSTEM. OF_PARSE only fills
// the path, OF_EXIST opens and closes, OF_DELETE deletes; the access bits (0 read, 1 write, 2 both) and OF_CREATE pick the mode
def('KERNEL32', 'OpenFile', 3, function (name, of, style) {
  const n = this.readA(name) || '', W = window.W95FS;
  let path = /^([a-z]:)?\\/i.test(n) ? n : null;
  if (!path && !(style & 0x1000)) for (const d of [this.fs.cwd, 'C:\\WINDOWS', 'C:\\WINDOWS\\SYSTEM']) { const f = W.join(d, n); if (this.fs.exists(f)) { path = f; break; } }
  if (!path) path = W.join(this.fs.cwd, n);
  const fill = (err, full) => { this.u8.fill(0, of, of + 136); this.u8[of] = 136; this.u8[of + 1] = 1; this.w16(of + 2, err); this.writeA(of + 8, full.toUpperCase(), 128); };
  if (style & 0x100) { fill(0, path); return 0; }                                                     // OF_PARSE
  try {
    if (style & 0x200) { this.fs.unlink(path); fill(0, path); return 1; }                             // OF_DELETE
    const full = this.fs.exists(path) ? this.fs.realpath(path) : path;
    const acc = style & 3, mode = style & 0x1000 ? (acc ? 'w+' : 'w+') : acc ? 'r+' : 'r';
    const fd = this.fs.open(full, mode); fill(0, full);
    if (style & 0x4000) { this.fs.close(fd); return 1; }                                               // OF_EXIST
    return this.newHandle({ kind: 'file', fd, path: full });
  } catch (e) {
    if (!(e instanceof W.FSError)) throw e;
    fill(e.code || 2, path); this.lastError = e.code || 2; return 0xffffffff;
  }
});
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
def('KERNEL32', 'GetDriveTypeA', 1, function (n) { const l = ((this.readA(n) || this.fs.cwd)[0] || 'C').toUpperCase(); const v = this.fs.vols.get(l); return !v ? 1 : { removable: 2, fixed: 3, remote: 4, cdrom: 5 }[v.kind] || 3; });   // (a network drive's DRIVE_REMOTE)
def('KERNEL32', 'GetLogicalDrives', 0, function () { let m = 0; for (const v of this.fs.vols.values()) m |= 1 << (v.letter.charCodeAt(0) - 65); return m; });
// GetLogicalDriveStringsA: the drives' root paths, each null-terminated, then a null ("A:\0C:\0D:\0" with backslashes);
// the length needed when the buffer is too small (LINKINFO asks with none first)
def('KERNEL32', 'GetLogicalDriveStringsA', 2, function (n, buf) {
  const s = [...this.fs.vols.keys()].sort().map(l => `${l}:\\\0`).join('');
  if (!buf || n < s.length + 1) return s.length + 1;
  for (let i = 0; i < s.length; i++) this.u8[buf + i] = s.charCodeAt(i); this.u8[buf + s.length] = 0;
  return s.length;
});
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
// File mappings: of a file (its contents copied in when mapped), or with no file (INVALID_HANDLE_VALUE: memory of
// the given size, zeroed, which every view of it shares). A named one is found again by CreateFileMappingA (with
// ERROR_ALREADY_EXISTS) and OpenFileMappingA
const sections = p => p.sections || (p.sections = new Map());
def('KERNEL32', 'CreateFileMappingA', 6, function (h, sa, prot, hi, lo, name) {
  const key = name ? this.readA(name).toUpperCase() : null, had = key && sections(this).get(key);
  if (had) { this.lastError = 183; return this.newHandle(had); }
  let m;
  if (u32(h) === 0xffffffff) { if (!lo) { this.lastError = 87; return 0; } const base = this.alloc(lo); this.u8.fill(0, base, base + lo); m = { kind: 'mapping', base, size: lo }; }
  else { const f = fileOf(this, h); if (!f) { this.lastError = 6; return 0; } m = { kind: 'mapping', path: f.path }; }
  if (key) sections(this).set(key, m);
  this.lastError = 0; return this.newHandle(m);
});
def('KERNEL32', 'OpenFileMappingA', 3, function (access, inherit, name) {
  const m = name && sections(this).get(this.readA(name).toUpperCase()); if (!m) { this.lastError = 2; return 0; }
  this.lastError = 0; return this.newHandle(m);
});
def('KERNEL32', 'MapViewOfFile', 5, function (h, access, hi, lo) {
  const m = this.obj(h); if (!m || m.kind !== 'mapping') { this.lastError = 6; return 0; }
  if (m.base) return m.base + lo;
  return fsCall(this, () => { const b = this.fs.readFile(m.path); const p = this.alloc(b.length + 1); this.u8.set(b, p); return p + lo; });
});
def('KERNEL32', 'UnmapViewOfFile', 1, function (p) { for (const m of sections(this).values()) if (p >= m.base && p < m.base + m.size) return 1; this.free(p); return 1; });
def('KERNEL32', 'CreateFileW', 7, () => 0xffffffff);
def('KERNEL32', 'GetFullPathNameA', 4, function (n, len, buf, part) {
  const s = this.readA(n); const full = /^[a-z]:/i.test(s) ? s : window.W95FS.join(this.fs.cwd, s); this.writeA(buf, full, len);
  if (part) this.w32(part, buf + full.lastIndexOf('\\') + 1); return full.length;
});
def('KERNEL32', 'SetStdHandle', 2, () => 1);
def('KERNEL32', 'GetConsoleMode', 2, function (h, p) { const o = conOf(this, h); if (!o) return 0; this.w32(p, o.io === 'in' ? (o.mode === undefined ? 7 : o.mode) : 3); return 1; });   // (line input, echo, processed input; processed output, wrap)
// (the input's mode to the console's window, which edits and echoes the line as it says: ENABLE_LINE_INPUT 2, ENABLE_ECHO_INPUT 4)
def('KERNEL32', 'SetConsoleMode', 2, function (h, mode) { const o = conOf(this, h); if (!o) return 0; if (o.io === 'in') { o.mode = mode; if (this.host.consoleMode) this.host.consoleMode(o.console, mode); } return 1; });
def('KERNEL32', 'WriteConsoleA', 5, function (h, buf, n, put) { const o = conOf(this, h); if (!o) return 0; conWrite(this, o, buf, n); if (put) this.w32(put, n); return 1; });
def('KERNEL32', 'DuplicateHandle', 7, function (a, h, b, out) { if (out) this.w32(out, h); return 1; });
def('KERNEL32', 'WaitForSingleObject', 2, () => 0);
// a process's exit code: STILL_ACTIVE (103h) while it runs, else its code (a Win16 task's too); the process's own
// pseudo-handle asks about itself. (It answered FALSE, and a caller polling for a child's end never saw it)
def('KERNEL32', 'GetExitCodeProcess', 2, function (h, out) {
  const o = (h >>> 0) === 0xffffffff ? { kind: 'process', pid: this.pc && this.pc.pid } : this.obj(h);
  if (!o || o.kind !== 'process') { this.lastError = 6; return 0; }
  let code;
  if (o.task) code = o.task.state === 'done' ? (o.task.exitCode >>> 0) || 0 : 0x103;
  else { const pc = this.procs && this.procs.get(o.pid); code = pc ? (pc.exitCode === null ? 0x103 : pc.exitCode >>> 0) : (this.exitCodes && this.exitCodes.get(o.pid)) || 0; }
  if (out) this.w32(out, code); return 1;
});
// threads run where the scheduler for them is (a session on the native USER, ne16.js threads16); elsewhere there is
// no second thread
def('KERNEL32', 'CreateThread', 6, function (attr, stack, start, param, flags, ptid) {
  if (!this.newThread || !this.nativeUser16 || !this.nativeUser16()) return 0;
  const t = this.newThread(start, param, stack, true, !!(flags & 4));
  if (ptid) this.w32(ptid, t.id);
  return this.newHandle({ kind: 'thread', id: t.id });
});
def('KERNEL32', 'ExitThread', 'regs', function () {
  const c = this.r32(this.reg('esp') + 4);
  if (this.thread16 && this.thread16.id !== 0x51) { this.thread16.exitCode = c; return LAYOUT.SENTINEL; }   // ends that thread only
  this.exitCode = c; this.host.exited(c); return LAYOUT.SENTINEL;
});
def('KERNEL32', 'ResumeThread', 1, function (h) {
  const o = this.obj(h), t = o && o.kind === 'thread' && this.threadsById && this.threadsById.get(o.id);
  if (t && t.state === 'suspended') { t.state = 'new'; return 1; } return 0;
});
def('KERNEL32', 'SetLocalTime', 1, () => 0);
def('KERNEL32', 'SetSystemPowerState', 2, () => 0);   // (no APM BIOS: the machine cannot be suspended, as Windows 95 answers without one)
def('KERNEL32', 'CreatePipe', 4, () => 0);
// WinExec / CreateProcessA: a program the host runs, started in this address space (ne16.js P.spawn); CreateProcess
// fills PROCESS_INFORMATION (process and thread handles, their ids)
def('KERNEL32', 'WinExec', 2, function (cmd, show) {
  const r = this.host.exec ? this.host.exec(this.readA(cmd) || '', show) : 2;
  // the new process runs as the caller waits (Sleep, waits), when its Win16Lock is let go, as Windows 95 lets it
  return typeof r === 'object' ? 33 : r;
});
// LoadModule(lpModuleName, LOADPARMS32 *): the module started as WinExec starts one, with the command tail the
// parameter block holds (lpCmdLine, a length byte then the text) and its show command (lpCmdShow: 2, nCmdShow)
def('KERNEL32', 'LoadModule', 2, function (name, parms) {
  const tailPtr = parms ? this.r32(parms + 4) : 0, showPtr = parms ? this.r32(parms + 8) : 0;
  const tail = tailPtr ? this.readA(tailPtr + 1, this.u8[tailPtr]) || '' : '', show = showPtr ? this.r16(showPtr + 2) : 1;
  const mod = this.readA(name) || '', r = this.host.exec ? this.host.exec(`"${mod}"${tail.trim() ? ' ' + tail.trim() : ''}`, show) : 2;
  return typeof r === 'object' ? 33 : r;
});
def('KERNEL32', 'CreateProcessA', 10, function (app, cmd, pa, ta, inherit, flags, env, dir, si, pi) {
  const line = this.readA(cmd) || this.readA(app) || '', r = this.host.exec ? this.host.exec(app && cmd ? `"${this.readA(app)}" ${line.replace(/^\s*("[^"]*"|\S+)\s*/, '')}` : line, 1) : 2;
  if (typeof r !== 'object' && r <= 32) { this.lastError = r === 11 ? 193 : r; return 0; }
  // a Windows 3.x program's task: a process of its own, as each Win16 task has its own process database on Windows 95,
  // its handle signalled when the task ends (Explorer waits on it for each RunOnce program before its desktop: with
  // no handle, TAPIINI's, it waited for good)
  if (typeof r === 'number') {
    const t = this.threadsById && [...this.threadsById.values()].reverse().find(x => x.task && x.task.hInst === r);
    if (pi) {
      this.u8.fill(0, pi, pi + 16);
      if (t) { this.w32(pi, this.newHandle({ kind: 'process', task: t, pid: t.tdb })); this.w32(pi + 4, this.newHandle({ kind: 'thread', id: t.id })); this.w32(pi + 8, t.tdb); this.w32(pi + 12, t.id); }
    }
    return 1;
  }
  if (r.elsewhere) { if (pi) this.u8.fill(0, pi, pi + 16); return 1; }   // (a second instance in a machine of its own: no handles here)
  if (pi) { this.w32(pi, this.newHandle({ kind: 'process', pid: r.pid })); this.w32(pi + 4, this.newHandle({ kind: 'thread', id: r.main.id })); this.w32(pi + 8, r.pid); this.w32(pi + 12, r.main.id); }
  // it returns once the new process is loaded, as Windows 95's waits for its load-done event: its main thread has
  // attached its DLLs and USER has its per-process data (WaitForInputIdle, which callers ask next, reads it)
  if (this.threads16 && r.main) for (let k = 0; k < 50 && !r.started && r.exitCode === null && !this.trapped; k++) this.threads16(true, r.main);
  return 1;
});
def('KERNEL32', 'ReadConsoleA', 5, function (h, buf, n, got) { const o = conOf(this, h); return o ? conRead(this, o, buf, n, got) : 0; });
// the console's screen: 80 x 25, as the MS-DOS window has it (the cursor where the text has come to is the page's)
def('KERNEL32', 'GetConsoleScreenBufferInfo', 2, function (h, p) {
  if (!conOf(this, h)) return 0;
  for (const [o, v] of [[0, 80], [2, 25], [4, 0], [6, 24], [8, 7], [10, 0], [12, 0], [14, 79], [16, 24], [18, 80], [20, 25]]) this.w16(p + o, v);
  return 1;
});
def('KERNEL32', 'AllocConsole', 0, function () { return conHandles(this) ? 0 : 0; });   // (a process without one: none here to make)
def('KERNEL32', 'FreeConsole', 0, () => 1);
def('KERNEL32', 'SetConsoleTitleA', 1, () => 1);
// the file functions' code page: a console program asks for the OEM one (its names typed in the console's); file names
// here are the same in both
def('KERNEL32', 'SetFileApisToOEM', 0, function () { this.fileApisOem = true; });
def('KERNEL32', 'SetFileApisToANSI', 0, function () { this.fileApisOem = false; });
def('KERNEL32', 'AreFileApisANSI', 0, function () { return this.fileApisOem ? 0 : 1; });
def('KERNEL32', 'GetConsoleCP', 0, () => 437);          // (the console's code page: EGA.CPI's 437, as the window shows it)
def('KERNEL32', 'GetConsoleOutputCP', 0, () => 437);
def('KERNEL32', 'SetConsoleTextAttribute', 2, function (h) { return conOf(this, h) ? 1 : 0; });
def('KERNEL32', 'SetConsoleCursorPosition', 2, function (h) { return conOf(this, h) ? 1 : 0; });
def('KERNEL32', 'GetConsoleCursorInfo', 2, function (h, p) { if (!conOf(this, h)) return 0; this.w32(p, 25); this.w32(p + 4, 1); return 1; });
def('KERNEL32', 'FlushConsoleInputBuffer', 1, function (h) { const o = conOf(this, h); if (o && this.conIn) this.conIn.set(o.console, ''); return o ? 1 : 0; });
// ---- what SHELL32.DLL and COMCTL32.DLL need of KERNEL32 beyond the above
const ft64 = (p, a) => (BigInt(p.r32(a + 4)) << 32n) | BigInt(p.r32(a));
const ftPut = (p, a, t) => { p.w32(a, Number(t & 0xffffffffn)); p.w32(a + 4, Number((t >> 32n) & 0xffffffffn)); };
def('KERNEL32', 'GetFileTime', 4, function (h, c, a, w) {
  const f = fileOf(this, h); if (!f) return 0;
  const i = this.fs.fstat(f.fd), t = ms => BigInt(Math.round(ms)) * 10000n + 116444736000000000n;
  if (c) ftPut(this, c, t(i.ctime)); if (a) ftPut(this, a, t(i.atime)); if (w) ftPut(this, w, t(i.mtime)); return 1;
});
def('KERNEL32', 'CompareFileTime', 2, function (a, b) { const x = ft64(this, a), y = ft64(this, b); return x < y ? 0xffffffff : x > y ? 1 : 0; });
def('KERNEL32', 'FileTimeToDosDateTime', 3, function (ft, pd, pt) {
  const d = new Date(Number((ft64(this, ft) - 116444736000000000n) / 10000n));
  this.w16(pd, ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate());
  this.w16(pt, (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)); return 1;
});
def('KERNEL32', 'DosDateTimeToFileTime', 3, function (dd, tt, ft) {
  const ms = Date.UTC((dd >> 9) + 1980, ((dd >> 5) & 15) - 1, dd & 31, tt >> 11, (tt >> 5) & 63, (tt & 31) * 2);
  ftPut(this, ft, BigInt(ms) * 10000n + 116444736000000000n); return 1;
});
def('KERNEL32', 'GetDiskFreeSpaceExA', 4, function (n, avail, total, free) {
  return fsCall(this, () => { const v = this.fs.statvfs(this.readA(n) || this.fs.cwd);
    if (avail) ftPut(this, avail, BigInt(v.free)); if (total) ftPut(this, total, BigInt(v.total)); if (free) ftPut(this, free, BigInt(v.free)); return 1; });
});
def('KERNEL32', 'GetVolumeInformationA', 8, function (root, name, nn, serial, maxc, flags, fsn, nf) {
  return fsCall(this, () => {
    const l = ((this.readA(root) || this.fs.cwd)[0] || 'C').toUpperCase(), v = this.fs.vols.get(l); if (!v) throw new window.W95FS.FSError(3, l);
    if (name) this.writeA(name, v.label || '', nn); if (serial) this.w32(serial, v.serial || 0x1d2c3b4a);
    if (maxc) this.w32(maxc, 255); if (flags) this.w32(flags, 0x4006); if (fsn) this.writeA(fsn, v.kind === 'cdrom' ? 'CDFS' : 'FAT', nf); return 1;
  });
});
def('KERNEL32', 'SetVolumeLabelA', 2, function (root, name) { return fsCall(this, () => (this.fs.setLabel(((this.readA(root) || this.fs.cwd)[0] || 'C').toUpperCase(), this.readA(name) || ''), 1)); });
def('KERNEL32', 'GetShortPathNameA', 3, function (l, s, n) { const r = fsCall(this, () => this.fs.stat(this.readA(l)).shortPath, null); if (r === null) return 0; return this.writeA(s, r, n); });   // (the path's 8.3 form, as stat gives it; a path that is not there fails)
def('KERNEL32', 'ExpandEnvironmentStringsA', 3, function (src, dst, n) {
  const env = envOf(this), r = (this.readA(src) || '').replace(/%([^%]+)%/g, (m, k) => { const e = env.get(k.toUpperCase()); return e ? e.value : k.toUpperCase() === 'SYSTEMROOT' ? 'C:\\WINDOWS' : m; });
  if (n) this.writeA(dst, r, n); return r.length + 1;
});
def('KERNEL32', 'RtlZeroMemory', 2, function (p, n) { this.u8.fill(0, p, p + n); });
def('KERNEL32', 'InterlockedExchange', 2, function (p, v) { const o = this.r32(p); this.w32(p, v); return o; });
def('KERNEL32', 'GlobalSize', 1, function (p) { return this.allocs.get(p) || 0; });
def('KERNEL32', 'GlobalHandle', 1, p => p);
def('KERNEL32', 'LocalSize', 1, function (p) { return this.allocs.get(p) || 0; });
def('KERNEL32', 'IsBadCodePtr', 1, function (a) { return a && a < this.mem.buffer.byteLength ? 0 : 1; });
def('KERNEL32', 'DebugBreak', 0, () => 0);
def('KERNEL32', 'GetThreadLocale', 0, () => 0x409);
def('KERNEL32', 'SetThreadPriority', 2, () => 1);
def('KERNEL32', 'GetThreadPriority', 1, () => 0);
def('KERNEL32', 'OpenProcess', 3, function (a, inh, pid) { return this.newHandle({ kind: 'process', pid }); });
def('KERNEL32', 'DeviceIoControl', 8, function () { this.lastError = 50; return 0; });
// LOAD_LIBRARY_AS_DATAFILE (2): only a file that is a Win32 image loads (VERSION.DLL tries every file it is given this
// way first); anything else fails with ERROR_BAD_EXE_FORMAT
def('KERNEL32', 'LoadLibraryExA', 3, function (name, f, fl) {
  if (fl & 2) {
    const path = this.readA(name) || '';
    let pe = false;
    try { const b = this.fs.readFile(this.fs.resolve ? this.fs.resolve(path) : path); const o = b.length > 0x40 ? b[0x3c] | b[0x3d] << 8 | b[0x3e] << 16 | b[0x3f] << 24 : 0; pe = b[0] === 0x4d && b[1] === 0x5a && o + 4 <= b.length && b[o] === 0x50 && b[o + 1] === 0x45 && !b[o + 2] && !b[o + 3]; } catch (_) { pe = false; }
    if (!pe) { this.lastError = 193; return 0; }
  }
  return API.KERNEL32.LoadLibraryA[1].call(this, name);
});
def('KERNEL32', 'WriteProfileStringA', 3, function (sec, key, v) { return API.KERNEL32.WritePrivateProfileStringA[1].call(this, sec, key, v, 0); });
def('KERNEL32', 'GetProfileIntA', 3, function (sec, key, dflt) { return API.KERNEL32.GetPrivateProfileIntA[1].call(this, sec, key, dflt, 0); });
def('KERNEL32', 'GetNumberFormatA', 6, function (lc, fl, val, fmt, out, n) {
  const v = Number(this.readA(val)); if (!isFinite(v)) return 0;
  // NUMBERFMT when given (digits, leading zero, grouping, decimal and thousand separators, negative order); else US
  const f = fmt ? { digits: this.r32(fmt), lead: this.r32(fmt + 4), group: this.r32(fmt + 8), dec: this.readA(this.r32(fmt + 12)) || '.', thou: this.readA(this.r32(fmt + 16)) ?? ',', neg: this.r32(fmt + 20) }
    : { digits: 2, lead: 1, group: 3, dec: '.', thou: ',', neg: 1 };
  let [ip, fp] = Math.abs(v).toFixed(f.digits).split('.');
  if (f.group) ip = ip.replace(new RegExp(`\\B(?=(\\d{${f.group}})+(?!\\d))`, 'g'), f.thou);
  if (ip === '0' && !f.lead && fp) ip = '';
  const body = fp ? ip + f.dec + fp : ip;
  const r = v < 0 ? (['(' + body + ')', '-' + body, '- ' + body, body + '-', body + ' -'][f.neg] || '-' + body) : body;
  if (!n) return r.length + 1; return this.writeA(out, r, n) + 1;
});
// FORMAT_MESSAGE_FROM_STRING (400h) formats `src`; %1..%99 take inserts (with !fmt! printf specs) from the argument
// array (2000h) or the va_list `args`; %0 ends the text, %n %% %. %! are line break, %, . and !; IGNORE_INSERTS (200h)
// copies the text as it is. Message tables (FROM_HMODULE / FROM_SYSTEM) are not kept, so those give "Error N.".
def('KERNEL32', 'FormatMessageA', 7, function (fl, src, id, lang, buf, n, args) {
  let t;
  if (fl & 0x400) {
    const f = this.readA(src) || '';
    if (fl & 0x200) t = f;
    else {
      const arg = k => fl & 0x2000 ? this.r32(args + 4 * (k - 1)) : this.r32(this.r32(args) + 4 * (k - 1));
      t = ''; for (let i = 0; i < f.length; i++) {
        const c = f[i]; if (c !== '%') { t += c; continue; }
        const d = f[++i];
        if (d === '0') break; if (d === 'n') { t += '\r\n'; continue; }
        if (/[1-9]/.test(d)) {
          let k = +d; if (/[0-9]/.test(f[i + 1])) k = k * 10 + +f[++i];
          let spec = 's'; if (f[i + 1] === '!') { const e = f.indexOf('!', i + 2); spec = f.slice(i + 2, e); i = e; }
          const v = arg(k);
          t += /s$/.test(spec) ? (this.readA(v) || '') : wsprintf(this, '%' + spec, (() => { const a = this.alloc(4); this.w32(a, v); return a; })());
          continue;
        }
        t += d;
      }
    }
  } else t = `Error ${id}.\r\n`;
  if (fl & 0x100) { const p = this.alloc(t.length + 1); this.writeA(p, t); this.w32(buf, p); return t.length; }   // FORMAT_MESSAGE_ALLOCATE_BUFFER
  return this.writeA(buf, t, n);
});
def('KERNEL32', '_hread', 3, function (h, b, n) { return API.KERNEL32._lread[1].call(this, h, b, n); });
def('KERNEL32', '_hwrite', 3, function (h, b, n) { return API.KERNEL32._lwrite[1].call(this, h, b, n); });
// events and semaphores: one guest thread, so a wait finds the object signalled or times out at once
// named synchronization objects: a second create finds the first (ERROR_ALREADY_EXISTS), Open* finds it by name
const named = (p, name, make) => {
  const key = name && p.readA(name).toUpperCase(), objs = p.namedObjs || (p.namedObjs = new Map()), had = key && objs.get(key);
  if (had) { p.lastError = 183; return p.newHandle(had); }
  const o = make(); if (key) objs.set(key, o); p.lastError = 0; return p.newHandle(o);
};
const openNamed = (p, name, kind) => { const o = name && (p.namedObjs || new Map()).get(p.readA(name).toUpperCase()); if (!o || o.kind !== kind) { p.lastError = 2; return 0; } p.lastError = 0; return p.newHandle(o); };
def('KERNEL32', 'CreateEventA', 4, function (sa, manual, initial, name) { return named(this, name, () => ({ kind: 'event', manual: !!manual, set: !!initial })); });
def('KERNEL32', 'OpenEventA', 3, function (access, inherit, name) { return openNamed(this, name, 'event'); });
def('KERNEL32', 'SetEvent', 1, function (h) { const o = this.obj(h); if (!o || o.kind !== 'event') return 0; if (this.signal) this.signal(o); else o.set = true; return 1; });
def('KERNEL32', 'ResetEvent', 1, function (h) { const o = this.obj(h); if (!o || o.kind !== 'event') return 0; o.set = false; return 1; });
def('KERNEL32', 'ReleaseMutex', 1, function (h) { const o = this.obj(h); if (!o || o.kind !== 'mutex') return 0; o.owned = false; return 1; });
def('KERNEL32', 'CreateSemaphoreA', 4, function (sa, init, max, name) { return named(this, name, () => ({ kind: 'semaphore', count: init, max })); });
def('KERNEL32', 'ReleaseSemaphore', 3, function (h, n, prev) {
  const o = this.obj(h); if (!o || o.kind !== 'semaphore') return 0; if (prev) this.w32(prev, o.count); o.count = Math.min(o.max, o.count + n);
  if (this.wakeWaiters) this.wakeWaiters(o);   // (the threads blocked on it look again)
  return 1;
});
def('KERNEL32', 'WaitForMultipleObjects', 4, function (n, hs, all, ms) {
  for (let i = 0; i < n; i++) { const o = this.obj(this.r32(hs + 4 * i)); if (!o || (o.kind === 'event' && o.set) || (o.kind === 'semaphore' && o.count > 0) || !['event', 'semaphore'].includes(o.kind)) { if (o && o.kind === 'event' && !o.manual) o.set = false; if (o && o.kind === 'semaphore') o.count--; return i; } }
  return 0x102;
});
def('KERNEL32', 'CreateMutexA', 3, function (sa, owned, name) { return named(this, name, () => ({ kind: 'mutex', owned: !!owned })); });
def('KERNEL32', 'OpenMutexA', 3, function (access, inherit, name) { return openNamed(this, name, 'mutex'); });
def('KERNEL32', 'MakeCriticalSectionGlobal', 1, () => 0);
def('KERNEL32', 'WaitForSingleObjectEx', 3, function (h, ms) { return API.KERNEL32.WaitForSingleObject[1].call(this, h, ms); });
// change notifications: nothing changes the disk while a guest waits on one, so they never fire
def('KERNEL32', 'FindFirstChangeNotificationA', 3, function () { return this.newHandle({ kind: 'event', manual: true, set: false }); });
def('KERNEL32', 'FindNextChangeNotification', 1, () => 1);
def('KERNEL32', 'FindCloseChangeNotification', 1, function (h) { this.handles.delete(h); return 1; });
// global atoms, shared by the process's modules. Under the native USER they are USER's (GlobalAddAtom and the rest are
// USER.268-271, which window properties and registered messages use too), as Windows 95's KERNEL32 reaches them
const atomsOf = p => p.globalAtoms || (p.globalAtoms = { byName: new Map(), byId: new Map(), next: 0xc000 });
const userAtom = (p, ord, args) => (p.nativeUser16 && p.nativeUser16() ? p.user16(ord, args).ax : null);
const segStr = (p, s) => (s >>> 16 ? p.mapLS(s) : s);
def('KERNEL32', 'GlobalAddAtomA', 1, function (s) {
  { const r = userAtom(this, 268, [['l', segStr(this, s)]]); if (r !== null) return r; }
  if (!(s >>> 16)) return s & 0xffff;
  const t = atomsOf(this), k = (this.readA(s) || '').toUpperCase();
  if (k[0] === '#') return parseInt(k.slice(1), 10) & 0xffff;
  let a = t.byName.get(k); if (!a) { a = { id: t.next++, name: this.readA(s), refs: 0 }; t.byName.set(k, a); t.byId.set(a.id, a); }
  a.refs++; return a.id;
});
def('KERNEL32', 'GlobalDeleteAtom', 1, function (id) { { const r = userAtom(this, 269, [['w', id]]); if (r !== null) return r; } const t = atomsOf(this), a = t.byId.get(id); if (a && --a.refs <= 0) { t.byId.delete(id); t.byName.delete(a.name.toUpperCase()); } return 0; });
def('KERNEL32', 'GlobalFindAtomA', 1, function (s) { { const r = userAtom(this, 270, [['l', segStr(this, s)]]); if (r !== null) return r; } const a = atomsOf(this).byName.get((this.readA(s) || '').toUpperCase()); return a ? a.id : 0; });
def('KERNEL32', 'GlobalGetAtomNameA', 3, function (id, buf, n) { { const r = userAtom(this, 271, [['w', id], ['l', this.mapLS(buf)], ['w', Math.min(n, 0xffff)]]); if (r !== null) return r; } const a = atomsOf(this).byId.get(id); return a ? this.writeA(buf, a.name, n) : 0; });
// WSOCK32's socket handles: a KERNEL32 handle it makes for each socket (CreateSocketHandle) and keeps its own data in
// (SetHandleContext, GetHandleContext), as Windows 95's KERNEL32 serves them
def('KERNEL32', 'CreateSocketHandle', 0, function () { return this.newHandle({ kind: 'socket', ctx: 0 }); });
def('KERNEL32', 'SetHandleContext', 2, function (h, ctx) { const o = this.obj(h); if (!o) { this.lastError = 6; return 0; } o.ctx = ctx >>> 0; return 1; });
def('KERNEL32', 'GetHandleContext', 1, function (h) { const o = this.obj(h); if (!o) { this.lastError = 6; return 0; } return o.ctx >>> 0 || 0; });
// code written at run time is translated from its bytes as they are when it runs (dyn.js checks a block's bytes
// before each run): nothing is cached that this would have to drop
def('KERNEL32', 'FlushInstructionCache', 3, () => 1);
// a 16-bit callback to 32-bit code, as a thunk DLL makes one (TAPI32's, for TAPI.DLL): a code segment of its own that
// pops the far return address, pushes the 32-bit callback, pushes the return address back and jumps far to the 16-bit
// finalizer, which calls the callback with it (as KERNEL32's AllocSLCallback builds it); its 16:16 address
def('KERNEL32', 'AllocSLCallback', 2, function (finalizer, callback) {
  const at = this.alloc(32), x = [0x66, 0x5a, 0x66, 0x68, callback & 0xff, callback >>> 8 & 0xff, callback >>> 16 & 0xff, callback >>> 24 & 0xff, 0x66, 0x52,
    0xea, finalizer & 0xff, finalizer >>> 8 & 0xff, finalizer >>> 16 & 0xff, finalizer >>> 24 & 0xff];
  this.u8.fill(0, at, at + 32); this.u8.set(x, at);
  const sel = this.allocSels(at, 32, 0xfb00); (this.slCallbacks || (this.slCallbacks = new Map())).set(sel, at);
  return (sel << 16) >>> 0;
});
def('KERNEL32', 'FreeSLCallback', 1, function (sp) {
  const sel = sp >>> 16, m = this.slCallbacks, at = m && m.get(sel); if (!at) return 0;
  m.delete(sel); this.freeSels(sel); this.free(at); return 1;
});
// KERNEL32's fault dialog's procedure: its dialog 1 (the program's name as the title, "This program has performed an
// illegal operation...", Close, Details>>, the details in an edit below), run in the system's machine by the worker
// for a program that faulted (worker.js faultBox), as KERNEL32 shows it, on the system's own screen and pointer.
// lParam: the title, the message and the details. Details>> grows the dialog to the marker control's 152 dialog units
const faultBoxes = new Map();
def('KERNEL32', 'FaultDlgProc', 4, function (h, msg, wp, lp) {
  const user = this.byName.get('USER32'), U = n => (...a) => this.call(user.exports.get(n), a);
  if (msg === 0x110) {   // WM_INITDIALOG
    U('SetWindowTextA')(h, this.r32(lp)); U('SetDlgItemTextA')(h, 3, this.r32(lp + 4)); U('SetDlgItemTextA')(h, 8, this.r32(lp + 8));
    U('SendDlgItemMessageA')(h, 9, 0x170, U('LoadIconA')(0, 32513), 0);   // (STM_SETICON, IDI_HAND)
    faultBoxes.set(h, false); return 1;
  }
  if (msg === 0x111) {   // WM_COMMAND
    const id = wp & 0xffff;
    if (id === 1 || id === 2) { faultBoxes.delete(h); U('EndDialog')(h, 1); return 1; }
    if (id === 4) {
      const open = !faultBoxes.get(h); faultBoxes.set(h, open);
      const rc = this.alloc(32), s = rc + 16;
      try {
        this.w32(rc, 0); this.w32(rc + 4, 61); this.w32(rc + 8, 0); this.w32(rc + 12, 152); U('MapDialogRect')(h, rc);
        const d = this.i32(rc + 12) - this.i32(rc + 4);
        U('GetWindowRect')(h, rc); const w = this.i32(rc + 8) - this.i32(rc), hh = this.i32(rc + 12) - this.i32(rc + 4);
        U('SetWindowPos')(h, 0, 0, 0, w, hh + (open ? d : -d), 6);   // (SWP_NOMOVE, SWP_NOZORDER)
        this.writeA(s, open ? '&Details<<' : '&Details>>'); U('SetDlgItemTextA')(h, 4, s);
      } finally { this.free(rc); }
      return 1;
    }
  }
  return 0;
});
// local atoms: the process's own table (InitAtomTable sizes it; AddAtom makes it), as KERNEL32's are: an integer atom
// (#n, or a value under C000h) is itself. HyperTerminal's AddAtomA was a dead import, its fault the system's end
const localAtoms = p => { const pc = p.pc; return pc.atoms || (pc.atoms = { byName: new Map(), byId: new Map(), next: 0xc000 }); };
const intAtom32 = (p, s) => (!(s >>> 16) ? s & 0xffff : /^#\d+$/.test(p.readA(s) || '') ? parseInt(p.readA(s).slice(1), 10) & 0xffff : null);
def('KERNEL32', 'InitAtomTable', 1, function () { localAtoms(this); return 1; });
def('KERNEL32', 'AddAtomA', 1, function (s) {
  const i = intAtom32(this, s); if (i !== null) return i;
  const t = localAtoms(this), name = (this.readA(s) || '').slice(0, 255), k = name.toUpperCase();
  let a = t.byName.get(k); if (!a) { if (t.next > 0xffff) return 0; a = { id: t.next++, name, refs: 0 }; t.byName.set(k, a); t.byId.set(a.id, a); }
  a.refs++; return a.id;
});
def('KERNEL32', 'FindAtomA', 1, function (s) { const i = intAtom32(this, s); if (i !== null) return i; const a = localAtoms(this).byName.get((this.readA(s) || '').toUpperCase()); return a ? a.id : 0; });
def('KERNEL32', 'DeleteAtom', 1, function (id) { const t = localAtoms(this), a = t.byId.get(id); if (a && --a.refs <= 0) { t.byId.delete(id); t.byName.delete(a.name.toUpperCase()); } return 0; });
def('KERNEL32', 'GetAtomNameA', 3, function (id, buf, n) {
  if (id < 0xc000) return this.writeA(buf, '#' + id, n);
  const a = localAtoms(this).byId.get(id); return a ? this.writeA(buf, a.name, n) : 0;
});
// KERNEL32's unnamed exports (by ordinal) that the shell uses
def('KERNEL32', '#10', 2, function (s, d) { this.writeA(d, this.readA(s) || ''); return 1; });                                  // CharToOemA
def('KERNEL32', '#11', 3, function (s, d, n) { this.u8.copyWithin(d, s, s + n); return 1; });                                   // CharToOemBuffA
def('KERNEL32', '#12', 2, function (s, d) { this.writeA(d, this.readA(s) || ''); return 1; });                                  // OemToCharA
def('KERNEL32', '#13', 3, function (s, d, n) { this.u8.copyWithin(d, s, s + n); return 1; });                                   // OemToCharBuffA
def('KERNEL32', '#15', -1, function (buf, fmt) { return this.writeA(buf, wsprintf(this, this.readA(fmt), this.reg('esp') + 12)); });   // wsprintfA
def('KERNEL32', '#16', 3, function (buf, fmt, va) { return this.writeA(buf, wsprintf(this, this.readA(fmt), va)); });           // wvsprintfA
def('KERNEL32', '#100', 3, () => 1);

def('KERNEL32', 'ReadConsoleInputA', 4, () => 0);
def('KERNEL32', 'PeekConsoleInputA', 4, () => 0);
def('KERNEL32', 'GetNumberOfConsoleInputEvents', 2, () => 0);
// a program's debug output: the machine's log (the Debug Monitor, DevTools), tagged with the program
def('KERNEL32', 'OutputDebugStringA', 1, function (s) { log('info', this.pc && this.pc.path ? this.pc.path.replace(/^.*\\/, '') : 'EXE', (this.readA(s) || '').replace(/\r?\n$/, '')); return 0; });

// ADVAPI32: registry. Keys are lower-case paths under the root names; values keep their type and bytes.
const regKey = (path, create, orig) => { if (!REGISTRY.has(path)) { if (!create) return null; regMake(path, orig); } return REGISTRY.get(path); };
/** the key a handle and subkey name: its path (lower case), or with `asGiven` the same path with the subkey's case */
const regPath = (p, hk, sub, asGiven) => {
  const root = HKEY[hk] || (p.obj(hk) || {}).path; if (!root) return null;
  const given = sub ? (p.readA(sub) || '').replace(/^\\+|\\+$/g, '') : '';
  const base = asGiven && !HKEY[hk] ? (p.obj(hk) || {}).given || root : root;
  return given ? `${asGiven ? base : root}\\${asGiven ? given : given.toLowerCase()}` : asGiven ? base : root;
};
const regVal = v => typeof v === 'number' ? { type: 4, data: new Uint8Array(new Uint32Array([v]).buffer) } : typeof v === 'string' ? { type: 1, data: window.W95FS.encode(v + '\0') } : v;
const regOpen = function (hk, sub, out, create) {
  const path = regPath(this, hk, sub), given = regPath(this, hk, sub, true); if (!path || !regKey(path, create, given)) return 2;
  if (out) this.w32(out, this.newHandle({ kind: 'key', path, given })); return 0;
};
// GetUserNameA: the name the user logged on with (Network\Logon username, as the logon leaves it); TRUE and the length
// with its null, or ERROR_INSUFFICIENT_BUFFER with the length needed
def('ADVAPI32', 'GetUserNameA', 2, function (buf, pn) {
  const v = regGet('hklm\\network\\logon', 'username'), name = v === undefined ? '' : typeof v === 'string' ? v : window.W95FS.decode(v.data || new Uint8Array(0)).replace(/\0.*$/, '');
  if (this.r32(pn) <= name.length) { this.w32(pn, name.length + 1); this.lastError = 122; return 0; }
  this.writeA(buf, name); this.w32(pn, name.length + 1); return 1;
});
def('ADVAPI32', 'RegOpenKeyA', 3, function (hk, sub, out) { return regOpen.call(this, hk, sub, out, false); });
// the Unicode registry calls Windows 95's ADVAPI32 does not implement: ERROR_CALL_NOT_IMPLEMENTED (120), on which a
// program (OLEAUT32, WSOCK32) uses the ANSI ones
for (const [n, k] of [['RegOpenKeyW', 3], ['RegCreateKeyW', 3], ['RegEnumKeyW', 4], ['RegQueryValueW', 4], ['RegQueryValueExW', 6], ['RegSetValueExW', 6]]) def('ADVAPI32', n, k, () => 120);
def('ADVAPI32', 'RegOpenKeyExA', 5, function (hk, sub, opt, sam, out) { return regOpen.call(this, hk, sub, out, false); });
def('ADVAPI32', 'RegCreateKeyA', 3, function (hk, sub, out) { return regOpen.call(this, hk, sub, out, true); });
def('ADVAPI32', 'RegCreateKeyExA', 9, function (hk, sub, res, cls, opt, sam, sa, out, disp) {
  const path = regPath(this, hk, sub); const existed = REGISTRY.has(path);
  const r = regOpen.call(this, hk, sub, out, true); if (!r && disp) this.w32(disp, existed ? 2 : 1); return r;
});
def('ADVAPI32', 'RegCloseKey', 1, function (h) { if (!HKEY[h]) this.handles.delete(h); return 0; });
def('ADVAPI32', 'RegDeleteKeyA', 2, function (hk, sub) { const path = regPath(this, hk, sub); if (!REGISTRY.has(path)) return 2; for (const k of [...REGISTRY.keys()]) if (k === path || k.startsWith(path + '\\')) { REGISTRY.delete(k); KEYNAME.delete(k); } regChanged({ op: 'delkey', path }); return 0; });
def('ADVAPI32', 'RegDeleteValueA', 2, function (hk, name) { const path = regPath(this, hk, 0), m = regKey(path), n = (this.readA(name) || '').toLowerCase(); if (!m || !m.delete(n)) return 2; regChanged({ op: 'del', path, name: n }); return 0; });
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
// RegQueryValue: a key's default value; a key that has none gives an empty string (as it does in Windows), only a key
// that is not there gives ERROR_FILE_NOT_FOUND
def('ADVAPI32', 'RegQueryValueA', 4, function (hk, sub, data, cb) {
  const m = regKey(regPath(this, hk, sub)); if (!m) return 2;
  if (m.has('')) return regQuery.call(this, m, '', 0, data, cb);
  if (data && cb && this.r32(cb) < 1) { this.w32(cb, 1); return 234; }
  if (data) this.u8[data] = 0;
  if (cb) this.w32(cb, 1);
  return 0;
});
def('ADVAPI32', 'RegSetValueExA', 6, function (hk, name, res, type, data, n) {
  const path = regPath(this, hk, 0); if (!path) return 6;   // ERROR_INVALID_HANDLE
  const m = regKey(path, true), key = (this.readA(name) || '').toLowerCase();
  // a string is kept as the string and its null, whatever count comes with it, as Windows 95's registry keeps one
  // (SPOOLSS gives a printer's "EMF" datatype a count of 2)
  const bytes = type === 1 && data ? window.W95FS.encode((this.readA(data) || '') + '\0') : this.u8.slice(data, data + n);
  const value = { type, data: bytes, name: this.readA(name) || '' };
  m.set(key, value); regChanged({ op: 'set', path, name: key, value });
  if (this.regIntent) this.regIntent(path, key, value);   // (a value a shared session's people set for each other: ne16.js)
  return 0;
});
def('ADVAPI32', 'RegSetValueA', 5, function (hk, sub, type, data, n) { const path = regPath(this, hk, sub); if (!path) return 6; const m = regKey(path, true, regPath(this, hk, sub, true)), value = { type: 1, data: window.W95FS.encode((this.readA(data) || '') + '\0') }; m.set('', value); regChanged({ op: 'set', path, name: '', value }); return 0; });
def('ADVAPI32', 'RegEnumKeyA', 4, function (hk, i, buf, n) {
  const path = regPath(this, hk, 0); const kids = [...REGISTRY.keys()].filter(k => k.startsWith(path + '\\') && !k.slice(path.length + 1).includes('\\'));
  if (i >= kids.length) return 259; this.writeA(buf, keyName(path, kids[i]), n); return 0;
});
def('ADVAPI32', 'RegFlushKey', 1, () => 0);                       // the registry store writes through
def('ADVAPI32', 'RegConnectRegistryA', 3, () => 53);              // another computer's registry: ERROR_BAD_NETPATH
// user profiles' hives (MPRSERV, when profiles are enabled): this machine keeps one user's settings
def('ADVAPI32', 'RegLoadKeyA', 3, () => 1); def('ADVAPI32', 'RegUnLoadKeyA', 2, () => 1); def('ADVAPI32', 'RegSaveKeyA', 3, () => 1);
def('ADVAPI32', 'RegRemapPreDefKey', 2, () => 0);
// RegEnumKeyExA(key, index, name, *cchName, -, class, *cchClass, *lastWrite): the name and its length; no classes, no times
def('ADVAPI32', 'RegEnumKeyExA', 8, function (hk, i, buf, pn, res, cls, pcls, ft) {
  const path = regPath(this, hk, 0); const kids = [...REGISTRY.keys()].filter(k => k.startsWith(path + '\\') && !k.slice(path.length + 1).includes('\\'));
  if (i >= kids.length) return 259;
  const name = keyName(path, kids[i]), n = this.r32(pn); if (n <= name.length) { this.w32(pn, name.length + 1); return 234; }
  this.writeA(buf, name, n); this.w32(pn, name.length);
  if (cls && pcls) { this.u8[cls] = 0; this.w32(pcls, 0); } else if (pcls) this.w32(pcls, 0);
  if (ft) { this.w32(ft, 0); this.w32(ft + 4, 0); }
  return 0;
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
// a locally unique identifier: a counter. The NT security and event-log calls are not implemented on Windows 95 and
// fail with ERROR_CALL_NOT_IMPLEMENTED
def('ADVAPI32', 'AllocateLocallyUniqueId', 1, function (p) { this.luid = (this.luid || 0x3e8) + 1; this.w32(p, this.luid); this.w32(p + 4, 0); return 1; });
for (const [nm, n] of [['InitializeSecurityDescriptor', 2], ['SetSecurityDescriptorDacl', 4], ['RegisterEventSourceW', 2], ['ReportEventW', 9], ['DeregisterEventSource', 1]])
  def('ADVAPI32', nm, n, function () { this.lastError = 120; return 0; });

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
  const win = { kind: 'window', cls: c, proc: c.proc, pc: this.pc, style, ex, x: x | 0, y: y | 0, w: w | 0, h: h | 0, parent, child: !!(style & 0x40000000), dirty: true, surfaceVersion: 1, title: this.readA(title) || '', extra: new Map() };
  const hwnd = this.newHandle(win); win.hwnd = hwnd; this.windows.set(hwnd, win);
  const parentWindow = this.windows.get(parent);
  const pw = parentWindow && (win.child || parentWindow.hostPreview) ? parentWindow : null;
  if (pw && pw.hostPreview) {
    win.parentWin = pw; win.child = true; win.previewChild = true;
    win.ctx = this.host.surface(hwnd, win.w, win.h, win, this.pc);
  } else if (pw) { win.parentWin = pw; win.ctx = pw.ctx; }
  else win.ctx = this.host.surface(hwnd, win.w, win.h, win, this.pc);
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
  for (const child of [...this.windows.values()]) if (child.parent === h) API.USER32.DestroyWindow[1].call(this, child.hwnd);
  if (w.parentWin && w.parentWin.hostPreview) w.parentWin.surfaceVersion++;
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
  if (!(flags & 1)) {
    win.w = w | 0; win.h = hh | 0;
    if (sized && win.previewChild) win.surfaceVersion++;
  }
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
  const pc = this.pc;
  if (pc && /\.SCR$/i.test(pc.path || '')) (pc.messageDebug || (pc.messageDebug = [])).push({ api: 'GetMessageA', msg: m && m.msg, hwnd: m && m.hwnd, quit: this.quit, queue: this.queue.length });
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
def('USER32', 'PostQuitMessage', 1, function (code) {
  const pc = this.pc;
  if (pc && /\.SCR$/i.test(pc.path || '')) (pc.messageDebug || (pc.messageDebug = [])).push({ api: 'PostQuitMessage', code });
  this.quit = code; return 0;
});
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
  return this.newHandle(new DC(this, w ? w.ctx : this.host.surface(0, this.host.width, this.host.height, null, this.pc), w ? w.w : this.host.width, w ? w.h : this.host.height, h));
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
def('USER32', 'IsWindow', 1, function (h) {
  const pc = this.thread16 && this.thread16.pc;
  if (pc && /\.SCR$/i.test(pc.path || '')) (pc.isWindowCalls || (pc.isWindowCalls = [])).push({ h, found: this.windows.has(h), keys: [...this.windows.keys()] });
  return this.windows.has(h) ? 1 : 0;
});
def('USER32', 'GetParent', 1, function (h) { const w = this.windows.get(h); return w ? w.parent : 0; });
def('USER32', 'LoadStringA', 4, function (inst, id, buf, n) { const s = this.loadString(id, this.moduleFor(inst)); if (s === null) { if (n) this.u8[buf] = 0; return 0; } return this.writeA(buf, s, n); });
def('USER32', 'CharNextA', 1, function (p) { return this.u8[p] ? p + 1 : p; });
def('USER32', 'CharUpperA', 1, function (p) { if (p >>> 16) { this.writeA(p, this.readA(p).toUpperCase()); return p; } return String.fromCharCode(p).toUpperCase().charCodeAt(0); });
def('USER32', 'wsprintfA', -1, function (buf, fmt) { return this.writeA(buf, wsprintf(this, this.readA(fmt), this.reg('esp') + 12)); });
def('USER32', 'MessageBeep', 1, () => 1);
def('USER32', 'MessageBoxA', 4, function (h, text, cap) { log('warn', 'win32', `MessageBox: ${this.readA(cap)}: ${this.readA(text)}`); return 1; });
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
/** a PE file's resource (type, id) as bytes, or null */
function peResource(bytes, type, id) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), p = dv.getUint32(0x3c, true), opt = p + 24;
    const nsec = dv.getUint16(p + 6, true), shdr = opt + dv.getUint16(p + 20, true), rsrc = dv.getUint32(opt + 96 + 16, true);
    const off = rva => { for (let i = 0; i < nsec; i++) { const o = shdr + 40 * i, va = dv.getUint32(o + 12, true), sz = Math.max(dv.getUint32(o + 8, true), dv.getUint32(o + 16, true)); if (rva >= va && rva < va + sz) return rva - va + dv.getUint32(o + 20, true); } return -1; };
    const root = off(rsrc);
    const find = (dir, key) => { const n = dv.getUint16(dir + 12, true) + dv.getUint16(dir + 14, true); for (let i = 0; i < n; i++) { const e = dir + 16 + 8 * i; if (key === undefined || dv.getUint32(e, true) === key) return dv.getUint32(e + 4, true); } return null; };
    let o = find(root, type); if (o === null) return null; o = find(root + (o & 0x7fffffff), id); if (o === null) return null; o = find(root + (o & 0x7fffffff));
    const de = root + (o & 0x7fffffff), a = off(dv.getUint32(de, true));
    return bytes.subarray(a, a + dv.getUint32(de + 4, true));
  } catch (_) { return null; }
}
/** FormatMessage's inserts: %n, and %n!printf format! (d, x, with a width and a precision) */
const fmtMsg = (fmt, args) => fmt.replace(/%(\d)(?:!([^!]*)!)?/g, (m, k, f) => {
  const v = args[+k - 1]; if (v === undefined) return '';
  if (!f || f === 's') return String(v);
  const t = /x$/i.test(f) ? (v >>> 0).toString(16).toUpperCase() : String(v | 0), w = /\.?(\d+)/.exec(f);
  return w ? t.padStart(+w[1], '0') : t;
});
// the message for each exception (KERNEL32's strings 106-113; 107 any other)
const FAULT_MSG = { 0: 108, 6: 109, 0xb: 110, 0xc: 111, 0xd: 112, 0xe: 113 };
/** the details KERNEL32 writes for a fault, from its own strings (k32: KERNEL32.DLL's bytes): what, where, the
 *  registers, the bytes at CS:EIP and the stack */
function faultText(k32, prog, f) {
  const s = id => peString(k32, id) || '', r = f.regs, sg = f.segs;
  let t = fmtMsg(s(FAULT_MSG[f.n] || 107), [prog, f.module, f.cs, f.offset, f.n]);
  t += fmtMsg(s(114), [r.eax, f.cs, f.offset, f.flags]) + fmtMsg(s(115), [r.ebx, sg.ss, r.esp, r.ebp]);
  t += fmtMsg(s(116), [r.ecx, sg.ds, r.esi, sg.fsel]) + fmtMsg(s(117), [r.edx, sg.es, r.edi, sg.gsel]);
  t += s(118) + f.bytes.map(b => fmtMsg(s(120), [b])).join('');
  t += s(119); f.stack.forEach((d, i) => { t += fmtMsg(s(122), [d]) + (i % 8 === 7 ? '\n' : ''); });
  return t;
}
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

window.W95Win32 = { log, regAttach, regGet, regKids, regVals, regDel, regSet, regDump, regApply, regWatch: f => regWatchers.add(f), Process, API, STAND_IN, LAYOUT, WM, YIELD, iniGet, iniSet, iniRead, peString, peResource, faultText, fmtMsg, def, dcOf, GuestError, HangError, FaultError, mkCanvas, dibOut };
})();
