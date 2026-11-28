// A software interrupt in protected mode goes to the protected-mode vector, as the DPMI host dispatches one: a
// program's own handler where it set one with DPMI 0205h, entered with an interrupt frame (FLAGS, CS, IP) on its
// stack; DPMI 0204h of a vector no program set gives the host's own handler, which a program's handler chains to.
// Windows 95 Setup's SYSDETMG installs one for INT 12h and asks it its DOS calls; answered by the BIOS instead, it
// walked a device chain from garbage until no selectors were left
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, { INTS, K16 } = window.W95NE16;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fs', 'gsb', 'cf', 'pf', 'zf', 'sf', 'df', 'of', 'eip']) p.cpu[r] = { value: 0 };
p.selUsed = new Uint8Array(8192); p.selUsed[0] = 1; p.th16 = []; p.rmode = false; p.ne = new Map(); p.modules = [];
p.rmReflect = () => false; p.refreshSegs = () => {};
const code = p.allocSels(0x100000, 0x10000, 0xfb00), stack = p.allocSels(0x200000, 0x10000, 0xf300);
p.seg('cs', code); p.seg('ss', stack); p.cpu.esp.value = 0x1000;

// no handler set: INT 12h is the host's (the BIOS's memory size)
let r = p.interrupt(0x12, 0x100010);
assert.equal(r, 0x100010, 'the host answers and goes on after the INT');
// DPMI 0204h of INT 12h, unset: the host's own handler, a thunk
p.cpu.eax.value = 0x0204; p.cpu.ebx.value = 0x12; INTS[0x31].call(p, 0);
const host = ((p.cpu.ecx.value & 0xffff) << 16 | (p.cpu.edx.value & 0xffff)) >>> 0;
assert.equal(host >>> 16, 0xfff7, 'a 16-bit thunk'); assert.equal(p.th16[(host & 0xffff) >> 2].key, 'DPMI.#274');
// a program's handler (DPMI 0205h, CX:DX): the INT enters it with IP, CS, FLAGS on the stack
p.cpu.eax.value = 0x0205; p.cpu.ebx.value = 0x12; p.cpu.ecx.value = code; p.cpu.edx.value = 0x0400; INTS[0x31].call(p, 0);
p.cpu.cf.value = 1;
r = p.interrupt(0x12, 0x100010);
assert.equal(r, 0x100400, 'into the program\'s handler');
const sp = p.cpu.esp.value & 0xffff;
assert.equal(sp, 0x1000 - 6); assert.deepEqual([p.r16(0x200000 + sp), p.r16(0x200000 + sp + 2), p.r16(0x200000 + sp + 4) & 1], [0x10, code, 1], 'IP, CS, FLAGS (CF)');
// its chaining to the host's handler: the frame popped, the host's INT 12h answered, back after the INT
const [, , fn] = K16['DPMI.#274'];
p.cpu.eax.value = 0x444d;
r = fn.call(p);
assert.equal(r, 0x100010, 'back at the INT\'s caller'); assert.equal(p.cpu.esp.value & 0xffff, 0x1000, 'the frame popped');
console.log('pmintvector: ok');
