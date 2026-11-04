// Ring α (braid.js): the line and its records. (1) The line: moments at machine times on generations; travel forks it,
// and a generation's lineage runs back through the forks, so the moment at or before a time is found along it and a
// moment of a generation left behind is not; the journal's actions between two times on the lineage; a span already
// computed found by its actions from the moment the line is at (memo), and not from another moment or after the
// moment changed; the line as a record and back. (2) An anchored moment's record: its checksum tells a damaged copy
// (a byte of a machine's memory changed), its build signature another build's. (3) The lint's verdict over its
// findings; a ring-0 run at the same place and the process ended are findings. (4) A mod's record is the script's
// name and the sum of its text: the same script changed is another mod.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../braid.js', import.meta.url), 'utf8'))();
const B = window.W95Braid;

// (1) the line
{
  const L = new B.Line();
  assert.equal(L.gen, 0); assert.equal(L.before(0), null); assert.equal(L.extent(), null);
  L.took({ name: 'a', at: 100, sum: 1 });
  L.note({ op: 'click', args: [{ name: 'Next >' }], at: 150 });
  L.note({ op: 'key', args: ['enter'], at: 160 });
  L.took({ name: 'b', at: 200, sum: 2 });
  L.note({ op: 'type', args: ['x'], at: 250 });
  L.took({ name: 'c', at: 300, sum: 3 });
  assert.deepEqual(L.along().map(m => m.name), ['a', 'b', 'c']);
  assert.equal(L.segments.length, 2); assert.deepEqual(L.segments[0].actions.map(a => a.op), ['click', 'key']);
  assert.deepEqual(L.extent(400), { lo: 100, hi: 400 });
  // travel back to a: generation 1 grows from it; b and c stay on the line but not on the lineage
  L.note({ op: 'run', args: ['notepad'], at: 320 });   // (an action in the open journal, closed into an open segment by the fork)
  assert.equal(L.fork('a', 'travel', { now: 330 }), 1);
  assert.deepEqual(L.along().map(m => m.name), ['a']);
  assert.deepEqual(L.lineage().map(l => l.gen), [1, 0]); assert.equal(L.lineage()[1].until, 100);
  assert.equal(L.before(250).name, 'a', 'b is on the generation left behind');
  assert.equal(L.after(100), null);
  assert.equal(L.segments[2].to, null, 'the open journal was closed into an open segment'); assert.equal(L.segments[2].at1, 330);
  L.took({ name: 'd', at: 180, sum: 4 });
  assert.deepEqual(L.along().map(m => m.name), ['a', 'd']); assert.equal(L.before(190).name, 'd'); assert.equal(L.before(1000).name, 'd'); assert.equal(L.after(100).name, 'd');
  assert.deepEqual([L.at(150).moment.name, L.at(150).gen], ['a', 1], 'this lineage runs on past 150 now (d is at 180)');
  assert.deepEqual([L.at(250).moment.name, L.at(250).gen], ['b', 0], 'past d, only generation 0 ran on');
  // the actions on the lineage between two times: none of generation 0's past the fork
  assert.deepEqual(L.actionsBetween(0, 1000).map(a => a.op), []);
  // the place a time names: on this lineage while it runs on past it; a time in the run left behind (between a and b
  // of generation 0, which ran on to c) names that run's moment, and its actions are the ones to make again
  assert.deepEqual([L.at(150).moment.name, L.at(150).gen], ['a', 1], 'this lineage has d past 150: its own run');
  assert.deepEqual(L.actionsIn(0, 100, 150).map(a => a.op), ['click']); assert.deepEqual(L.actionsIn(0, 100, 250).map(a => a.op), ['click', 'key', 'type']);
  assert.deepEqual([L.at(250).moment.name, L.at(250).gen], ['b', 0], 'past d, generation 0 is the record that runs on');
  assert.deepEqual(L.actionsBetween(100, 250, 0).map(a => a.op), ['click', 'key', 'type'], 'the run left behind, with its actions');
  L.note({ op: 'click', args: [1], at: 185 }); L.took({ name: 'e', at: 190, sum: 5 });
  assert.deepEqual(L.actionsBetween(100, 190).map(a => a.op), ['click']);
  // memo: from a again, the span with the same actions as before leads to b
  L.fork('a', 'travel', { now: 190 });
  assert.equal(L.memo([['click', [{ name: 'Next >' }]], ['key', ['enter']]]).to, 'b');
  assert.equal(L.memo([['click', [{ name: 'Next >' }]]]), null, 'a span with other actions is not it');
  assert.equal(L.memo([]).to, 'd', 'a span of no actions from a leads to d: time passing is a span too');
  L.fork('d', 'travel', { now: 190 });
  assert.equal(L.memo([['click', [{ name: 'Next >' }]], ['key', ['enter']]]), null, 'not from another moment');
  // the moment changed under the same name (another sum): no memo from it
  L.fork('a', 'travel', { now: 190 }); L.j.fromSum = 99;
  assert.equal(L.memo([['click', [{ name: 'Next >' }]], ['key', ['enter']]]), null);
  // a fault on the line, under its generation; the line as a record and back
  L.event({ t: 1, machine: 'system', fatal: true, fault: { why: 'exception eh' } });
  L.broken.set('c', 'broken');
  const copy = B.Line.from(JSON.parse(JSON.stringify(L)));
  assert.equal(copy.gen, L.gen); assert.deepEqual(copy.along().map(m => m.name), L.along().map(m => m.name));
  assert.equal(copy.events[0].fault.why, 'exception eh'); assert.equal(copy.broken.get('c'), 'broken');
  assert.equal(copy.describe().moments.find(m => m.name === 'c').verdict, 'broken');
  assert.ok(copy.describe().forks.every(f => f.gen !== undefined));
  assert.ok(L.forget('c')); assert.equal(L.broken.get('c'), undefined); assert.ok(!L.forget('c'));
}

// (2) an anchored moment's record
{
  const mem = new Uint8Array([1, 2, 3, 4]);
  const rec = B.anchor({ name: 'x', now: 500, build: 'b1', mods: [{ name: 'a.js', sum: '1' }], machines: { system: { meta: [{ kind: 'mem' }], roots: [{ r: 0 }], blob: mem, registry: [], now: 500 } }, page: { meta: [], roots: [], blob: new Uint8Array(0) }, registry: [['hklm\\x', 'a', 1]], line: null });
  assert.equal(rec.magic, 'W95ANCHOR'); assert.equal(B.refuseAnchor(rec, 'b1'), null); assert.equal(B.refuseAnchor(rec, ''), null);
  assert.match(B.refuseAnchor(rec, 'b2'), /build b1/);
  const sum = rec.sum; mem[2] = 9; assert.match(B.refuseAnchor(rec, 'b1'), /damaged/); mem[2] = 3; assert.equal(B.refuseAnchor(rec, 'b1'), null); assert.equal(rec.sum, sum);
  rec.mods.push({ name: 'b.js', sum: '2' }); assert.match(B.refuseAnchor(rec, 'b1'), /damaged/, 'the mods beside it are under the sum too');
  assert.match(B.refuseAnchor({ magic: 'W95BRAID' }, ''), /not an anchored/);
  assert.match(B.refuseAnchor({ ...rec, version: 99 }, ''), /version/);
}

// (3) the lint's verdict
{
  const probe = (now, o = {}) => ({ kind: 'json', value: { now, threads: [], held: null, faults: 0, heapTop: 0x400000, allocs: 10, r0: 0, queue: 0, exited: null, ...o } });
  const at = (a, b) => B.lint({ sections: { probe: a } }, { sections: { probe: b } });
  assert.equal(B.verdict(at(probe(0), probe(5000))), 'ok');
  assert.equal(B.verdict(at(probe(0, { r0: 1, r0At: 0x1200fa7 }), probe(5000, { r0: 1, r0At: 0x1200fa7 }))), 'suspect', 'a ring-0 run at the same place');
  assert.equal(B.verdict(at(probe(0, { r0: 1, r0At: 0x1200fa7 }), probe(5000, { r0: 1, r0At: 0x1200fb0 }))), 'ok', 'one that moved on');
  assert.equal(B.verdict(at(probe(0), probe(5000, { exited: -1 }))), 'broken', 'the process ended');
  assert.equal(B.verdict(at(probe(0), probe(5000, { faults: 1 }))), 'suspect', 'a line in the fault log (a parameter error) is a sign, not a crash');
  assert.equal(B.verdict(at(probe(0), probe(5000, { fatal: 1 }))), 'broken', 'an exception the system answered is');
  assert.equal(B.verdict([]), 'ok'); assert.equal(B.verdict([{ level: 'info' }]), 'ok'); assert.equal(B.verdict([{ level: 'warn' }, { level: 'error' }]), 'broken');
}

// (4) a mod's record
{
  const a = B.mod('claude-app.js', 'code'), b = B.mod('claude-app.js', 'code '), c = B.mod('claude-app.js', 'code');
  assert.equal(a.name, 'claude-app.js'); assert.notEqual(a.sum, b.sum); assert.equal(a.sum, c.sum); assert.match(a.sum, /^[0-9a-f]{8}$/);
}
console.log('braid-line: ok');
