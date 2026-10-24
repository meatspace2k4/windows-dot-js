// VKD's hot keys: a key a VxD defined as one goes to its callback instead of Windows, unless the callback reflects
// it (VKD_Reflect_Hot_Key), as IFSMGR's Ctrl+C does: then the press and its release go on to Windows, so Ctrl+C
// copies in Notepad. A hot key the callback keeps (REBOOT's Ctrl+Alt+Del) stays with VKD.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, INTS = window.W95NE16.INTS;
const mem = new Uint8Array(1 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, { r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true) });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esi', 'esp', 'cf', 'zf'].map(n => [n, { value: 0 }]));
p.cpu.esp.value = 0x8000;
// a callback's VxDCall of VKD's service n: INT 20h with the device and service in the dword after it
const vkd = n => { dv.setUint32(0x1002, 0x000d0000 | n, true); return INTS[0x20].call(p, 0x1006); };
const calls = [];
p.hotKeys = new Map([
  [1, { scan: 0x2e, ext: 0, want: 0x80, mask: 0x180, flags: 1, fn: 0x5000, ref: 0, on: true }],    // IFSMGR: Ctrl+C
  [2, { scan: 0x53, ext: 0xff, want: 0x180, mask: 0x180, flags: 1, fn: 0x6000, ref: 0, on: true }]]);   // REBOOT: Ctrl+Alt+Del
p.r0Callback = fn => { calls.push(fn); if (fn === 0x5000) assert.equal(vkd(6), 0x1006, 'Reflect_Hot_Key returns to the callback'); };

const ctrl = { shift: false, ctrl: true, alt: false };
assert.equal(p.vkdKey(0x2e, false, false, ctrl), false, 'Ctrl+C, reflected by its callback: the press goes on to Windows');
assert.equal(p.vkdKey(0x2e, false, true, ctrl), false, '... and its release');
assert.deepEqual(calls, [0x5000]);
assert.equal(p.vkdKey(0x53, true, false, { shift: false, ctrl: true, alt: true }), true, 'Ctrl+Alt+Del, kept by its callback: VKD takes it');
assert.equal(p.vkdKey(0x53, true, true, { shift: false, ctrl: true, alt: true }), true);
assert.equal(p.vkdKey(0x2e, false, false, { shift: false, ctrl: false, alt: false }), false, 'C alone is no hot key');
assert.equal(vkd(5), 0x1006, 'Cancel_Hot_Key_State');
console.log('vkdhotkey: ok');
