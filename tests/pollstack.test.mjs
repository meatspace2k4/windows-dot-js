// The machine's poll (the budget's check, mid-run) runs the VMM's time-outs and the page's input on a stack of its own:
// on the interrupted code's SS:SP their frames went below it. Sampled at a frozen first start: WELCOME blitting on
// DIBENG's 4Ah-byte blit stack (SS 129Fh, SP 40h) had 305F:0934 (its own CS:IP) at SS:3Ch, zeros down to SS:4 and its
// line count at SS:0 at FF78F0F7h: the hourglass, the crawl, then the freeze before WELCOME's window
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = w.indexOf('  poll() {'), j = w.indexOf('  pollIn() {');
assert.ok(i >= 0 && j > i, 'poll and pollIn');
const Poll = new Function(`return class { ${w.slice(i, j)} }`)();

const mk = runLevel => {
  const cpu = { ss: { value: 0x129f }, ssb: { value: 0x1e40360 }, esp: { value: 0x40 } }, seen = [];
  const m = new Poll();
  m.proc = { cpu, runLevel, alloc: n => { seen.push(['alloc', n]); return 0x3000000; } };
  m.pollIn = function () { seen.push(['in', cpu.ss.value, cpu.ssb.value, cpu.esp.value]); cpu.esp.value -= 0x40; return 'ran'; };
  return { m, cpu, seen };
};
// mid-run: the poll's code runs on its own flat stack, and the interrupted code's SS:SP come back as they were
{
  const { m, cpu, seen } = mk(1);
  assert.equal(m.poll(), 'ran');
  assert.deepEqual(seen, [['alloc', 0x10000], ['in', 0, 0, 0x3000000 + 0x10000 - 16]]);
  assert.deepEqual([cpu.ss.value, cpu.ssb.value, cpu.esp.value], [0x129f, 0x1e40360, 0x40], 'SS:SP as the blit left them');
  m.poll(); assert.equal(seen.filter(s => s[0] === 'alloc').length, 1, 'one stack, kept');
}
// a poll inside the poll (msgWait in ring 0 it ran) stays on the poll's stack
{
  const { m, cpu, seen } = mk(1);
  m.pollIn = function () { seen.push(['in', cpu.esp.value]); if (seen.length < 3) { cpu.esp.value -= 0x100; this.poll(); } return 'ran'; };
  m.poll();
  assert.deepEqual(seen.slice(1).map(s => s[1]), [0x300fff0, 0x300fef0], 'the inner poll goes on below the outer one');
  assert.equal(cpu.esp.value, 0x40);
}
// between slices (no run in progress): nothing to keep, the poll runs where it is
{
  const { m, seen } = mk(0);
  m.poll();
  assert.deepEqual(seen, [['in', 0x129f, 0x1e40360, 0x40]]);
}
console.log('pollstack: ok');
