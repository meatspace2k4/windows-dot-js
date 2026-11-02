// Ring α (braid.js): a moment of a machine taken and rewound to. (1) The graph: objects of every kind the machine's
// state is made of, changed in every way after the moment (properties set, added and deleted, Maps and Sets and
// arrays refilled, typed arrays and memories written, one typed array replaced by a longer one), put back as they
// were, in the same objects, so a closure that held one sees the moment's values. (2) A V86 machine running real-mode
// code: a moment in the middle of its run, the run continued, the moment rewound, the same steps run again to the
// same state: time travel within the recompilation. (3) The record: its checksum tells a damaged copy, its build
// signature another build's; a moment's lint reads the probe. (4) The registry's copy put back, quietly and as
// operations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['braid.js', 'fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'dyn.js', 'v86.js']) new Function(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))();
const B = window.W95Braid, W = window.W95Win32, V = window.W95V86;

// (1) the graph
{
  class Thread { constructor(id) { this.id = id; this.state = 'ready'; this.ctx = { eip: 0x100, cs: 0x1f }; } }
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 1 }), g = new WebAssembly.Global({ value: 'i32', mutable: true }, 7);
  const t1 = new Thread(1), t2 = new Thread(2);
  const root = { mem, cpu: { eip: g }, threads: new Map([[1, t1], [2, t2]]), tags: new Set(['a']), list: [t1, 'x', 3], bytes: new Uint8Array([1, 2, 3]), fpu: new Uint8Array(4), nested: { deep: { n: 1 } }, fn: () => 1, nul: null, when: new Date(5) };
  t1.other = t2; t2.other = t1;   // (a cycle)
  new Uint8Array(mem.buffer)[0x500] = 0xaa;
  const peek = () => t1.state + ':' + root.nested.deep.n;   // (a closure holding the objects)
  root.live = 'host'; const snap = B.make({ host: { kind: 'graph', graph: B.takeGraph([root], { skip: (o, k) => k === 'live' }) } }, { name: 'one', build: 'b1' });
  root.live = 'changed';
  assert.equal(B.refuse(snap, 'b1'), null);
  // everything changes
  t1.state = 'running'; t1.ctx.eip = 0x200; t1.extra = 'added'; delete t2.state; root.threads.delete(1); root.threads.set(3, new Thread(3));
  root.tags.add('b'); root.tags.delete('a'); root.list.push(9); root.list[0] = null; root.bytes[0] = 99; root.fpu = new Uint8Array(8); root.nested.deep.n = 2; root.nested.more = {};
  new Uint8Array(mem.buffer)[0x500] = 0x55; new Uint8Array(mem.buffer)[0x600] = 1; g.value = 8; root.gone = root.fn; root.fn = null;
  assert.equal(peek(), 'running:2');
  B.restoreGraph(snap.sections.host.graph);
  assert.equal(peek(), 'ready:1', 'the closure sees the moment again');
  assert.equal(t1.ctx.eip, 0x100); assert.equal(t1.extra, undefined, 'a property added since is gone'); assert.equal(t2.state, 'ready', 'one deleted since is back');
  assert.deepEqual([...root.threads.keys()], [1, 2]); assert.equal(root.threads.get(1), t1, 'the same object'); assert.deepEqual([...root.tags], ['a']);
  assert.equal(root.list.length, 3); assert.equal(root.list[0], t1); assert.deepEqual([...root.bytes], [1, 2, 3]); assert.equal(root.fpu.length, 4, 'the typed array of the moment\'s length');
  assert.equal(root.nested.more, undefined); assert.equal(typeof root.fn, 'function'); assert.equal(root.gone, undefined);
  assert.equal(new Uint8Array(mem.buffer)[0x500], 0xaa); assert.equal(new Uint8Array(mem.buffer)[0x600], 0); assert.equal(g.value, 7);
  assert.equal(root.when.getTime(), 5, 'a date, by reference');
  assert.equal(root.live, 'changed', 'a property left out of the moment is left alone by the rewind too');
  // the record: a copy damaged after its checksum is refused; another build's too
  assert.equal(B.refuse(snap, 'b1'), null); snap.sections.host.graph.entries[0].props.push(['x', 1]); assert.match(B.refuse(snap, 'b1'), /damaged/);
  snap.sections.host.graph.entries[0].props.pop(); assert.equal(B.refuse(snap, 'b1'), null); assert.match(B.refuse(snap, 'b2'), /build b1/);
  assert.match(B.refuse({ magic: 'x' }, ''), /not a moment/);
}

// (2) a machine's run, braided: real-mode code counting at 0600h, a moment mid-run, rewound, the same run again
{
  const m = V.machine({}); m.v86 = 0;
  let top = 0x30000; Object.assign(m, { dosTop: 0x20000, alloc: n => { const a = top; top += (n + 15) & ~15; return a; } });
  // 0700:0000  inc word [0600h]; retf: called in real mode as a nested execution block's far call is (ne16.js rmFarCall)
  m.u8.set([0xff, 0x06, 0x00, 0x06, 0xcb], 0x7000);
  const C = 0x9000, P = window.W95Win32.Process.prototype;
  const run = n => { for (let i = 0; i < n; i++) P.rmFarCall.call(m, C, 0x700, 0, [], []); };
  const count = () => m.dv.getUint16(0x600, true);
  run(3); const n0 = count(); assert.ok(n0 > 0, 'the counter runs');
  const snap = B.make({ host: { kind: 'graph', graph: B.takeGraph([m], { skip: (o, k) => k === 'dynEnv' }) } }, { name: 'mid', build: '' });
  run(5); const n1 = count(); assert.ok(n1 > n0, 'it ran on');
  B.restoreGraph(snap.sections.host.graph);
  assert.equal(count(), n0, 'rewound: the counter as it was at the moment');
  run(5); assert.equal(count(), n1, 'the same steps again, the same state: the run is a line to move along');
}

// (3) the lint: the Win16Lock held by the same thread across two moments, a thread at the same place with its time running out, faults since
{
  const probe = (now, o = {}) => ({ kind: 'json', value: { now, threads: [{ id: 5, state: 'running', cs: 0x1f, ip: 0x200, preempted: true, path: 'C:\\SUWIN.EXE' }], held: { who: 'thread 5', since: 100, hung: false }, faults: 0, heapTop: 0x400000, allocs: 10, r0: 0, queue: 0, ...o } });
  const a = { sections: { probe: probe(1000) } }, b = { sections: { probe: probe(6000, { faults: 1 }) } };
  const out = B.lint(a, b);
  assert.ok(out.some(x => /Win16Lock held by thread 5/.test(x.what)), 'the lock');
  assert.ok(out.some(x => /spin/.test(x.what) && x.thread === 5), 'the spin');
  assert.ok(out.some(x => /fault/.test(x.what) && x.level === 'error'), 'the fault');
  assert.deepEqual(B.lint(a, { sections: { probe: probe(1500, { held: null, threads: [] }) } }), [], 'nothing to say of a machine that moved on');
}

// (4) the registry's copy: a dump put back quietly, and as the operations that make it
{
  const ops = []; W.regWatch(o => ops.push(o));
  W.regSet('hklm\\software\\test', 'a', 1); W.regSet('hklm\\software\\test\\Sub', 'b', 'x');
  const dump = W.regDump();
  W.regSet('hklm\\software\\test', 'a', 2); W.regSet('hklm\\software\\test', 'c', 3); W.regDel('hklm\\software\\test\\sub'); W.regSet('hklm\\software\\other', 'd', 4);
  W.regLoad(dump); assert.deepEqual(W.regDump(), dump, 'quietly');
  W.regSet('hklm\\software\\test', 'a', 2); W.regSet('hklm\\software\\test', 'c', 3); W.regDel('hklm\\software\\test\\sub'); W.regSet('hklm\\software\\other', 'd', 4);
  ops.length = 0; W.regLoad(dump, true); assert.deepEqual(W.regDump(), dump, 'as operations');
  assert.deepEqual(ops.map(o => o.op + ' ' + o.path + (o.name ? ' ' + o.name : '')).sort(), ['del hklm\\software\\test c', 'delkey hklm\\software\\other', 'key hklm\\software\\test\\sub Sub', 'set hklm\\software\\test a', 'set hklm\\software\\test\\sub b'].sort());
  assert.equal(W.regDump().find(([p]) => p === 'hklm\\software\\test\\sub')[2], 'Sub', 'the key\'s name as created');
}
console.log('braid: ok');
