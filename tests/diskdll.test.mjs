// A Win32 program whose DLL is a file on disk, not one of the system bundle's (Paint and WordPad: MFC30.DLL): the
// loader maps the DLL from its file and binds the program's imports to its exports, by ordinal from the export table's
// base (MFC30's is 268). Bound to nothing, every MFC30 import was a dead thunk; the first call faulted and the fault's
// handling ran garbage until the system's machine stopped. And an image's room is looked for around the 16-bit
// modules' segments too: their records have no size, so USER's code at 1A00000h looked free and was written over.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

// a PE image: headers in 200h, one section at RVA 1000h (file 200h) holding what `fill` writes there
function pe({ dll, pref, fill, ch = 0x60000020 }) {
  const f = new Uint8Array(0x400), dv = new DataView(f.buffer);
  f[0] = 0x4d; f[1] = 0x5a; dv.setUint32(0x3c, 0x80, true);
  dv.setUint32(0x80, 0x4550, true); dv.setUint16(0x84, 0x14c, true); dv.setUint16(0x86, 1, true); dv.setUint16(0x94, 0xe0, true);
  dv.setUint16(0x96, (dll ? 0x2000 : 0) | 0x0102 | 1, true);   // (relocations stripped: placed at its base or nowhere)
  const opt = 0x98; dv.setUint16(opt, 0x10b, true); dv.setUint32(opt + 16, 0, true); dv.setUint32(opt + 28, pref, true);
  dv.setUint32(opt + 32, 0x1000, true); dv.setUint32(opt + 36, 0x200, true); dv.setUint32(opt + 56, 0x2000, true); dv.setUint32(opt + 60, 0x200, true);
  dv.setUint32(opt + 92, 16, true);
  const sh = opt + 0xe0; f.set([0x2e, 0x74, 0x65, 0x78, 0x74], sh); dv.setUint32(sh + 8, 0x200, true); dv.setUint32(sh + 12, 0x1000, true);
  dv.setUint32(sh + 16, 0x200, true); dv.setUint32(sh + 20, 0x200, true); dv.setUint32(sh + 36, ch, true);
  fill(dv, opt, x => 0x200 + (x - 0x1000));   // (an RVA in the section to its file offset)
  return f;
}
// the DLL: exports from ordinal 268, its #287 the 20th, at RVA 1100h
const lib = pe({ dll: true, pref: 0x00700000, fill: (dv, opt, at) => {
  dv.setUint32(opt + 96, 0x1000, true); dv.setUint32(opt + 100, 0x100, true);
  const e = at(0x1000); dv.setUint32(e + 16, 268, true); dv.setUint32(e + 20, 20, true); dv.setUint32(e + 24, 0, true); dv.setUint32(e + 28, 0x1040, true);
  dv.setUint32(at(0x1040) + 4 * 19, 0x1100, true);
} });
// the program: imports TESTLIB.DLL's #287 by ordinal
const exe = pe({ dll: false, pref: 0x00400000, fill: (dv, opt, at) => {
  dv.setUint32(opt + 104, 0x1000, true); dv.setUint32(opt + 108, 40, true);
  const d = at(0x1000); dv.setUint32(d, 0x1080, true); dv.setUint32(d + 12, 0x1060, true); dv.setUint32(d + 16, 0x10a0, true);
  'TESTLIB.DLL'.split('').forEach((c, i) => dv.setUint8(at(0x1060) + i, c.charCodeAt(0)));
  dv.setUint32(at(0x1080), 0x80000000 | 287, true); dv.setUint32(at(0x10a0), 0x80000000 | 287, true);
} });

function machine(files) {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(0x2400000) }; p.dlls = new Map(); p.modules = []; p.byName = new Map(); p.inits = [];
  p.fs = { readFile: path => { const f = files[path.toUpperCase()]; if (!f) throw new Error('no ' + path); return f; } };
  p.thunks = []; p.thunkFor = (dll, nm) => { p.thunks.push(dll + '!' + nm); return 0xdead0000 + p.thunks.length; };
  return p;
}
// (a 16-bit module, as ne16.js keeps one: segments and no size; USER's code at 1A00000h)
const user16 = { name: 'USER', base: 0x01a00000, segs: [{ base: 0x01a00000, alloc: 0x12e2 }, { base: 0x01a62ce0, alloc: 0x1337 }], meta: { textLo: 0, textHi: 0 } };

{ // the import bound to the DLL's export, mapped from its file
  const p = machine({ 'C:\\WINDOWS\\SYSTEM\\TESTLIB.DLL': lib });
  const rec = p.loadImage(exe, null, { base: 0x00400000, entry: 0, textLo: 0, textHi: 0, blocks: [] }, 'EXE');
  const testlib = p.byName.get('TESTLIB');
  assert.ok(testlib, 'the DLL on disk is loaded');
  assert.equal(testlib.base, 0x00700000, 'at the base its header prefers, nothing there');
  assert.deepEqual(p.thunks, [], 'no dead thunk');
  assert.equal(p.r32(rec.base + 0x10a0) >>> 0, 0x00700000 + 0x1100, 'the IAT holds #287: the 20th export from base 268');
  assert.ok(rec.deps.includes(testlib), 'the program depends on it (its DllMain runs as the program starts)');
  assert.deepEqual([...testlib.importers.get('#287')], ['EXE'], 'who imports the ordinal: cmd watch\'s name for an export without one');
}
{ // a DLL on no disk and implemented nowhere: the image is not loaded, as Windows refuses it
  const p = machine({});
  assert.throws(() => p.loadImage(exe, null, { base: 0x00400000, entry: 0, textLo: 0, textHi: 0, blocks: [] }, 'EXE'), e => e.missingDll === 'TESTLIB.DLL');
  assert.equal(p.modules.length, 0, 'nothing of it left mapped'); assert.deepEqual(p.thunks, []);
}
{ // a DLL this system implements (the personality's: KERNEL32) is never loaded from a file of that name
  const p = machine({ 'C:\\WINDOWS\\SYSTEM\\KERNEL32.DLL': lib });
  assert.equal(p.loadDll('KERNEL32'), null);
}
{ // room: not over a 16-bit module's segments
  const p = machine({}); p.modules.push(user16);
  assert.equal(p.imageRoom(0x01a00000, 0x10000, false), 0, 'USER\'s code is not free for an image that cannot move');
  const b = p.imageRoom(0x01a00000, 0x10000, true);
  assert.ok(b && (b + 0x10000 <= 0x01a00000 || b >= 0x01a62ce0 + 0x1337), 'one that can move goes elsewhere');
  p.modules.push({ name: 'X', base: 0x00620000, size: 0x30000, meta: {} });
  assert.equal(p.imageRoom(0x00620000, 0x10000, true), 0x00650000, 'past a PE image too');
}
// a private-arena DLL's writable data is each process's own (OLE32's: Explorer's "classes registered" state was Paint's
// too, Paint's OleInitialize made no class and failed); a shared-arena DLL's (based at 80000000h and up), or a section
// marked shared, is one copy
{
  const dllAt = (pref, ch) => pe({ dll: true, pref, ch, fill: () => {} });
  const p = machine({ 'C:\\WINDOWS\\SYSTEM\\PRIV.DLL': dllAt(0x00700000, 0xc0000040), 'C:\\WINDOWS\\SYSTEM\\SHRD.DLL': dllAt(0x00720000, 0xd0000040) });
  const priv = p.loadDll('PRIV'), shrd = p.loadDll('SHRD'), at = priv.base + 0x1000, st = shrd.base + 0x1000;
  assert.ok(priv.priv && !shrd.priv, 'writable, unshared: per process; marked shared: one copy');
  const A = { pid: 1 }, B = { pid: 2 };
  p.thread16 = { pc: A }; p.attach(priv); p.w32(at, 0xaaaa); p.w32(st, 0x1111);
  p.thread16 = { pc: B }; p.attach(priv);
  assert.equal(p.r32(at), 0, 'the second process attaches to the data as loaded'); p.w32(at, 0xbbbb); p.w32(st, 0x2222);
  p.dllUse(A); assert.equal(p.r32(at), 0xaaaa, 'the first process\'s own again as its thread runs');
  p.dllUse(B); assert.equal(p.r32(at), 0xbbbb);
  assert.equal(p.r32(st), 0x2222, 'the shared section is one copy');
  p.dllForget(B); const C = { pid: 3 }; p.thread16 = { pc: C }; p.attach(priv);
  assert.equal(p.r32(at), 0, 'a process after one that ended gets the data as loaded'); p.dllUse(A); assert.equal(p.r32(at), 0xaaaa);
  // (a shared-arena DLL, its header's base BFF70000h, mapped lower here as the bundle maps KERNEL32: one copy)
  const k = machine({}).loadImage(dllAt(0xbff70000, 0xc0000040), null, { base: 0x00780000, entry: 0, textLo: 0, textHi: 0, blocks: [] }, 'KRNL');
  assert.ok(!k.priv, 'a shared-arena DLL\'s data is one copy');
}
console.log('diskdll: ok');
