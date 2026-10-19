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
console.log('hicolormode: ok');
