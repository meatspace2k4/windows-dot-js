'use strict';
// Debuggable JavaScript for dyn.js's translated modules.
// A module named in W95DynJs.names (set by mod-dynjs.js, #mod=dynjs:MSTASK+EXPLORER) runs as JavaScript made from its
// wasm bytes instead of as WebAssembly. Each block is a function named by its guest address (b_1001def); registers are
// R.eax etc. The source shows in DevTools as dyn/NAME.js, so breakpoints work there.
// The page's win95.debug adds recording breakpoints on top (conditions, captured values, block source, memory); see
// "the debugger" below. To stop the machine, set a breakpoint in DevTools.
// The output depends only on the wasm bytes, so memoized modules convert without translating again.
(() => {
const VT = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64' };
class Rd {
  constructor(b, at = 0) { this.b = b; this.at = at; }
  u8() { return this.b[this.at++]; }
  uleb() { let r = 0, s = 0, x; do { x = this.b[this.at++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; }
  sleb() { let r = 0, s = 0, x; do { x = this.b[this.at++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); if (s < 32 && (x & 0x40)) r |= -1 << s; return r | 0; }
  sleb64() { let r = 0n, s = 0n, x; do { x = this.b[this.at++]; r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); if (x & 0x40) r |= -1n << s; return BigInt.asIntN(64, r); }
  str() { const n = this.uleb(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.at++]); return s; }
  f64() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 8).getFloat64(0, true); this.at += 8; return v; }
}
/** Parse the wasm module: types, imported functions and globals, function types and bodies, table entries. */
function parse(wasm) {
  const r = new Rd(wasm, 8), m = { types: [], impF: [], globals: [], funcT: [], bodies: [], table: [] };
  while (r.at < wasm.length) {
    const id = r.u8(), size = r.uleb(), end = r.at + size;
    if (id === 1) { for (let n = r.uleb(); n--;) { r.u8(); const p = [...Array(r.uleb())].map(() => VT[r.u8()]), q = [...Array(r.uleb())].map(() => VT[r.u8()]); m.types.push({ p, q }); } }
    else if (id === 2) {
      for (let n = r.uleb(); n--;) {
        const mod = r.str(), name = r.str(), kind = r.u8();
        if (kind === 0) m.impF.push({ mod, name, type: r.uleb() });
        else if (kind === 2) { const fl = r.u8(); r.uleb(); if (fl & 1) r.uleb(); }
        else if (kind === 3) { r.u8(); r.u8(); m.globals.push({ mod, name }); }
        else throw new Error(`dynjs: an import of kind ${kind}`);
      }
    }
    else if (id === 3) { for (let n = r.uleb(); n--;) m.funcT.push(r.uleb()); }
    else if (id === 9) { for (let n = r.uleb(); n--;) { r.uleb(); r.u8(); r.sleb(); r.u8(); for (let k = r.uleb(); k--;) m.table.push(r.uleb()); } }
    else if (id === 10) { for (let n = r.uleb(); n--;) { const sz = r.uleb(); m.bodies.push([r.at, r.at + sz]); r.at += sz; } }
    r.at = end;
  }
  return m;
}
const hex = v => (v >>> 0).toString(16);
const BIN32 = { 0x6a: (a, b) => `(${a} + ${b}) | 0`, 0x6b: (a, b) => `(${a} - ${b}) | 0`, 0x6c: (a, b) => `Math.imul(${a}, ${b})`, 0x6d: (a, b) => `divs(${a}, ${b})`, 0x6e: (a, b) => `divu(${a}, ${b})`,
  0x6f: (a, b) => `rems(${a}, ${b})`, 0x70: (a, b) => `remu(${a}, ${b})`, 0x71: (a, b) => `${a} & ${b}`, 0x72: (a, b) => `${a} | ${b}`, 0x73: (a, b) => `${a} ^ ${b}`,
  0x74: (a, b) => `${a} << ${b}`, 0x75: (a, b) => `${a} >> ${b}`, 0x76: (a, b) => `(${a} >>> ${b}) | 0`, 0x77: (a, b) => `rotl(${a}, ${b})`, 0x78: (a, b) => `rotr(${a}, ${b})`,
  0x46: (a, b) => `(${a} === ${b}) | 0`, 0x47: (a, b) => `(${a} !== ${b}) | 0`, 0x48: (a, b) => `(${a} < ${b}) | 0`, 0x49: (a, b) => `((${a} >>> 0) < (${b} >>> 0)) | 0`,
  0x4a: (a, b) => `(${a} > ${b}) | 0`, 0x4b: (a, b) => `((${a} >>> 0) > (${b} >>> 0)) | 0`, 0x4c: (a, b) => `(${a} <= ${b}) | 0`, 0x4d: (a, b) => `((${a} >>> 0) <= (${b} >>> 0)) | 0`,
  0x4e: (a, b) => `(${a} >= ${b}) | 0`, 0x4f: (a, b) => `((${a} >>> 0) >= (${b} >>> 0)) | 0` };
const U64 = a => `BigInt.asUintN(64, ${a})`, S64 = a => `BigInt.asIntN(64, ${a})`;
const BIN64 = { 0x7c: (a, b) => S64(`${a} + ${b}`), 0x7d: (a, b) => S64(`${a} - ${b}`), 0x7e: (a, b) => S64(`${a} * ${b}`), 0x7f: (a, b) => `div64(${a}, ${b})`, 0x80: (a, b) => S64(`div64(${U64(a)}, ${U64(b)})`),
  0x81: (a, b) => `rem64(${a}, ${b})`, 0x82: (a, b) => S64(`rem64(${U64(a)}, ${U64(b)})`), 0x83: (a, b) => `${a} & ${b}`, 0x84: (a, b) => `${a} | ${b}`, 0x85: (a, b) => `${a} ^ ${b}`,
  0x86: (a, b) => S64(`${a} << (${b} & 63n)`), 0x87: (a, b) => `${a} >> (${b} & 63n)`, 0x88: (a, b) => S64(`${U64(a)} >> (${b} & 63n)`),
  0x51: (a, b) => `(${a} === ${b}) | 0`, 0x52: (a, b) => `(${a} !== ${b}) | 0`, 0x53: (a, b) => `(${a} < ${b}) | 0`, 0x54: (a, b) => `(${U64(a)} < ${U64(b)}) | 0`,
  0x55: (a, b) => `(${a} > ${b}) | 0`, 0x56: (a, b) => `(${U64(a)} > ${U64(b)}) | 0`, 0x57: (a, b) => `(${a} <= ${b}) | 0`, 0x58: (a, b) => `(${U64(a)} <= ${U64(b)}) | 0`,
  0x59: (a, b) => `(${a} >= ${b}) | 0`, 0x5a: (a, b) => `(${U64(a)} >= ${U64(b)}) | 0` };
const BINF = { 0xa0: '+', 0xa1: '-', 0xa2: '*', 0xa3: '/' }, CMPF = { 0x61: '===', 0x62: '!==', 0x63: '<', 0x64: '>', 0x65: '<=', 0x66: '>=' };
const UNF = { 0x99: a => `Math.abs(${a})`, 0x9a: a => `-(${a})`, 0x9b: a => `Math.ceil(${a})`, 0x9c: a => `Math.floor(${a})`, 0x9d: a => `Math.trunc(${a})`, 0x9e: a => `nearest(${a})`, 0x9f: a => `Math.sqrt(${a})` };
const LOAD = { 0x28: 'r32', 0x29: 'r64', 0x2a: 'rf32', 0x2b: 'rf64', 0x2c: 'r8s', 0x2d: 'r8', 0x2e: 'r16s', 0x2f: 'r16' };
const STORE = { 0x36: 'w32', 0x37: 'w64', 0x38: 'wf32', 0x39: 'wf64', 0x3a: 'w8', 0x3b: 'w16' };
/** Convert one function body to JavaScript statements.
 *  The operand stack is tracked as expressions. Before any statement with a side effect (store, set, call, branch,
 *  block start), pending expressions are saved to temporaries so evaluation order matches the wasm. */
function body(m, wasm, [at, end], type, fname, ind = '  ') {
  const r = new Rd(wasm, at), out = [], st = [], ctl = [], temps = [];
  const locals = type.p.map(() => null), names = type.p.map((_, i) => `p${i}`);
  for (let n = r.uleb(); n--;) { const k = r.uleb(), t = VT[r.u8()]; for (let i = 0; i < k; i++) { names.push(`${t === 'f64' ? 'f' : t === 'i64' ? 'q' : 'l'}${names.length}`); locals.push(t === 'i64' ? '0n' : '0'); } }
  let dead = 0, lab = 0, pad = ind;
  const emit = s => out.push(pad + s);
  // (an expression grown long is put in a temporary with those pending under it, in order: a long run of pure operations
  // folded into one expression nested past what the engine's parser recurses through, and the module did not load,
  // "Maximum call stack size exceeded" at its eval)
  const push = (e, lit = false) => { st.push({ e, lit }); if (!lit && e.length > 400) spill(); }, pop = () => { const v = st.pop(); if (!v) throw new Error(`dynjs: ${fname}: the stack is empty at ${hex(r.at)}`); return v.lit ? v.e : `(${v.e})`; };
  const spill = () => { for (const v of st) if (!v.lit) { const t = `t${temps.length}`; temps.push(t); emit(`${t} = ${v.e};`); v.e = t; v.lit = true; } };
  const br = n => { const c = ctl[ctl.length - 1 - n]; return !c ? `return${type.q.length ? ' ' + st[st.length - 1].e : ''};` : c.kind === 'loop' ? `continue ${c.label};` : `break ${c.label};`; };
  const open = (kind, head) => { const label = `${kind[0].toUpperCase()}${lab++}`; emit(`${label}: ${head} {`); ctl.push({ kind, label, h: st.length }); pad += '  '; };
  while (r.at < end) {
    const op = r.u8();
    if (dead) {   // unreachable code after a branch: skip to the end of the enclosing block
      if (op === 0x02 || op === 0x03 || op === 0x04) { r.u8(); dead++; continue; }
      if (op === 0x0b) { if (--dead) continue; }
      else if (op === 0x05 && dead === 1) dead = 0;
      else {
        if (op === 0x41) r.sleb(); else if (op === 0x42) r.sleb64(); else if (op === 0x44) r.at += 8; else if (op === 0x43) r.at += 4;
        else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24) || op === 0xfc) r.uleb();
        else if (op === 0x11 || (op >= 0x28 && op <= 0x3e)) { r.uleb(); r.uleb(); }
        continue;
      }
    }
    if (op === 0x00) { spill(); emit(`throw new WebAssembly.RuntimeError('unreachable');`); dead = 1; }
    else if (op === 0x01) continue;
    else if (op === 0x02) { r.u8(); spill(); open('block', ''); }
    else if (op === 0x03) { r.u8(); spill(); open('loop', 'for (;;)'); }
    else if (op === 0x04) { r.u8(); const c = pop(); spill(); open('if', `if (${c})`); }
    else if (op === 0x05) { const c = ctl[ctl.length - 1]; st.length = c.h; pad = pad.slice(2); emit('} else {'); pad += '  '; }
    else if (op === 0x0b) {
      const c = ctl.pop();
      if (!c) { if (type.q.length && st.length && r.at >= end) emit(`return ${st.pop().e};`); break; }
      st.length = c.h; if (c.kind === 'loop') emit('break;'); pad = pad.slice(2); emit('}');
    }
    else if (op === 0x0c) { const n = r.uleb(); spill(); emit(br(n)); dead = 1; }
    else if (op === 0x0d) { const n = r.uleb(), c = pop(); spill(); emit(`if (${c}) ${br(n)}`); }
    else if (op === 0x0f) { spill(); emit(`return${type.q.length ? ' ' + st[st.length - 1].e : ''};`); dead = 1; }
    else if (op === 0x10 || op === 0x11) {
      let t, callee;
      if (op === 0x10) { const i = r.uleb(), f = m.impF[i]; t = m.types[f ? f.type : m.funcT[i - m.impF.length]]; callee = f ? `env.${f.name}` : `F[${i - m.impF.length}]`; }
      else { t = m.types[r.uleb()]; r.uleb(); callee = `T[${pop()}]`; }
      const args = t.p.map(() => pop()).reverse(); spill();
      const call = `${callee}(${args.join(', ')})`;
      if (!t.q.length) emit(call + ';'); else { const v = `t${temps.length}`; temps.push(v); emit(`${v} = ${t.q[0] === 'i32' ? call + ' | 0' : call};`); push(v, true); }
    }
    else if (op === 0x1a) { const v = st.pop(); if (!v.lit) emit(v.e + ';'); }
    else if (op === 0x1b) { const c = pop(), b = pop(), a = pop(); push(`${c} ? ${a} : ${b}`); }
    else if (op === 0x20) push(names[r.uleb()], false);
    else if (op === 0x21) { const i = r.uleb(), v = st.pop(); spill(); emit(`${names[i]} = ${v.e};`); }
    else if (op === 0x22) { const i = r.uleb(), v = st.pop(); spill(); emit(`${names[i]} = ${v.e};`); push(names[i], false); }
    else if (op === 0x23) { const g = m.globals[r.uleb()]; push(g.mod === 'cpu' ? `R.${g.name}` : g.name.toUpperCase(), g.mod !== 'cpu'); }
    else if (op === 0x24) { const g = m.globals[r.uleb()], v = st.pop(); spill(); emit(`R.${g.name} = ${v.e};`); }
    else if (LOAD[op]) { r.uleb(); const off = r.uleb(), a = pop(); push(`${LOAD[op]}(${off ? `${a} + ${off}` : a})`); }
    else if (STORE[op]) { r.uleb(); const off = r.uleb(), v = st.pop(), a = pop(); spill(); emit(`${STORE[op]}(${off ? `${a} + ${off}` : a}, ${v.e});`); }
    else if (op === 0x41) { const v = r.sleb(); if (v > -10 && v < 10) push(String(v), true); else if (v > 0) push(`0x${hex(v)}`, true); else push(`0x${hex(v)} | 0`); }
    else if (op === 0x42) push(`${r.sleb64()}n`, true);
    else if (op === 0x44) { const v = r.f64(); push(Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : String(v), v >= 0); }
    else if (op === 0x45) push(`(${pop()} === 0) | 0`);
    else if (op === 0x50) push(`(${pop()} === 0n) | 0`);
    else if (BIN32[op]) { const b = pop(), a = pop(); push(BIN32[op](a, b)); }
    else if (BIN64[op]) { const b = pop(), a = pop(); push(BIN64[op](a, b)); }
    else if (BINF[op]) { const b = pop(), a = pop(); push(`${a} ${BINF[op]} ${b}`); }
    else if (CMPF[op]) { const b = pop(), a = pop(); push(`(${a} ${CMPF[op]} ${b}) | 0`); }
    else if (UNF[op]) push(UNF[op](pop()));
    else if (op === 0x67) push(`Math.clz32(${pop()})`);
    else if (op === 0x68) push(`ctz(${pop()})`);
    else if (op === 0x69) push(`popcnt(${pop()})`);
    else if (op === 0xa7) push(`Number(BigInt.asIntN(32, ${pop()}))`);
    else if (op === 0xac) push(`BigInt(${pop()})`);
    else if (op === 0xad) push(`BigInt(${pop()} >>> 0)`);
    else if (op === 0xb7) push(`+${pop()}`);
    else if (op === 0xb8) push(`(${pop()} >>> 0)`);
    else if (op === 0xb9) push(`Number(${pop()})`);
    else if (op === 0xba) push(`Number(${U64(pop())})`);
    else if (op === 0xbb) push(`+${pop()}`);
    else if (op === 0xb6) push(`Math.fround(${pop()})`);
    else if (op === 0xaa) push(`trunc32(${pop()})`);
    else if (op === 0xfc) { const k = r.uleb(); if (k === 2) push(`sat32(${pop()})`); else if (k === 6) push(`sat64(${pop()})`); else throw new Error(`dynjs: ${fname}: operation fc ${k}`); }
    else throw new Error(`dynjs: ${fname}: operation ${hex(op)} at ${hex(r.at - 1)}`);
  }
  const decl = [];
  if (locals.length > type.p.length) decl.push(ind + 'let ' + names.slice(type.p.length).map((n, i) => `${n} = ${locals[type.p.length + i]}`).join(', ') + ';');
  if (temps.length) decl.push(ind + 'let ' + temps.join(', ') + ';');
  return decl.concat(out).join('\n');
}
/** Build the module's source. `blocks` holds the block addresses in table order; `label` is the module's name. */
function source(wasm, label, blocks) {
  const m = parse(wasm), nimp = m.impF.length;
  // Function 0 is run(eip); table entry i is the block at blocks[i].
  const addr = new Map(); m.table.forEach((f, i) => addr.set(f - nimp, blocks[i]));
  const L = [`(function (env, cpu, mem, BP) { 'use strict';`,
    `// ${label}: ${blocks.length} blocks, as dyn.js translated them`,
    `const R = {}; for (const n of Object.keys(cpu)) Object.defineProperty(R, n, { get() { return cpu[n].value; }, set(v) { cpu[n].value = v; }, enumerable: true });`,
    `const LOOKUP = env.lookup.value;`,
    `let dv = new DataView(mem.buffer); const D = () => (dv.buffer === mem.buffer ? dv : (dv = new DataView(mem.buffer)));`,
    `const r8 = a => D().getUint8(a >>> 0), r8s = a => D().getInt8(a >>> 0), r16 = a => D().getUint16(a >>> 0, true), r16s = a => D().getInt16(a >>> 0, true), r32 = a => D().getInt32(a >>> 0, true), r64 = a => D().getBigInt64(a >>> 0, true), rf32 = a => D().getFloat32(a >>> 0, true), rf64 = a => D().getFloat64(a >>> 0, true);`,
    `const w8 = (a, v) => D().setUint8(a >>> 0, v), w16 = (a, v) => D().setUint16(a >>> 0, v, true), w32 = (a, v) => D().setInt32(a >>> 0, v, true), w64 = (a, v) => D().setBigInt64(a >>> 0, v, true), wf32 = (a, v) => D().setFloat32(a >>> 0, v, true), wf64 = (a, v) => D().setFloat64(a >>> 0, v, true);`,
    `const M = { r8, r16, r32 };`,
    `const zero = () => { throw new WebAssembly.RuntimeError('divide by zero'); };`,
    `const divs = (a, b) => (b === 0 ? zero() : a === -2147483648 && b === -1 ? (() => { throw new WebAssembly.RuntimeError('integer overflow'); })() : (a / b) | 0), divu = (a, b) => (b === 0 ? zero() : ((a >>> 0) / (b >>> 0)) | 0);`,
    `const rems = (a, b) => (b === 0 ? zero() : (a % b) | 0), remu = (a, b) => (b === 0 ? zero() : ((a >>> 0) % (b >>> 0)) | 0);`,
    `const div64 = (a, b) => (b === 0n ? zero() : a / b), rem64 = (a, b) => (b === 0n ? zero() : a % b);`,
    `const rotl = (a, b) => (a << (b & 31)) | (a >>> (32 - (b & 31) & 31)), rotr = (a, b) => (a >>> (b & 31)) | (a << (32 - (b & 31) & 31));`,
    `const ctz = a => (a ? 31 - Math.clz32(a & -a) : 32), popcnt = a => { let n = 0; for (a >>>= 0; a; a &= a - 1) n++; return n; };`,
    `const nearest = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };`,
    `const sat32 = x => (x !== x ? 0 : x <= -2147483648 ? -2147483648 : x >= 2147483647 ? 2147483647 : Math.trunc(x) | 0), trunc32 = x => Math.trunc(x) | 0;`,
    `const sat64 = x => (x !== x ? 0n : x <= -9223372036854775808 ? -9223372036854775808n : x >= 9223372036854775807 ? 9223372036854775807n : BigInt(Math.trunc(x)));`];
  // (each function a slot of F, named, not a local of its own: a module's tens of thousands of blocks as declarations,
  // and their aliases, each took a register of this function's frame, and the frame overflowed the worker's stack as
  // the module was made, "Maximum call stack size exceeded" at 1:11)
  L.push(`const F = [];`);
  m.bodies.forEach((b, i) => {
    const t = m.types[m.funcT[i]], a = addr.get(i), name = a === undefined ? (i === 0 ? 'run' : `f${i}`) : `b_${hex(a)}`;
    L.push(`F[${i}] = function ${name}(${t.p.map((_, k) => `p${k}`).join(', ')}) {${a === undefined ? '' : `   // ${hex(a)}`}`);
    if (a !== undefined) L.push(`  if (BP.on) BP.at(0x${hex(a)}, R, M);`);
    L.push(body(m, wasm, b, t, name), '}');
  });
  L.push(`const T = [${m.table.map(f => `F[${f - nimp}]`).join(', ')}];`);
  L.push(`return { run: F[0] };`, `})`, `//# sourceURL=dyn/${label.replace(/[^\w.-]+/g, '_')}.js`);
  return L.join('\n');
}
// ---------------------------------------------------------------- the debugger
// Every block of a JS-run module calls BP.at(address, R, M) while BP.on is set (M: r8, r16, r32 over guest memory).
// A breakpoint is { id, at, when, capture, n }. It records a hit and runs on; the machine never stops here.
//   when:    optional expression; the breakpoint fires only when it is truthy.
//   capture: optional expression; its value is kept with the hit.
// Expressions see R (registers), r8/r16/r32 (memory), n (times this breakpoint was reached) and thread (its id).
const HITS_MAX = 1000;
const BP = { on: false, stepAll: false, byAddr: new Map(), byId: new Map(), stops: new Map(), hits: [], seq: 0, nextId: 1, proc: null, onHit: null,
  at(a, R, M) {
    const list = BP.byAddr.get(a); if (!list) return;
    const t = BP.proc && BP.proc.thread16, thread = t ? t.id : 0;
    for (const b of list) {
      b.n++;
      // (an expression that throws ends its breakpoint, with the error kept for the list: it never ends the machine)
      if (b.error) continue;
      let value;
      try { if (b.whenFn && !b.whenFn(R, M.r8, M.r16, M.r32, b.n, thread)) continue; if (b.captureFn) value = b.captureFn(R, M.r8, M.r16, M.r32, b.n, thread); }
      catch (e) { b.error = String(e && e.message || e); continue; }
      const regs = {}; for (const k of Object.keys(R)) regs[k] = R[k] >>> 0;
      const sp = (R.ss & 0xfff8 ? R.ssb + (R.esp & 0xffff) : R.esp) >>> 0, stack = [];
      for (let i = 0; i < 16; i++) stack.push(M.r32(sp + 4 * i) >>> 0);
      const hit = { seq: ++BP.seq, id: b.id, at: a, n: b.n, thread, regs, stack, value };
      BP.hits.push(hit); if (BP.hits.length > HITS_MAX) BP.hits.shift();
      if (BP.onHit) BP.onHit(hit);
    }
  } };
const made = new Map(), madeHash = new Map();   // (madeHash: each made text's hash, for dump: made once per text)
const expr = s => { if (!s) return null; try { return new Function('R', 'r8', 'r16', 'r32', 'n', 'thread', `return (${s});`); } catch (e) { throw new Error(`debug: the expression ${s} does not parse (${e.message})`); } };
const addrOf = v => (typeof v === 'string' ? parseInt(v, 16) : v) >>> 0;
const labelOf = m => (m.name === 'EXE' ? m.meta.path || m.meta.name || 'EXE' : m.name);
const shortOf = m => String(labelOf(m)).split(/[\\/]/).pop().replace(/\.\w+$/, '').toUpperCase();
// (a module's wasm is the memo's to keep (dyn.js neSet): read back, p.seedWasm, where the debugger needs it)
const translated = p => (p.modules || []).filter(m => m && m.meta && m.meta.lookup && m.netSeed && m.run && !m.netText);
/** The debugger's methods, each called with the machine's process first. The page's win95.debug calls them through
 *  the worker's cmd 'debug' ([method, ...arguments]); addresses are numbers or hex strings. */
const D = {
  /** The translated modules: [{ name, label, lo, hi, base, blocks, js }]. */
  modules: p => translated(p).map(m => ({ name: shortOf(m), label: String(labelOf(m)), lo: m.meta.textLo >>> 0, hi: m.meta.textHi >>> 0, base: (m.base || m.meta.textLo) >>> 0, blocks: m.netSeed.blocks.length, js: !!m.dynJs })),
  /** Run exactly these modules as JavaScript (names without extension, '*' for all); the rest go back to wasm.
   *  Returns the names now running as JavaScript. */
  run(p, names = []) {
    api.names.clear(); for (const n of names) if (n) api.names.add(String(n).toUpperCase().replace(/\.\w+$/, ''));
    const need = translated(p).filter(m => !m.netSeed.wasm && m.netSeed.made && api.wants(labelOf(m)));
    if (need.length) return Promise.all(need.map(m => p.seedWasm(m))).then(() => D.run(p, names));
    for (const m of translated(p)) { const want = api.wants(labelOf(m)); if (want === !!m.dynJs || m.hidden) continue; m.dynJs = want; p.neSet(m, m.module, m.netSeed); }
    return translated(p).filter(m => m.dynJs).map(shortOf);
  },
  /** Add a breakpoint: { at, when, capture }. Returns { id, at }. Its module must be running as JavaScript. */
  breakpoint(p, spec = {}) {
    const at = resolve(p, spec.at), b = { id: BP.nextId++, at, when: spec.when || null, capture: spec.capture || null, n: 0, whenFn: expr(spec.when), captureFn: expr(spec.capture) };
    BP.byId.set(b.id, b); if (!BP.byAddr.has(at)) BP.byAddr.set(at, []); BP.byAddr.get(at).push(b); BP.on = true;
    return { id: b.id, at };
  },
  /** Remove one breakpoint by id; true when it existed. */
  remove(p, id) {
    const b = BP.byId.get(id); if (!b) return false;
    BP.byId.delete(id); const l = BP.byAddr.get(b.at).filter(x => x !== b); if (l.length) BP.byAddr.set(b.at, l); else BP.byAddr.delete(b.at);
    BP.on = !!(BP.byId.size || BP.stepAll); return true;
  },
  /** Remove every breakpoint and forget the recorded hits. */
  clear() { BP.byId.clear(); BP.byAddr.clear(); BP.hits.length = 0; BP.on = BP.stepAll; return true; },
  /** The breakpoints: [{ id, at, when, capture, n }]. */
  breakpoints: () => [...BP.byId.values()].map(({ id, at, when, capture, n, error }) => ({ id, at, when, capture, n, error: error || null })),
  /** The recorded hits with seq above `since`: [{ seq, id, at, n, thread, regs, stack, value }]. */
  hits: (p, since = 0) => BP.hits.filter(h => h.seq > since),
  /** The JavaScript of the block holding an address, from its module's wasm (the module need not be running as
   *  JavaScript): { module, block, text }, or null where no translated block holds it. */
  source(p, addr) {
    const a = resolve(p, addr), m = translated(p).find(x => a >= x.meta.textLo && a < x.meta.textHi); if (!m) return null;
    if (!m.netSeed.wasm) return p.seedWasm(m).then(ok => (ok ? D.source(p, addr) : null));
    const bl = m.netSeed.blocks; let block = -1; for (const b of bl) if (b <= a && b > block) block = b; if (block < 0) return null;
    const key = String(labelOf(m)).toUpperCase(); if (!made.has(key)) made.set(key, source(m.netSeed.wasm, labelOf(m), bl));
    const s = made.get(key), i = s.indexOf(` = function b_${hex(block)}(`); if (i < 0) return null;
    return { module: shortOf(m), block, text: s.slice(i + 3, s.indexOf('\n}\n', i) + 2) };
  },
  /** The whole JavaScript of translated modules, from their wasm, as a JS-run module has it (dyn/NAME.js): `names`
   *  without extension, '*' for every one. Resolves with [{ name, label, file, hash, text }], file the source's own
   *  name, hash its text's (FNV-1a); `have` ({ file: hash }, what the caller saved before): a text unchanged since is
   *  not sent again (text null), only its hash */
  async dump(p, names = ['*'], have = {}) {
    const all = names.includes('*'), want = new Set(names.map(n => String(n).toUpperCase().replace(/\.\w+$/, '')));
    const out = [];
    for (const m of translated(p)) {
      if (!all && !want.has(shortOf(m))) continue;
      if (!m.netSeed.wasm && !(await p.seedWasm(m))) continue;
      const label = String(labelOf(m)), key = label.toUpperCase();
      if (!made.has(key)) made.set(key, source(m.netSeed.wasm, labelOf(m), m.netSeed.blocks));
      const text = made.get(key), file = `${label.replace(/[^\w.-]+/g, '_')}.js`;
      if (!madeHash.has(key) || madeHash.get(key).text !== text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); madeHash.set(key, { text, hash: (h >>> 0).toString(16) }); }
      const hash = madeHash.get(key).hash;
      out.push({ name: shortOf(m), label, file, hash, text: have[file] === hash ? null : text });
    }
    return out;
  },
  /** Guest memory: `n` bytes at an address (4096 at most). */
  read: (p, addr, n = 64) => Array.from(p.u8.subarray(resolve(p, addr), resolve(p, addr) + Math.min(n, 4096))),

  // ---- the Windows API
  /** An address from a place's name: a number, hex text, 'MODULE+offset' or an API 'DLL!Export' (a 16-bit module's
   *  export by name or '#ordinal'). Returns { addr, name } with the name as the machine tells places (whereOf). */
  resolve: (p, place) => { const addr = resolve(p, place); return { addr, name: nameOf(p, addr) }; },
  /** The name of an address: module+offset, with the nearest export. */
  where: (p, addr) => nameOf(p, addrOf(addr)),
  /** Stop in a debugger at each call of an API (any module, translated to wasm or run as JavaScript): the call comes
   *  through w95ApiEntry(call, args, from, thread), where a debugger's breakpoint sees it. `n`: argument count read.
   *  Returns { id, call, addr }. */
  stopAt(p, call, n = 6) {
    const addr = resolve(p, call), id = BP.nextId++;
    const off = p.addEntryHook(addr, function () { const c = callOf(this, n); w95ApiEntry(call, c.args, c.from, this.thread16 ? this.thread16.id : 0); });
    BP.stops.set(id, { id, call, addr, off }); return { id, call, addr };
  },
  /** End one API stop by id, or all of them. */
  unstop(p, id) { const ids = id == null ? [...BP.stops.keys()] : [id]; for (const i of ids) { const s = BP.stops.get(i); if (s) { s.off(); BP.stops.delete(i); } } return ids; },
  stops: () => [...BP.stops.values()].map(({ id, call, addr }) => ({ id, call, addr })),
  /** Trace API calls without stopping (the worker's watch): `dll`, `name` (an export, or '/regexp/' over the DLL's
   *  exports), `n` arguments. calls() returns and clears the calls traced: [{ t, name, args, text, from, stack, eax }]. */
  watch: (p, dll, name, n = 6) => BP.host.cmd('watch', [dll, name, n]),
  unwatch: (p, dll) => BP.host.cmd('watch', [dll]),
  calls: () => BP.host.cmd('watch', []),
  /** The processor and the running thread as they are now: registers, flags, the stack's first `n` dwords with each
   *  one's place when it is code, the thread and its program. */
  state(p, n = 24) {
    const c = p.cpu, reg = k => c[k].value >>> 0, regs = {};
    for (const k of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs']) regs[k] = hex(reg(k));
    const seg = reg('ss') & 0xfff8, sp = seg ? (reg('ssb') + (reg('esp') & 0xffff)) >>> 0 : reg('esp'), stack = [];
    for (let i = 0; i < n && sp + 4 * i + 4 <= p.u8.length; i++) { const v = p.r32(sp + 4 * i) >>> 0, w = nameOf(p, v); stack.push(`+${hex(4 * i)}  ${hex(v)}${/\+/.test(w) ? '  ' + w : ''}`); }
    const t = p.thread16;
    return { at: nameOf(p, reg('eip')), regs, flags: ['cf', 'zf', 'sf', 'of', 'df', 'pf'].filter(k => reg(k)).join(' '), stack16: !!seg, stack,
      thread: t ? t.id : 0, program: t && t.pc ? t.pc.path : null, sysLevel: p.sysLevel || 0, win16Lock: p.win16Held ? (p.win16Held.who && p.win16Held.who.id) || String(p.win16Held.who) : null };
  },
};
/** An address's name: its translated module by its file's name (a program is MSTASK, not EXE) and offset, with the
 *  export the machine names there; else as the machine names it (whereOf). */
function nameOf(p, a) {
  const w = p.whereOf(a), m = translated(p).find(x => a >= x.meta.textLo && a < x.meta.textHi); if (!m) return w;
  const ex = /\(.*\)$/.exec(w);
  return `${shortOf(m)}+${hex(a - (m.base || m.meta.textLo))}${ex ? ' ' + ex[0] : ''}`;
}
/** An API call's arguments and caller, read at its entry: 32-bit (dwords above the return address) or 16-bit (words). */
function callOf(p, n) {
  const seg = !!(p.cpu.ss.value & 0xffff), sp = seg ? (p.cpu.ssb.value >>> 0) + (p.cpu.esp.value & 0xffff) : p.cpu.esp.value >>> 0, args = [];
  if (seg) for (let i = 0; i < n; i++) args.push(p.r16(sp + 4 + 2 * i)); else for (let i = 1; i <= n; i++) args.push(p.r32(sp + 4 * i) >>> 0);
  const ret = seg ? (p.selBase(p.r16(sp + 2)) + p.r16(sp)) >>> 0 : p.r32(sp) >>> 0;
  return { args, from: p.whereOf(ret) };
}
/** Every API call a stopAt names comes through here: a debugger breaks on the return line to stop at those calls. */
function w95ApiEntry(call, args, from, thread) {
  return call;
}
function resolve(p, place) {
  if (typeof place === 'number') return place >>> 0;
  const s = String(place).trim();
  let m = /^([\w.]+)!(.+)$/.exec(s);
  if (m) {
    const mod = p.byName.get(m[1].toUpperCase()) || p.byName.get(m[1]); if (!mod) throw new Error(`debug: no module ${m[1]} is loaded`);
    if (mod.kind === 'ne') { const a = p.neExport(mod, /^#?\d+$/.test(m[2]) ? +m[2].replace('#', '') : m[2]); if (!a || !p.selValid(a >>> 16)) throw new Error(`debug: ${s} is not an export`); return (p.selBase(a >>> 16) + (a & 0xffff)) >>> 0; }
    const a = mod.exports.get(m[2]); if (typeof a !== 'number' || !a) throw new Error(`debug: ${s} is not an export`); return a >>> 0;
  }
  m = /^([\w.]+)\+([0-9a-f]+)$/i.exec(s);
  if (m) {
    const n = m[1].toUpperCase().replace(/\.\w+$/, ''), mod = (p.modules || []).find(x => x && x.meta && shortOf(x) === n) || p.byName.get(n); if (!mod) throw new Error(`debug: no module ${m[1]} is loaded`);
    return ((mod.base || mod.meta.textLo) + parseInt(m[2], 16)) >>> 0;
  }
  if (!/^(0x)?[0-9a-f]+$/i.test(s)) throw new Error(`debug: ${s} is not an address, MODULE+offset or DLL!Export`);
  return parseInt(s, 16) >>> 0;
}
const api = {
  /** Module names to run as JavaScript: upper case, no extension. '*' means all. */
  names: new Set(),
  wants(label) { const n = String(label).split(/[\\/]/).pop().replace(/\.\w+$/, '').toUpperCase(); return api.names.has(n) || api.names.has('*'); },
  /** Make the module; returns { run }. The source is kept for W95DynJs.source(label). */
  make(wasm, label, blocks, env, cpu, mem, proc) {
    const src = source(wasm, label, blocks); made.set(String(label).toUpperCase(), src);
    if (proc) BP.proc = proc;
    return (0, eval)(src)(env, cpu, mem, BP);
  },
  source: label => made.get(String(label).toUpperCase()) || null,
  /** The debugger: debug(process, [method, ...arguments]) calls one of D's methods (see above). */
  debug(p, [method, ...args], host) { if (!D[method]) throw new Error(`debug: no method ${method}`); BP.proc = p; if (host) BP.host = host; return D[method](p, ...args); },
  /** While on, every block of a JS-run module goes through BP.at, breakpoints or not: a debugger's breakpoint there
   *  stops at the next block entered (tools/devtools-mcp.mjs guest_step). */
  stepping(on) { BP.stepAll = !!on; BP.on = !!(BP.byId.size || BP.stepAll); return BP.on; },
  /** Called with each recorded hit as it happens (the worker posts it to the page). */
  set onHit(f) { BP.onHit = f; }, get onHit() { return BP.onHit; },
  _source: source, _parse: parse,
};
if (typeof self !== 'undefined') self.W95DynJs = api;
if (typeof window !== 'undefined') window.W95DynJs = api;
})();
