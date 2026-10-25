// A VxD's code written over is reported with the run that wrote it. VTDAPI's `VxDCall Get_System_Time` (cd 20 3f 00
// 01 00 at VTDAPI+62h) read 0FFF7F3Fh as its service at the first start: MSGSRV32 "performed an illegal operation"
// (unimplemented VxD service fffh:7f3fh) with nothing saying what had written there. The VxDCall sites are watched:
// a change shows on the console as the run ends and in the trap's text; a VxD's own patch (smc) is not one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype, { INTS } = window.W95NE16;

const BASE = 0x1820000;
// VTDAPI's bytes at 49h-68h: the time-out callback up to its VxDCall Get_System_Time, and a data dword after
const img = new Uint8Array(0x100);
img.set([0x9c, 0xfa, 0x33, 0xc0, 0x89, 0x42, 0x14, 0xf7, 0x42, 0x2c, 0x00, 0x01, 0x00, 0x00, 0x75, 0x5f,
  0xf7, 0x42, 0x2c, 0x01, 0x00, 0x00, 0x00, 0x74, 0x32, 0xcd, 0x20, 0x3f, 0x00, 0x01, 0x00], 0x49);
const mk = () => {
  const p = Object.create(P), mem = { buffer: new ArrayBuffer(0x2000000) };
  new Uint8Array(mem.buffer).set(img, BASE);
  const cpu = {}; for (const r of ['cs', 'eip', 'esp', 'eax', 'cf']) cpu[r] = { value: 0 };
  Object.assign(p, { mem, cpu, modules: [], vxds: new Map() });
  p.vxds.set('VTDAPI.VXD', { name: 'VTDAPI', base: BASE, meta: { size: 0x5000 }, watch: p.vxdWatch(img) });
  return p;
};
const errors = []; console.error = m => errors.push(String(m));

// the VxDCall site is watched; data elsewhere in the image is not
{
  const p = mk(), w = p.vxds.get('VTDAPI.VXD').watch;
  assert.deepEqual([...w.sites], [0x62], 'the one VxDCall site');
  p.u8[BASE + 0x80] = 0x55; p.vxdCodeCheck();
  assert.equal(w.hit, null, 'a write outside the VxDCall sites is not reported');
}
// a thread writes 0FFF7F3Fh over the service dword: reported once, with the thread and where it stopped
{
  const p = mk(); errors.length = 0;
  p.thread16 = { id: 0x12, task: { mod: { name: 'MSGSRV32' } } }; p.cpu.cs.value = 0x1cef; p.cpu.eip.value = 0x1570123;
  p.u8.set([0x3f, 0x7f, 0xff, 0x0f], BASE + 0x64);
  p.vxdCodeCheck(); p.vxdCodeCheck();
  assert.equal(errors.length, 1, 'reported once');
  assert.match(errors[0], /VTDAPI\+62 \(1820062\): cd 20 3f 00 01 00 written as cd 20 3f 7f ff 0f, by thread 18 \(MSGSRV32\) at 1cef:1570123/);
  assert.match(p.vxdWriteAt(BASE + 0x62), /VTDAPI\+62/, 'found by an address in the VxD');
  assert.equal(p.vxdWriteAt(0x1830000), null, 'not by one outside it');
}
// the trap of the call through the written site names the write
{
  const p = mk(); errors.length = 0;
  p.u8.set([0x3f, 0x7f, 0xff, 0x0f], BASE + 0x64);
  p.svcHooks = null; p.vxdService = () => null; p.vxdById = () => null; p.absentService = () => false;
  const r = INTS[0x20].call(p, BASE + 0x68);
  assert.equal(r, W.LAYOUT.SENTINEL);
  assert.match(p.trapped, /^unimplemented VxD service fffh:7f3fh at 1820062; VxD code written: VTDAPI\+62 /);
}
// a VxD's own patch of its code (smc) is its code from then on: not reported
{
  const p = mk(); errors.length = 0;
  p.u8.set([0x3f, 0x01, 0x01, 0x00], BASE + 0x64); p.smc(BASE + 0x64);
  p.vxdCodeCheck();
  assert.equal(errors.length, 0, 'its own patch is not reported');
  p.u8[BASE + 0x66] = 0x7f; p.vxdCodeCheck();
  assert.equal(errors.length, 1, 'a later write over the patched site is');
}
// each top-level run ends with the check
{
  const p = mk(); errors.length = 0;
  p.runAt = function () { this.u8.set([0x3f, 0x7f, 0xff, 0x0f], BASE + 0x64); return 0; };
  p.runTop(0x401000);
  assert.equal(errors.length, 1, 'the run that wrote it is reported as it ends');
}
console.log('vxdwatch: ok');
