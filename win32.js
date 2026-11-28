'use strict';
// Win32 personality for statically recompiled guest code (see tools/recomp.py).
// Loads a PE image from the in-memory file system into wasm linear memory,
// binds its imports to JS implementations of the KERNEL32/USER32/GDI32 subset
// the Windows 95 screen savers use, and runs the recompiled blocks. GDI output
// goes to a Canvas 2D surface.
(() => {
// guest address space: low runtime area, stack, programs' images and the DLLs placed among them from 0x400000, heap,
// per-module block lookup tables from 0x5600000, the system's modules from 0xA000000, VirtualAlloc's space past them
const LAYOUT = { SENTINEL: 0xFFFFFFF0, THUNK: 0xFFFF0000, THUNK16: 0xFFFE0000, ARENA: 0x80000000, FPU: 0x10000, TIB: 0x11000, SCRATCH: 0x12000,
  STACK_LO: 0x100000, STACK_TOP: 0x3ffff0, HEAP: 0x02000000, HEAP_END: 0x05500000,
  // a byte a 4 KB page of the address space, nonzero where ring 3 has no access (the null page, the VxDs' images, the
  // frame buffer's ring-0 mapping): ring-3 code's accesses are checked against it (dyn.js guard), protect() sets it
  PROT: 0x05500000,
  // the modules' block tables (an i32 a code byte): the bundle's at the places its build gave them (tools/build_system.py),
  // a module translated as it loads (dyn.js neCompile) where tableRoom finds room among them
  TABLES: 0x05600000, TABLES_END: 0x08000000,
  // the system's modules (tools/build_system.py), at their build's bases in an arena of their own, as Windows 95 keeps
  // them in its shared arena above 2 GB: 400000h to 2000000h is the programs' whole, each image at its own base. Past
  // it (and past the screen savers' images, 8000000h to A000000h), the address space VirtualAlloc reserves
  SYS_ARENA: 0x0a000000, SYS_ARENA_END: 0x0b100000, VM_LO: 0x0b200000 };
const DLL_CHAIN = 0xFFFFFFE0;   // (where a DllMain run as LoadLibrary returns comes back to: Process.dllChainStep)
const SEH_CONT = 0xFFFFFFDC;    // (where an exception handler the dispatcher called returns to: sehStep)
const YIELD = Symbol('yield');   // returned by an API implementation to suspend the guest at depth 0
const NO_CLOCK = Object.freeze({ tick: 0, wall: 0 });   // (a program reading this machine's own clock: Process.clockOf)
const TICK_MS = 65536 * 1000 / 1193182;   // PIT channel 0 period, 54.925 ms
const CPU_REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget',
  // the interrupt flag (IF): cleared by CLI, set by STI, popped by POPF and IRET (dyn.js); the hardware's interrupts
  // wait while it is clear, as the processor holds them (sound.js raiseIRQ, vmm.js vmIrqDeliver)
  'if',
  // EFLAGS' AF, NT, AC and ID as POPF left them, for PUSHF (dyn.js flagsWord): a thread's own, with its context
  'xf'];
// the processor is the host's: every BUDGET blocks the dispatcher asks it (tick) whether the guest goes on. A run that
// can give up the processor (a thread at its top level) does after SLICE_MS; one inside a call the host made cannot,
// and runs on, as a processor would: its machine is a worker's (worker.js), so it holds nothing but that machine, whose
// interrupts (the keys, the mouse, the timer) still come at each check
// (4 ms: the machine's step, with the input, the timers and a frame, comes round faster than the display's 120 a second
// while a thread computes. A thread stops only where it is at its own top level, not in a call the host made for it,
// and Windows 98 Setup's preparation comes there about every 5 ms: a 7 ms slice ran to its second such point, 10 ms,
// 95 steps a second; 4 ms stops at the first. The step's own work is ~0.1 ms. At 40 a busy 16-bit program left the
// page 16 frames a second)
const EXE_ZONE_END = 0x00c00000;   // (400000h up to here: programs' images at their own base, DLLs elsewhere: imageRoom)
const BUDGET = 0x1000, SLICE_MS = 4;   // (BUDGET: blocks between the checks, so a slice ends close to its time)
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
// SHA-256 of bytes, as hex, synchronously: a module's identity as the bundle records it (meta.sha256), so its
// translation runs only for the file it was made from (worker.js bundled, ne16.js loadLibrary16)
const sha256 = (() => {
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
    0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  return bytes => {
    const n = bytes.length, len = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(len); m.set(bytes); m[n] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(len - 8, Math.floor(n / 0x20000000)); dv.setUint32(len - 4, (n << 3) >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < len; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + w[i - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) >>> 0; }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
  };
})();
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
    // (shared, it grows on demand to 2 GiB, the user address space, as VirtualAlloc's reservations and DLLs above the
    // layout need it (vmFit): fixed, WINHLP32's heap, which doubles its reservation as it grows, ran out of room and
    // copied into address 0)
    this.vmMax = host.shared ? 0x8000 * 0x10000 : pages * 0x10000;
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
      fmod: (a, b) => a % b, frem: (a, b) => a - b * Math.round(a / b), f80load: a => this.f80load(a), f80store: (a, v) => this.f80store(a, v), fbld: a => this.fbld(a), fbstp: (a, v) => this.fbstp(a, v), btrace: e => { if (window.W95BTRACE) window.W95BTRACE(e >>> 0); } };
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
  // (`on` 'write': ring 3 may read them, not write them, as a VxD's memory is to ring 3 on Windows 95)
  protect(lo, hi, on = true) {
    const a = (lo + 0xfff) >>> 12, b = hi >>> 12; if (b > a) this.u8.fill(on === 'write' ? 2 : on ? 1 : 0, LAYOUT.PROT + a, LAYOUT.PROT + b);
    // (who protected the pages, for a fault on them: its log line names the range and the code that set it)
    const tags = this.protTags || (this.protTags = new Map());
    if (on) tags.set(a, { lo, hi, by: ((new Error().stack || '').split('\n')[2] || '').trim() }); else tags.delete(a);
  }
  protOwner(addr) {
    for (const t of (this.protTags || new Map()).values()) if (addr >= t.lo && addr < t.hi) return `${t.lo.toString(16)}-${t.hi.toString(16)} by ${t.by}`;
    return 'none recorded';
  }
  get u8() { return new Uint8Array(this.mem.buffer); }
  get dv() { return new DataView(this.mem.buffer); }
  r32(a) { return this.dv.getUint32(a & 0x7fffffff, true); }
  w32(a, v) { this.dv.setUint32(a & 0x7fffffff, v >>> 0, true); }
  r16(a) { return this.dv.getUint16(a & 0x7fffffff, true); }
  w16(a, v) { this.dv.setUint16(a & 0x7fffffff, v & 0xffff, true); }
  r8(a) { return this.u8[a & 0x7fffffff]; }
  i32(a) { return this.dv.getInt32(a & 0x7fffffff, true); }
  readA(p, max = 65536) { if (!p) return null; p &= 0x7fffffff; const u = this.u8; let s = ''; for (let i = 0; i < max && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; }
  readW(p, max = 65536) { if (!p) return null; let s = ''; for (let i = 0; i < max; i++) { const c = this.r16(p + 2 * i); if (!c) break; s += String.fromCharCode(c); } return s; }
  writeA(p, s, max) {
    p &= 0x7fffffff;
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
      // an image with no relocations moved off its base (diskDll synthRelocs): each dword in its sections, resources
      // aside, that is an address inside the image as linked is moved with it, as its relocations would have moved it
      if (meta.synthRelocs && !dir(5)) {
        const lo = pref >>> 0, hi = lo + dv.getUint32(opt + 56, true), rs = dir(2), re = rs + dv.getUint32(opt + 96 + 2 * 8 + 4, true);
        let n = 0;
        for (let i = 0; i < nsec; i++) {
          const o = shdr + 40 * i, va = dv.getUint32(o + 12, true), len = Math.min(dv.getUint32(o + 8, true) || dv.getUint32(o + 16, true), dv.getUint32(o + 16, true));
          if (rs && va >= rs && va < re) continue;
          for (let k = 0; k + 4 <= len; k++) { const a = base + va + k, v = this.r32(a) >>> 0; if (v >= lo && v < hi) { this.w32(a, v + delta); n++; k += 3; } }
        }
        log('info', 'win32', `${name}: no relocations, moved from ${lo.toString(16)} to ${(base >>> 0).toString(16)}: ${n} addresses of itself found and moved`);
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
      // (an export whose address is inside the export directory is a forwarder: "DLL.Name" or "DLL.#ord", another
      // module's export, which exportOf resolves)
      const e = base + ex, exEnd = ex + dv.getUint32(opt + 96 + 4, true), nf = this.r32(e + 20), nn = this.r32(e + 24), fa = base + this.r32(e + 28), na = base + this.r32(e + 32), oa = base + this.r32(e + 36), obase = this.r32(e + 16);
      const put = (key, r) => { if (!r) return; if (r >= ex && r < exEnd) (rec.forwards || (rec.forwards = new Map())).set(key, this.readA(base + r)); else rec.exports.set(key, base + r); };
      for (let k = 0; k < nf; k++) put('#' + (obase + k), this.r32(fa + 4 * k));
      for (let k = 0; k < nn; k++) put(this.readA(base + this.r32(na + 4 * k)), this.r32(fa + 4 * this.r16(oa + 2 * k)));
      // (the modules forwarded to loaded with it, and attached as its dependencies are: COMCAT's DllRegisterServer is
      // OLE32's, called by whoever loads COMCAT alone)
      for (const f of rec.forwards ? new Set([...rec.forwards.values()].map(s => s.slice(0, s.indexOf('.')).toUpperCase().replace(/\.DLL$/, ''))) : []) {
        const t = f !== name && this.loadDll(f); if (t && !rec.deps.includes(t)) rec.deps.push(t);
      }
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
        const addr = (native && this.exportOf(native, nm)) || (this.peResolve && this.peResolve(dll, nm));   // a ring-0 image's (vmm.js PELDR)
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
    } else if (meta.dynamic && dv.getUint16(opt + 68, true) !== 1 && this.neCompile && this.imports) {
      // (a program's or DLL's image mapped from its file, ring 3's (not a native driver's): its code translated whole as
      // it loads, relocated and its imports bound, into a module of the bundle's shape the dispatcher runs (dyn.js
      // neCompile, memoized on this computer by the file's SHA-256); what it misses is run-time code until the module
      // is translated again with it. Block by block, Windows 98's own USER32, GDI32, SHELL32 and Explorer, mapped from
      // their files, drew the desktop and took the cursor's input at a crawl)
      const code = [];
      for (let i = 0; i < nsec; i++) {
        const o = shdr + 40 * i, ch = dv.getUint32(o + 36, true), vs = dv.getUint32(o + 8, true) || dv.getUint32(o + 16, true), va = dv.getUint32(o + 12, true);
        if ((ch & 0x20000020) && vs) code.push({ num: 0, base: base + va, len: vs, flags: 0, bits: 32, flat: true });
      }
      if (code.length) {
        meta.textLo = Math.min(...code.map(g => g.base)); meta.textHi = Math.max(...code.map(g => g.base + g.len));
        rec.sha256 = sha256(f); rec.codeRanges = code;
        const had = this.neMemo(rec);
        // (no room for its table, or its translation failing: its code run-time code, not a module the dispatcher enters
        // with no run (MSJET40, its table refused, took the dispatcher down: "m.run is not a function")
        try {
          meta.lookup = this.tableRoom(4 * (meta.textHi - meta.textLo), had && had.textLo === meta.textLo ? had.lookup : 0);
          this.vmAudit(`${name}'s table`);
          this.neCompile(rec);
        } catch (e) {
          if (!(e instanceof GuestError)) throw e;
          log('warn', 'win32', `${name}: ${e.message}; its code runs as run-time code`);
          meta.textLo = meta.textHi = 0; rec.run = null; meta.lookup = 0;
        }
      }
    }
    if (name !== 'EXE' && meta.entry) { this.inits.push(rec); (this.initOrder || (this.initOrder = [])).push(rec); }
    return rec;
  }
  loadDll(name) {
    // (a process's own copy first: the one its program's folder holds where another of that name is loaded, as each
    // Windows 95 process finds a DLL it imports in its program's folder before any other)
    const pc = this.loadingPc || (this.thread16 && this.thread16.pc), own = pc && pc.ownDlls && pc.ownDlls.get(name);
    if (own) return own;
    if (this.byName.has(name)) return (pc && this.ownCopy(pc, name)) || this.byName.get(name);
    // (the bundle's translation is of the file it was made from: another file of that name where the loader finds it,
    // Windows 98's GDI32.DLL over Windows 95's, is mapped from disk and runs its own code, as ne16.js loadLibrary16
    // takes a 16-bit module; the bundle's GDI32 connected nothing of Windows 98's GDI.EXE)
    let d = this.dlls.get(name);
    // (its stand-ins, API[name], answer as they do for the bundle's: by name, over the module's own exports)
    if (d && d.file && this.fs && !STAND_IN.has(name)) {
      const file = /\./.test(name) ? name : name + '.DLL'; let f = null;
      for (const dir of [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS']) { try { f = this.fs.readFile(dir + '\\' + file); break; } catch (_) { /* not there */ } }
      if (f && !sameBytes(f, d.file)) { this.dlls.delete(name); d = this.diskDll(name, true); }
    }
    d = d || this.diskDll(name); if (!d) return null;
    const m = this.loadImage(d.file, d.module, d.meta, name);
    if (m && this.onDllLoad) this.onDllLoad(name, m);   // (a module watched as it comes: a shared session's intents, ne16.js)
    if (m && this.onModuleLoad) this.onModuleLoad(name, m);   // (a watch asked for before the module came: worker.js cmd 'watch')
    return m;
  }
  /** the DLL `name` from the folder of process `pc`'s program, when another file of that name is the one loaded:
   *  mapped as that process's own (pc.ownDlls), the loaded one left every other process's. IE4SETUP.EXE (an IExpress
   *  package, OSR 2.5's first start) loads SYSTEM's ADVPACK.DLL, and starts IE4WZD.EXE from the folder it extracted
   *  its own newer ADVPACK.DLL to; given SYSTEM's, IE4WZD's INSENG.DLL called its missing RegInstall and faulted.
   *  null: none of its own */
  ownCopy(pc, name) {
    const had = this.byName.get(name), path = String(pc.path || '');
    if (!had || !had.meta || !had.meta.path || !this.fs || API[name] || STAND_IN.has(name) || !/\\/.test(path) || (pc.ownLoading && pc.ownLoading.has(name))) return null;
    const none = pc.notOwn || (pc.notOwn = new Map()); if (none.get(name) === had) return null;   // (asked once per module loaded)
    // (the file this process's loader finds first: its program's folder, SYSTEM, the Windows folder. Another file than
    // the one loaded, or the same path written over since (IE4WZD copies its ADVPACK.DLL over SYSTEM's while the old
    // one is loaded), is this process's own, as a new process maps the file as it is now: given the old module,
    // LANGCHK.EXE called ADVPACK!GetVersionFromFile, which it lacks, and faulted)
    const leaf = /\./.test(name) ? name : name + '.DLL', no = () => { none.set(name, had); return null; };
    let f = null, dir = null;
    for (const d of [path.replace(/\\[^\\]*$/, ''), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS']) { try { f = this.fs.readFile(d + '\\' + leaf); dir = d; break; } catch (_) { /* not there */ } }
    if (!f) return no();
    const cur = this.dlls.get(name); if (!cur || !cur.file || sameBytes(f, cur.file)) return no();
    const was = this.loadDirs; let m = null;
    (pc.ownLoading || (pc.ownLoading = new Set())).add(name);
    try {
      this.loadDirs = [dir]; this.dlls.delete(name);
      const d = this.diskDll(name); if (d) m = this.loadImage(d.file, d.module, d.meta, name);
    } finally { this.loadDirs = was; this.dlls.set(name, cur); this.byName.set(name, had); pc.ownLoading.delete(name); }
    if (m) (pc.ownDlls || (pc.ownDlls = new Map())).set(name, m);
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
    for (const s of this.standins || []) out.push([s.base, s.base + s.size]);
    return out;
  }
  /** room for an image of `size` bytes in the arena below the heap (400000h-2000000h): at `pref` when nothing is there,
   *  else, for one that can be relocated, the first 64 KiB boundary with room; 0 when there is none. A program's own
   *  image (`own`) goes over other programs' images: each process has its own view of that range (arenaClaim).
   *  A relocated DLL is placed clear of the programs' two bases: 400000h (the scan starts above it) and 1000000h, where
   *  35 of Windows 98's programs are linked with no relocations, the largest 5F000h (DXDIAG). Relocated next to
   *  MSHTA's image there, MSVCRT left PSTORES no room, and its start failed (ERROR_BAD_EXE_FORMAT) */
  /** the address ranges the bundle's 16-bit modules load at (their segments' fixed bases), loaded or not */
  bundleSpans16() {
    const all = (window.W95SYSTEM && window.W95SYSTEM.ne) || {};
    if (this.neSpans && this.neSpans.of === all) return this.neSpans.spans;
    const spans = [];
    for (const s of Object.values(all)) for (const g of (s.meta && s.meta.segs) || []) spans.push([g.base, g.base + Math.max(g.alloc || 0, g.len || 0, 1)]);
    // (and every VxD of the bundle's, loaded or not: each loads at its build's base (vmm.js vxd), its pages ring 0's.
    // MSIDLE.DLL mapped over SPOOLER.VXD's at 14C0000h read its own data as a protected page, and MSGSRV32 faulted)
    for (const d of Object.values((window.W95SYSTEM && window.W95SYSTEM.vxds) || {})) if (d && d.meta && d.meta.base) spans.push([d.meta.base, d.meta.base + Math.max(d.meta.size || 0, 0x1000)]);
    this.neSpans = { of: all, spans }; return spans;
  }
  /** room for a block table of `size` bytes among the modules' (LAYOUT.TABLES to TABLES_END): at `pref` when nothing
   *  is there (the memo's place for this file, dyn.js neMemo), else the first 4 KiB boundary with room. Taken: every
   *  module of the bundle's, loaded or not (each loads with its build's table, at its build's place), and every module
   *  loaded here. None left is the machine's error, as running out of selectors is */
  tableRoom(size, pref = 0) {
    const S = window.W95SYSTEM || {}, taken = [];
    const span = t => { if (t && t.lookup && t.textHi > t.textLo) taken.push([t.lookup, t.lookup + 4 * (t.textHi - t.textLo)]); };
    for (const grp of [S.ne, S.dlls, S.programs, S.net, S.vxds, (window.W95SAVERS || {}).dlls]) for (const d of Object.values(grp || {})) span(d.meta);
    for (const m of this.modules) span(m.netText ? { lookup: m.meta.lookup, textLo: m.netText[0], textHi: m.netText[1] } : m.meta);   // (one whose module is being read from the memo: its table taken too)
    const free = a => a >= LAYOUT.TABLES && a + size <= LAYOUT.TABLES_END && !taken.some(([lo, hi]) => a < hi && lo < a + size);
    if (free(pref)) return pref;
    // (the memo's tables for modules not loaded here kept clear while there is room elsewhere in the arena, as vmRoom
    // keeps their images clear: each module's table where its translation was made)
    { const all = [...taken, ...this.memoSpans()].sort((x, y) => x[0] - y[0]); let b = LAYOUT.TABLES;
      for (const [lo, hi] of all) { if (b + size > LAYOUT.TABLES_END) break; if (b + size <= lo) return b; if (hi > b) b = (hi + 0xfff) & ~0xfff; }
      if (b + size <= LAYOUT.TABLES_END) return b; }
    taken.sort((x, y) => x[0] - y[0]);
    let a = LAYOUT.TABLES;
    // (a gap between tables inside the tables' arena only: the tables placed above the layout, vmRoom's, have DLLs'
    // images and VirtualAlloc's regions between them, and a table put in such a gap wrote its block numbers over them
    // (VCACHE's 30 MB reservation, URLMON's and MSIDLE's code: MSIDLE's mouse hook ran zeros, a fatal exception 0E)
    for (const [lo, hi] of taken) { if (a + size > LAYOUT.TABLES_END) break; if (a + size <= lo) return a; if (hi > a) a = (hi + 0xfff) & ~0xfff; }
    if (free(a)) return a;
    // (the tables' arena full, Windows 98's large DLLs (SHELL32, OLE32, MSHTML) translated as they load with the bundle's
    // tables in place: a table where VirtualAlloc's regions are, given as the module's own to it, its base the module's
    // to read, vmRoom; Explorer's start found no room for 7D1F20h bytes)
    const v = this.vmRoom(size, 0x1000); if (v) return v;
    throw new GuestError(`no room for a block table of ${u32(size).toString(16)}h bytes`);
  }
  /** whether [a, a+size) reaches into the room kept for programs' images (400000h to EXE_ZONE_END) */
  inExeZone(a, size) { return a < EXE_ZONE_END && a + size > 0x400000; }
  imageRoom(pref, size, relocatable, own = false) {
    // (and every 16-bit module of the bundle's, loaded or not: each loads at its build's fixed base (loadNE), over
    // whatever is there. WINSPOOL.DRV, placed at BA0000h before MMTASK, had MMTASK's image written over it, and
    // RUNDLL32 faulted in its start)
    const spans = [...(own ? this.moduleSpans(m => m.name !== 'EXE') : this.moduleSpans()), ...this.bundleSpans16()], free =a => a >= 0x400000 && a + size <= 0x02000000 && !spans.some(([lo, hi]) => a < hi && lo < a + size);
    // (a module that can go anywhere goes clear of the programs' own images, 400000h up to EXE_ZONE_END, as Windows maps
    // a DLL at its own base far from them: DLLs placed from 620000h up filled the room a program with no relocations
    // needs at 400000h, and the CD Sampler's Pinball, 4.6 MB, had "no room for its image" (KERNEL32's stand-in at
    // 620000h, OLEAUT32 and COMDLG32.OCX of the Sampler that started it). Into it only when there is no other room)
    // (and clear of 1000000h, where programs linked for Windows 95 are based (Welcome, MSAGENT.EXE's IExpress package):
    // SIGRES.EXE, which RSABASE loads for its signature on OSR 2.5's first start, is linked there too, relocatable, and
    // at its base it left each such program "no room for its image", "not a valid Win32 application")
    const PROGRAMS = [0x01000000, 0x01100000], programs = a => !own && a < PROGRAMS[1] && PROGRAMS[0] < a + size;
    const zone = a => !own && relocatable && (this.inExeZone(a, size) || programs(a));
    if (free(pref) && !zone(pref)) return pref;
    const from = own ? 0x00620000 : EXE_ZONE_END;
    // (clear of the memo's places for modules not loaded here first, as vmRoom keeps clear of them)
    if (relocatable) { const memo = this.memoSpans(), kept = a => !memo.some(([lo, hi]) => a < hi && lo < a + size); for (let a = from; a + size <= 0x02000000; a += 0x10000) if (free(a) && !programs(a) && kept(a)) return a; }
    if (relocatable) for (let a = from; a + size <= 0x02000000; a += 0x10000) if (free(a) && !programs(a)) return a;
    // (the arena full: a relocatable DLL in the address space above the layout's, where VirtualAlloc's regions are, as
    // Windows maps a DLL wherever its process has room. Windows 98's first start maps more DLLs than the arena holds,
    // and IEPEERS.DLL and OCCACHE.DLL found no room)
    // (a program too, when it can be relocated: the OSR 2.5 CD's MSN251.EXE, an IExpress package of A8A000h bytes at
    // 1000000h, found no gap that size below 2000000h, and its start failed with "no room for its image")
    if (relocatable && this.vmTop) { const r = this.vmRoom(size, 0x10000, spans); if (r) return r; }
    if (relocatable && !own) for (let a = 0x00620000; a + size <= EXE_ZONE_END; a += 0x10000) if (free(a)) return a;
    return 0;
  }
  /** `size` bytes of the address space above the layout's, where VirtualAlloc's regions are, aligned to `align`, clear
   *  of `spans`: first the room ended processes gave back (endProcess: their VirtualAlloc regions, vspare), then the
   *  top's. Taken only from the top, that space ran out after Windows 98's first start had run REGSVR32 a few dozen
   *  times, and WMI.DLL and DEVMGR32.DLL found none: RUNDLL's "Error loading devmgr32.dll", error 126. 0: none */
  /** room [b, b+n) handed out above the layout checked against what is there: a module's image or block table named
   *  with the allocation's stack (an error once each) */
  vmCheck(b, n, what) {
    if (!b) return b;
    for (const m of this.modules || []) {
      const t = m.meta, spans = [[m.base, m.base + (m.size || 0), 'image'], t && t.lookup ? [t.lookup, t.lookup + 4 * Math.max(0, (m.netText ? m.netText[1] - m.netText[0] : t.textHi - t.textLo)), 'table'] : null];
      for (const s of spans) if (s && s[1] > s[0] && b < s[1] && s[0] < b + n) {
        const k = `${what}:${m.name}:${s[2]}`; const seen = this.vmClash || (this.vmClash = new Set()); if (seen.has(k)) continue; seen.add(k);
        log('error', 'win32', `${what} at ${(b >>> 0).toString(16)}+${n.toString(16)} over ${m.name}'s ${s[2]} ${(s[0] >>> 0).toString(16)}-${(s[1] >>> 0).toString(16)}: ${(new Error().stack || '').split('\n').slice(2, 8).map(x => x.trim()).join(' < ')}`);
      }
    }
    return b;
  }
  /** the address space above the layout as its allocators keep it, checked after `what`: each spare piece, region, big
   *  block, image and block table apart from the others and below the top (the first overlap logged with its stack) */
  vmAudit(what) {
    if (this.vmAudited || !this.vmTop) return;
    const all = [];
    for (const s of this.vspare || []) all.push([s.base, s.base + s.size, 'spare']);
    for (const [b, r] of this.vregions || []) if (!r.heap) all.push([b, b + r.size, 'region']);
    for (const [b, n] of this.bigBlocks || []) all.push([b, b + n, 'big block']);
    for (const m of this.modules || []) {
      if (m.size && m.base >= this.vmLo) all.push([m.base, m.base + m.size, m.name + ' image']);
      const t = m.meta; if (t && t.lookup >= this.vmLo) all.push([t.lookup, t.lookup + 4 * Math.max(0, m.netText ? m.netText[1] - m.netText[0] : t.textHi - t.textLo), m.name + ' table']);
    }
    all.sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < all.length; i++) {
      const a = all[i], b = all[i + 1], h = v => (v >>> 0).toString(16);
      const bad = (b && b[0] < a[1]) ? `${a[2]} ${h(a[0])}-${h(a[1])} and ${b[2]} ${h(b[0])}-${h(b[1])}` : a[2] === 'spare' && a[1] > this.vmTop ? `spare ${h(a[0])}-${h(a[1])} past the top ${h(this.vmTop)}` : '';
      if (bad) { this.vmAudited = true; log('error', 'win32', `vm overlap after ${what}: ${bad}: ${(new Error().stack || '').split('\n').slice(2, 9).map(x => x.trim()).join(' < ')}`); return; }
    }
  }
  /** whether [0, end) is memory, the memory grown to it when it may (vmMax) */
  vmFit(end) {
    const have = this.mem.buffer.byteLength;
    if (end <= have) return true;
    if (end > (this.vmMax || have)) return false;
    this.mem.grow(Math.ceil((end - have) / 0x10000)); return true;
  }
  vmRoom(size, align, spans = []) {
    if (!this.vmTop) return 0;
    // (clear of the places the memo has for modules not loaded here (memoSpans) while there is room elsewhere: a DLL
    // put where its translation was made runs the memo's module; put elsewhere, translated again, whole, in the step)
    return this.vmRoomClear(size, align, [...spans, ...this.memoSpans()], true) || this.vmRoomClear(size, align, spans, false);
  }
  /** `topClear`: the top's room checked against `spans` too (the first pass, the memo's places); the last pass takes the
   *  top as it is, as it always has (checked there, a module mapped above the top refused every allocation from it, and
   *  MPREXE could not load IENPSTUB.DLL, error 126) */
  vmRoomClear(size, align, spans, topClear) {
    const n = (size + align - 1) & -align, spare = this.vspare || (this.vspare = []);
    const hit = a => spans.find(([lo, hi]) => a < hi && lo < a + n);
    for (let i = 0; i < spare.length; i++) {
      const s = spare[i], end = s.base + s.size;
      let a = (s.base + align - 1) & -align, h;
      while (a + n <= end && (h = hit(a))) a = (h[1] + align - 1) & -align;
      if (a + n > end) continue;
      spare.splice(i, 1);
      if (a > s.base) spare.push({ base: s.base, size: a - s.base });
      if (a + n < end) spare.push({ base: a + n, size: end - a - n });
      this.u8.fill(0, a, a + n); return this.vmCheck(a, n, 'room from the spare');
    }
    // (from the top only where it is clear: the top is not moved on past what it must keep clear of. Moved past the
    // memo's places, which lie across the whole space from runs before, a few allocations took the space up, and
    // MSJET40's block table found no room)
    const b = (this.vmTop + align - 1) & -align;
    if ((topClear && hit(b)) || !this.vmFit(b + n)) return 0;
    this.vmTop = b + n; return this.vmCheck(b, n, 'room from the top');
  }
  /** the room [b, b+size) above the layout taken where it is, when it is free (a spare piece holds it, or it is past the
   *  top) and clear of `spans`: the memo's place for a module (vmRoom's pieces otherwise). 0 when it is not */
  vmTake(b, size, spans = []) {
    if (!this.vmTop || !this.vmLo || b < this.vmLo || b % 0x1000) return 0;
    const n = (size + 0xfff) & ~0xfff, end = b + n, spare = this.vspare || (this.vspare = []);
    if (spans.some(([lo, hi]) => b < hi && lo < end) || !this.vmFit(end)) return 0;
    // (past the top, however far: the space between stays to hand as a spare piece, which vmRoom takes from before the
    // top. Refused when more than a megabyte past it, a DLL loaded late had its place only when the allocations before
    // it happened to end there: MSHTML and URLMON, loaded as the first folder window opens, were translated again
    // whole at every start, 74 MB of code, and that window took most of a minute to fill)
    if (b >= this.vmTop) {
      if (b > this.vmTop) spare.push({ base: this.vmTop, size: b - this.vmTop });
      this.vmTop = end; this.u8.fill(0, b, end); return this.vmCheck(b, n, 'the memo\'s place, from the top');
    }
    const i = spare.findIndex(s => s.base <= b && end <= s.base + s.size); if (i < 0) return 0;
    const s = spare.splice(i, 1)[0];
    if (b > s.base) spare.push({ base: s.base, size: b - s.base });
    if (end < s.base + s.size) spare.push({ base: end, size: s.base + s.size - end });
    this.u8.fill(0, b, end); return this.vmCheck(b, n, 'the memo\'s place, from the spare');
  }
  /** the places the memo (dyn.js) has for the modules it holds and this machine has not loaded: each one's image (its
   *  code span for a record from before images were kept) and its block table. Read again as the memo grows */
  memoSpans() {
    const memo = window.W95Dyn && window.W95Dyn.memo; if (!memo || !memo.size) return [];
    const loaded = new Set((this.modules || []).map(m => m && m.sha256).filter(Boolean));
    for (const m of this.ne ? this.ne.values() : []) if (m && m.sha256) loaded.add(m.sha256);
    const key = `${memo.size}:${loaded.size}`;
    if (this.memoSpanKey === key) return this.memoSpanList;
    const out = [];
    for (const r of memo.values()) {
      if (!r || loaded.has(r.sha) || !(r.textHi > r.textLo)) continue;
      out.push(r.imageHi > r.imageLo ? [r.imageLo, r.imageHi] : [r.textLo, r.textHi]);
      if (r.lookup) out.push([r.lookup, r.lookup + 4 * (r.textHi - r.textLo)]);
    }
    this.memoSpanKey = key; this.memoSpanList = out;
    return out;
  }
  /** a DLL an image imports or LoadLibrary names that the system bundle does not carry, from its file, as Windows'
   *  loader finds it: the program's folder, SYSTEM, the Windows folder. Mapped where there is room, its code translated
   *  as it runs (dyn.js); null when there is no such file or it is no Win32 DLL. (Bound to no DLL, Paint's imports of
   *  MFC30.DLL were dead thunks: the first call faulted, and its handling ran garbage until the machine stopped) */
  diskDll(name, replacing = false) {
    // (one this system implements, the personality's KERNEL32, ADVAPI32, ...: that one, never its file; unless the file
    // replaces the bundle's own translation of it, replacing)
    // (a long name may have spaces: the Plus! savers' engines, "Inside your Computer.dll", were never found)
    if (!this.fs || (API[name] && !replacing) || STAND_IN.has(name) || !/^[A-Z0-9_$~!#%&'()@^`{}][A-Z0-9_$~!#%&'()@^`{} -]*(\.[A-Z0-9]+)?$/i.test(name)) return null;
    const file = /\./.test(name) ? name : name + '.DLL';
    const dirs = [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS'];
    let f = null, path = null;
    for (const d of dirs) { try { f = this.fs.readFile(d + '\\' + file); path = d + '\\' + file; break; } catch (_) { /* not there */ } }
    if (!f || f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return null;
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength), pe = dv.getUint32(0x3c, true);
    // (a Win32 image: a DLL, or a program LoadLibrary names, which Windows 95 maps as a module whose entry point it never
    // calls, for its resources: RSABASE's DllRegisterServer loads SIGRES.EXE for its signature, and with no program
    // taken said "CAPI: The install program could not open signature file", on Windows 95 OSR 2.5's first start)
    if (pe + 0xf8 > f.length || dv.getUint32(pe, true) !== 0x4550) return null;
    const isDll = !!(dv.getUint16(pe + 22, true) & 0x2000);   // (IMAGE_FILE_DLL)
    if (!isDll && !/\.EXE$/i.test(file)) return null;
    const opt = pe + 24, pref = dv.getUint32(opt + 28, true), size = dv.getUint32(opt + 56, true), ep = dv.getUint32(opt + 16, true);
    const relocatable = !(dv.getUint16(pe + 22, true) & 1) && dv.getUint32(opt + 96 + 5 * 8 + 4, true) > 0;
    // (where the memo's translation of this file was made, first: the module put there runs the memo's module, not one
    // translated again, whole, as it loads (dyn.js neCompile). Its image's base, or its code's less the code's offset)
    let memoBase = 0;
    if (relocatable && window.W95Dyn && window.W95Dyn.memo.size) {
      const had = window.W95Dyn.memo.get(sha256(f));
      if (had && had.imageLo) memoBase = had.imageLo;
      else if (had && had.textLo) {
        const nsec = dv.getUint16(pe + 6, true), shdr = opt + dv.getUint16(pe + 20, true); let lo = Infinity;
        for (let i = 0; i < nsec; i++) { const o = shdr + 40 * i, ch = dv.getUint32(o + 36, true), vs = dv.getUint32(o + 8, true) || dv.getUint32(o + 16, true); if ((ch & 0x20000020) && vs) lo = Math.min(lo, dv.getUint32(o + 12, true)); }
        if (lo < Infinity) memoBase = had.textLo - lo;
      }
    }
    let base = (memoBase && memoBase !== pref && !this.inExeZone(memoBase, size) && (this.imageRoom(memoBase, size, false) || this.vmTake(memoBase, size, this.moduleSpans()))) || this.imageRoom(pref, size, relocatable);
    // (one with no relocations based past the machine's memory, where it can never be: put where there is room, its
    // addresses of itself found in its image, loadImage synthRelocs. The Plus! saver engine "Inside your Computer.dll"
    // is linked at 7C980000h with none, and the theme's screen saver showed nothing)
    const synth = !base && !relocatable && u32(pref) + size > this.mem.buffer.byteLength;
    if (synth) base = this.imageRoom(0, size, true);
    if (!base) { log('warn', 'win32', `${file}: no room for its image at ${pref.toString(16)}`); return null; }
    // (the file it was mapped from: GetModuleFileName's answer, TRIEDIT's own type library found beside it)
    const d = { file: f, module: null, meta: { base, entry: ep && isDll ? base + ep : 0, textLo: 0, textHi: 0, blocks: [], size, dynamic: true, path, ...(synth ? { synthRelocs: true } : {}) } };
    this.dlls.set(name, d);
    return d;
  }
  /** a module handle as the running process sees it: its program at the base the program's header prefers (where
   *  every Windows 95 process has its own, in its private arena), which here may be elsewhere in the shared space */
  hmod(h) { const e = this.exe; return e && e.pref && h === e.pref && e.base !== e.pref ? e.base : h; }
  /** the module handle of a DLL implemented here (OPENGL32), one per name: LoadLibrary's and GetModuleHandle's */
  jsDll(name) {
    const m = this.jsDlls || (this.jsDlls = new Map());
    if (!m.has(name)) m.set(name, this.standinImage(name) || 0x10000000 | (this.newHandle({ kind: 'module', name }) & 0xffff));
    return m.get(name);
  }
  /** the module handle of a stand-in whose file is on the disk (Windows 98's KERNEL32.DLL): its headers mapped at a
   *  base of their own in the arena, as the loader maps the DLL, the rest of its room kept. A program reads a module's
   *  header through its handle: MSVCRT's __heap_select reads the EXE module's linker version from it, and in the
   *  system's process that module is KERNEL32 (GetModuleHandleA). 0 when the file is not there */
  standinImage(name) {
    if (!this.fs || !/^[A-Z0-9_$~!#%&'()@^`{}-]+(\.[A-Z0-9]+)?$/i.test(name)) return 0;
    const file = /\./.test(name) ? name : name + '.DLL';
    let f = null, path = null;
    for (const d of ['C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS']) { try { f = this.fs.readFile(d + '\\' + file); path = d + '\\' + file; break; } catch (_) { /* not there */ } }
    if (!f || f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return 0;
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength), pe = dv.getUint32(0x3c, true);
    if (pe + 0xf8 > f.length || dv.getUint32(pe, true) !== 0x4550) return 0;
    const opt = pe + 24, pref = dv.getUint32(opt + 28, true), size = dv.getUint32(opt + 56, true), hdr = Math.min(dv.getUint32(opt + 60, true), f.length, size);
    const base = this.imageRoom(pref, size, true);
    if (!base) return 0;
    this.u8.set(f.subarray(0, hdr), base);
    (this.standins || (this.standins = [])).push({ name, base, size, path });
    return base;
  }
  standinAt(h) { return (this.standins || []).find(s => s.base === h) || null; }
  /** a module's export by name or '#ordinal', a forwarder followed to the module it names (its stand-in's thunk where
   *  that is one); 0 for none */
  exportOf(m, nm, hops = 0) {
    const a = m.exports.get(nm); if (a) return a;
    const f = m.forwards && m.forwards.get(nm); if (!f || hops > 8) return 0;
    const dot = f.indexOf('.'), dll = f.slice(0, dot).toUpperCase().replace(/\.DLL$/, ''), s = f.slice(dot + 1);
    const key = s[0] === '#' ? '#' + parseInt(s.slice(1), 10) : s, t = this.loadDll(dll);
    const r = t ? this.exportOf(t, key, hops + 1) : API[dll] && this.importDef(dll, key) ? this.thunkFor(dll, key) : 0;
    if (r) m.exports.set(nm, r);
    return r;
  }
  /** a Win32 file mapped as data (LoadLibraryEx's LOAD_LIBRARY_AS_DATAFILE): the section holding its resources copied
   *  into the heap, at the address its RVAs are read from; the module handle, or 0 for a file with no resources */
  dataModule(file, path) {
    const dv = new DataView(file.buffer, file.byteOffset, file.byteLength), pe = dv.getUint32(0x3c, true);
    const nsec = dv.getUint16(pe + 6, true), opt = pe + 24, optSize = dv.getUint16(pe + 20, true), magic = dv.getUint16(opt, true);
    const dirs = opt + (magic === 0x20b ? 112 : 96), rsrc = dirs + 16 + 8 <= file.length ? dv.getUint32(dirs + 16, true) : 0;
    let sec = null;
    for (let i = 0; i < nsec; i++) {
      const o = opt + optSize + 40 * i, va = dv.getUint32(o + 12, true), vs = dv.getUint32(o + 8, true), raw = dv.getUint32(o + 16, true), rp = dv.getUint32(o + 20, true);
      if (rsrc >= va && rsrc < va + Math.max(vs, raw)) { sec = { va, size: Math.max(vs, raw), raw, rp }; break; }
    }
    if (!rsrc || !sec) { this.lastError = 1812; return 0; }   // ERROR_RESOURCE_DATA_NOT_FOUND
    const block = this.alloc(sec.size); this.u8.set(file.subarray(sec.rp, sec.rp + Math.min(sec.raw, sec.size, file.length - sec.rp)), block);
    const base = u32(block - sec.va), name = String(path).replace(/^.*\\/, '').toUpperCase().replace(/\.DLL$/, '');
    (this.dataMods || (this.dataMods = new Map())).set(base, { name, base, rsrc, block, path, data: true, exports: new Map() });
    this.lastError = 0;
    return base;
  }
  moduleFor(h) { h = this.hmod(h); const dm = this.dataMods && this.dataMods.get(u32(h)); if (dm) return dm; const e = this.exe; return e && e.base === h ? e : this.modules.find(m => m.base === h && !m.hidden) || e; }   // (the running process's own program first: another's may be at its base, arenaClaim)
  thunkFor(dll, nm) {
    const key = dll + '!' + nm;
    if (this.thunkByName.has(key)) return this.thunkByName.get(key);
    const def = this.importDef(dll, nm);
    const t = LAYOUT.THUNK + this.thunks.length * 4;
    this.thunks.push({ dll, nm, def }); this.thunkByName.set(key, t);
    return t;
  }
  /** what a call to `dll`!`nm` does: its definition here, else what the DLL's own file does when that is the system's
   *  common stub for a call it leaves unimplemented. (Windows 98's SETUPAPI imports ADVAPI32's IsTextUnicode, which
   *  Windows 98's ADVAPI32 exports as that stub and this ADVAPI32 lacked: a dead thunk, and Explorer's first start
   *  faulted in it) */
  importDef(dll, nm) { return (API[dll] || {})[nm] || this.byOrdinal(dll, nm) || this.unimpStub(dll, nm) || undefined; }
  /** an import by number of a call defined here by name: the name `dll`'s own file gives that ordinal (Windows 98's
   *  ICWCONN1 reaches KERNEL32's QT_Thunk as #561, and ended in a dead thunk). Its definition, or null */
  byOrdinal(dll, nm) {
    if (nm[0] !== '#' || !this.fs || !API[dll]) return null;
    const names = this.ordNames32 || (this.ordNames32 = new Map());
    if (!names.has(dll)) {
      const map = new Map(); names.set(dll, map);
      const file = /\./.test(dll) ? dll : dll + '.DLL'; let f = null;
      for (const d of [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS']) { try { f = this.fs.readFile(d + '\\' + file); break; } catch (_) { /* not there */ } }
      if (f && f.length > 0x40 && f[0] === 0x4d && f[1] === 0x5a) {
        const dv = new DataView(f.buffer, f.byteOffset, f.byteLength), pe = dv.getUint32(0x3c, true);
        if (pe + 0xf8 <= f.length && dv.getUint32(pe, true) === 0x4550) {
          const opt = pe + 24, nsec = dv.getUint16(pe + 6, true), sh = opt + dv.getUint16(pe + 20, true);
          const off = r => { for (let i = 0; i < nsec; i++) { const s = sh + 40 * i, va = dv.getUint32(s + 12, true), n = Math.max(dv.getUint32(s + 8, true), dv.getUint32(s + 16, true)); if (r >= va && r < va + n) { const o = dv.getUint32(s + 20, true) + r - va; return o < f.length ? o : -1; } } return -1; };
          const str = o => { let s = ''; while (o >= 0 && o < f.length && f[o]) s += String.fromCharCode(f[o++]); return s; };
          const ex = off(dv.getUint32(opt + 96, true));
          if (ex >= 0) {
            const obase = dv.getUint32(ex + 16, true), nn = dv.getUint32(ex + 24, true), na = off(dv.getUint32(ex + 32, true)), oa = off(dv.getUint32(ex + 36, true));
            if (na >= 0 && oa >= 0) for (let i = 0; i < nn; i++) map.set(dv.getUint16(oa + 2 * i, true) + obase, str(off(dv.getUint32(na + 4 * i, true))));
          }
        }
      }
    }
    const name = names.get(dll).get(+nm.slice(1));
    return (name && API[dll][name]) || null;
  }
  /** an export of `dll`'s file that is `xor eax,eax; mov cl,N; jmp KERNEL32!#17` (directly or through a jump):
   *  KERNEL32's CommonUnimpStub, which sets ERROR_CALL_NOT_IMPLEMENTED, returns by N's high nibble (1: 1, 13: 50,
   *  14: 120, 15: -1, else 0) and pops N's low nibble of arguments. Its definition, or null */
  unimpStub(dll, nm) {
    if (!this.fs || !API[dll]) return null;
    const file = /\./.test(dll) ? dll : dll + '.DLL'; let f = null;
    for (const d of [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS']) { try { f = this.fs.readFile(d + '\\' + file); break; } catch (_) { /* not there */ } }
    if (!f || f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return null;
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength), pe = dv.getUint32(0x3c, true);
    if (pe + 0xf8 > f.length || dv.getUint32(pe, true) !== 0x4550) return null;
    const opt = pe + 24, nsec = dv.getUint16(pe + 6, true), sh = opt + dv.getUint16(pe + 20, true), base = dv.getUint32(opt + 28, true);
    const off = r => { for (let i = 0; i < nsec; i++) { const s = sh + 40 * i, va = dv.getUint32(s + 12, true), n = Math.max(dv.getUint32(s + 8, true), dv.getUint32(s + 16, true)); if (r >= va && r < va + n) { const o = dv.getUint32(s + 20, true) + r - va; return o < f.length ? o : -1; } } return -1; };
    const str = o => { let s = ''; while (o >= 0 && o < f.length && f[o]) s += String.fromCharCode(f[o++]); return s; };
    const ex = off(dv.getUint32(opt + 96, true)); if (ex < 0) return null;
    const obase = dv.getUint32(ex + 16, true), nf = dv.getUint32(ex + 20, true), nn = dv.getUint32(ex + 24, true), fa = off(dv.getUint32(ex + 28, true)), na = off(dv.getUint32(ex + 32, true)), oa = off(dv.getUint32(ex + 36, true));
    let k = -1;
    if (nm[0] === '#') k = +nm.slice(1) - obase;
    else for (let i = 0; i < nn; i++) if (str(off(dv.getUint32(na + 4 * i, true))) === nm) { k = dv.getUint16(oa + 2 * i, true); break; }
    if (k < 0 || k >= nf) return null;
    let rva = dv.getUint32(fa + 4 * k, true), c = off(rva);
    if (c < 0 || c + 9 > f.length || f[c] !== 0x33 || f[c + 1] !== 0xc0 || f[c + 2] !== 0xb1) return null;
    const cl = f[c + 3]; rva += 4; c += 4;
    if (f[c] === 0xe9) { rva = (rva + 5 + dv.getInt32(c + 1, true)) >>> 0; c = off(rva); }
    else if (f[c] === 0xeb) { rva = (rva + 2 + dv.getInt8(c + 1)) >>> 0; c = off(rva); }
    // (KERNEL32's own: straight to its #17, no import between: Windows 98's GetVersionExW, LoadLibraryW, ...)
    const def = () => { const ret = { 1: 1, 13: 50, 14: 120, 15: 0xffffffff }[cl >> 4] || 0; return [cl & 15, function () { this.lastError = 120; return ret; }]; };
    if (/^KERNEL32(\.DLL)?$/i.test(dll) && 17 - obase >= 0 && 17 - obase < nf && rva === dv.getUint32(fa + 4 * (17 - obase), true)) return def();
    if (c < 0 || c + 6 > f.length || f[c] !== 0xff || f[c + 1] !== 0x25) return null;
    const slot = (dv.getUint32(c + 2, true) - base) >>> 0;   // (the IAT entry it jumps through: KERNEL32's #17)
    for (let d = off(dv.getUint32(opt + 104, true)); d >= 0 && d + 20 <= f.length && dv.getUint32(d + 12, true); d += 20) {
      const iat = dv.getUint32(d + 16, true), lut = off(dv.getUint32(d, true) || iat);
      if (slot < iat || (slot - iat) & 3 || !/^KERNEL32(\.DLL)?$/i.test(str(off(dv.getUint32(d + 12, true))))) continue;
      const v = lut < 0 ? 0 : dv.getUint32(lut + slot - iat, true);
      if (v !== (0x80000000 | 17) >>> 0) return null;
      return def();
    }
    return null;
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
  /** the DLLs loaded since the last run, each after the DLLs it imports: one of those may have been loaded long ago by
   *  another process, and this process attaches to it before the new DLL's DllMain calls it. The new ones alone, ahead
   *  of what they import: a DLL REGSVR32 loaded ran its DllMain with OLEAUT32 not yet this process's (another's slot
   *  index in its data), its SysAllocString set the thread's block there, OLE32's CoSetState loaded OLEAUT32, whose
   *  DllMain then ran and took a new index, and SysAllocString read the thread's block at 0 */
  pendingInits() {
    const pending = this.inits, out = [], seen = new Set(); this.inits = [];
    for (const m of pending) this.importClosure(m, out, seen);
    return out;
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
    const entry = this.attachPrep(m); if (!entry) return;
    this.call(entry, [m.base, 1, 0]);
    this.attachOle(m);
  }
  /** SHELL32 told OLE is there once its DllMain has run (SHLoadOLE #151) */
  attachOle(m) {
    const ole = m.name === 'SHELL32' && m.exports.get('#151');
    if (ole) { this.shellNotifyList(m); this.call(ole, [2]); }
  }
  /** the DllMains of `mods` run by the thread itself as LoadLibrary returns to it, not as a call the host makes: the
   *  thread can give up the processor in one, as in any code of its own. Made inside a call the host made, a DllMain
   *  that waited on another thread waited for good, nothing else running meanwhile (Windows 98's first start: RUNONCE's
   *  LoadLibrary of a DLL whose DllMain loaded another, whose DllMain sent to a window of another thread, USER's
   *  wait for the reply at 3:1626 run on, and the machine answered nothing). The frame on the guest's stack, from ESP
   *  up: how many, the next one's index, their bases, LoadLibrary's answer, the caller's return address */
  dllChainStart(mods, ret, top, result) {
    const k = mods.length, f = u32(top - 4 * (k + 4));
    this.w32(f, k); this.w32(f + 4, 0); mods.forEach((m, i) => this.w32(f + 8 + 4 * i, m.base));
    this.w32(f + 8 + 4 * k, result); this.w32(f + 12 + 4 * k, ret);
    this.reg('esp', f); this.hookDllChain();
    return DLL_CHAIN;
  }
  /** the chain's address hooked (again after a travel, whose hooks are the moment's: worker.js) */
  hookDllChain() {
    const hooks = this.entryHooks || (this.entryHooks = new Map());
    if (!hooks.has(DLL_CHAIN)) hooks.set(DLL_CHAIN, function () { return this.dllChainStep(); });
    if (!hooks.has(SEH_CONT)) hooks.set(SEH_CONT, function () { return sehStep(this); });
  }
  dllChainStep() {
    const sp = u32(this.reg('esp')), k = this.r32(sp), i = this.r32(sp + 4);
    if (i > 0) { const prev = this.modules.find(x => x.base === this.r32(sp + 4 + 4 * i)); if (prev && prev.oleDue) { prev.oleDue = false; this.attachOle(prev); } }
    if (i < k) {
      this.w32(sp + 4, i + 1);
      const base = this.r32(sp + 8 + 4 * i), m = this.modules.find(x => x.base === base), entry = m && this.attachPrep(m);
      if (!entry) return DLL_CHAIN;
      if (m.name === 'SHELL32') m.oleDue = true;
      this.push(0); this.push(1); this.push(base); this.push(DLL_CHAIN);
      return entry;
    }
    this.reg('eax', this.r32(sp + 8 + 4 * k));
    const ret = this.r32(sp + 12 + 4 * k); this.reg('esp', sp + 16 + 4 * k);
    return ret;
  }
  /** the process marked attached to `m` and the DLL's data made its own: DllMain's address, 0 for none to run */
  attachPrep(m) {
    const pc = this.pc, done = pc.attached || (pc.attached = new Set());
    if (done.has(m) || !m.meta || m.clock) return 0;
    done.add(m);
    // (a DLL whose translation went with the last process that had it (dyn.js dynRelease): made again for this one)
    if (m.released && this.neCompile) {
      m.released = false;
      try { this.neCompile(m); } catch (e) { if (!(e instanceof GuestError)) throw e; log('warn', 'win32', `${m.name}: ${e.message}; its code runs as run-time code`); m.meta.textLo = m.meta.textHi = 0; m.run = null; }
    }
    // (its data as a new process gets it, a DLL of the private arena's: as loaded, the attached ones' put by)
    const v = m.priv;
    if (v && v.init) {
      this.dllInPlace = null;   // (the views in place changed here: dllUse walks the list again)
      if (v.cur === null) v.cur = pc;
      else if (v.cur !== pc) { if (v.cur !== GONE) v.bufs.set(v.cur, v.ranges.map(([lo, hi]) => this.u8.slice(lo, hi))); v.ranges.forEach(([lo], i) => this.u8.set(v.init[i], lo)); v.cur = pc; }
    }
    return m.meta.entry || 0;
  }
  /** the private-arena DLLs' data of process `pc` (the system's when null) in place, as the thread that runs is that
   *  process's (ne16.js imgUse) */
  dllUse(pc) {
    const key = pc || this.pc0 || (this.pc0 = { pid: 0x50 });
    // (the view in place already this process's, and no module come or gone since: nothing to walk. Walked at every
    // thread switch, the module list cost a tenth of a millisecond each, and Windows 98 Setup's copy, its Win16 tasks
    // taking turns thousands of times a second, spent more time here than in its own code)
    const mods = this.modules || [];
    if (this.dllInPlace === key && this.dllInPlaceN === mods.length) return;
    for (const m of mods) {
      const v = m.priv; if (!v || !v.init || v.cur === key || !v.bufs.has(key)) continue;
      if (v.cur !== GONE && v.cur !== null) v.bufs.set(v.cur, v.ranges.map(([lo, hi]) => this.u8.slice(lo, hi)));
      const mine = v.bufs.get(key); v.bufs.delete(key); v.ranges.forEach(([lo], i) => this.u8.set(mine[i], lo)); v.cur = key;
    }
    this.dllInPlace = key; this.dllInPlaceN = mods.length;
  }
  /** a process's end: its copies of the DLLs' data go */
  dllForget(pc) { this.dllInPlace = null; for (const m of this.modules || []) { const v = m.priv; if (!v) continue; v.bufs.delete(pc); if (v.cur === pc) v.cur = GONE; } }
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
    try { return this.dispatch(eip); } finally { if (this.callRun && this.callRun.level === this.runLevel) this.callRun = null; this.runLevel--; }
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
  /** the running thread's slice ends where it is: the dispatcher's next question gives the processor back, as when
   *  its time runs out (inside a call the host made it runs on) */
  endSlice() { if (this.sliceEnd === undefined) { this.sliceEnd = Math.max(1, this.cpu.budget.value); this.cpu.budget.value = 0; } }
  /** the dispatcher's question when the block budget runs out: 1 to give the processor back to the host here */
  tick(eip) {
    // (a slice ended before its time, endSlice: the blocks left are the next slice's, and no quantum went by)
    if (this.sliceEnd !== undefined) {
      this.cpu.budget.value = this.sliceEnd; this.sliceEnd = undefined;
      if (this.runLevel === this.yieldLevel && !this.noPreempt) { this.preempted = u32(eip); return 1; }
      return 0;
    }
    this.cpu.budget.value = BUDGET;
    const vc = this.host.vclock; if (vc) vc.now += vc.perTick;   // (the machine's own clock: a quantum per BUDGET blocks, whatever the host's speed; worker.js vclock)
    if (this.inputPoll && !this.inPoll) { this.inPoll = true; try { this.inputPoll(); } finally { this.inPoll = false; } }   // interrupts: the keyboard's and the mouse's
    // the sound card tended inside a long run too, every 10 ms of the wall's time, as its speakers play by the wall:
    // tended only between slices, a run that went on (a thread inside a call, a heavy first start) left its queue to run
    // dry and the sound stuttered under load
    if (this.sound16 && !this.inSound) { const w = performance.now(); if (w - (this.soundTended || 0) >= 10) { this.soundTended = w; this.sound16(); } }
    if (this.runLevel === this.yieldLevel && !this.noPreempt) {
      if (this.now() - this.runT0 < SLICE_MS) return 0;
      this.preempted = u32(eip); return 1;
    }
    // (inside a call the host made it cannot stop: it runs on. One that runs on 10 s is named once in the log, where it
    // is: nothing else runs meanwhile, and the machine answers nothing)
    const s = this.callRun;
    if (!s || s.level !== this.runLevel) this.callRun = { level: this.runLevel, t0: performance.now(), told: false };
    else if (!s.told && performance.now() - s.t0 > 10000) {
      s.told = true;
      log('warn', 'win32', `a call the host made runs on at ${this.whereOf(eip)} (${u32(eip).toString(16)}), thread ${this.thread16 ? this.thread16.id : 'main'}, level ${this.runLevel}/${this.yieldLevel}, depth ${this.depth}, ring 0 ${this.r0Depth || 0}; the host's way in: ${((Error.stackTraceLimit = Math.max(Error.stackTraceLimit || 10, 80)), new Error().stack || '').split('\n').slice(2).map(l => (l.match(/at (?:Process\.|P\.|Machine\.|Object\.)?([\w$.]+) /) || [])[1]).filter(n => n && !/^(tick|dynRun|dispatch|runAt|trap|raise)$/.test(n)).slice(0, 24).join(' < ')}`);
    }
    return 0;
  }
  /** no code at `at` the processor can run (nothing mapped there: #PF; an instruction run-time translation cannot
   *  take: #UD): the exception's continuation, or null for a stop of the emulator's own (trapped) */
  noCode(at) {
    const t = this.trapped || '';
    (this.faultLog || (this.faultLog = [])).push({ at: u32(at).toString(16), atIn: this.whereOf(at), why: t, esp: u32(this.cpu.esp.value).toString(16), from: u32(this.lastBlock || 0).toString(16), fromIn: this.whereOf(this.lastBlock || 0), path: this.entryRing ? [...Array(32).keys()].map(k => this.entryRing[(this.entryAt + k) & 31]).filter(Boolean).map(v => this.whereOf(v)) : [], stack: (() => { try { const ss = this.cpu.ss.value & 0xffff, sp = ss && ss !== LAYOUT.FLATDS ? (this.cpu.ssb.value >>> 0) + (this.cpu.esp.value & 0xffff) : u32(this.cpu.esp.value); return Array.from({ length: 8 }, (_, k) => this.r32(sp + 4 * k) >>> 0).map(v => { const w = this.whereOf(v), far = this.selValid && this.selValid(v >>> 16) ? this.whereOf(u32(this.selBase(v >>> 16) + (v & 0xffff))) : null; return `${v.toString(16)} ${far && !/^[0-9a-f]+$/.test(far) ? `(${far})` : w}`; }); } catch (_) { return []; } })(), cs: (this.cpu.cs.value & 0xffff).toString(16), ss: (this.cpu.ss.value & 0xffff).toString(16), thread: this.thread16 ? this.thread16.id : 'main' }); if (this.faultLog.length > 50) this.faultLog.shift();   // (a diagnostic: cmd 'faults')
    // (the way there in the log too, as it happens: a machine that ends of it, the system's machine at its start, leaves
    // no fault log to ask for)
    { const f = this.faultLog[this.faultLog.length - 1]; log('warn', 'win32', `no code at ${f.at} (${f.atIn}) (${f.why || 'unmapped'}) cs ${f.cs} ss ${f.ss} ${['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp'].map(r => `${r} ${u32(this.cpu[r].value).toString(16)}`).join(' ')} from ${f.fromIn || f.from}, esp ${f.esp}; the way there: ${f.path.slice(-16).join(' < ')}; stack ${(f.stack || []).slice(0, 8).join(' ')}`); }
    // (an emulator gap: named; the #UD at the instruction itself, not where the run of run-time code began: QUARTZ's MMX
    // probe (EMMS under its own handler, a 486 having none) was raised blocks earlier, and its handler did not take it)
    const ud = this.trappedAt; this.trappedAt = undefined;
    if (/^run-time code/.test(t)) { log('warn', 'win32', t); this.trapped = null; return this.raise(6, ud !== undefined ? ud : at); }
    if (t && !/^jump to unmapped address/.test(t)) return null;
    this.trapped = null; return this.raise(14, at, at);
  }
  // ---- diagnostics (worker.js cmd 'watch', 'memwatch', 'probe', 'faults'; docs/driving-the-machine/DEBUGGING.md)
  /** a linear address as a symbol: a thunk's import, a 16-bit module's segment:offset, or a 32-bit module's offset,
   *  with the nearest export at or before it (its name and the offset past it) when the module has one */
  whereOf(lin) {
    lin = u32(lin);
    const N = window.W95NE16, T16 = N && N.L.T16;
    if (this.t16r && lin >= this.t16r && lin < this.t16r + 0x10000) lin = u32(T16 + (lin - this.t16r));
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
    // (a program's image: the running thread's own process's first, named by its file, as programs' images share their
    // preferred base, each in its process's view: another's EXE there is not what this thread runs)
    const pc = this.thread16 && this.thread16.pc, own = pc && pc.exe;
    for (const m of own ? [own, ...(this.modules || []).filter(x => x !== own)] : this.modules || []) {
      if (!m.base || !m.size || lin < m.base || lin >= m.base + m.size) continue;
      const s = this.peSym(m, lin), name = m === own && pc.path ? pc.path.replace(/^.*\\/, '').toUpperCase() : m.name || '?';
      return `${name}+${(lin - m.base).toString(16)}${s ? ` (${s})` : ''}`;
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
  /** the host's hook at linear `at` (entryHooks: the dispatcher calls it as control arrives there). In a module
   *  translated as it loaded (dyn.js neCompile) the address keeps no block, so the module's own calls to it come to
   *  the dispatcher and the hook, as run-time code brought them */
  setEntryHook(at, fn) {
    at = u32(at); (this.entryHooks || (this.entryHooks = new Map())).set(at, fn);
    // (any module with a block table, a 16-bit one's too: dyn.js neSet fills each the same way. Only a program's and
    // a DLL's image were cleared, and in USER a breakpoint on CreateWindowEx saw none of USER's own calls to it)
    const dm = this.hookedModule(at);
    if (dm) this.w32(dm.meta.lookup + 4 * (at - dm.meta.textLo), 0);
  }
  /** the translated module whose block table holds `at` (neSet's: one entry an address of its text), or none */
  hookedModule(at) { return (this.modules || []).find(m => m && m.meta && m.meta.lookup && m.meta.textHi > m.meta.textLo && at >= m.meta.textLo && at < m.meta.textHi); }
  /** a hook gone from `at`: its block back in its module's table, where the module has one there (neSet's numbering) */
  unhookEntry(at) {
    const dm = this.hookedModule(at), bl = dm && dm.meta.blocks; if (!bl) return;
    const i = bl.indexOf(at); if (i >= 0) this.w32(dm.meta.lookup + 4 * (at - dm.meta.textLo), i + 1);
  }
  addEntryHook(at, fn) {
    at = u32(at);
    const hooks = this.entryHooks || (this.entryHooks = new Map()), lists = this.entryLists || (this.entryLists = new Map());
    let l = lists.get(at);
    if (!l) {
      l = { fns: [], was: hooks.get(at) || null }; lists.set(at, l);
      this.setEntryHook(at, function () { for (const f of l.fns.slice()) { const to = f.call(this); if (to !== undefined) return to; } return l.was ? l.was.call(this) : undefined; });
    }
    l.fns.push(fn);
    return () => { const i = l.fns.indexOf(fn); if (i >= 0) l.fns.splice(i, 1); if (!l.fns.length) { lists.delete(at); if (l.was) hooks.set(at, l.was); else { hooks.delete(at); this.unhookEntry(at); } } };
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
  memWatch(lo, len, own, max) {   // (own: a thread's id whose own writes are not recorded, for a watch on that thread's stack; max: the hits kept, 50)
    this.memW = lo == null ? null : { lo: u32(lo), len: len | 0, snap: this.u8.slice(u32(lo), u32(lo) + (len | 0)), hits: [], n: 0, own: own || null, max: max || 50 };
    return this.memW;
  }
  memCheck(by) {
    const w = this.memW, u8 = this.u8, s = w.snap, lo = w.lo, n = w.len; let i = 0;
    for (; i < n; i++) if (u8[lo + i] !== s[i]) break;
    if (i === n) return;
    let j = n - 1; while (j > i && u8[lo + j] === s[j]) j--;
    if (w.own && this.thread16 && this.thread16.id === w.own) { s.set(u8.subarray(lo, lo + n)); return; }
    w.n++;
    if (w.hits.length < w.max) w.hits.push({ at: (lo + i).toString(16), n: j - i + 1, was: Array.from(s.subarray(i, Math.min(j + 1, i + 16))), now: Array.from(u8.subarray(lo + i, Math.min(lo + j + 1, lo + i + 16))),
      by: by || this.whereOf(this.lastBlock || 0), thread: this.thread16 ? this.thread16.id : 'main', t: Math.round(this.now()),
      // (the return addresses on the stack then, as symbols: who the code that wrote was called by)
      stack: Array.from({ length: 48 }, (_, k) => this.r32(u32(this.cpu.esp.value) + 4 * k)).filter(v => this.modules.some(m => m.meta && v >= m.meta.textLo && v < m.meta.textHi)).map(v => this.whereOf(v)) });
    s.set(u8.subarray(lo, lo + n));
  }
  /** whether `eip` is a thunk's: the host's (at or above LAYOUT.THUNK16), or the 16-bit thunks' segment's own memory
   *  (t16r, ne16.js init16), which the dispatcher takes as the thunk at LAYOUT.THUNK16 */
  thunkAt(eip) { eip = u32(eip); return eip >= LAYOUT.THUNK16 || (!!this.t16r && eip >= this.t16r && eip < this.t16r + 0x10000); }
  dispatch(eip) {
    for (;;) {
      eip >>>= 0;
      if (eip >= LAYOUT.ARENA && eip < LAYOUT.THUNK16) eip -= LAYOUT.ARENA;
      if (eip === LAYOUT.SENTINEL) return 0;
      // (the 16-bit thunks' segment's own memory, reached through a CS its descriptor gave: the thunk, ne16.js init16)
      if (this.t16r && eip >= this.t16r && eip < this.t16r + 0x10000) eip = u32(LAYOUT.THUNK16 + (eip - this.t16r));
      if (this.runHook) this.runHook(eip);   // debugging: set from the page to watch every dispatch
      if (this.memW) this.memCheck();
      // (an export another module enters, watched: a shared session's intents, ne16.js hookIntents; a hook that answers
      // the call itself gives where it returns to: a program's clock, ne16.js hookClock)
      // (hookedAt: the hooked address whose hook just ran, so the module's run, sent back here from that same address
      // as no block of its table is there now, runs the code there and does not call the hook a second time)
      if (this.entryHooks) { const h = this.entryHooks.get(eip); this.hookedAt = h ? eip : undefined; if (h) { const to = h.call(this); if (to !== undefined) { eip = to; continue; } } }
      const m = eip >= LAYOUT.THUNK16 ? this.modules[0] : this.modules.find(x => eip >= x.meta.textLo && eip < x.meta.textHi && !x.hidden);   // (not a program whose process's view is put by: arenaUse)
      if (!m) {
        if (eip < 0x10000) (this.nullJumps || (this.nullJumps = [])).push({ at: eip, from: this.lastBlock >>> 0, cs: this.cpu.cs ? this.cpu.cs.value & 0xffff : null });
        const next = this.dataCode && this.dataCode(eip);
        if (next !== undefined && next !== null) { eip = next; continue; }
        if (this.netEnter && this.netEnter(eip)) continue;   // (a DLL whose memo's module is compiled now: put in place, and entered there, dyn.js)
        (this.entryRing || (this.entryAt = 0, this.entryRing = new Uint32Array(32)))[this.entryAt++ & 31] = eip;   // (run-time code entered: in a fault's way there too)
        const dyn = this.dynRun && this.dynRun(eip);   // code generated at run time (dyn.js)
        if (dyn === -1) return 1;   // its time was up
        if (dyn !== undefined && dyn !== null) { eip = dyn; continue; }
        const go = this.noCode(eip); if (go === null) return 2;
        eip = go; continue;
      }
      if (this.modeSwitch && eip < LAYOUT.THUNK16) this.modeSwitch(m);
      if (m.clock) this.tick16();   // SYSTEM.DRV reads the time the timer VxD keeps current
      let r;
      this.lastBlock = eip; (this.entryRing || (this.entryAt = 0, this.entryRing = new Uint32Array(32)))[this.entryAt++ & 31] = eip;   // (the last 32 entries into modules: a fault's way there, noCode)
      try { r = m.run(eip); } catch (e) {
        // a divide error (DIV or IDIV by 0, or a quotient too large: wasm's traps), #DE at the instruction, as the
        // processor raises it, for the program's handlers (a module translated as it loaded, dyn.js, divides with wasm's
        // own instructions; this was the machine's end)
        if (e instanceof WebAssembly.RuntimeError && /divide by zero|integer overflow/.test(e.message)) { eip = this.raise(0, u32(this.cpu.eip.value)); continue; }
        // an access past the end of memory (a pointer that is no address the machine has): a page fault where the guest
        // made it, for its own handlers or its fault dialog, as the processor raises one; not the machine's end
        if (!(e instanceof WebAssembly.RuntimeError) || !/out of bounds/.test(e.message)) throw e;
        const at = u32(this.cpu.eip.value);
        log('warn', 'win32', `${m.name || '?'}: memory access out of bounds in the block at ${at.toString(16)} (thread ${this.thread16 ? this.thread16.id : 'main'})`);
        eip = this.raise(14, at, 0xffffffff); continue;
      }
      if (r === 2 && this.dynWant !== undefined) {   // no translated block there: code written at run time
        const at = this.dynWant; this.dynWant = undefined;
        // (a hooked block, out of its module's table, comes here too: dynRun calls its hook as it enters it, unless
        // the dispatcher has just called that one for this same entry (hookedAt), so each entry calls it once)
        if (this.hookedAt !== at) this.hookedAt = undefined;
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
    if (this.sliceEnd !== undefined) { this.cpu.budget.value = this.sliceEnd; this.sliceEnd = undefined; }   // (a slice ended early that stopped another way first)
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
    let r; try { r = this.runAt(addr); } finally { this.depth--; }   // (the depth comes back whatever the run does: ne16.js call16)
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
    const r = sehStart(this, EXC_CODE[n] || 0xc0000005, eip, n === 14 || n === 13 ? [this.pfWrite ? 1 : 0, cr2] : [], f, 0);
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
        // (with the code it was running and the return addresses nearest the stack's end: the recursion that ran it out)
        // (only words in a module's code are named: whereOf for every word of the stack made each stack fault seconds long)
        // (a DLL loaded from its file has no text bounds in its record: its image's span; Explorer's stack ran out in
        // SHLWAPI and USER32, both from files, and the log named no return address)
        const code = this.modules.filter(x => (x.meta && x.meta.textHi > x.meta.textLo) || (x.base && x.size)).map(x => x.meta && x.meta.textHi > x.meta.textLo ? [x.meta.textLo >>> 0, x.meta.textHi >>> 0] : [x.base >>> 0, (x.base + x.size) >>> 0]);
        const chain = []; for (let a = u32(this.cpu.esp.value), end = Math.min(a + 0x8000, this.u8.length - 4); a < end && chain.length < 40; a += 4) { const v = this.r32(a) >>> 0; if (code.some(([lo, hi]) => v >= lo && v < hi)) chain.push(this.whereOf(v)); }
        // (and the frames by their EBP chain, each with its place on the stack: what took the stack, not only its end)
        const frames = []; for (let bp = u32(this.cpu.ebp.value), k = 0; k < 400 && bp > 0x1000 && bp + 8 <= this.u8.length; k++) { const nb = this.r32(bp) >>> 0; frames.push(`${this.whereOf(this.r32(bp + 4) >>> 0)}@${bp.toString(16)}`); if (nb <= bp) break; bp = nb; }
        const top = this.r32(this.cpu.fs.value + 4) >>> 0;
        log('warn', 'win32', `stack fault: thread ${this.thread16 ? this.thread16.id : 'main'}'s stack (${limit.toString(16)}-${top.toString(16)}) ran out at ${u32(eip).toString(16)}, in ${this.whereOf(this.cpu.eip.value)}; returns ${chain.join(' < ')}; frames ${frames.length > 60 ? [...frames.slice(0, 30), `... ${frames.length - 60} more ...`, ...frames.slice(-30)].join(' < ') : frames.join(' < ')}`);
        throw new FaultError(Object.assign(this.faultInfo(12, u32(this.cpu.eip.value), u32(eip)), { why: `stack fault at ${u32(this.cpu.eip.value).toString(16)}` }));
      }
      this.pfWrite = !!(code & 0x10);
      { let blk = 'no block'; for (const [b, n] of this.allocs || []) if (u32(eip) >= b && u32(eip) < b + n) { blk = `block ${b.toString(16)}+${n.toString(16)}`; break; }
        const edi = u32(this.cpu.edi.value); let eb = ''; for (const [b, n] of this.allocs || []) if (edi - 0x4000 >= b && edi - 0x4000 < b + n) { eb = `, the write's start in block ${b.toString(16)}+${n.toString(16)}`; break; }
        log('warn', 'win32', `protected page at ${u32(eip).toString(16)}: ${this.protOwner(u32(eip))}; ${blk}${eb}`); }
      (this.faultLog || (this.faultLog = [])).push({ why: `ring 3 ${this.pfWrite ? 'write' : 'read'} at ${u32(eip).toString(16)}, a protected page`, at: u32(this.cpu.eip.value).toString(16), atIn: this.whereOf(this.cpu.eip.value), thread: this.thread16 ? this.thread16.id : 'main',
        stack: Array.from({ length: 16 }, (_, k) => this.r32(u32(this.cpu.esp.value) + 4 * k)).map(v => this.whereOf(v)).filter(s => s && /[A-Z]/.test(s)) }); if (this.faultLog.length > 50) this.faultLog.shift();
      // (in the log as it happens too, as noCode's: a machine that ends of it, at its boot, leaves no fault log to ask for)
      { const f = this.faultLog[this.faultLog.length - 1]; log('warn', 'win32', `${f.why}, by ${f.atIn} (${f.at}), ${['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'].map(r => `${r} ${u32(this.cpu[r].value).toString(16)}`).join(' ')}; called from ${f.stack.slice(0, 6).join(' < ')}`); }
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
    (this.entryRing || (this.entryAt = 0, this.entryRing = new Uint32Array(32)))[this.entryAt++ & 31] = u32(eip);   // (an import called from inside a module's run: a fault's way there names it, noCode)
    if (u32(eip) < LAYOUT.THUNK) return this.api16(u32(eip));
    if (u32(eip) === DLL_CHAIN) return this.dllChainStep();   // (a module's own return to the chain comes here, not through the dispatcher)
    if (u32(eip) === SEH_CONT) return sehStep(this);          // (and an exception handler's return to the dispatcher)
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
      catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } return this.apiPastMemory(e, t, eip); }
    }
    const a = []; for (let i = 0; i < (nargs < 0 ? 8 : nargs); i++) a.push(this.r32(sp + 4 + 4 * i));
    const pc = this.thread16 && this.thread16.pc;
    if (pc && /\.SCR$/i.test(pc.path || '') && t.dll === 'USER32' && /^(IsWindow|GetForegroundWindow|GetParent|GetClientRect|GetDC|CreateWindowExA|GetSystemMetrics|ChangeDisplaySettingsA)$/.test(t.nm))
      (pc.user32Calls || (pc.user32Calls = [])).push({ name: t.nm, args: a.slice(0, 4) });
    let r; const wasCall = this.apiCall; this.apiCall = { sp, nargs }; this.dllChain = null;
    try { r = fn.apply(this, a); }
    catch (e) { if (e instanceof GuestError) { this.trapped = e.message; return LAYOUT.SENTINEL; } return this.apiPastMemory(e, t, eip); }
    finally { this.apiCall = wasCall; }
    if (r === YIELD) { this.preempted = 0; return -1; }   // (stopped in the call, not where its time ran out)
    if (this.exitCode !== null) return LAYOUT.SENTINEL;
    if (this.dllChain) { const c = this.dllChain; this.dllChain = null; return this.dllChainStart(c, this.r32(sp), sp + 4 + 4 * nargs, r === undefined ? 0 : r); }
    this.reg('eax', r === undefined ? 0 : r);
    const ret = this.r32(sp);
    this.reg('esp', sp + 4 + (nargs < 0 ? 0 : 4 * nargs));
    return ret;
  }
  /** a call given a pointer that is no address the machine has (its read or write went past the end of memory): a page
   *  fault in the call, from where it was called, as Windows' own code faults in the caller's thread (its handlers, or
   *  its fault dialog); not the machine's end */
  apiPastMemory(e, t, eip) {
    if (!(e instanceof RangeError) || !/bounds/.test(e.message)) throw e;
    // (KERNEL32's calls check their pointers on Windows 98, its parameter validation: one that is no address fails the
    // call with ERROR_INVALID_PARAMETER, not a fault in it. SHLWAPI's ShellExecuteExW converts lpClass whatever the mask
    // says, SHDOCVW leaves it as its stack had it, and WideCharToMultiByte of that garbage faulted Explorer on Windows 98's
    // first start)
    if (t && t.dll === 'KERNEL32' && t.def && typeof t.def[0] === 'number' && t.def[0] >= 0) {
      const sp = u32(this.reg('esp')), ret = this.r32(sp);
      this.lastError = 87; this.reg('eax', 0); this.reg('esp', sp + 4 + 4 * t.def[0]);
      return ret;
    }
    try { return this.raise(14, u32(eip), u32(eip)); } catch (f) { if (f instanceof FaultError) f.fault.import = t.dll + '!' + t.nm; throw f; }
  }
  f80load(a) {
    const lo = this.r32(a), hi = this.r32(a + 4), se = this.r16(a + 8);
    const sign = se & 0x8000 ? -1 : 1, exp = se & 0x7fff;
    if (!exp && !lo && !hi) return 0 * sign;
    return sign * (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
  }
  /** FBLD: the 10-byte packed BCD at `a` (18 digits, two a byte, the low digit in the low nibble, the low byte first;
   *  the sign bit 7 of byte 9) as a number */
  fbld(a) {
    let v = 0n; for (let i = 8; i >= 0; i--) { const b = this.u8[a + i]; v = v * 100n + BigInt((b >> 4) * 10 + (b & 15)); }
    const n = Number(v); return this.u8[a + 9] & 0x80 ? -n : n;
  }
  /** FBSTP: a number stored as packed BCD, rounded to an integer as the control word's rounding field says (0 to
   *  nearest, even at a half; 1 down; 2 up; 3 toward zero); one past 18 digits, or not a number, the indefinite */
  fbstp(a, v) {
    const rc = (this.cpu.fcw ? this.cpu.fcw.value >> 10 : 0) & 3;
    let r = rc === 1 ? Math.floor(v) : rc === 2 ? Math.ceil(v) : rc === 3 ? Math.trunc(v) : Math.round(v) - (Math.abs(v % 1) === 0.5 && Math.round(v) % 2 ? 1 : 0);
    if (!Number.isFinite(r) || Math.abs(r) >= 1e18) { this.u8.fill(0, a, a + 7); this.u8[a + 7] = 0xc0; this.u8[a + 8] = 0xff; this.u8[a + 9] = 0xff; return; }
    let m = BigInt(Math.abs(r));
    for (let i = 0; i < 9; i++) { const d = Number(m % 100n); m /= 100n; this.u8[a + i] = ((Math.floor(d / 10)) << 4) | (d % 10); }
    this.u8[a + 9] = r < 0 || Object.is(r, -0) ? 0x80 : 0;
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
      // (the heap's end reached: the free blocks merged where they touch, the end given back where the last of them
      // reaches it, then the smallest free block that holds it, the rest of that block free again at its size)
      if (this.heapTop > LAYOUT.HEAP_END) {
        this.heapTop -= n; this.coalesce(); p = this.heapTop; this.heapTop += n;
        if (this.heapTop > LAYOUT.HEAP_END) {
          let best = 0; for (const [s, l] of this.freeList) if (s >= n && l.length && (!best || s < best)) best = s;
          if (best) {
            this.heapTop -= n; p = this.freeList.get(best).pop();
            if (best > n) { const r = best - n; if (!this.freeList.has(r)) this.freeList.set(r, []); this.freeList.get(r).push(p + n); }
          }
        }
      }
      if (this.heapTop > LAYOUT.HEAP_END) {   // (the report says what holds the heap: live blocks by size, and what idles on the free lists)
        // (the top back where it was: left past the end by one request too big for the heap, every allocation after
        // it, a dozen bytes for a fault's dialog among them, was refused too, with 21 MB free, and Windows ended)
        this.heapTop -= n;
        // (a block the heap has no room for in one piece, its free bytes scattered among the live ones after some
        // hundreds of programs: from the address space above, where VirtualAlloc's regions are, and back there
        // when it is freed. Explorer's 2.3 MB for MSHTML's file was refused with 17 MB free)
        const size = (n + 0xffff) & ~0xffff, sp = (this.vspare || []).findIndex(r => r.size >= size); let b = 0;
        if (sp >= 0) { const s = this.vspare.splice(sp, 1)[0]; b = s.base; if (s.size > size) this.vspare.push({ base: b + size, size: s.size - size }); }
        else if (this.vmTop && this.vmFit(this.vmTop + size)) { b = this.vmTop; this.vmTop += size; }
        if (b) { this.vmCheck(b, size, 'a big block'); (this.bigBlocks || (this.bigBlocks = new Map())).set(b, size); this.vmAudit('a big block'); this.allocs.set(b, n); if (zero) this.u8.fill(0, b, b + n); return b; }
        const by = new Map(); let live = 0; for (const [, s] of this.allocs) { by.set(s, (by.get(s) || 0) + s); live += s; }
        let idle = 0; for (const [s, l] of this.freeList) idle += s * l.length;
        const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, t]) => `${s}x${t / s}`).join(' ');
        let most = 0; for (const [s, l] of this.freeList) if (l.length && s > most) most = s;
        throw new GuestError(`out of memory asking for ${n} bytes (the largest free block ${most}): ${(live >> 20)} MB live in ${this.allocs.size} blocks (${top}), ${idle >> 20} MB idle on the free lists; big blocks: ${(this.bigAllocs || []).join(' | ')}`);
      }
    }
    this.allocs.set(p, n); if (zero) this.u8.fill(0, p, p + n);
    if (n >= 8 << 20) (this.bigAllocs || (this.bigAllocs = [])).push(`${n} bytes at ${p.toString(16)}: ${(new Error().stack || '').split('\n').slice(2, 7).map(s => s.trim()).join(' < ')}`);   // (who takes a block of 8 MB or more: the out-of-memory report)
    return p;
  }
  /** the free lists with adjacent free blocks merged into one, and the heap's top lowered past free blocks at its end */
  coalesce() {
    const blocks = []; for (const [s, l] of this.freeList) for (const a of l) blocks.push([a, s]);
    blocks.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, s] of blocks) { const last = merged[merged.length - 1]; if (last && last[0] + last[1] === a) last[1] += s; else merged.push([a, s]); }
    while (merged.length && merged[merged.length - 1][0] + merged[merged.length - 1][1] === this.heapTop) this.heapTop = merged.pop()[0];
    this.freeList = new Map(); for (const [a, s] of merged) { if (!this.freeList.has(s)) this.freeList.set(s, []); this.freeList.get(s).push(a); }
  }
  free(p) { const n = this.allocs.get(p); if (!n) return false; this.allocs.delete(p);
    const big = this.bigBlocks && this.bigBlocks.get(p); if (big) { this.bigBlocks.delete(p); this.vmCheck(p, big, 'a big block given back'); (this.vspare || (this.vspare = [])).push({ base: p, size: big }); this.vmAudit('a big block given back'); return true; }   // (one from above the heap: back to that space)
    if (!this.freeList.has(n)) this.freeList.set(n, []); this.freeList.get(n).push(p); return true; }
  /** block `p` grown to `n` bytes where it is (the new bytes zeroed): at the heap's top, or over the free block that
   *  follows it; false when neither has the room */
  extend(p, n) {
    n = (Math.max(n, 1) + 15) & ~15; const old = this.allocs.get(p); if (!old) return false; if (n <= old) return true;
    let ok = false;
    if (p + old === this.heapTop && p + n <= LAYOUT.HEAP_END) { this.heapTop = p + n; ok = true; }
    else for (const [s, l] of this.freeList) {
      const i = l.indexOf(p + old); if (i < 0 || old + s < n) continue;
      l.splice(i, 1); const rest = old + s - n;
      if (rest) { if (!this.freeList.has(rest)) this.freeList.set(rest, []); this.freeList.get(rest).push(p + n); }
      ok = true; break;
    }
    if (!ok) return false;
    this.allocs.set(p, n); this.u8.fill(0, p + old, p + n); return true;
  }
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
  /** the machine's clock to the block, for a counter read as code runs (the 8254's, ne16.js pitIO): its clock, which
   *  moves a quantum each BUDGET blocks (tick), and the part of the quantum the blocks run since have taken. Read by the
   *  quantum alone, a short timed loop saw no time or a whole quantum: Windows 98 Setup timed its CPU by the 8254's
   *  channel 2 over a few thousand blocks, read no time, and divided by it (W98SETUP 1:77Ch, exception 6h) */
  blockNow() {
    const vc = this.host.vclock, b = this.cpu.budget;
    return this.now() + (vc && b ? Math.min(BUDGET, Math.max(0, BUDGET - b.value)) / BUDGET * vc.perTick : 0);
  }
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
  // (wsprintfA's string and character types: %s and %c the caller's own, ANSI; %ls, %ws and %S a wide string, %lc, %wc
  // and %C a wide character; %hs and %hc ANSI. Read as ANSI, a wide string gave its first character alone: QUARTZ's
  // DllRegisterServer makes its class keys with "CLSID\%ls", wrote every class to the one key "CLSID\{", and Windows
  // Media Player found no filter graph class, error 80040154)
  return fmt.replace(/%([-#0 +]*)(\d*)(?:\.(\d+))?(h|l|ll|w)?([diuxXcCsS%])/g, (m, flags, width, prec, len, t) => {
    if (t === '%') return '%';
    const wide = len === 'l' || len === 'w' || (len !== 'h' && (t === 'S' || t === 'C'));
    let s;
    if (t === 'd' || t === 'i') s = String(next() | 0);
    else if (t === 'u') s = String(next() >>> 0);
    else if (t === 'x' || t === 'X') { s = (next() >>> 0).toString(16); if (t === 'X') s = s.toUpperCase(); if (flags.includes('#')) s = '0x' + s; }
    else if (t === 'c' || t === 'C') s = String.fromCharCode(next() & (wide ? 0xffff : 0xff));
    else s = (wide ? p.readW(next()) : p.readA(next())) ?? '(null)';
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
/** a line that is not key=value added to the section, made when it is not there (WritePrivateProfileSection) */
function iniAddLine(fs, file, sec, raw) {
  const ini = iniRead(fs, file), sk = sec.toLowerCase();
  if (!ini.has(sk)) ini.set(sk, { name: sec, keys: new Map(), lines: [] });
  ini.get(sk).lines.push({ raw });
  let text = '';
  for (const v of ini.values()) { text += `[${v.name}]\r\n`; for (const k of v.lines) text += k.raw !== undefined ? `${k.raw}\r\n` : `${k.name}=${k.value}\r\n`; text += '\r\n'; }
  fs.writeFile(iniPath(file), text);
}
// The registry's keys by their full path. Its set of keys is counted as it changes (ver), so a key's subkeys are
// listed once per change (regKidPaths) and not found again in every key at each RegEnumKey: Windows 98's registry has
// tens of thousands of keys, each program's start enumerates hundreds, and the searches took a third of the machine's
// time as the shell's programs started (the startup sound ran dry)
class RegMap extends Map {
  set(k, v) { if (!this.has(k)) this.ver = (this.ver || 0) + 1; return super.set(k, v); }
  delete(k) { const had = super.delete(k); if (had) this.ver = (this.ver || 0) + 1; return had; }
  clear() { this.ver = (this.ver || 0) + 1; super.clear(); }
}
let kidsVer = null, kidsBy = new Map();
/** a key's subkeys (their full paths), in the order they were made */
const regKidPaths = path => {
  if (kidsVer !== REGISTRY.ver) {
    kidsBy = new Map();
    for (const k of REGISTRY.keys()) { const i = k.lastIndexOf('\\'); if (i < 0) continue; const p = k.slice(0, i); let a = kidsBy.get(p); if (!a) kidsBy.set(p, a = []); a.push(k); }
    kidsVer = REGISTRY.ver;
  }
  return kidsBy.get(path) || [];
};
const REGISTRY = new RegMap([
  ['hkcu\\control panel\\desktop', new Map([['screensaveusepassword', 0]])],
  ['hkcu\\control panel\\colors', new Map()],
]);
// Registry writes go through to a store when one is attached (regAttach): each key created or deleted and each value
// set or deleted, as it happens. Values are numbers, strings, or { type, name, data } with the raw bytes.
let regStore = null, regQuiet = false;
const regWatchers = new Set();   // the page's: each change, for the machines' copies in their workers
// (regQuiet true: nothing told; 'remote': a change another person's machine made, from the shared session's server
// (shared.js): this page's machines told, the store not, the server having it already)
// RegNotifyChangeKeyValue's asks: each one's event set once, at the first change to its key (or under it, when it
// watches the subtree) of the kinds it asked for (REG_NOTIFY_CHANGE_NAME 1: keys made or deleted; LAST_SET 4: values),
// whoever's change it was, this machine's or one told it quietly (another machine's, the page's)
const regNotifies = new Set();
const regNotify = op => {
  if (!regNotifies.size || !op || !op.path) return;
  const kind = op.op === 'set' || op.op === 'del' ? 4 : 1, parent = op.path.slice(0, op.path.lastIndexOf('\\'));
  for (const n of [...regNotifies]) {
    // (a key made or deleted is a change to its parent's names)
    const hit = op.path === n.path || (n.sub && op.path.startsWith(n.path + '\\')) || (kind === 1 && parent === n.path);
    if (!(n.filter & kind) || !hit) continue;
    regNotifies.delete(n);
    if (n.proc.signal) n.proc.signal(n.ev); else n.ev.set = true;
  }
};
const regChanged = op => { regNotify(op); if (regQuiet === true) return; if (regStore && !regQuiet) regStore.op(op); for (const f of regWatchers) f(op); };
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
// the registry's other names for a key, as Windows 95 has them: HKEY_LOCAL_MACHINE\SOFTWARE\Classes is
// HKEY_CLASSES_ROOT, HKEY_LOCAL_MACHINE\Config\0001 is HKEY_CURRENT_CONFIG, HKEY_USERS\.DEFAULT is HKEY_CURRENT_USER:
// the same keys, kept under the second name. Kept as two trees, a class URLMON or SHELL32 looked up under
// HKLM\SOFTWARE\Classes was not there (SHRegOpenUSKey: the Web view's MIME filter, a folder's %THISDIRNAME% left as it
// was). The first name's own key stays, so the key above it still lists it
const REG_ALIAS = [['hklm\\software\\classes', 'hkcr'], ['hklm\\config\\0001', 'hkcc'], ['hku\\.default', 'hkcu']];
/** a key's path under the name the registry keeps it by (lower case in, lower case out) */
const regCanon = path => { for (const [a, b] of REG_ALIAS) if (path === a || path.startsWith(a + '\\')) return b + path.slice(a.length); return path; };
/** a key's path as given (its case), under the name the registry keeps it by */
const regCanonGiven = given => { const low = given.toLowerCase(); for (const [a, b] of REG_ALIAS) if (low === a || low.startsWith(a + '\\')) return b + given.slice(a.length); return given; };
/** whether a stored path lies under another name of a key (left from before the names were one: not written out) */
const regAliased = path => REG_ALIAS.some(([a]) => path.startsWith(a + '\\'));
/** what a registry kept under the other names before they were one, given to the key it names, where that has none */
// (`tell`: each value given passed on as a change, to the store and the other copies; quiet, this copy alone)
const regUnify = tell => {
  for (const [path, m] of [...REGISTRY]) {
    if (!REG_ALIAS.some(([a]) => path === a || path.startsWith(a + '\\'))) continue;
    const to = regCanon(path); if (to === path) continue;
    if (!REGISTRY.has(to)) {
      if (tell) regMake(to, KEYNAME.get(path) ? to.slice(0, to.length - KEYNAME.get(path).length) + KEYNAME.get(path) : null);
      else { const parts = to.split('\\'); for (let k = 1; k <= parts.length; k++) { const q = parts.slice(0, k).join('\\'); if (!REGISTRY.has(q)) REGISTRY.set(q, new Map()); } }
    }
    const t = REGISTRY.get(to);
    for (const [n, v] of m) if (!t.has(n)) { t.set(n, v); if (tell) regChanged({ op: 'set', path: to, name: n, value: v }); }
  }
};
const regAttach = store => {
  regStore = store;
  const held = store.load();
  if (!held) { for (const [path, m] of REGISTRY) { store.op({ op: 'key', path }); for (const [name, value] of m) store.op({ op: 'set', path, name, value }); } return false; }
  REGISTRY.clear(); KEYNAME.clear();
  for (const [path, vals, name] of held) { REGISTRY.set(path, new Map(vals)); if (name) KEYNAME.set(path, name); }
  regUnify(true);
  return true;
};
/** the registry as it is now, in the form a store's load gives it ([path, values, name]), for a machine in a worker */
const regDump = () => [...REGISTRY].map(([path, m]) => [path, [...m], KEYNAME.get(path) || null]);
/** this copy of the registry put back as a dump had it (a moment rewound: braid.js). Quiet, the copy alone changes;
 *  `tell`, each difference goes as the operation that makes it, so the store and the other copies follow */
const regLoad = (held, tell) => {
  if (!tell) { REGISTRY.clear(); KEYNAME.clear(); for (const [path, vals, name] of held) { REGISTRY.set(path, new Map(vals)); if (name) KEYNAME.set(path, name); } regUnify(false); return; }
  const want = new Map(held.map(([path, vals, name]) => [path, { vals: new Map(vals), name }]));
  // (the keys not wanted, deepest first, each deleted by itself: those under it are gone already. regDel looks through
  // every key for the ones under its own, and 20,000 keys deleted that way were 5 s of an arrival. A wanted key under
  // one not wanted goes with it, as the store's delete of the key takes it, and is made again below)
  const gone = new Set([...REGISTRY.keys()].filter(path => !want.has(path)));
  if (gone.size) for (const path of want.keys()) { for (let i = path.lastIndexOf('\\'); i > 0; i = path.lastIndexOf('\\', i - 1)) if (gone.has(path.slice(0, i))) { REGISTRY.delete(path); KEYNAME.delete(path); break; } }
  for (const path of [...gone].sort().reverse()) { REGISTRY.delete(path); KEYNAME.delete(path); regChanged({ op: 'delkey', path }); }
  for (const [path, { vals, name }] of want) {
    if (!REGISTRY.has(path)) regMake(path, name ? path.slice(0, path.length - name.length) + name : null);
    if (name && KEYNAME.get(path) !== name) { KEYNAME.set(path, name); regChanged({ op: 'key', path, name }); }
    const m = REGISTRY.get(path);
    for (const n of [...m.keys()]) if (!vals.has(n)) { m.delete(n); regChanged({ op: 'del', path, name: n }); }
    for (const [n, v] of vals) if (JSON.stringify(m.get(n)) !== JSON.stringify(v)) { m.set(n, v); regChanged({ op: 'set', path, name: n, value: v }); }
  }
};
/** a change another copy of the registry made (a machine's in its worker, or the page's): applied here, and passed on
 *  to this copy's store unless `quiet` ('remote': another person's, to this page's machines but not its store) */
const regApply = (o, quiet) => {
  if (o && o.path && regCanon(o.path) !== o.path) o = { ...o, path: regCanon(o.path) };   // (a change made under another name of the key)
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
const regKids = path => { path = regCanon(path.toLowerCase()); return regKidPaths(path).map(k => k.slice(path.length + 1)); };
/** a key's values as [name, value] pairs, and a key removed with its subkeys */
const regVals = path => [...(REGISTRY.get(regCanon(path.toLowerCase())) || new Map()).entries()];
const regDel = path => { path = regCanon(path.toLowerCase()); let any = false; for (const k of [...REGISTRY.keys()]) if (k === path || k.startsWith(path + '\\')) { REGISTRY.delete(k); KEYNAME.delete(k); any = true; } if (any) regChanged({ op: 'delkey', path }); };
const regGet = (path, name) => { const m = REGISTRY.get(regCanon(path.toLowerCase())); return m ? m.get(name.toLowerCase()) : undefined; };
const regSet = (path, name, value) => {
  const orig = regCanonGiven(path); path = regCanon(path.toLowerCase()); regMake(path, orig);
  if (name === null) return;   // the key alone
  REGISTRY.get(path).set(name.toLowerCase(), value); regChanged({ op: 'set', path, name: name.toLowerCase(), value });
};
const HKEY = { 0x80000000: 'hkcr', 0x80000001: 'hkcu', 0x80000002: 'hklm', 0x80000003: 'hku', 0x80000005: 'hkcc', 0x80000006: 'hkdd', 1: 'hkcr', 2: 'hkcu', 3: 'hklm' };
/** the registry's file, as Windows 95 writes it to the Windows folder (and IO.SYS's real-mode registry reads it):
 *  'system' SYSTEM.DAT, HKEY_LOCAL_MACHINE (HKEY_CLASSES_ROOT its SOFTWARE\Classes, HKEY_CURRENT_CONFIG its
 *  Config\0001); 'user' USER.DAT, HKEY_USERS (HKEY_CURRENT_USER its .Default). The CREG format: a 20h-byte header, the
 *  RGKN block of key entries (1Ch bytes each: hash, parent, first child, next sibling, the key's id and RGDB block, the
 *  offsets from RGKN's start), then RGDB blocks of 4 KB multiples holding each key's name and values, by id */
const regHive = which => {
  // the tree: [path in the hive, the registry path its values come from]
  const map = which === 'user' ? [['', 'hku'], ['.default', 'hkcu']] : [['', 'hklm'], ['software\\classes', 'hkcr'], ['config\\0001', 'hkcc']];
  const root = { name: '', kids: new Map(), vals: null };
  const at = (hp, name) => { let n = root; if (hp) for (const seg of hp.split('\\')) { let k = n.kids.get(seg); if (!k) n.kids.set(seg, k = { name: seg, kids: new Map(), vals: null }); n = k; } if (name && !n.orig) n.orig = name; return n; };
  for (const [path, vals] of REGISTRY) for (const [hp, rp] of map) {
    if (path !== rp && !path.startsWith(rp + '\\')) continue;
    if (regAliased(path)) continue;   // (one kept under another name of a key before the names were one: its key's own is written)
    if (map.some(([h2, r2]) => r2 !== rp && r2.startsWith(rp + '\\') && (path === r2 || path.startsWith(r2 + '\\')))) continue;
    const rest = path.slice(rp.length + 1), n = at([hp, rest].filter(Boolean).join('\\'));
    const nm = KEYNAME.get(path); if (nm) n.orig = nm;
    n.vals = n.vals ? new Map([...n.vals, ...vals]) : new Map(vals);
  }
  if (which === 'user' && !root.kids.has('.default')) at('.default', '.Default'); else if (root.kids.has('.default')) root.kids.get('.default').orig = '.Default';
  const enc = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const value = (k, v) => {   // [type, name bytes, data bytes]
    const name = enc(v && typeof v === 'object' && v.name !== undefined ? String(v.name) : k);
    if (typeof v === 'number') { const d = new Uint8Array(4); new DataView(d.buffer).setUint32(0, v >>> 0, true); return [4, name, d]; }
    if (typeof v === 'string') return [1, name, enc(v)];
    const d = v && v.data ? (v.data instanceof Uint8Array ? v.data : new Uint8Array(v.data)) : new Uint8Array(0);
    return [v && v.type !== undefined ? v.type : 3, name, (v && (v.type === 1 || v.type === 2) && d.length && d[d.length - 1] === 0) ? d.subarray(0, d.length - 1) : d];
  };
  // the key entries in RGKN, depth first (the root first, with no RGDB record), and each key's record
  const keys = []; const walk = (n, parent) => { n.i = keys.length; n.parent = parent; keys.push(n); for (const k of n.kids.values()) walk(k, n); };
  walk(root, null);
  const recs = keys.map((n, i) => {
    if (!i) return null;
    const name = enc(n.orig || n.name), vals = [...(n.vals || new Map())].map(([k, v]) => value(k, v));
    const size = 0x14 + name.length + vals.reduce((s, [, nm, d]) => s + 0x0c + nm.length + d.length, 0);
    return { name, vals, size };
  });
  // the records in blocks: each block 20h of header and its records, rounded up to 4 KB (the rest one free record)
  const blocks = []; let cur = null;
  for (let i = 1; i < keys.length; i++) {
    const r = recs[i];
    if (!cur || (cur.recs.length && cur.used + r.size > 0x1000 - 0x20 - 0x14)) { cur = { recs: [], used: 0, ids: 0 }; blocks.push(cur); }
    r.block = blocks.length - 1; r.id = cur.ids++; cur.recs.push(r); cur.used += r.size;
  }
  // (as ScanReg reads RGKN: 291 entries in its first 2000h, then whole entries in each 1000h page; an RGDB block ends with 14h free)
  const slot = i => (i < 291 ? 0x20 + i * 0x1c : 0x2000 + 0x1000 * Math.floor((i - 291) / 146) + 0x1c * ((i - 291) % 146));
  const rgknSize = (slot(keys.length) + 0x1c + 0xfff) & ~0xfff;
  const blockSize = b => (b.used + 0x20 + 0x14 + 0xfff) & ~0xfff;
  const total = 0x20 + rgknSize + blocks.reduce((s, b) => s + blockSize(b), 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer), tag = (o, s) => out.set(enc(s), o);
  tag(0, 'CREG'); dv.setUint32(4, 0x10000, true); dv.setUint32(8, 0x20 + rgknSize, true); dv.setUint16(0x10, blocks.length, true); dv.setUint16(0x12, 0x20, true); dv.setUint16(0x16, 1, true);
  // (its flags 20h, closed clean: bit 0 is the VMM's mark of a registry open and not yet written back, which IO.SYS
  // takes at boot for one Windows did not close, and stops at the Startup Menu's "registry/configuration error")
  // (the header's checksum at 0Ch: its other dwords XORed, as the VMM writes it and IO.SYS's real-mode registry checks
  // it at boot. Left 0, IO.SYS took SYSTEM.DAT for damaged, found no SYSTEM.DA0, and every start stopped at the
  // Startup Menu's "registry/configuration error", Safe mode chosen)
  { let x = 0; for (let o = 0; o < 0x20; o += 4) if (o !== 0x0c) x ^= dv.getUint32(o, true); dv.setUint32(0x0c, x >>> 0, true); }
  const K = 0x20;
  tag(K, 'RGKN'); dv.setUint32(K + 4, rgknSize, true); dv.setUint32(K + 8, 0x20, true); dv.setUint32(K + 0x10, 8, true);
  // (the block's space past its entries is one free entry, the head of its free list: 80000000h, its size, the next (none))
  { const end = slot(keys.length), left = rgknSize - end; dv.setUint32(K + 0x0c, left >= 0x1c ? end : 0xffffffff, true); if (left >= 0x1c) { dv.setUint32(K + end, 0x80000000, true); dv.setUint32(K + end + 4, left, true); dv.setUint32(K + end + 8, 0xffffffff, true); } }
  const off = n => (n ? slot(n.i) : 0xffffffff);
  for (const n of keys) {
    const e = K + off(n), kids = [...n.kids.values()], sib = n.parent ? [...n.parent.kids.values()] : [], si = sib.indexOf(n);
    let hash = 0; for (const c of (n.orig || n.name).toUpperCase()) hash += c.charCodeAt(0) & 0xff;
    dv.setUint32(e, 0, true); dv.setUint32(e + 4, hash, true); dv.setUint32(e + 8, n.parent ? 0xffffffff : 0, true);
    dv.setUint32(e + 0x0c, off(n.parent), true); dv.setUint32(e + 0x10, off(kids[0]), true); dv.setUint32(e + 0x14, off(si >= 0 ? sib[si + 1] : null), true);
    const r = recs[n.i]; dv.setUint16(e + 0x18, r ? r.id : 0xffff, true); dv.setUint16(e + 0x1a, r ? r.block : 0xffff, true);
  }
  let o = 0x20 + rgknSize;
  blocks.forEach((b, bn) => {
    const size = blockSize(b), free = size - 0x20 - b.used;
    tag(o, 'RGDB'); dv.setUint32(o + 4, size, true); dv.setUint32(o + 8, free, true); dv.setUint16(o + 0x0c, 8, true); dv.setUint16(o + 0x0e, bn, true);
    dv.setUint32(o + 0x10, 0x20 + b.used, true); dv.setUint16(o + 0x14, b.ids, true); dv.setUint16(o + 0x16, b.ids, true);   // (the keys it holds, and the next id free)
    let p = o + 0x20;
    for (const r of b.recs) {
      dv.setUint32(p, r.size, true); dv.setUint16(p + 4, r.id, true); dv.setUint16(p + 6, bn, true); dv.setUint32(p + 8, r.size, true);
      dv.setUint16(p + 0x0c, r.name.length, true); dv.setUint16(p + 0x0e, r.vals.length, true); out.set(r.name, p + 0x14);
      let q = p + 0x14 + r.name.length;
      for (const [type, nm, d] of r.vals) { dv.setUint32(q, type, true); dv.setUint16(q + 8, nm.length, true); dv.setUint16(q + 0x0a, d.length, true); out.set(nm, q + 0x0c); out.set(d, q + 0x0c + nm.length); q += 0x0c + nm.length + d.length; }
      p += r.size;
    }
    // (the rest of the block one free record: its ids FFFFh)
    dv.setUint32(p, free, true); dv.setUint32(p + 4, 0xffffffff, true); dv.setUint32(p + 8, 0xffffffff, true);
    o += size;
  });
  return out;
};
/** a registry's file read back (regHive's format, and Windows 9x's own, as its Setup writes one): the keys it holds as
 *  a dump's entries ([path, values, name], regLoad's), the hive's paths put where regHive takes them from ('system':
 *  hklm, its software\classes hkcr, its config\0001 hkcc; 'user': hku, its .default hkcu). Null when it is not one */
const regReadHive = (b, which) => {
  if (!b || b.length < 0x40) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'CREG' || tag(0x20) !== 'RGKN') return null;
  const K = 0x20, rgdb0 = dv.getUint32(8, true), nblocks = dv.getUint16(0x10, true);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };
  // each key's record, by its block and id
  const recs = new Map();
  for (let o = rgdb0, bn = 0; bn < nblocks && o + 0x20 <= b.length && tag(o) === 'RGDB'; bn++) {
    const size = dv.getUint32(o + 4, true), end = o + size;
    for (let p = o + 0x20; p + 0x14 <= end;) {
      const rs = dv.getUint32(p, true); if (rs < 0x14 || p + rs > end) break;
      const id = dv.getUint16(p + 4, true), blk = dv.getUint16(p + 6, true);
      if (id !== 0xffff) {
        const nl = dv.getUint16(p + 0x0c, true), nv = dv.getUint16(p + 0x0e, true), vals = [];
        let q = p + 0x14 + nl;
        for (let i = 0; i < nv && q + 0x0c <= p + rs; i++) {
          const type = dv.getUint32(q, true), vnl = dv.getUint16(q + 8, true), dl = dv.getUint16(q + 0x0a, true);
          const name = str(q + 0x0c, vnl), d = b.slice(q + 0x0c + vnl, q + 0x0c + vnl + dl);
          // (as the registry keeps a value RegSetValueEx gave: a DWORD a number, a string with its NUL, the rest bytes)
          const v = type === 4 && dl === 4 ? new DataView(d.buffer).getUint32(0, true)
            : { type, data: (type === 1 || type === 2) ? Uint8Array.from([...d, 0]) : d, ...(name !== name.toLowerCase() ? { name } : {}) };
          vals.push([name.toLowerCase(), v]); q += 0x0c + vnl + dl;
        }
        recs.set(`${blk}:${id}`, { name: str(p + 0x14, nl), vals });
      }
      p += rs;
    }
    o = end;
  }
  // the tree from RGKN's root, each key's path in the hive
  const out = [], map = which === 'user' ? [['.default', 'hkcu'], ['', 'hku']] : [['software\\classes', 'hkcr'], ['config\\0001', 'hkcc'], ['', 'hklm']];
  const seen = new Set();
  const visit = (off, hp, depth) => {
    for (let guard = 0; off !== 0xffffffff && off + K + 0x1c <= b.length && guard < 1e6 && depth < 64; guard++) {
      if (seen.has(off)) return; seen.add(off);
      const e = K + off, r = recs.get(`${dv.getUint16(e + 0x1a, true)}:${dv.getUint16(e + 0x18, true)}`);
      const isRoot = !hp && dv.getUint32(e + 0x0c, true) === 0xffffffff;
      const name = isRoot ? '' : (r ? r.name : ''), path = isRoot ? '' : (hp === null ? name : `${hp}\\${name}`).replace(/^\\/, '');
      if (!isRoot || (r && r.vals.length)) {
        const low = path.toLowerCase(), [h, root] = map.find(([h]) => !h || low === h || low.startsWith(h + '\\'));
        const rest = h ? low.slice(h.length + 1) : low, rp = [root, rest].filter(Boolean).join('\\');
        out.push([rp, r ? r.vals : [], rest ? path.slice(path.lastIndexOf('\\') + 1) : null]);
      }
      visit(dv.getUint32(e + 0x10, true), isRoot ? '' : path, depth + 1);
      off = dv.getUint32(e + 0x14, true);
    }
  };
  visit(dv.getUint32(K + 8, true), null, 0);
  return out;
};

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
  const pc = this.thread16 && this.thread16.pc;
  let ptr = this.cmdPtr;
  // (a process with no command line of its own, the system's (MSGSRV32, MMTASK): an empty one, as a DLL's C run-time
  // reads it as it attaches. Answered with what was there, MSACM32's _setargv read an address past the machine's memory
  // and MSGSRV32 faulted: a blue screen)
  if (!ptr || u32(ptr) >= this.mem.buffer.byteLength) { if (!this.emptyCmd) { this.emptyCmd = this.alloc(4); this.w32(this.emptyCmd, 0); } ptr = this.emptyCmd; }
  if (pc && /\.SCR$/i.test(pc.path || '')) pc.commandLineSeen = this.readA(ptr);
  return ptr;
});
def('KERNEL32', 'GetStartupInfoA', 1, function (p) { this.u8.fill(0, p, p + 68); this.w32(p, 68); });
def('KERNEL32', 'GetModuleHandleA', 1, function (name) {
  // (NULL: the calling process's own image, as Windows 98's KERNEL32 takes it from the process database's EXE module,
  // [ppdbCur]+98h. The system's process, the kernel's own (Toolhelp lists it as KERNEL32.DLL), has KERNEL32 as that
  // module: MSVCRT's DllMain, loaded from GDI's LibEntry at Windows 98's boot, reads the linker version from the
  // module's PE header (__heap_select), and read it at 0 when this answered 0)
  if (!name) { const pc = this.thread16 && this.thread16.pc, exe = (pc && pc.exe) || this.exe; return exe ? exe.base : this.jsDll('KERNEL32'); }
  const n = (this.readA(name) || '').toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, ''), m = this.byName.get(n);
  // (a DLL implemented here is loaded once an image imported it or LoadLibrary loaded it: GDI32's ChoosePixelFormat
  // and SwapBuffers find OPENGL32 by GetModuleHandle, and give up without it)
  if (m) return m.base;
  return (this.jsDlls && this.jsDlls.get(n)) || (this.jsImported && this.jsImported.has(n) ? this.jsDll(n) : 0);
});
def('KERNEL32', 'GetModuleFileNameA', 3, function (h, buf, n) {
  h = this.hmod(h);
  // (the running process's own program at its base: another program linked at the same base is another process's,
  // Explorer asking for its own 400000h was told SPOOL32.EXE)
  if (h && this.pc && this.pc.exe && this.pc.exe.base === h && this.pc.path) return this.writeA(buf, this.pc.path, n);
  const dm = this.dataMods && this.dataMods.get(u32(h)); if (dm) return this.writeA(buf, dm.path, n);   // (a file mapped as data)
  const s = this.standinAt(h); if (s) return this.writeA(buf, s.path, n);
  const m = h && this.modules.find(x => x.base === h && x !== this.exe && x.kind !== 'ne');   // a DLL: its file in SYSTEM; another program: its file
  const other = m && m.name === 'EXE' && [this.pc0, ...(this.procs || new Map()).values()].find(x => x && x.exe === m);
  // (a module named with its own extension, DESK.CPL or WINSPOOL.DRV, is that file; the others are .DLL. A DLL mapped
  // from its file is that file, wherever it was: TRIEDIT's registration looked for its type library in SYSTEM, where
  // it is not, and failed ERROR_FILE_NOT_FOUND on Windows 98's first start)
  return this.writeA(buf, other ? other.path || this.host.path : m && m.meta && m.meta.path ? m.meta.path : m ? `C:\\WINDOWS\\SYSTEM\\${/\.[A-Z0-9]{1,3}$/i.test(m.name) ? m.name : m.name + '.DLL'}` : this.pc.path || this.host.path || 'C:\\WINDOWS\\SCRNSAVE.SCR', n);
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
// The version of Windows: KERNEL32.DLL's own, the file version in its version resource (VS_FIXEDFILEINFO: 4.10.2222
// on Windows 98 Second Edition), as each Windows' KERNEL32 answers its own; 4.0.950, Windows 95's, with no such file.
// (Answered 4.0 on Windows 98, Explorer's Start menu wore its Windows 95 banner: it takes bitmap 157, "Windows98",
// only where GetVersionExA says 4.10 or later.)
const winVersion = p => {
  if (p.winVer) return p.winVer;
  let major = 4, minor = 0, build = 950, b = null;
  try { b = p.fs.readFile('C:\\WINDOWS\\SYSTEM\\KERNEL32.DLL'); } catch (_) { /* the bundle's KERNEL32: Windows 95's */ }
  for (let i = 0; b && i + 16 <= b.length; i += 4) if (b[i] === 0xbd && b[i + 1] === 0x04 && b[i + 2] === 0xef && b[i + 3] === 0xfe) {
    major = b[i + 10] | b[i + 11] << 8; minor = b[i + 8] | b[i + 9] << 8; build = b[i + 12] | b[i + 13] << 8; break;
  }
  return p.winVer = { major, minor, build };
};
/** an OSVERSIONINFO's numbers at `at`. Windows 98's build number carries the version above it (040A08AEh); Windows
 *  95's is 950 as it was answered here */
const versionInfo = (p, at) => {
  const v = winVersion(p), w98 = v.minor >= 10;
  p.w32(at + 4, v.major); p.w32(at + 8, v.minor); p.w32(at + 12, w98 ? (v.major << 24 | v.minor << 16 | v.build) >>> 0 : v.build); p.w32(at + 16, 1);
  p.writeA(at + 20, w98 ? (v.build >= 2222 ? ' A ' : '') : ' B');
};
def('KERNEL32', 'GetVersion', 0, function () { const v = winVersion(this); return (0xc0000000 | v.minor << 8 | v.major) >>> 0; });
def('KERNEL32', 'GetVersionExA', 1, function (p) {
  versionInfo(this, p);
  const pc = this.thread16 && this.thread16.pc;
  if (pc && /\.SCR$/i.test(pc.path || '')) pc.versionInfoSeen = { size: this.r32(p), major: this.r32(p + 4), minor: this.r32(p + 8), build: this.r32(p + 12), platform: this.r32(p + 16) };
  return 1;
});
def('KERNEL32', 'LoadLibraryA', 1, function (n) {
  // (a name in quotes, as RUNDLL32 passes the one on its command line: "C:\WINDOWS\SYSTEM\DESK.CPL")
  const given = (this.readA(n) || '').trim().replace(/^"(.*)"$/, '$1'), name = given.toUpperCase().replace(/^.*\\/, '').replace(/\.DLL$/, '');
  // (a path: the file there, and the DLLs it imports looked for in its folder first, as LOAD_WITH_ALTERED_SEARCH_PATH
  // has it. Its folder was dropped: IERNONCE's C:\PROGRA~1\INTERN~1\HMMAPI.DLL was looked for in SYSTEM and the
  // Windows folder only, not found, and Windows 98's first start said it was not installed)
  // (a bare name: the calling program's folder, then the current directory, before SYSTEM and the Windows folder, as
  // Windows 95's LoadLibrary looks. Without them ACME's ACMSETUP.EXE did not find IE4.DLL beside it (error 126), ran
  // none of its custom actions, and Internet Explorer 4's every component failed to install)
  const pcNow = this.thread16 && this.thread16.pc, prog = String((pcNow && pcNow.path) || (this.exe && this.exe.meta && this.exe.meta.path) || '');
  let cwd = null; try { cwd = this.fs && this.fs.cwd; } catch (_) { /* none */ }
  const bare = given && !/\\/.test(given) ? [/\\/.test(prog) ? prog.replace(/\\[^\\]*$/, '') : null, cwd].filter(Boolean) : [];
  const dir = /\\/.test(given) ? given.replace(/\\[^\\]*$/, '') : null, was = this.loadDirs;
  const first = dir ? [dir] : bare;
  if (first.length) this.loadDirs = [...first, ...(was || []).filter(d => !first.some(f => f.toUpperCase() === d.toUpperCase()))];
  let native; try { native = this.loadDll(name); } finally { this.loadDirs = was; }
  // (a 16-bit DLL is no Win32 module: ERROR_BAD_EXE_FORMAT, as Windows 95's LoadLibrary answers, and RUNDLL32 then
  // loads it with LoadLibrary16 (KERNEL32 #35), finds the export with GetProcAddress16 (#37) and calls it through
  // SHELL32 #122. Given the module's place as a handle, RUNDLL32 took the 32-bit path and called GetProcAddress's 0:
  // PEEDY.EXE's "rundll32.exe setupx.dll,InstallHinfSection" faulted at 0)
  if (native && native.kind === 'ne') { this.lastError = 193; return 0; }
  // the process attaches to the library and to every DLL it uses, dependencies first, as Windows 95's LoadLibrary
  // does (a DLL another process loaded is attached to this one too: RUNDLL32 ran MMSYS.CPL on WINMM before the
  // shell's thread had attached WINMM, so WINMM's thunks to MMSYSTEM were not connected and it crashed in them)
  if (native) {
    // (called by the guest through the import, on a flat stack: the DllMains run as the thread's own code as the call
    // returns, dllChainStart)
    if (this.apiCall && this.apiCall.sp === u32(this.reg('esp')) && !(this.cpu.ss.value & 0xffff)) {
      const mods = [...new Set([...this.pendingInits(), ...this.importClosure(native)])];
      const done = this.pc.attached;
      if (mods.some(m => !(done && done.has(m)) && m.meta && !m.clock)) this.dllChain = mods;
      return native.base;
    }
    this.runPendingInits(); for (const m of this.importClosure(native)) this.attach(m); return native.base;
  }
  if (!API[name]) { this.lastError = 126; return 0; }   // ERROR_MOD_NOT_FOUND: neither a system DLL here nor one implemented in JS
  return this.jsDll(name);
});
def('KERNEL32', 'FreeLibrary', 1, function (h) {
  const dm = this.dataMods && this.dataMods.get(u32(h));   // (a file mapped as data: its copy given back)
  if (dm) { this.dataMods.delete(u32(h)); this.free(dm.block); return 1; }
  // (a DLL stays mapped: one copy serves every process here, and a freed one was still used, by another process's
  // calls, by a thread it had started (QUARTZ's), or by pointers taken from it; the room it takes is the arena's or
  // the address space above the heap's, imageRoom)
  return 1;
});
// (an export of a DLL loaded from its file answered here instead: kept out of API, where a name is a whole DLL's
// stand-in. RUNDLL32's entry: hwnd, hinst, command line, show; done, nothing to install)
const STANDIN_EXPORTS = { MSJAVA: { JavaPkgMgr_Install: [4, function () { return 0; }] } };
def('KERNEL32', 'GetProcAddress', 2, function (h, name) {
  const nm = name >>> 16 ? this.readA(name) : '#' + name;
  const native = this.modules.find(x => x.base === this.hmod(h));
  // (an export a stand-in answers in place of the module's own: MSJAVA's JavaPkgMgr_Install, the Java packages
  // Windows 98 Setup installs through RUNDLL32 at the first start, not installed: "Unable to install Java packages")
  const own = native && STANDIN_EXPORTS[native.name.toUpperCase().replace(/\.DLL$/, '')];
  if (own && own[nm]) {
    const key = 'MSJAVA!' + nm;
    if (!this.thunkByName.has(key)) { this.thunkByName.set(key, LAYOUT.THUNK + this.thunks.length * 4); this.thunks.push({ dll: 'MSJAVA', nm, def: own[nm] }); }
    return this.thunkByName.get(key);
  }
  if (native) return this.exportOf(native, nm);
  const m = this.standinAt(h) || this.obj(0x0000ffff & h) || { name: 'KERNEL32' };
  return API[m.name] && this.importDef(m.name, nm) ? this.thunkFor(m.name, nm) : 0;
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
/** an exception (code, at `eip`, its parameters) through the thread's structured handlers, as KERNEL32 dispatches one.
 *  Each handler is called by the thread itself, its return coming back to SEH_CONT (sehStep), not as a call the host
 *  makes: a handler that takes the exception (MSVC's _except_handler3: RtlUnwind, then its __except block) never
 *  returns, and the program runs on as itself. Called as the host's, QUARTZ's MMX probe (EMMS under its own handler)
 *  ran on inside the call: REGSVR32's message box and its message loop, the machine answering nothing. The address to
 *  go on at (the first handler's), or null when the thread's chain has none. When every handler declines: the fault's
 *  dialog for `fault` (a processor exception), else the exception `code` at `eip` (RaiseException's) */
function sehStart(p, code, eip, params, fault, flags) {
  p.sehFault = fault;
  const sp = u32(p.reg('esp')), rec = (sp - 0x400) & ~15, ctx = rec + 0x60, n = Math.min(params.length, 15);
  // (a stack pointer that is no address the machine has: nothing can be pushed for a handler, the fault is not
  // handled, the program's fault dialog takes it rather than the machine ending)
  if (sp < 0x10000 || sp > p.u8.length) return null;
  // (the dispatches whose records are now below the stack are over: their handler took the exception and the program
  // ran on above them)
  // (each thread's own: the machine's threads share the process object, and another thread's dispatch, its record
  // higher in memory, was taken for an outer one of this thread's, its search begun in that thread's chain)
  const live = p.sehLive || (p.sehLive = new Map()), tibNow = p.cpu.fs.value;
  for (const [r, s] of live) if (s.tib === tibNow && r < sp) live.delete(r);
  p.u8.fill(0, rec, rec + 0x50);
  p.w32(rec, code); p.w32(rec + 4, flags & 1); p.w32(rec + 12, eip); p.w32(rec + 16, n);
  for (let i = 0; i < n; i++) p.w32(rec + 20 + 4 * i, params[i]);
  sehContext(p, ctx, eip, sp);
  // (an exception raised inside a handler, nested: its search starts above the frame whose handler is running, as
  // KERNEL32's dispatcher skips the frames it is already in, EXCEPTION_NESTED_CALL. Searched from the chain's head, a
  // handler that faulted was asked about its own fault, and again, until the page's stack ran out)
  let nested = 0; for (const s of live.values()) if (s.tib === tibNow && s.f && s.rec > sp) nested = s.f;
  if (nested) p.w32(rec + 4, (flags & 1) | 0x10);
  const st = { rec, ctx, sp, f: 0, nested, fault, code, eip, tib: tibNow };   // (plain data: a moment keeps it)
  live.set(rec, st);
  if (p.hookDllChain) p.hookDllChain();
  return sehNext(p, st);
}
/** the next frame's handler called for dispatch `st`: its address, the frame and the call's arguments on the stack below
 *  the record, its return to SEH_CONT; null when the chain has no more (the stack as the exception found it) */
function sehNext(p, st) {
  // a frame off the thread's stack (the TIB's top and limit; past the end of memory) ends the chain, as KERNEL32
  // takes it: what the frames before it did not handle is not handled
  const tib = st.tib, end = p.mem.buffer.byteLength, top = p.r32(tib + 4), limit = p.r32(tib + 8);
  const onStack = f => f + 8 <= end && !(top > limit && (f < limit || f + 8 > top));
  const f = st.f ? p.r32(st.f) : st.nested ? p.r32(st.nested) : p.r32(tib);
  if (f === SEH_END || !f || !onStack(f)) { p.sehLive.delete(st.rec); p.reg('esp', st.sp); return null; }
  st.f = f;
  p.reg('esp', st.rec - 0x40);
  p.push(0); p.push(st.ctx); p.push(f); p.push(st.rec); p.push(SEH_CONT);
  return p.r32(f + 4);
}
/** a handler returned (EAX: 0 continue execution where the context says, 1 continue the search): where to go on */
function sehStep(p) {
  const sp = u32(p.reg('esp')), rec = p.r32(sp), st = p.sehLive && p.sehLive.get(rec);
  if (!st) throw new GuestError(`an exception handler returned to a dispatch that is over (record ${rec.toString(16)})`);
  if (p.reg('eax') === 0) {
    p.sehLive.delete(rec);
    for (const [rg, o] of Object.entries(CTX)) p.reg(rg, p.r32(st.ctx + o));
    p.reg('esp', p.r32(st.ctx + 0xc4)); return p.r32(st.ctx + 0xb8);
  }
  const go = sehNext(p, st);
  if (go !== null) return go;
  throw sehUnhandled(p, st.fault, st.code, st.eip);
}
/** nothing handled it: KERNEL32's unhandled-exception path ends the program with its fault dialog */
function sehUnhandled(p, fault, code, eip) {
  if (fault) return new FaultError(fault);
  const f = p.faultInfo(0, eip, 0); f.code = code; f.why = `exception ${u32(code).toString(16)} at ${u32(eip).toString(16)}`; return new FaultError(f);
}
def('KERNEL32', 'RaiseException', 'regs', function () {
  const sp = u32(this.reg('esp')), ret = this.r32(sp), code = this.r32(sp + 4), flags = this.r32(sp + 8), n = Math.min(this.r32(sp + 12), 15), argv = this.r32(sp + 16);
  const params = []; for (let i = 0; i < n; i++) params.push(this.r32(argv + 4 * i));
  this.reg('esp', sp + 20);
  const r = sehStart(this, code, ret, params, null, flags);
  if (r !== null) return r;
  throw sehUnhandled(this, null, code, ret);
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
// (two reads are never the same count: a read of the timer chip takes a few of its ticks, 5 microseconds or so on
// the machines of the day. The clock here moves a millisecond at a time: Windows 98's WELCOME times a short loop
// between two reads to rate the processor, found no time had passed, and divided by it)
def('KERNEL32', 'QueryPerformanceCounter', 1, function (p) { let t = Math.floor((this.progTime('tick') - 3600000) * 1193.182); if (t < (this.qpcLast || 0) + 6) t = this.qpcLast + 6; this.qpcLast = t; this.w32(p, t % 4294967296); this.w32(p + 4, Math.floor(t / 4294967296)); return 1; });
def('KERNEL32', 'QueryPerformanceFrequency', 1, function (p) { this.w32(p, 1193182); this.w32(p + 4, 0); return 1; });
def('KERNEL32', 'IsBadStringPtrW', 2, function (a) { return !a || a >= this.mem.buffer.byteLength ? 1 : 0; });
def('KERNEL32', 'RtlFillMemory', 3, function (d, n, v) { this.u8.fill(v & 0xff, d, d + n); });
// #87: whether the calling thread holds the Win16 lock (never for a Win32 thread); #88 (bytes of arguments, flags,
// function, arguments...): the function called with the arguments, on the caller's stack for a Win32 thread
def('KERNEL32', '#87', 0, () => 0);
def('KERNEL32', '#88', -1, function (cb, flags, fn) { const sp = this.reg('esp'), a = []; for (let i = 0; i < cb >> 2; i++) a.push(this.r32(sp + 16 + 4 * i)); return this.call(fn, a); });
def('KERNEL32', 'RtlUnwind', 'regs', function () {
  const sp = u32(this.reg('esp')), ret = this.r32(sp), target = this.r32(sp + 4), given = this.r32(sp + 12), value = this.r32(sp + 16);
  const keep = ['ebx', 'esi', 'edi', 'ebp'].map(r => [r, this.reg(r)]);
  // (a handler unwinding has taken its exception: the thread's dispatches below the target frame are over, as the
  // program runs on above them. Left, QUARTZ's next MMX probe, deeper in the stack, was taken for one raised inside
  // the first's handler and its search began past QUARTZ's own frame: unhandled)
  if (this.sehLive) { const tib = this.cpu.fs.value; for (const [r, s] of this.sehLive) if (s.tib === tib && (!target || r < u32(target))) this.sehLive.delete(r); }
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
  const top = topFilterOf(this);
  if (top.fn) { const r = this.call(top.fn, [ptrs]); if (r !== 0) return r; }
  const rec = this.r32(ptrs), ctx = this.r32(ptrs + 4);
  const f = this.sehFault && this.sehFault.eip === this.r32(rec + 12) ? this.sehFault : this.faultInfo(0, this.r32(rec + 12), 0);
  if (!this.sehFault || f !== this.sehFault) { f.code = this.r32(rec); for (const [r, o] of Object.entries(CTX)) f.regs[r] = this.r32(ctx + o); }
  if (this.host.faultDialog) this.host.faultDialog(f);
  return 1;
});
// (each process's own, as KERNEL32 keeps it in the process: one for the machine, the second REGSVR32 to load MSVCRT
// was given MSVCRT's own filter as the one before it, and the filter called itself until the stack ran out)
const topFilterOf = p => { const pc = p.thread16 && p.thread16.pc; return pc ? (pc.topFilter || (pc.topFilter = { fn: 0 })) : (p.topFilterMain || (p.topFilterMain = { fn: 0 })); };
def('KERNEL32', 'SetUnhandledExceptionFilter', 1, function (fn) { const top = topFilterOf(this), was = top.fn || 0; top.fn = fn; return was; });
// GetSystemPowerStatus(SYSTEM_POWER_STATUS*): on mains, no battery (Task Scheduler's MSTASK asks at its start)
def('KERNEL32', 'GetSystemPowerStatus', 1, function (p) {
  this.u8[p] = 1; this.u8[p + 1] = 128; this.u8[p + 2] = 255; this.u8[p + 3] = 0; this.w32(p + 4, 0xffffffff); this.w32(p + 8, 0xffffffff); return 1;
});
def('KERNEL32', 'GetLastError', 0, function () { return this.lastError || 0; });
def('KERNEL32', 'SetLastError', 1, function (e) { this.lastError = e; });
// Global and local memory (one heap in Win32): a fixed block's handle is its address; a moveable one's (GMEM_MOVEABLE,
// LMEM_MOVEABLE) is a cell of its own holding the block's address, the same handle however often the block moves as it
// grows. A memory stream (OLE32's CreateStreamOnHGlobal) grows its block by GlobalReAlloc while whoever made the
// stream keeps its handle (GetHGlobalFromStream): the handle as the block's old address read the freed block, and
// OLEAUT32 took a VB form's icon for an invalid picture
const MOVEABLE = 2, ZEROINIT = 0x40, MODIFY = 0x80, DISCARDED = 0x4000;
const gmov = (p, h) => p.gmov && p.gmov.get(u32(h));
function memAlloc(f, n) {
  const ptr = this.alloc(n);
  if (!(f & MOVEABLE)) return ptr;
  const h = this.alloc(8); this.w32(h, ptr);
  (this.gmov || (this.gmov = new Map())).set(h, { ptr, size: n, locks: 0 }); return h;
}
function memFree(h) {
  if (g16(this, h)) { const f16 = window.W95NE16 && window.W95NE16.K16['KERNEL.#17']; if (f16) f16[2].call(this, u32(h)); return 0; }   // (a 16-bit block's: GlobalFree16)
  const m = gmov(this, h);
  if (m) { if (m.ptr) this.free(m.ptr); this.gmov.delete(u32(h)); this.free(h); return 0; }
  this.free(h); return 0;
}
function memReAlloc(h, n, f) {
  const m = gmov(this, h);
  if (f & MODIFY) return h;   // (its flags alone)
  if (!m) return this.realloc(h, n);
  if (!n) { if (m.ptr) this.free(m.ptr); m.ptr = 0; m.size = 0; this.w32(h, 0); return h; }   // (discarded: the handle stays)
  const old = m.size; m.ptr = m.ptr ? this.realloc(m.ptr, n) : this.alloc(n);
  if (n > old && f & ZEROINIT) this.u8.fill(0, m.ptr + old, m.ptr + n);
  m.size = n; this.w32(h, m.ptr); return h;
}
// (a handle below 64K is a 16-bit global block's, as Windows 95's KERNEL32 takes one: GDI's metafiles are 16-bit
// blocks, and Desktop Themes locks the one a graphics filter made of the theme's wallpaper (JPEGIM32.FLT ImportGr):
// locked as an address, it drew nothing, and the preview's desktop was black)
const g16 = (p, h) => (u32(h) && u32(h) < 0x10000 && p.ghandles && p.gblock && p.gblock(u32(h))) || null;
const memLock = function (h) { const b = g16(this, h); if (b) return b.lin; const m = gmov(this, h); if (!m) return h; if (m.ptr) m.locks++; return m.ptr; };
const memUnlock = function (h) { const m = gmov(this, h); if (!m) return 0; if (m.locks) m.locks--; return m.locks; };
const memSize = function (h) { const b = g16(this, h); if (b) return b.size; const m = gmov(this, h); return m ? m.size : this.allocs.get(h) || 0; };
const memHandle = function (p) { if (this.gmov) for (const [h, m] of this.gmov) if (m.ptr === u32(p)) return h; return p; };
const memFlags = function (h) { const m = gmov(this, h); return m ? (m.ptr ? 0 : DISCARDED) | (m.locks & 0xff) : 0; };
for (const k of ['Global', 'Local']) {
  def('KERNEL32', k + 'Alloc', 2, memAlloc); def('KERNEL32', k + 'Free', 1, memFree); def('KERNEL32', k + 'ReAlloc', 3, memReAlloc);
  def('KERNEL32', k + 'Lock', 1, memLock); def('KERNEL32', k + 'Unlock', 1, memUnlock); def('KERNEL32', k + 'Size', 1, memSize);
  def('KERNEL32', k + 'Handle', 1, memHandle); def('KERNEL32', k + 'Flags', 1, memFlags);
}
def('KERNEL32', 'HeapCreate', 3, () => 0x5000);
def('KERNEL32', 'HeapDestroy', 1, () => 1);
def('KERNEL32', 'GetProcessHeap', 0, () => 0x5000);
def('KERNEL32', 'HeapAlloc', 3, function (h, f, n) { return this.alloc(n, true); });
// (HEAP_REALLOC_IN_PLACE_ONLY, 10h: a block that would have to move stays where it is and the call fails, as Windows'
// does. Moved and freed instead, the caller went on using the old address, its memory another's next allocation)
def('KERNEL32', 'HeapReAlloc', 4, function (h, f, p, n) {
  if (f & 0x10 && p && n > (this.allocs.get(p) || 0)) { this.lastError = 8; return 0; }
  return this.realloc(p, n);
});
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
  const size = (n + 0xffff) & ~0xffff, regions = this.vregions || (this.vregions = new Map());
  let heap = null;
  // (on a 64 KiB boundary, Windows' allocation granularity, from the room ended processes gave back or the top
  // (vmRoom: a spare piece's rest stays spare). MSO's allocator (MSONSEXT's) finds a block's header by masking its
  // address to 64 KiB: a region at the top as the block tables left it, 4 KiB aligned, read no header, and faulted)
  let b = this.vmTop ? this.vmRoom(size, 0x10000) : 0;
  if (!b) { try { heap = this.alloc(size + 0xffff, true); b = (heap + 0xffff) & ~0xffff; } catch (e) { if (!(e instanceof GuestError)) throw e; heap = 0; b = 0; } }
  // (no room for it: 0, as Windows answers, said in the log with its size and caller, once per size. Unsaid, WINHLP32's
  // own heap, which doubles its reservation as it grows, failed with nothing to show where)
  if (!b) {
    const said = this.vaFailSaid || (this.vaFailSaid = new Set());
    if (!said.has(size)) { said.add(size); log('warn', 'win32', `VirtualAlloc: no room for ${(size >>> 0).toString(16)}h bytes, called from ${this.whereOf(this.r32(this.reg('esp')))}`); }
    this.lastError = 8; return 0;
  }
  // (pc: the process whose own program reserved it, the caller's return address in its image, or a DLL whose
  // writable data is each process's own (priv: MSVCRT's, OLEAUT32's from their files, whose heaps' 4 MB reservations
  // their data holds): it goes when that process ends. What a DLL of one copy reserves (SHELL32's, DESK.CPL's) is the
  // DLL's, kept. MSVCRT's heap in every RUNDLL32 and REGSVR32 was kept: Windows 98's first start ran out of memory)
  const pc = this.pc, e = pc && pc.exe, ret = this.r32(this.reg('esp'));
  const by = !(e && ret >= e.base && ret < e.base + (e.size || 0)) && (this.modules || []).find(x => !x.hidden && !x.segs && x.size && ret >= x.base && ret < x.base + x.size);
  this.vmCheck(b, size, 'VirtualAlloc');
  regions.set(b, { size, heap, pc: e && ret >= e.base && ret < e.base + (e.size || 0) ? pc : by && by.priv && pc ? pc : null });
  this.vmAudit('VirtualAlloc');
  return b;
});
def('KERNEL32', 'VirtualFree', 3, function (p, n, type) {
  const r = type & 0x8000 && this.vregions && this.vregions.get(p);
  if (r) { this.vregions.delete(p); if (!r.heap) this.vmCheck(p, r.size, 'VirtualFree'); if (r.heap) this.free(r.heap); else (this.vspare || (this.vspare = [])).push({ base: p, size: r.size }); this.vmAudit('VirtualFree'); }
  return 1;
});
// VirtualProtect: memory here has no page protection, every page readable, writable and runnable; the protection a
// page was last given is kept and answered as the old one (PAGE_EXECUTE_READWRITE before any), so a caller that puts
// back what it found (MSVBVM50 writing its thunks into code) puts back its own
def('KERNEL32', 'VirtualProtect', 4, function (a, n, prot, old) {
  if (!n || !a) { this.lastError = 87; return 0; }
  const prots = this.vprots || (this.vprots = new Map()), first = u32(a) >>> 12, last = (u32(a) + u32(n) - 1) >>> 12;
  if (old) this.w32(old, prots.has(first) ? prots.get(first) : 0x40);
  for (let pg = first; pg <= last; pg++) prots.set(pg, prot);
  return 1;
});
// VirtualQuery: the region an address is in, as MEMORY_BASIC_INFORMATION (28 bytes): a reservation of VirtualAlloc's,
// a module's image (MEM_IMAGE), a thread's stack, else the 4 KiB page it is on, committed; the protection the page
// was given (VirtualProtect), else PAGE_EXECUTE_READWRITE
def('KERNEL32', 'VirtualQuery', 3, function (a, buf, len) {
  if (!buf || len < 28) { this.lastError = 24; return 0; }
  a = u32(a);
  let base = a & ~0xfff, size = 0x1000, alloc = base, type = 0x20000;   // MEM_PRIVATE
  const r = this.vregions && [...this.vregions].find(([b, x]) => a >= b && a < b + x.size);
  const m = !r && (this.modules || []).find(x => x.size && a >= x.base && a < x.base + x.size);
  const t = !r && !m && this.threadsById && [...this.threadsById.values()].find(x => x.stackBase && a >= x.stackBase && a < x.stackBase + (x.stack || x.stackSize || 0));
  if (r) { alloc = r[0]; base = r[0]; size = r[1].size; }
  else if (m) { alloc = m.base; base = m.base; size = m.size; type = 0x1000000; }   // MEM_IMAGE
  else if (t) { alloc = t.stackBase; base = t.stackBase; size = t.stack || t.stackSize; }
  const prot = this.vprots && this.vprots.has(a >>> 12) ? this.vprots.get(a >>> 12) : 0x40;
  [base, alloc, 0x40, size, 0x1000, prot, type].forEach((v, i) => this.w32(buf + 4 * i, v));   // MEM_COMMIT
  return 28;
});
// the wide calls Windows 98's KERNEL32 has only as stubs: they fail, ERROR_CALL_NOT_IMPLEMENTED, as there
for (const [nm, n] of [['GetModuleFileNameW', 3], ['CreateProcessW', 10], ['FormatMessageW', 7]]) def('KERNEL32', nm, n, function () { this.lastError = 120; return 0; });
def('KERNEL32', 'lstrcmpiW', 2, function (a, b) {
  const x = (this.readW(a) || '').toLowerCase(), y = (this.readW(b) || '').toLowerCase();
  return x < y ? -1 >>> 0 : x > y ? 1 : 0;
});
def('KERNEL32', 'lstrlenA', 1, function (p) { return p ? this.readA(p).length : 0; });
def('KERNEL32', 'lstrcpyA', 2, function (d, s) { this.writeA(d, this.readA(s) || ''); return d; });
def('KERNEL32', 'lstrcpynA', 3, function (d, s, n) { this.writeA(d, this.readA(s) || '', n); return d; });
def('KERNEL32', 'lstrcatA', 2, function (d, s) { this.writeA(d, (this.readA(d) || '') + (this.readA(s) || '')); return d; });
def('KERNEL32', 'lstrcmpiA', 2, function (a, b) { const x = (this.readA(a) || '').toLowerCase(), y = (this.readA(b) || '').toLowerCase(); return x < y ? -1 >>> 0 : x > y ? 1 : 0; });
// Windows' order of two strings: their letters first, whatever their case; the same letters, the one with the lower
// case at the first place they differ comes first ("version" before "Version"). -1, 0 or 1. By character code, the
// capital came first: SETUPAPI's string table, its chains kept in this order, found "Version" where it looked for
// "version", no section of any INF was found, and nothing Setup installs through it was registered
const strOrder = (x, y, ci) => {
  const X = x.toLowerCase(), Y = y.toLowerCase();
  if (X !== Y) return X < Y ? -1 : 1;
  if (ci) return 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] === X[i] ? -1 : 1;
  return 0;
};
def('KERNEL32', 'lstrcmpA', 2, function (a, b) { return strOrder(this.readA(a) || '', this.readA(b) || '', false) >>> 0; });
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
// IsBadReadPtr / IsBadWritePtr: no bytes asked for is never bad, whatever the pointer (Windows answers 0 for a count of
// 0): OLE32's IsClassOfCategories checks a required list of none, NULL, that way; told it was bad it answered
// E_POINTER, MSHTML took the Active Desktop Mover (marked safe for scripting) for a control not marked safe, and the
// desktop asked "Some software (ActiveX controls) on this page might be unsafe" each time it was made
def('KERNEL32', 'IsBadReadPtr', 2, function (a, n) { return n && (!a || a + n > this.mem.buffer.byteLength) ? 1 : 0; });
def('KERNEL32', 'IsBadWritePtr', 2, function (a, n) { return n && (!a || a + n > this.mem.buffer.byteLength) ? 1 : 0; });
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
    // (a list longer than the buffer: as much as fits, the last name cut, two NULs, and nSize - 2, as Windows answers.
    // Stopped at the first name that did not fit, it answered 0: IE4WZD asks with a small buffer whether [Options.WIN]
    // has keys, took it for empty, took JobName from [Options] (Job1, no such job), and IE 4's setup said the network
    // was busy: InitializeJob's E_OUTOFMEMORY, INSENG copying the job's missing CabName)
    const all = names.map(nm => nm + '\0').join('');
    if (all.length + 1 <= n) { for (let i = 0; i < all.length; i++) this.u8[buf + i] = all.charCodeAt(i) & 0xff; this.u8[buf + all.length] = 0; if (!all.length && n > 1) this.u8[buf + 1] = 0; return all.length; }
    if (n < 2) { this.u8[buf] = 0; return 0; }
    for (let i = 0; i < n - 2; i++) this.u8[buf + i] = all.charCodeAt(i) & 0xff;
    this.u8[buf + n - 2] = 0; this.u8[buf + n - 1] = 0;
    return n - 2;
  }
  const v = iniGet(this.fs, this.readA(file), this.readA(sec), this.readA(key));
  return this.writeA(buf, v === null ? (this.readA(dflt) || '') : v.replace(/^(["'])([^]*)\1$/, '$2'), n);   // (one pair of quotes taken off, as Windows does)
});
def('KERNEL32', 'WritePrivateProfileStringA', 4, function (sec, key, val, file) {
  if (this.iniIntent) this.iniIntent(file ? this.readA(file) : 'WIN.INI', this.readA(sec), key ? this.readA(key) : null, val ? this.readA(val) : null, null);
  try { iniSet(this.fs, this.readA(file), this.readA(sec), key ? this.readA(key) : null, val ? this.readA(val) : null); return 1; } catch (_) { return 0; }
});
// WritePrivateProfileSection(section, lines, file): the section's lines replaced by these (each NUL-terminated, then a
// NUL); a null list takes the section away
def('KERNEL32', 'WritePrivateProfileSectionA', 3, function (sec, data, file) {
  try {
    const f = this.readA(file), s = this.readA(sec);
    iniSet(this.fs, f, s, null, null);
    for (let a = data; a && this.u8[a];) {
      const l = this.readA(a), m = /^([^=]*)=(.*)$/.exec(l); a += l.length + 1;
      if (m) iniSet(this.fs, f, s, m[1].trim(), m[2]); else iniAddLine(this.fs, f, s, l);
    }
    return 1;
  } catch (_) { return 0; }
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
// a process's place in the shutdown order (level, flags), as Windows 98's Explorer sets its own at start; kept for the
// process and read back (default level 280h, no flags)
def('KERNEL32', 'SetProcessShutdownParameters', 2, function (level, flags) { const pc = this.pc || this; pc.shutdownParams = [level, flags]; return 1; });
def('KERNEL32', 'GetProcessShutdownParameters', 2, function (pl, pf) { const pc = this.pc || this, [l, f] = pc.shutdownParams || [0x280, 0]; if (pl) this.w32(pl, l); if (pf) this.w32(pf, f); return 1; });
/** the module whose resources handle `m` names: the process's own program for 0, else the module at that handle,
 *  none for a handle no module of this process has (1813). Not the program's in its place: Explorer copying
 *  MSTASK's tray icon from its resource (CopyImage, LR_COPYFROMRESOURCE) found its own icon 403, a computer, and the
 *  tray showed it in place of the Task Scheduler's */
const resModule = (p, m) => {
  if (!m) return p.moduleFor(0);
  if (!(m >>> 16) && p.mod16 && p.mod16(m)) return p.mod16(m);   // (a module's 16-bit handle, as USER keeps it: that module)
  const mod = p.moduleFor(m), h = u32(p.hmod(m));
  if (!mod || (u32(mod.base) !== h && !(p.dataMods && p.dataMods.get(h)))) { p.lastError = 1813; return null; }   // ERROR_RESOURCE_TYPE_NOT_FOUND
  return mod;
};
/** a resource of module mod: its place in mod's image; for a program whose image is not the one in place (another
 *  process's, put by in the arena they share) a copy made while its image is, kept with the module, so LoadResource and
 *  LockResource read its bytes and not the program at its base in this process */
const resIn = (p, mod, type, name) => {
  if (!mod.hidden || !p.withImage) return p.findResource(type, name, mod);
  const key = `${type}:${name}`, kept = (mod.resCopies || (mod.resCopies = new Map())).get(key); if (kept) return kept;
  const got = p.withImage(mod, () => { const r = p.findResource(type, name, mod); return r && p.u8.slice(r.addr, r.addr + r.size); });
  if (!got) return null;
  const addr = p.alloc(got.length || 1); p.u8.set(got, addr);
  const r = { addr, size: got.length }; mod.resCopies.set(key, r); return r;
};
def('KERNEL32', 'FindResourceA', 3, function (m, name, type) {
  const mod = resModule(this, m); if (!mod) return 0;
  const r = resIn(this, mod, this.resName(type), this.resName(name)); if (!r) return 0;
  return this.newHandle({ kind: 'res', ...r });
});
// FindResourceW: Windows 98's KERNEL32 has it (its own code, not the common stub), names in UTF-16 or by number (RUNONCE's
// call was a dead thunk, and RUNONCE ended on Windows 98's first start)
def('KERNEL32', 'FindResourceW', 3, function (m, name, type) {
  const n = p => (p >>> 16 ? this.readW(p) : p);
  const mod = resModule(this, m); if (!mod) return 0;
  const r = resIn(this, mod, n(type), n(name)); if (!r) return 0;
  return this.newHandle({ kind: 'res', ...r });
});
// the resource directory's levels enumerated to a callback: types, a type's names, a name's languages, each callback
// returning FALSE to stop. A name or type that is a string goes to the callback as a pointer to it (ANSI or UTF-16 as
// the call is), a number as itself. (Windows 98's first start: RUNDLL32's registrations called
// EnumResourceLanguagesA, an import this KERNEL32 did not have, and three RUNDLL32s faulted at its dead thunk)
const resLevel = (p, mod, dir) => {
  const root = mod.base + mod.rsrc, nn = p.r16(dir + 12), ni = p.r16(dir + 14), out = [];
  for (let i = 0; i < nn + ni; i++) {
    const e = dir + 16 + 8 * i, nm = p.r32(e), off = p.r32(e + 4);
    out.push({ key: nm & 0x80000000 ? p.readW(root + (nm & 0x7fffffff) + 2, p.r16(root + (nm & 0x7fffffff))) : nm, sub: off & 0x80000000 ? root + (off & 0x7fffffff) : 0 });
  }
  return out;
};
const resPick = (list, key) => list.find(e => typeof key === 'string' ? typeof e.key === 'string' && e.key.toUpperCase() === key.toUpperCase() : e.key === key) || null;
function resEnum(p, wide, h, keys, cb, lp) {
  const mod = p.moduleFor(h); if (!mod || !mod.rsrc) { p.lastError = 1812; return 0; }   // ERROR_RESOURCE_DATA_NOT_FOUND
  let dir = mod.base + mod.rsrc;
  for (const k of keys) { const e = resPick(resLevel(p, mod, dir), k); if (!e || !e.sub) { p.lastError = keys.indexOf(k) ? 1814 : 1813; return 0; } dir = e.sub; }   // ERROR_RESOURCE_NAME/TYPE_NOT_FOUND
  const tmp = [], arg = v => { if (typeof v !== 'string') return v; const a = p.alloc(2 * v.length + 2); if (wide) { for (let i = 0; i < v.length; i++) p.w16(a + 2 * i, v.charCodeAt(i)); p.w16(a + 2 * v.length, 0); } else p.writeA(a, v, v.length + 1); tmp.push(a); return a; };
  try {
    const fixed = keys.map(arg);
    for (const e of resLevel(p, mod, dir)) if (!p.call(cb, [h, ...fixed, arg(e.key), lp])) break;
  } finally { for (const a of tmp) p.free(a); }
  return 1;
}
const resKey = (p, v, wide) => (v >>> 16 ? (wide ? p.readW(v) : p.readA(v)) : v);
def('KERNEL32', 'EnumResourceTypesA', 3, function (h, cb, lp) { return resEnum(this, false, h, [], cb, lp); });
def('KERNEL32', 'EnumResourceTypesW', 3, function (h, cb, lp) { return resEnum(this, true, h, [], cb, lp); });
def('KERNEL32', 'EnumResourceNamesA', 4, function (h, type, cb, lp) { return resEnum(this, false, h, [resKey(this, type, false)], cb, lp); });
def('KERNEL32', 'EnumResourceNamesW', 4, function (h, type, cb, lp) { return resEnum(this, true, h, [resKey(this, type, true)], cb, lp); });
def('KERNEL32', 'EnumResourceLanguagesA', 5, function (h, type, name, cb, lp) { return resEnum(this, false, h, [resKey(this, type, false), resKey(this, name, false)], cb, lp); });
def('KERNEL32', 'EnumResourceLanguagesW', 5, function (h, type, name, cb, lp) { return resEnum(this, true, h, [resKey(this, type, true), resKey(this, name, true)], cb, lp); });
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
def('KERNEL32', 'GetTempFileNameA', 4, function (dir, pre, uniq, out) {
  // (uUnique 0: a number not in use, counted up from the clock's until the name is free, and the file made empty, as
  // Windows does. Taken from the clock alone, two calls in one millisecond had one name: WinHelp's index (-g) made its
  // second file over the first, "(null) (2)", its rcExists)
  const d = (this.readA(dir) || 'C:\\WINDOWS\\TEMP').replace(/\\$/, ''), pfx = (this.readA(pre) || '').slice(0, 3);
  const nameOf = v => `${d}\\${pfx}${v.toString(16).toUpperCase().padStart(4, '0')}.TMP`;
  let u = uniq & 0xffff;
  if (!u) {
    u = (Date.now() & 0xffff) || 1;
    for (let k = 0; k < 0xffff && this.fs.exists(nameOf(u)); k++) u = (u & 0xffff) === 0xffff ? 1 : u + 1;
    const nm = nameOf(u); fsCall(this, () => this.fs.writeFile(nm, new Uint8Array(0)));
  }
  this.writeA(out, nameOf(u), 260); return u;
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
// (every thread its own slots: one machine-wide set for threads not flagged flat let another thread's OLEAUT32 clear
// the slot REGSVR32's had just set, and SysAllocString read its per-thread block at 0)
// (keyed by the thread information block FS points at, the processor's own idea of which thread runs: a call that ran
// other threads inside it left the record of the current thread another's, and OLEAUT32's slot was set in that one)
const tlsOf = p => {
  const fs = p.cpu.fs.value >>> 0, m = p.tlsByTib || (p.tlsByTib = new Map());
  if (!m.has(fs)) m.set(fs, []); return m.get(fs);
};
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
// (the defaults by their names, 0 the user's; a neutral sublanguage its language's default; any other as it is)
def('KERNEL32', 'ConvertDefaultLocale', 1, lc => {
  lc >>>= 0;
  if (lc === 0 || lc === 0x400 || lc === 0x800) return 0x409;
  return (lc & 0xfc00) === 0 ? (lc & 0xffff03ff) | 0x400 : lc;
});
// the system's language, as its locale's (Windows 98's KERNEL32 reads it from a word of its data, the system locale's
// LANGID: mov ax,[...]; ret); 27 of Windows 98's files import it, and none could start past it
def('KERNEL32', 'GetSystemDefaultLangID', 0, () => 0x409);
// lstrcatW: Windows 98's KERNEL32 has it (its own code, not the common stub): the source after the destination's text
def('KERNEL32', 'lstrcatW', 2, function (d, s) { const t = (this.readW(d) || '') + (this.readW(s) || ''); for (let i = 0; i <= t.length; i++) this.w16(d + 2 * i, i < t.length ? t.charCodeAt(i) : 0); return d; });
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
  return strOrder(x, y, !!(f & 1)) + 2;
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
// SetTimeZoneInformation(TIME_ZONE_INFORMATION *): the zone recorded as Windows 95 keeps it, HKLM\System\
// CurrentControlSet\control\TimeZoneInformation (Bias, StandardName and DaylightName, their biases, StandardStart and
// DaylightStart as SYSTEMTIMEs, ActiveTimeBias); TRUE. The clock stays the host's. Date/Time Properties sets it on
// Windows 95 Setup's first start (TIMEDATE.CPL), and was ended there by the call with no stand-in
def('KERNEL32', 'SetTimeZoneInformation', 1, function (p) {
  if (!p) { this.lastError = 87; return 0; }
  const key = 'hklm\\system\\currentcontrolset\\control\\timezoneinformation', bias = this.r32(p) | 0;
  const name = o => this.readW(p + o, 32) || '', st = o => ({ type: 3, data: this.u8.slice(p + o, p + o + 16) });
  regSet(key, 'Bias', regVal(u32(bias))); regSet(key, 'StandardName', regVal(name(4))); regSet(key, 'StandardStart', st(132));
  regSet(key, 'StandardBias', regVal(this.r32(p + 148))); regSet(key, 'DaylightName', regVal(name(152))); regSet(key, 'DaylightStart', st(280));
  regSet(key, 'DaylightBias', regVal(this.r32(p + 296))); regSet(key, 'ActiveTimeBias', regVal(u32(bias)));
  return 1;
});
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
/** whether two files are the same bytes */
function sameBytes(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
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
    // (FILE_FLAG_DELETE_ON_CLOSE, 4000000h: the file goes when its handle is closed. ADVPACK tries whether a folder
    // takes files so, with TMP4352$.TMP: kept, one was left in the Temp, Desktop and StartUp folders, and the one
    // in StartUp was opened as Windows 98 logged on)
    return this.newHandle({ kind: 'file', fd: this.fs.open(path, mode), path, delOnClose: !!(flags & 0x4000000) });
  }, 0xffffffff);
});
def('KERNEL32', 'CloseHandle', 1, function (h) {
  const f = fileOf(this, h); if (f && !(f.refs > 1)) fsCall(this, () => { this.fs.close(f.fd); if (f.delOnClose) this.fs.unlink(f.path); }); else if (f) f.refs--;
  const c = commOf(this, h); if (c) vcomm(this, 18, [c.vh]);
  const m = this.obj(h); this.handles.delete(h);
  if (m && m.name) { if (this.namedOwner) this.namedOwner.delete(h); namedGone(this, m); }
  // (a file's mapping goes with its last handle, and its data with it)
  if (m && m.kind === 'mapping') { if (m.file) mapFlush(this, m); mapGone(this, m); }
  if (m && m.kind === 'socket' && m.ctx) socketGone(this, m);
  return 1;
});
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
// SetFilePointer: the distance a signed 64-bit one with *lpDistanceToMoveHigh (lo alone a signed 32-bit one without
// it), the new position's high dword written back there; NO_ERROR on success, which a caller reading GetLastError after
// a position of FFFFFFFFh tells from a failure (OLE32's compound files)
def('KERNEL32', 'SetFilePointer', 4, function (h, lo, hip, how) {
  const f = fileOf(this, h); if (!f) { this.lastError = 6; return 0xffffffff; }
  const dist = hip ? (this.r32(hip) | 0) * 0x100000000 + u32(lo) : lo | 0;
  const r = fsCall(this, () => this.fs.seek(f.fd, dist, how), null); if (r === null) return 0xffffffff;
  if (hip) this.w32(hip, Math.floor(r / 0x100000000));
  this.lastError = 0; return u32(r);
});
def('KERNEL32', 'GetFileSize', 2, function (h, hi) { const f = fileOf(this, h); if (hi) this.w32(hi, 0); return f ? this.fs.fstat(f.fd).size : 0xffffffff; });
def('KERNEL32', 'SetEndOfFile', 1, function (h) { const f = fileOf(this, h); return f ? fsCall(this, () => (this.fs.truncate(f.fd), 1)) : 0; });
def('KERNEL32', 'FlushFileBuffers', 1, () => 1);
// the Win16-style file calls (_lopen and friends) as Win32 has them: handles from the same table, -1 (HFILE_ERROR) on failure
const lfile = (p, path, mode) => fsCall(p, () => p.newHandle({ kind: 'file', fd: p.fs.open(path, mode), path }), 0xffffffff);
def('KERNEL32', '_lopen', 2, function (name, mode) { const m = mode & 3; return lfile(this, this.readA(name), m === 0 ? 'r' : 'r+'); });
def('KERNEL32', '_lcreat', 2, function (name, attr) { return lfile(this, this.readA(name), 'w+'); });
def('KERNEL32', '_lclose', 1, function (h) { const f = fileOf(this, h); if (!f) return 0xffffffff; if (f.refs > 1) f.refs--; else fsCall(this, () => this.fs.close(f.fd)); this.handles.delete(h); return 0; });
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
// (the dates given, as FILETIMEs; a null pointer leaves that one as it is. A no-op, every file Setup extracted kept the
// time of its copy: BonziBUDDY's Installer VISE compares dates, took OSR 2.5's OLEAUT32.DLL of 1996 for newer than its
// own, kept it, and BonziBUDDY said "The file 'OLEAUT32.DLL' is out of date")
def('KERNEL32', 'SetFileTime', 4, function (h, c, a, w) {
  const f = fileOf(this, h); if (!f) { this.lastError = 6; return 0; }
  const ms = p => p ? Number((ft64(this, p) - 116444736000000000n) / 10000n) : undefined, t = {};
  for (const [k, p] of [['ctime', c], ['atime', a], ['mtime', w]]) { const v = ms(p); if (v !== undefined) t[k] = v; }
  return fsCall(this, () => { this.fs.futimes(f.fd, t); return 1; });
});
def('KERNEL32', 'GetFileAttributesA', 1, function (n) { return fsCall(this, () => this.fs.stat(this.readA(n)).attrs, 0xffffffff); });
def('KERNEL32', 'SetFileAttributesA', 2, function (n, a) { return fsCall(this, () => (this.fs.setAttrs(this.readA(n), a), 1)); });
def('KERNEL32', 'DeleteFileA', 1, function (n) { return fsCall(this, () => (this.fs.unlink(this.readA(n)), 1)); });
def('KERNEL32', 'MoveFileA', 2, function (a, b) { return fsCall(this, () => (this.fs.rename(this.readA(a), this.readA(b)), 1)); });
def('KERNEL32', 'CopyFileA', 3, function (a, b, fail) { return fsCall(this, () => (this.fs.copy(this.readA(a), this.readA(b), { overwrite: !fail }), 1)); });
def('KERNEL32', 'CreateDirectoryA', 2, function (n) { return fsCall(this, () => (this.fs.mkdir(this.readA(n)), 1)); });
def('KERNEL32', 'RemoveDirectoryA', 1, function (n) { return fsCall(this, () => (this.fs.rmdir(this.readA(n)), 1)); });
def('KERNEL32', 'GetCurrentDirectoryA', 2, function (n, b) { return this.writeA(b, this.fs.cwd.replace(/\\$/, (m, o) => (o > 2 ? '' : m)), n); });
// (a drive alone, "C:", is that drive's current directory, as DOS keeps one a drive: the process's last there, else its
// root. Taken for the root, WINHLP32's restore of its directory with "C:" left it in C:\, and Windows 98's help index
// ("winhlp32 -g windows.hlp") looked for C:\windows.hlp: "(null) (2)")
def('KERNEL32', 'SetCurrentDirectoryA', 1, function (n) {
  const pc = this.pc, dc = pc.driveCwd || (pc.driveCwd = {}), cur = this.fs.cwd || '';
  if (/^[A-Za-z]:/.test(cur)) dc[cur[0].toUpperCase()] = cur;
  let path = this.readA(n) || '';
  if (/^[A-Za-z]:$/.test(path)) { const d = path[0].toUpperCase(); if (cur[0] && cur[0].toUpperCase() === d) return 1; path = dc[d] || d + ':\\'; }
  return fsCall(this, () => (this.fs.chdir(path), 1));
});
def('KERNEL32', 'GetDriveTypeA', 1, function (n) { const l = ((this.readA(n) || this.fs.cwd)[0] || 'C').toUpperCase(); const v = this.fs.vols.get(l); return !v ? 1 : { removable: 2, fixed: 3, remote: 4, cdrom: 5 }[v.kind] || 3; });   // (a network drive's DRIVE_REMOTE)
// QueryDosDeviceA(name, target, max), as Windows 98's KERNEL32 has it (BFF70000h+388A0h, behind its argument check):
// no name, no buffer or a size over 104h is ERROR_INVALID_PARAMETER; COMn and LPTn are their own targets; "X:", a drive
// there, is its SUBST path (INT 21h 71AAh, BH 2), and a drive not substituted (every drive here: none is) is
// ERROR_FILE_NOT_FOUND, as anything else is; a target longer than the buffer ERROR_INSUFFICIENT_BUFFER. The count of
// the characters written, the NUL not counted. Missing, PIDSET's call was a dead thunk and its C runtime's exception
// handling ran it out of stack on Windows 98's first start
def('KERNEL32', 'QueryDosDeviceA', 3, function (name, target, max) {
  if (!name || !target || u32(max) > 0x104) { this.lastError = 87; return 0; }
  const n = (this.readA(name) || '').toUpperCase();
  // (a drive, there or not, is no SUBST drive here: not found, as a name that is no device)
  const to = /^(COM[1-9]|LPT[1-9])$/.test(n) ? n : null;
  if (to === null) { this.lastError = 2; return 0; }
  if (to.length + 1 > u32(max)) { this.lastError = 0x7a; return 0; }
  this.writeA(target, to, to.length + 1); return to.length;
});
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
  // (the name's trailing blanks are no part of it, as the file system takes a name, and a name with no wildcard its
  // trailing dots: "regedit.exe " is REGEDIT.EXE; "*." keeps its dot, the files with no extension)
  const s = this.readA(pat); const dir = s.includes('\\') ? s.slice(0, s.lastIndexOf('\\')) || s.slice(0, 3) : this.fs.cwd, raw = s.slice(s.lastIndexOf('\\') + 1).replace(/ +$/, '');
  const mask = /[*?]/.test(raw) ? raw : raw.replace(/[. ]+$/, '') || raw;
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
  if (had) {
    // (a file's named mapping asked for again larger, as WININET grows its cache index: the file and the mapping's data
    // grown to the size asked for, in place when the heap has the room after it. Answered at its old size, WININET
    // zeroed the new part past the data's end, into the next block's pages, and faulted)
    let want = u32(hi) ? 0 : u32(lo);
    if (!want && had.path) try { want = this.fs.stat(had.path).size; } catch (_) { want = 0; }
    if (had.file && had.base && want > had.size) mapGrow(this, had, want);
    else if (want > (had.want || 0)) had.want = want;
    this.lastError = 183; return this.newHandle(had);
  }
  let m;
  if (u32(h) === 0xffffffff) { if (!lo) { this.lastError = 87; return 0; } const base = this.alloc(lo); this.u8.fill(0, base, base + lo); m = { kind: 'mapping', base, size: lo }; }
  // (a file's: its size at least the size asked for, the file grown to it as Windows grows it, and written back when
  // it is writable (PAGE_READWRITE, PAGE_EXECUTE_READWRITE) as its views go and as it goes, mapFlush. Kept only in the
  // view, WININET's cache index (index.dat) was its zeros on the disk: the next start read a cache limit of 0, made
  // its containers with none, and Explorer faulted in WININET)
  else { const f = fileOf(this, h); if (!f) { this.lastError = 6; return 0; } m = { kind: 'mapping', path: f.path, want: u32(hi) ? 0 : u32(lo), write: !!(prot & 0x44), views: 0 }; }
  if (key) sections(this).set(key, m);
  (this.mappings || (this.mappings = new Set())).add(m);
  this.lastError = 0; return this.newHandle(m);
});
def('KERNEL32', 'OpenFileMappingA', 3, function (access, inherit, name) {
  const m = name && sections(this).get(this.readA(name).toUpperCase()); if (!m) { this.lastError = 2; return 0; }
  this.lastError = 0; return this.newHandle(m);
});
def('KERNEL32', 'MapViewOfFile', 5, function (h, access, hi, lo, n) {
  const m = this.obj(h); if (!m || m.kind !== 'mapping') { this.lastError = 6; return 0; }
  if (m.file && m.base && u32(lo) + u32(n) > m.size) mapGrow(this, m, u32(lo) + u32(n));
  else if (m.file && m.base && m.path) { let fsz = 0; try { fsz = this.fs.stat(m.path).size; } catch (_) { fsz = 0; } if (fsz > m.size) mapGrow(this, m, fsz); }
  // (a file's mapping has its data at one address for as long as the mapping object lives, as Windows 95 keeps a
  // mapping in the shared arena: every view is that address, and unmapping a view leaves it. GDI32 maps a font file,
  // unmaps the view at once and reads the font through its address while it holds the mapping's handle; a copy per
  // view, freed at the unmap, was SUWIN's next GlobalAlloc, zeroed, and the TrueType loader found no table directory)
  if (!m.base) { const r = fsCall(this, () => { const b = this.fs.readFile(m.path), n = Math.max(b.length, m.want || 0); m.cap = m.write ? n + 0x400000 : n; m.base = this.alloc(m.cap + 1); m.size = n; m.file = true; this.u8.fill(0, m.base, m.base + n + 1); this.u8.set(b, m.base); if (n > b.length && m.write) mapFlush(this, m); return 0; }); if (!m.base) return r || 0; }
  if (m.file) m.views = (m.views || 0) + 1;
  return m.base + lo;
});
/** a file mapping's data grown to `want` bytes, in place when the heap has the room, the file's own bytes past the old
 *  end read in */
function mapGrow(p, m, want) {
  const old = m.size;
  if (want > (m.cap || old) && !p.extend(m.base, want + 1)) { const nb = p.alloc(want + 1); p.u8.copyWithin(nb, m.base, m.base + old); p.free(m.base); m.base = nb; }
  p.u8.fill(0, m.base + old, m.base + want + 1);
  try { const b = p.fs.readFile(m.path); if (b.length > old) p.u8.set(b.subarray(old, Math.min(b.length, want)), m.base + old); } catch (_) { /* none to read */ }
  m.size = want; m.want = Math.max(m.want || 0, want);
  if (m.write) mapFlush(p, m);
}
/** a writable file mapping's data written back to its file */
const mapFlush = (p, m) => { if (m.file && m.write && m.path && m.base) fsCall(p, () => { p.fs.writeFile(m.path, p.u8.slice(m.base, m.base + m.size)); return 1; }); };
/** a file's mapping gone once it has neither a handle nor a view, written back first (Windows keeps a mapping while a
 *  view of it is left: WININET closes its handle and keeps the view) */
const mapGone = (p, m) => {
  if (!m.file || m.views > 0 || [...p.handles.values()].includes(m)) return;
  mapFlush(p, m); p.free(m.base); m.base = 0; if (p.mappings) p.mappings.delete(m);
};
// FlushViewOfFile: a file's view written back to its file (the view is the file's contents copied in when mapped); a
// mapping of no file has nothing to write. Unimplemented, the thunk was a page fault in MSGSRV32 as Explorer opened My
// Computer (the shell's shared view of its settings file)
def('KERNEL32', 'FlushViewOfFile', 2, function (p) {
  for (const m of this.mappings || sections(this).values()) if (m.base && p >= m.base && p < m.base + Math.max(m.size, 1)) {
    if (!m.file || !m.path) return 1;
    const r = fsCall(this, () => { this.fs.writeFile(m.path, this.u8.slice(m.base, m.base + m.size)); return 1; });
    return r ? 1 : 0;
  }
  this.lastError = 487; return 0;   // ERROR_INVALID_ADDRESS
});
def('KERNEL32', 'UnmapViewOfFile', 1, function (p) {
  for (const m of this.mappings || sections(this).values()) if (m.base && p >= m.base && p < m.base + Math.max(m.size, 1)) {
    if (m.file) { mapFlush(this, m); m.views = Math.max(0, (m.views || 0) - 1); mapGone(this, m); }
    return 1;
  }
  this.free(p); return 1;
});
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
// a handle duplicated: the same object. The calling thread's or process's pseudo-handle (GetCurrentThread FFFFFFFEh,
// GetCurrentProcess FFFFFFFFh) is duplicated as a real handle to that very thread or process, which another thread
// can use: MPR hands its waiting thread's to MPREXE, which queues the APC that ends the wait there (copied as the
// pseudo-handle, the APC went to MPREXE's own thread, and GRPCONV's link to the Removable Disk in SendTo waited for
// good: Windows 98's first start stopped at "Programs on the Start menu")
// A kernel object's duplicate (a file mapping, an event, a mutex, a semaphore, a thread, a process) is a handle of
// its own to the object, and DUPLICATE_CLOSE_SOURCE (1) closes the one duplicated: the object lives until its last
// handle is closed. The shell hands a folder's ID list to Explorer as a mapping (SHLWAPI's SHAllocShared duplicates
// the mapping's handle for Explorer and closes its own; SHLockShared maps the duplicate). Duplicated as the same
// handle, the close took the mapping with it, Explorer got no ID list, and My Computer and Network Neighborhood opened
// as the path "" does, the current directory: C:\. An event duplicated that way went with its maker's CloseHandle,
// and the thread waiting on the duplicate waited its whole time-out: a folder window empty for a minute.
const DUP_KINDS = new Set(['mapping', 'event', 'mutex', 'semaphore', 'thread', 'process']);
def('KERNEL32', 'DuplicateHandle', 7, function (a, h, b, out, access, inherit, opts) {
  h >>>= 0;
  const o = h < 0xfffffffe ? this.obj(h) : null;
  let r;
  if (h === 0xfffffffe) r = this.newHandle({ kind: 'thread', id: this.currentThreadId() });
  else if (h === 0xffffffff) r = this.newHandle({ kind: 'process', pid: this.pc.pid });
  else if (o && DUP_KINDS.has(o.kind)) { r = this.nextHandle; this.nextHandle += 4; this.handles.set(r, o); if (opts & 1) this.handles.delete(h); }
  // (a file's duplicate: another handle to the same open file, its position shared, the file closed with its last
  // handle (CloseHandle). The handle itself back, OLE32's compound file closed its original and wrote through the
  // duplicate it kept, the file gone: STG_E_INVALIDHANDLE, and a VB form's icon an "Invalid picture")
  else if (o && o.kind === 'file') { r = this.nextHandle; this.nextHandle += 4; this.handles.set(r, o); o.refs = (o.refs || 1) + 1; if (opts & 1) API.KERNEL32.CloseHandle[1].call(this, h); }
  else r = h;
  if (out) this.w32(out, r); return 1;
});
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
  // (a stack size of 0 is the program's own: its header's SizeOfStackReserve, a megabyte for most, as CreateThread
  // gives one. Given 64K, Explorer's thread for a folder window ran out of stack making the window's toolbars, a
  // stack fault in SHDOCVW, once the window had a folder to show)
  if (!stack) {
    const pc = this.thread16 && this.thread16.pc, base = (pc && pc.exe && pc.exe.base) || (this.exe && this.exe.base) || 0;
    const pe = base ? base + this.r32(base + 0x3c) : 0;
    if (pe && this.r32(pe) === 0x4550) stack = Math.min(Math.max(this.r32(pe + 24 + 72), 0x10000), 0x100000);
  }
  const t = this.newThread(start, param, stack, true, !!(flags & 4));
  if (ptid) this.w32(ptid, t.id);
  return this.newHandle({ kind: 'thread', id: t.id });
});
// Fibers, as Windows 98's KERNEL32 has them (Windows 95's has none). A fiber is a record the thread's TIB names at
// +10h, its first dword the fiber's data (GetFiberData reads it there): { data, SEH chain, stack top, stack limit,
// ESP, EBP, EBX, ESI, EDI, where it goes on, its stack's block }. SwitchToFiber keeps the running fiber's place in
// its record and goes on with the other's, on its stack, with its SEH chain and stack bounds in the TIB.
// MSHTML decodes an image on a fiber: it takes KERNEL32's CreateFiber where there is one, its own stand-in for them
// on Windows 95 alone (version 4.0), and with neither decodes nothing, so on Windows 98 (4.10) no image in a page
// ever finished loading: a folder's Web view never got its onload (My Computer's pie chart control stayed a white
// box) and Explorer's busy animation ran for good.
const FIBER = { data: 0, seh: 4, top: 8, limit: 12, esp: 16, ebp: 20, ebx: 24, esi: 28, edi: 32, eip: 36, block: 40, size: 48 };
def('KERNEL32', 'ConvertThreadToFiber', 1, function (data) {
  const tib = this.cpu.fs.value >>> 0, f = this.alloc(FIBER.size); this.u8.fill(0, f, f + FIBER.size);
  this.w32(f + FIBER.data, data); this.w32(tib + 0x10, f); return f;
});
def('KERNEL32', 'CreateFiber', 3, function (size, start, data) {
  const n = Math.max((size + 0xfff) & ~0xfff, 0x10000), block = this.alloc(n), f = this.alloc(FIBER.size); this.u8.fill(0, f, f + FIBER.size);
  // (its first switch arrives at its procedure as a call does: the data its argument, and a return ends the thread)
  const sp = (block + n - 16) & ~3; this.w32(sp, this.thunkFor('KERNEL32', 'ExitThread')); this.w32(sp + 4, data);
  for (const [k, v] of [['data', data], ['seh', 0xffffffff], ['top', block + n], ['limit', block], ['esp', sp], ['eip', start], ['block', block]]) this.w32(f + FIBER[k], v);
  return f;
});
def('KERNEL32', 'DeleteFiber', 1, function (f) {
  if (!f || this.r32((this.cpu.fs.value >>> 0) + 0x10) === f >>> 0) return 0;   // (the running fiber's own end is its thread's: ExitThread)
  const block = this.r32(f + FIBER.block); if (block) this.free(block); this.free(f); return 0;
});
def('KERNEL32', 'SwitchToFiber', 'regs', function () {
  const sp = u32(this.reg('esp')), ret = this.r32(sp), to = this.r32(sp + 4), tib = this.cpu.fs.value >>> 0, cur = this.r32(tib + 0x10);
  if (cur) {
    this.w32(cur + FIBER.seh, this.r32(tib)); this.w32(cur + FIBER.top, this.r32(tib + 4)); this.w32(cur + FIBER.limit, this.r32(tib + 8));
    this.w32(cur + FIBER.esp, sp + 8); this.w32(cur + FIBER.eip, ret);
    for (const r of ['ebp', 'ebx', 'esi', 'edi']) this.w32(cur + FIBER[r], u32(this.reg(r)));
  }
  this.w32(tib, this.r32(to + FIBER.seh)); this.w32(tib + 4, this.r32(to + FIBER.top)); this.w32(tib + 8, this.r32(to + FIBER.limit)); this.w32(tib + 0x10, to);
  for (const r of ['ebp', 'ebx', 'esi', 'edi']) this.reg(r, this.r32(to + FIBER[r]));
  this.reg('esp', this.r32(to + FIBER.esp));
  return this.r32(to + FIBER.eip);
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
  if (dir) { const d = this.readA(dir); if (d) r.cwd = d.length > 3 ? d.replace(/\\+$/, '') : d; }   // (the directory it is given to start in)
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
// (the date and the time are WORDs: the high halves of their stack slots are whatever the caller left there. Taken
// whole, the Pinball trial's setup gave a year past what a Date holds, NaN, and BigInt(NaN) ended the system machine
// as its File Copy began: MSGSRV32's "illegal operation". A date no Date can hold is ERROR_INVALID_PARAMETER)
def('KERNEL32', 'DosDateTimeToFileTime', 3, function (dd, tt, ft) {
  dd &= 0xffff; tt &= 0xffff;
  const ms = Date.UTC((dd >> 9) + 1980, ((dd >> 5) & 15) - 1, dd & 31, tt >> 11, (tt >> 5) & 63, (tt & 31) * 2);
  if (!Number.isFinite(ms)) { this.lastError = 87; return 0; }
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
// (a folder given with its trailing backslash keeps it, as Windows answers: dropped, IE4.DLL's ShortPath gave ACME
// "C:\PROGRA~1\INTERN~1", ACME's path formatter wants a folder ending in one, and Internet Explorer 4's Web Browser
// failed at STF object 692 with Setup Error 991, "Your Setup files may be damaged")
def('KERNEL32', 'GetShortPathNameA', 3, function (l, s, n) {
  const given = this.readA(l) || '';
  let r = fsCall(this, () => this.fs.stat(given).shortPath, null); if (r === null) return 0;
  if (/[\\/]$/.test(given) && !/\\$/.test(r)) r += '\\';
  return this.writeA(s, r, n);
});   // (the path's 8.3 form, as stat gives it; a path that is not there fails)
def('KERNEL32', 'ExpandEnvironmentStringsA', 3, function (src, dst, n) {
  const env = envOf(this), r = (this.readA(src) || '').replace(/%([^%]+)%/g, (m, k) => { const e = env.get(k.toUpperCase()); return e ? e.value : k.toUpperCase() === 'SYSTEMROOT' ? 'C:\\WINDOWS' : m; });
  if (n) this.writeA(dst, r, n); return r.length + 1;
});
def('KERNEL32', 'RtlZeroMemory', 2, function (p, n) { this.u8.fill(0, p, p + n); });
def('KERNEL32', 'InterlockedExchange', 2, function (p, v) { const o = this.r32(p); this.w32(p, v); return o; });
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
    // (a bare name looked for as LoadLibrary looks: the search folders, SYSTEM, the Windows folder; a file not there is
    // ERROR_FILE_NOT_FOUND, not a bad image)
    const at = /\\|:/.test(path) ? [path] : [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS'].map(d => d + '\\' + path);
    let file = null;
    // (the path as given: the file system takes short names and long. A `resolve` of its was asked first, which it has
    // not, and the worker's proxy of it answers any name with a call to the page that throws: every file loaded as data
    // was not found, and Windows 98's first start could not register MSHTMLED.DLL or ICMFILTER.DLL, 80070002)
    for (const q of at) { try { file = this.fs.readFile(q); break; } catch (_) { /* not there */ } }
    if (!file) { this.lastError = 2; return 0; }
    let pe = false;
    try { const b = file; const o = b.length > 0x40 ? b[0x3c] | b[0x3d] << 8 | b[0x3e] << 16 | b[0x3f] << 24 : 0; pe = b[0] === 0x4d && b[1] === 0x5a && o + 4 <= b.length && b[o] === 0x50 && b[o + 1] === 0x45 && !b[o + 2] && !b[o + 3]; } catch (_) { pe = false; }
    if (!pe) { this.lastError = 193; return 0; }
    // (mapped as data, as Windows maps such a file: no image in the arena, no DllMain, its resources only. Loaded as an
    // image each time, the arena filled with what VERSION.DLL and REGSVR32 only read the resources of, and FreeLibrary
    // gives none of it back: on Windows 98's first start IEPEERS.DLL found no room, and VERSION.DLL could not read
    // ODBCINT.DLL's version, so ODBCCP32 said the two were different versions)
    return this.dataModule(file, path);
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
// copies the text as it is. FROM_HMODULE (800h) takes the text from `src`'s message table (RT_MESSAGETABLE, 11),
// FROM_SYSTEM (1000h) from KERNEL32.DLL's, the module's first where both are given; a message in neither is
// ERROR_MR_MID_NOT_FOUND (317) and no text
const msgTableText = (bytes, id) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), nb = dv.getUint32(0, true);
  for (let i = 0; i < nb; i++) {
    const lo = dv.getUint32(4 + 12 * i, true), hi = dv.getUint32(8 + 12 * i, true); if (id < lo || id > hi) continue;
    let a = dv.getUint32(12 + 12 * i, true);
    for (let k = lo; k < id; k++) a += dv.getUint16(a, true);
    const len = dv.getUint16(a, true), wide = dv.getUint16(a + 2, true) & 1, b = bytes.slice(a + 4, a + len);   // (a copy: the machine's memory is shared, and TextDecoder reads no shared view)
    return new TextDecoder(wide ? 'utf-16le' : 'latin1').decode(b).replace(/\0+$/, '');
  }
  return null;
};
const sysMessages = p => {
  if (p.sysMsgTable !== undefined) return p.sysMsgTable;
  let b = null; try { b = p.fs.readFile('C:\\WINDOWS\\SYSTEM\\KERNEL32.DLL'); } catch (_) { /* none on this disk */ }
  return (p.sysMsgTable = (b && peResource(b, 11, 1)) || null);
};
const messageText = (p, fl, src, id) => {
  if (fl & 0x800) {
    const mod = resModule(p, src), r = mod && resIn(p, mod, 11, 1);
    const t = r && msgTableText(p.u8.subarray(r.addr, r.addr + r.size), id >>> 0); if (t !== null && t !== undefined) return t;
  }
  if (fl & 0x1000) { const s = sysMessages(p), t = s && msgTableText(s, id >>> 0); if (t !== null) return t; }
  return null;
};
def('KERNEL32', 'FormatMessageA', 7, function (fl, src, id, lang, buf, n, args) {
  let t;
  const f = fl & 0x400 ? this.readA(src) || '' : messageText(this, fl, src, id);
  if (f === null) { this.lastError = 317; return 0; }
  // (a maximum width, the flags' low byte: the text's own line breaks are not kept, each a space, and only %n's
  // breaks are; under FFh no others are made, else the lines are broken at that width)
  const width = fl & 0xff, src0 = width ? f.replace(/\r\n|\r|\n/g, ' ') : f;
  {
    const f = src0;
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
  }
  if (width && width < 0xff) t = t.split('\r\n').map(line => { let out = '', cur = ''; for (const w of line.split(' ')) { if (cur && (cur + ' ' + w).length > width) { out += cur + '\r\n'; cur = w; } else cur = cur ? cur + ' ' + w : w; } return out + cur; }).join('\r\n');
  if (fl & 0x100) { const p = this.alloc(t.length + 1); this.writeA(p, t); this.w32(buf, p); return t.length; }   // FORMAT_MESSAGE_ALLOCATE_BUFFER
  return this.writeA(buf, t, n);
});
def('KERNEL32', '_hread', 3, function (h, b, n) { return API.KERNEL32._lread[1].call(this, h, b, n); });
def('KERNEL32', '_hwrite', 3, function (h, b, n) { return API.KERNEL32._lwrite[1].call(this, h, b, n); });
// events and semaphores: one guest thread, so a wait finds the object signalled or times out at once
// named synchronization objects: a second create finds the first (ERROR_ALREADY_EXISTS), Open* finds it by name
const named = (p, name, make) => {
  const key = name && p.readA(name).toUpperCase(), objs = p.namedObjs || (p.namedObjs = new Map()), had = key && objs.get(key);
  // (a second create's handle is its process's too, closed as it ends: left open, it kept the name alive after
  // every process that had it was gone, and each RUNONCE after two had met found a "previous instance")
  if (had) { p.lastError = 183; const h = p.newHandle(had); if (p.pc) (p.namedOwner || (p.namedOwner = new Map())).set(h, p.pc); return h; }
  const o = make(); if (key) { objs.set(key, o); o.name = key; } p.lastError = 0;
  const h = p.newHandle(o); if (key && p.pc) (p.namedOwner || (p.namedOwner = new Map())).set(h, p.pc); return h;
};
/** a named object whose last handle has gone: its name with it, as the kernel frees an object nothing refers to. Kept,
 *  RUNONCE's Runonce_Instance_Mutex outlived the RUNONCE that made it, and every RUNONCE after it found a "previous
 *  instance" and quit, started again and again */
const namedGone = (p, o) => {
  if (!o || !o.name || !p.namedObjs || p.namedObjs.get(o.name) !== o) return;
  for (const v of p.handles.values()) if (v === o) return;
  p.namedObjs.delete(o.name);
};
/** a process's handles to named objects closed as it ends (its other handles are the machine's to keep, as before) */
const namedClose = (p, pc) => {
  for (const [h, owner] of p.namedOwner || []) if (owner === pc) { const o = p.handles.get(h); p.namedOwner.delete(h); p.handles.delete(h); namedGone(p, o); }
};
const openNamed = (p, name, kind) => { const o = name && (p.namedObjs || new Map()).get(p.readA(name).toUpperCase()); if (!o || o.kind !== kind) { p.lastError = 2; return 0; } p.lastError = 0; const h = p.newHandle(o); if (p.pc) (p.namedOwner || (p.namedOwner = new Map())).set(h, p.pc); return h; };
Process.prototype.namedClose = function (pc) { namedClose(this, pc); };
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
const WSOCK_CLOSESOCKET = 0x102;
const socketGone = (p, m) => {
  const v = p.vxdById && p.vxdById(0x3e); if (!v) return;
  const b = p.sockCloseBuf || (p.sockCloseBuf = p.alloc(4)); p.w32(b, m.ctx);
  p.vxdIoctl(v, WSOCK_CLOSESOCKET, b, 4, 0, 0, 0, 0);
};
def('KERNEL32', 'CreateSocketHandle', 0,function () { return this.newHandle({ kind: 'socket', ctx: 0 }); });
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
// VxDCall0 ... VxDCall8 (ordinals 1-9, one entry): a VxD's Win32 service, the service dword above the return address.
// KERNEL32 drops the dword (mov eax,[esp+4] / pop [esp]) and enters the VMM's Win32 service dispatcher by its call
// gate, which (Windows 95's VMM at 4C27Ch) finds the device's table, [1C600h + 4 * id] for an id below 40h, else
// DDB_Win32_Service_Table (DDB+38h) of the DDB with that id flagged 4000h, each entry a handler and its argument
// count. With no table, or a service past its end, the client's EAX is 1 and it returns to the caller with the
// arguments still on its stack: Windows 98's WINMM asks VTDAPI (442h, no Win32 services) for the time that way at its
// start, and takes 10 or less for no answer and asks by DeviceIoControl
// KERNEL32.122 (Windows 98's, no name: BFF96DA0h): a program gives the kernel a procedure to tell of the programs
// that start (0, procedure) or asks for the telling to begin (1); TASKMON, which logs them for the defragmenter,
// calls it as it starts. None is told here
def('KERNEL32', '#122', 2, () => 0);
const VMM_PAGE = new Set([0, 1, 2, 0x0a, 0x0d]);   // (the VMM's page services answered here)
for (let k = 1; k <= 9; k++) def('KERNEL32', `#${k}`, 'regs', function () {
  const sp = u32(this.reg('esp')), ret = this.r32(sp), id = this.r32(sp + 4), dev = id >>> 16, n = id & 0xffff;
  // (the VMM's own, device 1: the page services a program makes memory with past KERNEL32. MSHTML makes each of its
  // threads' stacks so: _PageReserve (0: an arena or page, the pages, flags) answers the address; _PageCommit (1:
  // page, pages, pager, its data, flags) and _PageDecommit (2) say the pages are there, as a region's are here from
  // its reservation; _PageModifyPermissions (0Dh: page, pages, and-mask, or-mask) answers the permissions before;
  // _PageFree (0Ah: address, flags) gives the region back. Each pops its arguments, as every VMM service does: the
  // number the caller's ordinal names, VxDCall0 to VxDCall8. The VMM's others answer 0 here: ScanRegW calls service
  // 1Ch with one argument by VxDCall1 at its logon check and does not take it off its stack itself; left on, its
  // thread's procedure returned into its CRT block and faulted)
  if (dev === 1) {
    const a = i => this.r32(sp + 8 + 4 * i); let r;
    if (n === 0) {
      r = API.KERNEL32.VirtualAlloc[1].call(this, 0, a(1) << 12, 0x2000) >>> 0;
      const reg = r && this.vregions && this.vregions.get(r); if (reg) reg.pc = (this.thread16 && this.thread16.pc) || null;   // (its process's, gone with it)
      if (!r) r = 0xffffffff;
    } else if (n === 0x0a) r = API.KERNEL32.VirtualFree[1].call(this, a(0), 0, 0x8000);
    else if (n === 0x0d) r = 0x20060000;
    else r = VMM_PAGE.has(n) ? 1 : 0;
    this.reg('esp', sp + 8 + 4 * (k - 1)); this.reg('eax', r);
    return ret;
  }
  const v = this.vxdById && this.vxdById(dev), ddb = v && v.ddb, t = ddb && (this.r16(ddb + 0x0a) & 0x4000) ? this.r32(ddb + 0x38) : 0;
  if (t && n < this.r32(t)) throw new GuestError(`VxDCall ${id.toString(16)}: ${v.name || dev.toString(16)}'s Win32 service ${n} (handler ${this.r32(t + 8 + 8 * n).toString(16)}, ${this.r32(t + 12 + 8 * n)} arguments) is not dispatched here`);
  this.reg('esp', sp + 8); this.reg('eax', 1);
  return ret;
});
// Windows 98's KERNEL32 functions its own programs import (Explorer, OLE32, COMCTL32, the shell), each as that
// KERNEL32 has it (read from its code)
// the Unicode functions Windows 9x does not implement: one stub (KERNEL32 BFF71319h) sets error 120,
// ERROR_CALL_NOT_IMPLEMENTED, and returns 0, its arguments popped
for (const [nm, n] of [['CreateEventW', 4], ['GlobalGetAtomNameW', 3], ['SearchPathW', 6], ['lstrcmpW', 2], ['lstrcmpiW', 2]])
  def('KERNEL32', nm, n, function () { this.lastError = 120; return 0; });
// MoveFileExA: the paths checked, then MoveFileA's move (BFF9C478h); MOVEFILE_REPLACE_EXISTING (1) deletes the target
// first, MOVEFILE_COPY_ALLOWED (2) copies across drives, MOVEFILE_DELAY_UNTIL_REBOOT (4) is a line in WININIT.INI's
// [rename] section ("new=old", NUL for a delete), which WININIT carries out at the next start
def('KERNEL32', 'MoveFileExA', 3, function (a, b, fl) {
  const from = this.readA(a), to = b ? this.readA(b) : null;
  return fsCall(this, () => {
    if (fl & 4) {
      const ini = 'C:\\WINDOWS\\WININIT.INI', old = this.fs.exists(ini) ? window.W95FS.decode(this.fs.readFile(ini)) : '';
      const line = `${to || 'NUL'}=${from}\r\n`, txt = /^\[rename\]/im.test(old) ? old.replace(/^\[rename\]\r?\n/im, m => m + line) : `${old}${old && !old.endsWith('\n') ? '\r\n' : ''}[rename]\r\n${line}`;
      this.fs.writeFile(ini, window.W95FS.encode(txt)); return 1;
    }
    if (!to) { this.fs.unlink(from); return 1; }
    if ((fl & 1) && this.fs.exists(to)) this.fs.unlink(to);
    if ((fl & 2) && from[0].toUpperCase() !== to[0].toUpperCase()) { this.fs.copy(from, to, { overwrite: !!(fl & 1) }); this.fs.unlink(from); return 1; }
    this.fs.rename(from, to); return 1;
  });
});
// FindResourceExA(module, type, name, language): FindResourceA's lookup (BFF80A40h), one language to a resource here
def('KERNEL32', 'FindResourceExA', 4, function (m, type, name) { return API.KERNEL32.FindResourceA[1].call(this, m, name, type); });
// (and the wide one, one of the few Unicode calls Windows 95's KERNEL32 answers: Windows 98's Explorer asks it)
def('KERNEL32', 'FindResourceExW', 4, function (m, type, name) { return API.KERNEL32.FindResourceW[1].call(this, m, name, type); });
// GetFileAttributesExA(name, GetFileExInfoStandard, WIN32_FILE_ATTRIBUTE_DATA): attributes, creation, access and write
// times, size high and low; the find data's first 36 bytes
def('KERNEL32', 'GetFileAttributesExA', 3, function (n, level, p) {
  if (level !== 0) { this.lastError = 87; return 0; }
  return fsCall(this, () => { const s = this.fs.stat(this.readA(n)), tmp = this.alloc(320); try { writeFindData(this, tmp, s); this.u8.copyWithin(p, tmp, tmp + 36); } finally { this.free(tmp); } return 1; });
});
// GlobalFlags (BFF748CDh) and LocalShrink (BFF9A0EAh), after the handle's check: a fixed block's flags (no lock count,
// not discardable) are 0; the heap's size is what LocalShrink answers
def('KERNEL32', 'LocalShrink', 2, function () { return 0x10000; });
// GlobalCompact: the largest free block, from GlobalMemoryStatus's free memory
def('KERNEL32', 'GlobalCompact', 1, function () { const p = this.alloc(32); try { API.KERNEL32.GlobalMemoryStatus[1].call(this, p); return this.r32(p + 12); } finally { this.free(p); } });
def('KERNEL32', 'IsBadHugeWritePtr', 2, function (a, n) { return API.KERNEL32.IsBadWritePtr[1].call(this, a, n); });
// FreeLibraryAndExitThread (BFF95B34h): FreeLibrary, then ExitThread with the code, never returning
def('KERNEL32', 'FreeLibraryAndExitThread', 'regs', function () {
  const sp = u32(this.reg('esp')); API.KERNEL32.FreeLibrary[1].call(this, this.r32(sp + 4));
  this.w32(sp + 4, this.r32(sp + 8)); return API.KERNEL32.ExitThread[1].call(this);
});
// MapViewOfFileEx: MapViewOfFile's view; one asked for at an address it cannot have fails (ERROR_INVALID_ADDRESS)
def('KERNEL32', 'MapViewOfFileEx', 6, function (h, acc, hi, lo, n, base) {
  const v = API.KERNEL32.MapViewOfFile[1].call(this, h, acc, hi, lo, n);
  if (!base || !v || v === base) return v;
  API.KERNEL32.UnmapViewOfFile[1].call(this, v); this.lastError = 487; return 0;
});
def('KERNEL32', 'ResetNLSUserInfoCache', 0, () => 0);
// the Toolhelp process list (TH32CS_SNAPPROCESS): this machine's processes as a snapshot, each a PROCESSENTRY32 (296
// bytes: size, usage, process id, heap, module, threads, parent, priority, flags, exe path)
def('KERNEL32', 'CreateToolhelp32Snapshot', 2, function (flags) {
  const procs = [...(this.procs || new Map()).values()].filter(pc => pc.exitCode === null || pc.exitCode === undefined);
  const list = (flags & 2) ? procs.map(pc => ({ pid: pc.pid || 0, path: pc.path || '', threads: [...(this.threadsById || new Map()).values()].filter(t => t.pc === pc && t.state !== 'done').length || 1 })) : [];
  return this.newHandle({ kind: 'th32', list, i: 0 });
});
const th32Proc = (p, h, e, first) => {
  const s = p.handles && p.handles.get(h); if (!s || s.kind !== 'th32') { p.lastError = 6; return 0; }
  if (first) s.i = 0;
  const x = s.list[s.i++]; if (!x) { p.lastError = 18; return 0; }   // ERROR_NO_MORE_FILES
  p.u8.fill(0, e + 4, e + 296); p.w32(e + 4, 1); p.w32(e + 8, x.pid); p.w32(e + 20, x.threads); p.w32(e + 28, 8); p.writeA(e + 36, x.path, 260);
  return 1;
};
def('KERNEL32', 'Process32First', 2, function (h, e) { return th32Proc(this, h, e, true); });
def('KERNEL32', 'Process32Next', 2, function (h, e) { return th32Proc(this, h, e, false); });
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
  const path = given ? `${asGiven ? base : root}\\${asGiven ? given : given.toLowerCase()}` : asGiven ? base : root;
  return asGiven ? regCanonGiven(path) : regCanon(path);   // (HKLM\SOFTWARE\Classes is HKEY_CLASSES_ROOT: REG_ALIAS)
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
  const path = regPath(this, hk, 0); const kids = regKidPaths(path);
  if (i >= kids.length) return 259; this.writeA(buf, keyName(path, kids[i]), n); return 0;
});
def('ADVAPI32', 'RegFlushKey', 1, () => 0);                       // the registry store writes through
// RegNotifyChangeKeyValue(hKey, bWatchSubtree, dwNotifyFilter, hEvent, fAsynchronous): the event set at the key's next
// change (regNotify). Windows 98's ADVAPI32 has it (its own code, not KERNEL32's common stub); missing here, the call
// (CRYPT32 imports it) was a dead thunk on Windows 98's first start. A synchronous ask (no event) is answered at once: the change it
// would wait for is not waited on, as no thread here can be held in the call
def('ADVAPI32', 'RegNotifyChangeKeyValue', 5, function (hk, sub, filter, ev, async) {
  const path = regPath(this, hk, 0); if (!path || !REGISTRY.has(path)) return 6;   // ERROR_INVALID_HANDLE
  if (!async) return 0;
  const o = this.obj(ev); if (!o || o.kind !== 'event') return 6;
  regNotifies.add({ proc: this, path, sub: !!sub, filter: filter & 5 || 5, ev: o });
  return 0;
});
def('ADVAPI32', 'RegConnectRegistryA', 3, () => 53);              // another computer's registry: ERROR_BAD_NETPATH
// user profiles' hives (MPRSERV, when profiles are enabled): this machine keeps one user's settings
def('ADVAPI32', 'RegLoadKeyA', 3, () => 1); def('ADVAPI32', 'RegUnLoadKeyA', 2, () => 1); def('ADVAPI32', 'RegSaveKeyA', 3, () => 1);
def('ADVAPI32', 'RegRemapPreDefKey', 2, () => 0);
// RegEnumKeyExA(key, index, name, *cchName, -, class, *cchClass, *lastWrite): the name and its length; no classes, no times
def('ADVAPI32', 'RegEnumKeyExA', 8, function (hk, i, buf, pn, res, cls, pcls, ft) {
  const path = regPath(this, hk, 0); const kids = regKidPaths(path);
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
  const kids = regKidPaths(path);
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

// the CryptoAPI as the Microsoft Base Cryptographic Provider answers what Windows 98's programs ask of it: a context
// (any provider and key container, a verification one included), MD5 and SHA-1 hashes, random bytes. Keys, encryption
// and signatures are the one thing not here: their calls fail NTE_BAD_ALGID, as a provider without the algorithm does.
// (Windows 98's first start: the registrations RUNDLL32 made called CryptAcquireContextA, an import this ADVAPI32 did
// not have, and three RUNDLL32s faulted at its dead thunk)
const md5 = bytes => {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21], K = Array.from({ length: 64 }, (_, i) => (Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const n = bytes.length, len = ((n + 8) >> 6) + 1 << 6, m = new Uint8Array(len); m.set(bytes); m[n] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(len - 8, (n << 3) >>> 0, true); dv.setUint32(len - 4, Math.floor(n / 0x20000000), true);
  const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let o = 0; o < len; o += 64) {
    let [a, b, c, d] = H;
    for (let i = 0; i < 64; i++) {
      const r = i >> 4, f = r === 0 ? (b & c) | (~b & d) : r === 1 ? (d & b) | (~d & c) : r === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = r === 0 ? i : r === 1 ? (5 * i + 1) & 15 : r === 2 ? (3 * i + 5) & 15 : (7 * i) & 15, s = S[r * 4 + (i & 3)];
      const x = (a + f + K[i] + dv.getUint32(o + 4 * g, true)) >>> 0;
      a = d; d = c; c = b; b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer); H.forEach((h, i) => ov.setUint32(4 * i, h, true)); return out;
};
const sha1 = bytes => {
  const n = bytes.length, len = ((n + 8) >> 6) + 1 << 6, m = new Uint8Array(len); m.set(bytes); m[n] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(len - 4, (n << 3) >>> 0); dv.setUint32(len - 8, Math.floor(n / 0x20000000));
  const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], w = new Uint32Array(80), rl = (x, k) => (x << k) | (x >>> (32 - k));
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
    for (let i = 16; i < 80; i++) w[i] = rl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rl(a, 5) + f + e + k + w[i]) >>> 0; e = d; d = c; c = rl(b, 30) >>> 0; b = a; a = t;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0;
  }
  const out = new Uint8Array(20), ov = new DataView(out.buffer); H.forEach((h, i) => ov.setUint32(4 * i, h)); return out;
};
const CALG = { 0x8003: { name: 'md5', f: md5, size: 16 }, 0x8004: { name: 'sha1', f: sha1, size: 20 } };
const NTE_BAD_ALGID = 0x80090008, NTE_BAD_HASH = 0x80090002, NTE_BAD_UID = 0x80090001;
def('ADVAPI32', 'CryptAcquireContextA', 5, function (out, cont, prov, type, fl) {
  if (fl & 0x10) { this.lastError = 0; return 1; }   // CRYPT_DELETEKEYSET: nothing kept, nothing to delete
  this.w32(out, this.newHandle({ kind: 'cryptprov', type })); this.lastError = 0; return 1;
});
def('ADVAPI32', 'CryptAcquireContextW', 5, function (out, cont, prov, type, fl) { return API.ADVAPI32.CryptAcquireContextA[1].call(this, out, 0, 0, type, fl); });
def('ADVAPI32', 'CryptReleaseContext', 2, function (h) { const o = this.obj(h); if (!o || o.kind !== 'cryptprov') { this.lastError = NTE_BAD_UID; return 0; } this.handles.delete(h); return 1; });
def('ADVAPI32', 'CryptGenRandom', 3, function (h, n, buf) { const b = new Uint8Array(n); crypto.getRandomValues(b.subarray(0, Math.min(n, 65536))); for (let o = 65536; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536))); this.u8.set(b, buf); return 1; });
def('ADVAPI32', 'CryptCreateHash', 5, function (prov, alg, key, fl, out) {
  const a = CALG[alg]; if (!a || key) { this.lastError = NTE_BAD_ALGID; return 0; }
  this.w32(out, this.newHandle({ kind: 'crypthash', alg: a, parts: [], done: null })); return 1;
});
const hashOf = (p, h) => { const o = p.obj(h); return o && o.kind === 'crypthash' ? o : null; };
def('ADVAPI32', 'CryptHashData', 4, function (h, data, n, fl) {
  const o = hashOf(this, h); if (!o || o.done) { this.lastError = o ? NTE_BAD_HASH : 6; return 0; }
  o.parts.push(this.u8.slice(data, data + n)); return 1;
});
const hashDone = o => { if (!o.done) { const n = o.parts.reduce((s, b) => s + b.length, 0), all = new Uint8Array(n); let k = 0; for (const b of o.parts) { all.set(b, k); k += b.length; } o.done = o.alg.f(all); o.parts = null; } return o.done; };
def('ADVAPI32', 'CryptGetHashParam', 5, function (h, param, buf, pn, fl) {
  const o = hashOf(this, h); if (!o) { this.lastError = 6; return 0; }
  const val = param === 1 ? (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, o.alg === CALG[0x8003] ? 0x8003 : 0x8004, true); return b; })()   // HP_ALGID
    : param === 2 ? hashDone(o)                                                                                                                                   // HP_HASHVAL
    : param === 4 ? (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, o.alg.size, true); return b; })() : null;                          // HP_HASHSIZE
  if (!val) { this.lastError = 0x80090009; return 0; }   // NTE_BAD_FLAGS (a parameter it has not)
  const have = this.r32(pn); this.w32(pn, val.length);
  if (!buf) return 1;
  if (have < val.length) { this.lastError = 234; return 0; }   // ERROR_MORE_DATA
  this.u8.set(val, buf); return 1;
});
def('ADVAPI32', 'CryptDestroyHash', 1, function (h) { if (!hashOf(this, h)) { this.lastError = 6; return 0; } this.handles.delete(h); return 1; });
// CryptSetHashParam: HP_HASHVAL sets the hash's value (CRYPT32 verifies a signature over a hash it computed itself)
def('ADVAPI32', 'CryptSetHashParam', 4, function (h, param, data, fl) {
  const o = hashOf(this, h); if (!o) { this.lastError = 6; return 0; }
  if (param !== 2) { this.lastError = 0x80090009; return 0; }
  o.done = this.u8.slice(data, data + o.alg.size); o.parts = null; return 1;
});
// RSA public keys and PKCS #1 v1.5 signatures, as the base provider verifies them: WinVerifyTrust's Authenticode check
// (SOFTPUB, CRYPT32) of a signed CAB, Java Package Manager's xmldso4.cab on Windows 98's first start, which failed with
// TRUST_E (0x800B010B) as CryptImportKey had no keys. A PUBLICKEYBLOB (PUBLICKEYSTRUC, RSAPUBKEY 'RSA1', the modulus)
// and the signature are little-endian
const NTE_BAD_KEY = 0x80090003, NTE_BAD_SIGNATURE = 0x80090006, NTE_BAD_TYPE = 0x8009000a;
const leBig = b => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };
const modPow = (b, e, m) => { let r = 1n; b %= m; for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; } return r; };
const DIGEST_INFO = { md5: [0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00, 0x04, 0x10],
  sha1: [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14] };
def('ADVAPI32', 'CryptImportKey', 6, function (prov, data, len, pub, fl, out) {
  if (len < 20 || this.u8[data] !== 6 || this.r32(data + 8) !== 0x31415352) { this.lastError = this.u8[data] !== 6 ? NTE_BAD_TYPE : NTE_BAD_KEY; return 0; }   // (a PUBLICKEYBLOB of RSA1 alone)
  const bits = this.r32(data + 12), k = bits >> 3; if (!k || 20 + k > len) { this.lastError = NTE_BAD_KEY; return 0; }
  const key = { kind: 'cryptkey', alg: this.r32(data + 4), bits, e: BigInt(this.r32(data + 16)), n: leBig(this.u8.subarray(data + 20, data + 20 + k)) };
  this.w32(out, this.newHandle(key)); return 1;
});
const keyOf = (p, h) => { const o = p.obj(h); return o && o.kind === 'cryptkey' ? o : null; };
/** the signature `sig` (little-endian, `len` bytes) of hash `h` checked with public key `k`; CRYPT_NOHASHOID (1): the
 *  hash alone after the padding, without its DigestInfo */
function rsaVerify(p, h, sig, len, k, fl) {
  const o = hashOf(p, h), key = keyOf(p, k);
  if (!o) { p.lastError = NTE_BAD_HASH; return 0; }
  if (!key) { p.lastError = NTE_BAD_KEY; return 0; }
  const size = (key.bits + 7) >> 3; if (len !== size) { p.lastError = NTE_BAD_SIGNATURE; return 0; }
  let m = modPow(leBig(p.u8.subarray(sig, sig + len)), key.e, key.n);
  const em = new Uint8Array(size); for (let i = size - 1; i >= 0; i--) { em[i] = Number(m & 0xffn); m >>= 8n; }
  const t = [...(fl & 1 ? [] : DIGEST_INFO[o.alg.name] || []), ...hashDone(o)];
  let i = 2; if (em[0] !== 0 || em[1] !== 1) { p.lastError = NTE_BAD_SIGNATURE; return 0; }
  while (i < size && em[i] === 0xff) i++;
  const ok = i >= 10 && em[i] === 0 && size - i - 1 === t.length && t.every((v, j) => em[i + 1 + j] === v);
  if (!ok) { p.lastError = NTE_BAD_SIGNATURE; return 0; }
  return 1;
}
def('ADVAPI32', 'CryptVerifySignatureA', 6, function (h, sig, len, k, desc, fl) { return rsaVerify(this, h, sig, len, k, fl); });
def('ADVAPI32', 'CryptVerifySignatureW', 6, function (h, sig, len, k, desc, fl) { return rsaVerify(this, h, sig, len, k, fl); });
// CryptGetKeyParam: KP_ALGID (7), KP_BLOCKLEN (8), KP_KEYLEN (9), as DWORDs
def('ADVAPI32', 'CryptGetKeyParam', 5, function (k, param, buf, pn, fl) {
  const key = keyOf(this, k); if (!key) { this.lastError = NTE_BAD_KEY; return 0; }
  const v = param === 7 ? key.alg : param === 8 || param === 9 ? key.bits : null;
  if (v === null) { this.lastError = 0x80090009; return 0; }
  const have = this.r32(pn); this.w32(pn, 4); if (!buf) return 1;
  if (have < 4) { this.lastError = 234; return 0; }
  this.w32(buf, v); return 1;
});
for (const [nm, n] of [['CryptGenKey', 4], ['CryptDeriveKey', 5], ['CryptGetUserKey', 3], ['CryptEncrypt', 7], ['CryptDecrypt', 6], ['CryptSignHashA', 6], ['CryptHashSessionKey', 3]])
  def('ADVAPI32', nm, n, function () { this.lastError = NTE_BAD_ALGID; return 0; });
def('ADVAPI32', 'CryptDestroyKey', 1, function (k) { if (!keyOf(this, k)) { this.lastError = NTE_BAD_KEY; return 0; } this.handles.delete(k); return 1; });

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

window.W95Win32 = { versionInfo, log,regAttach, regGet, regKids, regVals, regDel, regSet, regDump, regApply, regLoad, regHive, regReadHive, regWatch: f => regWatchers.add(f), Process, API, STAND_IN, LAYOUT, WM, YIELD, iniGet, iniSet, iniRead, peString, peResource, faultText, fmtMsg, def, dcOf, GuestError, HangError, FaultError, mkCanvas, dibOut, sha256, sehStep, SEH_CONT };
})();
