// A VxD event's handle is the event's own (vmm.js Schedule_Global_Event, Schedule_VM_Event): Cancel_Global_Event of
// it cancels that event and no other, however the queue has moved since. The handle was the event's place in the
// queue: a cancel took whichever event was there then, another device's, and the cancelled one ran on a record its
// owner had freed (Windows 95 OSR 2.5 Setup, after User Information: IFSMgr's event called a handler from a freed
// VREDIR record, a fatal exception 06)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const SVC = window.W95NE16.VXD_SVC, p = { cpu: {} };
for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi']) p.cpu[r] = { value: 0 };
const call = (n, regs) => { for (const [k, v] of Object.entries(regs)) p.cpu[k].value = v; SVC[1 << 16 | n].call(p); return p.cpu.esi.value >>> 0; };

const a = call(0x0e, { esi: 0x1000, edx: 0xa });            // Schedule_Global_Event
const b = call(0x0f, { esi: 0x2000, edx: 0xb, ebx: 5 });    // Schedule_VM_Event
const c = call(0x14, { esi: 0x3000, edx: 0xc, ebx: 1 });    // Call_Priority_VM_Event
assert.equal(new Set([a, b, c]).size, 3, 'each its own handle');
p.vxdEvents.shift();                                         // (the first run: the queue moved)
call(0x12, { esi: b });                                      // Cancel_Global_Event of the second
assert.deepEqual(p.vxdEvents.map(e => e.fn), [0x3000], 'that event cancelled, the other kept');
call(0x12, { esi: a });                                      // a handle whose event already ran
assert.deepEqual(p.vxdEvents.map(e => e.fn), [0x3000], 'nothing else cancelled');
console.log('globaleventhandle: ok');
