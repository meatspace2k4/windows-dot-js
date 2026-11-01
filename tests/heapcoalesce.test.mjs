// The heap at its end: a block larger than any one free block is made from free blocks that touch, merged, and from
// free space at the heap's top given back. Kept apart by size, MSGSRV32 at boot found 15 MB idle on the free lists
// and still ran out of memory ("out of memory: 37 MB live ... 15 MB idle on the free lists")
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../win32.js', import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map();
// the heap filled with blocks of mixed sizes, then a run of neighbours freed: no one of them holds 3 MB, together they do
const sizes = [0x10000, 0x110000, 0x220000, 0x40000];
const blocks = []; for (let i = 0; p.heapTop + sizes[i % 4] <= LAYOUT.HEAP_END; i++) blocks.push(p.alloc(sizes[i % 4], false));
if (p.heapTop < LAYOUT.HEAP_END) blocks.push(p.alloc(LAYOUT.HEAP_END - p.heapTop, false));   // (to the heap's end)
const sizeOf = a => p.allocs.get(a);
for (const a of blocks.slice(8, 16)) p.free(a);
assert.ok(Math.max(...p.freeList.keys()) < 0x300000, 'no single free block holds the request');
const big = p.alloc(0x300000);
assert.equal(p.allocs.get(big), 0x300000, '3 MB from the merged neighbours');
assert.ok(big >= blocks[8] && big + 0x300000 <= blocks[16], 'inside the freed run');
assert.equal(p.u8[big], 0, 'zeroed');
// free space at the heap's top: given back, so a block that fits there is allocated past the last live block
const n = sizeOf(blocks[blocks.length - 1]) + sizeOf(blocks[blocks.length - 2]);
p.free(blocks[blocks.length - 1]); p.free(blocks[blocks.length - 2]);
const top = p.alloc(n);
assert.equal(top, blocks[blocks.length - 2], 'the heap\'s top lowered and reused');
console.log('heapcoalesce: ok');
