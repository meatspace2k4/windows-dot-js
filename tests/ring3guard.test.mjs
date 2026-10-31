// Ring-3 code has the protection Windows 95 gives it: an access to the null page, a VxD's pages or the frame buffer's
// ring-0 mapping (win32.js LAYOUT.PROT, a byte a page) is a page fault at the address before it is made, for the
// program's handlers or its fault dialog. Ring-0 code, 16-bit code and lea's address are not checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, P = Process.prototype;
const ACC = 0x40000, AT = 0x200000, FB = 0x3000000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem;
Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.selLimit = () => 0xffff;
p.protect(0, 0x1000); p.protect(FB, FB + 0x10000);
const traps = [];
p.trap = (a, c) => { traps.push([a >>> 0, c >>> 0, p.cpu.eip.value >>> 0]); p.cpu.eip.value = 0x7777; };   // (the handler's continuation)
let at = AT;
const run = (bytes, o = {}) => {
  at += 0x100; p.u8.set([...bytes, 0xc3], at); traps.length = 0;
  p.cpu.cs.value = o.cs || 0; p.cpu.csb.value = o.cs ? at : 0; p.r0Depth = o.r0 ? 1 : 0;
  p.cpu.esp.value = 0x8000; p.cpu.eax.value = 0x11223344; p.cpu.edi.value = o.edi || 0; p.cpu.ecx.value = 4;
  const next = p.dynBlock(at).run() >>> 0; return next;
};
// a read of address 0: a page fault at the instruction, CR2 0
assert.equal(run([0xa1, 0, 0, 0, 0]), 0x7777, 'the block goes on at the handler');
assert.deepEqual(traps, [[0, 0x4000000, AT + 0x100]]);
// a write into the frame buffer through a register: a write's fault, the frame buffer untouched
p.u8.fill(0x55, FB, FB + 16);
run([0x89, 0x07], { edi: FB + 4 });   // mov [edi], eax
assert.deepEqual(traps.map(t => t[0]), [FB + 4]); assert.equal(p.u8[FB + 4], 0x55, 'nothing drawn');
run([0xf3, 0xab], { edi: FB });   // rep stosd
assert.deepEqual(traps.map(t => [t[0], t[1]]), [[FB, 0x4000010]]); assert.equal(p.u8[FB], 0x55);
// what is not checked: ring 0, lea, and an address ring 3 has
run([0xa1, 0, 0, 0, 0], { r0: true }); assert.deepEqual(traps, [], 'ring 0');
run([0x8d, 0x05, 0, 0, 0, 0]); assert.deepEqual(traps, [], 'lea');
assert.equal(p.cpu.eax.value, 0);
run([0x89, 0x07], { edi: 0x300000 }); assert.deepEqual(traps, []); assert.equal(p.r32(0x300000), 0x11223344);
// a page given back
p.protect(FB, FB + 0x10000, false); run([0x89, 0x07], { edi: FB + 4 }); assert.deepEqual(traps, []);
console.log('ring3guard: ok');
