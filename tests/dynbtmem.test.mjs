// Run-time code's bt / bts / btr / btc with a memory operand and a register's bit index (IFSMGR's): the index is signed
// and picks the dword (the word, at 16 bits) from the operand's address on, the bit within it its low 5 (4) bits.
// Untranslated, the block was an invalid opcode (exception 6) and IFSMGR's initialization stopped there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const p = Object.create(window.W95Win32.Process.prototype), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {}; p.r0Depth = 1;
const BITS = 0x300000; let at = 0x200000;
const run = (bytes, ecx) => { at += 0x40; p.u8.set([...bytes, 0xc3], at); p.cpu.esp.value = 0x8000; p.cpu.esi.value = BITS; p.cpu.ecx.value = ecx; p.dynBlock(at).run(); return p.cpu.cf.value; };
p.u8.fill(0, BITS - 16, BITS + 16);
assert.equal(run([0x0f, 0xab, 0x0e], 37), 0);   // bts [esi], ecx: bit 37 is the next dword's bit 5
assert.equal(p.u8[BITS + 4], 0x20); assert.equal(p.u8[BITS], 0);
assert.equal(run([0x0f, 0xa3, 0x0e], 37), 1, 'bt sees it');
assert.equal(run([0x0f, 0xb3, 0x0e], 37), 1); assert.equal(p.u8[BITS + 4], 0, 'btr clears it');
assert.equal(run([0x0f, 0xbb, 0x0e], -1), 0); assert.equal(p.u8[BITS - 1], 0x80, 'a negative index: before the address');
console.log('dynbtmem: ok');
