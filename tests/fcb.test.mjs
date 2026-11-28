// INT 21h's FCB file calls (0Fh open, 10h close, 13h delete, 14h/15h sequential read and write, 16h create, 17h rename,
// 21h/22h random read and write, 23h size, 24h set random record, 27h/28h random block), as MS-DOS 7 answers them:
// Windows 95 OSR2 Setup's SUWIN creates a file with 16h after User Information, and stopped on "unhandled int 21h
// ax=1615"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, { FileSystem } = window.W95FS;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x40000) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ds', 'es', 'cf']) p.cpu[r] = { value: 0 };
p.vxdFlat = true; p.dosFiles = new Map();
p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24 }); p.fs.mkdir('C:\\SETUP', { recursive: true }); p.fs.chdir('C:\\SETUP');
const FCB = 0x1000, DTA = 0x2000, al = () => p.cpu.eax.value & 0xff;
p.dta = DTA;
const fcb = (name, ext, attr) => {   // an extended FCB when attr is given; drive 0 (the current one)
  p.u8.fill(0, FCB, FCB + 44); let f = FCB;
  if (attr !== undefined) { p.u8[FCB] = 0xff; p.u8[FCB + 6] = attr; f += 7; }
  p.u8.fill(0x20, f + 1, f + 12); [...name].forEach((c, i) => { p.u8[f + 1 + i] = c.charCodeAt(0); }); [...ext].forEach((c, i) => { p.u8[f + 9 + i] = c.charCodeAt(0); });
  return f;
};
const call = (ax, cx = 0) => { p.cpu.eax.value = ax; p.cpu.ecx.value = cx; p.cpu.edx.value = FCB; p.cpu.cf.value = 0; return p.dosNames(ax >> 8, false); };
const text = (s, n = 128) => { const b = new Uint8Array(n); [...s].forEach((c, i) => { b[i] = c.charCodeAt(0); }); return b; };

// create (SUWIN's call, AX 1615h), write two records, close
let f = fcb('SETUPLOG', 'TXT');
call(0x1615); assert.equal(al(), 0, 'created');
assert.equal(p.r16(f + 0x0e), 0x80, 'records of 128 bytes'); assert.equal(p.r32(f + 0x10), 0, 'empty');
p.u8.set(text('first'), DTA); call(0x1500); assert.equal(al(), 0);
p.u8.set(text('second'), DTA); call(0x1500); assert.equal(al(), 0);
assert.equal(p.u8[f + 0x20], 2, 'the current record advanced'); assert.equal(p.r32(f + 0x10), 256, 'the size in the FCB');
call(0x1000); assert.equal(al(), 0);
assert.equal(p.fs.stat('C:\\SETUP\\SETUPLOG.TXT').size, 256, 'on disk');
// open and read back, sequentially and at random
f = fcb('SETUPLOG', 'TXT'); call(0x0f00); assert.equal(al(), 0, 'opened'); assert.equal(p.r32(f + 0x10), 256);
call(0x1400); assert.equal(al(), 0); assert.equal(String.fromCharCode(...p.u8.subarray(DTA, DTA + 5)), 'first');
call(0x1400); assert.equal(al(), 0); assert.equal(String.fromCharCode(...p.u8.subarray(DTA, DTA + 6)), 'second');
call(0x1400); assert.equal(al(), 1, 'end of file');
p.w32(f + 0x21, 1); call(0x2100); assert.equal(al(), 0); assert.equal(String.fromCharCode(...p.u8.subarray(DTA, DTA + 6)), 'second', 'random record 1');
p.w32(f + 0x21, 0); call(0x2700, 2); assert.equal(al(), 0); assert.equal(p.cpu.ecx.value & 0xffff, 2, 'two records in a block');
assert.equal(String.fromCharCode(...p.u8.subarray(DTA + 128, DTA + 134)), 'second'); assert.equal(p.r32(f + 0x21), 2, 'the random record moved on');
call(0x2400); assert.equal(p.r32(f + 0x21), 2, 'set random record: the current one');
call(0x1000);
// size, rename, delete, an extended FCB
fcb('SETUPLOG', 'TXT'); call(0x2300); assert.equal(al(), 0); assert.equal(p.r32(FCB + 0x21), 2, 'size in records');
f = fcb('SETUPLOG', 'TXT'); [...'SETUPLOGOLD'].forEach((c, i) => { p.u8[f + 0x11 + i] = c.charCodeAt(0); });
call(0x1700); assert.equal(al(), 0); assert.ok(p.fs.stat('C:\\SETUP\\SETUPLOG.OLD'), 'renamed');
fcb('SETUPLOG', 'OLD', 0); call(0x1300); assert.equal(al(), 0, 'deleted through an extended FCB');
assert.throws(() => p.fs.stat('C:\\SETUP\\SETUPLOG.OLD'), /cannot find/, 'gone');
fcb('NOSUCH  ', 'TXT'); call(0x0f00); assert.equal(al(), 0xff, 'no file: AL FFh');
assert.equal(p.cpu.cf.value, 0, 'FCB calls leave the carry');
console.log('fcb: ok');
