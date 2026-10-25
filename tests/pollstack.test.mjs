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
console.log('pollstack: ok');
