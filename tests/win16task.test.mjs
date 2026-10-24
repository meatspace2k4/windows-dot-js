// A Win16 task started from a Win32 program's thread (GRPCONV's PROGMAN, a player's MMTASK) is the Win16 process's,
// not a thread of its starter: its windows report the system process, whose flags carry fWin16Process (8), which
// GRPCONV asks of the process behind a Progman window before it talks to it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const K16 = window.W95NE16.K16, P = window.W95Win32.Process.prototype;

// GetProcessDword(pid, GPD_FLAGS): the system process (40h) is the Win16 one; a Win32 process is not
{
  const p = Object.create(P); Object.assign(p, { procs: new Map(), inSystem: () => true, hinst16: () => 0, host: { system: true } });
  assert.equal(K16['KERNEL.#485'][2].call(p, 0x40, -4) & 8, 8);
  assert.equal(K16['KERNEL.#485'][2].call(p, 0x50, -4) & 8, 8);   // (the system's machine's own process: its Win16 tasks' GetCurrentProcessId)
  assert.equal(K16['KERNEL.#485'][2].call(p, 0x60, -4) & 8, 0);
  const q = Object.create(P); Object.assign(q, { procs: new Map(), inSystem: () => false, hinst16: () => 0, host: {}, exe: { base: 0x400000 } });
  assert.equal(K16['KERNEL.#485'][2].call(q, 0x50, -4) & 8, 0);   // (a program's machine: its own process is Win32)
  assert.equal(K16['KERNEL.#485'][2].call(p, 0x40, -44), 0x400);
}
// LoadModule's thread: no process of its starter's (the source says so where the task is made)
{
  const src = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
  const i = src.indexOf("def16('KERNEL', 45, 'sp', 'l'"), body = src.slice(i, src.indexOf('\n});', i));
  assert.ok(/t\.pc = null;/.test(body));
  assert.ok(body.indexOf('t.pc = null;') < body.indexOf('t.task = {'));
}
// a task's own handle: GetCurrentTask from a task thread with a process still gives the task's
{
  const pc = { pid: 0x60, tdb: 0x1234 }, task = { id: 8, pc, task: { psp: 1 }, tdb: 0x5678 };
  const p = Object.create(P); Object.assign(p, { threadsById: new Map([[8, task]]), thread16: task, w16() {}, selBase: () => 0 });
  assert.equal(P.currentTask.call(p), 0x5678);
}
console.log('win16task: ok');
