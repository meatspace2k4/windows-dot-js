// The 8254 timer and port 61h (ne16.js pitIO), as Windows 98 Setup times its CPU with channel 2: gate off, mode 0 with
// FFFFh loaded, gate on, the work, gate off, a read-back of channel 2's status and count; the counts gone are the
// clock's, 1.193182 a microsecond, and held while the gate is off. Channel 0 a mode 3 square wave, read through a latch
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const p = Object.create(window.W95Win32.Process.prototype);
let t = 1000; p.host = { now: () => t };
p.cpu = { eax: { value: 0 } };
const out = (port, v) => { p.cpu.eax.value = v; assert.equal(p.pitIO(port, 1, false), true); };
const inp = port => { p.cpu.eax.value = 0xabcd00; assert.equal(p.pitIO(port, 1, true), true); assert.equal(p.cpu.eax.value >>> 8, 0xabcd, 'AL only'); return p.cpu.eax.value & 0xff; };
assert.equal(p.pitIO(0x60, 1, true), false, 'not the timer\'s');
out(0x61, inp(0x61) & 0xfe); out(0x43, 0xb0); out(0x42, 0xff); out(0x42, 0xff);
t += 5; out(0x61, inp(0x61) | 1);                  // (the time before the gate opens is not counted)
t += 2;                                             // 2 ms: 2386 counts
out(0x61, inp(0x61) & 0xfe); t += 7;                 // (nor after it closes)
out(0x43, 0xc8);
const status = inp(0x42), count = inp(0x42) | inp(0x42) << 8;
assert.equal(status & 0x80, 0, 'OUT still low: not at zero');
assert.equal((status >> 1) & 7, 0, 'mode 0'); assert.equal((status >> 4) & 3, 3, 'low then high byte');
assert.equal(0xffff - count, Math.floor(2 * 1193.182), 'the counts gone while the gate was open');
// channel 0, mode 3 from 10000h: the latched count goes down by two, and reads low then high
out(0x43, 0x36); out(0x40, 0); out(0x40, 0); t += 10;
out(0x43, 0x00); const c0 = inp(0x40) | inp(0x40) << 8;
assert.equal(c0, (0x10000 - 2 * Math.floor(10 * 1193.182)) & 0xfffe);
// the clock to the block: within a quantum of the machine's clock (perTick a BUDGET blocks), the blocks run since its
// last tick count (the budget gone). Timed by the quantum alone, Setup's few thousand blocks read no time or a whole one
{
  const q = Object.create(window.W95Win32.Process.prototype), vclock = { now: 50, perTick: 0.25 };
  q.host = { now: () => vclock.now, vclock }; q.cpu = { eax: { value: 0 }, budget: { value: 0x1000 } };
  const o = (port, v) => { q.cpu.eax.value = v; q.pitIO(port, 1, false); }, i = port => { q.cpu.eax.value = 0; q.pitIO(port, 1, true); return q.cpu.eax.value & 0xff; };
  o(0x61, 0); o(0x43, 0xb0); o(0x42, 0xff); o(0x42, 0xff); o(0x61, 1);
  q.cpu.budget.value -= 0x800;                         // half a quantum's blocks: 0.125 ms, 149 counts
  o(0x61, 0); o(0x43, 0xc8); i(0x42);
  assert.equal(0xffff - (i(0x42) | i(0x42) << 8), Math.floor(0.125 * 1193.182), 'half a quantum, counted');
}
console.log('pit: ok');
