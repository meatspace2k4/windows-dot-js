// NETBEUI's time-out asks the VMM whether the critical section is owned (VMMCall Get_Crit_Status_No_Block, 0001h:00F1h)
// and, when the carry is clear, reads the client registers of the VM in EBX: mov eax, [ebx+8]; test byte [eax+2Dh], 2
// (the client's IF). EBX was 0 when the section was unowned, so NETBEUI took a pointer from address 8, whatever a stray
// write had left there, and page-faulted at 129366Ch. Unowned, EBX is the current VM and the carry is clear; owned, the
// carry is set (IFSMGR then compares EBX with its own VM).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, N = window.W95NE16, P = W.Process.prototype;
const mem = new Uint8Array(32 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
let top = 0x600000;
Object.assign(p, { selUsed: new Uint8Array(8192), alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {},
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), w16: (a, v) => dv.setUint16(a, v, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), vmClient() { return 0x500000; } });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'cf', 'zf'].map(n => [n, { value: 0 }]));
p.cpu.esp.value = 0x8000;
const AT = 0x1293664; dv.setUint32(AT + 2, 0x000100f1, true);   // cd 20 f1 00 01 00
const call = () => N.INTS[0x20].call(p, AT + 6);

// unowned (as when a time-out runs): carry clear, EBX a VM whose client registers NETBEUI reads
mem.fill(0xff, 0, 16);   // (the null page as a stray write left it)
p.vxdCrit = 0; p.cpu.ebx.value = 0; p.cpu.cf.value = 1;
assert.equal(call(), AT + 6);
assert.equal(p.cpu.cf.value, 0, 'carry clear: NETBEUI goes on to the VM\'s registers');
assert.equal(p.cpu.zf.value, 1);
const vm = p.cpu.ebx.value >>> 0;
assert.equal(vm, p.sysVM(), 'EBX the current VM');
const client = p.r32(vm + 8);
assert.equal(client, 0x500000, '[EBX+8]: its client registers, not a pointer from the null page');
// owned: carry set, EBX the owner
p.vxdCrit = 2; call();
assert.equal(p.cpu.cf.value, 1); assert.equal(p.cpu.zf.value, 0); assert.equal(p.cpu.ecx.value, 2); assert.equal(p.cpu.ebx.value >>> 0, p.sysVM());
console.log('critstatus: ok');
