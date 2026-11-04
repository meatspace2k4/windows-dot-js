// A call the personality's DLL here does not implement does what that DLL's own file does when the file's export is
// the system's common stub: Windows 98's ADVAPI32 exports IsTextUnicode (and its NT-only calls) as
// `xor eax,eax; mov cl,N; jmp KERNEL32!#17`, CommonUnimpStub, which sets ERROR_CALL_NOT_IMPLEMENTED, returns by N's
// high nibble and pops N's low nibble of arguments. This ADVAPI32 lacked IsTextUnicode; Windows 98's SETUPAPI imports
// it, its thunk was dead, and Explorer's first start faulted at the thunk's address (FFFF0830).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;

// ADVAPI32.DLL: headers in 200h, one section at RVA 1000h (file 200h); base BFE80000h as Windows 98's
const BASE = 0xbfe80000, f = new Uint8Array(0x400), dv = new DataView(f.buffer), at = r => 0x200 + r - 0x1000;
f[0] = 0x4d; f[1] = 0x5a; dv.setUint32(0x3c, 0x80, true);
dv.setUint32(0x80, 0x4550, true); dv.setUint16(0x84, 0x14c, true); dv.setUint16(0x86, 1, true); dv.setUint16(0x94, 0xe0, true); dv.setUint16(0x96, 0x2102, true);
const opt = 0x98; dv.setUint16(opt, 0x10b, true); dv.setUint32(opt + 28, BASE, true); dv.setUint32(opt + 56, 0x2000, true); dv.setUint32(opt + 92, 16, true);
dv.setUint32(opt + 96, 0x1000, true); dv.setUint32(opt + 100, 0x100, true); dv.setUint32(opt + 104, 0x1100, true); dv.setUint32(opt + 108, 40, true);
const sh = opt + 0xe0; dv.setUint32(sh + 8, 0x200, true); dv.setUint32(sh + 12, 0x1000, true); dv.setUint32(sh + 16, 0x200, true); dv.setUint32(sh + 20, 0x200, true);
const names = [['IsTextUnicode', 0x1180], ['W98Flag', 0x1190], ['W98Real', 0x11a0], ['W98Other', 0x11b0]];
const e = at(0x1000); dv.setUint32(e + 16, 1, true); dv.setUint32(e + 20, 4, true); dv.setUint32(e + 24, 4, true); dv.setUint32(e + 28, 0x1040, true); dv.setUint32(e + 32, 0x1060, true); dv.setUint32(e + 36, 0x1080, true);
names.forEach(([n, code], i) => {
  const s = 0x10a0 + 0x10 * i; [...n].forEach((c, j) => { f[at(s) + j] = c.charCodeAt(0); });
  dv.setUint32(at(0x1040) + 4 * i, code, true); dv.setUint32(at(0x1060) + 4 * i, s, true); dv.setUint16(at(0x1080) + 2 * i, i, true);
});
// imports: KERNEL32 #17 (CommonUnimpStub) and #18
const d = at(0x1100); dv.setUint32(d, 0x1140, true); dv.setUint32(d + 12, 0x1130, true); dv.setUint32(d + 16, 0x1150, true);
[...'KERNEL32.dll'].forEach((c, j) => { f[at(0x1130) + j] = c.charCodeAt(0); });
for (const t of [0x1140, 0x1150]) { dv.setUint32(at(t), 0x80000011, true); dv.setUint32(at(t) + 4, 0x80000012, true); }
f.set([0x33, 0xc0, 0xb1, 0x03, 0xe9], at(0x1180)); dv.setInt32(at(0x1185), 0x11c0 - 0x1189, true);   // IsTextUnicode: 3 arguments, FALSE
f.set([0x33, 0xc0, 0xb1, 0x14, 0xeb, 0x11c0 - 0x1196], at(0x1190));                                    // 4 arguments, TRUE (a short jump)
f.set([0x55, 0x8b, 0xec, 0x33, 0xc0, 0xc9, 0xc2, 0x04, 0x00], at(0x11a0));                              // its own code: no stub
f.set([0x33, 0xc0, 0xb1, 0xf2, 0xe9], at(0x11b0)); dv.setInt32(at(0x11b5), 0x11c8 - 0x11b9, true);   // through #18: not the stub
f.set([0xff, 0x25], at(0x11c0)); dv.setUint32(at(0x11c2), BASE + 0x1150, true);
f.set([0xff, 0x25], at(0x11c8)); dv.setUint32(at(0x11ca), BASE + 0x1154, true);

// KERNEL32's own stubs jump straight to its #17, no import between (Windows 98's GetVersionExW, LoadLibraryW): the same
// file as KERNEL32.DLL, its ordinals from 14 so that W98Other at 11B0h is #17, IsTextUnicode jumping there
const k32 = f.slice(), kv = new DataView(k32.buffer);
kv.setUint32(at(0x1000) + 16, 14, true); kv.setInt32(at(0x1185), 0x11b0 - 0x1189, true);
const p = Object.create(Process.prototype);
p.thunks = []; p.thunkByName = new Map();
p.fs = { readFile: path => { const u = path.toUpperCase(); if (u === 'C:\\WINDOWS\\SYSTEM\\ADVAPI32.DLL') return f; if (u === 'C:\\WINDOWS\\SYSTEM\\KERNEL32.DLL') return k32; throw new Error('no ' + path); } };
assert.ok(!API.KERNEL32.IsTextUnicode);
const ks = p.importDef('KERNEL32', 'IsTextUnicode');
assert.ok(ks && ks[0] === 3 && ks[1].call({}) === 0, 'KERNEL32\'s own stub: a jump to its #17');
assert.equal(p.importDef('KERNEL32', 'W98Real'), undefined, 'KERNEL32\'s own code is no stub');
assert.ok(API.ADVAPI32 && !API.ADVAPI32.IsTextUnicode, 'this ADVAPI32 does not implement IsTextUnicode');

const t = p.thunks[(p.thunkFor('ADVAPI32', 'IsTextUnicode') - window.W95Win32.LAYOUT.THUNK) >> 2];
assert.ok(t.def, 'not a dead thunk');
assert.equal(t.def[0], 3, 'three arguments popped');
const g = { lastError: 0 };
assert.equal(t.def[1].call(g), 0, 'FALSE');
assert.equal(g.lastError, 120, 'ERROR_CALL_NOT_IMPLEMENTED');
const flag = p.importDef('ADVAPI32', 'W98Flag');
assert.equal(flag[0], 4); assert.equal(flag[1].call({}), 1, 'the high nibble 1: TRUE');
assert.equal(p.importDef('ADVAPI32', '#2')[0], 4, 'by ordinal');
assert.equal(p.importDef('ADVAPI32', 'W98Real'), undefined, 'an export with its own code is not a stub');
assert.equal(p.importDef('ADVAPI32', 'W98Other'), undefined, 'a jump through another import is not the stub');
assert.equal(p.importDef('ADVAPI32', 'RegOpenKeyA'), API.ADVAPI32.RegOpenKeyA, 'a call implemented here is that one');
assert.equal(p.importDef('NOTHERE', 'IsTextUnicode'), undefined, 'only for a DLL implemented here');
console.log('unimpstub: ok');
