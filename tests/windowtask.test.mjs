// The hit test the host makes for a press (strokeTarget's WM_NCHITTEST) into a window of a Windows 3.x task: made
// from the system's context, USER sends it to the task's queue as a record the task's own loop answers, and the
// host's call ran on past it. The record stayed on SUWIN's queue through Windows 98 Setup's saving of the system
// files, the next press linked it again, and the GetMessage that took it read a message to window 0 (whose procedure
// is 0:FFFE). Run as the task's thread, the message ran on a stack of the call's own, and a Windows 3.x window
// procedure takes DS from SS: COMMCTRL's ran for good. So: (1) windowTask16 names the task's thread for a window of
// no started process, and none for a process's window or an ended task's. (2) threadAtLoop: a thread waiting for
// input at its loop (processIdle's test). (3) The hit test into a Windows 3.x task's window is USER's default
// procedure's answer, from the host's own context, whatever the task is doing; a process's window goes as before,
// as its main thread.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

const machine = (task, threads, procs) => {
  const p = Object.create(P);
  Object.assign(p, { thread16: null, depth: 0, imgUse() {}, procs: new Map(procs.map(x => [x.pid, x])), threadsById: new Map(threads.map(t => [t.id, t])), user16: () => ({ ax: task }) });
  return p;
};
// (1) the task's thread, not one that ended; none for a process's window
{
  const suwin = { id: 119, state: 'waiting', task: { dgStack: true }, tdb: 0x46f7 }, done = { id: 118, state: 'done', task: {}, tdb: 0x46f7 };
  assert.equal(machine(0x46f7, [done, suwin], []).windowTask16(0x210), suwin);
  const main = { id: 85, state: 'waiting' }, pc = { pid: 0x60, tdb: 0x3907, main }; main.pc = pc;
  assert.equal(machine(0x3907, [main], [pc]).windowTask16(0x300), null);
  assert.equal(machine(0x4117, [{ id: 113, state: 'done', task: {}, tdb: 0x4117 }], []).windowTask16(0x400), null);
  assert.equal(machine(0, [suwin], []).windowTask16(0x500), null);
}
// (2) at its loop: WaitEvent slept, or a wait on its queue alone; not with its slice over, nor a wait on an object
{
  const p = Object.create(P);
  assert.equal(p.threadAtLoop({ state: 'waiting', slept: true }), true);
  assert.equal(p.threadAtLoop({ state: 'waiting', waitOn: { msg: true, hs: [] } }), true);
  assert.equal(p.threadAtLoop({ state: 'waiting', preempted: true, slept: true }), false);
  assert.equal(p.threadAtLoop({ state: 'running' }), false);
  assert.equal(p.threadAtLoop({ state: 'waiting', waitOn: { msg: true, hs: [1] } }), false);
  assert.equal(p.threadAtLoop({ state: 'waiting' }), false);
}
// (3) strokeTarget's hit test: who answers, and as whom
{
  const run = (task, threads, procs) => {
    const calls = [], p = machine(task, threads, procs);
    p.user16 = (o, args) => { calls.push([o, p.thread16, p.asTask]); return { ax: o === 30 ? 0x210 : o === 224 ? task : o === 111 || o === 107 ? 1 : 0, dxax: 0 }; };   // WindowFromPoint, GetWindowTask, the hit test HTCLIENT, else 0
    p.windowRect = () => ({ x: 1, y: 2 }); p.wbufLin = 0; p.wbufSel = 0; p.readA = () => '';
    const r = p.strokeTarget(10, 10);
    return { r, hit: calls.find(c => c[0] === 111 || c[0] === 107) };
  };
  const suwin = { id: 119, state: 'waiting', slept: true, task: { dgStack: true }, tdb: 0x46f7 };
  let { r, hit } = run(0x46f7, [suwin], []);
  assert.equal(r.hwnd, 0x210); assert.deepEqual(hit, [107, null, undefined], 'at its loop: the default procedure, from the host');
  const busy = { id: 119, state: 'waiting', preempted: true, task: { dgStack: true }, tdb: 0x46f7 };
  ({ hit } = run(0x46f7, [busy], []));
  assert.deepEqual(hit, [107, null, undefined], 'stopped elsewhere: the same');
  const main = { id: 85, state: 'waiting', slept: true }, pc = { pid: 0x60, tdb: 0x3907, main }; main.pc = pc;
  ({ hit } = run(0x3907, [main], [pc]));
  assert.deepEqual(hit, [111, main, true], 'a process\'s window: as its main thread');
}
console.log('windowtask: ok');
