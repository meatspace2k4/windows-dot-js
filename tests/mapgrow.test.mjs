// A file's mapping asked for again larger, or its file grown, grows at the same address (win32.js mapGrow): answered at
// its old size, WININET zeroed past the data's end into the next block and faulted
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, K = API.KERNEL32;
const files = new Map([['C:\\INDEX.DAT', new Uint8Array(0x4000).fill(7)]]);
const p = Object.create(Process.prototype);
p.mem = new WebAssembly.Memory({ initial: 512 });
let top = 0x10000, hn = 0x100; const handles = new Map();
Object.assign(p, {
  fs: { readFile: n => files.get(n).slice(), writeFile: (n, b) => files.set(n, Uint8Array.from(b)), stat: n => ({ size: files.get(n).length }) },
  handles, obj: h => handles.get(h) || null, newHandle(o) { handles.set(hn, o); return hn++; },
  allocs: new Map(), alloc(n) { const b = top; top += (n + 15) & ~15; this.allocs.set(b, n); return b; }, free(a) { this.allocs.delete(a); }, extend: () => false,
});
const name = 0x200; p.u8.set(new TextEncoder().encode('IDX\0'), name);
const fh = p.newHandle({ kind: 'file', path: 'C:\\INDEX.DAT', fd: 1 });
const m1 = K.CreateFileMappingA[1].call(p, fh, 0, 4, 0, 0x4000, name), v1 = K.MapViewOfFile[1].call(p, m1, 2, 0, 0, 0);
const m2 = K.CreateFileMappingA[1].call(p, fh, 0, 4, 0, 0x10000, name), v2 = K.MapViewOfFile[1].call(p, m2, 2, 0, 0, 0);
assert.equal(v2, v1, 'the same address');
assert.equal(handles.get(m2).size, 0x10000, 'grown to the size asked for');
p.u8.fill(1, v2, v2 + 0x10000);   // (WININET zeroing its new part: inside the mapping's own memory)
assert.ok([...p.allocs].every(([b, n]) => b === v1 || b + n <= v1 || b >= v1 + 0x10000), 'no other block inside it');
assert.equal(files.get('C:\\INDEX.DAT').length, 0x10000, 'the file grown with it');
console.log('mapgrow: ok');
