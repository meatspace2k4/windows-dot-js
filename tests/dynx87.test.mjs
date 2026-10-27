// The run-time translator's x87 (dyn.js x87), as the static recompiler's: the stack at FPU, loads and stores of each
// size, arithmetic in both directions, compares into the status word, rounding by the control word, FWAIT passed over
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
// the code at 200000h, then a jump to 400000h, run as one run-time block on a fresh processor (operands put in first)
const run = (code, pre = () => {}) => {
  const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
  p.cpu = {};
  for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : n === 'fcw' ? 0x37f : 0);
  p.ne = new Map(); p.trap = () => {};
  const dv = new DataView(mem.buffer); pre(dv);
  p.u8.set([...code, 0xe9, ...new Uint8Array(new Int32Array([0x400000 - (0x200000 + code.length + 5)]).buffer)], 0x200000);
  p.cpu.esp.value = 0x8000;
  assert.equal(p.dynBlock(0x200000).run() >>> 0, 0x400000);
  return { p, dv };
};
const d32 = a => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, a >>> 24];
// fwait; fninit; fld1; fld1; faddp; fist [300000h]; fldpi; fstp qword [300008h]; fild dword [300000h]; fchs; fstp dword [300010h]
{
  const { dv } = run([0x9b, 0xdb, 0xe3, 0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xc1, 0xdb, 0x15, ...d32(0x300000), 0xd9, 0xeb, 0xdd, 0x1d, ...d32(0x300008),
    0xdb, 0x05, ...d32(0x300000), 0xd9, 0xe0, 0xd9, 0x1d, ...d32(0x300010)]);
  assert.equal(dv.getInt32(0x300000, true), 2); assert.equal(dv.getFloat64(0x300008, true), Math.PI); assert.equal(dv.getFloat32(0x300010, true), -2);
}
// subtraction both ways, 10 then 3 loaded: fsubp st(1),st (DE E9: ST1 - ST0 = 7) and fsubrp st(1),st (DE E1: ST0 - ST1 = -7)
for (const [op, want] of [[0xe9, 7], [0xe1, -7]]) {
  const { dv } = run([0xdd, 0x05, ...d32(0x300100), 0xdd, 0x05, ...d32(0x300108), 0xde, op, 0xdd, 0x1d, ...d32(0x300020)],
    v => { v.setFloat64(0x300100, 10, true); v.setFloat64(0x300108, 3, true); });
  assert.equal(dv.getFloat64(0x300020, true), want, `DE ${op.toString(16)}`);
}
// compare: 2 then 1 loaded (fld1; fld1; faddp; fld1), fcompp: ST0 = 1 below ST1 = 2 sets C0; fnstsw ax; both popped
{
  const { p } = run([0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0xe8, 0xde, 0xd9, 0xdf, 0xe0]);
  assert.equal(p.cpu.eax.value & 0x4500, 0x0100); assert.equal(p.cpu.ftop.value, 0);
}
// rounding by the control word: 2.5 to 2 (nearest, even), then with RC toward zero (control word 0F7Fh) 2.7 to 2
{
  const { dv } = run([0xdd, 0x05, ...d32(0x300100), 0xdb, 0x1d, ...d32(0x300000), 0xd9, 0x2d, ...d32(0x300110), 0xdd, 0x05, ...d32(0x300108), 0xdb, 0x1d, ...d32(0x300004)],
    v => { v.setFloat64(0x300100, 2.5, true); v.setFloat64(0x300108, 2.7, true); v.setUint16(0x300110, 0xf7f, true); });
  assert.equal(dv.getInt32(0x300000, true), 2); assert.equal(dv.getInt32(0x300004, true), 2);
}
// feni, fdisi, fsetpm (the 8087's and 287's, WIN87EM's start-up): nothing on a 387, the stack untouched
// fld1; feni; fdisi; fsetpm; fstp dword [300000h]
{
  const { dv } = run([0xd9, 0xe8, 0xdb, 0xe0, 0xdb, 0xe1, 0xdb, 0xe4, 0xd9, 0x1d, ...d32(0x300000)]);
  assert.equal(dv.getFloat32(0x300000, true), 1);
}
console.log('dynx87: ok');
