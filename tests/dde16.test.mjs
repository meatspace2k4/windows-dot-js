// DDE data between the sides, as USER hands a DDE message's block to a window of the other side (KRNL386 #533 and
// #534): the block is copied across; an EXECUTE's or ACK's block that came across already is given back as it was
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, K16 = window.W95NE16.K16, P = W.Process.prototype;

function guest() {
  const u8 = new Uint8Array(1 << 16), dv = new DataView(u8.buffer); let top = 0x1000, sel = 0x100;
  const p = Object.create(P);
  Object.defineProperty(p, 'u8', { value: u8 });
  Object.assign(p, {
    r16: a => dv.getUint16(a, true), w16: (a, v) => dv.setUint16(a, v & 0xffff, true), r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
    cpu: { ssb: { value: 0 }, esp: { value: 0x8000 }, eax: { value: 0 }, edx: { value: 0 } },
    allocs: new Map(), ghandles: new Map(), freed: [],
    alloc(n) { const a = top; top += (n + 15) & ~15; this.allocs.set(a, n); return a; }, free(a) { this.freed.push(a); this.allocs.delete(a); },
    globalAlloc16(flags, n) { const h = (sel += 8), lin = this.alloc(Math.max(n, 1)); this.ghandles.set(h | 1, { lin, size: n, flags }); return h; },
    retf16: n => 'retf' + n,
  });
  return p;
}
const call = (p, ord, words) => { const f = 0x8000; words.forEach((w, i) => (typeof w === 'object' ? p.w32(f + 4 + w.at, w.v) : p.w16(f + 4 + 2 * i, w))); return K16['KERNEL.#' + ord][2].call(p); };

// a 16-bit block to the Win32 side: a copy, in EAX and DX:AX; the same copy for the ACK of the EXECUTE it carried
{
  const p = guest(), h = p.globalAlloc16(0x2002, 12), b = p.gblock(h); for (let i = 0; i < 12; i++) p.u8[b.lin + i] = 0x41 + i;
  assert.equal(call(p, 534, [h, 0x3e8]), 'retf4');
  const r = p.cpu.eax.value; assert.ok(r && r !== b.lin); assert.equal(p.cpu.edx.value, r >>> 16);
  assert.equal(String.fromCharCode(...p.u8.subarray(r, r + 12)), 'ABCDEFGHIJKL');
  call(p, 534, [h, 0x3e4]); assert.equal(p.cpu.eax.value, r);   // (the ACK: the block already across)
  call(p, 534, [h, 0x3e5]); assert.notEqual(p.cpu.eax.value, r); assert.deepEqual(p.freed, [r]);   // (DATA: a fresh copy, the old one freed)
  call(p, 534, [0, 0x3e8]); assert.equal(p.cpu.eax.value, 0);
}
// a Win32 block to the 16-bit side: a 16-bit global block holding a copy; the EXECUTE's block given back for its ACK
{
  const p = guest(), w = p.alloc(8); for (let i = 0; i < 8; i++) p.u8[w + i] = 0x61 + i;
  assert.equal(call(p, 533, [{ at: 0, v: w }, 0, 0x3e8]), 'retf6');
  const h = p.cpu.eax.value & 0xffff; assert.ok(h); assert.equal(String.fromCharCode(...p.u8.subarray(p.gblock(h).lin, p.gblock(h).lin + 8)), 'abcdefgh');
  call(p, 533, [{ at: 0, v: w }, 0, 0x3e4]); assert.equal(p.cpu.eax.value & 0xffff, h);
  call(p, 533, [{ at: 0, v: 0 }, 0, 0x3e8]); assert.equal(p.cpu.eax.value, 0);
}
// a DDE execute command block: "[command]" with its ']' ending the string
{
  const p = guest(), put = s => { const h = p.globalAlloc16(0x2002, s.length + 2), b = p.gblock(h); for (let i = 0; i < s.length; i++) p.u8[b.lin + i] = s.charCodeAt(i); return h; };   // (a block a little larger than its string, as GlobalAlloc gives it)
  for (const [s, want] of [['[CreateGroup(X)]\0', 1], ['[a]\0', 1], ['[]\0', 1], ['CreateGroup\0', 0], ['[abc]x', 0]]) {
    assert.equal(call(p, 537, [0, put(s)]), 'retf4'); assert.equal(p.cpu.eax.value, want, JSON.stringify(s));
  }
  call(p, 537, [0, 0]); assert.equal(p.cpu.eax.value, 0);
}
console.log('dde16: ok');
