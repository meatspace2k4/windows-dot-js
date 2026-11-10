// The Win16Lock's level for 32-bit code (ne16.js) and who holds the lock when a thread is preempted (win32.js holdWin16).
//   KERNEL32 #97 takes the lock, #98 and #86 release it, and all three keep EAX (GDI32's GetObjectType returns the
//   value it has in EAX straight after leaving).
//   A thunk into 16-bit code takes it (enter16from32) and its return releases it (return16to32).
//   A thread preempted in flat code with the level above 0 holds the lock; with the level at 0 it does not.
// With #86 and #97 the wrong way round and thunks not counted, Explorer's taskbar thread lost the lock inside GDI32
// while drawing the Task Scheduler's tray icon, and the tray showed another thread's icon.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const { API, Process } = window.W95Win32, K = API.KERNEL32, P = Process.prototype;
const p = { sysLevel: 0, reg: n => (n === 'eax' ? 2 : 0) };   // (EAX: OBJ_BRUSH, the type GetObjectType found)
assert.equal(K['#97'][1].call(p, 0), 2, '#97 keeps EAX'); assert.equal(p.sysLevel, 1, '#97 takes the lock');
assert.equal(K['#98'][1].call(p, 0), 2, '#98 keeps EAX'); assert.equal(p.sysLevel, 0, '#98 releases it');
K['#97'][1].call(p, 0);
assert.equal(K['#86'][1].call(p, 0), 2, '#86 keeps EAX'); assert.equal(p.sysLevel, 0, '#86 releases it');
K['#86'][1].call(p, 0); assert.equal(p.sysLevel, -1, 'released around a call out of 16-bit code');
K['#97'][1].call(p, 0); assert.equal(p.sysLevel, 0, 'and taken again on the way back');

// the thunk's own level: its return releases what its entry took
const src = String(P.enter16from32);
assert.match(src, /this\.sysLevel = \(this\.sysLevel \|\| 0\) \+ 1/, 'a thunk into 16-bit code takes the lock');
const t = { sysLevel: 1, cpu: Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esp', 'fs', 'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb'].map(n => [n, { value: 0 }])),
  reg(n, v) { if (v !== undefined) this.cpu[n] = { value: v }; return this.cpu[n] ? this.cpu[n].value : 0; }, tibFor: () => 0 };
P.return16to32.call(t, { sp0: 0, esp: 0, ret32: true, done: () => 0x400000 });
assert.equal(t.sysLevel, 0, 'its return releases it');

// preempted in flat code: the lock is the thread's while its level is above 0
const who = { id: 103 };
const h = lvl => { const q = { preempted: 0x676416, sysLevel: lvl, cpu: { cs: { value: 0 } }, win16Held: null, runT0: 0, now: () => 5 }; P.holdWin16.call(q, who); return q.win16Held; };
assert.equal(h(1) && h(1).who, who, 'inside a thunk or GDI32\'s locked code: held');
assert.equal(h(0), null, 'in its own flat code: not held');
assert.equal(h(-1), null, 'in a window procedure 16-bit code called: not held');
console.log('syslevel: ok');
