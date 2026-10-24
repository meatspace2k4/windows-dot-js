// A mutex keeps out every thread but its owner: threads here are preempted between any two blocks, so one held by
// one thread is not signalled for another, a thread may take it again (recursively), only its owner releases it
// (ERROR_NOT_OWNER otherwise), and one whose owner ended is free. A wait on a handle nothing can wait on fails
// (WAIT_FAILED, ERROR_INVALID_HANDLE). Every such wait succeeded at once and ReleaseMutex kept no owner: two threads
// held one mutex together, and a wait on a bad handle reported success.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;
const K32 = API.KERNEL32, call = (p, n, ...a) => K32[n][1].apply(p, a);

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 16) };
p.handles = new Map(); p.nextHandle = 0x100;
const A = { id: 0x90, state: 'running' }, B = { id: 0x94, state: 'running' };
p.threadsById = new Map([[A.id, A], [B.id, B]]);
p.atThreadTop = () => false; p.inSystem = () => false;
const as = t => { p.thread16 = t; };

as(A); const m = call(p, 'CreateMutexA', 0, 1, 0);
assert.equal(call(p, 'WaitForSingleObject', m, 0), 0, 'its owner takes it again');
as(B); assert.equal(call(p, 'WaitForSingleObject', m, 0), 0x102, 'another thread times out');
assert.equal(call(p, 'ReleaseMutex', m), 0, 'and cannot release it'); assert.equal(p.lastError, 288);
as(A); assert.equal(call(p, 'ReleaseMutex', m), 1);
as(B); assert.equal(call(p, 'WaitForSingleObject', m, 0), 0x102, 'still held: taken twice, released once');
as(A); assert.equal(call(p, 'ReleaseMutex', m), 1);
as(B); assert.equal(call(p, 'WaitForSingleObject', m, 0), 0, 'free: B takes it');
as(A); assert.equal(call(p, 'WaitForSingleObject', m, 0), 0x102, 'and A is kept out');
B.state = 'done'; assert.equal(call(p, 'WaitForSingleObject', m, 0), 0, 'its owner ended: free');

assert.equal(call(p, 'WaitForSingleObject', 0xdead, 0), 0xffffffff, 'a handle that is no object: WAIT_FAILED');
assert.equal(p.lastError, 6);
const key = p.newHandle({ kind: 'key' });
assert.equal(call(p, 'WaitForSingleObject', key, 0), 0xffffffff, 'an object nothing waits on: WAIT_FAILED');
assert.equal(call(p, 'WaitForSingleObject', 0xfffffffe, 0), 0x102, 'the current thread\'s pseudo handle: never signalled to it');
const file = p.newHandle({ kind: 'file' });
assert.equal(call(p, 'WaitForSingleObject', file, 0), 0, 'a file: signalled, no I/O pending');
console.log('mutexwait: ok');
