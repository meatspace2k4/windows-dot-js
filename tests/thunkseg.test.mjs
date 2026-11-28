// The 16-bit thunks' segment (selector FFF7h) has memory of its own behind its descriptor (ne16.js init16, t16r): a
// read through it finds a byte, as USER's check of a dialog procedure reads its first one, and code that comes there
// through a CS the descriptor gave is the thunk at LAYOUT.THUNK16 (win32.js thunkAt, dispatch). The descriptor's base
// was the thunks' own address, outside memory: on Windows 95 OSR 2.5 Setup's Windows Components page USER read the
// first byte of SETUPX.#504's thunk there, and the read faulted (exception 0Eh)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map(); p.init16();
const base = p.selBase(0xfff7), thunk = p.thunk16For('KERNEL.#3');
assert.ok(base > 0 && base + 0x10000 <= p.u8.length, 'the segment\'s base is memory');
assert.equal(thunk >>> 16, 0xfff7);
assert.equal(typeof p.u8[p.lin(thunk)], 'number', 'a byte at the thunk, through its selector');
assert.ok(p.thunkAt(p.lin(thunk)), 'code there is a thunk');
assert.ok(p.thunkAt(LAYOUT.THUNK16 + (thunk & 0xffff)), 'as at the translated modules\' address for it');
assert.ok(!p.thunkAt(base - 1) && !p.thunkAt(base + 0x10000), 'and nothing beside it');
console.log('thunkseg: ok');
