// A process that ends gives back what it held: its threads' stacks and TIBs, the address space it reserved
// (VirtualAlloc), and the frame DIBs OpenGL made for its DCs. A screen saver started again and again (Display
// Properties switching savers) must not run the machine's heap out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

const mine = { pid: 0x200, exitCode: null }, other = { pid: 0x204, exitCode: null };
const freed = [];
const p = Object.create(P);
Object.assign(p, {
  threadsById: new Map([[1, { id: 1, pc: mine, state: 'waiting', flat: true, stackBase: 0x100000, tib: 0x200000 }],
    [2, { id: 2, pc: other, state: 'waiting', flat: true, stackBase: 0x300000, tib: 0x400000 }]]),
  vregions: new Map([[0x0a000000, { size: 0x400000, heap: null, pc: mine }], [0x0a400000, { size: 0x10000, heap: 0x500000, pc: mine }],
    [0x0a410000, { size: 0x10000, heap: null, pc: other }]]),
  glNativeDCs: new Map([[0x5d6, { pc: mine, bits: 0x600000 }], [0x5da, { pc: other, bits: 0x700000 }]]),
  windows: new Map(), procs: new Map([[mine.pid, mine], [other.pid, other]]),
  free(a) { freed.push(a); return true; }, wakeWaiters() {},
});
P.endProcess.call(p, mine, 0);
assert.deepEqual(freed.sort(), [0x100000, 0x200000, 0x500000, 0x600000].sort(), 'its stack, TIB, heap-backed region and frame DIB are freed');
assert.deepEqual([...p.vregions.keys()], [0x0a410000], 'its reserved regions are gone, the other process keeps its own');
assert.deepEqual(p.vspare, [{ base: 0x0a000000, size: 0x400000 }], 'its address space above the layout is there to be reserved again');
assert.deepEqual([...p.glNativeDCs.keys()], [0x5da]);
assert.equal(p.threadsById.get(2).stackBase, 0x300000, 'the other process keeps its stack');
// VirtualAlloc gives a region to the process only when its own program asked (the return address in its image); a
// DLL's (SHELL32's, called on the process's thread) stays with the DLL, shared, and is not freed with the process
{
  const VA = window.W95Win32.API.KERNEL32.VirtualAlloc[1];
  const mem = new DataView(new ArrayBuffer(0x20000));
  const owner = { pid: 0x300, exe: { base: 0x400000, size: 0x10000 } };
  const q = Object.create(P);
  Object.defineProperty(q, 'pc', { value: owner });
  Object.assign(q, { vmTop: 0x10000, mem: { buffer: { byteLength: 0x10000000 } }, r32: a => (a === 0x1000 ? q.ret : 0), reg: () => 0x1000 });
  q.ret = 0x401234; const own = VA.call(q, 0, 0x10000, 0x2000);
  q.ret = 0x1660000; const dll = VA.call(q, 0, 0x10000, 0x2000);
  assert.equal(q.vregions.get(own).pc, owner, 'the program reserved it: the process owns it');
  assert.equal(q.vregions.get(dll).pc, null, 'a DLL reserved it: kept');
}
console.log('processfree: ok');
