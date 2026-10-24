// call16's stack alias for a call made on the flat stack (SS the flat selector) low in memory: the alias's base is
// 64 KB below the stack top and never below 0. Taken below 0 it wrapped to FFFFxxxxh, and the first 16-bit API the
// call reached read its arguments past the end of memory (RangeError in api16, from USER's SignalProc32 as a
// program's end was signalled).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, L = window.W95NE16.L;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(4 << 20) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb']) p.cpu[r] = { value: 0 };
p.selUsed = new Uint8Array(0x2000); p.th16 = []; p.depth = 0; p.stackLevel = 0; p.init16 = () => {};
p.setDesc(L.FLATDS, 0, 0xffffffff, 0xcff300);
p.seg('ss', L.FLATDS); p.cpu.esp.value = 0x7f40;   // (a flat stack in the first 64 KB)
let seen = null;
p.runAt = () => { seen = { ssb: p.cpu.ssb.value >>> 0, sp: p.cpu.esp.value & 0xffff }; return 0; };
p.call16(0x1407, 0x1886, [['l', 0x20], ['w', 0x1af7]]);
assert.ok(seen.ssb < p.mem.buffer.byteLength, `alias base ${seen.ssb.toString(16)} inside memory`);
assert.equal(seen.ssb + seen.sp + 4 + 6, 0x7f40 - 16, 'the arguments lie just below the stack top, as before');
console.log('call16stack: ok');
