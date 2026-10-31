// the diagnostics (win32.js, cmd 'watch', 'memwatch', 'faults'): an address named as module, export and offset for a
// 32-bit and a 16-bit module (whereOf); entry hooks chained at one address beside a hook already there; a call's
// return found by thread and stack depth when the same return address is pending for nested and concurrent calls
// (onReturn); and a write watch that names the first write into a range and what ran last (memCheck)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype, L = W.LAYOUT;
const mem = new Uint8Array(0x30000), dv = new DataView(mem.buffer), reg = v => ({ value: v });
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, {
  cpu: { ss: reg(0), ssb: reg(0), esp: reg(0x20000), eax: reg(0), edx: reg(0), cs: reg(0) },
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  reg(n, v) { if (v === undefined) return this.cpu[n].value; this.cpu[n].value = v; },
  selBase: sel => (sel === 0x1f7 ? 0x10000 : 0), selValid: sel => sel === 0x1f7, selLimit: () => 0xffff,
  thread16: null, now: () => 0, thunks: [{ dll: 'KERNEL32', nm: 'GetTickCount' }], th16: [],
  modules: [{ name: 'OLE32', base: 0x8000, size: 0x1000, exports: new Map([['CoInitialize', 0x8100], ['CoUninitialize', 0x8200], ['#5', 'fwd']]) }],
  ne: new Map([['USER', { name: 'USER', segs: [{ num: 1, sel: 0x1f7, base: 0, len: 0x100 }], exports: new Map([[47, (0x1f7 << 16) | 0x20], [48, (0x1f7 << 16) | 0x80]]), names: { ISWINDOW: 47, GETPARENT: 48 } }]]),
});

// symbols: the export at or before the address, in a 32-bit module and a 16-bit one, and a thunk's import
assert.equal(p.whereOf(0x8100), 'OLE32+100 (CoInitialize)');
assert.equal(p.whereOf(0x8234), 'OLE32+234 (CoUninitialize+34)');
assert.equal(p.whereOf(0x8010), 'OLE32+10');
assert.equal(p.whereOf(0x10020), 'USER 1:20 (ISWINDOW)');
assert.equal(p.whereOf(0x10090), 'USER 1:90 (GETPARENT+10)');
assert.equal(p.whereOf(L.THUNK), 'KERNEL32!GetTickCount');
assert.equal(p.whereOf(0x7000), '7000');

// entry hooks chained: the hook there before (a clock's) still answers, the added ones see the entry first
const seen = [];
p.entryHooks = new Map([[0x8100, function () { seen.push('was'); return 0x1234; }]]);
const off1 = p.addEntryHook(0x8100, function () { seen.push('a'); }), off2 = p.addEntryHook(0x8100, function () { seen.push('b'); });
assert.equal(p.entryHooks.get(0x8100).call(p), 0x1234); assert.deepEqual(seen, ['a', 'b', 'was']);
off1(); off2();
assert.equal(p.entryHooks.get(0x8100).call(p), 0x1234); assert.deepEqual(seen, ['a', 'b', 'was', 'was'], 'the hook there before, restored');

// a call's return: the return address on the stack at entry, matched on the way back by thread and a shallower stack
// (an outer call and a nested one both return to the same address: each gets its own result)
const got = [];
p.cpu.esp.value = 0x20000; p.w32(0x20000, 0x8500);                 // outer: entered with the return address at esp
p.onReturn((eax) => got.push(['outer', eax]));
p.cpu.esp.value = 0x1ff00; p.w32(0x1ff00, 0x8500);                 // nested, deeper: the same return address
p.onReturn((eax) => got.push(['inner', eax]));
const retHook = p.entryHooks.get(0x8500);
p.cpu.esp.value = 0x1ff08; p.cpu.eax.value = 11; retHook.call(p);   // the inner returns first (esp back above its entry)
assert.deepEqual(got, [['inner', 11]]);
p.cpu.esp.value = 0x20008; p.cpu.eax.value = 22; retHook.call(p);
assert.deepEqual(got, [['inner', 11], ['outer', 22]]);
assert.equal(p.entryHooks.get(0x8500), undefined, 'nothing pending there: the hook is gone');
// another thread's return to that address is not this thread's
p.cpu.esp.value = 0x20000; p.onReturn(eax => got.push(['t1', eax]));
p.thread16 = { id: 2 }; p.cpu.esp.value = 0x20010; p.cpu.eax.value = 9; p.entryHooks.get(0x8500).call(p);
assert.equal(got.length, 2, 'thread 2 returning there is not thread main\'s call');
p.thread16 = null; p.entryHooks.get(0x8500).call(p); assert.deepEqual(got[2], ['t1', 9]);
// a 16-bit far call: the far return address, and the stack as SS:SP
p.cpu.ss.value = 0x1ef; p.cpu.ssb.value = 0x12000; p.cpu.esp.value = 0x100; dv.setUint16(0x12100, 0x90, true); dv.setUint16(0x12102, 0x1f7, true);
p.onReturn((eax, edx) => got.push(['far', eax & 0xffff, edx & 0xffff]));
p.cpu.esp.value = 0x108; p.cpu.eax.value = 0x1234; p.cpu.edx.value = 0x5678; p.entryHooks.get(0x10090).call(p);
assert.deepEqual(got[3], ['far', 0x1234, 0x5678]);
p.cpu.ss.value = 0; p.cpu.ssb.value = 0;

// a write watch: the first changed byte, the count, the bytes before and after, and what ran last
p.lastBlock = 0x8234;
const w = p.memWatch(0x14000, 16);
p.memCheck(); assert.equal(w.hits.length, 0);
mem[0x14004] = 0xaa; mem[0x14005] = 0xbb;
p.memCheck();
assert.equal(w.hits.length, 1); assert.deepEqual(w.hits[0], { at: '14004', n: 2, was: [0, 0], now: [0xaa, 0xbb], by: 'OLE32+234 (CoUninitialize+34)', thread: 'main', t: 0, stack: [] });
p.memCheck(); assert.equal(w.hits.length, 1, 'no change since: nothing more');
mem[0x1400f] = 1; p.memCheck('run-time code at 9000'); assert.equal(w.hits[1].by, 'run-time code at 9000'); assert.equal(w.n, 2);
p.memWatch(null); assert.equal(p.memW, null);
console.log('diag: ok');
