// SleepEx alertable runs the thread's queued APCs and returns WAIT_IO_COMPLETION, as WaitForSingleObjectEx does: a
// wave's completion routine (itself an APC) that sleeps alertably for the buffers still to complete gets their APCs
// there instead of spinning forever (Empty Recycle Bin's sound hung the machine that way)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;
const [, sleepEx] = W.API.KERNEL32.SleepEx;

function machine() {
  const p = Object.create(P), calls = [], T = { id: 7, state: 'running', depth: 1 };
  Object.assign(p, {
    thread16: T, threadsById: new Map([[7, T]]), depth: 1, now: () => 1000,
    nativeUser16: () => true, currentThreadId: () => 7, atThreadTop: () => false,
    call(proc, args) { calls.push([proc, args[0]]); }, threads16() {},
  });
  return { p, calls, T };
}
// APCs queued: they run, in order, and the call returns WAIT_IO_COMPLETION without sleeping
{
  const { p, calls } = machine();
  p.queueApc(7, 0x1000, 11); p.queueApc(7, 0x2000, 22);
  assert.equal(sleepEx.call(p, 50, 1), 0xc0);
  assert.deepEqual(calls, [[0x1000, 11], [0x2000, 22]]);
  assert.equal(p.apcQ.get(7).length, 0);
}
// an APC that queues another to the same thread: the next alertable sleep runs that one
{
  const { p, calls } = machine();
  p.call = (proc, args) => { calls.push([proc, args[0]]); if (proc === 0x1000) p.queueApc(7, 0x3000, 33); };
  p.queueApc(7, 0x1000, 11);
  assert.equal(sleepEx.call(p, 50, 1), 0xc0); assert.deepEqual(calls, [[0x1000, 11]]);
  assert.equal(sleepEx.call(p, 50, 1), 0xc0); assert.deepEqual(calls, [[0x1000, 11], [0x3000, 33]]);
  assert.equal(sleepEx.call(p, 50, 1), 0, 'none left: a sleep inside a call returns at once');
}
// not alertable: the APCs stay queued and the sleep is an ordinary one
{
  const { p, calls } = machine();
  p.queueApc(7, 0x1000, 11);
  assert.equal(sleepEx.call(p, 50, 0), 0); assert.deepEqual(calls, []); assert.equal(p.apcQ.get(7).length, 1);
}
