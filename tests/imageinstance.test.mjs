// A second instance of a running program shares its image, each process with its own copy of the image's data: the
// thread that starts it (the shell starting Explorer from the Start menu) goes on with its own data in place, and the
// new instance's comes in when the new process's thread runs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const mem = new Uint8Array(1 << 20);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
p.mem = { buffer: mem.buffer };
const BASE = 0x40000, SIZE = 0x1000;
const rec = { base: BASE, size: SIZE };
Object.assign(p, {
  modules: [rec], byName: new Map([['EXE', rec]]), threadsById: new Map(), selUsed: new Uint8Array(8192),
  alloc: () => 0x80000, writeA() {}, newThread: () => ({}), host: { now: () => 0 }, t0: 0,
  // (the image laid out afresh: the new instance's data)
  loadImage() { mem.fill(0x22, BASE, BASE + SIZE); const r = { base: BASE, size: SIZE }; this.modules.push(r); return r; },
});
const shell = { pid: 0x68, exe: rec, exitCode: null, path: 'C:\\WINDOWS\\EXPLORER.EXE' };   // (an instance of the same file)
p.procs = new Map([[shell.pid, shell]]);
mem.fill(0x11, BASE, BASE + SIZE);   // (the running shell's data)

p.thread16 = { pc: shell };
const pc = p.spawn(new Uint8Array(0), null, { base: BASE, entry: 0 }, 'C:\\WINDOWS\\EXPLORER.EXE', 'EXPLORER.EXE /n,/e,C:\\');
assert.equal(pc.exe, rec, 'one image');
assert.equal(mem[BASE + 0x84], 0x11, 'the shell, whose thread started it, keeps its own data in place');
p.imgUse(pc); assert.equal(mem[BASE + 0x84], 0x22, 'the new instance\'s data when its thread runs');
p.imgUse(shell); assert.equal(mem[BASE + 0x84], 0x11, 'and the shell\'s back with its thread');

// started from no thread of the program's (the host): the new instance's data stays in place
p.thread16 = null; mem.fill(0x11, BASE, BASE + SIZE);
const pc2 = p.spawn(new Uint8Array(0), null, { base: BASE, entry: 0 }, 'C:\\WINDOWS\\EXPLORER.EXE', 'EXPLORER.EXE');
assert.equal(mem[BASE + 0x84], 0x22); assert.ok(pc2.exe === rec);
console.log('imageinstance: ok');
