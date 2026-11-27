// A named object's name lives as long as a handle to it: a second CreateMutex finds the first (ERROR_ALREADY_EXISTS)
// while one is held, and once the last is closed, or the process holding it has ended, the name is free again.
// RUNONCE's Runonce_Instance_Mutex outlived the RUNONCE that made it, and every RUNONCE after it found a "previous
// instance" and quit, started again and again on Windows 98's first start
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 16) }; p.handles = new Map(); p.nextHandle = 0x100; p.lastError = 0;
const K = API.KERNEL32, call = (nm, ...a) => K[nm][1].call(p, ...a), name = 0x100; p.writeA(name, 'Runonce_Instance_Mutex');
const A = { pid: 1 }, B = { pid: 2 };

const as = pc => { p.thread16 = { pc }; };   // (the calling thread's process)
as(A); const ha = call('CreateMutexA', 0, 1, name); assert.equal(p.lastError, 0, 'the first makes it');
as(B); const hb = call('CreateMutexA', 0, 1, name); assert.equal(p.lastError, 183, 'a second finds it');
p.namedClose(A); assert.ok(!p.handles.has(ha), 'the first process\'s handle closed as it ends');
as(B); call('CloseHandle', hb);
as({ pid: 3 }); call('CreateMutexA', 0, 1, name); assert.equal(p.lastError, 0, 'its last handle gone, the name is free again');
p.namedClose(p.pc);
as({ pid: 4 }); call('CreateMutexA', 0, 1, name); assert.equal(p.lastError, 0, 'and after a process holding it ended without closing it');
console.log('namedobj: ok');
