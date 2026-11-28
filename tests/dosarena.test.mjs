// DOS's memory arena, as the list of lists gives it (ne16.js dosData): LoL-2 the first MCB's segment, a chain that a
// walker follows (next = segment + size + 1) to its 'Z' block and the end of conventional memory, A000h; LoL+66h FFFFh,
// no UMBs. LoL-2 was FFFFh with no arena behind it: Windows 95 OSR 2.5 Setup's SYSDETMG took FFFF:0 for a free block
// above A000h, a UMB, whose next (FFFFh+0+1) wrapped to 0:0, its first block again, and it made UMB devices of it
// without end: the hourglass after User Information
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 32, maximum: 32 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.dosTop = 0x50000;
const d = p.dosData(), lol = d.lol;
assert.equal(p.r16(lol + 0x66), 0xffff, 'no UMBs');
let seg = p.r16(lol - 2), n = 0, last = 0;
assert.ok(seg > 0 && seg < 0xa000, 'the first MCB is in conventional memory');
for (;;) {
  const a = seg << 4, sig = p.u8[a];
  assert.ok(sig === 0x4d || sig === 0x5a, `an MCB at ${seg.toString(16)}`);
  last = seg + p.r16(a + 3) + 1; n++;
  if (sig === 0x5a) break;
  assert.ok(n < 100 && last > seg, 'the chain goes up'); seg = last;
}
assert.equal(last, 0xa000, 'the arena ends where conventional memory does');
console.log('dosarena: ok');
