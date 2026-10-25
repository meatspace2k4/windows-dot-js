// A ring-0 run whose time ran out (preempted, not waiting) goes on before any event the VxDs scheduled starts: ring-0
// code is not interrupted by more ring-0 code, and an event runs when ring 0 has nothing in progress. A run that
// waits (_BlockOnID) lets events run meanwhile. r0Step started the queued event first, so IFSMGR's event ran in the
// middle of IFSMGR's own call (after its cli), its structures half-changed, and a fresh disk's boot faulted in IFSMGR.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

const order = [];
const mk = () => {
  const p = Object.create(P);
  Object.assign(p, {
    cpu: {}, saveFull: () => ({}), loadFull() {}, sysVM: () => 1, vmClientIdle: () => 0,
    r0Start(fn) { order.push('event ' + fn.toString(16)); return null; },
    r0Run(s) { order.push('resume ' + s.name); return null; },
  });
  return p;
};

// a preempted run and a queued event: the run goes on first
{
  const p = mk(); order.length = 0;
  p.r0Runs = [{ name: 'ifsmgr call', wait: false, ready: () => true, ctx: {} }];
  p.vxdEvents = [{ fn: 0x1200fec, ref: 0, handle: 1 }];
  p.r0Step();
  assert.deepEqual(order, ['resume ifsmgr call'], 'the preempted run goes on before the event starts');
  assert.equal(p.vxdEvents.length, 1, 'the event waits for ring 0 to be free');
}
// a run that waits: the event runs meanwhile
{
  const p = mk(); order.length = 0;
  p.r0Runs = [{ name: 'blocked', wait: true, ready: () => false, ctx: {} }];
  p.vxdEvents = [{ fn: 0x1200fec, ref: 0, handle: 1 }];
  p.r0Step();
  assert.deepEqual(order, ['event 1200fec'], 'with every run waiting, the event starts');
}
// the events run between slices (vxdRunEvents) wait for a preempted run too
{
  const p = mk(); order.length = 0; p.depth = 0;
  p.vxdCall = fn => { order.push('call ' + fn.toString(16)); return {}; };
  p.r0Runs = [{ name: 'ifsmgr call', wait: false, ready: () => true, ctx: {} }];
  p.vxdEvents = [{ fn: 0x1200fec, ref: 0, handle: 1 }];
  p.vxdRunEvents();
  assert.deepEqual(order, [], 'no event runs while a ring-0 run is preempted');
  p.r0Runs = []; p.vxdRunEvents();
  assert.deepEqual(order, ['call 1200fec'], 'it runs once ring 0 is free');
}
console.log('r0preempt: ok');
