// dynjs.js: a module named in W95DynJs.names runs as JavaScript made from its wasm.
// Checks: the JS module leaves every register and the stack exactly as the wasm module does (loop, push/pop, shift,
// multiply, negate, far jump out); blocks are functions named by address; the same wasm gives the same source;
// a module not named still runs as WebAssembly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'netpatch.js', 'dynjs.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { memo } = window.W95Dyn, J = self.W95DynJs;

// the file: one code segment at 200h and DGROUP, one export (1:0)
//   mov cx, 5; xor ax, ax; L: add ax, cx; push ax; pop bx; dec cx; jnz L; shl ax, 3; imul ax, ax, 7; neg ax; jmp far 0:0
const CODE = [0xb9, 5, 0, 0x31, 0xc0, 0x01, 0xc8, 0x50, 0x5b, 0x49, 0x75, 0xf9, 0xc1, 0xe0, 3, 0x6b, 0xc0, 7, 0xf7, 0xd8, 0xea, 0, 0, 0, 0];
const ne = () => {
  const f = new Uint8Array(0x400), dv = new DataView(f.buffer), w = (o, v) => dv.setUint16(o, v, true);
  f.set([0x4d, 0x5a]); dv.setUint32(0x3c, 0x40, true);
  const n = 0x40; f.set([0x4e, 0x45], n);
  w(n + 0x0c, 0x8001); w(n + 0x0e, 2); w(n + 0x10, 0x100); w(n + 0x12, 0); w(n + 0x14, 0); w(n + 0x16, 0);
  w(n + 0x1c, 2); w(n + 0x1e, 1); w(n + 0x20, 0); w(n + 0x32, 4); w(n + 0x3e, 0x300);
  let p = 0x40; w(n + 0x22, p);
  w(n + p, 0x20); w(n + p + 2, 0x20); w(n + p + 4, 0x0000); w(n + p + 6, 0x20);
  w(n + p + 8, 0x30); w(n + p + 10, 0x10); w(n + p + 12, 0x0001); w(n + p + 14, 0x10);
  p += 16; w(n + 0x24, p); w(n + 0x26, p);
  f[n + p] = 4; f.set([...'PMOD'].map(c => c.charCodeAt(0)), n + p + 1); p += 5; w(n + p, 0); p += 2;
  f[n + p] = 7; f.set([...'ENTRYPT'].map(c => c.charCodeAt(0)), n + p + 1); p += 8; w(n + p, 1); p += 2; f[n + p++] = 0;
  w(n + 0x28, p); w(n + p, 1); p += 2;
  w(n + 0x2a, p); f[n + p] = 0; f[n + p + 1] = 6; f.set([...'KERNEL'].map(c => c.charCodeAt(0)), n + p + 2); p += 8;
  w(n + 0x04, p); f.set([1, 1, 3], n + p); w(n + p + 3, 0); f[n + p + 5] = 0; w(n + 0x06, 6); p += 6;
  dv.setUint32(n + 0x2c, 0, true);
  f.set(CODE, 0x200);
  return f;
};
const proc = () => {
  const p = Object.create(Process.prototype);
  p.mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.cpu = {}; for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[r] = new WebAssembly.Global({ value: 'i32', mutable: true }, r === 'budget' ? 0x1000 : 0);
  Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(),
    heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, findFile16: () => null, fs: { exists: () => false },
    imports: { env: { api: () => 0, tick: () => 0, f80load: () => 0, f80store() {}, fbld: () => 0, fbstp() {} } }, trap() {}, tick: () => 0 });
  return p;
};
const run = named => {
  memo.clear(); J.names.clear(); if (named) J.names.add('PMOD');
  const p = proc(), rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\PMOD.DLL', ne()), g = rec.segs[0], d = rec.segs[1];
  p.cpu.cs.value = g.sel; p.cpu.csb.value = g.base; p.cpu.ss.value = d.sel; p.cpu.ssb.value = d.base; p.cpu.esp.value = 0x10;
  assert.equal(rec.run(g.base), 3, 'out of the module at the far jump');
  const regs = Object.fromEntries(Object.entries(p.cpu).map(([k, v]) => [k, v.value]));
  const again = () => { for (const r of ['eax', 'ebx', 'ecx']) p.cpu[r].value = 0; p.cpu.cs.value = g.sel; p.cpu.csb.value = g.base; p.cpu.ss.value = d.sel; p.cpu.ssb.value = d.base; p.cpu.esp.value = 0x10; return rec.run(g.base); };
  return { p, again, regs, rec, base: g.base, stack: [...p.u8.subarray(d.base, d.base + 0x10)] };
};
const w = run(false), j = run(true);
assert.equal(w.regs.eax & 0xffff, 0xfcb8, 'the wasm module: -(15 << 3) * 7');
assert.equal(w.regs.ebx & 0xffff, 15);
assert.ok(w.rec.run instanceof Function && /native code/.test(String(w.rec.run)), 'not named: WebAssembly');
assert.ok(!/native code/.test(String(j.rec.run)), 'named: JavaScript');
assert.deepEqual(j.regs, w.regs, 'the processor as the wasm module leaves it');
assert.deepEqual(j.stack, w.stack, 'and the stack');
const src = J.source('PMOD');
assert.match(src, new RegExp(`function b_${(j.base >>> 0).toString(16)}\\(\\)`), 'a block is a function named by its address');
assert.match(src, /sourceURL=dyn\/PMOD\.js/);
assert.equal(J._source(j.rec.netSeed.wasm, 'PMOD', j.rec.netSeed.blocks), src, 'the same wasm, the same text');

// the debugger (W95DynJs.debug, the page's win95.debug). A breakpoint fires where a block is entered: the loop's block
// at base + 5 is entered by the jump back, with CX 4, 3, 2, 1 (the first pass runs on inside the block before it)
const dbg = (...a) => J.debug(j.p, a), loop = (j.base + 5) >>> 0, seen = []; J.onHit = h => seen.push(h.seq);
assert.deepEqual(dbg('modules').map(m => [m.name, m.js]), [['PMOD', true]]);
const b1 = dbg('breakpoint', { at: loop, capture: 'R.ecx & 0xffff' });
assert.equal(j.again(), 3, 'a recording breakpoint does not stop the machine');
assert.deepEqual(dbg('hits').map(h => h.value), [4, 3, 2, 1], 'each time the block is reached, with the captured value');
assert.deepEqual(seen, [1, 2, 3, 4],'each hit told as it happens');
const h0 = dbg('hits')[0]; assert.equal(h0.at, loop); assert.equal(h0.id, b1.id); assert.equal(h0.regs.ecx & 0xffff, 4); assert.equal(h0.stack.length, 16);
assert.equal(dbg('breakpoints')[0].n, 4);
assert.equal(dbg('remove', b1.id), true); assert.equal(dbg('remove', b1.id), false);
const b2 = dbg('breakpoint', { at: loop.toString(16), when: 'n === 3 && (R.ecx & 0xffff) === 2', capture: 'r8(R.csb + 5)' });
j.again();
assert.deepEqual(dbg('hits', 4).map(h => [h.id, h.n, h.value]), [[b2.id, 3, 0x01]], 'a condition: only where it holds; memory read (the block\'s first byte)');
const bs = dbg('source', loop + 1); assert.equal(bs.block, loop); assert.match(bs.text, new RegExp(`^function b_${loop.toString(16)}\\(`)); assert.match(bs.text, /\n\}$/);
assert.deepEqual(dbg('read', j.base, 3), [0xb9, 5, 0]);
assert.equal(dbg('clear'), true); assert.deepEqual(dbg('breakpoints'), []); assert.deepEqual(dbg('hits'), []);
assert.deepEqual(dbg('run', []), []); assert.ok(/native code/.test(String(j.rec.run)), 'run([]): back to WebAssembly');
assert.deepEqual(dbg('run', ['pmod']), ['PMOD']); assert.equal(j.again(), 3); assert.equal(j.p.cpu.eax.value & 0xffff, 0xfcb8);
assert.throws(() => dbg('nope'), /no method nope/);
// an expression that throws ends its breakpoint and never the machine; one that does not parse is refused
const b3 = dbg('breakpoint', { at: loop, when: 'R32(R.esp) === 1' });
assert.equal(j.again(), 3, 'the machine runs on'); assert.match(dbg('breakpoints').find(b => b.id === b3.id).error, /R32 is not defined/);
assert.deepEqual(dbg('hits'), []);
assert.throws(() => dbg('breakpoint', { at: loop, when: 'R.eax ===' }), /does not parse/);
dbg('clear');
console.log('dynjs: ok');
