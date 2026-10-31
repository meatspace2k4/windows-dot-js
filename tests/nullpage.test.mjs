// What wrote the null page at boot (?memwatch=0,20): MMDEVLDR appends "\Drivers" at EDX after VMM's _lstrlen, which left
// EDX 0, so its registry paths went to address 0; and CreateFileA's DIOC_OPEN reached VTDAPI with no output buffer,
// where it writes its version (400h) unasked. Address 8 is what NETBEUI's time-out read its client pointer from.
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
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), w16: (a, v) => dv.setUint16(a, v, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true) });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'cf', 'zf'].map(n => [n, { value: 0 }]));
const AT = 0x500000, STK = 0x8000;
const vmmcall = (svc, ...args) => {   // VMMCall svc with C arguments, as MMDEVLDR makes it
  dv.setUint32(AT + 2, 0x00010000 | svc, true);
  p.cpu.esp.value = STK; args.forEach((a, i) => dv.setUint32(STK + 4 * i, a, true));
  N.INTS[0x20].call(p, AT + 6); return p.cpu.eax.value >>> 0;
};
// strcat(buf, "\Drivers") as MMDEVLDR does it: _lstrcpyn(EDX after _lstrlen(buf), src, -1)
const buf = 0x700000, src = 0x700100;
p.writeA(buf, 'System\\CurrentControlSet\\Services\\Class\\MEDIA\\0000'); p.writeA(src, '\\Drivers');
p.cpu.edx.value = 0;
const n = vmmcall(0x17c, buf);
assert.equal(n, p.readA(buf).length); assert.equal(p.cpu.edx.value >>> 0, buf + n, 'EDX the terminating null');
vmmcall(0x17b, p.cpu.edx.value >>> 0, src, 0xffffffff);
assert.equal(p.readA(buf), 'System\\CurrentControlSet\\Services\\Class\\MEDIA\\0000\\Drivers');
assert.deepEqual(Array.from(mem.subarray(0, 16)), new Array(16).fill(0), 'nothing at address 0');

// IFSMGR asks IOS of each drive (IOS_Requestor_Service, an IRS: func, result, drive): the answer in IRS_result, the
// drive letter left; written as a word at 2 it became drive 10h-41h, whose CDS entry went to address 0
const irs = 0x700200; mem[irs] = 2; mem[irs + 1] = 0; mem[irs + 2] = 0x43;
dv.setUint32(AT + 2, 0x00100008, true); p.cpu.esp.value = STK; dv.setUint32(STK, irs, true); N.INTS[0x20].call(p, AT + 6);
assert.equal(mem[irs + 2], 0x43, 'the drive letter as IFSMGR put it');
assert.notEqual(mem[irs + 1], 0, 'IRS_result: not IOS\'s drive');
assert.deepEqual(Array.from(mem.subarray(0, 16)), new Array(16).fill(0));

// CreateFileA's open of \\.\VTDAPI: DIOC_OPEN with an output buffer
const ne16 = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
assert.match(ne16, /this\.vxdIoctl\(vx, 0, 0, 0, out, 16, 0, 0\)/, 'DIOC_OPEN with a buffer for the version');
console.log('nullpage: ok');
