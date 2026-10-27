// a call the host makes as another thread (asThread: a shared session's window placed, a control set, as the window's
// task) is never that thread's top level, and leaves the thread's own depth as it was: a wait inside it lets the other
// threads run instead of stopping the call as if it were the thread (Explorer's tray thread then slept for good in the
// host's call, the Start button and the task buttons never painted again)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, YIELD } = window.W95Win32, P = Process.prototype;
const { K16 } = window.W95NE16;

const t = { id: 91, depth: 2, state: 'waiting' };
// the thread itself at its top level
{
  const p = Object.create(P); p.thread16 = t; p.depth = 2;
  assert.equal(p.atThreadTop(), true);
}
// as the thread, from the host: never its top level, at any depth, and its depth kept through a call made as it
{
  const p = Object.create(P); p.thread16 = null; p.depth = 1; p.imgUse = () => {};
  let top, depthIn;
  p.asThread(t, () => {
    p.depth = 2; top = p.atThreadTop();
    // (what start16 does on entering 16-bit code)
    p.depth++; if (p.thread16 && !p.asTask) p.thread16.depth = p.depth; depthIn = t.depth;
  });
  assert.equal(top, false); assert.equal(depthIn, 2); assert.equal(t.depth, 2);
  assert.equal(p.thread16, null); assert.equal(p.asTask, false);
}
// start16 itself leaves it alone
{
  const src = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
  assert.match(src, /this\.depth\+\+; if \(this\.thread16 && !this\.asTask\) this\.thread16\.depth = this\.depth;/);
  // and the other threads a wait inside it runs (threads16) run as themselves, at their own top levels
  assert.match(src, /this\.threadsNest = \(this\.threadsNest \|\| 0\) \+ 1; this\.asTask = false;/);
  assert.match(src, /this\.threadsNest--; this\.asTask = wasAs;/);
}
// a wait for an event not set, inside a call made as the thread: the others get their turn and the wait times out
// there, instead of giving up the thread's slice (YIELD) from inside the host's call
{
  const p = Object.create(P), ev = { kind: 'event', set: false };
  let turns = 0;
  Object.assign(p, { depth: 2, imgUse() {}, obj: h => (h === 5 ? ev : null), threads16() { turns++; }, threadsById: new Map(), now: () => 0 });
  const wait = K16['KERNEL.#460'][2];
  let r; p.asThread(t, () => { r = wait.call(p, 5, 0xffffffff); });
  assert.notEqual(r, YIELD); assert.equal(r, 0x102); assert.equal(turns, 1);
}
console.log('asthread: ok');
