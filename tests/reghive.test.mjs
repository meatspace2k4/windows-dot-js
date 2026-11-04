// The registry's files as Windows 95 writes them (win32.js regHive), read back as a CREG reader does: the header
// (CREG, version 1, the first RGDB block and their count), RGKN's key entries (parent, child, sibling, the key's id and
// block), each key's name and values in its RGDB block by id; HKEY_CLASSES_ROOT under SOFTWARE\Classes, HKEY_CURRENT_USER
// as USER.DAT's .Default
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))();
const R = window.W95Win32;
R.regSet('HKLM\\System\\CurrentControlSet\\control', 'Current User', 'Ann');
R.regSet('hklm\\software\\microsoft', 'n', 7);
for (let i = 0; i < 300; i++) R.regSet(`hklm\\software\\many\\k${i}`, 'v', 'x'.repeat(40));   // (more than one RGDB block)
R.regSet('hkcr\\.txt', '', 'txtfile');
R.regSet('hkcu\\control panel\\desktop', 'Wallpaper', '(None)');

const read = b => {
  const dv = new DataView(b.buffer, b.byteOffset), u32 = o => dv.getUint32(o, true), u16 = o => dv.getUint16(o, true), str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  assert.equal(str(0, 4), 'CREG'); assert.equal(u32(4), 0x10000);
  const K = 0x20; assert.equal(str(K, 4), 'RGKN');
  const blocks = []; let o = u32(8);
  for (let i = 0; i < u16(0x10); i++) { assert.equal(str(o, 4), 'RGDB'); assert.equal(u16(o + 6), 0, 'a block under 64 KB'); assert.equal(u32(o + 4) % 0x1000, 0); blocks.push(o); o += u32(o + 4); }
  assert.equal(o, b.length, 'the blocks end the file');
  const rec = (blk, id) => { const s = blocks[blk], end = s + u32(s + 4); for (let p = s + 0x20; p < end; p += u32(p)) if (u16(p + 4) === id && u16(p + 6) === blk) return p; return null; };
  const key = e => {
    const id = u16(K + e + 0x18), blk = u16(K + e + 0x1a), p = id === 0xffff ? null : rec(blk, id);
    const vals = {}; let name = '';
    if (p) { name = str(p + 0x14, u16(p + 0x0c)); let q = p + 0x14 + u16(p + 0x0c); for (let i = 0; i < u16(p + 0x0e); i++) { const nl = u16(q + 8), dl = u16(q + 10); vals[str(q + 12, nl)] = { type: u32(q), data: b.subarray(q + 12 + nl, q + 12 + nl + dl) }; q += 12 + nl + dl; } }
    return { name, vals, child: u32(K + e + 0x10), next: u32(K + e + 0x14), parent: u32(K + e + 0x0c) };
  };
  const find = path => {
    let e = u32(K + 8);
    for (const seg of path.split('\\')) {
      let c = key(e).child; while (c !== 0xffffffff && key(c).name.toLowerCase() !== seg.toLowerCase()) c = key(c).next;
      if (c === 0xffffffff) return null; assert.equal(key(c).parent, e); e = c;
    }
    return key(e);
  };
  return find;
};
const sys = read(R.regHive('system'));
const cu = sys('System\\CurrentControlSet\\control');
assert.equal(cu.name, 'control'); assert.equal(cu.vals['current user'].type, 1); assert.equal(String.fromCharCode(...cu.vals['current user'].data), 'Ann');
assert.deepEqual([...sys('SOFTWARE\\Microsoft').vals.n.data], [7, 0, 0, 0]); assert.equal(sys('software\\microsoft').vals.n.type, 4);
assert.ok(sys('software\\many\\k299'), 'a key in a later block');
assert.equal(String.fromCharCode(...sys('SOFTWARE\\Classes\\.txt').vals[''].data), 'txtfile', 'HKEY_CLASSES_ROOT under SOFTWARE\\Classes');
const user = read(R.regHive('user'));
assert.equal(user('.Default').name, '.Default');
assert.equal(String.fromCharCode(...user('.Default\\Control Panel\\desktop').vals.wallpaper.data), '(None)');
console.log('reghive: ok');
