// a critical section made new (InitializeCriticalSection) or deleted while a thread waits on it lets the thread go: a
// DLL's start in another process makes the sections in its shared data again (SHELL32's, as RUNDLL32 loads it) while
// a thread here waits on one, and that thread waited for good (a shared session's Control Panel never opened)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API } = window.W95Win32, K = n => API.KERNEL32[n][1];
for (const init of ['InitializeCriticalSection', 'DeleteCriticalSection']) {
  const u8 = new Uint8Array(0x1000), waiter = { id: 7, blocked: true };
  const p = { u8, critSecs: new Map([[0x100, { owner: 3, count: 1, waiters: new Set([waiter]) }]]) };
  K(init).call(p, 0x100);
  assert.equal(waiter.blocked, false, init + ' lets the waiter go');
  assert.equal(p.critSecs.has(0x100), false);
}
console.log('critreinit: ok');
