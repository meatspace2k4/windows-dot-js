// A rep string instruction charges the block budget for its rounds, one block for eight (dyn.js strop), as the clock
// counts blocks (win32.js tick): run whole inside one block, a copy loop of rep movs hardly moved the machine's clock,
// a thread copying files was not preempted for 200 ms holding the Win16Lock, and the system stopped while Setup copied
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
// mov ecx, 800h; mov edi, 280000h; mov al, 5Ah; rep stosb; jmp 300000h
const at = 0x200000, code = [0xb9, 0x00, 0x08, 0, 0, 0xbf, 0, 0, 0x28, 0, 0xb0, 0x5a, 0xf3, 0xaa];
p.u8.set([...code, 0xe9, ...new Uint8Array(new Int32Array([0x300000 - (at + code.length + 5)]).buffer)], at);
p.cpu.esp.value = 0x250000; p.cpu.budget.value = 100000;
let eip = at; for (let k = 0; k < 10 && eip !== 0x300000; k++) eip = p.dynBlock(eip).run() >>> 0;
assert.equal(eip, 0x300000);
assert.equal(p.u8[0x280000 + 0x7ff], 0x5a, 'the store done'); assert.equal(p.cpu.ecx.value, 0, 'the count run out');
const spent = 100000 - p.cpu.budget.value;
assert.ok(spent >= 0x800 / 8, `the rounds charged: ${spent} blocks for 2048 rounds`);
assert.ok(spent < 0x800 / 8 + 8, 'about one block for eight rounds');
console.log('dynrepbudget: ok');
