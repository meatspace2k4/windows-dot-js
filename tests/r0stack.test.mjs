// Where the next ring-0 frame goes is a linear address of the stack in use: a 16-bit stack's through its selector's
// base, a flat one's ESP as it is, whether SS is null or the flat selector (16-bit code that jumped into a 32-bit
// module runs on the flat alias of its stack, SS the flat selector, ESP the linear address). stackLin took every
// nonnull SS as 16-bit, so with SS the flat selector it gave ESP's low word: a VxD call made from such code then got
// its frame in the first 64 KB (ESP 0A3C8040h: a frame at 7F40h, over the interrupt vectors and the BIOS data) or,
// for a low word under 100h, past the end of memory (its first push an out-of-bounds access, IFSMGR's event at
// 1203893h and its 12187A7h). r0LowSet, which puts new frames below every stopped run's, read each run's ESP raw the
// same way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, L = window.W95NE16.L;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(64 << 20) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb']) p.cpu[r] = { value: 0 };
p.selUsed = new Uint8Array(0x2000); p.th16 = []; p.depth = 0; p.stackLevel = 0;
p.setDesc(L.FLATDS, 0, 0xffffffff, 0xcff300);
const SEL16 = 0x1407; p.setDesc(SEL16, 0x200000, 0xffff, 0xf300);   // a 16-bit stack segment at 200000h
p.r0Stack = 0x3000000; p.r0Top = 0x3010000 - 16;

// the stack's linear address
p.seg('ss', 0); p.cpu.esp.value = 0x0a3c8040;
assert.equal(p.stackLin(), 0x0a3c8040, 'SS null: ESP');
p.seg('ss', L.FLATDS); p.cpu.esp.value = 0x0a3c8040;
assert.equal(p.stackLin(), 0x0a3c8040, 'SS the flat selector: ESP, not its low word');
p.seg('ss', SEL16); p.cpu.esp.value = 0x00ab7f00;
assert.equal(p.stackLin(), 0x200000 + 0x7f00, 'a 16-bit stack: its base and SP');

// the next ring-0 frame, below the stack in use, while ring-0 code is live
p.r0Depth = 1;
p.seg('ss', L.FLATDS); p.cpu.esp.value = 0x0a3c8040;
assert.equal(p.r0Free(), (0x0a3c8040 - 0x100) & ~3, 'below the flat stack, not at 7F40h');
p.cpu.esp.value = 0x0a3c0040;
assert.ok(p.r0Free() > 0 && p.r0Free() < 0x0a3c0040 && p.r0Free() >= 0x0a3c0040 - 0x100, 'below a flat stack whose low word is under 100h, not past the end of memory');
p.seg('ss', SEL16); p.cpu.esp.value = 0x00ab7f00;
assert.equal(p.r0Free(), (0x200000 + 0x7f00 - 0x100) & ~3, 'below a 16-bit stack');
p.r0Depth = 0;

// a ring-0 run (r0Start) has a stack of its own, whatever runs are stopped and wherever they stopped: a run stopped in
// VM code it called has a 16-bit SS:SP, and frames placed below that landed in VxD images (VTDAPI's event saved the
// client registers over its own code at VTDAPI+186h). A run that ends gives its stack to the next
{
  let next = 0x3400000; const tops = [];
  p.alloc = n => { const a = next; next += n; return a; };
  p.saveFull = () => ({}); p.loadFull = () => {}; p.tibFor = null; p.r0Runs = []; p.vmIrqDeliver = () => {};
  p.cpu.cf = { value: 0 }; p.cpu.zf = { value: 0 };
  p.seg('ss', SEL16); p.cpu.esp.value = 0x7f00;
  // the first run stops in VM code on a 16-bit stack
  p.runTop = function () { tops.push(this.cpu.esp.value); this.seg('ss', SEL16); this.cpu.esp.value = 0x00ab7f00; return 1; };
  assert.equal(p.r0Start(0x1820049), null); p.depth = 0;
  // the next run's frames: its own stack, not below the stopped run's SS:SP (200000h + 7F00h)
  p.runTop = function () { tops.push(this.cpu.esp.value); return 0; };
  p.r0Start(0x18200ba); p.depth = 0;
  assert.equal(tops[0], 0x3400000 + 0x10000 - 16 - 4, "the first run's stack");
  assert.equal(tops[1], 0x3410000 + 0x10000 - 16 - 4, 'the second its own, not under the stopped run');
  p.r0Start(0x18200ba); p.depth = 0;
  assert.equal(tops[2], tops[1], 'an ended run gives its stack to the next');
  assert.equal(p.r0Runs.length, 1);
}
console.log('r0stack: ok');
