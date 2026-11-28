// A mutex is a waitable (ne16.js ev16): signalled while no thread owns it or for its owner, a wait it satisfies making
// the waiter its owner, ReleaseMutex counting down and freeing it. USER's MsgWaitForMultipleObjects (KERNEL #461) never
// saw a free one: ACME's ACMSETUP waited for good on IE4MUTEX, and Internet Explorer 4's setup stopped at 55%
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, K = API.KERNEL32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x10000) };
p.handles = new Map(); p.nextHandle = 0x100;
p.writeA(0x100, 'IE4MUTEX');
const t1 = { id: 0x70 }, t2 = { id: 0x71 };
p.thread16 = t1;
const h = K.CreateMutexA[1].call(p, 0, 0, 0x100);
const wait = () => K.WaitForSingleObject[1].call(p, h, 0);
assert.equal(wait(), 0, 'a free mutex: the wait is satisfied at once');
assert.equal(wait(), 0, 'its owner waits again: counted, not blocked');
p.thread16 = t2;
assert.equal(wait(), 0x102, 'another thread: not signalled while owned');
assert.equal(K.ReleaseMutex[1].call(p, h), 0, 'not the owner: ReleaseMutex fails');
p.thread16 = t1;
assert.equal(K.ReleaseMutex[1].call(p, h), 1); assert.equal(K.ReleaseMutex[1].call(p, h), 1, 'released as many times as taken');
p.thread16 = t2;
assert.equal(wait(), 0, 'free again: the other thread takes it');
// (CreateMutex owned: the creator its owner)
p.writeA(0x140, 'OWNED'); p.thread16 = t1;
const h2 = K.CreateMutexA[1].call(p, 0, 1, 0x140);
p.thread16 = t2; assert.equal(K.WaitForSingleObject[1].call(p, h2, 0), 0x102, 'owned at creation');
console.log('mutexwait: ok');
