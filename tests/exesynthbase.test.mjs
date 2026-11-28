// A program with no relocations and no room at its base is placed where there is room, its addresses of itself found
// and moved (worker.js dynProgram, meta.synthRelocs), as a DLL with none is. BonziBUDDY's Peedy.exe, 33F000h bytes
// linked at 1000000h, reaches the system's 16-bit modules at 1100000h, and was "not a valid Win32 application"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = w.indexOf('  dynProgram(file) {'), src = w.slice(i, w.indexOf('\n  }\n', i) + 4);
const fn = new Function('fs', 'W', `return { ${src} }.dynProgram;`);
const img = new Uint8Array(0x200), dv = new DataView(img.buffer);
dv.setUint16(0, 0x5a4d, true); dv.setUint32(0x3c, 0x80, true); dv.setUint32(0x80, 0x4550, true); dv.setUint16(0x80 + 22, 0x010f, true);
const opt = 0x98; dv.setUint32(opt + 16, 0x1000, true); dv.setUint32(opt + 28, 0x1000000, true); dv.setUint32(opt + 56, 0x33f000, true);
const asks = [];
const proc = { imageRoom: (pref, size, reloc, own) => { asks.push([pref, reloc]); return pref === 0x1000000 ? 0 : 0x2000000; } };
const d = fn({ readFile: () => img }, { log() {} }).call({ proc }, 'C:\\PEEDY.EXE');
assert.ok(d, 'placed');
assert.equal(d.meta.base, 0x2000000, 'where there is room');
assert.equal(d.meta.entry, 0x2001000, 'its entry moved with it');
assert.equal(d.meta.synthRelocs, true, 'its addresses of itself found and moved');
assert.deepEqual(asks[0], [0x1000000, false], 'its own base asked first');
console.log('exesynthbase: ok');
