// Run-time translation of what tools/staticmap.py found reachable and untranslatable: fnsave / frstor (the x87 state
// saved, the unit initialized, and restored: MSVCRT20's and CALC's), cpuid (an i486DX4, SYSDM's check) and cmpxchg.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer); Object.defineProperty(p, 'u8', { value: u8 });
p.cpu = Object.fromEntries(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if'].map(n => [n, new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'fcw' ? 0x37f : 0)]));
p.trap = () => {}; p.r0Depth = 1;
let at = 0x200000;
const run = bytes => { at += 0x40; u8.set([...bytes, 0xc3], at); p.cpu.esp.value = 0x8000; p.dynBlock(at).run(); };
const FPU = 0x10000, st = i => dv.getFloat64(FPU + 8 * ((p.cpu.ftop.value + i) & 7), true);

// two values on the stack (fld1, fldpi), fnsave [esi], then frstor [esi]
p.cpu.esi.value = 0x300000;
run([0xd9, 0xe8, 0xd9, 0xeb]); assert.equal(st(0), Math.PI); assert.equal(st(1), 1);
const top = p.cpu.ftop.value; p.cpu.fcw.value = 0x27f;
run([0xdd, 0x36]);   // fnsave [esi]
assert.equal(dv.getUint16(0x300000, true), 0x27f, 'the control word'); assert.equal((dv.getUint16(0x300004, true) >> 11) & 7, top, 'TOP in the status word');
assert.equal(p.cpu.ftop.value, 0); assert.equal(p.cpu.fcw.value, 0x37f, 'then initialized');
assert.equal(p.f80load(0x300000 + 28), Math.PI, 'ST(0), 80 bits'); assert.equal(p.f80load(0x300000 + 38), 1);
run([0xd9, 0xee]);   // fldz: something else there
run([0xdd, 0x26]);   // frstor [esi]
assert.equal(p.cpu.ftop.value, top); assert.equal(p.cpu.fcw.value, 0x27f); assert.equal(st(0), Math.PI); assert.equal(st(1), 1);

// cpuid
p.cpu.eax.value = 0; run([0x0f, 0xa2]);
assert.equal(p.cpu.eax.value, 1); assert.equal(Buffer.from(new Uint32Array([p.cpu.ebx.value, p.cpu.edx.value, p.cpu.ecx.value]).buffer).toString(), 'GenuineIntel');
p.cpu.eax.value = 1; run([0x0f, 0xa2]); assert.equal(p.cpu.eax.value, 0x480); assert.equal(p.cpu.edx.value & 1, 1, 'the FPU');

// cmpxchg [esi], ecx: equal, then not
dv.setUint32(0x300100, 5, true); p.cpu.esi.value = 0x300100;
p.cpu.eax.value = 5; p.cpu.ecx.value = 9; run([0x0f, 0xb1, 0x0e]);
assert.equal(dv.getUint32(0x300100, true), 9); assert.equal(p.cpu.zf.value, 1);
p.cpu.eax.value = 5; run([0x0f, 0xb1, 0x0e]);
assert.equal(p.cpu.eax.value, 9, 'the destination into the accumulator'); assert.equal(p.cpu.zf.value, 0); assert.equal(dv.getUint32(0x300100, true), 9);
console.log('dyngaps: ok');
