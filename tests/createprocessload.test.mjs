// CreateProcess returns once the new process is loaded, as Windows 95's waits for its load-done event: its DLLs have
// attached and USER has its per-process data (which WaitForInputIdle reads in the caller right after). SHELL32's
// ShellExecute of a folder (CreateProcess Explorer, WaitForInputIdle, then DDE ViewFolder) found none, did not wait,
// and its DDE went out before Explorer could answer: the folder window never opened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, cp = W.API.KERNEL32.CreateProcessA[1];

const u8 = new Uint8Array(1 << 16), dv = new DataView(u8.buffer), handles = new Map(); let hn = 0x100;
const str = (a, s) => { for (let i = 0; i < s.length; i++) u8[a + i] = s.charCodeAt(i); u8[a + s.length] = 0; return a; };
const pc = { pid: 0x68, started: false, exitCode: null }; pc.main = { id: 0x99, pc, state: 'new' };
let slices = 0;
const g = {
  u8, r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  readA(a) { let s = ''; for (let i = a; u8[i]; i++) s += String.fromCharCode(u8[i]); return s; },
  newHandle(o) { handles.set(hn, o); return hn++; }, obj: h => handles.get(h),
  host: { exec: () => pc }, threadsById: new Map([[0x99, pc.main]]),
  // the scheduler: the child's main thread runs its process start (pcStart) in its first slice
  threads16(nested, only) { assert.equal(only, pc.main); slices++; if (slices === 2) pc.started = true; },
};
const cmd = str(0x100, 'C:\\WINDOWS\\Explorer.exe /idlist,:1,C:\\X'), pi = 0x400;
assert.equal(cp.call(g, 0, cmd, 0, 0, 0, 0, 0, 0, 0, pi), 1);
assert.equal(pc.started, true, 'the child is loaded when CreateProcess returns');
assert.equal(slices, 2);
assert.equal(g.r32(pi + 8), 0x68);
console.log('createprocessload: ok');
