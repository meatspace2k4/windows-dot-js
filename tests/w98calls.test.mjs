// Calls Windows 98's own KERNEL32 and KRNL386 implement (their code, not the common stub) that its first start makes:
// FindResourceW (RUNONCE's, a dead thunk that ended it), IsPeFormat (KERNEL.#431, RUNDLL's), GetSystemDefaultLangID
// and lstrcatW.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API } = window.W95Win32, { K16 } = window.W95NE16;
// FindResourceW: names as UTF-16 strings or numbers, looked up as FindResourceA's are
{
  // (strings at 10010h and 10040h: an address above 64K is a name, below it a number)
  const asked = [], mem = new Uint8Array(0x100), w = (a, s) => { [...s, '\0'].forEach((c, i) => { mem[a - 0x10000 + 2 * i] = c.charCodeAt(0); }); };
  w(0x10010, 'REGINST'); w(0x10040, 'MYTYPE');
  const p = { readW: a => { let s = ''; for (let i = a - 0x10000; mem[i]; i += 2) s += String.fromCharCode(mem[i]); return s; }, readA: () => 'R', hmod: h => h, moduleFor: m => ({ base: m }),
    findResource: (t, n, m) => { asked.push([t, n, m]); return { addr: 0x1234, size: 8 }; }, newHandle: o => (asked.push(o), 7) };
  assert.equal(API.KERNEL32.FindResourceW[1].call(p, 0x400000, 0x10010, 0x10040), 7);
  assert.deepEqual(asked[0], ['MYTYPE', 'REGINST', { base: 0x400000 }], 'names read as UTF-16');
  API.KERNEL32.FindResourceW[1].call(p, 0x400000, 5, 6); assert.deepEqual(asked[2], [6, 5, { base: 0x400000 }], 'by number');
  // (a handle no module of the process has: no resource, ERROR_RESOURCE_TYPE_NOT_FOUND, not the program's own)
  const q = { ...p, moduleFor: () => ({ base: 0x400000 }) };
  assert.equal(API.KERNEL32.FindResourceW[1].call(q, 0x7fe00000, 5, 6), 0); assert.equal(q.lastError, 1813);
}
// IsBadReadPtr / IsBadWritePtr: a count of 0 is never bad, NULL included (OLE32's IsClassOfCategories with no
// required categories); NULL with bytes asked for is
{
  const p = { mem: { buffer: { byteLength: 0x10000 } } };
  for (const f of ['IsBadReadPtr', 'IsBadWritePtr']) {
    assert.equal(API.KERNEL32[f][1].call(p, 0, 0), 0, f + '(NULL, 0)');
    assert.equal(API.KERNEL32[f][1].call(p, 0, 16), 1, f + '(NULL, 16)');
    assert.equal(API.KERNEL32[f][1].call(p, 0x1000, 16), 0); assert.equal(API.KERNEL32[f][1].call(p, 0xfff8, 16), 1);
  }
}
// IsPeFormat: a PE image yes, an NE one and no file no
{
  const [args, ret, fn] = K16['KERNEL.#431']; assert.equal(args, 'sw'); assert.equal(ret, 'w');
  const img = sig => { const b = new Uint8Array(0x100); b[0] = 0x4d; b[1] = 0x5a; b[0x3c] = 0x80; b.set(sig, 0x80); return b; };
  const files = { 'C:\\WINDOWS\\SYSTEM\\A.DLL': img([0x50, 0x45, 0, 0]), 'C:\\WINDOWS\\SYSTEM\\B.DLL': img([0x4e, 0x45]) };
  const p = { findFile16: n => Object.keys(files).find(k => k.endsWith('\\' + n.toUpperCase())) || null, fs: { readFile: f => files[f] } };
  assert.equal(fn.call(p, 'a.dll', 0), 1, 'a Win32 image');
  assert.equal(fn.call(p, 'b.dll', 0), 0, 'a 16-bit one');
  assert.equal(fn.call(p, 'c.dll', 0), 0, 'no such file');
  assert.equal(fn.call(p, null, 5), 0, 'no name');
}
assert.equal(API.KERNEL32.GetSystemDefaultLangID[1](), 0x409);
// QueryDosDeviceA, as Windows 98's: a port its own target, a drive (none substituted) not found, bad arguments refused
{
  const q = API.KERNEL32.QueryDosDeviceA[1]; let name = '', out = null;
  const p = { lastError: 0, readA: () => name, writeA: (a, s) => { out = s; return s.length; } };
  name = 'com1'; assert.equal(q.call(p, 1, 2, 260), 4); assert.equal(out, 'COM1', 'a port: its own name');
  name = 'C:'; out = null; assert.equal(q.call(p, 1, 2, 260), 0); assert.equal(p.lastError, 2, 'a drive not substituted: not found'); assert.equal(out, null);
  name = 'LPT1'; assert.equal(q.call(p, 1, 2, 4), 0); assert.equal(p.lastError, 0x7a, 'no room for it and its NUL');
  assert.equal(q.call(p, 0, 2, 260), 0); assert.equal(p.lastError, 87);
  assert.equal(q.call(p, 1, 2, 0x105), 0); assert.equal(p.lastError, 87, 'a size over 104h');
}
console.log('w98calls: ok');
