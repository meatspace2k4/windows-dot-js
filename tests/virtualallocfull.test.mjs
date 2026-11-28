// VirtualAlloc with no room for the region answers 0 (ERROR_NOT_ENOUGH_MEMORY), as Windows does, and says so in the
// log with its size (win32.js). The heap's "out of memory" was thrown through it instead, failing the call itself
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API, GuestError } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x10000) };
const warned = []; const was = console.warn; console.warn = (...a) => warned.push(a.join(' '));
Object.assign(p, { vmTop: 0, alloc() { throw new GuestError('out of memory'); }, reg: () => 0x100, r32: () => 0, whereOf: () => 'WINHLP32.EXE+36869', modules: [] });
const r = API.KERNEL32.VirtualAlloc[1].call(p, 0, 0x8000000, 0x2000);
console.warn = was;
assert.equal(r, 0, 'no room: 0');
assert.equal(p.lastError, 8, 'ERROR_NOT_ENOUGH_MEMORY');
console.log('virtualallocfull: ok');
