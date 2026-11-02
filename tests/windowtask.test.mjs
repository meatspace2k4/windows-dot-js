// A call the host makes for a window (asWindowTask: the hit test for a press, a control set) runs as the task that
// owns the window, a Windows 3.x task's own thread as much as a started process's main thread: made from the
// system's context, USER sends it to the task's queue as a record the task answers only when it runs, and the
// host's call ran on past it. The record stayed on SUWIN's queue through Windows 98 Setup's saving of the system
// files, the next press linked it again, and the GetMessage that took it read a message to window 0 (whose
// procedure is 0:FFFE). (1) A window of a Win16 task: as that task's thread. (2) A window of a started process:
// as its main thread, as before. (3) A window of no live task: on the host's own context.
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
// (1) a Win16 task's window: the call runs as the task's thread, and the thread is given back after
{
  const suwin = { id: 119, state: 'waiting', task: { dgStack: true }, tdb: 0x46f7, depth: 1 }, done = { id: 118, state: 'done', task: {}, tdb: 0x46f7 };
  const p = machine(0x46f7, [done, suwin], []);
  let as; const r = p.asWindowTask(0x210, () => { as = p.thread16; return 7; });
  assert.equal(r, 7); assert.equal(as, suwin, 'as the task\'s own thread, not one that ended'); assert.equal(p.thread16, null); assert.equal(p.asTask, false);
}
// (2) a started process's window: as its main thread
{
  const main = { id: 85, state: 'waiting', pc: null }, pc = { pid: 0x60, tdb: 0x3907, main }; main.pc = pc;
  const p = machine(0x3907, [main], [pc]);
  let as; p.asWindowTask(0x300, () => { as = p.thread16; });
  assert.equal(as, main);
}
// (3) no live task owns it: the host's own context
{
  const p = machine(0x4117, [{ id: 113, state: 'done', task: {}, tdb: 0x4117 }], []);
  let as = 'unset'; p.asWindowTask(0x400, () => { as = p.thread16; });
  assert.equal(as, null);
}
console.log('windowtask: ok');
