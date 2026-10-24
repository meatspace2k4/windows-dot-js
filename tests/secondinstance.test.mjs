// A second instance of a running program is laid out over the first's image on purpose (P.spawn: one image as code,
// each process's data put by in turn); the loader's overlap check holds for every other image. Refused there, the
// second Notepad or Help went nowhere: the page's catch read the load's error as "its place is taken" and started it
// in another machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const BASE = 0x100000, SIZE = 0x2000;
const pe = new Uint8Array(0x200), dv = new DataView(pe.buffer);
pe[0] = 0x4d; pe[1] = 0x5a; dv.setUint32(0x3c, 0x80, true); pe.set([0x50, 0x45, 0, 0], 0x80);
dv.setUint32(0x80 + 24 + 28, BASE, true); dv.setUint32(0x80 + 24 + 56, SIZE, true); dv.setUint32(0x80 + 24 + 60, 0x200, true);
dv.setUint16(0x80 + 20, 0xe0, true);   // (no sections, no directories)
// (a module whose run does nothing)
const mod = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 7, 1, 3, 0x72, 0x75, 0x6e, 0, 0, 10, 4, 1, 2, 0, 0x0b]));
const meta = { base: BASE, entry: 0, lookup: 0x300000, textLo: BASE, textHi: BASE, blocks: [] };

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 22) };
let heap = 0x200000;
Object.assign(p, { modules: [], byName: new Map(), dlls: new Map(), imports: {}, selUsed: new Uint8Array(8192), threadsById: new Map(),
  alloc: n => { const a = heap; heap += n + 15 & ~15; return a; }, allocSels: () => 0x107, newThread: () => ({}) });

const one = p.spawn(pe, mod, meta, 'C:\\WINDOWS\\NOTEPAD.EXE', 'NOTEPAD.EXE');
const two = p.spawn(pe, mod, meta, 'C:\\WINDOWS\\NOTEPAD.EXE', 'NOTEPAD.EXE');
assert.equal(two.exe, one.exe, 'a second instance shares the running one\'s image');
assert.equal(p.modules.filter(m => m.base === BASE).length, 1, 'one image there');
assert.throws(() => p.loadImage(pe, mod, meta, 'OTHER'), /OTHER at 100000 lies over EXE's image/, 'any other image there stops its load');
console.log('secondinstance: ok');
