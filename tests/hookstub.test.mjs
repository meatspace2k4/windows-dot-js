// A host hook at a block of a module translated as it loaded is the module's own (dyn.js hookStub): its block table
// names a stub in the module's table that calls the hook, then the block or where the hook sent the call; the
// dispatcher leaves it to the stub (hookedIn), a hook gone puts the block back (hookUnstub), a table made again gets
// its stubs again (neSet, hookRestub), and a hook that ends the slice has the block wait without running it twice
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { memo } = window.W95Dyn;

// the file: one code segment (0: mov ax, 1234h; jmp far 0000:0000) and DGROUP, one export (1:0)
const ne = () => {
  const f = new Uint8Array(0x400), dv = new DataView(f.buffer), w = (o, v) => dv.setUint16(o, v, true);
  f.set([0x4d, 0x5a]); dv.setUint32(0x3c, 0x40, true);
  const n = 0x40; f.set([0x4e, 0x45], n);
  w(n + 0x0c, 0x8001); w(n + 0x0e, 2); w(n + 0x10, 0x100); w(n + 0x12, 0); w(n + 0x14, 0); w(n + 0x16, 0);
  w(n + 0x1c, 2); w(n + 0x1e, 1); w(n + 0x20, 0); w(n + 0x32, 4); w(n + 0x3e, 0x300);
  let p = 0x40; w(n + 0x22, p);
  w(n + p, 0x20); w(n + p + 2, 0x10); w(n + p + 4, 0x0000); w(n + p + 6, 0x10);
  w(n + p + 8, 0x30); w(n + p + 10, 0x10); w(n + p + 12, 0x0001); w(n + p + 14, 0x10);
  p += 16; w(n + 0x24, p); w(n + 0x26, p);
  f[n + p] = 4; f.set([...'HMOD'].map(c => c.charCodeAt(0)), n + p + 1); p += 5; w(n + p, 0); p += 2;
  f[n + p] = 7; f.set([...'ENTRYPT'].map(c => c.charCodeAt(0)), n + p + 1); p += 8; w(n + p, 1); p += 2; f[n + p++] = 0;
  w(n + 0x28, p); w(n + p, 1); p += 2;
  w(n + 0x2a, p); f[n + p] = 0; f[n + p + 1] = 6; f.set([...'KERNEL'].map(c => c.charCodeAt(0)), n + p + 2); p += 8;
  w(n + 0x04, p); f.set([1, 1, 3], n + p); w(n + p + 3, 0); f[n + p + 5] = 0; w(n + 0x06, 6); p += 6;
  dv.setUint32(n + 0x2c, 0, true);
  f.set([0xb8, 0x34, 0x12, 0xea, 0, 0, 0, 0], 0x200);
  return f;
};
const p = Object.create(Process.prototype);
p.mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.cpu = {}; for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[r] = new WebAssembly.Global({ value: 'i32', mutable: true }, r === 'budget' ? 0x1000 : 0);
let ticks = 0;
Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(),
  heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, findFile16: () => null, fs: { exists: () => false },
  imports: { env: { api: () => 0, tick: () => { ticks++; return 0; }, f80load: () => 0, f80store() {} } }, trap() {}, tick: () => 0 });
memo.clear();
const rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\HMOD.DLL', ne()), code = rec.segs[0], at = code.base;
if (!p.modules.includes(rec)) p.modules.push(rec);
p.cpu.cs.value = code.sel; p.cpu.csb.value = code.base; p.cpu.ss.value = rec.segs[1].sel;
const slot = () => p.r32(rec.meta.lookup + 4 * (at - rec.meta.textLo)) >>> 0, block = slot();
assert.ok(block && rec.table instanceof WebAssembly.Table, 'a block, and the module\'s table');

// a hook that takes the call: the module's run answers it, the block not run
let calls = 0, mode = 'take';
const off = p.addEntryHook(at, function () {
  calls++;
  if (mode === 'take') { this.cpu.eax.value = 0x4242; return 0x123456; }
  if (mode === 'sentinel') return LAYOUT.SENTINEL;
  if (mode === 'end') this.cpu.budget.value = 0;
  return undefined;
});
assert.notEqual(slot(), block, 'the block table names the stub'); assert.ok(p.hasBlock(rec, at)); assert.ok(p.hookedIn(at));
p.cpu.eax.value = 0;
assert.equal(rec.run(at), 3); assert.equal(p.cpu.eip.value >>> 0, 0x123456); assert.equal(p.cpu.eax.value, 0x4242); assert.equal(calls, 1);
// a hook that lets it go on: the block
mode = 'on'; p.cpu.eax.value = 0;
assert.equal(rec.run(at), 3); assert.equal(p.cpu.eax.value & 0xffff, 0x1234); assert.equal(p.cpu.eip.value, 0); assert.equal(calls, 2);
// a hook that ends the slice: the block waits for the clock, then runs, the hook run once
mode = 'end'; p.cpu.eax.value = 0; ticks = 0;
assert.equal(rec.run(at), 3); assert.equal(p.cpu.eax.value & 0xffff, 0x1234); assert.equal(calls, 3); assert.ok(ticks >= 1, 'the clock asked first');
p.cpu.budget.value = 0x1000;
// the dispatcher leaves it to the module: run once, not twice
mode = 'sentinel';
assert.equal(p.dispatch(at), 0); assert.equal(calls, 4);
// the module translated again: its new table gets the stub
mode = 'take'; p.neCompile(rec, true);
assert.notEqual(slot(), block); assert.equal(rec.run(at), 3); assert.equal(p.cpu.eip.value >>> 0, 0x123456); assert.equal(calls, 5);
// the hook gone: the block as it was, the dispatcher's again
off();
assert.equal(slot(), block, 'the block\'s own entry back'); assert.ok(!p.hookedIn(at));
p.cpu.eax.value = 0; assert.equal(rec.run(at), 3); assert.equal(p.cpu.eax.value & 0xffff, 0x1234); assert.equal(calls, 5);
// a return watched (onReturn) at a block: seen as the module's own code returns there
{
  // (a far call's return address to the block on a 16-bit stack, the module's DGROUP's selector as translated for)
  const sp = 0x200000; p.cpu.ssb.value = sp; p.cpu.esp.value = 0x100;
  p.w16(sp + 0x100, at - code.base); p.w16(sp + 0x102, code.sel);
  let seen = 0; p.onReturn(() => { seen++; });
  assert.notEqual(slot(), block, 'the return address\'s block through the stub');
  p.cpu.esp.value = 0x104;   // (returned: the stack above where the call was)
  assert.equal(rec.run(at), 3); assert.equal(seen, 1, 'the return seen'); assert.equal(slot(), block, 'and its hook gone');
}
console.log('hookstub: ok');
