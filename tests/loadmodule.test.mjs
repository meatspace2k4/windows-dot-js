// KERNEL32's LoadModule: the module started as WinExec starts one, with the command tail of its LOADPARMS32 (a length
// byte, then the text) and the show command (lpCmdShow: 2, nCmdShow); a started program's instance is above 31, a
// failure the error (Hover! starts its help through it)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;
const mem = new Uint8Array(1 << 16), p = Object.create(P);
Object.defineProperty(p, 'mem', { value: { buffer: mem.buffer } });
const calls = []; let answer = { pid: 0x70 };
p.host = { exec: (cmd, show) => { calls.push([cmd, show]); return answer; } };
const str = (a, s) => { mem.set([...s].map(c => c.charCodeAt(0)), a); mem[a + s.length] = 0; };
str(0x100, 'D:\\FUNSTUFF\\HOVER\\WMCONFIG.EXE');
const tail = ' /quiet'; mem[0x200] = tail.length; str(0x201, tail);
p.w32(0x300, 0); p.w32(0x304, 0x200); p.w32(0x308, 0x400); p.w32(0x30c, 0);
p.w16(0x400, 2); p.w16(0x402, 3);
const lm = W.API.KERNEL32.LoadModule[1];
assert.equal(lm.call(p, 0x100, 0x300), 33, 'started: an instance above 31');
assert.deepEqual(calls[0], ['"D:\\FUNSTUFF\\HOVER\\WMCONFIG.EXE" /quiet', 3]);
answer = 2; assert.equal(lm.call(p, 0x100, 0x300), 2, 'not found: the error');
mem[0x200] = 0; lm.call(p, 0x100, 0); assert.deepEqual(calls[2], ['"D:\\FUNSTUFF\\HOVER\\WMCONFIG.EXE"', 1], 'no parameter block: no tail, shown normally');
console.log('loadmodule: ok');
