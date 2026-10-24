// VWIN32_SysErrorBox (IFSMGR's system error box: a drive not ready, a disk to insert) shows nothing here; it answered
// 0 as though a button had been chosen, with a console line, and IFSMGR went on with an answer nobody gave. It stops
// as a service that is not here does, naming the box.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, INTS = window.W95NE16.INTS, { LAYOUT } = window.W95Win32;
const mem = new Uint8Array(1 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
const str = (a, s) => { for (let i = 0; i < s.length; i++) mem[a + i] = s.charCodeAt(i); mem[a + s.length] = 0; };
Object.assign(p, { r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), vxdById: () => null,
  readA: a => { let s = ''; while (mem[a]) s += String.fromCharCode(mem[a++]); return s; } });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'esp', 'cf', 'zf'].map(n => [n, { value: 0 }]));
// the VSEB in EBX: response, buttons 3, 2, 1, caption, text
const VSEB = 0x4000; str(0x5000, 'Error'); str(0x5100, 'There is no disk in drive A.');
dv.setUint32(VSEB + 12, 0x5000, true); dv.setUint32(VSEB + 16, 0x5100, true);
p.cpu.ebx.value = VSEB; p.cpu.esp.value = 0x8000;
dv.setUint32(0x1002, 0x002a001a, true);
assert.equal(INTS[0x20].call(p, 0x1006), LAYOUT.SENTINEL, 'it stops');
assert.match(p.trapped, /VWIN32_SysErrorBox: Error: There is no disk in drive A\./, 'naming the box');
console.log('syserrorbox: ok');
