// Local32Init on a segment whose block has the room makes the 32-bit heap there, the segment's linear address kept:
// Windows 98's GDI makes its heap in its data segment after GDI32 took flat pointers into it (its stock-object table),
// and moved, GDI32's GetStockObject read the old place and WinHelp's RegisterClass refused its brush, "(null) (2)".
// A segment whose block has no room moves, its bytes with it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

function proc(blockSize) {
  const buf = new ArrayBuffer(16 << 20), u8 = new Uint8Array(buf), dv = new DataView(buf);
  const seg = 0x1000, old = 0x100000, gb = { lin: old, size: 0x10000 };
  const p = Object.create(P);
  Object.assign(p, {
    mem: { buffer: buf }, allocs: new Map([[old, blockSize]]), freeList: new Map(), heapTop: 0x800000, gb,
    w16: (a, v) => dv.setUint16(a, v & 0xffff, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
    r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true),
    selBase: s => (s === seg ? gb.lin : 0), selLimit: () => 0xffff, allocSels: () => 0x2000, refreshSegs() {}, gblock: () => gb,
  });
  p.alloc = function (n) { const a = this.heapTop; this.heapTop += (n + 15) & ~15; this.allocs.set(a, n); return a; };
  u8.set([1, 2, 3, 4], old);
  return { p, seg, old, gb };
}

{ // the block has room for the segment and its heap: made where it is
  const { p, seg, old, gb } = proc(0x200010);
  const hdr = P.local32Init.call(p, seg, 0, 0x100000, 0);
  assert.equal(gb.lin, old, 'the segment stays at its linear address');
  assert.equal(hdr, old + 0x10000, 'the heap header follows the segment in the same block');
  assert.deepEqual([...p.u8.subarray(old, old + 4)], [1, 2, 3, 4], 'the segment\'s bytes as they were');
  assert.equal(p.heapTop, 0x800000, 'no new block taken');
}
{ // no room: moved, its bytes copied
  const { p, seg, old, gb } = proc(0x10010);
  P.local32Init.call(p, seg, 0, 0x100000, 0);
  assert.notEqual(gb.lin, old, 'moved');
  assert.deepEqual([...p.u8.subarray(gb.lin, gb.lin + 4)], [1, 2, 3, 4], 'its bytes with it');
}
console.log('local32inplace: ok');
