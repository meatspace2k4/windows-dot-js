// a program's clock in a shared session (ne16.js startClock, win32.js clockOf): one started here for the session reads
// the clock of the machine that started it, as of its start there, so the seed it takes from the time is the one it
// took there; one started here of itself reads this machine's own. USER's GetTickCount answered for such a program
// where another module enters it (clockCall); for a program on this machine's clock, USER answers
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype, API = W.API;
const machine = (now, t0) => { const p = Object.create(P); Object.assign(p, { host: { now: () => now.v }, t0, thread16: null }); return p; };

// Ann's machine starts Solitaire of itself: its own clock, no offsets
const annNow = { v: 50000 }, ann = machine(annNow, 1000);
const a = ann.startClock();
assert.equal(a.clock, null); assert.equal(a.t0.tick, 50000 - 1000 + 3600000);
ann.thread16 = { pc: a };
const tickA = API.KERNEL32.GetTickCount[1].call(ann);
assert.equal(tickA, a.t0.tick);

// Bob's machine, up longer and later by 7 s, starts it for the session with Ann's t0: the same first reading
const bobNow = { v: 900000 }, bob = machine(bobNow, 2000);
bob.nextClock = a.t0; const b = bob.startClock();
assert.equal(bob.nextClock, null, 'taken by the one program it was for');
assert.deepEqual(b.t0, a.t0);
bob.thread16 = { pc: b };
assert.equal(API.KERNEL32.GetTickCount[1].call(bob), tickA);
bobNow.v += 250; assert.equal(API.KERNEL32.GetTickCount[1].call(bob), (tickA + 250) >>> 0, 'and runs on from there');
// the wall clock: the start's, there
const st = 0x100, mem = new Uint8Array(0x200), dv = new DataView(mem.buffer);
Object.defineProperty(bob, 'u8', { value: mem }); bob.w16 = (p, v) => dv.setUint16(p, v, true);
b.clock.wall -= 3 * 3600000;   // (as if Ann's wall clock were three hours behind Bob's)
API.KERNEL32.GetSystemTime[1].call(bob, st);
assert.equal(dv.getUint16(st + 8, true), new Date(Date.now() - 3 * 3600000).getUTCHours());
// a Win16 task (Solitaire): its task carries the clock
bob.thread16 = { pc: null, task: { clock: b.clock } };
assert.equal(bob.clockOf(), b.clock);

// USER's GetTickCount and GetCurrentTime for such a program: answered, DX:AX, and returned from
{
  let eax = 0, edx = 0;
  Object.assign(bob, { cpu: { eax: { get value() { return eax; }, set value(v) { eax = v >>> 0; } }, edx: { get value() { return edx; }, set value(v) { edx = v >>> 0; } } },
    retf16: () => 0x1234 });
  assert.equal(P.clockCall.call(bob), 0x1234);
  assert.equal(((edx & 0xffff) << 16 | (eax & 0xffff)) >>> 0, (tickA + 250) >>> 0);
  bob.thread16 = { pc: { clock: null } };
  assert.equal(P.clockCall.call(bob), undefined, 'this machine\'s own clock: USER answers');
}
console.log('clock: ok');
