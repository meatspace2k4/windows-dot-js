// A module loaded from its file keeps nothing of the loader's as code on its record: its segments' relocations are made
// from the record alone (ne16.js relocSeg16, importTarget16: the file, the segments, the exports, the module-reference
// table in meta.imports), as they load and again when a data segment is read again from the file (reloadData16). A
// moment arrived at in another page has the record and not a closure (the records' relocSeg came back as nothing).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
const src = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
assert.equal(typeof P.relocSeg16, 'function'); assert.equal(typeof P.importTarget16, 'function');
assert.ok(!/rec\.relocSeg\b/.test(src), 'no closure kept on the record');
assert.match(src, /if \(meta\.dynamic && rec\.file\) for \(const sg of data\) this\.relocSeg16\(rec, sg\);/, 'reloadData16 makes them again from the record');
assert.match(src, /try \{ for \(const sg of segs\) this\.relocSeg16\(rec, sg\); \} catch \(e\) \{/, 'the loader makes them the same way');
// a relocation of the internal kind, made from a record built by hand: a far pointer to segment 2's offset 10h at
// segment 1's offset 4, through a chain of two places
{
  const file = new Uint8Array(0x100); const n = 0x40; file[0x3c] = n;
  const rel = 0x80; file[rel] = 1; file[rel + 2] = 3; file[rel + 3] = 0; file[rel + 4] = 4; file[rel + 5] = 0; file[rel + 6] = 2; file[rel + 7] = 0; file[rel + 8] = 0x10; file[rel + 9] = 0;   // at 3 (far pointer), type 0 (internal, chained), off 4, segment 2, offset 10h
  const mem = new Uint8Array(0x1000), p = Object.create(P);
  Object.defineProperty(p, 'u8', { value: mem }); p.r16 = a => mem[a] | mem[a + 1] << 8; p.w16 = (a, v) => { mem[a] = v & 0xff; mem[a + 1] = v >> 8; }; p.w32 = (a, v) => { p.w16(a, v & 0xffff); p.w16(a + 2, v >>> 16); };
  const segs = [{ num: 1, sel: 0x107, base: 0x100, alloc: 0x40, rel }, { num: 2, sel: 0x10f, base: 0x200, alloc: 0x40, rel: 0 }];
  p.w16(0x104, 0x20); p.w16(0x120, 0xffff);   // (the chain: offset 4 names 20h, 20h ends it)
  p.relocSeg16({ file, segs, exports: new Map(), meta: { imports: [] } }, segs[0]);
  assert.equal(p.r16(0x104), 0x10); assert.equal(p.r16(0x106), 0x10f); assert.equal(p.r16(0x120), 0x10); assert.equal(p.r16(0x122), 0x10f);
}
console.log('relocseg: ok');
