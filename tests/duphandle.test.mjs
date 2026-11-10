// DuplicateHandle of the calling thread's or process's pseudo-handle makes a real handle to that thread or process
// (win32.js): MPR gives MPREXE its waiting thread's handle, made so, and MPREXE queues the APC that ends the wait on
// it. Copied as the pseudo-handle, MPREXE's QueueUserAPC took FFFFFFFEh for its own thread, and GRPCONV's link to the
// Removable Disk in SendTo waited for good: Windows 98's first start stopped at "Programs on the Start menu".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API } = window.W95Win32, dup = API.KERNEL32.DuplicateHandle[1];
const objs = new Map(), out = {};
const p = { pc: { pid: 124 }, currentThreadId: () => 109, newHandle(o) { const h = 0x400 + objs.size; objs.set(h, o); return h; }, w32(a, v) { out[a] = v; },
  handles: new Map(), nextHandle: 0x800, obj(h) { return this.handles.get(h) || null; } };
assert.equal(dup.call(p, 0xffffffff, 0xfffffffe, 0xffffffff, 0x100, 0, 0, 2), 1);
assert.notEqual(out[0x100], 0xfffffffe, 'not the pseudo-handle');
assert.deepEqual(objs.get(out[0x100]), { kind: 'thread', id: 109 }, 'the calling thread itself');
dup.call(p, 0xffffffff, 0xffffffff, 0xffffffff, 0x104, 0, 0, 2);
assert.deepEqual(objs.get(out[0x104]), { kind: 'process', pid: 124 }, 'the calling process itself');
dup.call(p, 0xffffffff, 0x540, 0xffffffff, 0x108, 0, 0, 2);
assert.equal(out[0x108], 0x540, 'a real handle: the same object');
// a file mapping's duplicate is a handle of its own, and DUPLICATE_CLOSE_SOURCE (1) closes the one duplicated: the
// shell's SHAllocShared hands Explorer a folder's ID list this way and closes its own handle
const map = { kind: 'mapping', base: 0x1000, size: 64 }; p.handles.set(0x600, map);
dup.call(p, 0xffffffff, 0x600, 0xffffffff, 0x10c, 0, 0, 2);
assert.notEqual(out[0x10c], 0x600, 'a mapping: a handle of its own'); assert.equal(p.handles.get(out[0x10c]), map); assert.equal(p.handles.get(0x600), map, 'the source stays');
dup.call(p, 0xffffffff, 0x600, 0xffffffff, 0x110, 0, 0, 3);
assert.equal(p.handles.get(out[0x110]), map); assert.equal(p.handles.has(0x600), false, 'DUPLICATE_CLOSE_SOURCE: the source closed, the mapping still held');
console.log('duphandle: ok');
