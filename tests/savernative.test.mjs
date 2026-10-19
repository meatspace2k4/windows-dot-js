// A screen saver on the machine's own USER32/GDI32 (Display Properties' monitor preview, /p hwnd): OpenGL takes its
// DC as GDI32's, sized from the DC's window, and presents each frame through GDI32's SetDIBitsToDevice; the pixel
// format entries GDI32 asks OPENGL32 for exist.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'gl.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, GL = W.API.OPENGL32, { Context } = window.W95GL;

for (const n of ['wglChoosePixelFormat', 'wglSetPixelFormat', 'wglGetPixelFormat', 'wglDescribePixelFormat', 'wglSwapBuffers'])
  assert.ok(GL[n], `OPENGL32 has ${n} (GDI32's pixel-format and SwapBuffers calls land there)`);

// a process whose DCs are the machine GDI32's: native exports at fake addresses, calls recorded
const mem = new ArrayBuffer(1 << 20), u8 = new Uint8Array(mem), dv = new DataView(mem);
let top = 0x1000;
const calls = [];
const ADDR = { WindowFromDC: 0x100, GetClientRect: 0x104, SetDIBitsToDevice: 0x200, GetDeviceCaps: 0x204 };
const exp = names => ({ exports: new Map(names.map(n => [n, ADDR[n]])) });
const p = {
  u8, dv, pc: { nativeGdi: true },
  byName: new Map([['USER32', exp(['WindowFromDC', 'GetClientRect'])], ['GDI32', exp(['SetDIBitsToDevice', 'GetDeviceCaps'])]]),
  alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {},
  r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), w16: (a, v) => dv.setUint16(a, v, true),
  obj: h => (h === 0x77 ? { kind: 'glrc', ctx: {} } : null),
  call(addr, args) {
    calls.push([addr, args]);
    if (addr === ADDR.WindowFromDC) return 0x2a4;
    if (addr === ADDR.GetClientRect) { dv.setInt32(args[1] + 8, 152, true); dv.setInt32(args[1] + 12, 112, true); return 1; }
    if (addr === ADDR.GetDeviceCaps) return args[1] === 12 ? 8 : 1;   // (a 256-color screen: BITSPIXEL 8, PLANES 1)
    return 1;
  },
};
assert.equal(GL.wglMakeCurrent[1].call(p, 0x5d6, 0x77), 1, 'wglMakeCurrent takes the GDI32 DC');
const o = p.obj(0x77);   // (a new object per call: read the one MakeCurrent set through glctx)
const dc = p.glctx.dc;
assert.equal(dc.native, true);
assert.equal(dc.hdc, 0x5d6);
assert.deepEqual([dc.w, dc.h], [152, 112], 'the context is the size of the DC window client area');
assert.deepEqual(calls[0], [ADDR.WindowFromDC, [0x5d6]]);

// a 2x2 frame: RGBA rows bottom-up from WebGL become a BGRX bottom-up DIB handed to SetDIBitsToDevice
const px = [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255];
const ctx = Object.create(Context.prototype);
Object.assign(ctx, { p, cap: new Set(), canvas: { width: 2, height: 2 }, g: { RGBA: 1, UNSIGNED_BYTE: 2, flush() {}, readPixels(x, y, w, h, f, t, out) { out.set(px); } } });
calls.length = 0;
ctx.presentNative(dc);
const [addr, args] = calls.find(c => c[0] === ADDR.SetDIBitsToDevice) || [];
assert.equal(addr, ADDR.SetDIBitsToDevice, 'the frame goes to GDI32');
assert.deepEqual(dc.win(), { w: 152, h: 112 }, 'fitDrawable reads the window size from the GDI32 DC');
// (the screen is 8 bits: an 8-bit DIB of 3-3-2 indices into the palette the saver realized, DIB_PAL_COLORS)
const head = 40 + 512, i332 = (r, g, b) => (r >> 5) | ((g >> 5) << 3) | ((b >> 6) << 6);
assert.deepEqual(args.slice(0, 10), [0x5d6, 0, 0, 2, 2, 0, 0, 0, 2, dc.bits + head]);
assert.equal(args[10], dc.bits); assert.equal(args[11], 1, 'DIB_PAL_COLORS');
assert.equal(p.r32(dc.bits), 40); assert.equal(dv.getInt32(dc.bits + 8, true), 2, 'bottom-up DIB');
assert.equal(dv.getUint16(dc.bits + 14, true), 8); assert.equal(p.r32(dc.bits + 32), 256);
assert.equal(dv.getUint16(dc.bits + 40 + 2 * 77, true), 77, 'identity color table');
assert.deepEqual([...u8.slice(dc.bits + head, dc.bits + head + 2)], [i332(10, 20, 30), i332(40, 50, 60)], 'row 0, GL_DITHER off');
assert.deepEqual([...u8.slice(dc.bits + head + 4, dc.bits + head + 6)], [i332(70, 80, 90), i332(100, 110, 120)], 'row 1 at the 4-byte stride');
// the pixel format GDI32's DescribePixelFormat forwards for that DC: 8-bit RGB 3-3-2, PFD_NEED_PALETTE (the saver
// takes the format whose cColorBits is BITSPIXEL * PLANES)
const pfd = p.alloc(40);
GL.wglDescribePixelFormat[1].call(p, 0x5d6, 1, 40, pfd);
assert.equal(u8[pfd + 9], 8); assert.ok(p.r32(pfd + 4) & 0x80, 'PFD_NEED_PALETTE');
assert.deepEqual([...u8.slice(pfd + 10, pfd + 16)], [3, 0, 3, 3, 2, 6], 'red 3@0, green 3@3, blue 2@6');

// a process on the JS personality keeps its own DCs
const q = { ...p, pc: {}, obj: h => (h === 0x77 ? { kind: 'glrc', ctx: {} } : h === 0x99 ? { kind: 'dc', w: 5, h: 5 } : null) };
assert.equal(GL.wglMakeCurrent[1].call(q, 0x99, 0x77), 1);
assert.equal(q.glctx.dc.kind, 'dc', 'a JS DC is used as is');
void o;
console.log('savernative: ok');
