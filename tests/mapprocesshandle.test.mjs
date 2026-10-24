// KERNEL.483, MapProcessHandle: USER asks it for the process behind a handle (a program Explorer started while the
// logon dialog's thread waits); a process handle gives its id, the current-process handle the caller's, an id itself
// stays as it is, and anything else is 0 with ERROR_INVALID_HANDLE
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();

const def = window.W95NE16.K16['KERNEL.#483'];
assert.ok(def, 'KERNEL.#483 (MapProcessHandle) has an implementation');
const [args, ret, fn] = def;
assert.equal(args, 'l'); assert.equal(ret, 'l');

const handles = new Map(); let hn = 0x100;
const g = { handles, obj: h => handles.get(h) || null, newHandle(o) { handles.set(hn, o); return hn++; },
  procs: new Map([[0x6c, { pid: 0x6c }]]), thread16: null, inSystem: () => true, lastError: 0 };
const h = g.newHandle({ kind: 'process', pid: 0x6c });
assert.equal(fn.call(g, h), 0x6c);                    // a process handle
assert.equal(fn.call(g, 0xffffffff), 0x40);           // GetCurrentProcess() on USER's system thread: the system process
g.thread16 = { pc: { pid: 0x6c } };
assert.equal(fn.call(g, 0xffffffff), 0x6c);           // on a program's thread: that program's
assert.equal(fn.call(g, 0x6c), 0x6c);                 // an id already
assert.equal(fn.call(g, 0x40), 0x40);                 // the system process's id
const ht = g.newHandle({ kind: 'thread', id: 9 });
assert.equal(fn.call(g, ht), 0); assert.equal(g.lastError, 6);   // not a process
assert.equal(fn.call(g, 0x1234), 0);
console.log('mapprocesshandle: ok');
