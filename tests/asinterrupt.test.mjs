// An interrupt the host runs in the middle of a thread's run (ne16.js asInterrupt: the input poll, the VMM's
// time-outs, at the dispatcher's budget check) leaves the interrupted code's registers and flags as they were, as FLAGS
// on the stack and IRET give them back. Kept only SS:ESP, a handler's flags reached the jump after a CMP in the next
// block: PIDGEN's binary GCD (Windows 98 Setup's product key) ran past x = y to x = 0 and never ended
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.alloc = () => 0x600000;
const before = { eax: 0x1234, ebx: 0x5678, cf: 1, zf: 0, sf: 1, of: 0, pf: 1, df: 0, ss: 0x27, ssb: 0x300000, esp: 0xd0d8, ds: 0x2f, es: 0x37 };
for (const [k, v] of Object.entries(before)) p.cpu[k].value = v;
let inside = null;
p.asInterrupt(() => {
  inside = { ss: p.cpu.ss.value, ifl: p.cpu.if.value };
  // (a handler that leaves its own registers and flags behind)
  for (const k of ['eax', 'ebx']) p.cpu[k].value = 0xdead; for (const f of ['cf', 'zf', 'sf', 'of', 'pf', 'df']) p.cpu[f].value ^= 1; p.cpu.ds.value = 0x47; p.cpu.esp.value -= 0x40;
});
assert.deepEqual(inside, { ss: 0, ifl: 0 }, 'the handler runs on the interrupt stack, interrupts off');
for (const [k, v] of Object.entries(before)) assert.equal(p.cpu[k].value, v, `${k} as the interrupted code left it`);
assert.equal(p.cpu.if.value, 1, 'IF back on');
console.log('asinterrupt: ok');
