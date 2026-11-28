// INT 15h AH=4Dh, a vendor's BIOS service an AT BIOS does not have, answers as one: CF set, AH 86h (function not
// supported), AL kept. Windows 95 OSR 2.5 Setup's SYSDETMG asks AX=4DD4h on Analyzing Your Computer; the system ended
// SUWIN on "unhandled int 15h ax=4dd4"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, { INTS } = window.W95NE16;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 32, maximum: 32 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'cf', 'es']) p.cpu[r] = { value: 0 };
p.cpu.eax.value = 0x4dd4;
assert.equal(INTS[0x15].call(p, 0), undefined, 'answered, not trapped');
assert.equal(p.cpu.cf.value, 1, 'CF: not supported');
assert.equal(p.cpu.eax.value & 0xffff, 0x86d4, 'AH 86h, AL kept');
assert.equal(p.trapped, undefined);
console.log('int15vendor: ok');
