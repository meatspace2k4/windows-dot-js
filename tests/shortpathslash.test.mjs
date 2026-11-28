// GetShortPathNameA keeps a folder's trailing backslash, as Windows does (win32.js). Dropped, IE4.DLL's ShortPath gave
// ACME "C:\PROGRA~1\INTERN~1", ACME's path formatter wants a folder ending in one, and Internet Explorer 4's Web
// Browser failed at STF object 692 with Setup Error 991
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, { FileSystem } = window.W95FS;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x10000) };
p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24 });
p.fs.mkdir('C:\\Program Files\\Internet Explorer', { recursive: true });
const G = (path) => { p.writeA(0x100, path); const n = API.KERNEL32.GetShortPathNameA[1].call(p, 0x100, 0x400, 260); return [n, p.readA(0x400)]; };
const [n1, s1] = G('C:\\Program Files\\Internet Explorer\\');
assert.match(s1, /^C:\\PROGRA~1\\INTERN~1\\$/, 'the trailing backslash kept');
assert.equal(n1, s1.length, 'its length, without the NUL');
assert.match(G('C:\\Program Files\\Internet Explorer')[1], /^C:\\PROGRA~1\\INTERN~1$/, 'none given, none added');
console.log('shortpathslash: ok');
