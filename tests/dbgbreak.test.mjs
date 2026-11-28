// Breakpoints kept in the machine (dynjs.js breakpoint, win32.js addEntryHook):
// (1) a hook inside a chained block: the loop's block, which the module's own jnz enters from within its own code
//     (wasm, no dispatcher between), comes back to the dispatcher once hooked (setEntryHook takes it out of the
//     module's table, for a 16-bit module too), and runs through again once the hook is gone (unhookEntry)
// (2) the table: a place kept as given, a hit recorded with exact registers by sequence number, 'record' running on,
//     'halt' asking the machine to halt (p.dbgHalt, worker.js step) until resume; a place whose module is not loaded
//     waits and is set as the module is put in place (api.placed)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'netpatch.js', 'dynjs.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { memo } = window.W95Dyn, J = self.W95DynJs;
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
const p = Object.create(Process.prototype);
p.mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.cpu = {}; for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[r] = new WebAssembly.Global({ value: 'i32', mutable: true }, r === 'budget' ? 0x1000 : 0);
Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(),
  heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, findFile16: () => null, fs: { exists: () => false },
  imports: { env: { api: () => 0, tick: () => 0, f80load: () => 0, f80store() {}, fbld: () => 0, fbstp() {} } }, trap() {}, tick: () => 0 });
memo.clear(); J.names.clear();
// (2a) a breakpoint set before its module is loaded: waiting
const early = J.debug(p, ['breakpoint', { at: 'PMOD+5', mode: 'record' }]);
assert.equal(early.at, null, 'its module not loaded: it waits');
const rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\PMOD.DLL', ne()), g = rec.segs[0], d = rec.segs[1], L = g.base + 5;
const go = () => { for (const r of ['eax', 'ebx', 'ecx']) p.cpu[r].value = 0; p.cpu.cs.value = g.sel; p.cpu.csb.value = g.base; p.cpu.ss.value = d.sel; p.cpu.ssb.value = d.base; p.cpu.esp.value = 0x10; return rec.run(g.base); };
assert.equal(J.debug(p, ['breakpoints'])[0].at, L, 'set as its module was put in place (api.placed)');
// (1) the loop's block, chained to from the module's own jnz, back to the dispatcher while hooked
J.debug(p, ['clear']);
assert.ok(!/native code/.test('') && rec.meta.blocks.includes(L), 'the loop is a block of its own');
const off = p.addEntryHook(L, () => undefined);
assert.equal(p.r32(rec.meta.lookup + 4 * (L - rec.meta.textLo)), 0, 'a 16-bit module\'s table: the hooked block out of it');
const r1 = go();
assert.notEqual(r1, 3, 'not run through to the far jump');
assert.equal(p.cpu.eip.value >>> 0, L, 'control back at the hooked block: the dispatcher calls the hook there');
off();
assert.equal(p.r32(rec.meta.lookup + 4 * (L - rec.meta.textLo)), rec.meta.blocks.indexOf(L) + 1, 'the hook gone: the block back in the table');
assert.equal(go(), 3, 'and the loop chained again, through to the far jump');
// (1b) through the dispatcher: the module's run, come to the hooked block from its own jnz, is sent back (its trap,
// dynWant) and the dispatcher calls the hook there, once an entry, then runs the code there (win32.js dispatch:
// hookedAt; dyn.js dynRun, its region run once at a hooked entry: dynRegion ENTRY), and the loop goes on to its end.
// The hook sees each jump back, CX 4, 3, 2, 1 (the first pass runs on inside the first block). In a region, the
// loop's rounds ran past the hook, the first only seen
{
  delete p.trap;   // (the machine's own trap: no block there, dynWant, as dyn.js's run asks for run-time code)
  const seen = []; const off2 = p.addEntryHook(L, function () { seen.push(this.cpu.ecx.value & 0xffff); });
  for (const r of ['eax', 'ebx', 'ecx']) p.cpu[r].value = 0; p.cpu.cs.value = g.sel; p.cpu.csb.value = g.base; p.cpu.ss.value = d.sel; p.cpu.ssb.value = d.base; p.cpu.esp.value = 0x10;
  try { p.dispatch(g.base); } catch (_) { /* the far jump to 0:0 ends it, as it may */ }
  off2();
  assert.ok(seen.length >= 4, `the hook called at each entry from within (${JSON.stringify(seen)})`);
  assert.deepEqual(seen.slice(-4), [4, 3, 2, 1], 'once an entry, each with its registers then');
  assert.equal(p.cpu.eax.value & 0xffff, 0xfcb8, 'and the code there run as it would be: the same result');
}
// (2b) the table's hit as the dispatcher calls the hook: exact registers, by sequence number; record runs on
const b = J.debug(p, ['breakpoint', { at: 'PMOD+5', mode: 'record', capture: 'R.ecx & 0xffff' }]);
assert.equal(b.at, L); assert.equal(b.mode, 'record');
const hook = () => p.entryHooks.get(L).call(p);
p.cpu.ecx.value = 5; hook(); p.cpu.ecx.value = 4; hook();
const hits = J.debug(p, ['hits', 0]);
assert.deepEqual(hits.map(h => [h.id, h.n, h.value, h.place]), [[b.id, 1, 5, 'PMOD+5'], [b.id, 2, 4, 'PMOD+5']], 'each hit, its registers then');
assert.equal(J.debug(p, ['hits', hits[0].seq]).length, 1, 'read from a sequence number on');
assert.equal(J.debug(p, ['halted']), null, 'record: no halt');
// (2c) halt: asked of the machine at the first hit, kept until resume; the breakpoint stays
const h = J.debug(p, ['breakpoint', { at: 'PMOD+5', mode: 'halt' }]);
hook();
const st = J.debug(p, ['halted']);
assert.ok(st && st.id === h.id && st.at === L, 'halted at its hit');
assert.equal(J.debug(p, ['state']).halted.id, h.id, 'guest_state says so');
assert.equal(J.debug(p, ['resume']), true); assert.equal(J.debug(p, ['halted']), null, 'resumed');
assert.equal(J.debug(p, ['breakpoints']).length, 2, 'its breakpoints stay');
// (2d) removed: its hook gone, the block back in the table
J.debug(p, ['clear']);
assert.ok(!p.entryHooks.has(L), 'no hook left'); assert.equal(go(), 3);
assert.throws(() => J.debug(p, ['breakpoint', { at: 'not a place' }]), /is not an address/, 'a place that does not parse');
console.log('dbgbreak: ok');
