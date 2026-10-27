// CreateProcess of a Windows 3.x program: a process handle for its task, signalled (and its exit code given) when the
// task ends, as each Win16 task is a process of its own on Windows 95. With PROCESS_INFORMATION left zero, Explorer
// waited on handle 0 for the RunOnce program TAPIINI.EXE, and its desktop never came. GetExitCodeProcess answered
// FALSE for every process
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;
const p = Object.create(Process.prototype);
Object.assign(p, { mem: { buffer: new ArrayBuffer(0x40000) }, handles: new Map(), nextHandle: 0x100, procs: new Map() });
const task = { id: 120, tdb: 0x4d0f, state: 'waiting', task: { hInst: 0x2e57 } };
p.threadsById = new Map([[task.id, task]]);
p.host = { exec: () => 0x2e57 };   // (WinExec's answer for a Win16 program: its instance)
const K = n => (...a) => API.KERNEL32[n][1].call(p, ...a), PI = 0x1000, CMD = 0x2000, OUT = 0x3000;
p.writeA(CMD, 'tapiini.exe');
assert.equal(K('CreateProcessA')(0, CMD, 0, 0, 0, 0, 0, 0, 0, PI), 1);
const h = p.r32(PI), o = p.obj(h);
assert.ok(h && o && o.kind === 'process' && o.task === task, 'a process handle for the task');
assert.equal(p.r32(PI + 8), 0x4d0f, 'its id'); assert.equal(p.r32(PI + 12), 120, 'its thread\'s id');
assert.equal(K('GetExitCodeProcess')(h, OUT), 1); assert.equal(p.r32(OUT), 0x103, 'STILL_ACTIVE while it runs');
const ev = () => { const W = p.obj(h); return W.kind === 'process' && (W.task ? W.task.state === 'done' : null); };
assert.equal(ev(), false);
task.state = 'done'; task.exitCode = 3;
assert.equal(K('GetExitCodeProcess')(h, OUT), 1); assert.equal(p.r32(OUT), 3, 'its exit code once it has ended');
// a Win32 process: its code once ended and gone from the table
p.procs.set(0x60, { pid: 0x60, exitCode: null }); const h2 = p.newHandle({ kind: 'process', pid: 0x60 });
K('GetExitCodeProcess')(h2, OUT); assert.equal(p.r32(OUT), 0x103);
p.procs.delete(0x60); p.exitCodes = new Map([[0x60, 7]]); K('GetExitCodeProcess')(h2, OUT); assert.equal(p.r32(OUT), 7);
console.log('win16proc: ok');
