// A file's dates are set: KERNEL32 SetFileTime (FILETIMEs) and INT 21h AX=5701h (a DOS time and date), as SETUPX gives
// each file it extracts its cabinet's date. Both were no-ops: every file Setup copied was dated the day of its copy, and
// BonziBUDDY's Installer VISE, which compares dates, kept OSR 2.5's OLEAUT32.DLL of 1996 over its own newer one, and
// BonziBUDDY said "The file 'OLEAUT32.DLL' is out of date"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, { FileSystem } = window.W95FS, { INTS } = window.W95NE16;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x40000) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ds', 'es', 'cf']) p.cpu[r] = { value: 0 };
p.vxdFlat = true;
p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24 });
p.fs.writeFile('C:\\OLEAUT32.DLL', new Uint8Array(4));
// (1) SetFileTime: its write time 1996-12-01 12:00 UTC, a FILETIME
const fd = p.fs.open('C:\\OLEAUT32.DLL', 'r+'), want = Date.UTC(1996, 11, 1, 12), ft = BigInt(want) * 10000n + 116444736000000000n;
p.w32(0x2000, Number(ft & 0xffffffffn)); p.w32(0x2004, Number(ft >> 32n));
p.obj = h => (h === 7 ? { kind: 'file', fd } : null);
assert.equal(API.KERNEL32.SetFileTime[1].call(p, 7, 0, 0, 0x2000), 1);
assert.equal(p.fs.fstat(fd).mtime, want, 'SetFileTime: the write time given');
// (2) INT 21h 5701h on a DOS handle: 1997-07-11 08:30:10, local, then read back with 5700h
p.dosFiles = new Map(); p.nextDosFile = 5;
p.writeA(0x1000, 'C:\\OLEAUT32.DLL'); p.cpu.edx.value = 0x1000; p.cpu.eax.value = 0x3d02; INTS[0x21].call(p);
assert.equal(p.cpu.cf.value, 0, 'opened'); const h = p.cpu.eax.value & 0xffff;
const t = (8 << 11) | (30 << 5) | 5, d = ((1997 - 1980) << 9) | (7 << 5) | 11;
p.cpu.ebx.value = h; p.cpu.ecx.value = t; p.cpu.edx.value = d; p.cpu.eax.value = 0x5701; INTS[0x21].call(p);
assert.equal(p.cpu.cf.value, 0, '5701h done');
p.cpu.ecx.value = 0; p.cpu.edx.value = 0; p.cpu.eax.value = 0x5700; INTS[0x21].call(p);
assert.deepEqual([p.cpu.ecx.value & 0xffff, p.cpu.edx.value & 0xffff], [t, d], '5700h reads the date 5701h set');
console.log('setfiletime: ok');
