// A Win16 task a process's thread starts (LoadModule: MMSYSTEM's MMTASK for the MCI sequencer) is a task of its own:
// GetCurrentTask from its thread is its handle, not the process's, so the driver posts the sequencer's commands to the
// task's queue (PostAppMessage to the handle mmGetCurrentTask gave it) and not to the player's own, where they would
// sit while the player yields for the task
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, K16 = window.W95NE16.K16, P = W.Process.prototype;

const pc = { pid: 0x60, tdb: 0x1234 };
const player = { id: 7, pc, tdb: pc.tdb, queue: 0x1a0e };
const task = { id: 8, pc, task: { psp: 1 }, tdb: 0x5678, queue: 0x1b0e };
const p = Object.create(P);
Object.assign(p, { threadsById: new Map([[7, player], [8, task]]), w16() {}, selBase: () => 0 });
p.thread16 = player; assert.equal(P.currentTask.call(p), 0x1234);
p.thread16 = task; assert.equal(P.currentTask.call(p), 0x5678); assert.equal(task.tdb, 0x5678);
// the task's queue by its handle (USER's PostAppMessage: GetThreadQueue with the task handle)
assert.equal(K16['KERNEL.#464'][2].call(p, 0x5678), 0x1b0e);
assert.equal(K16['KERNEL.#464'][2].call(p, 0x1234), 0x1a0e);
console.log('mmtask: ok');
