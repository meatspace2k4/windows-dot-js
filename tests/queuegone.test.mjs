// a thread that ends with another thread's SendMessage to its queue waiting: the send is answered (0, replied) and the
// sender woken as USER's SetWakeBit2 wakes a queue, as USER answers them when a queue goes (Display Properties waited
// for good on a screen saver preview's queue)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const buf = new ArrayBuffer(0x10000), u8 = new Uint8Array(buf), dv = new DataView(buf);
const base = { 0x30: 0x8000, 0x40: 0x1000, 0x48: 0x2000 }, ev = { kind: 'event', set: false };   // USER's data, the sender's queue, the receiver's
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: u8 });
Object.assign(p, {
  selValid: s => s in base, selBase: s => base[s], r16: a => dv.getUint16(a, true), w16: (a, v) => dv.setUint16(a, v, true),
  r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), obj: h => (h === 77 ? ev : null), signal(e) { e.set = true; },
  ne: new Map([['USER', { segs: [{ num: 32, sel: 0x30 }], meta: { autodata: 32 } }]]),   // (USER's DGROUP, its autodata: Windows 95's segment 32)
});
const sender = { id: 1, state: 'waiting', queue: 0x40 }, receiver = { id: 2, state: 'done', queue: 0x48 };
p.threadsById = new Map([[1, sender], [2, receiver]]);
const rec = 0x200;
p.w16(0x1000 + 0x4e, rec); p.w16(0x1000 + 0x4c, 0x8840); p.w32(0x1000 + 0xc, 77);   // waiting on its send, its event
p.w16(0x8000 + rec + 0x12, 0x48); p.w32(0x8000 + rec + 0x20, 0x1234); u8[0x8000 + rec + 0x24] = 0x1a;
p.wakeWaiters(receiver);
assert.equal(u8[0x8000 + rec + 0x24] & 1, 1, 'replied');
assert.equal(p.r32(0x8000 + rec + 0x20), 0, 'answered 0');
assert.equal(p.r16(0x1000 + 0x48) & 0x8000, 0x8000, 'QS_SMRESULT');
assert.equal(p.r16(0x1000 + 0x4c), 0, 'mask cleared');
assert.equal(ev.set, true, 'woken');
// a send to another queue is left alone
u8[0x8000 + rec + 0x24] = 0x1a; p.w16(0x1000 + 0x4c, 0x8840); p.w16(0x8000 + rec + 0x12, 0x50); ev.set = false;
p.wakeWaiters(receiver);
assert.equal(u8[0x8000 + rec + 0x24] & 1, 0); assert.equal(ev.set, false);
// a send made to a queue no thread that goes on has (its thread ended before the send): answered as the sender waits
p.thread16 = sender; p.sendToGone();
assert.equal(u8[0x8000 + rec + 0x24] & 1, 1); assert.equal(ev.set, true);
// one to a live thread's queue waits on
u8[0x8000 + rec + 0x24] = 0x1a; p.w16(0x1000 + 0x4c, 0x8840); p.w16(0x8000 + rec + 0x12, 0x48); receiver.state = 'waiting'; ev.set = false;
p.sendToGone();
assert.equal(u8[0x8000 + rec + 0x24] & 1, 0); assert.equal(ev.set, false);
console.log('queuegone: ok');
