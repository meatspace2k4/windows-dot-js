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
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb'];
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

class Fn {
  constructor() { this.b = []; this.nloc = 0; this.n64 = 0; this.l64 = []; }
  e(...x) { for (const v of x) Array.isArray(v) ? this.b.push(...v) : this.b.push(v); return this; }
  c(v) { return this.e(0x41, sleb(v)); }
  c64(v) { return this.e(0x42, sleb64(v)); }
  op(n) { return this.e(OP[n]); }
  op64(n) { return this.e(OP64[n]); }
  loc() { if (this.n64) throw new Error('i32 locals come first'); return this.nloc++; }
  loc64() { this.l64.push(this.nloc + this.n64); return this.nloc + this.n64++; }
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
    const groups = []; if (this.nloc) groups.push([...uleb(this.nloc), I32]); if (this.n64) groups.push([...uleb(this.n64), I64]);
    const b = [...uleb(groups.length), ...groups.flat(), ...this.b, 0x0b]; return [...uleb(b.length), ...b];
  }
}

// ---------------------------------------------------------------- decoding
class Unsupported extends Error {}
const MASK = { 1: 0xff, 2: 0xffff, 4: -1 };
const COND = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

/** translate the block at linear `lin` (code segment base `csb`, 32-bit default when `d32`) */
function translate(p, lin, csb, d32) {
  const u8 = p.u8;
  const f = new Fn();
  const T = f.loc(), A = f.loc(), B = f.loc(), R = f.loc(), C = f.loc(), X = f.loc(), K = f.loc();   // scratch locals
  const W = f.loc64();
  let pc = lin, n = 0;
  const fetch = () => u8[pc++];
  const fetch16 = () => { const v = u8[pc] | (u8[pc + 1] << 8); pc += 2; return v; };
  const fetch32 = () => { const v = u8[pc] | (u8[pc + 1] << 8) | (u8[pc + 2] << 16) | (u8[pc + 3] << 24); pc += 4; return v; };
  const fetchS8 = () => (fetch() << 24) >> 24;
  const done = next => { f.c(next | 0); return { fn: f, len: pc - lin, n }; };
  for (;;) {
    if (++n > 400) return done(pc);   // a long straight run: continue in another block
    const start = pc;
    f.c(start | 0).gs('eip');
    let osz = d32 ? 4 : 2, asz = d32 ? 4 : 2, seg = null, rep = null;
    let b;
    for (;;) {
      b = fetch();
      if (b === 0x66) osz = osz === 4 ? 2 : 4;
      else if (b === 0x67) asz = asz === 4 ? 2 : 4;
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
      let defSeg = 3;
      if (asz === 4) {
        let base = rm, idx = -1, scale = 0;
        if (rm === 4) { const sib = fetch(); scale = sib >> 6; idx = (sib >> 3) & 7; base = sib & 7; if (idx === 4) idx = -1; }
        let disp = 0, hasBase = true;
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
    const rd = (o, sz) => { if (o.isReg) rdReg(o.rm, sz); else f.lg(A).ld(sz); };
    const wr = (o, sz, loc) => { if (o.isReg) wrReg(o.rm, sz, loc); else f.lg(A).lg(loc).st(sz); };
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
    const ss32 = !!(p.r32(ACC + (p.cpu.ss.value & 0xfff8)) & 0x400000) || !(p.cpu.ss.value & 0xffff);
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
      f.lg(loc).c(0xfff8).op('and').c(LDT).op('add').ld(4).gs(base);
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
    if (b === 0x07 || b === 0x17 || b === 0x1f) { pop(T, osz); loadSeg(b >> 3, T); continue; }
    if (b === 0x69 || b === 0x6b) {   // imul r, rm, imm
      const o = modrm(); rd(o, osz); f.ls(B); f.c(b === 0x69 ? (osz === 4 ? fetch32() : (fetch16() << 16) >> 16) : fetchS8()).ls(C);
      f.lg(B).lg(C).op('mul').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); wrReg(o.reg, osz, R); continue;
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
    if (b === 0x8c) { const o = modrm(); f.gg(SEG[o.reg][0]).ls(T); wr(o, o.isReg ? osz : 2, T); continue; }
    if (b === 0x8e) { const o = modrm(); rd(o, 2); f.ls(T); loadSeg(o.reg, T); continue; }
    if (b === 0x8d) { const o = modrm(); f.lg(A).gg(sbase(o.sr)).op('sub').ls(T); wrReg(o.reg, osz, T); continue; }   // lea: the offset (less the base its address added: SS's for BP and SP)
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
      for (const [k, n2] of [[0, 'cf'], [2, 'pf'], [6, 'zf'], [7, 'sf'], [10, 'df'], [11, 'of']]) f.lg(C).c(k).op('shr_u').c(1).op('and').gs(n2);
      loadSeg(1, B); f.lg(T).gg('csb').op('add').e(0x0f); return done(pc);
    }
    if (b === 0x9a) {   // call far ptr16:16/32
      const off = osz === 4 ? fetch32() : fetch16(), sel = fetch16();
      f.gg('cs').ls(T); push(T, osz); f.c(offOf(pc)).ls(T); push(T, osz);
      f.c(sel).ls(T); loadSeg(1, T); f.gg('csb').c(off | 0).op('add').e(0x0f); return done(pc);
    }
    if (b === 0xcd) {   // int n, which the host services (the continuation in the eip global); INT 20h's service dword follows it
      const v = fetch(); if (v === 0x20) pc += 4;
      f.c(pc | 0).c(0x100 + v).e(0x10, 1); f.gg('eip').e(0x0f); return done(pc);
    }
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
      f.c(off).gg(sbase(seg === null ? 3 : seg)).op('add').ls(A);
      if (b & 2) { rdReg(0, sz); f.ls(T); f.lg(A).lg(T).st(sz); } else { f.lg(A).ld(sz).ls(T); wrReg(0, sz, T); }
      continue;
    }
    if (b === 0xa8 || b === 0xa9) { const sz = b & 1 ? osz : 1; rdReg(0, sz); f.c(imm(sz)).op('and').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); szp(sz); continue; }
    if ((b >= 0xa4 && b <= 0xa7) || (b >= 0xaa && b <= 0xaf)) { strop(f, b, osz, asz, seg, rep, { T, A, B, C, R, X }, alu2, szp); continue; }
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
    if (b === 0xe8) { const d = osz === 4 ? fetch32() : (fetch16() << 16) >> 16; f.c(offOf(pc)).ls(T); push(T, osz); return done(osz === 4 ? pc + d : csb + ((pc - csb + d) & 0xffff)); }
    if (b === 0xe9) { const d = osz === 4 ? fetch32() : (fetch16() << 16) >> 16; return done(osz === 4 ? pc + d : csb + ((pc - csb + d) & 0xffff)); }
    if (b === 0xeb) { const d = fetchS8(); return done(pc + d); }
    if (b === 0xea) {   // jmp far ptr16:16/32
      const off = osz === 4 ? fetch32() : fetch16(), sel = fetch16();
      f.c(sel).ls(T); loadSeg(1, T); f.gg('csb').c(off | 0).op('add').e(0x0f); return done(pc);
    }
    if (b === 0xf5) { f.gg('cf').op('eqz').gs('cf'); continue; }
    if (b === 0xf8 || b === 0xf9) { f.c(b & 1).gs('cf'); continue; }
    if (b === 0xfc || b === 0xfd) { f.c(b & 1).gs('df'); continue; }
    if (b === 0xfa || b === 0xfb) continue;   // cli / sti: no interrupts arrive inside a block
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
      if (b === 0xff && o.reg === 2) { rd(o, osz); f.ls(B); f.c(offOf(pc)).ls(T); push(T, osz); f.lg(B).gg('csb').op('add').e(0x0f); return done(pc); }
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
      if (b2 === 0xaf) { const o = modrm(); rdReg(o.reg, osz); rd(o, osz); f.op('mul').ls(R); f.c(0).gs('cf'); f.c(0).gs('of'); wrReg(o.reg, osz, R); continue; }
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
        szp(osz); wr(o, osz, R); f.end(); continue;
      }
      if (b2 === 0xa0 || b2 === 0xa8) { f.gg(b2 === 0xa0 ? 'fsel' : 'gsel').ls(T); push(T, osz); continue; }
      if (b2 === 0xa1 || b2 === 0xa9) { pop(T, osz); loadSeg(b2 === 0xa1 ? 4 : 5, T); continue; }
      if (b2 === 0xb2 || b2 === 0xb4 || b2 === 0xb5) { const o = modrm(); f.lg(A).ld(osz).ls(T); f.lg(A).c(osz).op('add').ld(2).ls(B); wrReg(o.reg, osz, T); loadSeg(b2 === 0xb2 ? 2 : b2 === 0xb4 ? 4 : 5, B); continue; }
      if (b2 === 0xa3 || b2 === 0xab || b2 === 0xb3 || b2 === 0xbb || b2 === 0xba) {   // bt / bts / btr / btc
        const o = modrm(); if (!o.isReg && b2 !== 0xba) throw new Unsupported('bt with a memory operand and a register index');
        const kind = b2 === 0xba ? o.reg - 4 : [0xa3, 0xab, 0xb3, 0xbb].indexOf(b2);   // 0 bt, 1 bts, 2 btr, 3 btc
        if (b2 === 0xba) f.c(fetch()); else rdReg(o.reg, osz);
        f.c(osz * 8 - 1).op('and').ls(C); rd(o, osz); f.ls(B);
        f.lg(B).lg(C).op('shr_u').c(1).op('and').gs('cf');
        if (kind) {
          f.lg(B).c(1).lg(C).op('shl');
          if (kind === 2) f.c(-1).op('xor').op('and'); else f.op(kind === 1 ? 'or' : 'xor');
          f.ls(T); wr(o, osz, T);
        }
        continue;
      }
      if (b2 === 0x02 || b2 === 0x03) {   // lar / lsl, as the recompiled ones: the access word (ACC) or limit (LDT +4) of the selector's descriptor, ZF when it is in use
        const o = modrm(); rd(o, 2); f.c(0xfff8).op('and').ls(T);
        f.lg(T).c(LDT + 4).op('add').ld(4).lg(T).c(LDT).op('add').ld(4).op('or').c(0).op('ne').gs('zf');
        f.gg('zf').if_(); f.lg(T).c(b2 === 0x02 ? ACC : LDT + 4).op('add').ld(4).ls(R); wrReg(o.reg, osz, R); f.end();
        continue;
      }
      throw new Unsupported(`0f ${b2.toString(16)}`);
    }
    if (b === 0xd7) { f.gg(sbase(seg === null ? 3 : seg)).gg('ebx'); if (asz === 2) f.c(0xffff).op('and'); f.gg('eax').c(0xff).op('and').op('add').op('add').ld(1).ls(T); wrReg(0, 1, T); continue; }
    if (b === 0x9c || b === 0x9d) {   // pushf / popf: the flags the translated code keeps
      if (b === 0x9c) { f.gg('cf').gg('pf').c(2).op('shl').op('or').gg('zf').c(6).op('shl').op('or').gg('sf').c(7).op('shl').op('or').gg('df').c(10).op('shl').op('or').gg('of').c(11).op('shl').op('or').c(0x202).op('or').ls(T); push(T, osz); }
      else { pop(T, osz); for (const [k, n2] of [[0, 'cf'], [2, 'pf'], [6, 'zf'], [7, 'sf'], [10, 'df'], [11, 'of']]) f.lg(T).c(k).op('shr_u').c(1).op('and').gs(n2); }
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
function strop(f, b, osz, asz, seg, rep, L, alu2, szp) {
  const { T, A, B, C, R } = L, sz = b & 1 ? osz : 1;
  const idx = r => { f.gg(r); if (asz === 2) f.c(0xffff).op('and'); };
  const step = r => {   // r += df ? -sz : sz, within the address size
    f.gg(r).c(-sz).c(sz).gg('df').e(0x1b).op('add');
    if (asz === 2) { f.c(0xffff).op('and').gg(r).c(0xffff0000).op('and').op('or'); }
    f.gs(r);
  };
  const srcBase = seg === null ? 'dsb' : ['esb', 'csb', 'ssb', 'dsb', 'fs', 'gsb'][seg];
  const kind = b <= 0xa5 ? 'movs' : b <= 0xa7 ? 'cmps' : b <= 0xab ? 'stos' : b <= 0xad ? 'lods' : 'scas';
  const body = () => {
    if (kind === 'movs') { f.gg('esb'); idx('edi'); f.op('add'); f.gg(srcBase); idx('esi'); f.op('add').ld(sz).st(sz); step('esi'); step('edi'); }
    else if (kind === 'stos') { f.gg('esb'); idx('edi'); f.op('add').gg('eax').st(sz); step('edi'); }
    else if (kind === 'lods') { f.gg(srcBase); idx('esi'); f.op('add').ld(sz).ls(T); if (sz === 4) f.lg(T).gs('eax'); else f.gg('eax').c(sz === 2 ? 0xffff0000 : 0xffffff00).op('and').lg(T).op('or').gs('eax'); step('esi'); }
    else if (kind === 'scas') { f.gg('eax').ls(B); f.gg('esb'); idx('edi'); f.op('add').ld(sz).ls(C); alu2(7, sz); step('edi'); }
    else { f.gg(srcBase); idx('esi'); f.op('add').ld(sz).ls(B); f.gg('esb'); idx('edi'); f.op('add').ld(sz).ls(C); alu2(7, sz); step('esi'); step('edi'); }
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
  const types = vec([[0x60, 0, 1, I32], [0x60, 2, I32, I32, 0]]);
  const imps = vec([[...str('env'), ...str('mem'), 0x02, ...(shared ? [0x03, ...uleb(MEM_PAGES), ...uleb(65536)] : [0x00, ...uleb(MEM_PAGES)])], ...G.map(n => [...str('cpu'), ...str(n), 0x03, I32, 1]),
    [...str('env'), ...str('io'), 0x00, 1],     // function 0: port I/O (port, size | 8 for IN)
    [...str('env'), ...str('trap'), 0x00, 1]]);   // function 1: an interrupt (continuation, 100h + n)
  const funcs = vec([[0]]);
  const exps = vec([[...str('run'), 0x00, 2]]);
  const code = vec([fn.body()]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, types), ...sec(2, imps), ...sec(3, funcs), ...sec(7, exps), ...sec(10, code)]);
}

/** the run-time block at linear `eip`, translated now or from the cache; null when it cannot be translated */
P.dynBlock = function (eip) {
  this.dynCache = this.dynCache || new Map();
  const u8 = this.u8;
  let c = this.dynCache.get(eip);
  if (c && c.bytes.every((v, i) => u8[eip + i] === v)) return c;
  const cs = this.cpu.cs.value & 0xffff, csb = u32(this.cpu.csb.value);
  // only code inside the current code segment (flat 32-bit code, CS 0, as ring-0 VxD code runs: anywhere in memory):
  // a stray jump (to 0, or past the segment) is the guest's fault, not code
  const flat = !cs && !csb;
  if (!eip || (flat ? eip >= u8.length : !cs || eip < csb || eip - csb > this.selLimit(cs))) { this.trapped = `jump to unmapped address ${eip.toString(16)}`; return null; }
  const d32 = flat || !!(this.r32(ACC + (cs & 0xfff8)) & 0x400000);
  let t;
  try { t = translate(this, eip, csb, d32); }
  catch (e) { if (e instanceof Unsupported) { this.trapped = `run-time code at ${eip.toString(16)}: ${e.message}`; return null; } throw e; }
  t.fn.e(0x0f);
  const run = new WebAssembly.Instance(new WebAssembly.Module(assemble(t.fn, Object.prototype.toString.call(this.mem.buffer) === '[object SharedArrayBuffer]')), { env: { mem: this.mem, io: (port, k) => this.portIO(port & 0xffff, k & 7, !!(k & 8)), trap: (e, c) => this.trap(e, c) }, cpu: this.cpu }).exports.run;
  c = { run, bytes: Array.from(u8.subarray(eip, eip + t.len)) };
  this.dynCache.set(eip, c);
  return c;
};
/** run run-time code from `eip` until control reaches translated module code (or the sentinel); the next address */
P.dynRun = function (eip) {
  for (let n = 0; ; n++) {
    if ((n & 0xfff) === 0xfff) { this.cpu.eip.value = eip; if (this.tick(eip)) return -1; }   // the processor's time, as the dispatcher asks
    const blk = this.dynBlock(eip); if (!blk) return null;
    try { eip = u32(blk.run()); }
    catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; this.trapped = `run-time code at ${eip.toString(16)} (instruction at ${u32(this.cpu.eip.value).toString(16)}): ${e.message}`; return null; }
    if (eip === LAYOUT.SENTINEL || eip >= LAYOUT.THUNK16) return eip;
    if (this.modules.some(m => eip >= m.meta.textLo && eip < m.meta.textHi && this.hasBlock(m, eip))) return eip;
  }
};
/** whether module `m` has a translated block starting at `eip` */
P.hasBlock = function (m, eip) {
  if (!m.meta.lookup) return false;
  return new Uint32Array(this.mem.buffer, m.meta.lookup + 4 * (eip - m.meta.textLo), 1)[0] !== 0;
};
})();
