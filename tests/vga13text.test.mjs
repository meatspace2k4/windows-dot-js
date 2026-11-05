// The VGA BIOS's characters in mode 13h (IO.SYS's start-up logo): drawn as 8x8 pixels, 40 columns, in BL's colour,
// the text buffer at B800h left alone. Written there at 80 columns, WININIT's message under the logo showed afterwards on
// the text screen torn across lines, a run of spaces before "iles..."
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'v86.js']) new Function(read(f))();
const M = window.W95V86, m = M.machine({ base: 0x10000, mem: new WebAssembly.Memory({ initial: 64, maximum: 64 }) });
m.vgaInit(); const V = m.v86;   // (the machine's first megabyte at V in its memory)
m.font8 = new Uint8Array(256 * 8); for (let y = 0; y < 8; y++) m.font8['A'.charCodeAt(0) * 8 + y] = 0xff;   // ('A' a solid block)
const int10 = (ax, bx = 0, cx = 0, dx = 0) => { m.cpu.eax.value = ax; m.cpu.ebx.value = bx; m.cpu.ecx.value = cx; m.cpu.edx.value = dx; M.BIOS[0x10].call(m); };
int10(0x0013);
assert.equal(m.m8(0x449), 0x13); assert.equal(m.m16(0x44a), 40, 'mode 13h has 40 columns');
const b800 = m.u8.slice(V + 0xb8000, V + 0xb8000 + 4000);
int10(0x0200, 0, 0, 0x0300 | 39);   // (row 3, column 39: the last column)
int10(0x0e41, 0x0f); int10(0x0e41, 0x0f);   // ('A' twice: the second wraps to row 4, column 0)
const px = (x, y) => m.u8[V + 0xa0000 + y * 320 + x];
assert.equal(px(39 * 8, 3 * 8), 0x0f, 'the first at row 3, column 39, in pixels of BL\'s colour');
assert.equal(px(0, 4 * 8 + 7), 0x0f, 'the second wrapped at 40 columns to the next row');
assert.deepEqual([m.m8(0x451), m.m8(0x450)], [4, 1], 'the cursor after it');
assert.deepEqual(m.u8.slice(V + 0xb8000, V + 0xb8000 + 4000), b800, 'the text buffer untouched');
console.log('vga13text: ok');
