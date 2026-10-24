// The code run at an address is the one for the mode CS gives: a 16-bit code selector runs the 16-bit module there,
// never a flat module's translation of the same address. MCIAVI loaded over SHELL32.DLL's image ran as SHELL32's
// 32-bit code under its own 16-bit CS (the stack was then switched to the flat one for it), and no exception came:
// Media Player hung where a processor would have run MCIAVI.
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
const flat = { name: 'SHELL32', meta: { textLo: 0x10000, textHi: 0x30000 }, run: () => { ran = 'SHELL32'; return 0; } };
const ne = { name: 'MCIAVI', kind: 'ne', meta: { textLo: 0x18000, textHi: 0x20000 }, run: () => { ran = 'MCIAVI'; return 0; } };
p.modules = [flat, ne];
p.dynRun = () => { ran = 'dyn'; return window.W95Win32.LAYOUT.SENTINEL; };   // (the run ends there)
const CS16 = 0x20d7; p.setDesc(CS16, 0x18000, 0x7fff, 0xfb00);   // a 16-bit code segment

const go = (cs, eip) => { ran = null; p.cpu.cs.value = cs; p.dispatch(eip); return ran; };
assert.equal(go(CS16, 0x18010), 'MCIAVI', 'a 16-bit CS runs the 16-bit module, not the flat one over the same address');
assert.equal(go(0, 0x18010), 'SHELL32', 'flat code runs the flat module');
assert.equal(go(0, 0x28000), 'SHELL32');
assert.equal(go(CS16, 0x28000), 'dyn', 'a 16-bit CS where only a flat module has code: the bytes there, translated at run time');
console.log('modedispatch: ok');
