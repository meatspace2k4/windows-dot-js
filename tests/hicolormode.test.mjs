// The adapter's custom mode (the configured size in the 1024x768 slot) holds at high color too: a 16-bit mode set on
// that slot is the configured size, its pitch two bytes a pixel, so the screen the driver draws is the one GDI was told.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const mem = new Uint8Array(8 << 20);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, { init16() {}, alloc: () => 0x100000, customMode: [913, 765] });
assert.equal(p.setVideoMode(0x38, true, 16), true);
const a = p.scanout();
assert.deepEqual([a.w, a.h, a.bpp], [913, 765, 16], '16-bit custom mode at the configured size');
assert.ok(a.pitch >= 913 * 2 && a.pitch % 8 === 0, `a scan line holds its pixels (pitch ${a.pitch})`);
assert.equal(p.setVideoMode(0x38, true, 0), true);
assert.deepEqual([p.scanout().w, p.scanout().h, p.scanout().bpp], [913, 765, 8], '8-bit custom mode unchanged');
// the W32's segment select 2 (3CBh) keeps what is written (the Tseng driver's W32 check) and adds the bank's high
// bits, so the banks reach past the first megabyte
{
  const out = (port, v) => { p.cpu.eax.value = v; p.portIO(port, 1, false); };
  const inp = port => { p.cpu.eax.value = 0; p.portIO(port, 1, true); return p.cpu.eax.value & 0xff; };
  p.cpu = { eax: { value: 0 } };
  out(0x3cb, 0x11); assert.equal(inp(0x3cb), 0x11);
  out(0x3cb, 0x22); assert.equal(inp(0x3cb), 0x22, 'what is written is kept');
  out(0x3cb, 0x01); out(0x3cd, 0x33);
  assert.equal(p.adapter().bank, 0x13, 'bank 13h: 3 from 3CDh, 1 from 3CBh');
}
// at 16 bits the W32's sprite counts pixel clocks, two to a pixel: TSENG.DRV puts the arrow at x 513 as 1026, with
// its image's columns doubled; the sprite is at pixel 513, two columns to a pixel
{
  p.setVideoMode(0x38, true, 16);
  const r = p.adapter().ima;
  r[0xf7] = 0x80; r[0xe0] = 1026 & 0xff; r[0xe1] = 1026 >> 8; r[0xe4] = 30; r[0xe5] = 0; r[0xe2] = 0; r[0xe6] = 31;
  const sp = p.sprite();
  assert.deepEqual([sp.x, sp.y, sp.px, sp.py, sp.cpp], [513, 30, 0, 31, 2]);
  p.setVideoMode(0x38, true, 0);
  assert.deepEqual([p.sprite().x, p.sprite().cpp], [1026, 1], 'at 8 bits a clock is a pixel');
}
console.log('hicolormode: ok');
