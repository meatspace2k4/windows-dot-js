// Run-time code is translated for the code segment it runs in: the same bytes run as 32-bit code after running as
// 16-bit code (DIBENG compiles 16- and 32-bit blits into one buffer) are decoded again, not run from the 16-bit block
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const ACC = 0x40000, AT = 0x200000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem;
Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {}; p.selLimit = () => 0xffff;
const dv = new DataView(mem.buffer);
// two selectors on the same base: 0x10 a 16-bit code segment, 0x18 a 32-bit one (D bit)
dv.setUint32(ACC + 0x10, 0, true); dv.setUint32(ACC + 0x18, 0x400000, true);
// B8 78 56 34 12: as 32-bit code mov eax, 12345678h; as 16-bit code mov ax, 5678h then xor al, 12h (566Ah)
p.u8.set([0xb8, 0x78, 0x56, 0x34, 0x12, 0xeb, 0x00, 0xcc], AT);
const run = cs => { p.cpu.cs.value = cs; p.cpu.csb.value = AT; p.cpu.eax.value = 0; p.cpu.esp.value = 0x8000; try { p.dynBlock(AT).run(); } catch (_) { /* the bytes after it */ } return p.cpu.eax.value >>> 0; };
assert.equal(run(0x10), 0x566a);
assert.equal(run(0x18), 0x12345678);   // (the 16-bit block, kept by address alone, ran here before: 566Ah)
assert.equal(run(0x10), 0x566a);
console.log('dynmode: ok');
