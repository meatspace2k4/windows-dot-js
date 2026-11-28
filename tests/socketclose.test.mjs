import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, K = W.API.KERNEL32;
const mem = new Uint8Array(0x10000), dv = new DataView(mem.buffer);
const calls = [], wsock = { name: 'WSOCK', id: 0x3e };
const handles = new Map(); let next = 0x100, top = 0x1000;
const p = {
  u8: mem, handles, lastError: 0,
  newHandle(o) { const h = next += 4; handles.set(h, o); return h; },
  obj(h) { return handles.get(h); },
  alloc(n) { const a = top; top += n; return a; },
  w32(a, v) { dv.setUint32(a, v >>> 0, true); },
  vxdById(id) { return id === 0x3e ? wsock : null; },
  vxdIoctl(v, code, inb, nin) { calls.push([v.name, code, dv.getUint32(inb, true), nin]); return 0; },
};
const h = K.CreateSocketHandle[1].call(p);
K.SetHandleContext[1].call(p, h, 0x39df8b4);
assert.equal(K.CloseHandle[1].call(p, h), 1);
assert.deepEqual(calls, [['WSOCK', 0x102, 0x39df8b4, 4]]);
const h2 = K.CreateSocketHandle[1].call(p);
K.CloseHandle[1].call(p, h2);
assert.equal(calls.length, 1);
console.log('socketclose: ok');
