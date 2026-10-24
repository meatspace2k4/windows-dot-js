// A module's translation is of its own mode: run under a CS of the other mode it is not what a processor would run
// there, and the dispatcher stops, naming it. MCIAVI's 16-bit code under its own CS ran SHELL32.DLL's 32-bit
// translation of the same address (MCIAVI's image lay over SHELL32's), and no exception ever came: Media Player hung.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 20) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb']) p.cpu[r] = { value: 0 };
p.selUsed = new Uint8Array(0x2000);
let ran = null;
p.modules = [{ name: 'SHELL32', meta: { textLo: 0x10000, textHi: 0x18000 }, run: () => { ran = 'SHELL32'; return 0; } },
  { name: 'MCIAVI', kind: 'ne', meta: { textLo: 0x18000, textHi: 0x20000 }, segs: [{ base: 0x18000, alloc: 0x8000, bits: 16 }], run: () => { ran = 'MCIAVI'; return 0; } },
  { name: 'GDI', kind: 'ne', meta: { textLo: 0x20000, textHi: 0x28000 }, segs: [{ base: 0x20000, alloc: 0x8000, bits: 32 }], run: () => { ran = 'GDI'; return 0; } }];
const CS16 = 0x20d7; p.setDesc(CS16, 0x18000, 0x7fff, 0xfb00);   // a 16-bit code segment

const go = (cs, eip) => { ran = null; p.trapped = null; p.cpu.cs.value = cs; return [p.dispatch(eip), ran, p.trapped]; };
assert.deepEqual(go(CS16, 0x18010), [0, 'MCIAVI', null], '16-bit code under a 16-bit CS runs');
assert.deepEqual(go(0, 0x10010), [0, 'SHELL32', null], 'flat code under a flat CS runs');
assert.deepEqual(go(CS16, 0x10010), [2, null, "16-bit CS 20d7 at 10010, in SHELL32's 32-bit code"], 'a flat module under a 16-bit CS stops');
assert.deepEqual(go(0, 0x18010), [2, null, "32-bit CS 0 at 18010, in MCIAVI's 16-bit code"], 'a 16-bit module under a flat CS stops');
const CS32 = 0x112f; p.setDesc(CS32, 0x20000, 0x7fff, 0x40fb00);   // a 16-bit module's USE32 code segment (GDI's)
assert.deepEqual(go(CS32, 0x20010), [0, 'GDI', null], 'a USE32 segment of a 16-bit module runs under its 32-bit CS');
assert.deepEqual(go(CS16, 0x20010), [2, null, "16-bit CS 20d7 at 20010, in GDI's 32-bit code"], 'and stops under a 16-bit one');
console.log('modedispatch: ok');
