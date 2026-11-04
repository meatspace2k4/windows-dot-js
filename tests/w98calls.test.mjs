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
  const p = { readW: a => { let s = ''; for (let i = a - 0x10000; mem[i]; i += 2) s += String.fromCharCode(mem[i]); return s; }, readA: () => 'R', moduleFor: m => m,
    findResource: (t, n, m) => { asked.push([t, n, m]); return { addr: 0x1234, size: 8 }; }, newHandle: o => (asked.push(o), 7) };
  assert.equal(API.KERNEL32.FindResourceW[1].call(p, 0x400000, 0x10010, 0x10040), 7);
  assert.deepEqual(asked[0], ['MYTYPE', 'REGINST', 0x400000], 'names read as UTF-16');
  API.KERNEL32.FindResourceW[1].call(p, 0x400000, 5, 6); assert.deepEqual(asked[2], [6, 5, 0x400000], 'by number');
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
console.log('w98calls: ok');
