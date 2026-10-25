// Nested execution runs on the VM's locked stack, never under the SS:SP of the code a VxD's event interrupted.
// Sampled at a frozen first start: WELCOME blitting on DIBENG's 4Ah-byte blit stack (SS 129Fh, SP 40h) as the client;
// VTDAPI's timer event (VTDAPI+18Ch) wrote its callback's frame under Client_SS:Client_SP and ran MMSYSTEM's callback
// there: zeros from SS:4, WELCOME's CS:IP at SS:3Ch, and the line count at SS:0 written over, so the blit's
// `dec dword ss:[0]` loop ran from 0 (FF745788h and falling). Begin_Nest_Exec moves the client to the locked stack, as
// the VMM's does; End_Nest_Exec gives it its own back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, { INTS } = window.W95NE16;

const mem = { buffer: new ArrayBuffer(0x100000) }, p = Object.create(P), dv = new DataView(mem.buffer);
const C = 0x8000;   // the client registers (CB_Client_Pointer)
const cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cf']) cpu[r] = { value: 0 };
let next = 0x20000;
Object.assign(p, { mem, cpu, vmClient: () => C, alloc: n => { const a = next; next += n; return a; }, allocSels: () => 0x3fff });
// a VxD's call of a VMM service by number (INT 20h's dispatch reaches the same table)
const svc = n => { dv.setUint32(0x10002, 0x00010000 | n, true); return INTS[0x20].call(p, 0x10006); };
p.r32 = a => dv.getUint32(a, true); p.w32 = (a, v) => dv.setUint32(a, v >>> 0, true); p.r16 = a => dv.getUint16(a, true);

// the client is WELCOME on DIBENG's blit stack
p.w32(C + 0x34, 0x129f); p.w32(C + 0x30, 0x40);
svc(0x83);   // Begin_Nest_Exec
assert.equal(p.r16(C + 0x34), 0x3fff, 'Client_SS: the locked stack');
assert.equal(p.r32(C + 0x30), 0x3ff0, 'Client_SP: its top');
// a nested Begin_Nest_Exec already on the locked stack stays where the outer one left it
p.w32(C + 0x30, 0x3f00); svc(0x83);
assert.equal(p.r32(C + 0x30), 0x3f00, 'the inner nest goes on below the outer one');
svc(0x86);
assert.equal(p.r16(C + 0x34), 0x3fff, 'the inner End_Nest_Exec leaves the outer one on the locked stack');
svc(0x86);   // End_Nest_Exec
assert.equal(p.r16(C + 0x34), 0x129f, 'Client_SS back');
assert.equal(p.r32(C + 0x30), 0x40, 'Client_SP back');
console.log('nestlocked: ok');
