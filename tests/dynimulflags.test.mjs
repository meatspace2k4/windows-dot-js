// CF and OF from run-time code's two- and three-operand IMUL (0Fh AFh, 69h, 6Bh), set when the signed product does not
// fit the operand; OF from ROL and ROR by 1 and from SHLD and SHRD by 1 (the sign changed). They were left 0, or as
// they were, where a program reads them after the instruction
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const ACC = 0x40000, AT = 0x200000, END = AT + 0x1000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {}; p.selLimit = () => 0xffff; p.ne = new Map(); p.modules = [];
new DataView(mem.buffer).setUint32(ACC + 0x18, 0x400000, true);   // (0x18: a 32-bit code segment)
/** `code` run as 32-bit code from EAX and ECX, CF and OF set first: EAX and the flags after */
const run = (code, eax, ecx, flags = 0) => {
  const jmp = [0xe9, ...new Uint8Array(new Int32Array([(END - AT) - (code.length + 5)]).buffer)];
  p.u8.set([...code, ...jmp], AT); p.dynCache = new Map();
  p.cpu.cs.value = 0x18; p.cpu.csb.value = AT; p.cpu.eax.value = eax; p.cpu.ecx.value = ecx; p.cpu.cf.value = flags; p.cpu.of.value = flags;
  let eip = AT; for (let k = 0; k < 4 && eip !== END; k++) eip = p.dynBlock(eip).run() >>> 0;
  return [p.cpu.eax.value >>> 0, p.cpu.cf.value & 1, p.cpu.of.value & 1];
};
assert.deepEqual(run([0x0f, 0xaf, 0xc1], 0x10000, 0x10000), [0, 1, 1], 'imul eax, ecx: 2^32 does not fit');
assert.deepEqual(run([0x0f, 0xaf, 0xc1], 0xffffffff, 0xffffffff, 1), [1, 0, 0], 'imul eax, ecx: -1 * -1 fits');
assert.deepEqual(run([0x66, 0x0f, 0xaf, 0xc1], 0x4000, 2), [0x8000, 1, 1], 'imul ax, cx: 8000h is no positive 16-bit number');
assert.deepEqual(run([0x6b, 0xc0, 0x10], 0x10000000, 0), [0, 1, 1], 'imul eax, eax, 16');
assert.deepEqual(run([0x69, 0xc0, 0x00, 0x00, 0x01, 0x00], 0x8000, 0), [0x80000000, 1, 1], 'imul eax, eax, 10000h');
assert.deepEqual(run([0xd1, 0xc0], 0x40000000, 0, 0), [0x80000000, 0, 1], 'rol eax, 1: the top bit changed');
assert.deepEqual(run([0xd1, 0xc8], 0x00000001, 0, 0), [0x80000000, 1, 1], 'ror eax, 1: the top two bits differ');
assert.deepEqual(run([0x0f, 0xa4, 0xc8, 0x01], 0x40000000, 0, 0), [0x80000000, 0, 1], 'shld eax, ecx, 1: the sign changed');
// XADD (0Fh C1h): the sum to the destination, its old value to the source, flags as ADD
assert.deepEqual(run([0x0f, 0xc1, 0xc8], 0xffffffff, 2, 0), [1, 1, 0], 'xadd eax, ecx: EAX the sum, carried out');
assert.equal(p.cpu.ecx.value >>> 0, 0xffffffff, 'xadd eax, ecx: ECX the old EAX');
console.log('dynimulflags: ok');
