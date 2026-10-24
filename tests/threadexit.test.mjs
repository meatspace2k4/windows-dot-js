// A process that ends has USER told of each of its threads' end (SignalProc32, USIG_THREAD_EXIT) on that thread, as
// KERNEL32 signals it from the exiting thread: USER destroys the thread's windows there, and its DestroyWindow goes
// on only when the window's queue is the current thread's (GetFastQueue). Signalled from another thread (the one that
// ended the process, or the system's), it found another queue, destroyed nothing, and looped on the same window for
// good: Media Player faulting while MCIAVI loaded froze the whole machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const p = Object.create(Process.prototype);
const pc = { pid: 0x6c, started: true, exe: { base: 0x420000 }, exitCode: null };
const main = { id: 0x90, pc, state: 'running', queue: 0x2a7 }, worker = { id: 0x94, pc, state: 'waiting', queue: 0x2b7 };
const sys = { id: 0x84, state: 'running', queue: 0x1e7 };
p.threadsById = new Map([[sys.id, sys], [main.id, main], [worker.id, worker]]);
p.thread16 = sys;   // (the process ended from another thread: the system's)
p.ne = new Map([['USER', { meta: {}, exports: new Map([[391, 0x14071886]]), names: {} }]]);
p.hinst16 = () => 0x1af7;
const seen = [];
p.user16 = (ord, args) => { if (ord === 391) seen.push([args[0][1], args[1][1], p.thread16 && p.thread16.id]); return { ax: 1 }; };
p.endProcess(pc, 0);
assert.deepEqual(seen.filter(s => s[0] === 0x20), [[0x20, 0x90, 0x90], [0x20, 0x94, 0x94]], 'each thread\'s end is signalled on that thread');
assert.equal(p.thread16, sys, 'the caller\'s thread is current again after');
console.log('threadexit: ok');
