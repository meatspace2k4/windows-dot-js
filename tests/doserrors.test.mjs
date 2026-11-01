// INT 21h's errors as MS-DOS gives them, not the file system's Win32 codes: MKDIR of a folder that is there and RMDIR
// of one that is not empty answer 5 (access denied). Given 183 (ERROR_ALREADY_EXISTS) for MKDIR of C:\WINDOWS, Windows
// 98 Setup stopped with "Setup cannot create C:\WINDOWS" (SU0343)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, { FileSystem } = window.W95FS;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x40000) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ds', 'es', 'cf']) p.cpu[r] = { value: 0 };
p.vxdFlat = true;   // (offsets are linear addresses: no segments to set up)
p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24 }); p.fs.mkdir('C:\\WINDOWS', { recursive: true });
p.fs.writeFile('C:\\WINDOWS\\WIN.INI', new Uint8Array(4));
const call = (ah, path) => { p.writeA(0x1000, path); p.cpu.edx.value = 0x1000; p.cpu.eax.value = ah << 8; p.cpu.cf.value = 0; p.dosNames(ah, false); return [p.cpu.cf.value, p.cpu.eax.value & 0xffff]; };
assert.deepEqual(call(0x39, 'C:\\WINDOWS'), [1, 5], 'MKDIR of a folder that is there: access denied');
assert.deepEqual(call(0x3a, 'C:\\WINDOWS'), [1, 5], 'RMDIR of a folder that is not empty: access denied');
assert.deepEqual(call(0x39, 'C:\\NEW'), [0, 0x3900], 'MKDIR of a new folder');
assert.ok(p.fs.stat('C:\\NEW').isDir);
console.log('doserrors: ok');
