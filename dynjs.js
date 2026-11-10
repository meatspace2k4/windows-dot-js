'use strict';
// Debuggable JavaScript for dyn.js's translated modules.
// A module named in W95DynJs.names (set by mod-dynjs.js, #mod=dynjs:MSTASK+EXPLORER) runs as JavaScript made from its
// wasm bytes instead of as WebAssembly. Each block is a function named by its guest address (b_1001def); registers are
// R.eax etc. The source shows in DevTools as dyn/NAME.js, so breakpoints work there.
// W95DynJs.breakAt(address) pauses at a block's entry while DevTools is open.
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
  const push = (e, lit = false) => st.push({ e, lit }), pop = () => { const v = st.pop(); if (!v) throw new Error(`dynjs: ${fname}: the stack is empty at ${hex(r.at)}`); return v.lit ? v.e : `(${v.e})`; };
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
      if (op === 0x10) { const i = r.uleb(), f = m.impF[i]; t = m.types[f ? f.type : m.funcT[i - m.impF.length]]; callee = f ? `env.${f.name}` : `f${i - m.impF.length}`; }
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
    `const zero = () => { throw new WebAssembly.RuntimeError('divide by zero'); };`,
    `const divs = (a, b) => (b === 0 ? zero() : a === -2147483648 && b === -1 ? (() => { throw new WebAssembly.RuntimeError('integer overflow'); })() : (a / b) | 0), divu = (a, b) => (b === 0 ? zero() : ((a >>> 0) / (b >>> 0)) | 0);`,
    `const rems = (a, b) => (b === 0 ? zero() : (a % b) | 0), remu = (a, b) => (b === 0 ? zero() : ((a >>> 0) % (b >>> 0)) | 0);`,
    `const div64 = (a, b) => (b === 0n ? zero() : a / b), rem64 = (a, b) => (b === 0n ? zero() : a % b);`,
    `const rotl = (a, b) => (a << (b & 31)) | (a >>> (32 - (b & 31) & 31)), rotr = (a, b) => (a >>> (b & 31)) | (a << (32 - (b & 31) & 31));`,
    `const ctz = a => (a ? 31 - Math.clz32(a & -a) : 32), popcnt = a => { let n = 0; for (a >>>= 0; a; a &= a - 1) n++; return n; };`,
    `const nearest = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };`,
    `const sat32 = x => (x !== x ? 0 : x <= -2147483648 ? -2147483648 : x >= 2147483647 ? 2147483647 : Math.trunc(x) | 0), trunc32 = x => Math.trunc(x) | 0;`,
    `const sat64 = x => (x !== x ? 0n : x <= -9223372036854775808 ? -9223372036854775808n : x >= 9223372036854775807 ? 9223372036854775807n : BigInt(Math.trunc(x)));`];
  m.bodies.forEach((b, i) => {
    const t = m.types[m.funcT[i]], a = addr.get(i), name = a === undefined ? (i === 0 ? 'run' : `f${i}`) : `b_${hex(a)}`;
    L.push(`function ${name}(${t.p.map((_, k) => `p${k}`).join(', ')}) {${a === undefined ? '' : `   // ${hex(a)}`}`);
    if (a !== undefined) L.push(`  if (BP.on) BP.at(0x${hex(a)}, R);`);
    L.push(body(m, wasm, b, t, name), '}');
  });
  L.push(`const T = [${m.table.map(f => `b_${hex(addr.get(f - nimp))}`).join(', ')}];`);
  // Direct calls use f<i>; alias those to the named block functions.
  m.bodies.forEach((_, i) => { const a = addr.get(i); if (a !== undefined) L.push(`const f${i} = b_${hex(a)};`); });
  L.push(`const f0 = run;`, `return { run };`, `})`, `//# sourceURL=dyn/${label.replace(/[^\w.-]+/g, '_')}.js`);
  return L.join('\n');
}
// Every block calls BP.at(address, R) while BP.on is set; at a breakpoint address it runs `debugger`, which pauses in
// DevTools with the registers in R.
const BP = { on: false, breaks: new Set(), at(a, R) { if (BP.breaks.has(a)) debugger; } };
const made = new Map();
const api = {
  /** Module names to run as JavaScript: upper case, no extension. '*' means all. */
  names: new Set(),
  wants(label) { const n = String(label).split(/[\\/]/).pop().replace(/\.\w+$/, '').toUpperCase(); return api.names.has(n) || api.names.has('*'); },
  /** Make the module; returns { run }. The source is kept for W95DynJs.source(label). */
  make(wasm, label, blocks, env, cpu, mem) {
    const src = source(wasm, label, blocks); made.set(String(label).toUpperCase(), src);
    return (0, eval)(src)(env, cpu, mem, BP);
  },
  source: label => made.get(String(label).toUpperCase()) || null,
  /** Pause at a block's entry (needs DevTools open); clearBreak removes one address or all. */
  breakAt: a => { BP.breaks.add(a >>> 0); BP.on = true; return [...BP.breaks]; },
  clearBreak: a => { if (a === undefined) BP.breaks.clear(); else BP.breaks.delete(a >>> 0); BP.on = !!BP.breaks.size; return [...BP.breaks]; },
  _source: source, _parse: parse,
};
if (typeof self !== 'undefined') self.W95DynJs = api;
if (typeof window !== 'undefined') window.W95DynJs = api;
})();
