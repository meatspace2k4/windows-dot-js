// A 32-bit thunk DLL whose 16-bit half cannot be found (or does not match) is recorded on the process, so the machine's
// probe can say which connect failed (the worker's console does not reach the page).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, TC = W.API.KERNEL32.ThunkConnect32;
assert.ok(TC, 'ThunkConnect32 is defined');

const mem = new Uint8Array(1 << 16), dv = new DataView(mem.buffer);
const str = (a, s) => { for (let i = 0; i < s.length; i++) mem[a + i] = s.charCodeAt(i); mem[a + s.length] = 0; };
str(0x100, 'LS01'); str(0x200, 'user_ThunkData16'); str(0x300, 'USER.EXE'); str(0x400, 'USER32.DLL');
const warn = console.warn; console.warn = () => {};
const p = Object.create(W.Process.prototype);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, {
  thread16: null,
  readA(a, n = 256) { let s = ''; for (let i = 0; i < n && mem[a + i]; i++) s += String.fromCharCode(mem[a + i]); return s || null; },
  r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  loadLibrary16: () => null,
});
assert.equal(TC[1].call(p, 0x100, 0x200, 0x300, 0x400, 0x1000, 1), 0, 'the connect fails without its 16-bit half');
console.warn = warn;
assert.deepEqual(p.thunkFails, [{ dll: 'USER32.DLL', to: 'USER.EXE', f16: 'user_ThunkData16', why: 'no 16-bit half', who: 'main' }]);
// late-bound (LB01) thunk data whose 16-bit half is already loaded is bound at connect: its target table is in the
// 32-bit data at once, as USER32's CreateWindowExA reads it directly
str(0x500, 'LS01'); str(0x50c, 'LB01'); dv.setUint32(0x51c, 0x40, true); dv.setUint32(0x520, 0x48, true);
const user = { meta: {} }, t16 = 0x2000; dv.setUint32(t16 + 8, 0x12340010, true);
const q = Object.create(W.Process.prototype);
Object.defineProperty(q, 'u8', { value: mem });
Object.assign(q, {
  thread16: null, ne: new Map([['USER', user]]),
  readA: p.readA, r32: p.r32, w32: p.w32,
  loadLibrary16: n => (/^USER(\.EXE)?$/.test(n) ? user : null), neExport: () => 0x77770000, lin: a => (a === 0x77770000 ? t16 : (a >>> 16) * 0x100 + (a & 0xffff)),
});
str(0x300, 'USER.EXE');
assert.equal(TC[1].call(q, 0x500, 0x200, 0x300, 0x400, 0x1000, 1), 1);
assert.equal(dv.getUint32(0x508, true), 0x1234 * 0x100 + 0x10, 'the target table is in the 32-bit data after the connect');
console.log('thunkfail: ok');
