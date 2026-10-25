// A global block GlobalReAlloc moves takes every selector onto it along: an alias left at the old base split DIBENG's
// blit stack in two (the line count written through one selector, read as 0 through SS), and WELCOME's blit loop ran on
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

const LDT = 0x30000, dv = new DataView(new ArrayBuffer(0x50000));
const p = Object.create(P);
p.cpu = Object.fromEntries(['cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fs', 'gsb', 'eip'].map(n => [n, { value: 0 }]));
Object.assign(p, {
  selUsed: new Uint8Array(8192), ghandles: new Map([[0x129f, { lin: 0x500000, size: 0x50, n: 1 }]]),
  r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  gsel: h => h | 1, gblock(h) { return this.ghandles.get(h & 0xffff); },
});
const desc = (sel, base) => { p.selUsed[sel >> 3] = 1; p.w32(LDT + (sel & 0xfff8), base); };
desc(0x129f, 0x500000);   // the block
desc(0x2a17, 0x500000);   // an alias onto it (AllocCStoDSAlias)
desc(0x2a1f, 0x500040);   // one onto its middle
desc(0x2a27, 0x700000);   // a selector elsewhere
p.moveAliases(0x500000, 0x50, 0x900000);
assert.equal(p.selBase(0x2a17), 0x900000);
assert.equal(p.selBase(0x2a1f), 0x900040);
assert.equal(p.selBase(0x2a27), 0x700000);
// a thread stopped with SS on the alias at the old base goes on with the alias where the block is now
p.w32(LDT + 0x1298, 0x900000);
p.loadFull = function (c) { for (const [k, v] of Object.entries(c)) this.cpu[k].value = v; };
p.loadCtx16({ ss: 0x2a17, ssb: 0x500000, ds: 0x2a27, dsb: 0x123000 });
assert.equal(p.cpu.ssb.value, 0x900000);
assert.equal(p.cpu.dsb.value, 0x123000);   // a stack alias another call redefined: as saved
console.log('aliasmove: ok');
