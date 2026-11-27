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
// (access denied for a Win16 task's own MKDIR, as MS-DOS answers it; other callers (ring 0's, a flat call as here) get
// the file system's code, 183: mapping every call's code made Explorer fault while Windows 98 Setup ran, 8344069)
assert.deepEqual(call(0x39, 'C:\\WINDOWS'), [1, 183], 'MKDIR of a folder that is there, not a task\'s: the file system\'s code');
assert.match(readFileSync(new URL('../ne16.js', import.meta.url), 'utf8'), /case 0x39: \{ const full = this\.dosFull\(this\.readA\(dsdx\(\)\)\); if \(!lfn && !this\.vxdFlat && this\.thread16 && this\.thread16\.task && this\.fs\.exists\(full\)\) return fail\(5\);/, 'a Win16 task\'s own MKDIR of a folder that is there: access denied');
assert.deepEqual(call(0x39, 'C:\\NEW'), [0, 0x3900], 'MKDIR of a new folder');
assert.ok(p.fs.stat('C:\\NEW').isDir);
// a function past MS-DOS 7's last (NetWare's DCh, its connection number, which Windows 98 Setup asks for): AL 0, the
// program going on, as DOS's dispatcher answers one it lacks
{
  const { INTS } = window.W95NE16;
  p.cpu.eax.value = 0xdc55; const r = INTS[0x21].call(p);
  assert.notEqual(r, window.W95Win32.LAYOUT.SENTINEL, 'not a stop'); assert.equal(p.cpu.eax.value & 0xffff, 0xdc00, 'AL 0: no NetWare connection');
}
// a write of 0 bytes (INT 21h AH=40h, CX 0) ends the file where it is: a file rewritten shorter in place keeps none
// of its old end (Windows 98 Setup's AUTOEXEC.BAT)
{
  const { INTS } = window.W95NE16;
  p.dosFiles = p.dosFiles || new Map(); p.nextDosFile = 5;
  p.fs.writeFile('C:\\AUTOEXEC.BAT', new TextEncoder().encode('0123456789'));
  p.writeA(0x1000, 'C:\\AUTOEXEC.BAT'); p.cpu.edx.value = 0x1000; p.cpu.eax.value = 0x3d02; INTS[0x21].call(p);
  assert.equal(p.cpu.cf.value, 0, `opened (${(p.cpu.eax.value & 0xffff).toString(16)})`);
  const h = p.cpu.eax.value & 0xffff;
  p.writeA(0x1100, 'abc'); p.cpu.ebx.value = h; p.cpu.ecx.value = 3; p.cpu.edx.value = 0x1100; p.cpu.eax.value = 0x4000; INTS[0x21].call(p);
  assert.deepEqual([p.cpu.cf.value, p.cpu.eax.value & 0xffff], [0, 3], 'the 3-byte write');
  p.cpu.ebx.value = h; p.cpu.ecx.value = 0; p.cpu.eax.value = 0x4000; INTS[0x21].call(p);
  assert.equal(p.cpu.cf.value, 0, `the 0-byte write (${(p.cpu.eax.value & 0xffff).toString(16)})`);
  p.cpu.ebx.value = h; p.cpu.eax.value = 0x3e00; INTS[0x21].call(p);
  assert.equal(new TextDecoder().decode(p.fs.readFile('C:\\AUTOEXEC.BAT')), 'abc', 'the file ends after what was written');
}
console.log('doserrors: ok');
