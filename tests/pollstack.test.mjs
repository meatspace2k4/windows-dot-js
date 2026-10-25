// The machine's poll in the middle of a run (the budget's check) is an interrupt: it runs through the process's
// asInterrupt (its own stack, its own client registers: tests/interrupt.test.mjs), never on the stopped code's SS:SP.
// Sampled at a frozen first start: WELCOME blitting on DIBENG's 4Ah-byte blit stack (SS 129Fh, SP 40h) had 305F:0934
// (its own CS:IP) at SS:3Ch, zeros down to SS:4 and its line count at SS:0 counting down from 0.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = w.indexOf('  poll() {'), j = w.indexOf('  pollIn() {');
assert.ok(i >= 0 && j > i, 'poll and pollIn');
const Poll = new Function(`return class { ${w.slice(i, j)} }`)();

const mk = runLevel => {
  const cpu = { ss: { value: 0x129f }, ssb: { value: 0x1e40360 }, esp: { value: 0x40 }, cs: { value: 0x305f }, eip: { value: 0x1e3db54 } }, seen = [];
  const m = new Poll();
  m.proc = { cpu, runLevel, asInterrupt(fn) { seen.push('interrupt'); this.inInterrupt = true; try { return fn(); } finally { this.inInterrupt = false; } } };
  m.pollIn = function () { seen.push(m.proc.inInterrupt ? 'in, as an interrupt' : 'in'); return 'ran'; };
  return { m, seen };
};
// mid-run: an interrupt
{ const { m, seen } = mk(1); assert.equal(m.poll(), 'ran'); assert.deepEqual(seen, ['interrupt', 'in, as an interrupt']); }
// between slices (no run in progress): nothing stopped, the poll runs as it is
{ const { m, seen } = mk(0); m.poll(); assert.deepEqual(seen, ['in']); }
// the log (cmd 'pollLog'): a mid-run poll that ran a time-out, with the run it stopped and the stack it was on
{
  const { m } = mk(1), p = m.proc;
  p.sysTime = () => 5000; p.selValid = () => true; p.selLimit = () => 0x49;
  p.vxdTimeOuts = new Map([[0xf0000008, { fn: 0x1820049, due: 4990 }], [0xf0000010, { fn: 0x1820049, due: 9000 }]]);
  p.modules = [{ kind: 'vxd', name: 'VTDAPI', base: 0x1820000, meta: { size: 0x5000 } }];
  p.thread16 = { id: 104, pc: { path: 'C:\\WINDOWS\\WELCOME.EXE' } };
  m.pollIn = function () { p.vxdTimeOuts.delete(0xf0000008); };
  m.poll();
  assert.deepEqual(m.pollLog, [{ ms: 5000, who: '104 WELCOME.EXE', at: '305f:1e3db54', ss: '129f', sp: '40', ssLimit: 0x49, timeouts: ['VTDAPI+49'], inputs: 0 }]);
  m.pollIn = function () {}; m.poll();
  assert.equal(m.pollLog.length, 1, 'a poll that ran nothing is not logged');
}
console.log('pollstack: ok');
