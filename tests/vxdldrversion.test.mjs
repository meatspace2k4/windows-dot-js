// VXDLDR_Get_Version (27h:0) answers 4.0 with carry clear (vmm.js): missing, WSOCK.VXD's Device_Init failed and
// Winsock had no VxD under it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const SVC = window.W95VMM ? window.W95VMM.VXD_SVC : Object.values(window).find(v => v && v.VXD_SVC)?.VXD_SVC;
assert.ok(SVC, 'the VxD service table');
const fn = SVC[0x27 << 16 | 0]; assert.ok(fn, 'VXDLDR service 0 is there');
const p = { cpu: { eax: { value: 0 }, cf: { value: 1 } } };
fn.call(p);
assert.equal(p.cpu.eax.value & 0xffff, 0x400); assert.equal(p.cpu.cf.value, 0);
console.log('vxdldrversion: ok');
