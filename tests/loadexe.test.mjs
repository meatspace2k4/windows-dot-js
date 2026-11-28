// LoadLibrary of a program (a PE image without IMAGE_FILE_DLL, named .EXE) maps it as a module whose entry point is
// never called, as Windows 95 loads one for its resources (win32.js diskDll). RSABASE's DllRegisterServer loads
// SIGRES.EXE for its signature on Windows 95 OSR 2.5's first start; refused, it said "CAPI: The install program could
// not open signature file", Internet Explorer 4's components were not installed, and IE4WZD called the old ADVPACK's
// missing RegInstall and faulted
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const image = dll => {   // a PE image: MZ, PE at 40h, its characteristics, preferred base 1000000h, size 6000h, entry 1413h
  const f = new Uint8Array(0x200), dv = new DataView(f.buffer); f[0] = 0x4d; f[1] = 0x5a; dv.setUint32(0x3c, 0x40, true);
  dv.setUint32(0x40, 0x4550, true); dv.setUint16(0x40 + 22, dll ? 0x2102 : 0x0102, true);
  const opt = 0x40 + 24; dv.setUint32(opt + 16, 0x1413, true); dv.setUint32(opt + 28, 0x1000000, true); dv.setUint32(opt + 56, 0x6000, true);
  return f;
};
const files = { 'C:\\WINDOWS\\SYSTEM\\SIGRES.EXE': image(false), 'C:\\WINDOWS\\SYSTEM\\RSAENH.DLL': image(true), 'C:\\WINDOWS\\SYSTEM\\PROG.DLL': image(false) };
const p = Object.assign(Object.create(P), {
  fs: { readFile: n => { const f = files[n.toUpperCase()]; if (!f) throw new Error('no file'); return f; } },
  dlls: new Map(), imageRoom: pref => pref, inExeZone: () => false, vmTake: () => 0, moduleSpans: () => [],
});
const exe = p.diskDll('SIGRES.EXE');
assert.ok(exe, 'a program LoadLibrary names is mapped');
assert.equal(exe.meta.entry, 0, 'its entry point is never called');
assert.equal(p.diskDll('RSAENH').meta.entry, 0x1000000 + 0x1413, 'a DLL\'s is');
assert.equal(p.diskDll('PROG'), null, 'a program by a DLL\'s name is no DLL');
console.log('loadexe: ok');
