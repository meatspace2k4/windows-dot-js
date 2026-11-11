// netpatch.js: fixes to Windows' own code kept by the file's SHA-256, made before the code is translated. A module
// loaded from its file (dyn.js netPatch): a byte patch where the code is as the file has it, the translation the fixed
// code's; a handler the host's hook there; code that is neither as the file nor as the fix has it left. The bundle's
// (tools/netpatch.py): the same patch made in the file's bytes before it is recompiled, at the same place
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'netpatch.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { memo } = window.W95Dyn, T = self.W95NetPatch;

// the file: one code segment at 200h (0: mov ax, 1234h; jmp far 0000:0000) and DGROUP, one export (1:0)
const ne = () => {
  const f = new Uint8Array(0x400), dv = new DataView(f.buffer), w = (o, v) => dv.setUint16(o, v, true);
  f.set([0x4d, 0x5a]); dv.setUint32(0x3c, 0x40, true);
  const n = 0x40; f.set([0x4e, 0x45], n);
  w(n + 0x0c, 0x8001); w(n + 0x0e, 2); w(n + 0x10, 0x100); w(n + 0x12, 0); w(n + 0x14, 0); w(n + 0x16, 0);
  w(n + 0x1c, 2); w(n + 0x1e, 1); w(n + 0x20, 0); w(n + 0x32, 4); w(n + 0x3e, 0x300);
  let p = 0x40; w(n + 0x22, p);
  w(n + p, 0x20); w(n + p + 2, 0x10); w(n + p + 4, 0x0000); w(n + p + 6, 0x10);
  w(n + p + 8, 0x30); w(n + p + 10, 0x10); w(n + p + 12, 0x0001); w(n + p + 14, 0x10);
  p += 16; w(n + 0x24, p); w(n + 0x26, p);
  f[n + p] = 4; f.set([...'PMOD'].map(c => c.charCodeAt(0)), n + p + 1); p += 5; w(n + p, 0); p += 2;
  f[n + p] = 7; f.set([...'ENTRYPT'].map(c => c.charCodeAt(0)), n + p + 1); p += 8; w(n + p, 1); p += 2; f[n + p++] = 0;
  w(n + 0x28, p); w(n + p, 1); p += 2;
  w(n + 0x2a, p); f[n + p] = 0; f[n + p + 1] = 6; f.set([...'KERNEL'].map(c => c.charCodeAt(0)), n + p + 2); p += 8;
  w(n + 0x04, p); f.set([1, 1, 3], n + p); w(n + p + 3, 0); f[n + p + 5] = 0; w(n + 0x06, 6); p += 6;
  dv.setUint32(n + 0x2c, 0, true);
  f.set([0xb8, 0x34, 0x12, 0xea, 0, 0, 0, 0], 0x200);
  return f;
};
const proc = () => {
  const p = Object.create(Process.prototype);
  p.mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.cpu = {}; for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[r] = new WebAssembly.Global({ value: 'i32', mutable: true }, r === 'budget' ? 0x1000 : 0);
  Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(),
    heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, findFile16: () => null, fs: { exists: () => false },
    imports: { env: { api: () => 0, tick: () => 0, f80load: () => 0, f80store() {}, fbld: () => 0, fbstp() {} } }, trap() {}, tick: () => 0 });
  return p;
};
const run = (p, rec) => { const g = rec.segs[0]; p.cpu.cs.value = g.sel; p.cpu.csb.value = g.base; p.cpu.ss.value = rec.segs[1].sel; p.cpu.eax.value = 0; assert.equal(rec.run(g.base), 3); return p.cpu.eax.value & 0xffff; };
const file = ne(), sha = window.W95Win32.sha256(file);

// none for the file: as it is
memo.clear();
{ const p = proc(), rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\PMOD.DLL', file); assert.equal(run(p, rec), 0x1234); }
// a byte patch: the fixed code translated (mov ax, 5678h), the file's bytes untouched
T.files[sha] = { name: 'PMOD', patches: [{ at: '1:1', expect: '3412', bytes: '7856' }] };
memo.clear();
{
  const p = proc(), rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\PMOD.DLL', file);
  assert.equal(run(p, rec), 0x5678, 'the fix translated');
  assert.equal(file[0x201], 0x34, 'the file as it is');
  p.neCompile(rec, true); assert.equal(run(p, rec), 0x5678, 'translated again: made once, still there');
}
// code neither as the file nor as the fix has it: left, as it is
T.files[sha] = { name: 'PMOD', patches: [{ at: '1:1', expect: 'aaaa', bytes: '7856' }] };
memo.clear();
{ const logs = [], log = window.W95Win32.log; window.W95Win32.log = (l, t, s) => logs.push(s);
  const p = proc(), rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\PMOD.DLL', file); window.W95Win32.log = log;
  assert.equal(run(p, rec), 0x1234); assert.ok(logs.some(s => /netpatch at 1:1 finds 3412, not aaaa/.test(s)), logs.join('; ')); }
// a handler: the host's hook at that place
let calls = 0; T.handlers.probe = function () { calls++; return undefined; };
T.files[sha] = { name: 'PMOD', patches: [{ at: '1:0', handler: 'probe' }] };
memo.clear();
{ const p = proc(), rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\PMOD.DLL', file); assert.ok(p.entryHooks && p.entryHooks.get(rec.segs[0].base) === T.handlers.probe, 'hooked at 1:0'); }
// the bundle's: tools/netpatch.py makes the same patch in the file's bytes, at the file offset of segment 1 offset 1
{
  const d = mkdtempSync(join(tmpdir(), 'netpatch-')), src = join(d, 'pmod.dll'); writeFileSync(src, file);
  const out = execFileSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(new URL('../tools', import.meta.url).pathname)}); import netpatch
b = open(sys.argv[1], 'rb').read(); sys.stdout.write(netpatch.apply(b, json.loads(sys.argv[2])).hex())`, src, JSON.stringify({ name: 'PMOD', patches: [{ at: '1:1', expect: '3412', bytes: '7856' }] })]).toString();
  const b = Buffer.from(out, 'hex'); assert.deepEqual([...b.subarray(0x200, 0x203)], [0xb8, 0x78, 0x56]); assert.equal(b.length, file.length);
  assert.throws(() => execFileSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(new URL('../tools', import.meta.url).pathname)}); import netpatch
netpatch.apply(open(sys.argv[1], 'rb').read(), json.loads(sys.argv[2]))`, src, JSON.stringify({ name: 'PMOD', patches: [{ at: '1:1', expect: 'aaaa', bytes: '7856' }] })], { stdio: 'pipe' }), /not aaaa/, 'the file not as expected: the build stops');
}
console.log('netpatch: ok');
