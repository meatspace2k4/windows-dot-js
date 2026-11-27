// A Win32 thread whose PeekMessage finds nothing (USER's WIN32_OldYield, KERNEL.447) does not give its slice up there,
// after USER has looked at the queue: what PeekMessage then answered was the queue as it was before every other thread
// ran (SHELL32's icon thread took "no message" for idle after the desktop had posted it My Documents' icon, and threw
// the task away). It gives the slice up at its next PeekMessage, before USER looks (hookPeek32, endSlice); a third
// yield with no PeekMessage between gives it up in place, as a Win16 task's OldYield does
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, YIELD } = window.W95Win32, P = Process.prototype, K16 = window.W95NE16.K16;
const yield447 = K16['KERNEL.#447'][2], yield117 = K16['KERNEL.#117'][2];

// (another thread ready to run, one that yielded with nothing to wait for: the yields are for it)
const thread = (other = { id: 0x52, state: 'waiting' }) => { const t = { id: 0x66, depth: 0, state: 'running' }; return { t, p: { thread16: t, threadsById: new Map([[0x52, other], [0x66, t]]), depth: 0, asTask: false, inSystem: () => false, othersReady: P.othersReady, waitBlocked: () => false } }; };
// no other thread ready (the other waits on its event): the thread runs on, its slice ending when its time does. Given
// up, SETUPX's pass through its file queue, a PeekMessage an entry, took a step's rest each time ("Scanning ...")
{
  const { t, p } = thread({ id: 0x52, state: 'waiting', wait: { set: false } });
  for (let i = 0; i < 6; i++) assert.equal(yield447.call(p), undefined, 'nothing to give the slice to');
  assert.ok(!t.yielded);
  const b = thread({ id: 0x52, state: 'done' }); assert.equal(yield117.call(b.p), undefined);
  const m = thread({ id: 0x51, state: 'waiting' }); assert.equal(yield117.call(m.p), undefined, 'the main thread is not the pass\'s to run');
  const c = thread({ id: 0x52, state: 'waiting', wait: { set: false } }); c.p.host = { keyq: [1] }; assert.equal(yield117.call(c.p), YIELD, 'input waiting: the slice given up');
}
{
  const { t, p } = thread();
  assert.equal(yield447.call(p), undefined, 'the thread runs on'); assert.equal(t.peekOwed, 1);
  assert.equal(yield447.call(p), undefined); assert.equal(t.peekOwed, 2);
  assert.equal(yield447.call(p), YIELD, 'a third with no PeekMessage between: the slice given up here');
  assert.equal(yield447.call(p), undefined, 'the call made again as the thread resumes'); assert.ok(!t.yielded); assert.equal(t.peekOwed, 0);
  // a Win16 task's OldYield is as it was
  const b = thread(); assert.equal(yield117.call(b.p), YIELD); assert.equal(yield117.call(b.p), undefined);
}
// USER32's PeekMessage entered: the slice owed is given up before USER looks
{
  const { t, p } = thread(), hooks = new Map(); let ended = 0;
  p.setEntryHook = (at, fn) => hooks.set(at, fn); p.endSlice = () => { ended++; };
  P.hookPeek32.call(p, { exports: new Map([['PeekMessageA', 0x1000], ['PeekMessageW', 0x2000], ['GetMessageA', 0x3000]]) });
  assert.deepEqual([...hooks.keys()], [0x1000, 0x2000]);
  assert.equal(hooks.get(0x1000).call(p), undefined); assert.equal(ended, 0, 'nothing owed: PeekMessage runs');
  yield447.call(p); assert.equal(hooks.get(0x2000).call(p), undefined, 'USER32\'s own code goes on'); assert.equal(ended, 1); assert.equal(t.peekOwed, 0);
  hooks.get(0x2000).call(p); assert.equal(ended, 1, 'owed once');
  p.threadsById.get(0x52).wait = { set: false }; yield447.call(p); hooks.get(0x1000).call(p); assert.equal(ended, 1, 'no other thread ready: not given up');
}
// endSlice: the dispatcher's next question gives the processor back, the blocks left kept and no quantum counted
{
  const vclock = { now: 100, perTick: 5 }, p = { cpu: { budget: { value: 700 } }, host: { vclock }, runLevel: 1, yieldLevel: 1, noPreempt: false, now: () => 0, runT0: 0 };
  P.endSlice.call(p); assert.equal(p.cpu.budget.value, 0); P.endSlice.call(p);
  assert.equal(P.tick.call(p, 0x401000), 1); assert.equal(p.preempted, 0x401000); assert.equal(p.cpu.budget.value, 700); assert.equal(vclock.now, 100); assert.equal(p.sliceEnd, undefined);
  // inside a call the host made it runs on
  p.cpu.budget.value = 300; p.preempted = 0; p.runLevel = 2; P.endSlice.call(p);
  assert.equal(P.tick.call(p, 0x401000), 0); assert.equal(p.preempted, 0); assert.equal(p.cpu.budget.value, 300);
}
// a thread's last error is its own: kept with its context, put back as it runs again
{
  const p = { lastError: 2, saveFull: () => ({}), loadFull: () => {}, rebaseGlobals: () => {} };
  const c = P.saveCtx16.call(p); p.lastError = 87; P.loadCtx16.call(p, c); assert.equal(p.lastError, 2);
  p.lastError = 5; P.loadCtx16.call(p, {}); assert.equal(p.lastError, 5, 'a context from before it was kept: left');
}
console.log('peekyield: ok');
