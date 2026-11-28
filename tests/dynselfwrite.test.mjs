// A store through CS into an instruction later in the same block is what that instruction then runs with: run-time
// code ends the block after a store through CS, and the next one is translated from the bytes as they are. SYSDETMG's
// real-mode INT 12h stub (Windows 95 Setup's hardware detection) writes its INT's operand 43 bytes on with
// mov cs:[67h], al, and ran the INT with the number before: no INT 21h AH=52h, a device chain walked from garbage
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const DESC_HI = 0x30004, AT = 0x200000, END = AT + 0x1000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {}; p.selLimit = () => 0xffff; p.ne = new Map(); p.modules = [];
new DataView(mem.buffer).setUint32(DESC_HI + 0x18, 0x400000, true);   // (0x18: a 32-bit code segment)
const run = code => {
  const jmp = [0xe9, ...new Uint8Array(new Int32Array([(END - AT) - (code.length + 5)]).buffer)];
  p.u8.set([...code, ...jmp], AT); p.dynCache = new Map(); p.dynFast = new Map();
  p.cpu.cs.value = 0x18; p.cpu.csb.value = AT; p.cpu.eax.value = 0;
  let eip = AT; for (let k = 0; k < 6 && eip !== END; k++) eip = p.dynBlock(eip).run() >>> 0;
  return p.cpu.eax.value & 0xff;
};
// mov byte cs:[9], 42h (2E C6 05 disp32 imm8: 8 bytes) writes the immediate of mov al, 0 (B0 00) right after it
assert.equal(run([0x2e, 0xc6, 0x05, 0x09, 0, 0, 0, 0x42, 0xb0, 0x00]), 0x42, 'the INT-operand pattern through a ModR/M store');
// mov cs:[9], al (2E A2 disp32: 6 bytes, AL 77h from mov al, 77h before it) writes the immediate of mov al, 0; add al, 1
assert.equal(run([0xb0, 0x77, 0x2e, 0xa2, 0x09, 0, 0, 0, 0xb0, 0x00, 0x04, 0x01]), 0x78, 'through mov moffs, as SYSDETMG\'s stub writes it');
console.log('dynselfwrite: ok');
