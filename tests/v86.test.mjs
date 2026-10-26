// The virtual-8086 machine (v86.js on dyn.js's V86 mode): segments are paragraphs of the machine's own memory, INT goes
// through its vectors at 0:0 (a program's handler, or the BIOS's ROM stub calling the host and IRETing), FLAGS keeps
// bits 12-14 as a 386 does, HLT waits for the host, and the FAT16 disk the machine boots from has its partition table
// and folders as FDISK, FORMAT and SYS leave them
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js', 'v86.js']) new Function(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))();
const V = window.W95V86;
const run = (code, setup) => {
  const m = V.machine({}); m.u8.set(code, m.v86 + 0x7c00);
  m.sreg('cs', 0); m.sreg('ss', 0); m.sreg('ds', 0); m.sreg('es', 0); m.cpu.esp.value = 0x7c00; m.cpu.eip.value = m.v86 + 0x7c00;
  m.ticksAt = Date.now() + 1e9;   // (no timer interrupt in the middle of a test)
  if (setup) setup(m);
  assert.equal(m.v86Run(200), 'idle', m.trapped || 'ran to the HLT');
  return m;
};
// a segment register's base is 16 times its value: mov ax,1234h; mov ds,ax; mov [10h],ax; hlt
{ const m = run([0xb8, 0x34, 0x12, 0x8e, 0xd8, 0xa3, 0x10, 0x00, 0xf4]); assert.equal(m.m16(0x12340 + 0x10), 0x1234); }
// INT through the machine's own vector: int 60h to a handler at 0:7D00 (mov bx,5555h; iret), then hlt
{
  const m = run([0xcd, 0x60, 0xf4], m => { m.s16(0x60 * 4, 0x7d00); m.s16(0x60 * 4 + 2, 0); m.u8.set([0xbb, 0x55, 0x55, 0xcf], m.v86 + 0x7d00); });
  assert.equal(m.r('bx'), 0x5555); assert.equal(m.r('sp'), 0x7c00, 'IRET took FLAGS, CS and IP back');
}
// the BIOS through its ROM stub: INT 12h answers the memory size, INT 10h AH=0Eh writes to the text screen
{ const m = run([0xcd, 0x12, 0xa3, 0x00, 0x05, 0xb8, 0x41, 0x0e, 0xcd, 0x10, 0xf4]); assert.equal(m.m16(0x500), 640); assert.equal(m.m8(0xb8000), 0x41); }
// FLAGS bits 12-14 stay as written (a 386, not a 286): pushf; pop ax; or ax,7000h; push ax; popf; pushf; pop bx; hlt
{ const m = run([0x9c, 0x58, 0x0d, 0x00, 0x70, 0x50, 0x9d, 0x9c, 0x5b, 0xf4]); assert.equal(m.r('bx') & 0x7000, 0x7000); }
// the boot disk: an active FAT16 partition from sector 63, IO.SYS and MSDOS.SYS first in the root, folders with . and ..
{
  const boot = new Uint8Array(512); boot.set([0xeb, 0x3c, 0x90]); boot[510] = 0x55; boot[511] = 0xaa;
  const d = V.fat16(boot, [{ name: 'IO.SYS', data: new Uint8Array(3000), attr: 7 }, { name: 'MSDOS.SYS', data: new Uint8Array(1100), attr: 7 }, { path: 'WINDOWS\\WIN.COM', data: new Uint8Array([1, 2, 3]) }], 16);
  const dv = new DataView(d.buffer);
  assert.equal(d[0x1be], 0x80); assert.equal(dv.getUint32(0x1be + 8, true), 63); assert.equal(dv.getUint16(510, true), 0xaa55);
  const vol = 63 * 512, root = vol + (1 + 2 * dv.getUint16(vol + 22, true)) * 512, name = o => String.fromCharCode(...d.subarray(root + o, root + o + 11));
  assert.equal(name(0), 'IO      SYS'); assert.equal(name(32), 'MSDOS   SYS'); assert.equal(name(64), 'WINDOWS    '); assert.equal(d[root + 64 + 11], 0x10);
  assert.equal(dv.getUint32(vol + 28, true), 63, 'hidden sectors: the partition\'s start');
}
console.log('v86: ok');
