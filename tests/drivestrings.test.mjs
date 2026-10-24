// GetLogicalDriveStringsA: the drives' roots, each null-terminated, then a null; the length needed when the buffer is
// too small (LINKINFO asks with no buffer first, as a shell link is saved)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;
const p = Object.create(P); Object.defineProperty(p, 'u8', { value: new Uint8Array(256) }); p.fs = { vols: new Map([['C', {}], ['A', {}], ['D', {}]]) };
const [n, impl] = W.API.KERNEL32.GetLogicalDriveStringsA;
assert.equal(n, 2);
assert.equal(impl.call(p, 0, 0), 13);                    // "A:\" "C:\" "D:\" each 4 bytes, then the null
assert.equal(impl.call(p, 13, 16), 12);
assert.equal(String.fromCharCode(...p.u8.subarray(16, 29)), 'A:\\\0C:\\\0D:\\\0\0');
console.log('drivestrings: ok');
