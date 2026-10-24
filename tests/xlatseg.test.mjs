// XLAT reads its table at DS:[BX + AL], or in the segment a prefix names: VGA.DRV's color match looks up its plane
// bits with `cs: xlat` (2Eh D7h), which capstone decodes with no operand to carry the override. Each form is
// translated by recomp.py as a block of 16-bit code and run.
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

const run = hex => {
  const mem = new WebAssembly.Memory({ initial: 2048 }), u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer);
  const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget'];
  const cpu = Object.fromEntries(names.map(n => [n, new WebAssembly.Global({ value: 'i32', mutable: true }, 0)]));
  const env = new Proxy({ mem }, { get: (t, k) => (k in t ? t[k] : () => 0) });
  const m = new WebAssembly.Instance(new WebAssembly.Module(build(hex)), { env, cpu: new Proxy(cpu, { get: (t, k) => t[k] || new WebAssembly.Global({ value: 'i32', mutable: true }, 0) }) });
  dv.setUint32(LOOKUP, 1, true);   // (the block at TEXT is function 1)
  cpu.csb.value = 0x100000; cpu.dsb.value = 0x200000; cpu.ssb.value = 0x300000; cpu.budget.value = 100;
  cpu.ebx.value = 0x10; cpu.eax.value = 0x1202;
  u8[0x100012] = 0xc5; u8[0x200012] = 0xd5; u8[0x300012] = 0x35;
  m.exports.run(TEXT);
  return cpu.eax.value & 0xffff;
};
assert.equal(run('d7'), 0x12d5, 'no prefix: DS');
assert.equal(run('2ed7'), 0x12c5, 'cs: the code segment');
assert.equal(run('36d7'), 0x1235, 'ss: the stack segment');
console.log('xlatseg: ok');
