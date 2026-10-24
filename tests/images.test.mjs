// Every module the built system.js carries loads at an address range of its own: a 16-bit module's segments, a 32-bit
// image's SizeOfImage from its header, a VxD's image. Two that overlap overwrite each other once both are loaded, and
// the dispatcher runs the first one's code for the other's: 1ead0e6 put MCIAVI and MSVIDEO inside SHELL32.DLL, and
// Media Player, which opens every MCI device as it starts, hung or faulted. (build_system.py makes the same check as
// it writes system.js; this one holds the system.js the page serves to it.)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const peSize = file => { const d = Buffer.from(file, 'base64'), pe = d.readUInt32LE(0x3c); return d.readUInt32LE(pe + 24 + 56); };
function overlaps(S) {
  const images = [];
  for (const [name, m] of Object.entries(S.ne || {})) for (const g of m.meta.segs) images.push([g.base, g.base + (g.len || 0), `${name} seg${g.num}`]);
  for (const group of ['dlls', 'programs', 'net', 'drivers']) for (const [name, m] of Object.entries(S[group] || {})) {
    if (!m.meta || m.meta.base === undefined) continue;
    const n = m.meta.size || (m.file ? peSize(m.file) : 0); if (n) images.push([m.meta.base, m.meta.base + n, name]);
  }
  for (const [name, m] of Object.entries(S.vxds || {})) if (m.meta && m.meta.size) images.push([m.meta.base, m.meta.base + m.meta.size, name]);
  images.sort((a, b) => a[0] - b[0]);
  const out = []; let held = null;   // (the image reaching furthest so far: one large image can hold several after it)
  for (const im of images) {
    if (held && im[0] < held[1]) out.push(`${held[2]} ${held[0].toString(16)}-${held[1].toString(16)} holds ${im[2]} at ${im[0].toString(16)}`);
    if (!held || im[1] > held[1]) held = im;
  }
  return out;
}

test('an image inside another is found (SHELL32.DLL and MCIAVI as 1ead0e6 placed them)', () => {
  const mz = Buffer.alloc(0x200); mz.writeUInt32LE(0x80, 0x3c); mz.writeUInt32LE(0xcb000, 0x80 + 24 + 56);
  const S = { dlls: { 'SHELL32.DLL': { file: mz.toString('base64'), meta: { base: 0x01600000 } } },
    ne: { MCIAVI: { meta: { segs: [{ num: 1, base: 0x01610000, len: 0xac86 }] } } } };
  assert.deepEqual(overlaps(S), ['SHELL32.DLL 1600000-16cb000 holds MCIAVI seg1 at 1610000']);
});

const built = new URL('../system.js', import.meta.url);
test('the built system.js has no two images at one address', { skip: !existsSync(built) && 'no system.js built' }, () => {
  globalThis.window = globalThis;
  new Function(readFileSync(built, 'utf8'))();
  assert.deepEqual(overlaps(window.W95SYSTEM), []);
});
