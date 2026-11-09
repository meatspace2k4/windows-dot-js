// A machine's files on the page's file system are its own: what it opens through the page (serve, bridge.js's RPC) is
// closed when it ends (exited), as a process's handles are. Windows keeps a 16-bit module's file open for its
// discardable segments; left open after Windows 95 shut down for Windows 98 Setup's restart, SHELL.DLL and DDEML.DLL
// could not be replaced by WININIT (a sharing violation each: "Windows could not upgrade the file")
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../fs.js', import.meta.url), 'utf8'))();
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const method = name => { const i = src.indexOf(`\n  ${name}(`), j = src.indexOf('\n  }\n', i); assert.ok(i > 0 && j > i, name); return src.slice(i + 1, j + 4); };
const fs = new window.W95FS.FileSystem(); fs.mount('C', { kind: 'fixed', total: 1 << 24 }); fs.mkdir('C:\\WINDOWS\\SYSTEM', { recursive: true });
fs.writeFile('C:\\WINDOWS\\SYSTEM\\SHELL.DLL', Uint8Array.of(1, 2, 3));
const stubs = { fs, W95Bridge: { answer() {} }, nativeApps: new Set(), machineWorkers: new Set(), windows: [], clipOwner: null, msgApp: null, closeWin() {}, emit() {}, msgBox() {}, dirty() {}, systemEnded() {}, basename: p => p, fatalText: () => '', runNative() {}, console };
const M = new Function(...Object.keys(stubs), `return class {\n${method('serve')}\n${method('exited')}\n}`)(...Object.values(stubs));
const a = new M(); Object.assign(a, { alive: true, wins: new Map(), calls: new Map(), worker: { terminate() {} }, answer() {}, path: 'C:\\WINDOWS\\SYSTEM\\MSGSRV32.EXE' });
// (the reply goes out through bridge.js's answer: stood in for, the value kept)
let last; a.reply = v => { last = v; };
const call = (method, args) => { a.serve({ target: 'fs', method, args, id: 1 }); };
call('open', ['C:\\WINDOWS\\SYSTEM\\SHELL.DLL', 'r']);
assert.throws(() => fs.unlink('C:\\WINDOWS\\SYSTEM\\SHELL.DLL'), /being used by another process/, 'open while the machine runs');
a.exited(0);
assert.doesNotThrow(() => fs.unlink('C:\\WINDOWS\\SYSTEM\\SHELL.DLL'), 'closed with the machine: the file can be replaced');
assert.ok(!fs.exists('C:\\WINDOWS\\SYSTEM\\SHELL.DLL'));
// one it closed itself is not closed again
const b = new M(); Object.assign(b, { alive: true, wins: new Map(), calls: new Map(), worker: { terminate() {} }, path: 'X' }); b.reply = () => {};
fs.writeFile('C:\\T.TXT', Uint8Array.of(1));
b.serve({ target: 'fs', method: 'open', args: ['C:\\T.TXT', 'r'], id: 2 });
const fd = [...b.fds][0]; b.serve({ target: 'fs', method: 'close', args: [fd], id: 3 });
assert.equal(b.fds.size, 0); b.exited(0); fs.unlink('C:\\T.TXT');
console.log('machinefds: ok');
