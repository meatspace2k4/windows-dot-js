// A devnode whose device loader is not there, or refuses it (PNP_NEW_DEVNODE's CONFIGRET), has a problem, as CONFIGMG
// records it: CM_PROB_DEVLOADER_NOT_FOUND (8) or CM_PROB_DEVLOADER_FAILED (2), with DN_HAS_PROBLEM in its status, which
// Device Manager shows. It was a console line, and Get_DevNode_Status called the device fine and not started.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, INTS = window.W95NE16.INTS;
const mem = new Uint8Array(1 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, { r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), vxdById: () => null });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'esp', 'cf', 'zf'].map(n => [n, { value: 0 }]));
window.W95Win32.regGet = () => 'MMDEVLDR.VXD';
const dns = [{ handle: 0x100, id: 'ISAPNP\\CSC0000', driver: 'MEDIA\\0000' }, { handle: 0x200, id: 'ISAPNP\\YMH0021', driver: 'MEDIA\\0001' }];
p.devnodes = () => dns; p.cmStart = () => {};
const status = h => {   // Get_DevNode_Status(*status, *problem, dn, flags)
  p.cpu.esp.value = 0x8000; [0x6000, 0x6004, h, 0].forEach((v, i) => dv.setUint32(0x8000 + 4 * i, v, true));
  dv.setUint32(0x1002, 0x00330036, true); INTS[0x20].call(p, 0x1006);
  return [dv.getUint32(0x6000, true), dv.getUint32(0x6004, true)];
};
assert.deepEqual(status(0x100), [0x0a, 0], 'before: DN_STARTED | DN_DRIVER_LOADED, no problem');
p.vxdLoad = () => null;
p.cmProcess(dns[0]);
assert.deepEqual(status(0x100), [0x400, 8], 'no device loader: DN_HAS_PROBLEM, CM_PROB_DEVLOADER_NOT_FOUND');
p.vxdLoad = () => ({ file: 'MMDEVLDR.VXD' }); p.vxdControl = () => ({ eax: 0x1f });
p.cmProcess(dns[1]);
assert.deepEqual(status(0x200), [0x400, 2], 'the loader refused it: CM_PROB_DEVLOADER_FAILED');
console.log('devloader: ok');
