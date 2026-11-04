// An MS-DOS VM's events (vmm.js vmEventRun): SHELL holds a VM while WinOldAp grabs its screen, with a priority VM event
// whose callback blocks (_BlockOnID) until WinOldAp's next SHELL call releases it (SHELL 1:1154B, 1:1158C)
// - started by the host, the event is a ring-0 run that can stop: it waits there and the system goes on (run inside a
//   call it could not stop, and the wait was a ring-0 deadlock that froze the system)
// - inside a call it waits in the queue for the host's turn, and a ring-0 wait's pump leaves it there
// - the worker's step goes on while such a run waits (it ran nothing but the wait, and the release never came)
// - an event of a VM that has ended is dropped with it, never run as the system VM's (typing ended MEM, and its hold
//   ran as the system's, waiting for a release that never came)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map(); p.init16();
p.fixedDisk = () => {}; p.vmToClient = () => {}; p.vmFromClient = () => {}; p.vmBroadcast = () => true; p.sysVM = () => 1;
p.asInterrupt = fn => fn(); p.depth = 0; p.runLevel = 0;
const started = [], called = [];
p.r0Start = (fn, regs, vm) => { started.push({ fn, vm }); (p.r0Runs || (p.r0Runs = [])).push({ vm, wait: true, stack: 0 }); return null; };
p.vxdCall = (fn) => { called.push(fn); return {}; };

const h = p.vmCreate({}), vm = p.vmOf(h), hold = { fn: 0x2157e, ref: 0, handle: 7, vm: h };

// inside a call: queued for the host's turn, not run
p.depth = 1; p.vxdEvents = [hold]; p.vmEventRun(vm, hold);
assert.ok(p.vxdEvents.includes(hold) && !started.length && !called.length, 'kept in the queue, nothing run');
// a ring-0 wait's pump leaves an MS-DOS VM's event queued (and reports nothing run for it)
p.vxdEvents = [hold]; p.r0Pump && p.r0Pump();
assert.ok(p.vxdEvents.includes(hold) && !called.length, 'the pump leaves it');

// the host's turn: started as a ring-0 run that can stop, in that VM
p.depth = 0; p.vxdEvents = [hold]; p.vxdRunEventsIn();
assert.equal(started.length, 1, 'started once'); assert.equal(started[0].vm, vm, 'as that VM'); assert.equal(called.length, 0, 'not inside a call');
assert.ok(p.r0Runs.every(s => s.vm && s.wait), 'it waits, holding that VM only');

// the VM's program ends: its events go with it, queued or waiting, and one for it later is never run
p.vxdEvents = [{ ...hold, handle: 8 }];
p.vmEnd(vm);
assert.equal(p.vxdEvents.length, 0, 'queued: dropped'); assert.equal(p.r0Runs.length, 0, 'waiting: dropped');
p.vxdEvents = [{ ...hold, handle: 9 }]; p.vxdRunEventsIn();
assert.equal(called.length, 0, 'not run as the system VM\'s'); assert.equal(started.length, 1, 'not started');
console.log('vmevents: ok');
