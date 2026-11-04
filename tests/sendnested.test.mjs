// A call the host made (no thread) that waits on an object inside a call (KERNEL.460 WaitForSingleObject below a
// thread's top: USER's SendMessage waiting for its reply) gives the other threads turns until the object is set, up to
// 64, as the sender blocks on Windows. Given one turn, the receiving thread had not yet taken the message, the call
// came back unanswered, USER freed the message's record while the receiver's queue still held it, and Explorer later
// called through what took the memory ("invalid page fault at 0002:3B08" after Windows 98 Setup's ScanDisk).
// A thread's own nested wait keeps its one turn.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { K16 } = window.W95NE16, wait = K16['KERNEL.#460'][2];
const mk = (setAt, thread) => {
  const e = { kind: 'event', set: false, manual: false }, p = { thread16: thread, depth: 3, asTask: false, turns: 0 };
  p.obj = () => e; p.atThreadTop = () => false; p.inSystem = () => false; p.threadsById = new Map();
  p.threads16 = () => { if (++p.turns === setAt) e.set = true; };
  p.waitNested = function (done) { if (!done()) this.threads16(true); };
  return { p, e };
};
// the host's wait: the third turn sets it, and the wait ends with it (0), the event taken
{ const { p, e } = mk(3, null); assert.equal(wait.call(p, 1, 0xffffffff), 0); assert.equal(p.turns, 3); assert.equal(e.set, false, 'an auto-reset event taken'); }
// never set: 64 turns past the first, then the time-out, as before
{ const { p } = mk(0, null); assert.equal(wait.call(p, 1, 0xffffffff), 0x102); assert.equal(p.turns, 65); }
// a receiver busy in a long run of its own: the turns end after 200 ms of the machine's time
{ const { p } = mk(0, null); const t = globalThis.performance.now; let now = 0; globalThis.performance.now = () => (now += 60); try { assert.equal(wait.call(p, 1, 0xffffffff), 0x102); assert.ok(p.turns < 10, 'few turns: ' + p.turns); } finally { globalThis.performance.now = t; } }
// a thread's own nested wait: one turn, as it was
{ const t = { id: 7, depth: 1 }; const { p } = mk(3, t); assert.equal(wait.call(p, 1, 0xffffffff), 0x102); assert.equal(p.turns, 1); }
// ms 0: no turn at all
{ const { p } = mk(1, null); assert.equal(wait.call(p, 1, 0), 0x102); assert.equal(p.turns, 0); }
console.log('sendnested: ok');
