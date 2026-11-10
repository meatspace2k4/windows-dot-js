// A resource of a program whose image is not the one in place (two programs linked at 400000h, each in its process's
// view of the arena): read with its own image in place and the view put back whatever happens, the view of the process
// that had it, or the running process's where none was; given each program its own 16-bit handle (hinst16, mod16), a
// later program at a base an ended one had included; and the 32-bit FindResource of such a program a copy of its bytes
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, P = Process.prototype;

// withImage: the owner's view in for fn, then the previous one back; the running process's when no view was in place
{
  const mod = { hidden: true }, owner = { exe: mod, exitCode: null }, other = { exe: { hidden: false }, exitCode: null }, uses = [];
  const slot = { own: new Set([owner, other]), cur: other };
  const p = { procs: new Map([[1, owner], [2, other]]), arena: [slot], pc: other, arenaUse: pc => { uses.push(pc); slot.cur = pc || 0; } };
  assert.equal(P.withImage.call(p, mod, () => (assert.equal(slot.cur, owner), 7)), 7);
  assert.deepEqual(uses, [owner, other], 'the view that was in place put back');
  uses.length = 0; assert.throws(() => P.withImage.call(p, mod, () => { throw new Error('x'); }));
  assert.deepEqual(uses, [owner, other], 'put back when fn throws');
  uses.length = 0; slot.cur = null; assert.throws(() => P.withImage.call(p, mod, () => { throw new Error('x'); }));
  assert.deepEqual(uses, [owner, other], 'no view in place: the running process\'s, not the other program\'s left there');
  uses.length = 0; assert.equal(P.withImage.call(p, { hidden: false }, () => 3), 3); assert.deepEqual(uses, [], 'a module in place: nothing swapped');
}
// hinst16: a program at a base an ended one had gets a handle of its own; mod16 gives each its own module
{
  const base = 0x400000, a = { name: 'EXE', base }, b = { name: 'EXE', base };
  const mem = new Uint8Array(0x1100000), dv = new DataView(mem.buffer); let next = 0x1000, sel = 0x100;
  const p = { procs: new Map(), r32: x => dv.getUint32(x, true), r16: x => dv.getUint16(x, true), w16: (x, v) => dv.setUint16(x, v, true), u8: mem,
    alloc: n => (next += n) - n, allocSels: () => (sel += 8), moduleFor: () => a };
  const ha = P.hinst16.call(p, base, a); p.procs.set(1, { exe: a, exitCode: 0 });
  const hb = P.hinst16.call(p, base, b);
  assert.notEqual(ha, hb, 'its own handle, the ended program\'s left to it');
  assert.equal(P.mod16.call(p, ha), a); assert.equal(P.mod16.call(p, hb), b); assert.equal(P.hinst32.call(p, hb), base);
  // (asked where no module of the process is, moduleFor's answer the running program elsewhere: a handle of no module,
  // never the one the program at that base gets)
  const explorer = { name: 'EXE', base: 0x10000 }, c = { name: 'EXE', base: 0x1000000 };
  const hx = P.hinst16.call(p, 0x1000000, explorer), hc = P.hinst16.call(p, 0x1000000, c);
  assert.notEqual(hx, hc, 'the program its own'); assert.equal(P.mod16.call(p, hc), c); assert.equal(P.mod16.call(p, hx), null);
}
// FindResource (KERNEL.60) with a handle of no module, as a moment taken before kept one (Explorer's for MSTASK's
// 1000000h): the program at that base whose resource it is, its own handle from then on; never Explorer's
{
  const { K16 } = window.W95NE16, find = K16['KERNEL.#60'][2];
  const explorer = { name: 'EXE', base: 0x400000 }, ddhelp = { name: 'EXE', base: 0x1000000 }, mstask = { name: 'EXE', base: 0x1000000 };
  const mem = new Uint8Array(0x1000); let next = 0x800;
  const p = { u8: mem, procs: new Map([[1, { exe: ddhelp, exitCode: null }], [2, { exe: mstask, exitCode: null }], [3, { exe: explorer, exitCode: null }]]),
    mod16of: new Map(), hinst32: h => (h === 0x1237 ? 0x1000000 : 0), mod16: P.mod16, moduleFor: () => explorer, readA: x => x, resName: x => x,
    findResource: (type, id, m) => (m === mstask && id === 403 ? { addr: 0x10, size: 4 } : m === explorer && id === 403 ? { addr: 0x20, size: 4 } : null), resKey: x => x };
  mem.set([1, 2, 3, 4], 0x10); mem.set([9, 9, 9, 9], 0x20);
  p.resHandles = []; p.resIx = new Map();
  const r = find.call(p, 0x1237, 403, 14);
  assert.ok(r, 'found'); assert.deepEqual([...p.resHandles[r / 4 - 1].data], [1, 2, 3, 4], 'MSTASK\'s, not Explorer\'s');
  assert.equal(P.mod16.call(p, 0x1237), mstask, 'the handle MSTASK\'s from then on');
}
// FindResourceA of a program whose image is put by: a copy, made while its image was in place, kept for the next ask
{
  const mod = { base: 0x400000, hidden: true }, mem = new Uint8Array(0x1000);
  let swapped = 0, next = 0x800;
  const p = { u8: mem, mod16: () => null, moduleFor: () => mod, hmod: h => h, alloc: n => (next += n) - n, newHandle: o => o,
    withImage: (m, fn) => { swapped++; mem.set([1, 2, 3], 0x10); try { return fn(); } finally { mem.set([9, 9, 9], 0x10); } },
    findResource: () => ({ addr: 0x10, size: 3 }), resName: x => x };
  const r = API.KERNEL32.FindResourceA[1].call(p, 0x400000, 5, 3);
  assert.deepEqual([...mem.subarray(r.addr, r.addr + r.size)], [1, 2, 3], 'its own bytes, not those at its base now');
  assert.equal(API.KERNEL32.FindResourceA[1].call(p, 0x400000, 5, 3).addr, r.addr); assert.equal(swapped, 1, 'kept: swapped in once');
}
// GetModuleFileNameA of the running process's own program at its base: its file, not another program's at that base
{
  const exe = { name: 'EXE', base: 0x400000 }, spool = { name: 'EXE', base: 0x400000 }, out = [];
  const p = { hmod: h => h, pc: { exe, path: 'C:\\WINDOWS\\EXPLORER.EXE' }, procs: new Map([[1, { exe: spool, path: 'C:\\WINDOWS\\SYSTEM\\SPOOL32.EXE' }]]), modules: [spool, exe],
    writeA: (b, s) => (out.push(s), s.length), standinAt: () => null };
  API.KERNEL32.GetModuleFileNameA[1].call(p, 0x400000, 0x100, 260);
  assert.deepEqual(out, ['C:\\WINDOWS\\EXPLORER.EXE']);
}
console.log('resview: ok');
