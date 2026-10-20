// The VGA's 16-color planar modes as VGA.DRV drives them through the A0000h window: mode 12h's registers, a read
// loading the latches (read mode 0: a plane; 1: color compare), each write mode through the map mask, set/reset,
// the rotate and logical operation and the bit mask; the BIOS's palette call; and the page's scan-out of a 4-bit
// pixel through the attribute palette.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const mem = new Uint8Array(16 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
let top = 0x400000;
Object.assign(p, { init16() {}, alloc(n) { const a = top; top += (n + 0xfff) & ~0xfff; return a; }, r16: a => dv.getUint16(a, true), w16: (a, v) => dv.setUint16(a, v, true) });
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'es'].map(n => [n, { value: 0 }]));
const W = 0xa0000;
assert.equal(p.setVideoMode(0x12, true, 0), true);
const a = p.scanout();
assert.deepEqual([a.w, a.h, a.bpp, a.planar, a.pitch, a.seq[4]], [640, 480, 4, true, 80, 0x06], 'mode 12h: 640x480, four planes, 80 bytes a line, chain-4 off');
assert.deepEqual([a.attr[6], a.attr[15], a.dac[3 * 0x14], a.dac[3 * 0x14 + 1]], [0x14, 0x3f, 0x2a, 0x15], 'the EGA palette: brown is DAC 14h');
const plane = (p_, off) => a.vram[p_ << 16 | off];
const wr = (off, v) => { mem[W + off] = v; p.vgaWrite(W + off, 1); }, rd = off => { p.vgaRead(W + off, 1); return mem[W + off]; };

// write mode 0, all planes, bit mask FFh: the byte in every plane
wr(0, 0xa5); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 0)), [0xa5, 0xa5, 0xa5, 0xa5]);
// the map mask: planes 0 and 2 only
a.seq[2] = 0x05; wr(1, 0xff); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 1)), [0xff, 0, 0xff, 0]); a.seq[2] = 0x0f;
// read mode 0: the plane GC 4 selects; the read loads the latches
a.gc[4] = 2; assert.equal(rd(1), 0xff); a.gc[4] = 1; assert.equal(rd(1), 0); assert.deepEqual([...a.latch], [0xff, 0, 0xff, 0]);
// set/reset: color 9 (planes 0 and 3) in every enabled plane, the bit mask keeping the latches' other bits
rd(2); a.gc[0] = 9; a.gc[1] = 0x0f; a.gc[8] = 0xf0; wr(2, 0); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 2)), [0xf0, 0, 0, 0xf0]);
a.gc[1] = 0; a.gc[8] = 0xff;
// write mode 1: the latches copied (a screen-to-screen move)
rd(1); a.gc[5] = 1; wr(3, 0x12); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 3)), [0xff, 0, 0xff, 0]); a.gc[5] = 0;
// write mode 2: the byte's low four bits a plane each, under the bit mask (one pixel, bit 7 only)
rd(4); a.gc[5] = 2; a.gc[8] = 0x80; wr(4, 0x0c); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 4)), [0, 0, 0x80, 0x80]);
// the logical operation: XOR with the latches
rd(4); a.gc[3] = 3 << 3; wr(4, 0x0c); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 4)), [0, 0, 0, 0]); a.gc[3] = 0; a.gc[5] = 0; a.gc[8] = 0xff;
// write mode 3: set/reset's color, the rotated byte ANDed with the bit mask the mask
rd(5); a.gc[0] = 0x0e; a.gc[5] = 3; a.gc[8] = 0x0f; wr(5, 0xff); assert.deepEqual([0, 1, 2, 3].map(q => plane(q, 5)), [0, 0x0f, 0x0f, 0x0f]); a.gc[5] = 0; a.gc[8] = 0xff;
// the rotate: 3 right
a.gc[3] = 3; wr(6, 0x81); assert.equal(plane(0, 6), 0x30); a.gc[3] = 0;
// read mode 1, color compare: the bits of offset 5 whose color is 14 (planes 1-3), every plane cared about
a.gc[5] = 8; a.gc[2] = 0x0e; a.gc[7] = 0x0f; assert.equal(rd(5), 0x0f); a.gc[7] = 0; assert.equal(rd(5), 0xff, 'no plane cared about: all match'); a.gc[5] = 0;

// INT 10h AX=1010h: one DAC register; 1000h: a palette register
p.cpu.eax.value = 0x1010; p.cpu.ebx.value = 7; p.cpu.edx.value = 0x2100; p.cpu.ecx.value = 0x2223; p.biosPalette();
assert.deepEqual([...a.dac.subarray(21, 24)], [0x21, 0x22, 0x23]);
p.cpu.eax.value = 0x1000; p.cpu.ebx.value = 0x3f07; p.biosPalette(); assert.equal(a.attr[7], 0x3f);

// the page: pixel 0 of line 0 is color 9 through the attribute palette to its DAC entry
{
  const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8'), i = w.indexOf('function scanRow('), j = w.indexOf('\n}\n', i);
  const scanRow = new Function(`${w.slice(i, j + 2)}\nreturn scanRow;`)();
  const v = new Uint8Array(0x40000); v[0] = 0x80; v[0x30000] = 0x80;   // (bits 0 and 3 of pixel 0: color 9)
  const at = Uint8Array.from([...Array(16).keys(), ...Array(5).fill(0)]); at[9] = 0x39; at[0x10] = 0x01;
  const pal = Uint32Array.from({ length: 256 }, (_, k) => k), d = new Uint32Array(8);
  scanRow({ bpp: 4, attr: at }, v, pal, d, 0, 0, 0, 8);
  assert.deepEqual([...d], [0x39, 0, 0, 0, 0, 0, 0, 0], 'color 9 to palette register 9, 39h, its DAC entry');
}
console.log('vgaplanar: ok');
