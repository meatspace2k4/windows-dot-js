// a wait inside a call (Sleep, a Win32 wait, a Yield: threads16 nested) lets the sound card run and interrupt as the
// clock on the wall says, as the host does between slices: a wait on a wave's end made inside a call ends
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;

function machine() {
  const p = Object.create(P);
  const A = { id: 7, state: 'running', depth: 2, pc: null };
  Object.assign(p, {
    threadsById: new Map([[7, A]]), thread16: A, inThreads: true, depth: 2, stackLevel: 3, preempted: 0, runT0: 500, played: 0,
    now: () => 1000, cpu: { eip: { value: 0 } }, imgUse() {}, holdWin16() {}, wakeWaiters() {},
    saveCtx16() { return {}; }, loadCtx16() {}, sound16() { this.played++; },
  });
  return { p, A };
}
// a nested pass lets the card run, even with nothing else to run and however deep the nesting
{
  const { p } = machine();
  p.threads16(true); assert.equal(p.played, 1);
  p.threadsNest = 4; p.threads16(true); assert.equal(p.played, 2);
  p.threadsById = null; p.threads16(true); assert.equal(p.played, 3);
}
// the host's pass between slices does not: the host runs the card itself after it
{
  const { p } = machine();
  p.thread16 = null; p.depth = 0; p.threads16(); assert.equal(p.played, 0);
}
// Sleep inside a call (not at the thread's top level) goes through the nested pass: the card runs there
{
  const { p } = machine();
  p.atThreadTop = () => false;
  const [, sleep] = W.API.KERNEL32.Sleep;
  assert.equal(sleep.call(p, 10), 0); assert.equal(p.played, 1);
}
// a Win32 wait inside a call on an event nothing sets: the card runs, the wait times out
{
  const { p } = machine();
  p.atThreadTop = () => false; p.nativeUser16 = () => true; p.currentThreadId = () => 7;
  const ev = { kind: 'event', set: false, manual: false }; p.obj = () => ev; p.handles = new Map([[0x44, ev]]);
  const [, wait] = W.API.KERNEL32.WaitForSingleObject;
  assert.equal(wait.call(p, 0x44, 10), 0x102); assert.equal(p.played, 1);
}
