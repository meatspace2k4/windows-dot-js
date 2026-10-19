// The system bundle's layout: every 16-bit module's LDT selectors (selbase + 8 per segment) are its own and lie below
// the dynamic ones (2007h on), no two images share an address range, and every block table (an i32 per code byte at
// its lookup base) lies apart from the others' and below the 128 MB address space. A module placed over another's
// selectors or table shows up as faults in the other module once both are loaded (PROGMAN over DESKCP16's selectors
// took GDI32 and the shell down). The check reads system.js when it is built (it is generated from the CD: skipped
// when absent), and tools/build_system.py refuses such a layout at build time
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const path = new URL('../system.js', import.meta.url);
if (!existsSync(path)) { console.log('layout: skipped (no system.js)'); process.exit(0); }
const s = readFileSync(path, 'utf8'), S = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf(';')));
const overlaps = (ranges, what) => {
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const [a0, a1, an] = ranges[i - 1], [b0, b1, bn] = ranges[i];
    assert.ok(b0 >= a1, `${what} overlap: ${an} ${a0.toString(16)}-${a1.toString(16)} and ${bn} ${b0.toString(16)}-${b1.toString(16)}`);
  }
};
const ne = Object.entries(S.ne);
overlaps(ne.map(([n, m]) => [m.meta.selbase, m.meta.selbase + 8 * m.meta.segs.length, n]), 'selectors');
for (const [n, m] of ne) assert.ok(m.meta.selbase + 8 * m.meta.segs.length <= 0x2007, `${n}'s selectors reach the dynamic ones`);
// images: a 16-bit module's segments as the file holds them (PROGMAN's code lay over MSGSRV32's DGROUP, whose top is
// its stack), 32-bit DLLs and programs whole
const images = [];
for (const [n, m] of ne) for (const g of m.meta.segs) images.push([g.base, g.base + (g.len || 0), `${n} seg${g.num}`]);
for (const g of [S.dlls, S.programs, S.net || {}, S.drivers || {}]) for (const [n, m] of Object.entries(g)) if (m.meta && 'base' in m.meta && 'size' in m.meta) images.push([m.meta.base, m.meta.base + m.meta.size, n]);
overlaps(images, 'images');
{ const a = S.ne.MSGSRV32.meta, b = S.ne.PROGMAN.meta, top = a.segs[a.segs.length - 1]; assert.ok(b.base >= top.base + Math.max(top.alloc || 0, top.len || 0) || b.base + b.size <= a.base, 'PROGMAN over MSGSRV32\'s DGROUP'); }
const tables = [];
for (const g of Object.values(S)) if (g && typeof g === 'object') for (const [n, m] of Object.entries(g)) if (m && m.meta && 'lookup' in m.meta) tables.push([m.meta.lookup, m.meta.lookup + 4 * (m.meta.textHi - m.meta.textLo), n]);
overlaps(tables, 'block tables');
for (const [a0, a1, n] of tables) assert.ok(a1 <= 0x08000000, `${n}'s block table past the address space: ${a0.toString(16)}-${a1.toString(16)}`);
// what Setup needs of the bundle: Program Manager for GRPCONV's groups, RUNONCE and GRPCONV themselves
assert.ok(S.ne.PROGMAN && S.ne.PROGMAN.fileName === 'PROGMAN.EXE');
assert.ok(S.programs['RUNONCE.EXE'] && S.programs['GRPCONV.EXE']);
assert.ok(S.dlls['LINKINFO.DLL'], 'LINKINFO.DLL: GRPCONV loads it for each Start menu item it makes');
console.log(`layout: ok (${ne.length} 16-bit modules, ${images.length} images, ${tables.length} tables)`);
