// An MS-DOS VM's memory goes back to the heap when the VM ends (vmm.js vmEnd) or is refused at its creation: kept,
// each MS-DOS program Windows 98 Setup ran (ScanDisk, ScanReg) held 2 MB for good, and MSGSRV32 ran out of memory
// after Setup ("2232320x3" among its live blocks)
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
for (let i = 0; i < 40; i++) { const h = p.vmCreate({}); assert.ok(h); assert.equal(big(), 1, 'one VM, one block'); p.vmEnd(p.vmOf(h)); assert.equal(big(), 0, 'ended, its memory freed'); }
// closed by a device (Close_VM, EBX the VM): that VM ends, its memory freed, and the machine goes on
{
  const h = p.vmCreate({}); assert.equal(big(), 1);
  p.cpu = { ebx: { value: h }, eax: { value: 0 }, cf: { value: 0 } }; window.W95NE16.VXD_SVC[0x10000 | 0xec].call(p);
  assert.ok(p.vmOf(h).gone); assert.equal(big(), 0, 'closed, its memory freed');
}
// refused at its creation: freed too
p.vmBroadcast = () => false;
assert.equal(p.vmCreate({}), 0); assert.equal(big(), 0, 'refused, its memory freed');
console.log('vmfree: ok');
