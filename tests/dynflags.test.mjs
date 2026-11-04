// EFLAGS' AC and ID bits through POPFD and PUSHFD in run-time code (dyn.js xf): an i486 keeps what POPFD gives AC, and
// this one (a DX4, with CPUID) ID too, which is how a program tells it from a 386 (Windows 98 Setup: "requires a
// computer with an 80486 processor or higher", AC read back clear)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.ne = new Map(); p.modules = []; p.trap = () => {};
// the bit toggled, popped, pushed back and compared, for AC (40000h, its result in EDX) then ID (200000h, in EAX):
// pushfd; pop eax; mov ecx, eax; xor eax, bit; push eax; popfd; pushfd; pop eax; xor eax, ecx
const toggle = bit => [0x9c, 0x58, 0x89, 0xc1, 0x35, ...new Uint8Array(new Uint32Array([bit]).buffer), 0x50, 0x9d, 0x9c, 0x58, 0x31, 0xc8];
const code = [...toggle(0x40000), 0x89, 0xc2, ...toggle(0x200000)], at = 0x200000;
p.u8.set([...code, 0xe9, ...new Uint8Array(new Int32Array([0x300000 - (at + code.length + 5)]).buffer)], at);
p.cpu.esp.value = 0x250000;
let eip = at; for (let k = 0; k < 20 && eip !== 0x300000; k++) eip = p.dynBlock(eip).run() >>> 0;
assert.equal(eip, 0x300000);
assert.equal(p.cpu.edx.value >>> 0, 0x40000, 'AC takes what POPFD gives it: an i486');
assert.equal(p.cpu.eax.value >>> 0, 0x200000, 'ID too: CPUID is there');
assert.equal(p.cpu.esp.value >>> 0, 0x250000, 'the stack as it was');
console.log('dynflags: ok');
