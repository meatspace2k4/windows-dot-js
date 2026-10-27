// Every function the installed Win32 programs and DLLs (msdos.js: the Windows folder's programs, the Typical
// components, their DLLs) import from the DLLs this system implements itself, KERNEL32 and ADVAPI32, is implemented.
// One that is not is a dead import: the call faults where Windows would have run it (HyperTerminal's AddAtomA). This
// is checked before any of them is run. msdos.js is generated (tools/build_dos.py); without it there is nothing to check
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
// (the scripts the worker loads that implement functions, in its order: worker.js importScripts)
for (const f of ['fs.js', 'win32.js', 'gl.js', 'shell32.js', 'ne16.js', 'vmm.js', 'sound.js', 'lan.js', 'parallel.js', 'netfs.js', 'dyn.js']) {
  try { new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))(); } catch (e) { throw new Error(`${f}: ${e.message}`); }
}
const { API } = window.W95Win32;
const PERSONALITY = ['KERNEL32', 'ADVAPI32'];   // (the system's machine's own: the rest, USER32, GDI32, SHELL32, ..., are Windows' modules)

const dos = new URL('../msdos.js', import.meta.url);
if (!existsSync(dos)) { console.log('imports: skipped, no msdos.js (python3 tools/build_dos.py msdos.js <CD files>)'); process.exit(0); }
new Function(readFileSync(dos, 'utf8'))();
const D = window.W95DOS, images = [];
for (const [n, d] of Object.entries({ ...D.windows, ...D.system })) images.push([n, d]);
for (const c of D.components || []) for (const [p, d] of c.files) images.push([p, d]);
for (const [p, d] of D.deps || []) images.push([p, d]);

/** a PE image's imports: [dll, name or #ordinal] */
function imports(b) {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), e = dv.getUint32(0x3c, true);
  if (e + 0xf8 > b.length || dv.getUint32(e, true) !== 0x4550) return [];
  const nsec = dv.getUint16(e + 6, true), opt = e + 24, sh = opt + dv.getUint16(e + 20, true);
  const secs = [...Array(nsec)].map((_, i) => [dv.getUint32(sh + 40 * i + 12, true), Math.max(dv.getUint32(sh + 40 * i + 8, true), dv.getUint32(sh + 40 * i + 16, true)), dv.getUint32(sh + 40 * i + 20, true)]);
  const off = r => { for (const [va, vs, ro] of secs) if (r >= va && r < va + vs) return r - va + ro; return null; };
  const str = o => { let s = ''; while (o < b.length && b[o]) s += String.fromCharCode(b[o++]); return s; };
  const out = [];
  for (let d = off(dv.getUint32(opt + 104, true)); d !== null && d + 20 <= b.length && dv.getUint32(d + 12, true); d += 20) {
    const dll = str(off(dv.getUint32(d + 12, true))).toUpperCase().replace(/\.DLL$/, '');
    for (let t = off(dv.getUint32(d, true) || dv.getUint32(d + 16, true)); t !== null && dv.getUint32(t, true); t += 4) {
      const v = dv.getUint32(t, true); out.push([dll, v & 0x80000000 ? '#' + (v & 0xffff) : str(off(v) + 2)]);
    }
  }
  return out;
}
/** a Windows 3.x image's imports from KERNEL (KRNL386, implemented here, ne16.js): [KERNEL, #ordinal or name] */
const { K16, names16 } = window.W95NE16;
function imports16(b) {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), e = dv.getUint32(0x3c, true);
  if (e + 0x40 > b.length || b[e] !== 0x4e || b[e + 1] !== 0x45) return [];
  const h = o => dv.getUint16(e + o, true), shift = h(0x32) || 9, out = [];
  const name = o => { const n = b[o]; let s = ''; for (let i = 1; i <= n; i++) s += String.fromCharCode(b[o + i]); return s; };
  const mods = [...Array(h(0x1e))].map((_, i) => name(e + h(0x2a) + dv.getUint16(e + h(0x28) + 2 * i, true)).toUpperCase());
  for (let i = 0; i < h(0x1c); i++) {
    const s = e + h(0x22) + 8 * i, off = dv.getUint16(s, true) << shift, len = dv.getUint16(s + 2, true) || (off ? 0x10000 : 0), fl = dv.getUint16(s + 4, true);
    if (!(fl & 0x100) || !off) continue;
    const r = off + len, n = dv.getUint16(r, true);
    for (let k = 0; k < n; k++) {
      const t = r + 2 + 8 * k, typ = b[t + 1] & 3, mi = dv.getUint16(t + 4, true), x = dv.getUint16(t + 6, true);
      if ((typ === 1 || typ === 2) && mods[mi - 1] === 'KERNEL') out.push(['KERNEL', typ === 1 ? '#' + x : name(e + h(0x2a) + x).toUpperCase()]);
    }
  }
  return out;
}
// (KERNEL's names, KRNL386's own name tables, come with the system bundle: system.js's names16, read from it; its
// constants, __AHSHIFT and the rest, the loader puts in place: KERNEL_EQUATES)
const { KERNEL_EQUATES } = window.W95NE16;
const sysjs = readFileSync(new URL('../system.js', import.meta.url), 'latin1'), at = sysjs.indexOf('"names16":');
let kn = {}; if (at >= 0) { let i = sysjs.indexOf('{', at), d = 0, j = i; for (; j < sysjs.length; j++) { if (sysjs[j] === '{') d++; else if (sysjs[j] === '}' && !--d) break; } kn = JSON.parse(sysjs.slice(i, j + 1)).KERNEL || {}; }
const kernel16 = fn => { const o = fn[0] === '#' ? +fn.slice(1) : kn[fn]; return o !== undefined && (K16[`KERNEL.#${o}`] || KERNEL_EQUATES[o] !== undefined); };
const dead = new Map(), add = (f, n) => (dead.get(f) || dead.set(f, []).get(f)).push(n.replace(/^.*\\/, ''));
for (const [n, d] of images) {
  const b = Uint8Array.from(atob(d), c => c.charCodeAt(0));
  for (const [dll, fn] of imports(b)) if (PERSONALITY.includes(dll) && !(API[dll] && API[dll][fn])) add(`${dll}!${fn}`, n);
  for (const [dll, fn] of imports16(b)) if (!kernel16(fn)) add(`${dll}.${fn}`, n);
}
assert.deepEqual([...dead].map(([f, who]) => `${f} (${[...new Set(who)].join(', ')})`), [], 'imports nothing implements');
console.log(`imports: ok, ${images.length} images`);
