// A VxDCall of a loaded VxD's service runs that VxD's code: a service written here for a VxD not yet recompiled
// stopped standing in once the VxD itself loaded only where the VMM here takes it over by name (SHELL's appy time
// and broadcasts). SHELL_Message stayed a console line answered OK after SHELL.VXD loaded, so MSSNDSYS, MSOPL,
// ENABLE, VNETBIOS and VCOMM had their messages to the user taken as read without ever showing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, INTS = window.W95NE16.INTS;
const mem = new Uint8Array(1 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, { r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), readA: () => '' });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'esp', 'cf', 'zf'].map(n => [n, { value: 0 }]));
p.cpu.esp.value = 0x8000;
// SHELL.VXD loaded: its DDB's service table (at 3000h) has 20h services, each at 7000h + 10h * n
const DDB = 0x2000, TABLE = 0x3000;
dv.setUint32(DDB + 0x30, TABLE, true); dv.setUint32(DDB + 0x34, 0x20, true);
for (let n = 0; n < 0x20; n++) dv.setUint32(TABLE + 4 * n, 0x7000 + 0x10 * n, true);
p.vxdById = id => id === 0x17 ? { ddb: DDB, file: 'SHELL.VXD' } : null;
p.user16Ready = false; p.appyQueue = [];
const call = n => { p.cpu.esp.value = 0x8000; dv.setUint32(0x1002, 0x00170000 | n, true); return INTS[0x20].call(p, 0x1006); };

assert.equal(call(4), 0x7040, 'SHELL_Message: SHELL.VXD\'s own');
assert.equal(dv.getUint32(0x8000 - 4, true), 0x1006, '... entered by a call, back to after the VxDCall');
assert.equal(call(3), 0x7030, 'SHELL_SYSMODAL_Message: SHELL.VXD\'s own');
assert.equal(call(0x0d), 0x1006, '_SHELL_QueryAppyTimeAvailable: the VMM here takes it over');
// (the system's broadcasts: SHELL.VXD's own, delivered through appy time and _SHELL_CallDll; the stand-in dropped them)
assert.equal(call(0x10), 0x7100, '_SHELL_BroadcastSystemMessage: SHELL.VXD\'s own');
assert.equal(call(0x11), 0x7110, '_SHELL_HookSystemBroadcast: SHELL.VXD\'s own');
assert.equal(call(0x12), 0x7120, '_SHELL_UnhookSystemBroadcast: SHELL.VXD\'s own');
console.log('vxdshadow: ok');
