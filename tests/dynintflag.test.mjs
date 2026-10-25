// Run-time translated code keeps the processor's interrupt flag: CLI clears cpu.if, STI sets it, PUSHF carries it
// (bit 9) and POPF takes it back, so the host can hold the hardware's interrupts while the code has them disabled
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const machine = code => {
  const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.mem = mem;
  Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
  p.cpu = {};
  for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
  p.ne = new Map([['X', { meta: { base: 0x200000, size: 0x1000 } }]]);
  p.trap = () => {};
  p.u8.set([...code, 0xe9, ...new Uint8Array(new Int32Array([0x300000 - (0x200000 + code.length + 5)]).buffer)], 0x200000);   // ... jmp 300000h
  p.cpu.esp.value = 0x8000;
  return p;
};
// cli: the flag clears; sti: it sets
{
  const p = machine([0xfa]); assert.equal(p.dynBlock(0x200000).run() >>> 0, 0x300000); assert.equal(p.cpu.if.value, 0);
  const q = machine([0xfb]); q.cpu.if.value = 0; q.dynBlock(0x200000).run(); assert.equal(q.cpu.if.value, 1);
}
// pushfd with interrupts disabled: bit 9 clear in the word pushed, bit 1 set as always; with them enabled: bit 9 set
{
  const p = machine([0xfa, 0x9c]); p.dynBlock(0x200000).run();
  const dv = new DataView(p.u8.buffer); assert.equal(dv.getUint32(0x7ffc, true) & 0x202, 0x002);
  const q = machine([0x9c]); q.dynBlock(0x200000).run();
  assert.equal(new DataView(q.u8.buffer).getUint32(0x7ffc, true) & 0x202, 0x202);
}
// popfd takes the flag from the word: a word with IF clear disables, one with it set enables
{
  const p = machine([0x9d]); new DataView(p.u8.buffer).setUint32(0x8000, 0x002, true); p.dynBlock(0x200000).run(); assert.equal(p.cpu.if.value, 0);
  const q = machine([0x9d]); q.cpu.if.value = 0; new DataView(q.u8.buffer).setUint32(0x8000, 0x202, true); q.dynBlock(0x200000).run(); assert.equal(q.cpu.if.value, 1);
}
