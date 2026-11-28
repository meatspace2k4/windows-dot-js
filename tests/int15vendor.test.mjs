// INT 15h AH=4Dh (a vendor's) and AH=53h (the APM BIOS, none here), services this AT BIOS does not have, answer as
// it does: CF set, AH 86h (function not supported), AL kept. Windows 95 OSR 2.5 Setup's SYSDETMG asks AX=4DD4h and
// 5300h on Analyzing Your Computer; the system ended SUWIN on "unhandled int 15h ax=4dd4", then "ax=5300"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, { INTS } = window.W95NE16;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 32, maximum: 32 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'cf', 'es']) p.cpu[r] = { value: 0 };
for (const ax of [0x4dd4, 0x5300]) {   // (a vendor's; the APM BIOS's installation check: no APM here)
  p.cpu.eax.value = ax; p.cpu.cf.value = 0;
  assert.equal(INTS[0x15].call(p, 0), undefined, 'answered, not trapped');
  assert.equal(p.cpu.cf.value, 1, 'CF: not supported');
  assert.equal(p.cpu.eax.value & 0xffff, 0x8600 | (ax & 0xff), 'AH 86h, AL kept');
  assert.equal(p.trapped, undefined);
}
// the PS/2 pointing device, this machine's mouse: C204h its ID (BH 0, a standard mouse); C201h reset (BH 0, BL AAh)
for (const [ax, bx] of [[0xc204, 0x0000], [0xc201, 0x00aa]]) {
  p.cpu.eax.value = ax; p.cpu.ebx.value = 0x1234; p.cpu.cf.value = 1;
  assert.equal(INTS[0x15].call(p, 0), undefined, `${ax.toString(16)} answered`);
  assert.deepEqual([p.cpu.cf.value, p.cpu.eax.value >> 8 & 0xff, p.cpu.ebx.value & 0xffff], [0, 0, ax === 0xc204 ? 0x0034 : bx], `${ax.toString(16)}: done, AH 0, BH the ID`);
}
console.log('int15vendor: ok');
