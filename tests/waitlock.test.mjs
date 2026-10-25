// A thread that stops in a wait lets the Win16Lock go, even when its time ran out earlier in the same run (inside a call
// that could not stop): the scheduler does not run a blocked thread, so a lock it kept was never released
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

function machine(run) {
  const p = Object.create(P), t = { id: 7, state: 'waiting', ctx: {}, depth: 0 };
  Object.assign(p, {
    threadsById: new Map([[7, t]]), thread16: null, depth: 0, win16Held: null, preempted: 0, sysLevel: 0, runT0: 0,
    cpu: { cs: { value: 0x1407 }, eip: { value: 0 } }, now: () => 1000,
    saveCtx16: () => ({}), loadCtx16() {}, imgUse() {}, saveFull: () => ({}), loadFull() {},
    runTop() { return run(p, t); },
  });
  return { p, t };
}
// time runs out inside a call, then the thread blocks in a wait at its top (the wait's YIELD): no lock kept
{
  const { p, t } = machine((q, th) => { q.preempted = 1; th.blocked = true; q.preempted = 0; return 1; });
  p.threads16();
  assert.equal(p.win16Held, null); assert.equal(t.blocked, true); assert.equal(t.preempted, false);
}
// a wait left `wake` set, then time runs out in 16-bit code (DIBENG's blit): the lock is kept, or another thread blits
// on DIBENG's one blit stack and this one's line count goes from 0
{
  const { p, t } = machine((q, th) => { th.wake = 5000; q.preempted = 1; return 1; });
  p.threads16();
  assert.equal(p.win16Held && p.win16Held.who, t); assert.equal(t.preempted, true);
}
// time runs out in 16-bit code with no wait: the lock is kept until the thread goes on
{
  const { p, t } = machine(q => { q.preempted = 1; return 1; });
  p.threads16();
  assert.equal(p.win16Held && p.win16Held.who, t); assert.equal(t.preempted, true);
}
console.log('waitlock: ok');
