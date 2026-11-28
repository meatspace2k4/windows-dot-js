// A far call or jump through a call gate goes to the gate's selector and offset (dyn.js gate), the offset the
// instruction names ignored, as the processor takes it; the callee's RETF comes back after the call. Windows 95 OSR 2.5
// Setup's SYSDETMG builds 16-bit gates (type 4) to its ring-0 port I/O and calls through them on Analyzing Your
// Computer: taken as a code segment, the gate's base was its target selector, and the call faulted (exception 0Eh)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const LDT = 0x30000, AT = 0x200000, END = AT + 0x1000, STACK = 0x300000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {}; p.selLimit = () => 0xffff; p.ne = new Map(); p.modules = [];
const desc = (sel, bytes) => p.u8.set(bytes, LDT + (sel & 0xfff8));
const code16 = (sel, base) => desc(sel, [0xff, 0xff, base & 0xff, (base >> 8) & 0xff, (base >> 16) & 0xff, 0xfb, 0x00, base >>> 24]);
code16(0x1f, AT); code16(0x27, AT + 0x100);
desc(0x2f, [0x10, 0x00, 0x27, 0x00, 0x06, 0xe4, 0x00, 0x00]);   // a 16-bit call gate to 0027:0010, six parameter words
const run = code => {
  p.u8.fill(0, AT, AT + 0x200); p.u8.set(code, AT);
  p.u8.set([0xb0, 0x55, 0xca, 0x02, 0x00], AT + 0x110);            // the callee: mov al, 55h; retf 2
  p.dynCache = new Map(); p.dynFast = new Map();
  p.cpu.cs.value = 0x1f; p.cpu.csb.value = AT; p.cpu.eax.value = 0; p.cpu.ssb.value = STACK; p.cpu.esp.value = 0x1000;
  let eip = AT; for (let k = 0; k < 8 && eip !== END; k++) eip = p.dynBlock(eip).run() >>> 0;
  return { eip, al: p.cpu.eax.value & 0xff, sp: p.cpu.esp.value & 0xffff, cs: p.cpu.cs.value & 0xffff };
};
const back = rel => [0xe9, ...new Uint8Array(new Int16Array([0x1000 - rel - 3]).buffer)];   // jmp near to END
// push 1234h; call far 002F:9999 (the gate; 9999h ignored); then on to the end
let r = run([0x68, 0x34, 0x12, 0x9a, 0x99, 0x99, 0x2f, 0x00, ...back(8)]);
assert.deepEqual(r, { eip: END, al: 0x55, sp: 0x1000, cs: 0x1f }, 'into the gate\'s target, back after the call, its parameter word removed');
// call far [bx] through a far pointer in memory to the gate
p.u8.set([0x99, 0x99, 0x2f, 0x00], STACK + 0x800); p.cpu.ds.value = 0; p.cpu.dsb.value = STACK; p.cpu.ebx.value = 0x800;
r = run([0x68, 0x34, 0x12, 0xff, 0x1f, ...back(5)]);
assert.deepEqual(r, { eip: END, al: 0x55, sp: 0x1000, cs: 0x1f }, 'through call far [mem]');
console.log('callgate: ok');
