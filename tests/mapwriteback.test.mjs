// A writable file mapping's data goes back to its file (win32.js mapFlush): at UnmapViewOfFile, and as the mapping
// goes; a mapping larger than its file grows the file; a view outlives the mapping's handle. Kept only in the view,
// WININET's cache index (index.dat) stayed its zeros on the disk: the next start read a cache limit of 0, made its
// containers with none, and Explorer faulted in WININET
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, K = API.KERNEL32;
const files = new Map([['C:\\INDEX.DAT', new Uint8Array(0)], ['C:\\FONT.TTF', new Uint8Array([1, 2, 3])]]);
const p = Object.create(Process.prototype);
p.mem = new WebAssembly.Memory({ initial: 256 });
let top = 0x1000, hn = 0x100; const handles = new Map();
Object.assign(p, {
  fs: { readFile: n => files.get(n).slice(), writeFile: (n, b) => files.set(n, Uint8Array.from(b)) },
  handles, obj: h => handles.get(h) || null, newHandle(o) { handles.set(hn, o); return hn++; },
  alloc(n) { const b = top; top += (n + 15) & ~15; return b; }, free() {},
});
const fh = p.newHandle({ kind: 'file', path: 'C:\\INDEX.DAT', fd: 1 });
const mh = K.CreateFileMappingA[1].call(p, fh, 0, 4, 0, 0x4000, 0);   // (PAGE_READWRITE, 16 KiB of a file of none)
const v = K.MapViewOfFile[1].call(p, mh, 2, 0, 0, 0);
assert.ok(v, 'a view');
assert.equal(files.get('C:\\INDEX.DAT').length, 0x4000, 'the file grown to the mapping\'s size');
K.CloseHandle[1].call(p, mh);                                         // (WININET closes the handle and keeps the view)
p.u8.set([0x43, 0x6c, 0x69], v); p.u8[v + 0x30] = 0x40;
K.UnmapViewOfFile[1].call(p, v);
const f = files.get('C:\\INDEX.DAT');
assert.deepEqual([...f.slice(0, 3)], [0x43, 0x6c, 0x69], 'the header the view was written with, on the disk');
assert.equal(f[0x30], 0x40);
// a read-only mapping is never written back
const rh = p.newHandle({ kind: 'file', path: 'C:\\FONT.TTF', fd: 2 });
const rm = K.CreateFileMappingA[1].call(p, rh, 0, 2, 0, 0, 0), rv = K.MapViewOfFile[1].call(p, rm, 4, 0, 0, 0);
p.u8[rv] = 9; K.UnmapViewOfFile[1].call(p, rv); K.CloseHandle[1].call(p, rm);
assert.deepEqual([...files.get('C:\\FONT.TTF')], [1, 2, 3], 'a read-only mapping leaves its file');
console.log('mapwriteback: ok');
