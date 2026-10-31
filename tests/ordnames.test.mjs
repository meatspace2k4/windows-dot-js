// cmd('watch') names a DLL's exports by ordinal (MFC30's have no names) from a .def or .map file beside it, looked for
// where its loader looks: EXPORTS lines "name @n" of a .def, the "ordinal name" lines of a .map's exports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = w.indexOf('  ordNames(m) {'), j = w.indexOf('  isNE(file) {');
assert.ok(i >= 0 && j > i, 'ordNames');
const files = {
  'C:\\WINDOWS\\SYSTEM\\MFC30.DEF': 'LIBRARY MFC30\r\nEXPORTS\r\n  ?SetModifiedFlag@CDocument@@QAEXH@Z @ 1599 NONAME\r\n  AfxGetApp=_AfxGetApp@0 @268\r\n; a comment @1\r\nSECTIONS\r\n  .data @5\r\n',
  'C:\\APPS\\MFCO30.MAP': ' Exports\r\n\r\n  ordinal    name\r\n\r\n      268    ?Foo@@YAXXZ (?Foo@@YAXXZ)\r\n      300    ?Bar@@YAXXZ\r\n',
};
const fs = { readFile: f => { if (!(f in files)) throw new Error('no ' + f); return f; } };
const W95FS = { decode: f => files[f] };
const M = new Function('fs', 'W95FS', `return class { ${w.slice(i, j)} }`)(fs, W95FS);
const m = new M(); m.proc = { procs: new Map([[1, { path: 'C:\\APPS\\PAINT.EXE' }]]) };
assert.deepEqual([...m.ordNames({ name: 'MFC30' })], [[1599, '?SetModifiedFlag@CDocument@@QAEXH@Z'], [268, 'AfxGetApp']]);
assert.deepEqual([...m.ordNames({ name: 'MFCO30' })], [[268, '?Foo@@YAXXZ'], [300, '?Bar@@YAXXZ']], 'a .map in the program\'s folder');
assert.equal(m.ordNames({ name: 'MFCANS32' }).size, 0, 'neither: the ordinal and its importers name it');
console.log('ordnames: ok');
