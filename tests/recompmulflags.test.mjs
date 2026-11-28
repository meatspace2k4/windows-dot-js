// CF and OF from recomp.py's one-operand MUL and IMUL at 16 and 8 bits, as dyn.js muldiv sets them: MUL's high half
// not zero, IMUL's product not its low half sign-extended. At 16 bits they were left as the instruction before had
// them: SETUPX's strtol (1:22Ch) took a CMP's carry after MUL CX as an overflow, every number it parsed was
// 7FFFFFFFh, and no INF's %17% or %25% was substituted. Each instruction is translated by recomp.py as a block of
// 16-bit code and run from a set carry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tools = fileURLToPath(new URL('../tools/', import.meta.url));
const TEXT = 0x10000, LOOKUP = 0x20000;
const build = hex => Buffer.from(execFileSync('python3', ['-c', `
import sys, capstone
sys.path.insert(0, ${JSON.stringify(tools)})
import recomp
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_16); md.detail = True
got = next(md.disasm(bytes.fromhex('${hex}'), ${TEXT}))
ins = recomp.Insn(); ins.i = got; ins.addr = got.address; ins.size = got.size; ins.next = got.address + got.size
ins.mn = got.mnemonic.split()[-1]; ins.ops = got.operands; ins.prefix = got.prefix; ins.segbase = ${TEXT}; ins.bits = 16; ins.live = recomp.ALLF
f = recomp.Translator(None, {}).block(${TEXT}, [ins])
sys.stdout.write(recomp.assemble([f], ${TEXT}, ${TEXT} + 16, ${LOOKUP}).hex())
`]).toString(), 'hex');

/** `hex` run from AX and CX with CF and OF set: [AX, DX, CF, OF] after */
const run = (hex, ax, cx) => {
  const mem = new WebAssembly.Memory({ initial: 2048 }), dv = new DataView(mem.buffer);
  const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget'];
  const cpu = Object.fromEntries(names.map(n => [n, new WebAssembly.Global({ value: 'i32', mutable: true }, 0)]));
  const env = new Proxy({ mem }, { get: (t, k) => (k in t ? t[k] : () => 0) });
  const m = new WebAssembly.Instance(new WebAssembly.Module(build(hex)), { env, cpu: new Proxy(cpu, { get: (t, k) => t[k] || new WebAssembly.Global({ value: 'i32', mutable: true }, 0) }) });
  dv.setUint32(LOOKUP, 1, true);   // (the block at TEXT is function 1)
  cpu.budget.value = 100; cpu.eax.value = ax; cpu.ecx.value = cx; cpu.cf.value = 1; cpu.of.value = 1;
  m.exports.run(TEXT);
  return [cpu.eax.value & 0xffff, cpu.edx.value & 0xffff, cpu.cf.value & 1, cpu.of.value & 1];
};
assert.deepEqual(run('f7e1', 0, 10), [0, 0, 0, 0], 'mul cx: 0 * 10, the carry before cleared');
assert.deepEqual(run('f7e1', 2, 10), [20, 0, 0, 0], 'mul cx: 2 * 10 fits AX');
assert.deepEqual(run('f7e1', 0x8000, 2), [0, 1, 1, 1], 'mul cx: 10000h reaches DX');
assert.deepEqual(run('f7e9', 0xffff, 0xffff), [1, 0, 0, 0], 'imul cx: -1 * -1 fits AX');
assert.deepEqual(run('f7e9', 0x4000, 2), [0x8000, 0, 1, 1], 'imul cx: 8000h is no positive 16-bit number');
assert.deepEqual(run('f7e9', 0xffff, 2), [0xfffe, 0xffff, 0, 0], 'imul cx: -2 fits AX, DX its sign');
assert.deepEqual(run('f6e1', 0x10, 0x0f), [0xf0, 0, 0, 0], 'mul cl: F0h fits AL');
assert.deepEqual(run('f6e9', 0x10, 0x0f), [0xf0, 0, 1, 1], 'imul cl: F0h is no positive 8-bit number');
assert.deepEqual(run('f6e9', 0xff, 0x02), [0xfffe, 0, 0, 0], 'imul cl: -2 fits AL');
console.log('recompmulflags: ok');
