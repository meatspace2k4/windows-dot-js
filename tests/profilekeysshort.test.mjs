// GetPrivateProfileStringA with a null key lists the section's keys; a list longer than the buffer gives what fits,
// the last name cut, two NULs, and nSize - 2, as Windows answers (win32.js). It answered 0: IE4WZD asks with a small
// buffer whether IE4SETUP.INF's [Options.WIN] has keys, took it for empty, took the job's name from [Options] (Job1, no
// such job), and Internet Explorer 4's setup said "The network is probably busy"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, { FileSystem } = window.W95FS;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x10000) };
p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24 });
p.fs.writeFile('C:\\IE4SETUP.INF', '[Options]\r\nJobName=Job1\r\n[Options.Win]\r\nInstallMode=1\r\nJobName=Job.IE4\r\n');
p.writeA(0x100, 'C:\\IE4SETUP.INF'); p.writeA(0x200, 'Options.WIN');
const G = API.KERNEL32.GetPrivateProfileStringA[1];
// (the whole list: "InstallMode\0JobName\0\0", its length without the last NUL)
assert.equal(G.call(p, 0x200, 0, 0, 0x1000, 0x100, 0x100), 20);
assert.equal(p.readA(0x1000), 'InstallMode'); assert.equal(p.readA(0x1000 + 12), 'JobName'); assert.equal(p.u8[0x1000 + 20], 0);
// (a buffer of 8: "Install" cut, two NULs, 6)
p.u8.fill(0xaa, 0x2000, 0x2010);
assert.equal(G.call(p, 0x200, 0, 0, 0x2000, 8, 0x100), 6, 'nSize - 2: the section has keys');
assert.equal(p.readA(0x2000), 'Instal'); assert.deepEqual([p.u8[0x2006], p.u8[0x2007]], [0, 0]);
// (a section with no keys: 0)
p.writeA(0x300, 'Nothing');
assert.equal(G.call(p, 0x300, 0, 0, 0x2000, 8, 0x100), 0);
console.log('profilekeysshort: ok');
