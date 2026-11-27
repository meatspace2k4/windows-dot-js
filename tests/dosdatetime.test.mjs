// DosDateTimeToFileTime takes its date and time as WORDs: the high halves of their stack slots are the caller's
// leftovers. Taken whole, the CD Sampler's Pinball setup gave a date no Date holds, NaN, and BigInt(NaN) ended the
// system machine as its File Copy began
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API } = window.W95Win32, f = API.KERNEL32.DosDateTimeToFileTime[1];
const mem = new Map(), p = { lastError: 0, w32(a, v) { mem.set(a, v >>> 0); } };
const ft = () => (BigInt(mem.get(0x104)) << 32n) | BigInt(mem.get(0x100));
const date = ((2001 - 1980) << 9) | (4 << 5) | 23, time = (12 << 11) | (30 << 5) | 5;
assert.equal(f.call(p, date, time, 0x100), 1);
const want = ft();
assert.equal(Number((want - 116444736000000000n) / 10000n), Date.UTC(2001, 3, 23, 12, 30, 10));
mem.clear();
assert.equal(f.call(p, 0xbeef0000 | date, 0x7fff0000 | time, 0x100), 1, 'the high halves left out');
assert.equal(ft(), want);
console.log('dosdatetime: ok');
