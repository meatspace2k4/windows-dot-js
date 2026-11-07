// the bundle's 16-bit modules for a disk (ne16.js neBundle): Windows 98's builds only where a file of Windows 98's own
// is on it. A file both have (TSENG.DRV, the same bytes) says nothing: a fresh Windows 95 disk matching Windows 98's
// DISPLAY build lost Windows 95's GDI build, and GDI.EXE mapped from its file faulted in its LibEntry
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
const i = src.indexOf('P.neBundle = function'), j = src.indexOf('\n};\n', i);
assert.ok(i >= 0 && j > i);
const run = (files, w95, w98) => {
  const P = {};
  globalThis.window = { W95SYSTEM: { ne: w95 }, W95SYSTEM98: { ne: w98 }, W95Win32: { sha256: f => f } };
  globalThis.self = {};
  new Function('P', src.slice(i, j + 3))(P);
  const m = { fs: { readFile: p => files[p] }, findFile16: n => (files['C:\\WINDOWS\\SYSTEM\\' + n] !== undefined ? 'C:\\WINDOWS\\SYSTEM\\' + n : null) };
  return P.neBundle.call(m);
};
const mod = (fileName, sha) => ({ fileName, meta: { sha256: sha } });
const w95 = () => ({ GDI: mod('GDI.EXE', 'gdi95'), DISPLAY: mod('TSENG.DRV', 'tseng'), USER: mod('USER.EXE', 'user95') });
const w98 = () => ({ GDI: mod('GDI.EXE', 'gdi98'), DISPLAY: mod('TSENG.DRV', 'tseng'), USER: mod('USER.EXE', 'user98') });
const sys = o => Object.fromEntries(Object.entries(o).map(([k, v]) => ['C:\\WINDOWS\\SYSTEM\\' + k, v]));

// Windows 95's files: its own builds, every one, though Windows 98's DISPLAY build is of the same TSENG.DRV
{
  const a = w95(), b = w98(), r = run(sys({ 'GDI.EXE': 'gdi95', 'TSENG.DRV': 'tseng', 'USER.EXE': 'user95' }), a, b);
  assert.equal(r.GDI, a.GDI); assert.equal(r.USER, a.USER); assert.equal(r.DISPLAY, a.DISPLAY);
  assert.ok(!b.DISPLAY.w98, 'not marked Windows 98\'s');
}
// Windows 98's files: its builds, TSENG.DRV's too (linked to Windows 98's DIB engine)
{
  const a = w95(), b = w98(), r = run(sys({ 'GDI.EXE': 'gdi98', 'TSENG.DRV': 'tseng', 'USER.EXE': 'user98' }), a, b);
  assert.equal(r.GDI, b.GDI); assert.equal(r.USER, b.USER); assert.equal(r.DISPLAY, b.DISPLAY);
  assert.ok(b.GDI.w98 && b.DISPLAY.w98);
}
// Windows 98's GDI with another USER.EXE: neither build's USER (mapped from its file)
{
  const a = w95(), b = w98(), r = run(sys({ 'GDI.EXE': 'gdi98', 'TSENG.DRV': 'tseng', 'USER.EXE': 'other' }), a, b);
  assert.equal(r.GDI, b.GDI); assert.equal(r.USER, undefined);
}
console.log('nebundle98: ok');
