// A stopped thread goes on with a global block's segment at the block's base as it is now: GlobalReAlloc moved the
// block while the thread was stopped with SS on it (DIBENG's blit stack segment), and the thread ran on in memory the
// block had left. A per-call stack alias keeps the base it was saved with
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

const p = Object.create(P), bases = new Map([[0x129f, 0x4901e4], [0x50, 0x777000]]);
p.cpu = Object.fromEntries(['cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fs', 'gsb', 'eip'].map(n => [n, { value: 0 }]));
Object.assign(p, {
  ghandles: new Map([[0x129f, { lin: 0x4901e4, size: 0x50, n: 1 }], [0x2007, { lin: 0x5c0000, size: 0x2000, n: 1 }]]),
  gsel: h => h | 1, gblock(h) { return this.ghandles.get(h & 0xffff); }, selBase: s => bases.get(s & 0xffff) || 0,
  loadFull(c) { for (const [k, v] of Object.entries(c)) this.cpu[k].value = v; },
});
// stopped with SS on the block at its old base 300000h, DS on a stack alias whose saved base is its own
p.loadCtx16({ ss: 0x129f, ssb: 0x300000, ds: 0x50, dsb: 0x123000 });
assert.equal(p.cpu.ssb.value, 0x4901e4);   // the block's base now
assert.equal(p.cpu.dsb.value, 0x123000);   // not a global block: as saved
// stopped in code in a block (DIBENG's blit buffer) that grew and moved: the same offset in the block where it is now
bases.set(0x2007, 0x5c0000);
p.loadCtx16({ cs: 0x2007, csb: 0x1b00000, eip: 0x1b0017c, ss: 0, ssb: 0 });
assert.equal(p.cpu.csb.value, 0x5c0000);
assert.equal(p.cpu.eip.value, 0x5c017c);
console.log('rebase: ok');
