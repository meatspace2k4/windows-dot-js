// LoadLibraryA of a bare name looks in the calling program's folder, then the current directory, before SYSTEM and
// the Windows folder (win32.js), as Windows 95's does. ACME's ACMSETUP.EXE loads IE4.DLL from beside it; not found
// (error 126), Internet Explorer 4's setup ran none of its custom actions and every component failed to install
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x10000) };
let seen = null;
Object.assign(p, { fs: { cwd: 'C:\\WORK' }, thread16: { pc: { path: 'C:\\WINDOWS\\MSDOWNLD.TMP\\ASE016.TMP\\ACMSETUP.EXE' } }, loadDll(name) { seen = { name, dirs: this.loadDirs }; return null; } });
p.writeA(0x100, 'ie4.dll');
assert.equal(API.KERNEL32.LoadLibraryA[1].call(p, 0x100), 0);
assert.equal(seen.name, 'IE4');
assert.deepEqual(seen.dirs, ['C:\\WINDOWS\\MSDOWNLD.TMP\\ASE016.TMP', 'C:\\WORK'], 'the program\'s folder, then the current directory');
assert.equal(p.loadDirs, undefined, 'the search as it was after');
p.writeA(0x200, 'C:\\X\\Y.DLL');
API.KERNEL32.LoadLibraryA[1].call(p, 0x200);
assert.deepEqual(seen.dirs, ['C:\\X'], 'a path: its own folder');
console.log('loadlibrarybare: ok');
