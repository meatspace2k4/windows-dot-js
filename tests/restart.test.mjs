// what Restart (ExitWindowsEx from Explorer) needs: a thunklet that fits its block, a Win32 thread's queue with its event,
// PostEvent counted on a task, semaphores and critical sections that block and wake (MPR's requests to MPREXE), the
// KERNEL thunks USER's ExitWindows reaches, MPREXE where MPR starts it, and a stray pointer that faults the program
// rather than ending the machine
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, K16 = window.W95NE16.K16, API = W.API, YIELD = W.YIELD, P = W.Process.prototype;

function guest() {
  const u8 = new Uint8Array(1 << 16), dv = new DataView(u8.buffer); let top = 0x100;
  const handles = new Map(); let hn = 0x100;
  return ({ wakeWaiters: P.wakeWaiters, signal: P.signal,
    u8, r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), r16: a => dv.getUint16(a, true), w16: (a, v) => dv.setUint16(a, v & 0xffff, true),
    alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, lin: a => a,
    obj: h => handles.get(h), newHandle(o) { handles.set(hn, o); return hn++; },
  });
}

// AllocLSThunkletCallback: its stub (nop; push target; nop; push relay; jmp glue) is 17 bytes, and the block holds them
{
  const g = guest(); let asked = 0; g.alloc = n => { asked = n; return 0x1000; }; g.cbGlueLS = 0x8000;
  K16['KERNEL.#561'][2].call(g, 0x1234, 0x5678);
  assert.ok(asked >= 17, `thunklet block of ${asked} bytes`);
  assert.equal(g.u8[0x100c], 0xe9); assert.equal(g.r32(0x100d), (0x8000 - 0x1011) >>> 0);
}

// a semaphore, as KERNEL's 16-bit waits see it: signalled while its count is above zero, a satisfied wait takes one;
// ReleaseSemaphore wakes the threads blocked on it
{
  const g = guest(); g.thread16 = { id: 9 }; g.now = () => 0; g.atThreadTop = () => true;
  const sem = { kind: 'semaphore', count: 0, max: 4 }, h = g.newHandle(sem), arr = g.alloc(4); g.w32(arr, h);
  const w461 = K16['KERNEL.#461'][2];
  assert.equal(w461.call(g, 1, arr, 0, 0), 0x102);
  const t = { blocked: true }; sem.waiters = new Set([t]);
  API.KERNEL32.ReleaseSemaphore[1].call(g, h, 1, 0);
  assert.equal(sem.count, 1); assert.equal(t.blocked, false);
  assert.equal(w461.call(g, 1, arr, 0, 0), 0); assert.equal(sem.count, 0);
}

// critical sections: owned by a thread until it leaves as often as it entered; another thread entering then gives up
// the processor and is let go when the owner leaves
{
  const g = guest(); g.nativeUser16 = () => true; g.atThreadTop = () => true;
  const a = { id: 1 }, b = { id: 2 }, cs = 0x200;
  const enter = API.KERNEL32.EnterCriticalSection[1], leave = API.KERNEL32.LeaveCriticalSection[1];
  g.thread16 = a; g.currentThreadId = () => g.thread16.id;
  enter.call(g, cs); enter.call(g, cs);
  g.thread16 = b; assert.equal(enter.call(g, cs), YIELD); assert.equal(b.blocked, true);
  g.thread16 = a; leave.call(g, cs); assert.equal(b.blocked, true); leave.call(g, cs); assert.equal(b.blocked, false);
  g.thread16 = b; assert.notEqual(enter.call(g, cs), YIELD);
  g.thread16 = a; assert.equal(enter.call(g, cs), YIELD);
}

// PostEvent counts an event on the task, which its next WaitEvent takes without giving up the processor; a task
// starts with one
{
  const g = guest(); const t = { id: 5, task: {}, tdb: 0x77, state: 'waiting', depth: 0 };
  g.threadsById = new Map([[5, t]]); g.thread16 = t; g.depth = 0; g.inSystem = () => false; g.currentTask = () => 0x77; g.selValid = () => false;
  const wait = K16['KERNEL.#30'][2], post = K16['KERNEL.#31'][2];
  t.events = 1; assert.equal(wait.call(g, 0), 0); assert.equal(wait.call(g, 0), YIELD);
  t.slept = false; post.call(g, 0x77); assert.equal(t.events, 1); assert.equal(wait.call(g, 0), 0);
}

// GetFastQueue: USER's InitThreadInput told a Win32 thread is one (flag 1: its queue gets the event SetWakeBit2 sets)
{
  for (const [thread, want] of [[{ id: 90, flat: true }, 5], [{ id: 91, pc: {} }, 5], [{ id: 92, task: {} }, 4]]) {
    const g = guest(); let flags; g.thread16 = thread; g.threadsById = new Map([[thread.id, thread]]); g.inSystem = () => false;
    g.ne = new Map([['USER', { meta: {} }]]); g.neExport = () => 0x10000; g.call16 = (s, o, args) => { flags = args[1][1]; return { ax: 0x1234 }; };
    K16['KERNEL.#625'][2].call(g); assert.equal(flags, want, `thread ${thread.id}`);
  }
}

// IsTask: a task whose thread has ended is none (MMSYSTEM, as Windows exits, yields until MMTASK has ended)
{
  const g = guest(); g.currentTask = () => 0x10; g.threadsById = new Map([[1, { tdb: 0x20, state: 'waiting' }], [2, { tdb: 0x30, state: 'done' }]]);
  const isTask = K16['KERNEL.#320'][2];
  assert.equal(isTask.call(g, 0x20), 1); assert.equal(isTask.call(g, 0x30), 0); assert.equal(isTask.call(g, 0x10), 1);
}
// GetModuleHandle: a program's module is gone once its last task has ended
{
  const g = guest(), rec = { hModule: 0x500, taskModule: true }, t = { task: { mod: rec }, state: 'waiting' };
  g.ne = new Map([['MMTASK', rec]]); g.threadsById = new Map([[1, t]]);
  const gmh = K16['KERNEL.#47'][2];
  assert.equal(gmh.call(g, 'mmtask'), 0x500); t.state = 'done'; assert.equal(gmh.call(g, 'mmtask'), 0);
}
// the thunks USER's ExitWindows reaches: ThunkTerminateProcess (#362) and BUNNY_351
assert.ok(K16['KERNEL.#362'] && K16['KERNEL.#351']);
// ThunkTerminateProcess, in a Win32 thread whose window took WM_ENDSESSION(TRUE) (a log off: Welcome, SYSTRAY): its
// process ends and the thread unwinds; a thread of no process (the system's) only unwinds
{
  const term = K16['KERNEL.#362'][2], procs = [], pc = {}, t = { pc };
  const g = Object.assign(guest(), { thread16: t, endProcess: (p, c) => procs.push([p, c]) });
  assert.equal(term.call(g), W.LAYOUT.SENTINEL); assert.deepEqual([procs, t.exitCode], [[[pc, 0]], 0]);
  g.thread16 = { id: 3 }; assert.equal(term.call(g), W.LAYOUT.SENTINEL); assert.equal(procs.length, 1);
}
// ExitProcess (#466), which USER calls where a thread's own window took WM_ENDSESSION(TRUE): MSGSRV32's, as Display
// Properties restarts Windows, in a call from the restarting thread's SendMessage. That call ends and the machine
// goes on to ExitKernel (EW_RESTARTWINDOWS); at the system task's own top level its exit is the machine's. A Win32
// thread's process ends with it
{
  const exit = K16['KERNEL.#466'][2], ended = [];
  const g = Object.assign(guest(), { cpu: { ssb: { value: 0 }, esp: { value: 0x200 } }, thread16: null, depth: 1, exitCode: null, host: { exited: c => ended.push(c) } });
  g.w16(0x204, 7);
  assert.equal(exit.call(g), W.LAYOUT.SENTINEL); assert.deepEqual([ended, g.exitCode], [[], null], 'the SendMessage call ends, not the machine');
  g.depth = 0; exit.call(g); assert.deepEqual([ended, g.exitCode], [[7], 7], 'at the top level the machine ends');
  const pc = {}, t = { pc }, procs = []; Object.assign(g, { thread16: t, depth: 2, endProcess: (p, c) => procs.push([p, c]) });
  assert.equal(exit.call(g), W.LAYOUT.SENTINEL); assert.deepEqual([procs, t.exitCode], [[[pc, 7]], 7], 'a Win32 thread\'s process ends, and the thread');
}

// MPREXE in SYSTEM, as COPY.INF puts it (LDID 11), where MPR starts it from GetSystemDirectory
{
  const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8'), k = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(/IN_SYSTEM = new Set\(\[[^\]]*'MPREXE\.EXE'/.test(w)); assert.ok(/\['C:\\\\WINDOWS\\\\SYSTEM\\\\MPREXE\.EXE'/.test(k));
}

// an access past the end of memory in recompiled code: a page fault where the guest made it (raise 14), not the end
{
  const g = Object.create(P), raised = [];
  Object.assign(g, {
    cpu: { eip: { value: 0x401000 } }, thread16: null, modeSwitch: null, modules: [{ name: 'X', meta: { textLo: 0x400000, textHi: 0x500000 }, run() { throw new WebAssembly.RuntimeError('memory access out of bounds'); } }],
    raise(n, at) { raised.push([n, at]); return W.LAYOUT.SENTINEL; },
  });
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(g.dispatch(0x401000), 0); } finally { console.warn = warn; }
  assert.deepEqual(raised, [[14, 0x401000]]);
}
console.log('restart: ok');
