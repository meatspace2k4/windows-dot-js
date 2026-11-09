// A 16-bit module loaded from its file is translated whole as it loads (dyn.js neCompile) into a module of the
// bundle's shape: its code in the image arena, its block table among the modules' (win32.js tableRoom), its run the
// dispatcher's (0 at the sentinel, 3 outside its text, trap(eip, 2) and 2 at a hole, else the block). The translation
// is memoized by the file's SHA-256 with its placement, and a second load at the same placement runs the memo's module.
// A block the static walk missed, found as it ran (noteEntry's dynNew), gets the module translated again at an idle
// step (neRebuild), once no more are being found
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { memo } = window.W95Dyn;

// the file: MZ stub, NE header at 40h, a code segment at 200h and DGROUP at 300h, KERNEL imported, one export (1:0)
//   0: mov ax, 1234h; jmp far 0000:0000   (to selector 0: outside the module, the dispatcher's)
//   8: mov ax, 5678h; jmp far 0000:0000   (reached by nothing the file names: a block found only as it runs)
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
  f[n + p] = 4; f.set([...'TMOD'].map(c => c.charCodeAt(0)), n + p + 1); p += 5; w(n + p, 0); p += 2;
  f[n + p] = 7; f.set([...'ENTRYPT'].map(c => c.charCodeAt(0)), n + p + 1); p += 8; w(n + p, 1); p += 2; f[n + p++] = 0;
  w(n + 0x28, p); w(n + p, 1); p += 2;
  w(n + 0x2a, p); f[n + p] = 0; f[n + p + 1] = 6; f.set([...'KERNEL'].map(c => c.charCodeAt(0)), n + p + 2); p += 8;
  w(n + 0x04, p); f.set([1, 1, 3], n + p); w(n + p + 3, 0); f[n + p + 5] = 0; w(n + 0x06, 6); p += 6;
  dv.setUint32(n + 0x2c, 0, true);
  f.set([0xb8, 0x34, 0x12, 0xea, 0, 0, 0, 0, 0xb8, 0x78, 0x56, 0xea, 0, 0, 0, 0], 0x200);
  return f;
};
const proc = () => {
  const p = Object.create(Process.prototype);
  p.mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  p.cpu = {}; for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if', 'xf']) p.cpu[r] = new WebAssembly.Global({ value: 'i32', mutable: true }, r === 'budget' ? 0x1000 : 0);
  const traps = [];
  Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(),
    heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, findFile16: () => null, fs: { exists: () => false },
    imports: { env: { api: () => 0, tick: () => 0, f80load: () => 0, f80store() {} } }, trap: (x, c) => traps.push([x >>> 0, c]), tick: () => 0, traps });
  return p;
};
memo.clear();
const file = ne(), sha = window.W95Win32.sha256(file);

// the module's shape and placement; the block at 0 translated, the one at 8 not (nothing names it)
const p = proc(), rec = p.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\TMOD.DLL', file);
const code = rec.segs[0];
assert.ok(code.base >= 0x400000 && code.base < LAYOUT.HEAP, 'code in the image arena');
assert.ok(rec.meta.lookup >= LAYOUT.TABLES && rec.meta.lookup + 4 * (rec.meta.textHi - rec.meta.textLo) <= LAYOUT.TABLES_END, 'the block table among the modules\'');
assert.deepEqual([rec.meta.textLo, rec.meta.textHi], [code.base, code.base + 0x10]);
assert.equal(typeof rec.run, 'function');
assert.ok(p.hasBlock(rec, code.base), 'a block at the entry'); assert.ok(!p.hasBlock(rec, code.base + 8), 'none at 8');
assert.ok(p.staticCodeAt(code.base), 'the dispatcher finds it as a module');
// the run: the sentinel, an address outside, a hole, the block
assert.equal(rec.run(LAYOUT.SENTINEL), 0);
assert.equal(rec.run(0x123456), 3); assert.equal(p.cpu.eip.value >>> 0, 0x123456);
assert.equal(rec.run(code.base + 8), 2); assert.deepEqual(p.traps.at(-1), [code.base + 8, 2], 'a hole asks for run-time code');
p.cpu.cs.value = code.sel; p.cpu.csb.value = code.base; p.cpu.ss.value = rec.segs[1].sel;   // (16-bit code on a 16-bit stack, as translated)
assert.equal(rec.run(code.base), 3, 'the far jump leaves the module'); assert.equal(p.cpu.eax.value & 0xffff, 0x1234); assert.equal(p.cpu.eip.value, 0);
// memoized by the file's SHA-256, with the placement
const m1 = memo.get(sha);
assert.ok(m1 && m1.wasm && m1.codeBase === code.base && m1.sels[0] === code.sel && m1.blocks.length === 1, 'the memo: wasm, placement, blocks');

// a block found as it ran: the module translated again with it at an idle step, once no more are being found
rec.dynEntries = new Set(['1:8']); rec.dynNew = new Set(['1:8']);
assert.equal(p.neRebuild(), false, 'still finding: waits a step');
assert.equal(p.neRebuild(), true, 'quiet: translated again');
assert.ok(p.hasBlock(rec, code.base + 8), 'the found block is the module\'s now');
assert.equal(rec.run(code.base + 8), 3); assert.equal(p.cpu.eax.value & 0xffff, 0x5678);
assert.deepEqual(memo.get(sha).entries, ['1:8'], 'the memo keeps the entry'); assert.equal(memo.get(sha).blocks.length, 2);
p.depth = 1; rec.dynNew = new Set(['1:8', '1:0']); assert.equal(p.neRebuild(), false, 'inside a call the host made: not now'); p.depth = 0;

// a second load, the same placement: the memo's module runs, nothing translated
const q = proc(), made = memo.get(sha).made, logged = [];
const log = window.W95Win32.log; window.W95Win32.log = (l, t, s) => logged.push(s);
const rec2 = q.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\TMOD.DLL', file);
window.W95Win32.log = log;
assert.equal(rec2.segs[0].base, code.base); assert.equal(rec2.segs[0].sel, code.sel); assert.equal(rec2.segs[1].sel, rec.segs[1].sel);
assert.equal(memo.get(sha).made, made, 'the memo untouched');
assert.ok(logged.some(s => /TMOD: 2 blocks from the memo/.test(s)), logged.join('; '));
assert.ok(q.hasBlock(rec2, code.base + 8), 'with the entries the memo kept');
// translated again after a start from the memo: its blocks taken back from the memo's module, none translated anew
{
  const tr = q.translateNE(rec2);
  assert.deepEqual(tr.blocks, memo.get(sha).blocks); assert.deepEqual([...tr.wasm], [...memo.get(sha).wasm], 'the same module, from the kept bodies');
  q.u8[code.base + 9] = 0x11;   // (a block's bytes changed: that one translated again)
  const tr2 = q.translateNE(rec2); assert.notDeepEqual([...tr2.wasm], [...tr.wasm]);
  q.u8[code.base + 9] = 0x78;
}
// the placement taken (another module there): placed elsewhere, the code hashes differently, translated anew
const r = proc(); r.modules.push({ name: 'OTHER', segs: [{ base: code.base, alloc: 0x10000, len: 0x10 }] });
r.selUsed[(code.sel & 0xfff8) >> 3] = 1;
const rec3 = r.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\TMOD.DLL', file);
assert.notEqual(rec3.segs[0].base, code.base); assert.notEqual(rec3.segs[0].sel, code.sel);
assert.notEqual(memo.get(sha).made, made, 'the memo made again at the new placement');
r.cpu.ss.value = rec3.segs[1].sel; assert.equal(rec3.run(rec3.segs[0].base), 3); assert.equal(r.cpu.eax.value & 0xffff, 0x1234);

// an additive relocation names segment 1 offset 0 and the far call holds its own offset (W98SETUP's calls within the
// module): its target is a block of the module's, read from the pointer the loader made
{
  const f = ne(), dv = new DataView(f.buffer), n = 0x40;
  dv.setUint16(n + 0x40 + 4, 0x0100, true);                         // (segment 1 with relocations, after its 10h bytes)
  f.set([0x9a, 0x20, 0x00, 0x00, 0x00, 0x90, 0x90, 0x90], 0x208);    // 8: call far 1:0020 (offset in place)
  dv.setUint16(0x210, 1, true); f.set([3, 4], 0x212); dv.setUint16(0x214, 9, true); dv.setUint16(0x216, 1, true); dv.setUint16(0x218, 0, true);   // far pointer at 9, internal additive, segment 1 offset 0
  dv.setUint16(n + 0x40 + 2, 0x30, true);                            // (the segment 30h long: the target at 20h)
  f.set([0xb8, 0x99, 0x99, 0xea, 0, 0, 0, 0], 0x220);
  // (the relocations follow the segment's 30h bytes: moved there)
  f.copyWithin(0x230, 0x210, 0x21a); f.fill(0, 0x210, 0x21a); f.set([0xb8, 0x99, 0x99, 0xea, 0, 0, 0, 0], 0x220);
  memo.clear();
  const s = proc(), r = s.loadNEDynamic('C:\\WINDOWS\\SYSTEM\\TMOD.DLL', f), b = r.segs[0].base;
  assert.equal(s.r16(b + 9), 0x20, 'the offset kept'); assert.equal(s.r16(b + 11), r.segs[0].sel, 'the selector made');
  assert.ok(s.hasBlock(r, b + 0x20), 'the call\'s target, a block of the module\'s');
}
// a program's or DLL's image mapped from its file (win32.js loadImage, meta.dynamic): its executable sections translated
// whole as it loads, flat; its entry point a block, and a pointer its base relocations name into its code (a vtable's)
{
  const f = new Uint8Array(0x600), dv = new DataView(f.buffer), w16 = (o, v) => dv.setUint16(o, v, true), w32 = (o, v) => dv.setUint32(o, v, true);
  f.set([0x4d, 0x5a]); w32(0x3c, 0x40); w32(0x40, 0x4550);
  w16(0x44, 0x14c); w16(0x46, 2); w16(0x54, 0xe0); w16(0x56, 0x2102);
  const opt = 0x58; w16(opt, 0x10b); w32(opt + 16, 0x1000); w32(opt + 28, 0x01800000); w32(opt + 32, 0x1000); w32(opt + 36, 0x200);
  w32(opt + 56, 0x3000); w32(opt + 60, 0x200); w16(opt + 68, 2); w32(opt + 92, 16);
  w32(opt + 96 + 5 * 8, 0x2000); w32(opt + 96 + 5 * 8 + 4, 12);   // base relocations: one HIGHLOW at 2010h
  const sh = opt + 0xe0;
  f.set([...'.text'].map(c => c.charCodeAt(0)), sh); w32(sh + 8, 0x20); w32(sh + 12, 0x1000); w32(sh + 16, 0x200); w32(sh + 20, 0x200); w32(sh + 36, 0x60000020);
  f.set([...'.data'].map(c => c.charCodeAt(0)), sh + 40); w32(sh + 48, 0x20); w32(sh + 52, 0x2000); w32(sh + 56, 0x200); w32(sh + 60, 0x400); w32(sh + 76, 0xc0000040);
  f.set([0xb8, 1, 0, 0, 0, 0xc3], 0x200);                        // 1000h: mov eax, 1; ret (the entry)
  f.set([0xb8, 2, 0, 0, 0, 0xc3], 0x210);                        // 1010h: mov eax, 2; ret (reached only through the pointer)
  w32(0x400, 0x2000); w32(0x404, 12); w16(0x408, 0x3010); w32(0x410, 0x01801010);   // .reloc page 2000h, HIGHLOW at +10; the pointer at 2010h
  memo.clear();
  const s = proc(); s.inits = []; s.dlls = new Map();
  const meta = { base: 0x01800000, entry: 0x01801000, textLo: 0, textHi: 0, blocks: [], size: 0x3000, dynamic: true, path: 'C:\\WINDOWS\\SYSTEM\\TDLL.DLL' };
  const r = s.loadImage(f, null, meta, 'TDLL');
  assert.deepEqual([meta.textLo, meta.textHi], [0x01801000, 0x01801020], 'its code section');
  assert.ok(s.hasBlock(r, 0x01801000) && s.hasBlock(r, 0x01801010), 'the entry and the pointed-to procedure');
  assert.ok(memo.get(window.W95Win32.sha256(f)), 'memoized by the file');
  s.cpu.esp.value = 0x300000; new DataView(s.mem.buffer).setUint32(0x300000, LAYOUT.SENTINEL >>> 0, true);
  assert.equal(r.run(0x01801010), 0, 'run to the sentinel'); assert.equal(s.cpu.eax.value, 2);
  // (on a 16-bit stack, or with a CS of its own, the module's translation is not for it: run-time code takes the block)
  const t16 = s.allocSels(0x200000, 0x10000); s.cpu.ss.value = t16; s.traps.length = 0;
  assert.equal(r.run(0x01801010), 2); assert.deepEqual(s.traps.at(-1), [0x01801010, 2]);
  s.cpu.ss.value = 0; s.cpu.cs.value = t16; assert.equal(r.run(0x01801010), 2); s.cpu.cs.value = 0;
}
// tableRoom: clear of the bundle's tables (loaded or not) and of the modules loaded, pref first when free
{
  const s = proc(); window.W95SYSTEM = { ne: { X: { meta: { lookup: LAYOUT.TABLES, textLo: 0, textHi: 0x1000 } } } };
  assert.equal(s.tableRoom(0x100), LAYOUT.TABLES + 0x4000, 'after the bundle\'s');
  assert.equal(s.tableRoom(0x100, LAYOUT.TABLES + 0x100000), LAYOUT.TABLES + 0x100000, 'at pref');
  assert.equal(s.tableRoom(0x100, LAYOUT.TABLES + 0x800), LAYOUT.TABLES + 0x4000, 'pref taken: first fit');
  s.modules.push({ meta: { lookup: LAYOUT.TABLES + 0x4000, textLo: 0, textHi: 0x400 } });
  assert.equal(s.tableRoom(0x100), LAYOUT.TABLES + 0x5000, 'after a loaded module\'s');
  assert.throws(() => s.tableRoom(LAYOUT.TABLES_END - LAYOUT.TABLES), /no room/);
  delete window.W95SYSTEM;
}
// allocSels: the selector asked for when its slots are free
{
  const s = proc(), a = s.allocSels(0x500000, 0x10000);
  assert.equal(s.allocSels(0x510000, 0x10000, 0xf300, a), a + 8, 'taken: the first free');
  const want = a + 0x40; assert.equal(s.allocSels(0x520000, 0x20000, 0xf300, want), want, 'free: as asked');
  assert.equal(s.selUsed[(want >> 3) + 1], 1, 'both of its slots');
}
console.log('netrans: ok');
