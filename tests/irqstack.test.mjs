// The VM's interrupt handler runs on a stack of its own: the stack the interrupted code was on (DIBENG's 40h-byte blit
// stack, its line count at SS:0) is not written, and the code's SS:ESP is as it was when the handler returns
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
window.AudioContext = class { constructor() { this.state = 'running'; } close() {} };
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

const p = Object.create(P), seen = [];
p.cpu = Object.fromEntries(['cf', 'pf', 'zf', 'sf', 'of', 'df', 'if', 'ss', 'ssb', 'esp'].map(n => [n, { value: n === 'if' ? 1 : 0 }]));
Object.assign(p, {
  dosVec: { [8 + 7]: 0x12340056 }, now: () => 0, tick16() {}, alloc: n => (n === 0x10000 ? 0x500000 : 0x600000),
  call16() { seen.push({ ss: p.cpu.ss.value, ssb: p.cpu.ssb.value, esp: p.cpu.esp.value >>> 0 }); },
});
// interrupted on DIBENG's stack: SS 2337h based at 1E00000h, ESP 3Ch
p.cpu.ss.value = 0x2337; p.cpu.ssb.value = 0x1e00000; p.cpu.esp.value = 0x3c;
assert.equal(p.raiseIRQ(7), true);
assert.equal(seen.length, 1);
assert.deepEqual(seen[0], { ss: 0, ssb: 0, esp: 0x500000 + 0x10000 - 16 });   // the interrupt stack (asInterrupt)
assert.equal(p.cpu.ss.value, 0x2337); assert.equal(p.cpu.ssb.value, 0x1e00000); assert.equal(p.cpu.esp.value, 0x3c);
console.log('irqstack: ok');
