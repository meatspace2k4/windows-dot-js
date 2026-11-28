// A relocatable program with no gap its size in the arena below 2000000h is put in the address space above the layout
// (win32.js imageRoom, vmRoom), as Windows maps a relocatable image wherever its process has room. The OSR 2.5 CD's
// MSN251.EXE, an IExpress package of A8A000h bytes based at 1000000h, had "no room for its image" and did not start
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const asked = [];
const p = Object.assign(Object.create(P), {
  moduleSpans: () => [[0x400000, 0x1800000]], bundleSpans16: () => [], memoSpans: () => [],
  vmTop: 0x40000000, vmRoom(size, align) { asked.push(size); return 0x30000000; },
});
assert.equal(p.imageRoom(0x1000000, 0xa8a000, true, true), 0x30000000, 'a relocatable program: room above the layout');
assert.deepEqual(asked, [0xa8a000]);
assert.equal(p.imageRoom(0x1000000, 0xa8a000, false, true), 0, 'one with no relocations is not moved there');
console.log('bigprogramroom: ok');
