// A pass of the threads the host makes between slices (ne16.js threads16, not nested, not one thread) ends once the
// machine's clock has gone PASS_MS past its start, at least one thread run, and the next pass starts with the thread it
// left. A pass of every thread was one step: with Setup's many threads in slow code a step ran 1.9 s, and the system
// froze while it copied
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
let clock = 0; const ran = [];
const p = Object.create(P);
Object.assign(p, {
  host: { now: () => clock }, threadsById: new Map(), cpu: { budget: { value: 0 }, eip: { value: 0 }, esp: { value: 0 } },
  saveCtx16: () => ({}), restoreCtx16() {}, loadCtx16() {}, imgUse() {}, cwdSwitch() {}, holdWin16() {}, waitBlocked: () => false,
  runTop() { ran.push(this.thread16.id); clock += 3; this.preempted = this.thread16.wakes ? 0 : 1; return 1; },   // (each run: 3 ms of the machine's time, then preempted, but a thread that yields)
});
for (const id of [1, 2, 3, 4, 5, 6]) p.threadsById.set(id, { id, state: 'waiting', wait: null, ctx: {}, preempted: true });
const pass = () => { ran.length = 0; try { p.threads16(); } catch (e) { if (!ran.length) throw e; } return [...ran]; };
const first = pass();
assert.ok(first.length >= 1 && first.length < 6, `a pass bounded by the machine's clock: ${first}`);
const second = pass();
assert.equal(second[0], first[first.length - 1] + 1, 'the next pass starts with the thread the last one left');
const seen = new Set([...first, ...second]); for (let k = 0; k < 6 && seen.size < 6; k++) for (const id of pass()) seen.add(id);
assert.equal(seen.size, 6, 'every thread has its turn');
// (a thread its wait let go, not preempted: it runs in every pass, past the bound, as a woken thread is boosted;
// held back too, MMTASK's wave callbacks came a pass late and SystemStart stuttered)
const audio = p.threadsById.get(6); audio.wakes = true; audio.preempted = false;
for (let k = 0; k < 4; k++) assert.ok(pass().includes(6), 'the woken thread runs in each pass');
console.log('threadpass: ok');
