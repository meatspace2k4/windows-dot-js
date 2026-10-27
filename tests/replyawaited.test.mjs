// a thread waits on the reply to a SendMessage of its own when its queue's wake mask (4Ch) asks for QS_SMRESULT: the
// host then sends nothing to read controls (nativeChildren), as a send from it went into that thread's chain of sends
// and the thread waited for good (Display Properties' hourglass, the taskbar that no longer painted)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const mem = new DataView(new ArrayBuffer(0x10000)), base = { 0x47: 0x1000, 0x4f: 0x2000 };
const p = Object.create(P);
Object.assign(p, { selValid: s => s in base, selBase: s => base[s], r16: a => mem.getUint16(a, true) });
p.threadsById = new Map([[1, { id: 1, state: 'waiting', queue: 0x47 }], [2, { id: 2, state: 'waiting', queue: 0x4f }]]);
mem.setUint16(0x1000 + 0x4c, 0x287f, true); mem.setUint16(0x2000 + 0x4c, 0x20ff, true);
assert.equal(p.replyAwaited(), false, 'both in GetMessage');
mem.setUint16(0x2000 + 0x4c, 0x8840, true);
assert.equal(p.replyAwaited(), true, 'one in SendMessage, waiting for QS_SMRESULT');
p.threadsById.get(2).state = 'done';
assert.equal(p.replyAwaited(), false, 'an ended thread waits on nothing');
console.log('replyawaited: ok');
