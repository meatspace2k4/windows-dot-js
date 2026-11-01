// An MS-DOS VM's memory when the VM ends (vmm.js vmEnd) or is refused at its creation: parked for the next VM made,
// not given back to the heap. Kept for good, each MS-DOS program Windows 98 Setup ran (ScanDisk, ScanReg) held 2 MB,
// and MSGSRV32 ran out of memory after Setup ("2232320x3" among its live blocks). Freed to the heap, the devices
// that keep the VM's handle after Destroy_VM (VDD for WinOldAp's window, SHELL until its release) wrote the VM's
// video pages over whatever took the block next: Explorer jumped to 0:0 as Setup's ScanDisk ended
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map(); p.init16();
p.fixedDisk = () => {}; p.vmToClient = () => {}; p.vmBroadcast = () => true; p.sysVM = () => 1;
const big = () => [...p.allocs.values()].filter(n => n >= 0x200000).length;
const idle = () => [...p.freeList].reduce((s, [n, l]) => s + (n >= 0x200000 ? l.length : 0), 0);
// forty programs one after another: one block, each VM the last one's, never on the heap's free lists
let first = 0;
for (let i = 0; i < 40; i++) {
  const h = p.vmCreate({}); assert.ok(h); const v = p.vmOf(h);
  if (!first) first = v.high; else assert.equal(v.high, first, 'the ended VM\'s block, used again');
  assert.equal(big(), 1, 'one block'); assert.equal(idle(), 0, 'none on the free lists');
  // (the block as a new VM's: zero where the last one wrote)
  p.u8[v.high + 0xb8000] = 0x41; p.vmEnd(v);
  assert.equal(big(), 1, 'ended: the block parked, not freed'); assert.equal(idle(), 0, 'not on the free lists');
  assert.ok(v.gone && !v.m && !v.mem);
}
{ const h = p.vmCreate({}); assert.equal(p.u8[p.vmOf(h).high + 0xb8000], 0, 'a new VM\'s memory is clear'); p.vmEnd(p.vmOf(h)); }
// two at once: two blocks, both parked after, both used again
{
  const a = p.vmCreate({}), b = p.vmCreate({}); assert.equal(big(), 2);
  p.vmEnd(p.vmOf(a)); p.vmEnd(p.vmOf(b)); assert.equal(big(), 2, 'both parked'); assert.equal(idle(), 0);
  const c = p.vmCreate({}), d = p.vmCreate({}); assert.equal(big(), 2, 'no new block');
  p.vmEnd(p.vmOf(c)); p.vmEnd(p.vmOf(d));
}
// closed by a device (Close_VM, EBX the VM): that VM ends, its memory parked, and the machine goes on
{
  const h = p.vmCreate({}); assert.equal(big(), 2);
  p.cpu = { ebx: { value: h }, eax: { value: 0 }, cf: { value: 0 } }; window.W95NE16.VXD_SVC[0x10000 | 0xec].call(p);
  assert.ok(p.vmOf(h).gone); assert.equal(big(), 2, 'closed: parked'); assert.equal(idle(), 0);
}
// refused at its creation: parked too
p.vmBroadcast = () => false;
assert.equal(p.vmCreate({}), 0); assert.equal(big(), 2, 'refused: parked'); assert.equal(idle(), 0);
console.log('vmfree: ok');
