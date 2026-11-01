// The worker's step while an MS-DOS VM's event waits at ring 0 (SHELL's hold of the VM until WinOldAp's next SHELL
// call releases it): the run goes on when it can, and the system's slice, threads and VMs run in the same step, since
// the wait holds that VM only. Held as other ring-0 runs are, the step ran nothing but the wait, WinOldAp's release
// never came, and the system stopped. A ring-0 run of the system's that waits still holds the step as before; input
// is held only by such a run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const s = w.indexOf('  step() {'), e = w.indexOf('  /** the next step as soon as'), r = w.indexOf('  ring0() {'), r2 = w.indexOf('  feedKeys() {');
assert.ok(s >= 0 && e > s && r >= 0 && r2 > r, 'step and ring0');
const W = { FaultError: class extends Error {}, HangError: class extends Error {} };
const Step = new Function('W', 'post', `return class { ${w.slice(s, e)} ${w.slice(r, r2)} }`)(W, () => {});

const mk = runs => {
  const m = new Step(), did = [];
  const p = {
    r0Runs: runs, r0Step() { did.push('r0Step'); }, stats: { slices: 0, guestMs: 0 }, depth: 0, thread16: null, win16Held: null,
    slice() { did.push('slice'); return true; }, timers16() {}, systemPump() {}, appy16() {}, threads16() { did.push('threads'); },
    vmsRun() { did.push('vms'); }, preempted: 0, pcFaults: [], trapped: null, exitCode: null, fault: null,
  };
  Object.assign(m, { proc: p, alive: true, keyq: [], mouseq: [], poll() {}, feedMouse() {}, feedKeys() {}, postScan() {}, sendText() {}, frame() {}, stepSoon() {} });
  return { m, p, did };
};
const t = globalThis.setTimeout; globalThis.setTimeout = () => 1;
try {
  // an MS-DOS VM's event waiting: the wait checked, and the system runs on in the same step
  { const { m, did } = mk([{ vm: {}, wait: true }]);
    m.step();
    assert.ok(did.includes('r0Step'), 'the wait looked at'); assert.ok(did.includes('threads'), 'the system\'s threads run'); assert.ok(did.includes('vms'), 'the VMs run');
    assert.equal(m.ring0(), false, 'input not held'); }
  // a ring-0 run of the system's: the step is its alone, as before
  { const { m, did } = mk([{ wait: true }]);
    m.step();
    assert.deepEqual(did, ['r0Step'], 'nothing else'); assert.equal(m.ring0(), true, 'input held'); }
} finally { globalThis.setTimeout = t; }
console.log('vmeventstep: ok');
