// A module loaded over another's image takes those bytes: the other module's translations of that range go, so what
// runs there is what is in memory now (dyn.js), as a processor runs what is there, and the rest of its code keeps them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 20) };
const meta = { textLo: 0x10000, textHi: 0x10100, lookup: 0x80000 }, look = new Uint32Array(p.mem.buffer, meta.lookup, 0x100);
look.fill(7);
const shell = { name: 'SHELL32', meta }, avi = { name: 'MCIAVI', kind: 'ne', meta: { textLo: 0x10040, textHi: 0x10080, lookup: 0x90000 } };
p.modules = [shell, avi];
p.smcRange(0x10040, 0x10080, avi);
assert.deepEqual([look[0x3f], look[0x40], look[0x7f], look[0x80]], [7, 0, 0, 7], 'only the range written over loses its translations');
console.log('loadoverlap: ok');
