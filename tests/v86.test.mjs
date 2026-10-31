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
// the PC's MS-DOS running the VMM's loader: the code before its protected-mode entry runs (the block ends before an
// instruction translation cannot take), Windows starts there (o.windows); its end with 44h returns through the
// loader's exit: WIN.COM's buffer (INT 2Fh AX=4B20h) gets the program, INT 2Fh AX=1606h, INT 21h AH=4Ch AL=44h
{
  let started = null; const calls = [];
  const m = V.machine({ pc: true, windows: p => { started = p; } });
  m.sda = 0x700; m.s16(0x710, 0x1000); m.s16(0x0fff * 16 + 3, 0x100);   // (the PSP the loader runs as, its block's size)
  m.vmm = { path: 'C:\\WINDOWS\\SYSTEM\\VMM32.VXD', ivt: m.u8.slice(m.v86, m.v86 + 1024), xms: new Set() };
  m.u8.set([0xb8, 0x01, 0x00, 0x0f, 0x20, 0xc0], m.v86 + 0x10100);   // mov ax,1; mov eax,cr0
  m.sreg('cs', 0x1010); m.sreg('ss', 0x2000); m.cpu.esp.value = 0x100; m.cpu.eip.value = m.v86 + 0x10100; m.ticksAt = Date.now() + 1e9;
  assert.equal(m.v86Run(50), 'idle'); assert.equal(m.r('ax'), 1, 'the code before the CR0 access ran');
  assert.equal(started, 'C:\\WINDOWS\\SYSTEM\\VMM32.VXD'); assert.ok(m.winWait);
  m.s16(0x2f * 4, 0x0400); m.s16(0x2f * 4 + 2, 0x3000);   // WIN.COM's INT 2Fh: 4B20h gives its buffer 3000:0500h
  m.u8.set([0x3d, 0x20, 0x4b, 0x75, 0x07, 0xba, 0x00, 0x30, 0xb9, 0x00, 0x05, 0xcf, 0xcf], m.v86 + 0x30400);   // cmp ax,4B20h; jne; mov dx,3000h; mov cx,500h; iret
  const P = Object.getPrototypeOf(m); m.v86Trap = function (next, code) { if (code === 0x421 || code === 0x42f) calls.push(this.r('ax')); if (code === 0x421 && this.ah() === 0x4c) { this.halted = true; this.cpu.eip.value = next; return; } return P.v86Trap.call(this, next, code); };
  m.winDone(0x44, { path: 'C:\\WINDOWS\\COMMAND.COM', tail: '' });
  for (let i = 0; i < 10 && !m.halted; i++) m.v86Run(50);
  assert.deepEqual(calls, [0x4b20, 0x1606, 0x4c44]);
  let s = ''; for (let i = 0; m.m8(0x30500 + i); i++) s += String.fromCharCode(m.m8(0x30500 + i));
  assert.equal(s, 'C:\\WINDOWS\\COMMAND.COM'); assert.deepEqual([m.m8(0x30580), m.m8(0x30581)], [0, 13], 'an empty command tail');
}
console.log('v86: ok');
