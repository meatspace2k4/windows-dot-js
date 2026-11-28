// verr and verw in run-time code (dyn.js), as the recompiled modules have them (recomp.py verify): ZF when the
// selector's descriptor is present, and for verw when the segment is not code (TOOLHELP's TaskFirst checks a task's
// SS with verr before it reads the stack's bounds from it: untranslated, the check was an invalid-opcode fault)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, LDT = 0x30000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.ne = new Map(); p.modules = []; p.trap = () => {};
const dv = new DataView(mem.buffer);
// descriptors: 1007h a data segment (base 1000h, limit FFh), 100Fh a code segment, 1017h none
// (the access table holds the access byte as LAR answers it, in bits 8 to 15)
// (the processor's descriptors: limit FFh, base 1000h and 2000h; a data and a code segment, access byte bit 3)
dv.setUint32(LDT + 0x1000, 0x100000ff, true); dv.setUint32(LDT + 0x1004, 0xf300, true);
dv.setUint32(LDT + 0x1008, 0x200000ff, true); dv.setUint32(LDT + 0x100c, 0xfb00, true);
// verr ax; jmp 300000h (32-bit code) at 200000h, and verw ax; jmp 300000h at 200010h
p.u8.set([0x0f, 0x00, 0xe0, 0xe9, ...new Uint8Array(new Int32Array([0x300000 - (0x200000 + 8)]).buffer)], 0x200000);
p.u8.set([0x0f, 0x00, 0xe8, 0xe9, ...new Uint8Array(new Int32Array([0x300000 - (0x200010 + 8)]).buffer)], 0x200010);
const zfAfter = (sel, which) => { p.cpu.eax.value = sel; p.cpu.zf.value = 2; const blk = p.dynBlock(which === 'r' ? 0x200000 : 0x200010); assert.equal(blk.run() >>> 0, 0x300000); return p.cpu.zf.value; };
assert.equal(zfAfter(0x1007, 'r'), 1, 'verr: a data segment is readable');
assert.equal(zfAfter(0x1007, 'w'), 1, 'verw: and writable');
assert.equal(zfAfter(0x100f, 'r'), 1, 'verr: a code segment is readable');
assert.equal(zfAfter(0x100f, 'w'), 0, 'verw: a code segment is not writable');
assert.equal(zfAfter(0x1017, 'r'), 0, 'verr: no descriptor');
assert.equal(zfAfter(0x1017, 'w'), 0, 'verw: no descriptor');
console.log('dynverr: ok');
