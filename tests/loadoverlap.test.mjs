// A module's image is its own: one whose load base lays it over a loaded module's image stops the load, naming both.
// MCIAVI at 01610000h was laid over SHELL32.DLL's image (01600000h-01662000h), and the machine ran on: SHELL32's
// translations ran as MCIAVI's code and Media Player hung with nothing to say why.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 20) };
p.init16 = () => {};
p.modules = [{ name: 'SHELL32', base: 0x10000, size: 0x62000, meta: { textLo: 0x11000, textHi: 0x61800 } }];
assert.equal(p.imageAt(0x20000, 0x2d5c0).name, 'SHELL32', 'an image inside another\'s is found');
assert.equal(p.imageAt(0x72000, 0x80000), null, 'one clear of it is not');
const meta = { base: 0x20000, size: 0xd5c0, segs: [], fixups: [], exports: {}, names: {} };
assert.throws(() => p.loadNE('MCIAVI', new Uint8Array(0x100), null, meta), /MCIAVI at 20000 lies over SHELL32's image/);
console.log('loadoverlap: ok');
