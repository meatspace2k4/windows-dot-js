// The adapter's custom mode (a size TSENG.DRV does not list, in its 1024x768 entry) is the configured size in every
// record the driver keeps for that entry: its resolution tables, its GDIINFO, its scan lines, and the description of
// each depth's screen in its data segment (width, height, bytes a line, bits a pixel), which the DIB engine draws by.
// Those descriptions kept saying 1024x768 while the rest said the configured size, so a 732x484 screen was drawn
// through a description of another, and the DIB engine's blits wrote outside the screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'system.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const d = window.W95SYSTEM.ne.DISPLAY, file = Buffer.from(d.file, 'base64');
const mem = new Uint8Array(64 << 20);
for (const s of d.meta.segs) mem.set(file.subarray(s.fileoff, s.fileoff + (s.len || 0)), s.base);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
p.mem = { buffer: mem.buffer };
p.ne = new Map([['DISPLAY', { segs: d.meta.segs }]]);
const data = d.meta.segs.find(s => s.num === 7).base;
const desc = at => [0, 1, 2, 3].map(i => new DataView(mem.buffer).getUint32(data + at + 4 * i, true));
// (the descriptions as the driver has them: 1024x768 at 8 and at 16 bits)
assert.deepEqual(desc(0x382), [1024, 768, 1024, 8]);
assert.deepEqual(desc(0x3a6), [1024, 768, 2048, 16]);

assert.deepEqual(p.displaySlot(732, 484, 16), { w: 1024, h: 768 }, 'the custom size stands in the 1024x768 entry');
assert.deepEqual(desc(0x3a6), [732, 484, 1464, 16], "the 16-bit screen's description is the configured size");
assert.deepEqual(desc(0x382), [732, 484, 736, 8], "and the 8-bit one's");

p.displaySlot(818, 570, 16);
assert.deepEqual(desc(0x3a6), [818, 570, 1640, 16], 'another custom size replaces it');

p.displaySlot(800, 600, 16);
assert.deepEqual(desc(0x3a6), [1024, 768, 2048, 16], 'a size the driver lists puts its records back');
assert.deepEqual(desc(0x382), [1024, 768, 1024, 8]);
console.log('customdesc: ok');
