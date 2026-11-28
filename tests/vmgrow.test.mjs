// A machine's memory grows on demand (win32.js vmFit, up to vmMax): a reservation past the memory's end is room from
// the top, the memory grown to hold it. Fixed at its first size, WINHLP32's heap, which doubles its reservation as it
// grows, found no room, and copied into address 0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = new WebAssembly.Memory({ initial: 4, maximum: 512, shared: true });
Object.assign(p, { vmLo: 0x20000, vmTop: 0x20000, vmMax: 512 * 0x10000, memoSpans: () => [], vmCheck: b => b, vmAudit() {}, alloc() { throw new window.W95Win32.GuestError('out of memory'); }, whereOf: () => '?', reg: () => 0x100, r32: () => 0, modules: [] });
const b = API.KERNEL32.VirtualAlloc[1].call(p, 0, 0x800000, 0x2000);
assert.ok(b >= 0x20000 && b % 0x10000 === 0, `the reservation: ${b.toString(16)}`);
assert.ok(p.mem.buffer.byteLength >= b + 0x800000, 'the memory grown to hold it');
p.u8[b + 0x7fffff] = 1;
assert.equal(API.KERNEL32.VirtualAlloc[1].call(p, 0, 0x4000000, 0x2000), 0, 'past vmMax: no room');
console.log('vmgrow: ok');
