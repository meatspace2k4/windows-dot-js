// A processor exception in ring 0 the machine's poll runs (a VxD's time-out, VKD's key handling) is the machine's to
// answer: the process records it (faulted, which the step answers with VWIN32's blue screen) and the run the poll
// interrupted goes no further. Printed and passed over, the system ran on with NETBEUI's state broken after its
// time-out page-faulted: the time-out ran again from 0 and the screen was written over. Another error is still printed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = w.indexOf('  r0Fault(e) {'), j = w.indexOf('  queueKey(');
assert.ok(i >= 0 && j > i, 'r0Fault and pollIn');
class FaultError extends Error { constructor(f) { super(f.why); this.fault = f; } }
const W = { FaultError, WM: { KEYDOWN: 0x100, KEYUP: 0x101 } };
let ring = [];
const B = { KEY: 1, MOUSE: 2, ringTake: () => ring.shift() || null };
const Poll = new Function('W', 'B', `return class { ${w.slice(i, j)} }`)(W, B);

const fault = { why: 'exception eh at 129366c', ring: 0 };
const mk = timeOut => {
  const m = new Poll(), faults = [];
  m.proc = { depth: 1, r0Depth: 0, vxdTimeOuts: new Map([[1, {}]]), vxdRunTimeOuts: timeOut, faulted: f => faults.push(f), dispatchInput() {} };
  m.keyq = []; m.queueKey = () => {};
  return { m, faults };
};
const err = console.error; let printed = []; console.error = e => printed.push(String(e));
try {
  // NETBEUI's time-out page-faults: recorded for the blue screen, and thrown on so the interrupted run stops
  { const { m, faults } = mk(() => { throw new FaultError(fault); });
    assert.throws(() => m.pollIn(), FaultError);
    assert.deepEqual(faults, [fault]); assert.equal(m.proc.depth, 1, 'the run\'s depth as it was'); assert.equal(m.inTimer, false); assert.deepEqual(printed, []); }
  // VKD's key handling faults the same way
  { const { m, faults } = mk(() => {}); m.proc.vxdTimeOuts = new Map();
    m.proc.vkdKey = () => { throw new FaultError(fault); }; ring = [[B.KEY, 0x1e, 0, 0x41]];
    assert.throws(() => m.pollIn(), FaultError); assert.deepEqual(faults, [fault]); }
  // anything else is printed and the poll goes on
  { const { m, faults } = mk(() => { throw new Error('no such service'); }); ring = [];
    m.pollIn(); assert.deepEqual(faults, []); assert.deepEqual(printed, ['Error: no such service']); }
} finally { console.error = err; }
console.log('r0fault: ok');
