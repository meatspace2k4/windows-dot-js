// The W32's MMU and accelerator as the Tseng driver drives them: VDD service 83h gives a selector for B8000h; a store
// into aperture 1 lands in VRAM at its base; a store into aperture 2 in accelerator mode runs the programmed operation
// with that address as its destination, and the status reads idle after it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const mem = new Uint8Array(8 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
let top = 0x400000;
Object.assign(p, { init16() {}, alloc(n) { const a = top; top += (n + 0xfff) & ~0xfff; return a; } });
p.r16 = a => dv.getUint16(a, true); p.r32 = a => dv.getUint32(a, true);
const MMU = 0xb8000, R = MMU + 0x7f00;
const w8 = (o, v) => { mem[MMU + o] = v; p.mmioWrite(MMU + o, 1); };
const w16 = (o, v) => { dv.setUint16(MMU + o, v, true); p.mmioWrite(MMU + o, 2); };
const w32 = (o, v) => { dv.setUint32(MMU + o, v, true); p.mmioWrite(MMU + o, 4); };
const a = p.adapter(); a.flat = true;
const vram = p.scanout().vram;

// the status the driver polls before each operation reads idle whatever was stored there
w8(0x7f36, 1); assert.equal(mem[R + 0x36], 0, 'ACL status idle');
w8(0x7f13, 0x74);   // (aperture 2 in accelerator mode, as the driver sets it)

// aperture 1 at the pattern area: a dword of color stored through it lands in VRAM
w32(0x7f04, 0x100000); w32(0x2000, 0x7c1f7c1f);
assert.deepEqual([...vram.subarray(0x100000, 0x100004)], [0x1f, 0x7c, 0x1f, 0x7c], 'aperture 1 writes VRAM at its base');

// a solid fill: pattern 4 bytes wrapped (7F90h = 2), ROP PATCOPY, 6 bytes by 3 lines at pitch 0x800, started by the
// byte store into aperture 2 with base 2 the destination
w32(0x7f80, 0x100000); w8(0x7f90, 2); w16(0x7f88, 3); w16(0x7f8c, 0x7ff); w8(0x7f8f, 0); w8(0x7f9c, 0);
w16(0x7f98, 5); w16(0x7f9a, 2); w8(0x7f9f, 0xf0);
w32(0x7f08, 0x802); w8(0x4000, 0);
for (let y = 0; y < 3; y++)
  assert.deepEqual([...vram.subarray(0x802 + y * 0x800, 0x802 + y * 0x800 + 6)], [0x1f, 0x7c, 0x1f, 0x7c, 0x1f, 0x7c], `line ${y} filled`);
assert.equal(vram[0x808], 0, 'X count + 1 bytes, no more');
assert.equal(vram[0x802 + 3 * 0x800], 0, 'Y count + 1 lines, no more');

// a screen-to-screen copy one line down over itself (SRCCOPY), walking up so the source is read before it is written:
// both addresses are the last line's, the Y direction decrements
for (let y = 0; y < 4; y++) vram.fill(y + 1, 0x10000 + y * 0x100, 0x10000 + y * 0x100 + 4);
w32(0x7f84, 0x10000 + 2 * 0x100); w8(0x7f92, 0x77); w16(0x7f8a, 0xff); w16(0x7f8c, 0xff); w8(0x7f8f, 2);
w16(0x7f98, 3); w16(0x7f9a, 2); w8(0x7f9f, 0xcc);
w32(0x7f08, 0x10000 + 3 * 0x100); w8(0x4000, 0);
assert.deepEqual([0, 1, 2, 3].map(y => vram[0x10000 + y * 0x100]), [1, 1, 2, 3], 'lines 0-2 moved down one');

// a destination-inverting operation (DSTINVERT, 55h) leaves the pattern and source unread
w8(0x7f8f, 0); w16(0x7f98, 0); w16(0x7f9a, 0); w8(0x7f9f, 0x55); w32(0x7f08, 0x20000); w8(0x4000, 0);
assert.equal(vram[0x20000], 0xff, 'DSTINVERT');

// a glyph through the mix (routing 2): 3 bytes by 2 lines, foreground PATCOPY of color 77h, background left (D); the
// CPU writes a mix bit per byte, low bit first, a write for each line, whose bits past the line's end are dropped
vram.fill(0x11, 0x30000, 0x30000 + 0x400);
w32(0x7f80, 0x100000); vram.fill(0x77, 0x100000, 0x100004); w8(0x7f90, 2);
w16(0x7f8c, 0xff); w8(0x7f8f, 0); w8(0x7f9c, 2); w16(0x7f98, 2); w16(0x7f9a, 1); w8(0x7f9f, 0xf0); w8(0x7f9e, 0xaa);
w32(0x7f08, 0x30000);
w8(0x4000, 0b11111101);   // (line 0: bytes 0 and 2; the high bits past the third byte dropped)
assert.deepEqual([...vram.subarray(0x30000, 0x30003)], [0x77, 0x11, 0x77], 'line 0 by its mix');
w16(0x4000, 0b0000000000000010);   // (line 1: byte 1, from a word write)
assert.deepEqual([...vram.subarray(0x30100, 0x30103)], [0x11, 0x77, 0x11], 'line 1 by its mix');
assert.equal(a.acl, null, 'the last line ends the operation');
w8(0x7f9c, 0);

// VDD 83h: the MMU's physical address in EDX comes back as a selector over it
p.cpu = Object.fromEntries(Object.entries({ eax: 0x83, edx: MMU, ecx: 0x200000, ebx: 1 }).map(([k, v]) => [k, { value: v }]));
const sels = [];
p.allocSels = (base, size) => { sels.push([base, size]); return 0x2a7; };
p.retf16 = () => 0;
const vdd = p.thunk16Def('VDD.#0').def[2];
vdd.call(p);
assert.equal(p.cpu.edx.value, 0x2a7, 'EDX: the selector');
assert.deepEqual(sels, [[MMU, 0x8000]], 'over B8000h-BFFFFh');
p.cpu.eax.value = 0x83; p.cpu.edx.value = MMU; vdd.call(p);
assert.equal(sels.length, 1, 'the same selector each time');
// a size TSENG.DRV does not list (800x480) takes its 1024x768 entry: its resolution tables, GDIINFO and the scan line
// length of each depth say 800x480 there (the records laid out as the driver's second segment has them)
{
  const b = 0x600000, put = (o, ws) => ws.forEach((v, i) => dv.setUint16(b + o + 2 * i, v & 0xffff, true));
  const RES = [320, 200, 320, 240, 512, 384, 640, 400, 640, 480, 800, 600, 1024, 768, 1280, 1024];
  put(0x3ee, RES); put(0x1b06, RES);
  [[320, 320, 512, 640, 640, 800, 1024, 1280], [640, 640, 1024, 1280, 1280, 1600, 2048, 2560]].forEach((ls, g) => put(0x496 + 32 * g, ls.flatMap(l => [0xe000, l])));
  put(0x1a1a, [0x400, 1, 208, 156, 1024, 768]); put(0x19ac, [0x400, 1, 208, 156, 800, 600]);
  const q = Object.create(P);
  Object.defineProperty(q, 'u8', { value: mem });
  Object.assign(q, { r16: p.r16, w16: (a, v) => dv.setUint16(a, v, true), ne: new Map([['DISPLAY', { segs: [{ num: 1, base: 0x5f0000 }, { num: 2, base: b, len: 0x2000 }] }]]) });
  assert.deepEqual(q.displaySlot(800, 480), { w: 1024, h: 768 }, 'the driver is told its 1024x768 entry');
  assert.deepEqual([q.r16(b + 0x3ee + 24), q.r16(b + 0x3ee + 26), q.r16(b + 0x1b06 + 24), q.r16(b + 0x1b06 + 26)], [800, 480, 800, 480], 'both resolution tables');
  assert.deepEqual([q.r16(b + 0x1a1a + 8), q.r16(b + 0x1a1a + 10)], [800, 480], 'GDIINFO');
  assert.deepEqual([q.r16(b + 0x496 + 26), q.r16(b + 0x496 + 32 + 26)], [800, 1600], 'the scan line at 8 and 16 bits');
  q.displaySlot(913, 765);
  assert.deepEqual([q.r16(b + 0x3ee + 24), q.r16(b + 0x496 + 32 + 26)], [913, 1832], 'a second size patches the same records (913 x 2 to 8 bytes)');
  // at 24 bits the driver's modes stop at 800x600 (BIOS mode 30h): that entry takes the size, and 1024x768's records
  // are the driver's own again
  assert.deepEqual(q.displaySlot(913, 520, 24), { w: 800, h: 600 });
  assert.deepEqual(q.customMode, { w: 913, h: 520, mode: 0x30 });
  assert.deepEqual([q.r16(b + 0x3ee + 20), q.r16(b + 0x3ee + 22), q.r16(b + 0x1b06 + 20)], [913, 520, 913], 'the 800x600 entry');
  assert.deepEqual([q.r16(b + 0x3ee + 24), q.r16(b + 0x3ee + 26), q.r16(b + 0x1a1a + 8)], [1024, 768, 1024], '1024x768 as the driver has it');
  assert.equal(q.r16(b + 0x496 + 64 + 22), (913 * 3 + 7) & ~7, 'the 24-bit scan line of the 800x600 entry');
  assert.equal(q.r16(b + 0x19ac + 8), 913, 'its GDIINFO');
  q.displaySlot(800, 600, 24);
  assert.deepEqual([q.customMode, q.r16(b + 0x3ee + 20), q.r16(b + 0x19ac + 8)], [null, 800, 800], 'a listed size: the driver\'s records unchanged');
}
// VDD 85h, the display configuration USER reads before a mode change: the display devnode and the driver its
// software key names (USER restarts Windows for a mode whose driver differs from the loaded one's file)
{
  const W = window.W95Win32, sw = 'hklm\\system\\currentcontrolset\\services\\class\\display\\0000';
  W.regSet('hklm\\enum\\root\\*pnp0912\\0000', 'Class', 'Display'); W.regSet('hklm\\enum\\root\\*pnp0912\\0000', 'Driver', 'Display\\0000');
  W.regSet(sw + '\\default', 'drv', 'tseng.drv');
  const q = Object.create(P);
  Object.defineProperty(q, 'u8', { value: mem });
  Object.assign(q, { r16: p.r16, r32: p.r32, w16: (a, v) => dv.setUint16(a, v, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), retf16: () => 0,
    lin: a => 0x700000 + (a & 0xffff), displayConfig: () => ({ w: 913, h: 520, bpp: 16 }), ne: new Map([['DISPLAY', { fileName: 'TSENG.DRV' }]]) });
  q.cpu = Object.fromEntries(Object.entries({ eax: 0x85, es: 0, edi: 0, ecx: 0x32, edx: 0, ebx: 1 }).map(([k, v]) => [k, { value: v }]));
  q.thunk16Def('VDD.#0').def[2].call(q);
  const dn = q.devnodes().find(d => d.id === 'ROOT\\*PNP0912\\0000');
  assert.equal(q.r32(0x700004), dn.handle, 'diDevNodeHandle: the display\'s devnode');
  assert.equal(q.readA(0x700008), 'tseng.drv', 'diDriverName: its DEFAULT\\drv');
  assert.deepEqual([q.r16(0x700018), q.r16(0x70001a), mem[0x70001f]], [913, 520, 16]);
}
console.log('w32acl: ok');
