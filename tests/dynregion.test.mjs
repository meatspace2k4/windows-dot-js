// Code of a module loaded from its file runs as a region: its blocks, reached by the near jumps, calls and branches
// known as they are translated, in one function whose loop goes from block to block without the host. A loop of many
// rounds and a call into a subroutine run to the same registers as block by block, in a few calls from the host
// (one block a module, called one at a time, ran Windows 98 Setup's copy engine, SETUPX, at a crawl). Code of no
// module from a file (DIBENG's blits) runs block by block as before
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, P = Process.prototype;
const ACC = 0x40000, AT = 0x200000, STK = 0x300000;
const machine = () => {
  const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
  p.cpu = {};
  for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
  // (tick as the machine's: the block budget filled again, win32.js; a region counts its rounds in it)
  p.trap = () => {}; p.selLimit = () => 0xffffffff; p.tick = () => { p.cpu.budget.value = 0x1000; return 0; }; p.modules = [];
  new DataView(mem.buffer).setUint32(ACC + 0x18, 0x400000, true);   // (0x18: a 32-bit code segment; 0x20: a 32-bit stack)
  new DataView(mem.buffer).setUint32(ACC + 0x20, 0x400000, true);
  return p;
};
// 32-bit code: ecx = 1000; eax = 0; loop: call add; dec ecx; jnz loop; jmp out (to the sentinel)
//   add: add eax, ecx; ret
const code = [];
const at = () => AT + code.length;
code.push(0xb9, 0xe8, 0x03, 0x00, 0x00);   // mov ecx, 1000
code.push(0x31, 0xc0);                     // xor eax, eax
const loop = at();
code.push(0xe8, 0, 0, 0, 0);               // call add (rel32, below)
const callEnd = at();
code.push(0x49);                           // dec ecx
code.push(0x75, (loop - (at() + 2)) & 0xff);   // jnz loop
const jmpAt = at();
code.push(0xe9, 0, 0, 0, 0);               // jmp to the sentinel (rel32, below)
const add = at();
code.push(0x01, 0xc8);                     // add eax, ecx
code.push(0xc3);                           // ret
const rel = (from, to) => [(to - from) & 0xff, ((to - from) >> 8) & 0xff, ((to - from) >> 16) & 0xff, ((to - from) >>> 24) & 0xff];
code.splice(loop - AT + 1, 4, ...rel(callEnd, add));
code.splice(jmpAt - AT + 1, 4, ...rel(jmpAt + 5, LAYOUT.SENTINEL));

const run = asModule => {
  const p = machine(); p.u8.set(code, AT);
  p.ne = new Map(asModule ? [['SETUPX', { meta: { dynamic: true }, segs: [{ num: 1, sel: 0x18, base: AT, len: 0x1000, flags: 0 }] }]] : []);
  p.cpu.cs.value = 0x18; p.cpu.csb.value = 0; p.cpu.ss.value = 0x20; p.cpu.ssb.value = 0; p.cpu.esp.value = STK;
  let calls = 0; const real = p.dynBlock; p.dynBlock = function (eip) { const b = real.call(this, eip); if (!b) return b; return { ...b, run: () => { calls++; return b.run(); } }; };
  const end = p.dynRun(AT);
  return { end: end >>> 0, eax: p.cpu.eax.value >>> 0, ecx: p.cpu.ecx.value >>> 0, esp: p.cpu.esp.value >>> 0, calls };
};
const byBlock = run(false), byRegion = run(true);
assert.equal(byBlock.end, LAYOUT.SENTINEL >>> 0);
assert.equal(byBlock.eax, 500500, 'the sum of 1..1000, block by block');
assert.deepEqual({ ...byRegion, calls: 0 }, { ...byBlock, calls: 0 }, 'the same end, registers and stack as a region');
assert.ok(byBlock.calls > 3000, `block by block: a call from the host each block (${byBlock.calls})`);
assert.ok(byRegion.calls < 10, `as a region: a few calls from the host (${byRegion.calls})`);
console.log('dynregion: ok');
