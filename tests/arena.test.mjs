// Two programs linked at 400000h without relocations run at once, as Windows 95 gives each process its own arena: each
// image is mapped at its preferred base in its process's own view, the view in place the one of the process whose
// thread runs, and the program whose view is put by is hidden from the dispatcher. The system's DLLs keep out of
// every program's image. A second instance of one program shares its image record, each with its own data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

// a program image at 400000h, relocations stripped: one writable section at RVA 1000h holding `fill` bytes
function exe(fill) {
  const f = new Uint8Array(0x400), dv = new DataView(f.buffer);
  f[0] = 0x4d; f[1] = 0x5a; dv.setUint32(0x3c, 0x80, true);
  dv.setUint32(0x80, 0x4550, true); dv.setUint16(0x84, 0x14c, true); dv.setUint16(0x86, 1, true); dv.setUint16(0x94, 0xe0, true);
  dv.setUint16(0x96, 0x0102 | 1, true);
  const opt = 0x98; dv.setUint16(opt, 0x10b, true); dv.setUint32(opt + 16, 0x1000, true); dv.setUint32(opt + 28, 0x400000, true);
  dv.setUint32(opt + 32, 0x1000, true); dv.setUint32(opt + 36, 0x200, true); dv.setUint32(opt + 56, 0x2000, true); dv.setUint32(opt + 60, 0x200, true);
  dv.setUint32(opt + 92, 16, true);
  const sh = opt + 0xe0; f.set([0x2e, 0x64, 0x61, 0x74, 0x61], sh); dv.setUint32(sh + 8, 0x200, true); dv.setUint32(sh + 12, 0x1000, true);
  dv.setUint32(sh + 16, 0x200, true); dv.setUint32(sh + 20, 0x200, true); dv.setUint32(sh + 36, 0xe0000040, true);
  f.fill(fill, 0x200, 0x400);
  return f;
}
const mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
const p = Object.create(Process.prototype);
Object.assign(p, {
  mem, dlls: new Map(), modules: [], byName: new Map(), inits: [], threadsById: new Map(), selUsed: new Uint8Array(8192), host: { now: () => 0 }, t0: 0,
  heap: 0x2000000, alloc(n) { const a = this.heap; this.heap += (n + 15) & ~15; return a; }, newThread: () => ({}), startClock: () => ({}), effect() {},
});
const meta = { base: 0x400000, entry: 0x401000, textLo: 0, textHi: 0, blocks: [], size: 0x2000, dynamic: true };
const D = 0x401000;

// two different programs, both at 400000h: the second goes there too, in a view of its own
assert.equal(p.imageRoom(0x400000, 0x2000, false, true), 0x400000);
const a = p.spawn(exe(0xaa), null, { ...meta }, 'C:\\APPS\\ONE.EXE', 'ONE.EXE');
assert.equal(p.imageRoom(0x400000, 0x2000, false, true), 0x400000, 'a program goes over another program\'s image');
assert.equal(p.imageRoom(0x400000, 0x2000, false), 0, 'a DLL without relocations does not');
const b = p.spawn(exe(0xbb), null, { ...meta }, 'C:\\APPS\\TWO.EXE', 'TWO.EXE');
assert.notEqual(a.exe, b.exe); assert.equal(a.exe.base, 0x400000); assert.equal(b.exe.base, 0x400000);
assert.equal(p.u8[D], 0xbb, 'the new program\'s image in place as it is mapped (started from no thread)');
assert.ok(a.exe.hidden && !b.exe.hidden, 'the other program hidden from the dispatcher');

p.imgUse(a); assert.equal(p.u8[D], 0xaa, 'the first program\'s image when its thread runs');
assert.ok(!a.exe.hidden && b.exe.hidden);
p.u8[D + 4] = 0x11;   // (its data, written as it runs)
p.imgUse(b); assert.equal(p.u8[D], 0xbb); assert.equal(p.u8[D + 4], 0xbb, 'each with its own data');
p.u8[D + 4] = 0x22;
p.imgUse(a); assert.equal(p.u8[D + 4], 0x11);
p.imgUse(b); assert.equal(p.u8[D + 4], 0x22);
p.imgUse(null); assert.equal(p.u8[D], 0xaa, 'the system\'s context: the view every other process has');

// a process's module handle is its own program's, and USER knows the two as two modules
p.thread16 = { pc: a }; assert.equal(p.moduleFor(0x400000), a.exe);
const ha = p.hinst16(0x400000);
p.thread16 = { pc: b }; assert.equal(p.moduleFor(0x400000), b.exe);
const hb = p.hinst16(0x400000);
assert.notEqual(ha, hb); assert.equal(p.hinst16(0x400000, a.exe), ha);
p.thread16 = null;

// run-time code at one address in both views: each process runs its own, neither taken for the other's
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {};
const code = (pc, v) => { p.imgUse(pc); p.u8.set([0xb8, v, 0, 0, 0, 0xc3], 0x401100); };   // mov eax, v; ret
code(a, 1); code(b, 2);
const run = pc => { p.imgUse(pc); p.cpu.esp.value = 0x8000; p.cpu.eax.value = 0; p.dynBlock(0x401100).run(); return p.cpu.eax.value; };
assert.equal(run(a), 1); assert.equal(run(b), 2); assert.equal(run(a), 1);
assert.equal(p.dynCache.get(`${0x401100}:0:32`).length, 2, 'both translations kept');

// a second instance of the first program: one image record, its own data
const a2 = p.spawn(exe(0xaa), null, { ...meta }, 'C:\\APPS\\ONE.EXE', 'ONE.EXE');
assert.equal(a2.exe, a.exe);
p.imgUse(a2); assert.equal(p.u8[D + 4], 0xaa, 'laid out afresh');
p.imgUse(a); assert.equal(p.u8[D + 4], 0x11);

// the second program ends: its view and its record go; the rest go on
p.procs.delete(b.pid); b.exitCode = 0; p.arenaForget(b);
assert.ok(!p.modules.includes(b.exe));
p.imgUse(a2); assert.equal(p.u8[D + 4], 0xaa); p.imgUse(a); assert.equal(p.u8[D + 4], 0x11);
p.procs.delete(a2.pid); a2.exitCode = 0; p.arenaForget(a2);
assert.equal(p.arena.length, 0, 'no process with a view of its own: the slot goes');
assert.equal(p.u8[D + 4], 0x11); assert.ok(!a.exe.hidden);

// a fault in such a program names its file
p.thread16 = { pc: a, id: 1 }; p.r0Depth = 0; p.meta = {};
assert.equal(p.faultInfo(14, 0x401100, 0).module, 'ONE.EXE');
console.log('arena: ok');
