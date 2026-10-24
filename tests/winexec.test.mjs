// WinExec from a 16-bit task (MSGSRV32 starting the shell): it returns once the started program is idle, as KERNEL32's
// does (the process in GetMessage, or a time-out), and until then the caller gives up its slices, so the machine runs
// on. The shell waiting on RUNONCE (Setup's "Windows is now setting up" screen) with its queue pumped is not idle yet;
// its main thread blocked on a plain object once the desktop's thread runs is
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, K16 = window.W95NE16.K16, P = W.Process.prototype, YIELD = W.YIELD;

const pcOf = main => ({ main, exitCode: null, exe: { base: 0x400000 } });
// idle: ended; in WaitEvent; a pure message wait; a plain object wait. Not idle: running; its slice ran out; a wait
// that pumps while it holds a handle
{
  const p = Object.create(P), idle = main => P.processIdle.call(p, pcOf(main));
  assert.equal(idle({ state: 'done' }), true);
  assert.equal(idle({ state: 'waiting', slept: true }), true);
  assert.equal(idle({ state: 'waiting', waitOn: { hs: [], all: 0, ms: -1, msg: true } }), true);
  assert.equal(idle({ state: 'waiting', waitOn: { hs: [0x40], all: 0, ms: 0xffffffff } }), true);
  assert.equal(idle({ state: 'running' }), false);
  assert.equal(idle({ state: 'waiting', preempted: true, waitOn: { hs: [0x40], all: 0, ms: 0xffffffff } }), false);
  assert.equal(idle({ state: 'waiting', waitOn: { hs: [0x44], all: 0, ms: 0xffffffff, msg: true } }), false);
  assert.equal(idle({ state: 'waiting' }), false);
  assert.equal(P.processIdle.call(p, { ...pcOf({ state: 'waiting' }), exitCode: 0 }), true);
}
// the call from a task at its top level: the program started once, the call yielding until the program is idle, then
// its instance; the 16-bit side's hinst for it
{
  const main = { state: 'running' }, pc = pcOf(main), started = [];
  const p = Object.create(P); let now = 1000;
  Object.assign(p, {
    thread16: { id: 7, depth: 0 }, depth: 0, host: { exec: (cmd, show) => { started.push([cmd, show]); return pc; } },
    now: () => now, hinst16: base => (base === 0x400000 ? 0x1234 : 0), runUntilIdle: () => { throw new Error('ran inline'); },
  });
  const fn = K16['KERNEL.#166'][2];
  assert.equal(fn.call(p, 'EXPLORER.EXE', 1), YIELD); assert.deepEqual(started, [['EXPLORER.EXE', 1]]); assert.equal(p.thread16.execWait, pc);
  main.state = 'waiting'; main.waitOn = { hs: [0x44], all: 0, ms: 0xffffffff, msg: true };   // (waiting on RUNONCE, pumping)
  assert.equal(fn.call(p, 'EXPLORER.EXE', 1), YIELD); assert.equal(started.length, 1);
  main.waitOn = { hs: [0x48], all: 0, ms: 0xffffffff };   // (the desktop's thread has the shell: its main thread blocks)
  assert.equal(fn.call(p, 'EXPLORER.EXE', 1), 0x1234); assert.equal(p.thread16.execWait, null); assert.equal(started.length, 1);
  // the time-out: a program never idle is returned after 60 s
  main.waitOn = { hs: [0x44], all: 0, ms: 0xffffffff, msg: true };
  assert.equal(fn.call(p, 'EXPLORER.EXE', 1), YIELD); now += 60001; assert.equal(fn.call(p, 'EXPLORER.EXE', 1), 0x1234);
  // not a Win32 program (a task's instance, or an error): given back as it is
  p.host.exec = () => 2; assert.equal(fn.call(p, 'NOPE.EXE', 1), 2);
  p.host.exec = () => ({ elsewhere: true }); assert.equal(fn.call(p, 'TWICE.EXE', 1), 33);
}
// inside a call (the caller cannot give up its slice): the program runs here until idle
{
  let ran = 0; const main = { state: 'running' }, pc = pcOf(main);
  const p = Object.create(P);
  Object.assign(p, { thread16: { id: 7, depth: 0 }, depth: 2, host: { exec: () => pc }, hinst16: () => 0x1234, trapped: null, threads16() { if (++ran === 3) { main.state = 'waiting'; main.slept = true; } } });
  assert.equal(K16['KERNEL.#166'][2].call(p, 'X.EXE', 1), 0x1234); assert.equal(ran, 3);
}
console.log('winexec: ok');
