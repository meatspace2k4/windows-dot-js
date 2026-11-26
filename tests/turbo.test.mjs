// mod-turbo.js: x alone runs the machine x times ahead of the wall; x@NAMES only while a program of those names runs (a
// 16-bit task by its TDB's module name, a 32-bit process by its file), the wall's pace once none does; ended, the wall's
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../mod-turbo.js', import.meta.url), 'utf8');
const run = (arg, proc) => {
  const calls = [], timers = [];
  const self = { W95ModArg: arg, W95Win32: { log: () => {} }, W95ModOff: {} };
  const machine = { proc, cmd: (n, a) => calls.push([n, ...a]) };
  new Function('self', 'machine', 'setInterval', 'clearInterval', src)(self, machine, f => (timers.push(f), timers.length), i => { timers[i - 1] = null; });
  return { calls, tick: () => timers.forEach(f => f && f()), off: () => self.W95ModOff['mod-turbo.js']() };
};
// (a TDB's module name at F2h of its selector's base, as KERNEL keeps it)
const mem = new Map(), proc = { tdbList: [], procs: new Map(), selValid: s => mem.has(s), selBase: s => s, readA: a => mem.get(a - 0xf2) };

{ const t = run('8', proc); assert.deepEqual(t.calls, [['speed', 8]], 'x alone: the whole machine'); t.off(); assert.deepEqual(t.calls.at(-1), ['speed', 1]); }

const t = run('8@SETUP,W98SETUP.EXE,SUWIN,RUNONCE', proc);
assert.deepEqual(t.calls, [['speed', 1]], 'none of them running: the wall\'s pace');
mem.set(0x1234, 'SUWIN   '); proc.tdbList.push(0x1234); t.tick();
assert.deepEqual(t.calls.at(-1), ['speed', 8], 'a 16-bit task of the list');
t.tick(); assert.equal(t.calls.length, 2, 'told once');
proc.tdbList.length = 0; proc.procs.set(1, { path: 'C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE', exitCode: null }); t.tick();
assert.equal(t.calls.length, 2, 'RUNONCE (a 32-bit process) takes over: still ahead');
proc.procs.get(1).exitCode = 0; proc.procs.set(2, { path: 'C:\\WINDOWS\\EXPLORER.EXE', exitCode: null }); t.tick();
assert.deepEqual(t.calls.at(-1), ['speed', 1], 'only the desktop: the wall\'s pace');
proc.procs.set(3, { path: 'D:\\WIN98\\W98SETUP.EXE', exitCode: null }); t.tick(); assert.deepEqual(t.calls.at(-1), ['speed', 8], 'a name given with .EXE');
t.off(); assert.deepEqual(t.calls.at(-1), ['speed', 1], 'ended: the wall\'s pace'); const n = t.calls.length; t.tick(); assert.equal(t.calls.length, n, 'its watch ended');
console.log('turbo: ok');
