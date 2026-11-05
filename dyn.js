'use strict';
// Run-time translation of code that exists only at run time: the blit routines DIBENG.DLL compiles into its data
// segment for each BitBlt, and any other generated code. Each basic block is decoded from guest memory and
// emitted as a wasm function with the static recompiler's conventions (tools/recomp.py): registers and flags in the
// shared "cpu" globals, guest memory as the shared linear memory, segment bases in the cached base globals, and the
// function returns the linear address to continue at. Blocks are cached by address and re-translated when the
// guest bytes under them change.
(() => {
const { Process, LAYOUT } = window.W95Win32;
const P = Process.prototype;
const u32 = v => v >>> 0;

// layout shared with tools/recomp.py
const LDT = 0x30000, ACC = 0x40000, MEM_PAGES = 2048;
const G = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb',
  'if',    // the interrupt flag (win32.js CPU_REGS): CLI, STI, PUSHF, POPF and IRET here keep it
  'xf'];   // the flags POPF and IRET keep for PUSHF and nothing else sets: AF, NT, AC, ID (flagsWord)
const GI = Object.fromEntries(G.map((n, i) => [n, i]));
const SEG = [['es', 'esb'], ['cs', 'csb'], ['ss', 'ssb'], ['ds', 'dsb'], ['fsel', 'fs'], ['gsel', 'gsb']];   // by sreg number
const I32 = 0x7f, I64 = 0x7e;

// ---------------------------------------------------------------- wasm encoding
const uleb = n => { const o = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sleb = n => { const o = []; n |= 0; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const sleb64 = n => { const o = []; n = BigInt.asIntN(64, BigInt(n)); for (;;) { const b = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const str = s => [...uleb(s.length), ...[...s].map(c => c.charCodeAt(0))];
const vec = items => [...uleb(items.length), ...items.flat()];
const OP = { eqz: 0x45, eq: 0x46, ne: 0x47, lt_s: 0x48, lt_u: 0x49, gt_s: 0x4a, gt_u: 0x4b, le_s: 0x4c, le_u: 0x4d, ge_s: 0x4e, ge_u: 0x4f,
  clz: 0x67, popcnt: 0x69, add: 0x6a, sub: 0x6b, mul: 0x6c, div_s: 0x6d, div_u: 0x6e, rem_s: 0x6f, rem_u: 0x70, and: 0x71, or: 0x72, xor: 0x73,
  shl: 0x74, shr_s: 0x75, shr_u: 0x76, rotl: 0x77, rotr: 0x78 };
const OP64 = { eqz: 0x50, ne: 0x52, lt_s: 0x53, add: 0x7c, sub: 0x7d, mul: 0x7e, div_s: 0x7f, div_u: 0x80, rem_s: 0x81, rem_u: 0x82, and: 0x83, or: 0x84, xor: 0x85, shl: 0x86, shr_s: 0x87, shr_u: 0x88 };
const WRAP = 0xa7, EXT_S = 0xac, EXT_U = 0xad;

// (the f64 operations the x87's translation uses)
const F64 = { load: 0x2b, store: 0x39, add: 0xa0, sub: 0xa1, mul: 0xa2, div: 0xa3, abs: 0x99, neg: 0x9a, ceil: 0x9b, floor: 0x9c, trunc: 0x9d, nearest: 0x9e, sqrt: 0x9f,
  eq: 0x61, ne: 0x62, lt: 0x63, gt: 0x64, fromI32: 0xb7, fromI64: 0xb9, fromF32: 0xbb, toF32: 0xb6 };
const F64T = 0x7c, NF = 4;   // (four f64 locals, the first ones: the x87's operands and result)

class Fn {
  constructor() { this.b = []; this.nloc = 0; this.n64 = 0; this.l64 = []; }
  e(...x) { for (const v of x) Array.isArray(v) ? this.b.push(...v) : this.b.push(v); return this; }
  c(v) { return this.e(0x41, sleb(v)); }
  c64(v) { return this.e(0x42, sleb64(v)); }
  cf(v) { const b = new Uint8Array(new Float64Array([v]).buffer); return this.e(0x44, ...b); }
  op(n) { return this.e(OP[n]); }
  op64(n) { return this.e(OP64[n]); }
  fop(n) { return this.e(F64[n]); }
  loc() { if (this.n64) throw new Error('i32 locals come first'); return NF + this.nloc++; }
  loc64() { this.l64.push(NF + this.nloc + this.n64); return NF + this.nloc + this.n64++; }
  lg(i) { return this.e(0x20, uleb(i)); }
  ls(i) { return this.e(0x21, uleb(i)); }
  lt(i) { return this.e(0x22, uleb(i)); }
  gg(n) { return this.e(0x23, uleb(GI[n])); }
  gs(n) { return this.e(0x24, uleb(GI[n])); }
  ld(sz, signed) { return this.e(sz === 4 ? 0x28 : sz === 2 ? (signed ? 0x2e : 0x2f) : (signed ? 0x2c : 0x2d), 0, 0); }
  st(sz) { return this.e(sz === 4 ? 0x36 : sz === 2 ? 0x3b : 0x3a, 0, 0); }
  if_() { return this.e(0x04, 0x40); }
  else_() { return this.e(0x05); }
  end() { return this.e(0x0b); }
  body() {
    const groups = [[...uleb(NF), F64T]]; if (this.nloc) groups.push([...uleb(this.nloc), I32]); if (this.n64) groups.push([...uleb(this.n64), I64]);
    const b = [...uleb(groups.length), ...groups.flat(), ...this.b, 0x0b]; return [...uleb(b.length), ...b];
  }
}

// ---------------------------------------------------------------- decoding
// (n: the instruction of the block being translated that it met, so the block can end before it: dynBlock)
let insnAt = 0;
class Unsupported extends Error { constructor(m) { super(m); this.n = insnAt; } }
const MASK = { 1: 0xff, 2: 0xffff, 4: -1 };
const COND = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

/** the device memory range (linear start, size) the module holding linear `lin` writes as registers, if it does; for
 *  code in no module's image (a display driver's blits compiled onto the stack: VGA.DRV's), the range of the loaded
 *  module that has one, the display driver that compiled it */
function mmioRange(p, lin) {
  if (p.vgaRange) return p.vgaRange;   // (the PC's own VGA window, before Windows: v86.js vgaInit)
  let other = null;
  for (const m of p.ne ? p.ne.values() : []) {
    const meta = m && m.meta; if (!meta) continue;
    // (a module mapped from its file has its segments each where it was allocated: its code is in one of them)
    if (meta.dynamic ? (m.segs || []).some(g => lin >= g.base && lin < g.base + g.alloc) : lin >= meta.base && lin < meta.base + meta.size) return meta.mmio || null;
    if (meta.mmio && !other) other = meta.mmio;
  }
  return p.modules && p.modules.some(m => m.base && lin >= m.base && lin < m.base + (m.size || 0)) ? null : other;
}
/** translate the block at linear `lin` (code segment base `csb`, 32-bit default when `d32`); `v86` is the linear
 *  base of a virtual-8086 machine's first megabyte when the code is that machine's: a segment register's base is then
 *  v86 + 16 * its value, INT goes through the machine's own interrupt vectors, and the BIOS's ROM calls the host */
function translate(p, lin, csb, d32, v86, limit, ss32In) {
  const vm = v86 !== undefined && v86 !== null;
  // (a V86 machine's FLAGS bits 12-14, IOPL and NT, which a 386 keeps as written and the translated code keeps no
  // global for: a word of the machine's own, past its first megabyte and the 64K above it)
  const XFLAGS = vm ? (p.v86Flags || (v86 + 0x110000)) | 0 : 0;   // (a machine's own word for them, p.v86Flags: the system VM's, whose 110000h is its threads' stacks)
  const u8 = p.u8;
  const f = new Fn();
  const T = f.loc(), A = f.loc(), B = f.loc(), R = f.loc(), C = f.loc(), X = f.loc(), K = f.loc(), D = f.loc();   // scratch locals
  const W = f.loc64();
  // code of a module that writes a device's registers (its build's mmio range, recomp.py --mmio): each store that
  // lands there goes to the host after it is made, as the module's translated code sends it
  const mm = mmioRange(p, lin);
  const dev = (a, sz, code = 0x2000000) => { if (mm) f.lg(a).c(mm[0]).op('sub').c(mm[1]).op('lt_u').if_().lg(a).c(code | sz).e(0x10, 1).end(); };
  const devLoad = (a, sz) => dev(a, sz, 0x3000000);   // (and its loads from there ask the host first, as recomp.py's do)
  // a ring-3 program's code (flat 32-bit, outside a VxD's run): an access to a page ring 3 has no access to (the null
  // page, the VxDs', the frame buffer's: win32.js PROT, a byte a page) is a page fault at the address, before it is made
  const r3 = !vm && !csb && d32 && !(p.r0Depth > 0) && !(p.cpu.cs.value & 0xffff);
  // (a call's return address checked as the stack grows: a thread's stack has protected pages below it, and runaway
  // recursion meets them as a stack fault, not running on down through the heap; ESP's own accesses are not checked)
  const ssWide = ss32In !== undefined ? ss32In : !vm && (!!(p.r32(ACC + (p.cpu.ss.value & 0xfff8)) & 0x400000) || !(p.cpu.ss.value & 0xffff));
  const callGuard = () => { if (r3 && ssWide) { f.gg('esp').c(4).op('sub').ls(K); guard(K, true); } };
  const guard = (a, wr) => { if (r3) f.lg(a).c(12).op('shr_u').e(0x2d, 0, uleb(LAYOUT.PROT)).if_().lg(a).c(wr ? 0x4000010 : 0x4000000).e(0x10, 1).gg('eip').e(0x0f).end(); };
  let pc = lin, n = 0;
  const fetch = () => u8[pc++];
  const fetch16 = () => { const v = u8[pc] | (u8[pc + 1] << 8); pc += 2; return v; };
  const fetch32 = () => { const v = u8[pc] | (u8[pc + 1] << 8) | (u8[pc + 2] << 16) | (u8[pc + 3] << 24); pc += 4; return v; };
  const fetchS8 = () => (fetch() << 24) >> 24;
  const done = next => { f.c(next | 0); return { fn: f, len: pc - lin, n }; };
  for (;;) {
    if (++n > (limit || 400)) return done(pc);   // a long straight run: continue in another block
    insnAt = n;
    const start = pc;
    f.c(start | 0).gs('eip');
    let osz = d32 ? 4 : 2, asz = d32 ? 4 : 2, seg = null, rep = null;
    let b;
    for (;;) {
      b = fetch();
      if (b === 0x66) osz = d32 ? 2 : 4;   // (a prefix given twice is given once, not undone: DIBENG's 66 66 9A, a 16:16 far call from its 32-bit blit code, ran as 16:32 to 885F:343703BD, RUNONCE's fault on Windows 98's first start)
      else if (b === 0x67) asz = d32 ? 2 : 4;
      else if (b === 0x26 || b === 0x2e || b === 0x36 || b === 0x3e) seg = (b >> 3) & 3;
      else if (b === 0x64) seg = 4; else if (b === 0x65) seg = 5;
      else if (b === 0xf3 || b === 0xf2) rep = b;
      else if (b === 0xf0) { /* lock: one processor */ }
      else break;
    }
    // ---- operands
    const sbase = s => SEG[s][1];
    const modrm = () => {
      const m = fetch(), mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
      if (mod === 3) return { reg, rm, isReg: true };
      // effective address into local A (then plus segment base)
      let defSeg = 3, onStack = false;
      if (asz === 4) {
        let base = rm, idx = -1, scale = 0;
        if (rm === 4) { const sib = fetch(); scale = sib >> 6; idx = (sib >> 3) & 7; base = sib & 7; if (idx === 4) idx = -1; }
        let disp = 0, hasBase = true;
        onStack = base === 4 && idx < 0;
        if (mod === 0 && base === 5) { hasBase = false; disp = fetch32(); }
        else if (mod === 1) disp = fetchS8(); else if (mod === 2) disp = fetch32();
        f.c(disp);
        if (hasBase) { f.gg(G[base]).op('add'); if (base === 4 || base === 5) defSeg = 2; }
        if (idx >= 0) { f.gg(G[idx]); if (scale) f.c(scale).op('shl'); f.op('add'); }
      } else {
        let disp = 0;
        if (mod === 0 && rm === 6) disp = fetch16(); else if (mod === 1) disp = fetchS8(); else if (mod === 2) disp = (fetch16() << 16) >> 16;
        const R16 = [['ebx', 'esi'], ['ebx', 'edi'], ['ebp', 'esi'], ['ebp', 'edi'], ['esi'], ['edi'], ['ebp'], ['ebx']][rm];
        f.c(disp);
        if (!(mod === 0 && rm === 6)) { for (const r of R16) f.gg(r).op('add'); if (rm === 2 || rm === 3 || rm === 6) defSeg = 2; }
        f.c(0xffff).op('and');
      }
      const sr = seg === null ? defSeg : seg;
      f.gg(sbase(sr)).op('add').ls(A);
      if (b !== 0x8d && !onStack) guard(A, false);   // (lea's address is no access; ESP's frame is the stack's own pages)
      return { reg, mem: true, sr };
    };
    const rdReg = (r, sz) => {
      if (sz === 1) { f.gg(G[r & 3]); if (r & 4) f.c(8).op('shr_u'); f.c(0xff).op('and'); }
      else { f.gg(G[r]); if (sz === 2) f.c(0xffff).op('and'); }
    };
    const wrReg = (r, sz, loc) => {   // value in local
      if (sz === 4) { f.lg(loc).gs(G[r]); return; }
      if (sz === 2) { f.gg(G[r]).c(0xffff0000).op('and').lg(loc).c(0xffff).op('and').op('or').gs(G[r]); return; }
      const sh = r & 4 ? 8 : 0, g = G[r & 3];
      f.gg(g).c(~(0xff << sh)).op('and').lg(loc).c(0xff).op('and'); if (sh) f.c(sh).op('shl'); f.op('or').gs(g);
    };
    const rd = (o, sz) => { if (o.isReg) rdReg(o.rm, sz); else { devLoad(A, sz); f.lg(A).ld(sz); } };
    const wr = (o, sz, loc) => { if (o.isReg) wrReg(o.rm, sz, loc); else { f.lg(A).lg(loc).st(sz); dev(A, sz); } };
    const imm = sz => sz === 1 ? fetch() : sz === 2 ? fetch16() : fetch32();
    // ---- flags
    const bits = sz => sz * 8;
    const szp = (sz) => {   // zf, sf, pf from local R
      f.lg(R); if (sz < 4) f.c(MASK[sz]).op('and'); f.op('eqz').gs('zf');
      f.lg(R).c(bits(sz) - 1).op('shr_u').c(1).op('and').gs('sf');
      f.lg(R).c(0xff).op('and').op('popcnt').c(1).op('and').op('eqz').gs('pf');
    };
    // ALU op 0..7 (add or adc sbb and sub xor cmp) on locals B (destination) and C (source): result in R, flags set.
    // Every new flag is computed from the old carry before any flag is written.
    const alu2 = (op, sz) => {
      const m = MASK[sz], w = bits(sz);
      if (op === 1 || op === 4 || op === 6) {
        f.lg(B).lg(C).op(op === 1 ? 'or' : op === 4 ? 'and' : 'xor').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); szp(sz); return;
      }
      const carry = op === 2 || op === 3, sub = op === 3 || op === 5 || op === 7;
      f.lg(B).lg(C).op(sub ? 'sub' : 'add'); if (carry) f.gg('cf').op(sub ? 'sub' : 'add'); f.ls(R);
      // the carry or borrow, from the operands widened to 64 bits
      f.lg(B).c(m).op('and').e(EXT_U).lg(C).c(m).op('and').e(EXT_U); if (carry) f.gg('cf').e(EXT_U).op64('add');
      if (sub) f.op64('lt_s'); else f.op64('add').c64(w).op64('shr_u').e(WRAP).c(1).op('and');
      f.ls(X);
      if (sub) f.lg(B).lg(C).op('xor').lg(B).lg(R).op('xor').op('and'); else f.lg(B).lg(R).op('xor').lg(C).lg(R).op('xor').op('and');
      f.c(w - 1).op('shr_u').c(1).op('and').gs('of');
      f.lg(X).gs('cf');
      szp(sz);
    };
    const cond = c => {   // push 0/1
      const k = c >> 1;
      if (k === 0) f.gg('of'); else if (k === 1) f.gg('cf'); else if (k === 2) f.gg('zf'); else if (k === 3) f.gg('cf').gg('zf').op('or');
      else if (k === 4) f.gg('sf'); else if (k === 5) f.gg('pf'); else if (k === 6) f.gg('sf').gg('of').op('xor');
      else f.gg('zf').gg('sf').gg('of').op('xor').op('or');
      if (c & 1) f.op('eqz');
    };
    // ---- stack (SS's B bit picks ESP or SP)
    // (the stack's width as the block is entered, which its cache key carries; a load of SS ends the block, so the
    // next block is translated for the new stack: USER32's 16 -> 32 callback did lss sp then retf in one block, and the
    // retf popped through the 32-bit ESP it had before, to 0:0)
    const ss32 = ssWide;
    const push = (loc, sz) => {
      if (ss32) { f.gg('esp').c(sz).op('sub').gs('esp'); f.gg('ssb').gg('esp').op('add').lg(loc).st(sz); }
      else { f.gg('esp').c(0xffff0000).op('and').gg('esp').c(sz).op('sub').c(0xffff).op('and').op('or').gs('esp'); f.gg('ssb').gg('esp').c(0xffff).op('and').op('add').lg(loc).st(sz); }
    };
    const pop = (loc, sz) => {
      if (ss32) { f.gg('ssb').gg('esp').op('add').ld(sz).ls(loc); f.gg('esp').c(sz).op('add').gs('esp'); }
      else { f.gg('ssb').gg('esp').c(0xffff).op('and').op('add').ld(sz).ls(loc); f.gg('esp').c(0xffff0000).op('and').gg('esp').c(sz).op('add').c(0xffff).op('and').op('or').gs('esp'); }
    };
    const loadSeg = (sreg, loc) => {   // selector in local -> selector and base globals
      const [sel, base] = SEG[sreg];
      f.lg(loc).c(0xffff).op('and').gs(sel);
      if (vm) { f.lg(loc).c(0xffff).op('and').c(4).op('shl').c(v86 | 0).op('add').gs(base); return; }   // (V86: the paragraph)
      f.lg(loc).c(0xfff8).op('and').c(LDT).op('add').ld(4).gs(base);
    };
    // the flags as a word: CF PF AF(0) ZF SF TF(0) IF DF OF, bit 1 set
    const flagsWord = loc => { f.gg('cf').gg('pf').c(2).op('shl').op('or').gg('zf').c(6).op('shl').op('or').gg('sf').c(7).op('shl').op('or').gg('if').c(9).op('shl').op('or').gg('df').c(10).op('shl').op('or').gg('of').c(11).op('shl').op('or').gg('xf').op('or').c(0x2).op('or').ls(loc); };
    // (the flags kept as they were popped, nothing here computing them: AF, NT, AC and ID, the xf global; an i486's AC
    // and ID take what POPFD gives them, which is how a program tells it from a 386 and finds CPUID. NT is XFLAGS' in V86)
    const XM = vm ? 0x240010 : 0x244010;
    const keepX = (loc, osz) => { const m = osz === 4 ? XM : XM & 0xffff; f.gg('xf').c(~m).op('and').lg(loc).c(m).op('and').op('or').gs('xf'); };
    // a real-mode interrupt in a V86 machine: FLAGS, CS and IP pushed, IF cleared, CS:IP from the vector at 0:4n
    const realInt = (n, next) => {
      // (a vector the host hooks, as the VMM's Hook_V86_Int_Chain: the host sees the interrupt first, and takes it,
      // the code going on at the eip global, when it sets the word after XFLAGS)
      if (p.v86Hooks && p.v86Hooks.has(n)) {
        f.c(next | 0).c(0x400 + n).e(0x10, 1);
        f.c(XFLAGS + 2).ld(2).if_().c(XFLAGS + 2).c(0).st(2).gg('eip').e(0x0f).end();
      }
      flagsWord(T); f.lg(T).c(XFLAGS).ld(2).op('or').ls(T); push(T, 2); f.gg('cs').ls(T); push(T, 2); f.c(u32(next - csb) & 0xffff).ls(T); push(T, 2);
      f.c(0).gs('if');
      f.c((v86 + n * 4 + 2) | 0).ld(2).ls(B); loadSeg(1, B);
      f.c((v86 + n * 4) | 0).ld(2).gg('csb').op('add').e(0x0f);
    };
    const offOf = ln => u32(ln - csb);   // a linear address within this code segment, as an offset
    // ---- the instruction
    if (b < 0x40 && (b & 7) < 6) {   // ALU forms
      const op = b >> 3, form = b & 7, sz = form & 1 ? osz : 1;
      if (form < 4) {
        const o = modrm(), dir = form & 2;
        if (dir) { rdReg(o.reg, sz); f.ls(B); rd(o, sz); f.ls(C); } else { rd(o, sz); f.ls(B); rdReg(o.reg, sz); f.ls(C); }
        alu2(op, sz);
        if (op !== 7) { if (dir) wrReg(o.reg, sz, R); else wr(o, sz, R); }
      } else {
        rdReg(0, sz); f.ls(B); f.c(sz === 1 ? fetch() : sz === 2 ? fetch16() : fetch32()).ls(C);
        alu2(op, sz); if (op !== 7) wrReg(0, sz, R);
      }
      continue;
    }
    if (b >= 0x40 && b < 0x50) {   // inc/dec r
      const r = b & 7, dec = b >= 0x48, cf = K;
      f.gg('cf').ls(cf); rdReg(r, osz); f.ls(B); f.c(1).ls(C); alu2(dec ? 5 : 0, osz); f.lg(cf).gs('cf'); wrReg(r, osz, R); continue;
    }
    if (b >= 0x50 && b < 0x58) { rdReg(b & 7, osz); f.ls(T); push(T, osz); continue; }
    if (b >= 0x58 && b < 0x60) { pop(T, osz); wrReg(b & 7, osz, T); continue; }
    if (b === 0x68 || b === 0x6a) { f.c(b === 0x68 ? (osz === 4 ? fetch32() : fetch16()) : fetchS8()).ls(T); push(T, osz); continue; }
    if (b === 0x06 || b === 0x0e || b === 0x16 || b === 0x1e) { f.gg(SEG[b >> 3][0]).ls(T); push(T, osz); continue; }
    if (b === 0x07 || b === 0x17 || b === 0x1f) { pop(T, osz); loadSeg(b >> 3, T); if (b === 0x17) return done(pc); continue; }
    if (b === 0x69 || b === 0x6b) {   // imul r, rm, imm
      const o = modrm(); rd(o, osz); f.ls(B); f.c(b === 0x69 ? (osz === 4 ? fetch32() : (fetch16() << 16) >> 16) : fetchS8()).ls(C);
      imul2(f, osz, B, C, R, W); wrReg(o.reg, osz, R); continue;
    }
    if (b >= 0x70 && b < 0x80) {   // jcc short
      const d = fetchS8(), t = pc + d; cond(b & 15); f.ls(T); f.lg(T).if_().c(t | 0).e(0x0f).end(); return done(pc);
    }
    if (b >= 0x80 && b <= 0x83) {
      const sz = b === 0x80 || b === 0x82 ? 1 : osz, o = modrm();
      rd(o, sz); f.ls(B); f.c(b === 0x83 ? fetchS8() : imm(sz)).ls(C);
      alu2(o.reg, sz); if (o.reg !== 7) wr(o, sz, R); continue;
    }
    if (b === 0x84 || b === 0x85) { const sz = b & 1 ? osz : 1, o = modrm(); rd(o, sz); rdReg(o.reg, sz); f.op('and').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); szp(sz); continue; }
    if (b === 0x86 || b === 0x87) { const sz = b & 1 ? osz : 1, o = modrm(); rd(o, sz); f.ls(B); rdReg(o.reg, sz); f.ls(C); wr(o, sz, C); wrReg(o.reg, sz, B); continue; }
    if (b >= 0x88 && b <= 0x8b) {
      const sz = b & 1 ? osz : 1, o = modrm();
      if (b & 2) { rd(o, sz); f.ls(T); wrReg(o.reg, sz, T); } else { rdReg(o.reg, sz); f.ls(T); wr(o, sz, T); }
      continue;
    }
    // (segment registers 6 and 7 are none, and CS is no mov's to load: an invalid opcode, as the processor takes them;
    // indexed past the table, the translator itself threw: tools/staticmap.py)
    if (b === 0x8c) { const o = modrm(); if (o.reg > 5) throw new Unsupported(`mov from segment register ${o.reg}`); f.gg(SEG[o.reg][0]).ls(T); wr(o, o.isReg ? osz : 2, T); continue; }
    if (b === 0x8e) { const o = modrm(); if (o.reg > 5 || o.reg === 1) throw new Unsupported(`mov to segment register ${o.reg}`); rd(o, 2); f.ls(T); loadSeg(o.reg, T); if (o.reg === 2) return done(pc); continue; }
    if (b === 0x8d) { const o = modrm(); if (o.isReg) throw new Unsupported('lea with a register operand'); f.lg(A).gg(sbase(o.sr)).op('sub').ls(T); wrReg(o.reg, osz, T); continue; }   // lea: the offset (less the base its address added: SS's for BP and SP)
    if (b === 0x8f) { const o = modrm(); pop(T, osz); wr(o, osz, T); continue; }
    if (b === 0x90) continue;
    if (b === 0x60) {   // pusha: AX CX DX BX, SP as it was, BP SI DI
      rdReg(4, osz); f.ls(X);
      for (const r of [0, 1, 2, 3]) { rdReg(r, osz); f.ls(T); push(T, osz); }
      push(X, osz);
      for (const r of [5, 6, 7]) { rdReg(r, osz); f.ls(T); push(T, osz); }
      continue;
    }
    if (b === 0x61) {   // popa: DI SI BP, (SP skipped), BX DX CX AX
      for (const r of [7, 6, 5]) { pop(T, osz); wrReg(r, osz, T); }
      pop(T, osz);
      for (const r of [3, 2, 1, 0]) { pop(T, osz); wrReg(r, osz, T); }
      continue;
    }
    if (b === 0xcf) {   // iret: IP, CS, flags
      pop(T, osz); pop(B, osz); pop(C, osz);
      for (const [k, n2] of [[0, 'cf'], [2, 'pf'], [6, 'zf'], [7, 'sf'], [9, 'if'], [10, 'df'], [11, 'of']]) f.lg(C).c(k).op('shr_u').c(1).op('and').gs(n2);
      keepX(C, osz); if (vm) f.c(XFLAGS).lg(C).c(0x7000).op('and').st(2);
      loadSeg(1, B); f.lg(T).gg('csb').op('add').e(0x0f); return done(pc);
    }
    if (b === 0x9a) {   // call far ptr16:16/32
      const off = osz === 4 ? fetch32() : fetch16(), sel = fetch16();
      f.gg('cs').ls(T); push(T, osz); f.c(offOf(pc)).ls(T); push(T, osz);
      f.c(sel).ls(T); loadSeg(1, T); f.gg('csb').c(off | 0).op('add').e(0x0f); return done(pc);
    }
    if (vm && (b === 0xcd || b === 0xcc || b === 0xce)) {   // int n, int 3, into: through the machine's own vectors
      const v = b === 0xcd ? fetch() : b === 0xcc ? 3 : 4;
      if (b === 0xce) { f.gg('of').if_(); realInt(4, pc); f.end(); return done(pc); }
      realInt(v, pc); return done(pc);
    }
    if (vm && b === 0x0f && u8[pc] === 0xff) {   // 0F FF n: the BIOS ROM's call to the host (service n), then on at the eip global
      pc++; const v = fetch(); f.c(pc | 0).c(0x200 + v).e(0x10, 1); f.gg('eip').e(0x0f); return done(pc);
    }
    if (vm && b === 0xf4) { f.c(pc | 0).c(0x300).e(0x10, 1); f.gg('eip').e(0x0f); return done(pc); }   // hlt: the host waits for an interrupt
    if (b === 0x27 || b === 0x2f) {   // daa / das
      const sub = b === 0x2f; f.gg('eax').c(0xff).op('and').ls(B); f.gg('cf').ls(C);
      // low nibble > 9 (AF is not kept: taken as clear): adjust by 6; then above 99h or carry: by 60h, CF set
      f.lg(B).c(0xf).op('and').c(9).op('gt_u').if_().lg(B).c(6).op(sub ? 'sub' : 'add').c(0xff).op('and').ls(B).end();
      f.lg(B).c(sub ? 0x99 : 0x9f).op('gt_u').lg(C).op('or').ls(X);
      f.lg(X).if_().lg(B).c(0x60).op(sub ? 'sub' : 'add').c(0xff).op('and').ls(B).end();
      f.lg(X).gs('cf'); f.lg(B).ls(R); szp(1); wrReg(0, 1, B); continue;
    }
    if (b === 0x37 || b === 0x3f) {   // aaa / aas: AL's low nibble > 9 adjusts AH and AL, CF set
      const sub = b === 0x3f; f.gg('eax').c(0xf).op('and').c(9).op('gt_u').ls(X);
      f.lg(X).if_();
      f.gg('eax').c(0xff).op('and').c(6).op(sub ? 'sub' : 'add').c(0xf).op('and').ls(T);
      f.gg('eax').c(8).op('shr_u').c(1).op(sub ? 'sub' : 'add').c(0xff).op('and').c(8).op('shl').lg(T).op('or').ls(T); wrReg(0, 2, T);
      f.else_(); f.gg('eax').c(0xf).op('and').ls(T); wrReg(0, 1, T); f.end();
      f.lg(X).gs('cf'); continue;
    }
    if (b === 0xd4 || b === 0xd5) {   // aam n / aad n
      const n = fetch() || 10;
      if (b === 0xd4) { f.gg('eax').c(0xff).op('and').ls(B); f.lg(B).c(n).op('div_u').c(8).op('shl').lg(B).c(n).op('rem_u').op('or').ls(T); }
      else f.gg('eax').c(8).op('shr_u').c(0xff).op('and').c(n).op('mul').gg('eax').c(0xff).op('and').op('add').c(0xff).op('and').ls(T);
      wrReg(0, 2, T); f.lg(T).c(0xff).op('and').ls(R); szp(1); continue;
    }
    if (b === 0x9b) continue;   // fwait: the x87's exceptions are masked, nothing to wait for
    if (b >= 0xd8 && b <= 0xdf) { x87(f, b, modrm(), A); continue; }
    if (b === 0xcd) {   // int n, which the host services (the continuation in the eip global); INT 20h's service dword follows it
      const v = fetch(); if (v === 0x20) pc += 4;
      f.c(pc | 0).c(0x100 + v).e(0x10, 1); f.gg('eip').e(0x0f); return done(pc);
    }
    // int 3: the breakpoint exception after the instruction, as the recompiler raises it (trap 3); IFSMGR's
    if (b === 0xcc) { f.c(pc | 0).c(3).e(0x10, 1); f.gg('eip').e(0x0f); return done(pc); }
    if (b === 0xd6) { f.c(-1).c(0).gg('cf').e(0x1b).c(0xff).op('and').ls(T); wrReg(0, 1, T); continue; }   // salc: AL = CF ? FFh : 0
    if ((b >= 0xe4 && b <= 0xe7) || (b >= 0xec && b <= 0xef)) {   // in / out, through the host's port I/O
      const sz = b & 1 ? osz : 1, isIn = !(b & 2);
      if (b < 0xe8) f.c(fetch()); else f.gg('edx').c(0xffff).op('and');
      f.c(sz | (isIn ? 8 : 0)).e(0x10, 0);
      continue;
    }
    if (b > 0x90 && b < 0x98) { rdReg(0, osz); f.ls(B); rdReg(b & 7, osz); f.ls(C); wrReg(0, osz, C); wrReg(b & 7, osz, B); continue; }
    if (b === 0x98) { if (osz === 4) { f.gg('eax').c(16).op('shl').c(16).op('shr_s').gs('eax'); } else { f.gg('eax').c(24).op('shl').c(24).op('shr_s').ls(T); wrReg(0, 2, T); } continue; }
    if (b === 0x99) { if (osz === 4) f.gg('eax').c(31).op('shr_s').gs('edx'); else { f.gg('eax').c(16).op('shl').c(31).op('shr_s').ls(T); wrReg(2, 2, T); } continue; }
    if (b === 0x9e) { f.gg('eax').c(8).op('shr_u').ls(T); for (const [k, n2] of [[0, 'cf'], [2, 'pf'], [6, 'zf'], [7, 'sf']]) f.lg(T).c(k).op('shr_u').c(1).op('and').gs(n2); continue; }
    if (b === 0x9f) { f.gg('cf').gg('pf').c(2).op('shl').op('or').gg('zf').c(6).op('shl').op('or').gg('sf').c(7).op('shl').op('or').c(2).op('or').ls(T); f.gg('eax').c(0xffff00ff).op('and').lg(T).c(8).op('shl').op('or').gs('eax'); continue; }
    if (b >= 0xa0 && b <= 0xa3) {   // mov al/eax, moffs
      const sz = b & 1 ? osz : 1, off = asz === 4 ? fetch32() : fetch16();
      f.c(off).gg(sbase(seg === null ? 3 : seg)).op('add').ls(A); guard(A, !!(b & 2));
      if (b & 2) { rdReg(0, sz); f.ls(T); f.lg(A).lg(T).st(sz); dev(A, sz); } else { devLoad(A, sz); f.lg(A).ld(sz).ls(T); wrReg(0, sz, T); }
      continue;
    }
    if (b === 0xa8 || b === 0xa9) { const sz = b & 1 ? osz : 1; rdReg(0, sz); f.c(imm(sz)).op('and').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); szp(sz); continue; }
    if ((b >= 0xa4 && b <= 0xa7) || (b >= 0xaa && b <= 0xaf) || (b >= 0x6c && b <= 0x6f)) { strop(f, b, osz, asz, seg, rep, { T, A, B, C, R, X, D }, alu2, szp, dev, guard); continue; }
    if (b >= 0xb0 && b < 0xb8) { f.c(fetch()).ls(T); wrReg(b & 7, 1, T); continue; }
    if (b >= 0xb8 && b < 0xc0) { f.c(osz === 4 ? fetch32() : fetch16()).ls(T); wrReg(b & 7, osz, T); continue; }
    if (b === 0xc0 || b === 0xc1 || (b >= 0xd0 && b <= 0xd3)) {
      const sz = b & 1 ? osz : 1, o = modrm();
      if (b === 0xc0 || b === 0xc1) f.c(fetch() & 31); else if (b <= 0xd1) f.c(1); else f.gg('ecx').c(31).op('and');
      f.ls(C);
      shift(f, o.reg, sz, o, rd, wr, { B, C, R, T }, szp);
      continue;
    }
    if (b === 0xc2 || b === 0xc3) {   // ret near
      const n2 = b === 0xc2 ? fetch16() : 0; pop(T, osz);
      if (n2) { if (ss32) f.gg('esp').c(n2).op('add').gs('esp'); else f.gg('esp').c(0xffff0000).op('and').gg('esp').c(n2).op('add').c(0xffff).op('and').op('or').gs('esp'); }
      f.lg(T).gg('csb').op('add').e(0x0f); return done(pc);
    }
    if (b === 0xc4 || b === 0xc5) {   // les / lds
      const o = modrm(); f.lg(A).ld(osz).ls(T); f.lg(A).c(osz).op('add').ld(2).ls(B); wrReg(o.reg, osz, T); loadSeg(b === 0xc4 ? 0 : 3, B); continue;
    }
    if (b === 0xc6 || b === 0xc7) { const sz = b & 1 ? osz : 1, o = modrm(); f.c(imm(sz)).ls(T); wr(o, sz, T); continue; }
    if (b === 0xca || b === 0xcb) {   // retf
      const n2 = b === 0xca ? fetch16() : 0; pop(T, osz); pop(B, osz); loadSeg(1, B);
      if (n2) { if (ss32) f.gg('esp').c(n2).op('add').gs('esp'); else f.gg('esp').c(0xffff0000).op('and').gg('esp').c(n2).op('add').c(0xffff).op('and').op('or').gs('esp'); }
      f.lg(T).gg('csb').op('add').e(0x0f); return done(pc);
    }
    if (b === 0xe2 || b === 0xe1 || b === 0xe0 || b === 0xe3) {   // loop / loope / loopne / jcxz
      const d = fetchS8(), t = pc + d;
      if (b === 0xe3) { f.gg('ecx'); if (asz === 2) f.c(0xffff).op('and'); f.op('eqz'); }
      else {
        if (asz === 4) f.gg('ecx').c(1).op('sub').gs('ecx'); else f.gg('ecx').c(0xffff0000).op('and').gg('ecx').c(1).op('sub').c(0xffff).op('and').op('or').gs('ecx');
        f.gg('ecx'); if (asz === 2) f.c(0xffff).op('and'); f.c(0).op('ne');
        if (b === 0xe1) f.gg('zf').op('and'); if (b === 0xe0) f.gg('zf').op('eqz').op('and');
      }
      f.if_().c(t | 0).e(0x0f).end(); return done(pc);
    }
    if (b === 0xe8) { const d = osz === 4 ? fetch32() : (fetch16() << 16) >> 16; callGuard(); f.c(offOf(pc)).ls(T); push(T, osz); return done(osz === 4 ? pc + d : csb + ((pc - csb + d) & 0xffff)); }
    if (b === 0xe9) { const d = osz === 4 ? fetch32() : (fetch16() << 16) >> 16; return done(osz === 4 ? pc + d : csb + ((pc - csb + d) & 0xffff)); }
    if (b === 0xeb) { const d = fetchS8(); return done(pc + d); }
    if (b === 0xea) {   // jmp far ptr16:16/32
      const off = osz === 4 ? fetch32() : fetch16(), sel = fetch16();
      f.c(sel).ls(T); loadSeg(1, T); f.gg('csb').c(off | 0).op('add').e(0x0f); return done(pc);
    }
    if (b === 0xf5) { f.gg('cf').op('eqz').gs('cf'); continue; }
    if (b === 0xf8 || b === 0xf9) { f.c(b & 1).gs('cf'); continue; }
    if (b === 0xfc || b === 0xfd) { f.c(b & 1).gs('df'); continue; }
    if (b === 0xfa || b === 0xfb) { f.c(b & 1).gs('if'); continue; }   // cli / sti: the interrupt flag (interrupts arrive between blocks, when it is set)
    if (b === 0xf6 || b === 0xf7) {
      const sz = b & 1 ? osz : 1, o = modrm();
      if (o.reg <= 1) { rd(o, sz); f.c(imm(sz)).op('and').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); szp(sz); continue; }
      if (o.reg === 2) { rd(o, sz); f.c(-1).op('xor').ls(T); wr(o, sz, T); continue; }
      if (o.reg === 3) { f.c(0).ls(B); rd(o, sz); f.ls(C); alu2(5, sz); wr(o, sz, R); continue; }
      muldiv(f, o.reg, sz, o, rd, { T, B, C, R, X, W }, rdReg, wrReg);
      continue;
    }
    if (b === 0xfe || b === 0xff) {
      const sz = b & 1 ? osz : 1, o = modrm();
      if (o.reg <= 1) { const cf = K; f.gg('cf').ls(cf); rd(o, sz); f.ls(B); f.c(1).ls(C); alu2(o.reg ? 5 : 0, sz); f.lg(cf).gs('cf'); wr(o, sz, R); continue; }
      if (b === 0xff && o.reg === 6) { rd(o, osz); f.ls(T); push(T, osz); continue; }
      if (b === 0xff && o.reg === 4) { rd(o, osz); f.gg('csb').op('add').e(0x0f); return done(pc); }
      if (b === 0xff && o.reg === 2) { rd(o, osz); f.ls(B); callGuard(); f.c(offOf(pc)).ls(T); push(T, osz); f.lg(B).gg('csb').op('add').e(0x0f); return done(pc); }
      if (b === 0xff && (o.reg === 3 || o.reg === 5)) {   // call/jmp far [mem]
        f.lg(A).ld(osz).ls(B); f.lg(A).c(osz).op('add').ld(2).ls(C);
        if (o.reg === 3) { f.gg('cs').ls(T); push(T, osz); f.c(offOf(pc)).ls(T); push(T, osz); }
        loadSeg(1, C); f.lg(B).gg('csb').op('add').e(0x0f); return done(pc);
      }
    }
    if (b === 0x0f) {
      const b2 = fetch();
      if (b2 >= 0x80 && b2 < 0x90) { const d = osz === 4 ? fetch32() : (fetch16() << 16) >> 16, t = osz === 4 ? pc + d : csb + ((pc - csb + d) & 0xffff); cond(b2 & 15); f.if_().c(t | 0).e(0x0f).end(); return done(pc); }
      if (b2 >= 0x90 && b2 < 0xa0) { const o = modrm(); cond(b2 & 15); f.ls(T); wr(o, 1, T); continue; }
      if (b2 === 0xb6 || b2 === 0xb7 || b2 === 0xbe || b2 === 0xbf) {
        const ssz = b2 & 1 ? 2 : 1, o = modrm(); rd(o, ssz);
        if (b2 >= 0xbe) { const sh = 32 - ssz * 8; f.c(sh).op('shl').c(sh).op('shr_s'); }
        f.ls(T); wrReg(o.reg, osz, T); continue;
      }
      if (b2 === 0xaf) { const o = modrm(); rdReg(o.reg, osz); f.ls(B); rd(o, osz); f.ls(C); imul2(f, osz, B, C, R, W); wrReg(o.reg, osz, R); continue; }
      if (b2 >= 0xc8 && b2 < 0xd0) { const r = b2 & 7; f.gg(G[r]).ls(T); f.lg(T).c(24).op('shl').lg(T).c(8).op('shl').c(0xff0000).op('and').op('or').lg(T).c(8).op('shr_u').c(0xff00).op('and').op('or').lg(T).c(24).op('shr_u').op('or').gs(G[r]); continue; }
      if (b2 === 0xa4 || b2 === 0xa5 || b2 === 0xac || b2 === 0xad) {   // shld / shrd
        const o = modrm(), left = b2 < 0xa8; f.c(b2 & 1 ? 0 : fetch()); if (b2 & 1) f.gg('ecx'); else f.c(0).op('or'); f.c(31).op('and').ls(C);
        rd(o, osz); f.ls(B); rdReg(o.reg, osz); f.ls(T);
        f.lg(C).if_();
        if (osz === 4) {
          if (left) f.lg(B).lg(C).op('shl').lg(T).c(32).lg(C).op('sub').op('shr_u').op('or').ls(R).lg(B).c(32).lg(C).op('sub').op('shr_u').c(1).op('and').gs('cf');
          else f.lg(B).lg(C).op('shr_u').lg(T).c(32).lg(C).op('sub').op('shl').op('or').ls(R).lg(B).lg(C).c(1).op('sub').op('shr_u').c(1).op('and').gs('cf');
        } else if (left) f.lg(B).c(16).op('shl').lg(T).c(0xffff).op('and').op('or').lg(C).op('shl').c(16).op('shr_u').ls(R).lg(B).c(16).lg(C).op('sub').op('shr_u').c(1).op('and').gs('cf');
        else f.lg(T).c(16).op('shl').lg(B).c(0xffff).op('and').op('or').lg(C).op('shr_u').c(0xffff).op('and').ls(R).lg(B).lg(C).c(1).op('sub').op('shr_u').c(1).op('and').gs('cf');   // counts past 16 are undefined on x86
        f.lg(R).lg(B).op('xor').c(osz * 8 - 1).op('shr_u').c(1).op('and').gs('of');   // (OF: the sign changed, as a 1-bit shift sets it)
        szp(osz); wr(o, osz, R); f.end(); continue;
      }
      if (b2 === 0xa0 || b2 === 0xa8) { f.gg(b2 === 0xa0 ? 'fsel' : 'gsel').ls(T); push(T, osz); continue; }
      if (b2 === 0xa1 || b2 === 0xa9) { pop(T, osz); loadSeg(b2 === 0xa1 ? 4 : 5, T); continue; }
      if (b2 === 0xb2 || b2 === 0xb4 || b2 === 0xb5) { const o = modrm(); f.lg(A).ld(osz).ls(T); f.lg(A).c(osz).op('add').ld(2).ls(B); wrReg(o.reg, osz, T); loadSeg(b2 === 0xb2 ? 2 : b2 === 0xb4 ? 4 : 5, B); if (b2 === 0xb2) return done(pc); continue; }
      // cpuid: the processor as the machine is one (an i486DX4: tools/recomp.py x_cpuid)
      if (b2 === 0xa2) {
        f.gg('eax').op('eqz').if_().c(1).gs('eax').c(0x756e6547).gs('ebx').c(0x49656e69).gs('edx').c(0x6c65746e).gs('ecx').else_();
        f.gg('eax').c(1).op('eq').if_().c(0x480).gs('eax').c(0).gs('ebx').c(0).gs('ecx').c(1).gs('edx').else_().c(0).gs('eax').c(0).gs('ebx').c(0).gs('ecx').c(0).gs('edx').end().end();
        continue;
      }
      // cmpxchg: the accumulator compared with the destination (flags as cmp); equal, the source goes there, else the
      // destination into the accumulator
      if (b2 === 0xb0 || b2 === 0xb1) {
        const sz = b2 & 1 ? osz : 1, o = modrm();
        rdReg(0, sz); f.ls(B); rd(o, sz); f.ls(C); alu2(7, sz);
        f.lg(B).lg(C).op('eq').if_(); rdReg(o.reg, sz); f.ls(T); wr(o, sz, T); f.else_(); wrReg(0, sz, C); f.end();
        continue;
      }
      // xadd: the sum (flags as add) to the destination, the destination's old value to the source register
      if (b2 === 0xc0 || b2 === 0xc1) {
        const sz = b2 & 1 ? osz : 1, o = modrm();
        rd(o, sz); f.ls(B); rdReg(o.reg, sz); f.ls(C); alu2(0, sz);
        wrReg(o.reg, sz, B); wr(o, sz, R);
        continue;
      }
      if (b2 === 0xa3 || b2 === 0xab || b2 === 0xb3 || b2 === 0xbb || b2 === 0xba) {   // bt / bts / btr / btc
        const o = modrm();
        const kind = b2 === 0xba ? o.reg - 4 : [0xa3, 0xab, 0xb3, 0xbb].indexOf(b2);   // 0 bt, 1 bts, 2 btr, 3 btc
        if (b2 === 0xba) f.c(fetch());
        else if (!o.isReg) {   // (a memory operand with a register's bit index: the index, signed, picks the operand-sized word from the address on; IFSMGR's)
          rdReg(o.reg, osz); if (osz === 2) f.c(16).op('shl').c(16).op('shr_s'); f.ls(X);
          f.lg(A).lg(X).c(osz === 4 ? 5 : 4).op('shr_s').c(osz === 4 ? 2 : 1).op('shl').op('add').ls(A); f.lg(X);
        } else rdReg(o.reg, osz);
        f.c(osz * 8 - 1).op('and').ls(C); rd(o, osz); f.ls(B);
        f.lg(B).lg(C).op('shr_u').c(1).op('and').gs('cf');
        if (kind) {
          f.lg(B).c(1).lg(C).op('shl');
          if (kind === 2) f.c(-1).op('xor').op('and'); else f.op(kind === 1 ? 'or' : 'xor');
          f.ls(T); wr(o, osz, T);
        }
        continue;
      }
      if (b2 === 0xbc || b2 === 0xbd) {   // bsf / bsr: the lowest / highest set bit's index, ZF when the source is 0 (the destination left)
        const o = modrm(); rd(o, osz); f.ls(B); f.lg(B).op('eqz').gs('zf');
        f.lg(B).if_();
        if (b2 === 0xbc) f.lg(B).e(0x68).ls(T); else f.c(31).lg(B).op('clz').op('sub').ls(T);   // ctz; 31 - clz
        wrReg(o.reg, osz, T); f.end(); continue;
      }
      if (vm && b2 === 0x01 && ((u8[pc] >> 3) & 7) === 4) { const o = modrm(); f.c(0xfff0).ls(T); wr(o, 2, T); continue; }   // smsw: real mode (PE clear), as a 386 shows it
      if (b2 === 0x02 || b2 === 0x03) {   // lar / lsl, as the recompiled ones: the access word (ACC) or limit (LDT +4) of the selector's descriptor, ZF when it is in use
        const o = modrm(); rd(o, 2); f.c(0xfff8).op('and').ls(T);
        f.lg(T).c(LDT + 4).op('add').ld(4).lg(T).c(LDT).op('add').ld(4).op('or').c(0).op('ne').gs('zf');
        f.gg('zf').if_(); f.lg(T).c(b2 === 0x02 ? ACC : LDT + 4).op('add').ld(4).ls(R); wrReg(o.reg, osz, R); f.end();
        continue;
      }
      if (b2 === 0x00 && (((u8[pc] >> 3) & 7) === 4 || ((u8[pc] >> 3) & 7) === 5)) {   // verr / verw: ZF when the selector's descriptor is present (and, for verw, not code)
        const w = ((u8[pc] >> 3) & 7) === 5, o = modrm(); rd(o, 2); f.c(0xfff8).op('and').ls(T);
        f.lg(T).c(LDT + 4).op('add').ld(4).lg(T).c(LDT).op('add').ld(4).op('or').c(0).op('ne');
        if (w) f.lg(T).c(ACC).op('add').ld(4).c(0x0800).op('and').op('eqz').op('and');
        f.gs('zf'); continue;
      }
      throw new Unsupported(`0f ${b2.toString(16)}`);
    }
    if (b === 0xd7) { f.gg(sbase(seg === null ? 3 : seg)).gg('ebx'); if (asz === 2) f.c(0xffff).op('and'); f.gg('eax').c(0xff).op('and').op('add').op('add').ld(1).ls(T); wrReg(0, 1, T); continue; }
    if (b === 0x9c || b === 0x9d) {   // pushf / popf: the flags the translated code keeps
      if (b === 0x9c) { flagsWord(T); if (vm) f.lg(T).c(XFLAGS).ld(2).op('or').ls(T); push(T, osz); }
      else { pop(T, osz); for (const [k, n2] of [[0, 'cf'], [2, 'pf'], [6, 'zf'], [7, 'sf'], [9, 'if'], [10, 'df'], [11, 'of']]) f.lg(T).c(k).op('shr_u').c(1).op('and').gs(n2); keepX(T, osz); if (vm) f.c(XFLAGS).lg(T).c(0x7000).op('and').st(2); }
      continue;
    }
    if (b === 0xc8) {   // enter size, 0
      const size = fetch16(), level = fetch() & 31; if (level) throw new Unsupported(`enter with nesting level ${level}`);
      rdReg(5, osz); f.ls(T); push(T, osz);
      f.gg('esp'); if (!ss32) f.c(0xffff).op('and'); f.ls(T); wrReg(5, osz, T);
      if (ss32) f.gg('esp').c(size).op('sub').gs('esp');
      else f.gg('esp').c(0xffff0000).op('and').gg('esp').c(size).op('sub').c(0xffff).op('and').op('or').gs('esp');
      continue;
    }
    if (b === 0xc9) {   // leave
      if (ss32) { rdReg(5, 4); f.gs('esp'); } else { f.gg('esp').c(0xffff0000).op('and'); rdReg(5, 2); f.op('or').gs('esp'); }
      pop(T, osz); wrReg(5, osz, T); continue;
    }
    throw new Unsupported(`opcode ${b.toString(16)}`);
  }
}

// ---------------------------------------------------------------- the x87, as the static recompiler translates it
// (tools/recomp.py fpu): its eight registers f64s in memory at FPU (ST(i) at FPU + 8 * ((ftop + i) & 7)), the
// status, control and top in the fsw, fcw and ftop globals; its loads, stores, arithmetic, compares (C0 C2 C3 in
// fsw), rounding by the control word, and the transcendental ones through the host's math imports
const FPU = 0x10000;
const IMP = { fsin: 2, fcos: 3, ftan: 4, fatan2: 5, fexp2: 6, flog2: 7, fmod: 8, frem: 9, f80load: 10, f80store: 11 };
const [FA, FB, FR, FT] = [0, 1, 2, 3];   // (the f64 locals)
function x87(f, b, o, A) {
  const g = i => f.e(0x20, FA + i), s = i => f.e(0x21, FA + i);   // (get / set an f64 local by its number 0..3)
  const stAddr = i => { f.gg('ftop'); if (i) f.c(i).op('add'); f.c(7).op('and').c(3).op('shl').c(FPU).op('add'); };
  const stGet = i => { stAddr(i); f.e(0x2b, 3, 0); };
  const stSet = (i, val) => { stAddr(i); val(); f.e(0x39, 3, 0); };
  const fpush = val => { val(); s(FT); f.gg('ftop').c(1).op('sub').c(7).op('and').gs('ftop'); stSet(0, () => g(FT)); };
  const fpop = () => { f.gg('ftop').c(1).op('add').c(7).op('and').gs('ftop'); };
  const load = kind => {   // a memory operand at local A, as an f64
    f.lg(A);
    if (kind === 'f32') f.e(0x2a, 2, 0).fop('fromF32'); else if (kind === 'f64') f.e(0x2b, 3, 0); else if (kind === 'f80') f.e(0x10, IMP.f80load);
    else if (kind === 'i16') f.e(0x2e, 1, 0).fop('fromI32'); else if (kind === 'i32') f.e(0x28, 2, 0).fop('fromI32'); else f.e(0x29, 3, 0).fop('fromI64');
  };
  const round = () => {   // the f64 on the stack rounded as FCW's rounding control says: nearest, down, up, toward zero
    s(FT); g(FT).fop('nearest'); s(FR);
    for (const [op, code] of [['floor', 1], ['ceil', 2], ['trunc', 3]]) { g(FT).fop(op); g(FR); f.gg('fcw').c(10).op('shr_u').c(3).op('and').c(code).op('eq').e(0x1b); s(FR); }
    g(FR);
  };
  const istore = (sz, trunc) => {   // ST(0) to an integer at A
    f.lg(A); stGet(0); if (trunc) f.fop('trunc'); else round();
    if (sz === 8) f.e(0xfc, 6).e(0x37, 3, 0); else f.e(0xfc, 2).e(sz === 2 ? 0x3b : 0x36, sz === 2 ? 1 : 2, 0);
  };
  const cmp = (src, pops) => {   // C3 C2 C0 from ST(0) against the source: less, equal, unordered
    stGet(0); s(FA); src(); s(FB);
    const v = () => { g(FA); g(FB); f.fop('lt').c(8).op('shl'); g(FA); g(FB); f.fop('eq').c(14).op('shl').op('or'); };
    // (unordered, a NaN either side: C3 C2 C0 all set)
    v(); f.c(0x4500); g(FA); g(FA); f.fop('eq'); g(FB); g(FB); f.fop('eq').op('and').e(0x1b);
    f.gg('fsw').c(~0x4500).op('and').op('or').gs('fsw');
    for (let i = 0; i < pops; i++) fpop();
  };
  const cmpi = (i, pop) => {   // fcomi / fucomi: ZF PF CF from ST(0) against ST(i)
    stGet(0); s(FA); stGet(i); s(FB);
    g(FA); g(FB); f.fop('lt'); g(FA); g(FA); f.fop('ne'); g(FB); g(FB); f.fop('ne').op('or').op('or').gs('cf');
    g(FA); g(FB); f.fop('eq'); g(FA); g(FA); f.fop('ne'); g(FB); g(FB); f.fop('ne').op('or').op('or').gs('zf');
    g(FA); g(FA); f.fop('ne'); g(FB); g(FB); f.fop('ne').op('or').gs('pf'); f.c(0).gs('of'); f.c(0).gs('sf');
    if (pop) fpop();
  };
  const arith = (kind, dst, src, pop) => {   // ST(dst) = ST(dst) op source
    stGet(dst); s(FA); src(); s(FB);
    stSet(dst, () => { if (kind === 'subr') { g(FB); g(FA); f.fop('sub'); } else if (kind === 'divr') { g(FB); g(FA); f.fop('div'); } else { g(FA); g(FB); f.fop(kind); } });
    if (pop) fpop();
  };
  const OPS8 = ['add', 'mul', 'com', 'comp', 'sub', 'subr', 'div', 'divr'];
  const r = o.reg, i = o.rm;
  if (!o.isReg) {   // memory forms
    if (b === 0xd8 || b === 0xdc || b === 0xda || b === 0xde) {
      const kind = { 0xd8: 'f32', 0xdc: 'f64', 0xda: 'i32', 0xde: 'i16' }[b], op = OPS8[r];
      if (op === 'com' || op === 'comp') { cmp(() => load(kind), op === 'comp' ? 1 : 0); return; }
      arith(op, 0, () => load(kind), false); return;
    }
    if (b === 0xd9) {
      if (r === 0) { fpush(() => load('f32')); return; }
      if (r === 2 || r === 3) { f.lg(A); stGet(0); f.fop('toF32').e(0x38, 2, 0); if (r === 3) fpop(); return; }
      if (r === 5) { f.lg(A).ld(2).gs('fcw'); return; }                      // fldcw
      if (r === 7) { f.lg(A).gg('fcw').st(2); return; }                      // fnstcw
      if (r === 4 || r === 6) {   // fldenv / fnstenv: the control, status and tag words (the 28-byte form's first three)
        if (r === 6) { f.lg(A).gg('fcw').st(4); f.lg(A).c(4).op('add').gg('fsw').c(~0x3800).op('and').gg('ftop').c(11).op('shl').op('or').st(4); f.lg(A).c(8).op('add').c(0xffff).st(4); }
        else { f.lg(A).ld(2).gs('fcw'); f.lg(A).c(4).op('add').ld(2).c(11).op('shr_u').c(7).op('and').gs('ftop'); f.lg(A).c(4).op('add').ld(2).c(~0x3800).op('and').gs('fsw'); }
        return;
      }
    }
    if (b === 0xdb) {
      if (r === 0) { fpush(() => load('i32')); return; }
      if (r === 1 || r === 2 || r === 3) { istore(4, r === 1); if (r !== 2) fpop(); return; }
      if (r === 5) { fpush(() => load('f80')); return; }
      if (r === 7) { f.lg(A); stGet(0); f.e(0x10, IMP.f80store); fpop(); return; }
    }
    if (b === 0xdd) {
      if (r === 0) { fpush(() => load('f64')); return; }
      if (r === 1) { istore(8, true); fpop(); return; }
      if (r === 2 || r === 3) { f.lg(A); stGet(0); f.e(0x39, 3, 0); if (r === 3) fpop(); return; }
      if (r === 7) { f.lg(A).gg('fsw').c(~0x3800).op('and').gg('ftop').c(11).op('shl').op('or').st(2); return; }   // fnstsw m16
      // fnsave / frstor: the 28-byte environment (control, status with TOP, tags, the pointers: none kept), then the
      // eight registers, ST(0) first, 10 bytes each; fnsave then initializes the unit (MSVCRT20's and CALC's state saves,
      // which tools/staticmap.py found reachable)
      if (r === 6) {
        for (let k = 0; k < 7; k++) f.lg(A).c(4 * k).op('add').c(0).st(4);
        f.lg(A).gg('fcw').st(2); f.lg(A).c(4).op('add').gg('fsw').c(~0x3800).op('and').gg('ftop').c(11).op('shl').op('or').st(2); f.lg(A).c(8).op('add').c(0xffff).st(2);
        for (let k = 0; k < 8; k++) { f.lg(A).c(28 + 10 * k).op('add'); stGet(k); f.e(0x10, IMP.f80store); }
        f.c(0).gs('ftop'); f.c(0x37f).gs('fcw'); f.c(0).gs('fsw'); return;
      }
      if (r === 4) {
        f.lg(A).ld(2).gs('fcw'); f.lg(A).c(4).op('add').ld(2).c(11).op('shr_u').c(7).op('and').gs('ftop'); f.lg(A).c(4).op('add').ld(2).c(~0x3800).op('and').gs('fsw');
        for (let k = 0; k < 8; k++) stSet(k, () => { f.lg(A).c(28 + 10 * k).op('add').e(0x10, IMP.f80load); });
        return;
      }
    }
    if (b === 0xdf) {
      if (r === 0) { fpush(() => load('i16')); return; }
      if (r === 1 || r === 2 || r === 3) { istore(2, r === 1); if (r !== 2) fpop(); return; }
      if (r === 5) { fpush(() => load('i64')); return; }
      if (r === 7) { istore(8, false); fpop(); return; }
    }
    throw new Unsupported(`x87 ${b.toString(16)} /${r} (memory)`);
  }
  // register forms
  const st = k => () => stGet(k);
  if (b === 0xd8) { const op = OPS8[r]; if (op === 'com' || op === 'comp') { cmp(st(i), op === 'comp' ? 1 : 0); return; } arith(op, 0, st(i), false); return; }
  if (b === 0xdc || b === 0xde) {
    const pop = b === 0xde;
    if (b === 0xde && r === 3 && i === 1) { cmp(st(1), 2); return; }   // fcompp
    if (r === 2 || r === 3) { cmp(st(i), (r === 3 ? 1 : 0) + (pop ? 1 : 0)); return; }
    arith(['add', 'mul', null, null, 'subr', 'sub', 'divr', 'div'][r], i, st(0), pop); return;
  }
  if (b === 0xd9) {
    if (r === 0) { stGet(i); s(FT); fpush(() => g(FT)); return; }                                 // fld st(i)
    if (r === 1) { stGet(0); s(FA); stGet(i); s(FB); stSet(0, () => g(FB)); stSet(i, () => g(FA)); return; }   // fxch
    const m = 0xc0 | (r << 3) | i;
    const K = { 0xe8: 1, 0xe9: Math.log2(10), 0xea: Math.LOG2E, 0xeb: Math.PI, 0xec: Math.log10(2), 0xed: Math.LN2, 0xee: 0 };
    if (m in K) { fpush(() => f.cf(K[m])); return; }
    if (m === 0xd0) return;                                                                          // fnop
    const un = { 0xe0: () => f.fop('neg'), 0xe1: () => f.fop('abs'), 0xfa: () => f.fop('sqrt'), 0xfe: () => f.e(0x10, IMP.fsin), 0xff: () => f.e(0x10, IMP.fcos), 0xfc: () => round(), 0xf0: () => { f.e(0x10, IMP.fexp2).cf(1).fop('sub'); } };
    if (un[m]) { stGet(0); un[m](); s(FR); stSet(0, () => g(FR)); if (m === 0xfe || m === 0xff) f.gg('fsw').c(~0x400).op('and').gs('fsw'); return; }
    if (m === 0xe4) { cmp(() => f.cf(0), 0); return; }                                                 // ftst
    if (m === 0xe5) {   // fxam: zero C3, normal C2, negative C1
      stGet(0); s(FA);
      f.gg('fsw').c(~0x4700).op('and');
      g(FA); f.cf(0).fop('eq').c(0x4000).op('mul'); g(FA); f.cf(0).fop('ne').c(0x400).op('mul').op('or'); g(FA); f.cf(0).fop('lt').c(0x200).op('mul').op('or');
      f.op('or').gs('fsw'); return;
    }
    if (m === 0xf2) { stGet(0); f.e(0x10, IMP.ftan); s(FR); stSet(0, () => g(FR)); fpush(() => f.cf(1)); return; }     // fptan
    if (m === 0xfb) { stGet(0); s(FT); stSet(0, () => { g(FT); f.e(0x10, IMP.fsin); }); fpush(() => { g(FT); f.e(0x10, IMP.fcos); }); return; }   // fsincos
    if (m === 0xf3 || m === 0xf1 || m === 0xf9) {   // fpatan, fyl2x, fyl2xp1: ST(1) = f(ST(1), ST(0)), popped
      stGet(0); s(FA); stGet(1); s(FB);
      if (m === 0xf3) { g(FB); g(FA); f.e(0x10, IMP.fatan2); } else { g(FB); g(FA); if (m === 0xf9) f.cf(1).fop('add'); f.e(0x10, IMP.flog2).fop('mul'); }
      s(FR); stSet(1, () => g(FR)); fpop(); return;
    }
    if (m === 0xf8 || m === 0xf5 || m === 0xfd) {   // fprem, fprem1, fscale
      stGet(0); s(FA); stGet(1); s(FB);
      if (m === 0xfd) { g(FA); g(FB); f.fop('trunc').e(0x10, IMP.fexp2).fop('mul'); } else { g(FA); g(FB); f.e(0x10, m === 0xf8 ? IMP.fmod : IMP.frem); }
      s(FR); stSet(0, () => g(FR)); if (m !== 0xfd) f.gg('fsw').c(~0x400).op('and').gs('fsw'); return;
    }
    if (m === 0xf6) { f.gg('ftop').c(1).op('sub').c(7).op('and').gs('ftop'); return; }              // fdecstp
    if (m === 0xf7) { fpop(); return; }                                                                // fincstp
  }
  if (b === 0xda && r === 5 && i === 1) { cmp(st(1), 2); return; }                                    // fucompp
  if (b === 0xdb) {
    if (r === 4 && i === 2) { f.gg('fsw').c(0x7f00).op('and').gs('fsw'); return; }                   // fnclex
    if (r === 4 && i === 3) { f.c(0).gs('ftop').c(0x37f).gs('fcw').c(0).gs('fsw'); return; }          // fninit
    if (r === 4 && (i === 0 || i === 1 || i === 4)) return;                                               // feni, fdisi, fsetpm: the 8087's and 287's, nothing on a 387
    if (r === 5 || r === 6) { cmpi(i, false); return; }                                                // fucomi / fcomi
  }
  if (b === 0xdd) {
    if (r === 0) return;                                                                               // ffree
    if (r === 2 || r === 3) { stGet(0); s(FT); stSet(i, () => g(FT)); if (r === 3) fpop(); return; }   // fst / fstp st(i)
    if (r === 4 || r === 5) { cmp(st(i), r === 5 ? 1 : 0); return; }                                   // fucom / fucomp
  }
  if (b === 0xdf) {
    if (r === 4 && i === 0) { f.gg('eax').c(~0xffff).op('and').gg('fsw').c(~0x3800).op('and').gg('ftop').c(11).op('shl').op('or').c(0xffff).op('and').op('or').gs('eax'); return; }   // fnstsw ax
    if (r === 5 || r === 6) { cmpi(i, true); return; }                                                 // fucomip / fcomip
  }
  throw new Unsupported(`x87 ${b.toString(16)} ${(0xc0 | (r << 3) | i).toString(16)}`);
}

// shifts and rotates: group 2, sub-op `op`, count in local C (already masked)
function shift(f, op, sz, o, rd, wr, L, szp) {
  const { B, C, R } = L, w = sz * 8, m = MASK[sz];
  f.lg(C).if_();
  rd(o, sz); f.ls(B);
  if (op === 4 || op === 6) {   // shl
    f.lg(B).lg(C).op('shl').ls(R);
    f.lg(B).c(w).lg(C).op('sub').op('shr_u').c(1).op('and').gs('cf');
    f.lg(R).c(w - 1).op('shr_u').c(1).op('and').gg('cf').op('xor').gs('of'); szp(sz);
  } else if (op === 5) {        // shr
    f.lg(B).c(m).op('and').lg(C).op('shr_u').ls(R);
    f.lg(B).c(m).op('and').lg(C).c(1).op('sub').op('shr_u').c(1).op('and').gs('cf');
    f.lg(B).c(w - 1).op('shr_u').c(1).op('and').gs('of'); szp(sz);
  } else if (op === 7) {        // sar
    const sh = 32 - w;
    f.lg(B).c(sh).op('shl').c(sh).op('shr_s').lg(C).op('shr_s').ls(R);
    f.lg(B).c(sh).op('shl').c(sh).op('shr_s').lg(C).c(1).op('sub').op('shr_s').c(1).op('and').gs('cf');
    f.c(0).gs('of'); szp(sz);
  } else if (op === 0 || op === 1) {   // rol / ror
    if (sz === 4) { f.lg(B).lg(C).op(op === 0 ? 'rotl' : 'rotr').ls(R); }
    else {
      f.lg(B).c(m).op('and').ls(B);
      f.lg(C).c(w).op('rem_u').ls(R);   // reuse R as k
      f.lg(B).lg(R).op(op === 0 ? 'shl' : 'shr_u').lg(B).c(w).lg(R).op('sub').op(op === 0 ? 'shr_u' : 'shl').op('or').c(m).op('and').ls(R);
    }
    if (op === 0) f.lg(R).c(1).op('and').gs('cf'); else f.lg(R).c(w - 1).op('shr_u').c(1).op('and').gs('cf');
    // (OF, as a 1-bit rotate sets it: ROL the top bit XOR CF, ROR the top two bits XORed)
    if (op === 0) f.lg(R).c(w - 1).op('shr_u').gg('cf').op('xor').c(1).op('and').gs('of');
    else f.lg(R).c(w - 1).op('shr_u').lg(R).c(w - 2).op('shr_u').op('xor').c(1).op('and').gs('of');
  } else {                      // rcl / rcr: a rotate of w + 1 bits, CF above the operand
    const X = f.loc64(), K = f.loc64(), mask = (1n << BigInt(w + 1)) - 1n;
    f.gg('cf').e(EXT_U).c64(w).op64('shl').lg(B).c(m).op('and').e(EXT_U).op64('or').ls(X);
    f.lg(C).c(w + 1).op('rem_u').e(EXT_U).ls(K);
    if (op === 2) f.lg(X).lg(K).op64('shl').lg(X).c64(w + 1).lg(K).op64('sub').op64('shr_u');
    else f.lg(X).lg(K).op64('shr_u').lg(X).c64(w + 1).lg(K).op64('sub').op64('shl');
    f.op64('or').c64(mask).op64('and').ls(X);
    if (op === 3) f.lg(B).c(w - 1).op('shr_u').gg('cf').op('xor').c(1).op('and').gs('of');   // before CF changes
    f.lg(X).c64(w).op64('shr_u').e(WRAP).c(1).op('and').gs('cf');
    f.lg(X).e(WRAP).c(m).op('and').ls(R);
    if (op === 2) f.lg(R).c(w - 1).op('shr_u').gg('cf').op('xor').c(1).op('and').gs('of');
  }
  wr(o, sz, R);
  f.end();
}

// imul r, r/m and imul r, r/m, imm (0Fh AFh, 69h, 6Bh): R the low half of B * C, signed; CF and OF set when the product
// does not fit the operand (a 16-bit product checked on sign-extended operands)
function imul2(f, osz, B, C, R, W) {
  if (osz === 4) {
    f.lg(B).e(EXT_S).lg(C).e(EXT_S).op64('mul').e(0x21, uleb(W));
    f.e(0x20, uleb(W)).e(WRAP).ls(R); f.e(0x20, uleb(W)).lg(R).e(EXT_S).op64('ne').gs('cf');
  } else {
    f.lg(B).c(16).op('shl').c(16).op('shr_s').lg(C).c(16).op('shl').c(16).op('shr_s').op('mul').ls(R);
    f.lg(R).c(16).op('shl').c(16).op('shr_s').lg(R).op('ne').gs('cf');
  }
  f.gg('cf').gs('of');
}

// mul / imul / div / idiv (group 3, sub-ops 4..7)
function muldiv(f, op, sz, o, rd, L, rdReg, wrReg) {
  const { T, B, C, R, W } = L;
  if (sz === 4) {
    rd(o, 4); f.ls(C);
    if (op === 4 || op === 5) {   // edx:eax = eax * src
      const ext = op === 4 ? EXT_U : EXT_S;
      f.gg('eax').e(ext).lg(C).e(ext).op64('mul').e(0x21, uleb(W));
      f.e(0x20, uleb(W)).e(WRAP).gs('eax'); f.e(0x20, uleb(W)).c64(32).op64('shr_u').e(WRAP).gs('edx');
      if (op === 4) f.gg('edx').c(0).op('ne'); else f.gg('eax').c(31).op('shr_s').gg('edx').op('ne');
      f.gs('cf'); f.gg('cf').gs('of'); return;
    }
    // eax, edx = edx:eax / src, edx:eax % src
    f.gg('edx').e(EXT_U).c64(32).op64('shl').gg('eax').e(EXT_U).op64('or').e(0x21, uleb(W));
    const ext = op === 6 ? EXT_U : EXT_S;
    f.e(0x20, uleb(W)).lg(C).e(ext).op64(op === 6 ? 'div_u' : 'div_s').e(WRAP).ls(T);
    f.e(0x20, uleb(W)).lg(C).e(ext).op64(op === 6 ? 'rem_u' : 'rem_s').e(WRAP).gs('edx');
    f.lg(T).gs('eax'); return;
  }
  if (sz === 2) {
    rd(o, 2); f.ls(C);
    if (op === 4) { f.gg('eax').c(0xffff).op('and').lg(C).op('mul').ls(R); f.lg(R).ls(T); wrReg(0, 2, T); f.lg(R).c(16).op('shr_u').ls(T); wrReg(2, 2, T); f.lg(R).c(16).op('shr_u').c(0).op('ne').gs('cf'); f.gg('cf').gs('of'); return; }
    if (op === 5) { f.gg('eax').c(16).op('shl').c(16).op('shr_s').lg(C).c(16).op('shl').c(16).op('shr_s').op('mul').ls(R); f.lg(R).ls(T); wrReg(0, 2, T); f.lg(R).c(16).op('shr_u').ls(T); wrReg(2, 2, T); f.lg(R).c(16).op('shl').c(16).op('shr_s').lg(R).op('ne').gs('cf'); f.gg('cf').gs('of'); return; }
    // dx:ax / src
    f.gg('edx').c(16).op('shl').gg('eax').c(0xffff).op('and').op('or').ls(B);
    if (op === 6) { f.lg(B).lg(C).c(0xffff).op('and').op('div_u').ls(T); f.lg(B).lg(C).c(0xffff).op('and').op('rem_u').ls(R); }
    else { f.lg(B).lg(C).c(16).op('shl').c(16).op('shr_s').op('div_s').ls(T); f.lg(B).lg(C).c(16).op('shl').c(16).op('shr_s').op('rem_s').ls(R); }
    wrReg(0, 2, T); wrReg(2, 2, R); return;
  }
  rd(o, 1); f.ls(C);
  if (op === 4) { f.gg('eax').c(0xff).op('and').lg(C).op('mul').ls(T); wrReg(0, 2, T); f.lg(T).c(8).op('shr_u').c(0).op('ne').gs('cf'); f.gg('cf').gs('of'); return; }
  if (op === 5) { f.gg('eax').c(24).op('shl').c(24).op('shr_s').lg(C).c(24).op('shl').c(24).op('shr_s').op('mul').ls(T); wrReg(0, 2, T); f.lg(T).c(24).op('shl').c(24).op('shr_s').lg(T).c(0xffff).op('and').c(16).op('shl').c(16).op('shr_s').op('ne').gs('cf'); f.gg('cf').gs('of'); return; }
  f.gg('eax').c(0xffff).op('and').ls(B);
  if (op === 6) { f.lg(B).lg(C).op('div_u').ls(T); f.lg(B).lg(C).op('rem_u').ls(R); }
  else { f.lg(B).c(16).op('shl').c(16).op('shr_s').lg(C).c(24).op('shl').c(24).op('shr_s').op('div_s').ls(T); f.lg(B).c(16).op('shl').c(16).op('shr_s').lg(C).c(24).op('shl').c(24).op('shr_s').op('rem_s').ls(R); }
  f.lg(T).c(0xff).op('and').lg(R).c(0xff).op('and').c(8).op('shl').op('or').ls(T); wrReg(0, 2, T);
}

// string instructions, with rep / repe / repne
function strop(f, b, osz, asz, seg, rep, L, alu2, szp, dev, guard) {
  const { T, A, B, C, R, D, X } = L, sz = b & 1 ? osz : 1;
  const ld = () => { f.ls(X); guard(X, false); dev(X, sz, 0x3000000); f.lg(X).ld(sz); };   // (the address on the stack: the load, a device's asked first)
  const idx = r => { f.gg(r); if (asz === 2) f.c(0xffff).op('and'); };
  const step = r => {   // r += df ? -sz : sz, within the address size
    f.gg(r).c(-sz).c(sz).gg('df').e(0x1b).op('add');
    if (asz === 2) { f.c(0xffff).op('and').gg(r).c(0xffff0000).op('and').op('or'); }
    f.gs(r);
  };
  const srcBase = seg === null ? 'dsb' : ['esb', 'csb', 'ssb', 'dsb', 'fs', 'gsb'][seg];
  const kind = b === 0x6c || b === 0x6d ? 'ins' : b === 0x6e || b === 0x6f ? 'outs' : b <= 0xa5 ? 'movs' : b <= 0xa7 ? 'cmps' : b <= 0xab ? 'stos' : b <= 0xad ? 'lods' : 'scas';
  const body = () => {
    // ins / outs: a port's value to ES:(E)DI, or DS:(E)SI's to the port, through the host's port I/O (which reads
    // and writes EAX: EAX kept around it)
    if (kind === 'ins') { f.gg('eax').ls(X); f.gg('edx').c(0xffff).op('and').c(sz | 8).e(0x10, 0); f.gg('esb'); idx('edi'); f.op('add').gg('eax').st(sz); f.lg(X).gs('eax'); step('edi'); }
    else if (kind === 'outs') { f.gg('eax').ls(X); f.gg(srcBase); idx('esi'); f.op('add').ld(sz).gs('eax'); f.gg('edx').c(0xffff).op('and').c(sz).e(0x10, 0); f.lg(X).gs('eax'); step('esi'); }
    else if (kind === 'movs') { f.gg('esb'); idx('edi'); f.op('add').lt(D); guard(D, true); f.gg(srcBase); idx('esi'); f.op('add'); ld(); f.st(sz); dev(D, sz); step('esi'); step('edi'); }
    else if (kind === 'stos') { f.gg('esb'); idx('edi'); f.op('add').lt(D); guard(D, true); f.gg('eax').st(sz); dev(D, sz); step('edi'); }
    else if (kind === 'lods') { f.gg(srcBase); idx('esi'); f.op('add'); ld(); f.ls(T); if (sz === 4) f.lg(T).gs('eax'); else f.gg('eax').c(sz === 2 ? 0xffff0000 : 0xffffff00).op('and').lg(T).op('or').gs('eax'); step('esi'); }
    else if (kind === 'scas') { f.gg('eax').ls(B); f.gg('esb'); idx('edi'); f.op('add'); ld(); f.ls(C); alu2(7, sz); step('edi'); }
    else { f.gg(srcBase); idx('esi'); f.op('add'); ld(); f.ls(B); f.gg('esb'); idx('edi'); f.op('add'); ld(); f.ls(C); alu2(7, sz); step('esi'); step('edi'); }
  };
  if (!rep) { body(); return; }
  // while (count) { body; count--; stop on zf for repe/repne with cmps/scas }
  f.e(0x02, 0x40).e(0x03, 0x40);
  idx('ecx'); f.op('eqz').e(0x0d, 1);
  body();
  if (asz === 4) f.gg('ecx').c(1).op('sub').gs('ecx'); else f.gg('ecx').c(0xffff0000).op('and').gg('ecx').c(1).op('sub').c(0xffff).op('and').op('or').gs('ecx');
  if (kind === 'cmps' || kind === 'scas') { f.gg('zf'); if (rep === 0xf2) f.op('eqz'); f.op('eqz').e(0x0d, 1); }
  f.e(0x0c, 0).end().end();
  void A; void R;
}

// ---------------------------------------------------------------- module assembly and the cache
function assemble(fn, shared) {
  const sec = (n, b) => [n, ...uleb(b.length), ...b];
  // types: 0 run () -> i32; 1 (i32, i32); 2 (f64) -> f64; 3 (f64, f64) -> f64; 4 (i32) -> f64; 5 (i32, f64)
  const types = vec([[0x60, 0, 1, I32], [0x60, 2, I32, I32, 0], [0x60, 1, F64T, 1, F64T], [0x60, 2, F64T, F64T, 1, F64T], [0x60, 1, I32, 1, F64T], [0x60, 2, I32, F64T, 0]]);
  const imp = (n, t) => [...str('env'), ...str(n), 0x00, t];
  const imps = vec([[...str('env'), ...str('mem'), 0x02, ...(shared ? [0x03, ...uleb(MEM_PAGES), ...uleb(65536)] : [0x00, ...uleb(MEM_PAGES)])], ...G.map(n => [...str('cpu'), ...str(n), 0x03, I32, 1]),
    imp('io', 1),     // function 0: port I/O (port, size | 8 for IN)
    imp('trap', 1),   // function 1: an interrupt (continuation, 100h + n)
    // functions 2-11: the x87's (IMP), as the static modules import them
    imp('fsin', 2), imp('fcos', 2), imp('ftan', 2), imp('fatan2', 3), imp('fexp2', 2), imp('flog2', 2), imp('fmod', 3), imp('frem', 3), imp('f80load', 4), imp('f80store', 5)]);
  const funcs = vec([[0]]);
  const exps = vec([[...str('run'), 0x00, 12]]);
  const code = vec([fn.body()]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, types), ...sec(2, imps), ...sec(3, funcs), ...sec(7, exps), ...sec(10, code)]);
}

/** the run-time block at linear `eip`, translated now or from the cache; null when it cannot be translated */
/** whether the block at linear `eip` can be translated, flat 32-bit code (16-bit with `d32` false): null, or what it
 *  cannot take (tools/gapmap.mjs, translating every block of every module without running it) */
P.dynCheck = function (eip, d32 = true) {
  try { const t = translate(this, u32(eip), 0, d32, null); return { len: t.len }; }
  catch (e) { if (e instanceof Unsupported) return { unsupported: e.message }; throw e; }
};
P.dynBlock = function (eip) {
  this.dynCache = this.dynCache || new Map();
  const u8 = this.u8;
  const cs = this.cpu.cs.value & 0xffff, csb = u32(this.cpu.csb.value);
  // only code inside the current code segment (flat 32-bit code, CS 0, as ring-0 VxD code runs: anywhere in memory):
  // a stray jump (to 0, or past the segment) is the guest's fault, not code
  const vm = this.v86 !== undefined && this.v86 !== null;   // (a virtual-8086 machine's code: any segment value is one)
  const flat = !vm && !cs && !csb;
  if (vm ? eip >= u8.length : !eip || (flat ? eip >= u8.length : !cs || eip < csb || eip - csb > this.selLimit(cs))) { this.trapped = `jump to unmapped address ${eip.toString(16)}${vm || flat ? '' : ` (CS ${cs.toString(16)}: base ${csb.toString(16)}, limit ${cs ? u32(this.selLimit(cs)).toString(16) : '-'})`}`; return null; }
  const d32 = !vm && (flat || !!(this.r32(ACC + (cs & 0xfff8)) & 0x400000));
  // (a translation holds the code segment's base and its operand size: the same bytes run through another segment, or
  // as 16-bit code where they ran as 32-bit, are another block. DIBENG compiles 16- and 32-bit blits into one buffer)
  // (and the stack's width, and CS itself: CS 0 and the flat selector share a base, and only CS 0's code has the ring-3
  // guard)
  const ss = this.cpu.ss.value & 0xffff, ss32 = !vm && (!ss || !!(this.r32(ACC + (ss & 0xfff8)) & 0x400000));
  // (the block this address ran last, when it is run the same way and its bytes are as they were: the common case, a
  // loop's blocks, found by number, not by the string key below. Windows 98 Setup's CAB inflating in SETUPX ran 400
  // blocks a millisecond, a quarter of the time in this lookup)
  const r0 = this.r0Depth > 0, fast = this.dynFast || (this.dynFast = new Map()), fe = fast.get(eip);
  if (fe && fe.csb === csb && fe.cs === cs && fe.d32 === d32 && fe.ss32 === ss32 && fe.vm === vm && fe.r0 === r0) {
    const b = fe.c.bytes; let i = 0; for (; i < b.length; i++) if (u8[eip + i] !== b[i]) break;
    if (i === b.length) return fe.c;
  }
  const remember = c => { fast.set(eip, { c, csb, cs, d32, ss32, vm, r0 }); return c; };
  const key =`${eip}:${csb}:${d32 ? 32 : 16}:s${ss32 ? 32 : 16}:c${cs}${vm ? 'v' : ''}${this.r0Depth > 0 ? 'r0' : ''}`;   // (ring 0's translation has no ring-3 guard)
  // (a few translations per address: two processes' programs at one base, each process's view in place in turn, arenaUse)
  const kept = this.dynCache.get(key) || [];
  let c = kept.find(k => k.bytes.every((v, i) => u8[eip + i] === v));
  if (c) return remember(c);
  let t;
  // (an instruction translation cannot take ends the block before it: what comes first runs, and the block after it
  // starts at that instruction, where the failure is the instruction's own. The end found is kept by the block's key,
  // so translating the block again (its bytes rewritten, or its translation dropped from the four kept) goes straight
  // to it, not through the failing translation first; changed bytes that fail sooner fail again and are found again,
  // and bytes that would now go further end at the kept end, a shorter block that is still right)
  const ends = this.dynEnds || (this.dynEnds = new Map());
  try { t = translate(this, eip, csb, d32, vm ? this.v86 : null, ends.get(key), ss32); }
  catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    if (e.n > 1) { ends.set(key, e.n - 1); t = translate(this, eip, csb, d32, vm ? this.v86 : null, e.n - 1, ss32); }
    else { this.trapped = `run-time code at ${eip.toString(16)} (${this.whereOf(eip)}, bytes ${Array.from(u8.subarray(eip, eip + 12), v => v.toString(16).padStart(2, '0')).join(' ')}): ${e.message}`; return null; }
  }
  t.fn.e(0x0f);
  // (the imports: the memory, port I/O, interrupts, and the x87's math, the process's own as its static modules get it)
  const e = this.imports && this.imports.env, f80 = { f80load: a => this.f80load(a), f80store: (a, v) => this.f80store(a, v) };
  const env = this.dynEnv || (this.dynEnv = { mem: this.mem, io: (port, k) => this.portIO(port & 0xffff, k & 7, !!(k & 8)), trap: (x, c) => this.trap(x, c),
    fsin: Math.sin, fcos: Math.cos, ftan: Math.tan, fatan2: Math.atan2, fexp2: x => Math.pow(2, x), flog2: Math.log2, fmod: (a, b) => a % b, frem: (a, b) => a - b * Math.round(a / b),
    ...f80, ...(e ? { f80load: e.f80load, f80store: e.f80store } : {}) });
  if (!this.cpu.xf) this.cpu.xf = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);   // (a processor made without it: v86.js's)
  const run = new WebAssembly.Instance(new WebAssembly.Module(assemble(t.fn, Object.prototype.toString.call(this.mem.buffer) === '[object SharedArrayBuffer]')), { env, cpu: this.cpu }).exports.run;
  c = { run, bytes: Array.from(u8.subarray(eip, eip + t.len)) };
  this.dynCache.set(key, [c, ...kept.slice(0, 3)]);
  return remember(c);
};
/** whether `eip` starts a block of a translated module the dispatcher runs (not hidden: another process's program at
 *  this address is not this one's code, arenaUse). The modules' code ranges by 64K page, made again when the module
 *  list changes: run-time code asked after every block, and went through every module each time */
P.staticCodeAt = function (eip) {
  const ms = this.modules || [];
  let s = this.staticPages;
  if (!s || s.arr !== ms || s.len !== ms.length) {
    const pages = new Map();
    for (const m of ms) {
      const t = m.meta; if (!t || !(t.textHi > t.textLo)) continue;
      for (let pg = t.textLo >>> 16; pg <= (t.textHi - 1) >>> 16; pg++) { let l = pages.get(pg); if (!l) pages.set(pg, l = []); l.push(m); }
    }
    s = this.staticPages = { arr: ms, len: ms.length, pages };
  }
  const l = s.pages.get(eip >>> 16); if (!l) return false;
  for (const m of l) if (eip >= m.meta.textLo && eip < m.meta.textHi && !m.hidden && this.hasBlock(m, eip)) return true;
  return false;
};
/** run run-time code from `eip` until control reaches translated module code (or the sentinel); the next address */
P.dynRun = function (eip) {
  for (let n = 0; ; n++) {
    if ((n & 0xfff) === 0xfff) { this.cpu.eip.value = eip; if (this.tick(eip)) return -1; }   // the processor's time, as the dispatcher asks
    // (an export another module enters, hooked, win32.js dispatch: a module run from its file reaches it here, never
    // through the dispatcher; a hook that answers where to go on takes the call)
    if (this.entryHooks) { const h = this.entryHooks.get(eip); if (h) { const to = h.call(this); if (to !== undefined) { eip = u32(to); if (eip === LAYOUT.SENTINEL || eip >= LAYOUT.THUNK16 || this.staticCodeAt(eip)) return eip; continue; } } }
    // (code the host runs in a module's data, ne16.js dataCode: ThunkConnect32's relays, LS thunklets. The dispatcher
    // asks for it, and so must a run of run-time code going on to its next block: Windows 98's SHELL32, mapped from
    // its file, called its LS01 relay, and the relay's padding (INT 3) ran instead)
    if (this.dataCode) { const to = this.dataCode(eip); if (to !== undefined && to !== null) { eip = u32(to); if (eip === LAYOUT.SENTINEL || eip >= LAYOUT.THUNK16 || this.staticCodeAt(eip)) return eip; continue; } }
    const blk = this.dynBlock(eip); if (!blk) return null;
    const from = eip;
    if (this.dynHook) this.dynHook(eip);   // (a diagnostic: the blocks a program runs, worker.js cmd 'blocks')
    try { eip = u32(blk.run()); }
    catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; this.trapped = `run-time code at ${eip.toString(16)} (instruction at ${u32(this.cpu.eip.value).toString(16)}): ${e.message}`; return null; }
    if (this.memW) this.memCheck(`run-time code at ${from.toString(16)}`);   // (a write watch: each block of run-time code, win32.js memCheck)
    if (eip === LAYOUT.SENTINEL || eip >= LAYOUT.THUNK16) return eip;
    if (this.staticCodeAt(eip)) return eip;   // (another process's program at this address is not this one's code: arenaUse)
  }
};
/** whether module `m` has a translated block starting at `eip` */
P.hasBlock = function (m, eip) {
  if (!m.meta.lookup) return false;
  return new Uint32Array(this.mem.buffer, m.meta.lookup + 4 * (eip - m.meta.textLo), 1)[0] !== 0;
};
})();
