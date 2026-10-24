// a task started from a thread (MMSYSTEM's PlaySound starting MMTASK with LoadModule) runs inside its creator's run,
// until it first waits, with a slice of its own; the creator's run then goes on as it was
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

function machine() {
  const p = Object.create(P), used = [];
  const A = { id: 7, state: 'running', depth: 2, pc: { exe: { inst: null } } }, B = { id: 8, state: 'new', task: { psp: 0x100, hInst: 0x200, stack: 0x1000, heap: 0x400, dgroup: 0x300 }, start: 0x12340000, stack: 0x4000 };
  let clock = 1000;
  Object.assign(p, {
    threadsById: new Map([[7, A], [8, B]]), thread16: A, inThreads: true, depth: 2, stackLevel: 3, preempted: 0, runT0: 500,
    now: () => clock++, cpu: Object.fromEntries(['esp', 'ssb', 'edi', 'esi', 'ebx', 'ecx', 'eax', 'edx'].map(r => [r, { value: 0 }])), seg() {}, alloc: () => 0x8000, imgUse: pc => used.push(pc), wakeWaiters() {},
    saveCtx16() { return { depth: this.depth, stackLevel: this.stackLevel }; }, loadCtx16(c) { this.depth = c.depth; this.stackLevel = c.stackLevel; },
    holdWin16() {}, ran: 0,
    start16() { this.ran++; this.depth = 1; this.preempted = 0x999; B.slept = true; return 1; },   // (B runs to its first WaitEvent and gives up its slice)
  });
  return { p, A, B, used };
}

// the one task runs inside the thread's run and ends at its first wait; the caller's run is as it was
{
  const { p, A, B, used } = machine();
  p.threads16(true, B);
  assert.equal(p.ran, 1); assert.equal(B.state, 'waiting'); assert.ok(B.ctx); assert.equal(B.preempted, true);
  assert.equal(p.thread16, A); assert.equal(p.depth, 2); assert.equal(p.stackLevel, 3); assert.equal(p.inThreads, true); assert.equal(p.preempted, 0); assert.equal(p.runT0, 500);
  assert.deepEqual(used, [A.pc]);
}
// a whole pass inside a thread's run (a Yield inside a call) runs the other threads, not the running ones; a thread
// already running is never run again
{
  const { p, A, B } = machine();
  p.threads16(true, A); assert.equal(p.ran, 0); assert.equal(A.state, 'running');
  p.threads16(true); assert.equal(p.ran, 1); assert.equal(B.state, 'waiting'); assert.equal(p.thread16, A); assert.equal(p.depth, 2); assert.equal(p.inThreads, true);
  p.threadsNest = 4; B.state = 'new'; p.threads16(true); assert.equal(p.ran, 1);   // (no deeper than four)
}
// the creator hands the Win16Lock it holds over; a lock another thread holds bars the task
{
  const { p, A, B } = machine();
  p.win16Held = { who: { id: 9 } }; p.threads16(true, B); assert.equal(p.ran, 0);
  p.win16Held = { who: A }; p.threads16(true, B); assert.equal(p.ran, 1); assert.equal(B.state, 'waiting');
}
// LoadModule's start of a task from a thread runs the task this way
{
  const src = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
  assert.ok(/if \(this\.thread16 \|\| this\.depth\) for \(let k = 0; k < 500 [^\n]*this\.threads16\(true, t\);/.test(src));
}
console.log('soundtask: ok');
