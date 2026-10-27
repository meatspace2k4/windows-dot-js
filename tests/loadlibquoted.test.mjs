// LoadLibrary with a file name in quotes, as RUNDLL32 passes the one on its command line ("C:\WINDOWS\SYSTEM\DESK.CPL"):
// the module named inside them (Display Properties started by its command line failed with error 126)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API } = window.W95Win32;
const asked = [], mod = { base: 0x7000000 };
const g = {
  readA: () => '"C:\\WINDOWS\\SYSTEM\\DESK.CPL"', loadDll(n) { asked.push(n); return n === 'DESK.CPL' ? mod : null; },
  runPendingInits() {}, importClosure: m => [m], attach() {},
};
assert.equal(API.KERNEL32.LoadLibraryA[1].call(g, 0x100), mod.base);
assert.deepEqual(asked, ['DESK.CPL']);
console.log('loadlibquoted: ok');
