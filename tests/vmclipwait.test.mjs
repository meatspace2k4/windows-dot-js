// An MS-DOS program's clipboard call (INT 2Fh AH=17h) while USER is busy (a thread holds the Win16Lock, or a thread's
// call is in progress) waits for USER: the VM halts with its INT 2Fh to be issued again at its next tick, as SHELL has
// the call made in the system VM when it can. Answered AX 0 then, ScanDisk run by Windows 98 Setup took the clipboard
// as unavailable and quit without its report, and Setup said there was not enough conventional memory to check the
// disks. With USER free the call is made at once, as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const vmm = readFileSync(new URL('../vmm.js', import.meta.url), 'utf8'), v86 = readFileSync(new URL('../v86.js', import.meta.url), 'utf8');
const a = vmm.indexOf('P.vmClipboard = function'), b = vmm.indexOf('/** the MS-DOS VMs\' time');
const h = v86.indexOf('HOOK[0x2f] = function'), h2 = v86.indexOf('  // in a VM of Windows\' (o.vmId)', h);
assert.ok(a >= 0 && b > a && h >= 0 && h2 > h, 'vmClipboard and HOOK[0x2f]');
const P = {}, W = { GuestError: class extends Error {}, log() {} };
new Function('P', 'W', vmm.slice(a, b))(P, W);
const HOOK = {}, ROM = 0xf0000, XMS = {};
new Function('HOOK', 'ROM', 'XMS', v86.slice(h, h2) + '  return false;\n};')(HOOK, ROM, XMS);

const machine = (ax, sys) => {
  const regs = { ax, bx: 0, cx: 0, dx: 0, si: 0 };
  const m = { cpu: { es: { value: 0 }, eip: { value: 0 } }, halted: false, r: n => regs[n], w: (n, v) => { regs[n] = v; }, ah: () => regs.ax >> 8, regs, setAL() {}, sreg() {} };
  m.o = { clip: x => P.vmClipboard.call(sys, x) };
  return m;
};
const sys = (busy, calls) => ({ depth: 0, thread16: null, win16Held: busy ? { who: { id: 119 } } : null, user16: (o) => { calls.push(o); return { ax: 1 }; } });

// USER busy: the VM waits at the INT 2Fh (CD 2F, two bytes before `next`), nothing asked of USER, AX as it was
{ const calls = [], s = sys(true, calls), m = machine(0x1701, s);
  assert.equal(HOOK[0x2f].call(m, 0x1234), true, 'taken: the code goes on at eip');
  assert.equal(m.cpu.eip.value, 0x1232, 'the INT again'); assert.equal(m.halted, true, 'until the next tick');
  assert.deepEqual(calls, [], 'USER not called'); assert.equal(m.regs.ax, 0x1701, 'AX not answered 0'); }
// USER free: OpenClipboard made, AX 1, the code goes on after the INT
{ const calls = [], s = sys(false, calls), m = machine(0x1701, s); m.cpu.eip.value = 0x1234;
  assert.equal(HOOK[0x2f].call(m, 0x1234), true);
  assert.deepEqual(calls, [137], 'OpenClipboard'); assert.equal(m.regs.ax, 1); assert.equal(m.halted, false); assert.equal(m.cpu.eip.value, 0x1234); }
// a VM waiting for USER says so (a yield then lets the Win16Lock go for it: ne16.js othersReady), and no longer once served
{ const s = sys(true, []), m = machine(0x1701, s); HOOK[0x2f].call(m, 0x1234); assert.equal(m.askedUser, true, 'waiting');
  s.win16Held = null; m.regs.ax = 0x1701; HOOK[0x2f].call(m, 0x1234); assert.equal(m.askedUser, false, 'served'); }
// the version (1700h) answers whatever USER is doing
{ const m = machine(0x1700, sys(true, [])); HOOK[0x2f].call(m, 0x1234); assert.equal(m.regs.ax, 0x0a01); assert.equal(m.halted, false); }
console.log('vmclipwait: ok');
