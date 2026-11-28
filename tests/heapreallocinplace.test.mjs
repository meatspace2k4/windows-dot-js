// HeapReAlloc with HEAP_REALLOC_IN_PLACE_ONLY (10h) that cannot grow the block where it is fails and leaves it, as
// Windows' does (win32.js): moved and freed, its caller went on using the old address
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, K = API.KERNEL32;
const p = Object.create(Process.prototype);
p.mem = new WebAssembly.Memory({ initial: 4 });
let top = 0x1000; const freed = [];
Object.assign(p, { allocs: new Map(), alloc(n) { const b = top; top += (n + 15) & ~15; this.allocs.set(b, n); return b; }, free(a) { freed.push(a); return this.allocs.delete(a); } });
const a = K.HeapAlloc[1].call(p, 0x5000, 0, 16);
assert.equal(K.HeapReAlloc[1].call(p, 0x5000, 0x10, a, 64), 0, 'in place only: fails');
assert.equal(p.lastError, 8);
assert.ok(p.allocs.has(a) && !freed.length, 'the block left where it was');
assert.equal(K.HeapReAlloc[1].call(p, 0x5000, 0x10, a, 8), a, 'a shrink stays in place');
const b = K.HeapReAlloc[1].call(p, 0x5000, 0, a, 64);
assert.ok(b && b !== a && freed.includes(a), 'without the flag it moves');
console.log('heapreallocinplace: ok');
