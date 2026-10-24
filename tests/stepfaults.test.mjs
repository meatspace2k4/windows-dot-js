// Everything a step of the machine runs answers to the machine as a slice does: a processor exception is the fault
// (VWIN32's blue screen at ring 0), anything else its end. The interrupts' poll at the step's head, the system's first
// task, and the input fed to USER ran outside that: a fault there escaped the step's timer, and the machine froze
// with nothing on the screen; inside USER's input calls it was a console line.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const method = name => { const i = src.indexOf(`  ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i) + 4); };
class FaultError extends Error { constructor(fault) { super(fault.why); this.fault = fault; } }
class HangError extends Error {}
const W = { FaultError, HangError, WM: {} };
const B = { ringTake: () => null };
const M = new Function('B', 'W', 'post', 'performance', 'setTimeout', 'clearTimeout',
  `return class {\n${['step', 'caught', 'poll', 'feedKeys', 'feedMouse'].map(method).join('\n')}\n}`);
const posted = [];
const mk = proc => {
  const m = new (M(B, W, x => posted.push(x), { now: () => 0 }, () => 1, () => {}))();
  const seen = [];
  Object.assign(m, { proc, alive: true, ring: [], keyq: [], mouseq: [], mods: {}, ring0: () => false, sendText() {}, frame() {}, postScan() {}, stopFullSavers() {},
    fatal: f => seen.push(['fatal', f.why]), exited: (c, why) => { seen.push(['exited', why]); m.alive = false; } });
  return [m, seen];
};
const proc = extra => Object.assign({ depth: 0, stats: { slices: 0, guestMs: 0 }, exitCode: null, trapped: null, pcFaults: [], scanout: () => ({}),
  faulted(f) { this.fault = f; }, hung() {}, slice: () => true, timers16() {}, threads16() {}, systemPump() {}, appy16() {}, user16: () => ({ ax: 0 }) }, extra);
const r0 = why => { throw new FaultError({ ring: 0, why }); };

{ // (the poll runs the due time-outs inside a guest's run: with depth, a call the guest is in)
  const p = proc({ depth: 1, vxdTimeOuts: new Set([1]), vxdRunTimeOuts: () => r0('page fault in REBOOT') }), [m, seen] = mk(p); m.step();
  assert.deepEqual(seen, [['fatal', 'page fault in REBOOT']], 'a time-out\'s fault at the step\'s head is the blue screen'); }
{ const p = proc({ keyEvent16: () => r0('page fault in USER at ring 0') }), [m, seen] = mk(p); m.keyq.push([0x41, 0x1e, false]); m.step();
  assert.deepEqual(seen, [['fatal', 'page fault in USER at ring 0']], 'a fault in USER taking a key is the fault'); }
{ const p = proc({ mouseEvent16: () => { throw new TypeError('q is null'); } }), [m, seen] = mk(p); m.mouseq.push([1, 2, 3]); m.step();
  assert.deepEqual(seen, [['exited', 'q is null']], 'an error feeding the mouse ends the machine, naming it'); }
{ const p = proc({}), [m, seen] = mk(p); m.sysPending = true; m.startMsgsrv = () => r0('page fault in MPR'); m.step();
  assert.deepEqual(seen, [['fatal', 'page fault in MPR']], 'a fault starting the system\'s first task is the fault'); }
console.log('stepfaults: ok');
