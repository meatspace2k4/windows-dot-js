// The LDT is the processor's: each selector's descriptor in its 8-byte form (ne16.js setDesc), read by run-time code at
// every segment register load, and written by a program through the alias the DPMI host gives (INT 2Fh 1688h
// BX=0BADh, or 168Ah's "MS-DOS" entry with AX=100h). Windows 95 Setup builds a selector for DOS's CDS that way: with
// no alias it read the CDS through selector 0, and reported SUBST and JOIN running. Checked: descriptors round-trip
// (base, byte and page-granular limits, access, D), LAR and LSL answer from them in run-time code, and a descriptor
// written through the alias is the base a segment load then takes
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, LDT = 0x30000, AT = 0x200000, END = AT + 0x1000;
const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
p.cpu = {};
for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
p.trap = () => {}; p.ne = new Map(); p.modules = []; p.selUsed = new Uint8Array(8192); p.selUsed[0] = 1;

// descriptors round-trip
p.setDesc(0x107, 0x12345678, 0xffff, 0xf300);
assert.equal(p.selBase(0x107), 0x12345678); assert.equal(p.selLimit(0x107), 0xffff); assert.equal(p.selAcc(0x107) & 0xff00, 0xf300);
assert.deepEqual([...p.u8.subarray(LDT + 0x100, LDT + 0x108)], [0xff, 0xff, 0x78, 0x56, 0x34, 0xf3, 0x00, 0x12], 'the processor\'s bytes: limit, base 0-15, base 16-23, access, flags|limit 16-19, base 24-31');
p.setDesc(0x10f, 0x400000, 0x7fffff, 0x40fb00);
assert.equal(p.selLimit(0x10f), 0x7fffff, 'a limit past 1 MB in 4 KB pages (G)'); assert.ok(p.selAcc(0x10f) & 0x800000, 'G set'); assert.ok(p.selAcc(0x10f) & 0x400000, 'D kept');
p.setSelBase(0x107, 0xabcd0000); assert.equal(p.selBase(0x107), 0xabcd0000); assert.equal(p.selLimit(0x107), 0xffff, 'a new base keeps the limit');

// run-time code: a 32-bit code segment (flat, CS 18h), the descriptors read by LAR, LSL and a segment load
p.setDesc(0x18, 0, 0xffffffff, 0x40fb00); p.selUsed[3] = 1;
const run = (code, regs) => {
  const jmp = [0xe9, ...new Uint8Array(new Int32Array([(END - AT) - (code.length + 5)]).buffer)];
  p.u8.set([...code, ...jmp], AT); p.dynCache = new Map(); p.dynFast = new Map();
  p.cpu.cs.value = 0x18; p.cpu.csb.value = 0; for (const [k, v] of Object.entries(regs)) p.cpu[k].value = v;
  let eip = AT; for (let k = 0; k < 4 && eip !== END; k++) eip = p.dynBlock(eip).run() >>> 0;
};
run([0x0f, 0x02, 0xc1], { ecx: 0x10f });   // lar eax, ecx
assert.equal(p.cpu.eax.value >>> 0, p.selAcc(0x10f) >>> 0, 'LAR: the high dword without the base'); assert.equal(p.cpu.zf.value, 1);
run([0x0f, 0x03, 0xc1], { ecx: 0x10f });   // lsl eax, ecx
assert.equal(p.cpu.eax.value >>> 0, 0x7fffff, 'LSL: the limit in bytes');

// the alias: INT 2Fh 1688h BX=0BADh gives a data selector of the LDT, and a descriptor written through it is the one
// a segment load takes (mov es, cx after the write)
p.rmode = false; p.cpu.eax.value = 0x1688; p.cpu.ebx.value = 0x0bad;
p.interrupt(0x2f, 0);
const alias = p.cpu.ebx.value & 0xffff;
assert.equal(p.cpu.eax.value & 0xffff, 0, 'AX 0: an alias given'); assert.equal(p.selBase(alias), LDT, 'its base the LDT'); assert.equal(p.selLimit(alias), 0xffff);
const sel = p.allocSels(0, 1), d = LDT + (sel & 0xfff8);
// as Setup writes it: limit, base 0-15, base 16-23, access, flags, base 24-31
p.u8.set([0x00, 0x10, 0x40, 0x03, 0x00, 0xf3, 0x00, 0x00], d);
run([0x8e, 0xc1], { ecx: sel });   // mov es, cx
assert.equal(p.cpu.esb.value >>> 0, 0x340, 'the segment load takes the base written through the alias');
assert.equal(p.selLimit(sel), 0x1000);
console.log('ldtalias: ok');
