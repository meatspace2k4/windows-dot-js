// INT 21h AH=44h with a subfunction MS-DOS 7 has no table entry for (past 11h, or one no device here takes): invalid
// function (1) with carry, as DOS's IOCTL dispatcher answers, the program going on. Windows 98 Setup's SUWIN issues
// 44E0h while it saves the system files; stopped on it ("unhandled int 21h ax=44e0"), Setup ended there
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { FileSystem } = window.W95FS, { INTS } = window.W95NE16;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x40000) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ds', 'es', 'cf']) p.cpu[r] = { value: 0 };
p.vxdFlat = true; p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24 }); p.dosFiles = new Map();
const ioctl = (ax, bx = 0, cx = 0) => { p.cpu.eax.value = ax; p.cpu.ebx.value = bx; p.cpu.ecx.value = cx; p.cpu.cf.value = 0; p.trapped = null; const r = INTS[0x21].call(p); return { stop: r === LAYOUT.SENTINEL || !!p.trapped, cf: p.cpu.cf.value, ax: p.cpu.eax.value & 0xffff }; };
assert.deepEqual(ioctl(0x44e0), { stop: false, cf: 1, ax: 1 }, '44E0h: invalid function, not a stop');
assert.deepEqual(ioctl(0x4412), { stop: false, cf: 1, ax: 1 }, '4412h: past the table');
// the ones answered stay as they were
assert.deepEqual(ioctl(0x4408, 3), { stop: false, cf: 0, ax: 1 }, '4408h: C: is fixed');
assert.deepEqual(ioctl(0x440e, 3), { stop: false, cf: 0, ax: 0x4400 }, '440Eh: one letter per drive');
// a device handle's IOCTL still reaches the device: IFSHLP's control data (4402h with its signature at DS:DX), which
// IFSMGR reads as it connects at boot (answered invalid function once, IFSMGR stopped Windows: "cannot connect to the
// helper driver"), and a character device's information (4400h)
p.dosFiles.set(7, { dev: true, name: 'IFS$HLP$' }); p.ifsHlp = { seg: 0x1234, lin: 0x12340, entry: 0x20c };
p.w16(0x3000, 0xe970); p.w16(0x3002, 0x3735); p.cpu.edx.value = 0x3000;
assert.deepEqual(ioctl(0x4402, 7, 8), { stop: false, cf: 0, ax: 8 }, '4402h to the helper: its control data');
assert.deepEqual([p.r16(0x3004), p.r16(0x3006)], [0x20c, 0x1234], 'the helper\'s entry point');
p.cpu.edx.value = 0; assert.deepEqual(ioctl(0x4400, 7), { stop: false, cf: 0, ax: 0x4400 }, '4400h on a device'); assert.equal(p.cpu.edx.value & 0xffff, 0xc080, 'a character device');
console.log('ioctlunknown: ok');
