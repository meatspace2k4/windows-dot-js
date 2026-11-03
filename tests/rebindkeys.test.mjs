// rebind pairs an array's records by what they are (name, key, id, pid, path), not by position: a moment's modules
// paired by position with the booted machine's took those modules' code (a record's wasm run is a function the export
// cannot carry, kept from the live object at the same path), and COMMCTRL's record ran another module's run at its
// own addresses, which returned the same address each time: the machine stood at COMMCTRL 2:69 for good. (1) A
// record pairs with the live record of its name, in another position; a record no live one answers to is made anew
// without the function (lost), never with another's. (2) An element with no name pairs by index as before. (3) A
// name that repeats pairs by index.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../braid.js', import.meta.url), 'utf8'))();
const B = window.W95Braid;
const runA = () => 'A', runB = () => 'B';
// (1)
{
  const ex = B.serialize(B.takeGraph([{ modules: [{ name: 'COMMCTRL', size: 3, run: runA }, { name: 'SETUPX', size: 4, run: runB }] }]));
  const live = { modules: [{ name: 'SETUPX', size: 1, run: runB }, { name: 'USER', size: 2, run: runA }] };
  const r = B.rebind([live], ex);
  assert.deepEqual(live.modules.map(m => m.name), ['COMMCTRL', 'SETUPX']);
  assert.equal(live.modules[1].run, runB, 'SETUPX\'s own, by its name'); assert.equal(live.modules[1].size, 4);
  assert.equal(live.modules[0].run, undefined, 'COMMCTRL\'s: none here, not USER\'s'); assert.equal(live.modules[0].size, 3);
  assert.ok(r.lost.some(([n, k]) => k === 'run'), 'named as lost');
}
// (2)
{
  const ex = B.serialize(B.takeGraph([{ a: [{ v: 1, f: runA }, { v: 2, f: runB }] }]));
  const live = { a: [{ v: 9, f: runA }, { v: 9, f: runB }] };
  B.rebind([live], ex);
  assert.equal(live.a[0].f, runA); assert.equal(live.a[1].f, runB); assert.equal(live.a[0].v, 1);
}
// (3)
{
  const ex = B.serialize(B.takeGraph([{ a: [{ name: 'EXE', v: 1, f: runA }, { name: 'EXE', v: 2, f: runB }] }]));
  const live = { a: [{ name: 'EXE', v: 0, f: runA }, { name: 'EXE', v: 0, f: runB }] };
  B.rebind([live], ex);
  assert.equal(live.a[0].f, runA); assert.equal(live.a[1].f, runB); assert.equal(live.a[1].v, 2);
}
console.log('rebindkeys: ok');
