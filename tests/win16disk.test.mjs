// A Windows 3.x module from disk, mapped by KERNEL's loader (ne16.js loadNEDynamic), as VB3's runtime and its
// controls need it: its module name without the NUL a resident name can carry; KERNEL's constant exports (__WINFLAGS)
// resolved at an import fixup; a library's exports that take DS from AX (mov ax,ds; nop) patched to mov ax,DGROUP as
// KRNL386 patches them (MCI.VBX's VBINITCC ran on VB's DS and registered an empty control); the version of Windows
// its header expects (GetExpWinVer: USER holds a 3.0 program to 3.0's rules)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { K16 } = window.W95NE16;

// the file: MZ stub, NE header at 40h, two segments (code with one import fixup at 200h, DGROUP at 300h), KERNEL imported
const ne = (name, flags, prolog) => {
  const f = new Uint8Array(0x400), dv = new DataView(f.buffer), w = (o, v) => dv.setUint16(o, v, true);
  f.set([0x4d, 0x5a]); dv.setUint32(0x3c, 0x40, true);
  const n = 0x40; f.set([0x4e, 0x45], n);
  w(n + 0x0c, flags); w(n + 0x0e, 2); w(n + 0x10, 0x100); w(n + 0x12, 0); w(n + 0x14, 0); w(n + 0x16, 0);   // (no LibEntry)
  w(n + 0x1c, 2); w(n + 0x1e, 1); w(n + 0x20, 0); w(n + 0x32, 4); w(n + 0x3e, 0x300);
  let p = 0x40; w(n + 0x22, p);   // segment table
  w(n + p, 0x20); w(n + p + 2, 0x10); w(n + p + 4, 0x0100); w(n + p + 6, 0x10);   // code at 200h, with relocations
  w(n + p + 8, 0x30); w(n + p + 10, 0x10); w(n + p + 12, 0x0001); w(n + p + 14, 0x10);   // DGROUP at 300h
  p += 16; w(n + 0x24, p); w(n + 0x26, p);   // no resources; resident names: the module's, then one export
  f[n + p] = name.length; f.set([...name].map(c => c.charCodeAt(0)), n + p + 1); p += 1 + name.length; w(n + p, 0); p += 2;
  f[n + p] = 7; f.set([...'ENTRYPT'].map(c => c.charCodeAt(0)), n + p + 1); p += 8; w(n + p, 1); p += 2; f[n + p++] = 0;
  w(n + 0x28, p); w(n + p, 1); p += 2;   // module references: KERNEL at import-names offset 1
  w(n + 0x2a, p); f[n + p] = 0; f[n + p + 1] = 6; f.set([...'KERNEL'].map(c => c.charCodeAt(0)), n + p + 2); p += 8;
  w(n + 0x04, p); f.set([1, 1, 3], n + p); w(n + p + 3, 0); f[n + p + 5] = 0; w(n + 0x06, 6); p += 6;   // entry 1: segment 1:0, exported, shared data
  dv.setUint32(n + 0x2c, 0, true);
  f.set([...prolog, 0x45, 0x55, 0x8b, 0xec, 0xb8, 0, 0, 0x90, 0x90, 0x90, 0x90, 0x90], 0x200);   // ... mov ax, __WINFLAGS
  w(0x210, 1); f.set([5, 1], 0x212); w(0x214, 9); w(0x216, 1); w(0x218, 178);   // offset fixup at 9: KERNEL.178
  return f;
};
const proc = () => {
  // (a module from its file is translated as it loads, dyn.js neCompile: the processor's registers are the globals
  // its module imports, the memory the machine's whole address space)
  const p = Object.create(Process.prototype);
  p.mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.cpu = {}; for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[r] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
  Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(),
    heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, findFile16: () => null, fs: { exists: () => false },
    imports: { env: { api: () => 0, tick: () => 0, f80load: () => 0, f80store() {}, fbld: () => 0, fbstp() {} } }, trap() {}, tick: () => 0 });
  return p;
};
// a library: name without its NUL, the constant, the prolog patched with the DGROUP's selector, the expected version
{
  const p = proc(), rec = p.loadNEDynamic('D:\\X\\MCI.VBX', ne('MCI\0', 0x8001, [0x8c, 0xd8, 0x90]));
  assert.equal(rec.name, 'MCI'); assert.ok(p.ne.has('MCI'));
  const code = rec.segs[0].base, dg = rec.segs[1].sel;
  assert.equal(p.r16(code + 9), 0x0c29, '__WINFLAGS at the fixup');
  assert.deepEqual([p.u8[code], p.r16(code + 1)], [0xb8, dg], 'mov ax, DGROUP');
  assert.equal(K16['KERNEL.#167'][2].call(p, rec.hInstance), 0x300, 'GetExpWinVer: the header\'s 3.0');
  assert.equal(K16['KERNEL.#167'][2].call(p, 0), 0x400, 'no module: 4.0');
}
// push ds; pop ax; nop too; a program's exports keep theirs (MakeProcInstance's AX goes through)
{
  const p = proc(), rec = p.loadNEDynamic('D:\\X\\A.DLL', ne('ADLL', 0x8001, [0x1e, 0x58, 0x90]));
  assert.equal(p.u8[rec.segs[0].base], 0xb8);
  const q = proc(), app = q.loadNEDynamic('D:\\X\\APP.EXE', ne('APP', 0x0002, [0x8c, 0xd8, 0x90]));
  assert.deepEqual([...q.u8.subarray(app.segs[0].base, app.segs[0].base + 3)], [0x8c, 0xd8, 0x90]);
}
console.log('win16disk: ok');
