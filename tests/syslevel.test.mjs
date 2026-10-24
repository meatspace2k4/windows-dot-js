// KERNEL32's system-level lock calls (#97, #98) leave EAX as the caller had it: GDI32's GetObjectType takes the lock
// around an object's lookup and returns the type it has in EAX straight after leaving.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const K = window.W95Win32.API.KERNEL32;
const p = { sysLevel: 1, reg: n => (n === 'eax' ? 2 : 0) };   // (EAX: OBJ_BRUSH, the type GetObjectType found)
assert.equal(K['#98'][1].call(p, 0), 2, '#98 keeps EAX');
assert.equal(K['#97'][1].call(p, 0), 2, '#97 keeps EAX');
console.log('syslevel: ok');
