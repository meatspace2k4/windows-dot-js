// Explorer's busy pointer for good: a folder window's thread waiting on another of Explorer's threads that never ran
// - USER sleeps a Win32 thread's queue by arming its wake mask, resetting the queue's event and waiting on it; a send
//   or post in between clears the mask and sets the event, and ResetW32Event took that wake away. A woken queue keeps
//   its event set
// - USER hears of each thread of a process that ends while the process goes on (SignalProc32, USIG_THREAD_EXIT), on
//   that thread, as KERNEL32 tells it; told only as a whole process ended, the thread's queue stayed behind
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, K16 = window.W95NE16.K16;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(16 << 20) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb']) p.cpu[r] = { value: 0 };
p.selUsed = new Uint8Array(0x2000); p.handles = new Map(); p.nextHandle = 0x100;
const QSEL = 0x2007, QBASE = 0x100000; p.setDesc(QSEL, QBASE, 0xff, 0xf300);
const reset = K16['KERNEL.#459'][2], create = K16['KERNEL.#457'][2];
const ev = create.call(p, 0, 1), e = p.obj(ev);
p.w32(QBASE + 0xc, ev);
p.threadsById = new Map([[0x93, { id: 0x93, queue: QSEL, state: 'waiting' }]]);

// armed, not woken: the reset takes the event down
p.w16(QBASE + 0x4c, 0x287f); p.w16(QBASE + 0x48, 0); e.set = true;
reset.call(p, ev); assert.equal(e.set, false, 'an armed queue\'s event is reset');
// woken (the mask cleared, a sent message waiting): the reset leaves it set
p.w16(QBASE + 0x4c, 0); p.w16(QBASE + 0x48, 0x40); e.set = true;
reset.call(p, ev); assert.equal(e.set, true, 'a woken queue keeps its wake');
// an event that is no queue's: reset as ever
const other = create.call(p, 0, 1); reset.call(p, other); assert.equal(p.obj(other).set, false);

// a thread of a process that goes on: USER told on that thread, once
{
  const pc = { pid: 1, started: true, exe: { base: 0x400000 }, exitCode: null };
  const a = { id: 0xa0, pc, state: 'done', queue: QSEL }, b = { id: 0xb0, pc, state: 'waiting', queue: 0x200f };
  const q = Object.create(Process.prototype); q.threadsById = new Map([[a.id, a], [b.id, b]]);
  q.ne = new Map([['USER', { meta: {} }]]); q.neExport = () => 0x14071886; q.hinst16 = () => 0x1af7;
  const told = []; q.user16 = function (ord, args) { told.push([ord, args[0][1], args[1][1], this.thread16 && this.thread16.id]); return {}; };
  q.pcThreadEnded(a); q.pcThreadEnded(a);
  assert.deepEqual(told, [[391, 0x20, 0xa0, 0xa0]], 'USIG_THREAD_EXIT on the ending thread, once');
  assert.equal(pc.exitCode, null, 'the process goes on');
}
console.log('queuewake: ok');
