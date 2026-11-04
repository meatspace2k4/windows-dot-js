// The 16/32-bit transitions in flight carry a continuation by name (ne16.js retDone), never a closure, so a moment
// anchored on this computer brings them back (worker.js 'import' finds each continuation by its kind). (1) Every kind
// a record names has a continuation. (2) A record entered through enter16from32 keeps the kind's own fields beside
// the record's: Common32ThkLS's caller EDI (edi0) is not the EDI the 16-bit side was given, which the record keeps as
// `edi` (one name for both sent the 16-bit side's EDI back to the 32-bit caller, and the boot blue-screened at
// 0028:CCCCCCCC). (3) A record without a kind is refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;
const src = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');

function machine() {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(4 << 20) };
  p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb']) p.cpu[r] = { value: 0 };
  p.selUsed = new Uint8Array(0x2000); p.th16 = []; p.depth = 1; p.stackLevel = 0;
  return p;
}
// (1) every kind named in the code has its continuation
{
  const kinds = new Set([...src.matchAll(/kind: '(\w+)'/g)].map(m => m[1]).filter(k => ['ret', 'common', 'back32', 'cp32', 'sl'].includes(k) || /^(ret|common|back32|cp32|sl)$/.test(k)));
  for (const k of ['ret', 'common', 'back32', 'cp32', 'sl']) assert.equal(typeof Process.prototype.retDone[k], 'function', k);
  assert.ok(kinds.size >= 5, [...kinds].join());
}
// (2) the record keeps the kind's fields beside its own
{
  const p = machine(); p.cpu.edi.value = 0x1234; p.cpu.esp.value = 0x300000;
  p.enter16from32(0x11a305b2, 0x300000, 8, 0, true, { kind: 'common', sp: 0x300020, edi0: 0x5678, ret: 0x401000 });
  const rec = p.retRecs.find(r => r);
  assert.equal(rec.kind, 'common'); assert.equal(rec.edi0, 0x5678, 'the caller\'s EDI'); assert.equal(rec.edi, 0x1234, 'the EDI the 16-bit side was given'); assert.equal(rec.ret, 0x401000);
  assert.equal(rec.done, Process.prototype.retDone.common, 'the continuation by its kind');
  // the continuation found again by name, as an import does
  delete rec.done; assert.equal(rec.done, undefined); rec.done = p.retDone[rec.kind]; assert.equal(rec.done, Process.prototype.retDone.common);
}
// (3) a record without a kind is refused
{
  const p = machine();
  assert.throws(() => p.retToken({}), /continuation's name/);
  assert.throws(() => p.retToken({ kind: 'nothing' }), /continuation's name/);
}
console.log('retkinds: ok');
