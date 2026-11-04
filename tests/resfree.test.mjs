// KERNEL's resources: FindResource gives one handle for each resource of a module, LoadResource shares the block it
// loaded with a count, and FreeResource's last call frees it. A new handle and block at each find, never freed, held a
// copy of USER's 65488-byte resource for each load until MSGSRV32 ran out of memory (104 of them, 6.5 MB)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'osclass.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { K16 } = window.W95NE16, { Process, LAYOUT } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map(); p.init16();
const file = new Uint8Array(0x20000); for (let i = 0; i < 0xffd0; i++) file[0x100 + i] = i & 0xff;
const m = { name: 'USER', file, res: [{ id: 1, type: 2, off: 0x100, len: 0xffd0 }] };
p.neByHandle = h => h === 0x148f ? m : null; p.neResources = mod => mod.res; p.hinst32 = () => 0;
const fn = k => (...a) => K16[k][2].apply(p, a);
const find = fn('KERNEL.#60'), load = fn('KERNEL.#61'), free = fn('KERNEL.#63'), lock = fn('KERNEL.#62');

// the same resource found again: the same handle
const hr = find(0x148f, 1, 2);
assert.ok(hr); assert.equal(find(0x148f, 1, 2), hr);
// loaded twice: one block, its bytes the resource's; freed once, still there; freed again, gone
const g = load(0x148f, hr); assert.ok(g); assert.equal(load(0x148f, hr), g);
assert.equal(p.u8[p.lin(lock(g)) + 0x123], 0x23);
assert.equal(free(g), 0); assert.ok(p.gblock(g), 'one load still holds it');
assert.equal(free(g), 0); assert.ok(!p.gblock(g), 'the last free frees the block');
// find, load and free over and over: the heap does not grow
const top = p.heapTop, live = p.allocs.size;
for (let i = 0; i < 200; i++) { const h = find(0x148f, 1, 2), b = load(0x148f, h); assert.ok(b); free(b); }
assert.equal(p.allocs.size, live, 'no block left behind');
assert.ok(p.heapTop - top <= 0x10000, 'no copy per load');
console.log('resfree: ok');
