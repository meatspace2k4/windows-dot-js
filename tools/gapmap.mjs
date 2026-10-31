#!/usr/bin/env node
// The JavaScript half of tools/staticmap.py's static analysis, nothing run:
//
//   node tools/gapmap.mjs --standins [system.js]       what each VxD service stand-in sets (vmm.js), as JSON: called once
//                                                      on an empty machine with its registers watched; one that needs
//                                                      state the empty machine lacks is marked (probe)
//   node tools/gapmap.mjs --dyn reach.json [system.js] the block starts run-time translation cannot take (dyn.js
//                                                      dynCheck), each module's code mapped where it loads, as JSON
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...rest] = process.argv.slice(2);
const log = console.log; console.log = console.info = console.warn = console.debug = () => {};   // (the stand-ins' own lines stay out of the JSON)
globalThis.window = globalThis; globalThis.self = globalThis;
// (W95_SCRIPTS: another folder's scripts, as an older vmm.js, to see what the check would have found in them)
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'dyn.js']) new Function(readFileSync(join(process.env.W95_SCRIPTS || ROOT, f), 'utf8'))();
const P = window.W95Win32.Process.prototype, N = window.W95NE16;
const mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
const p = Object.create(P);
p.mem = mem; Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if'];
p.cpu = Object.fromEntries(REGS.map(n => [n, new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0)]));
p.trap = () => {};
const hex = v => (v >>> 0).toString(16);
const bundle = file => { const s = readFileSync(file || join(ROOT, 'system.js'), 'utf8'), at = s.indexOf('window.W95SYSTEM = ') + 19; return JSON.parse(s.slice(at, s.lastIndexOf(';'))); };

if (mode === '--standins') {
  const out = {};
  for (const [id, fn] of Object.entries(N.VXD_SVC)) {
    const writes = new Set(), real = p.cpu, base = 0x300000;
    p.cpu = Object.fromEntries(REGS.map(n => { let v = n === 'esp' ? 0x8000 : 0; return [n, { get value() { return v; }, set value(x) { writes.add(n); v = x | 0; } }]; }));
    p.u8.fill(0, base, base + 0x2000);
    let threw = null, ret;
    try { ret = fn.call(p, i => base + 0x100 * i); } catch (e) { threw = String(e && e.message || e).slice(0, 100); }
    if (ret !== undefined) writes.add('eax');
    p.cpu = real;
    // (what its source sets besides, for a stand-in the empty machine could not run to the end: cpu.<reg>.value =,
    // CF(this, ...), ZF(this, ...), a value returned)
    const s = String(fn);
    if (threw) { for (const m of s.matchAll(/cpu\.(\w+)\.value\s*=[^=]/g)) writes.add(m[1]); for (const m of s.matchAll(/\b(CF|ZF)\(this/g)) writes.add(m[1].toLowerCase()); if (/return [^;]/.test(s)) writes.add('eax'); }
    out[`${hex(id >>> 16).padStart(4, '0')}:${hex(id & 0xffff).padStart(4, '0')}`] = { sets: [...writes].sort(), ...(threw ? { probe: `threw: ${threw}` } : {}), source: s.replace(/\s+/g, ' ').slice(0, 200) };
  }
  log(JSON.stringify(out));
} else if (mode === '--dyn') {
  const reach = JSON.parse(readFileSync(rest[0], 'utf8')), S = bundle(rest[1]), b64 = s => Buffer.from(s, 'base64');
  const all = {};
  for (const g of ['vxds', 'dlls', 'programs', 'net', 'drivers', 'ne']) for (const [n, m] of Object.entries(S[g] || {})) all[n] = { g, m };
  const mapPE = (file, base) => {
    const dv = new DataView(file.buffer, file.byteOffset, file.byteLength), pe = dv.getUint32(0x3c, true), opt = pe + 24;
    const nsec = dv.getUint16(pe + 6, true), shdr = opt + dv.getUint16(pe + 20, true);
    p.u8.set(file.subarray(0, Math.min(dv.getUint32(opt + 60, true), file.length)), base);
    for (let i = 0; i < nsec; i++) {
      const o = shdr + 40 * i, vs = dv.getUint32(o + 8, true), va = dv.getUint32(o + 12, true), rs = dv.getUint32(o + 16, true), ro = dv.getUint32(o + 20, true);
      p.u8.fill(0, base + va, base + va + Math.max(vs, rs)); p.u8.set(file.subarray(ro, ro + Math.min(rs, vs || rs)), base + va);
    }
  };
  const out = {};
  for (const [name, r] of Object.entries(reach)) {
    const { g, m } = all[name] || {}; if (!m) continue;
    if (g === 'vxds') p.u8.set(b64(m.image), m.meta.base);
    else if (g === 'ne') { const f = b64(m.file); for (const s of m.meta.segs) if (s.fileoff && s.len) p.u8.set(f.subarray(s.fileoff, s.fileoff + s.len), s.base); }
    else mapPE(b64(m.file), m.meta.base);
    p.r0Depth = g === 'vxds' || g === 'drivers' ? 1 : 0;
    for (const [a, bits] of Object.entries(r.bits)) {
      const lin = parseInt(a, 16);
      let res; try { res = p.dynCheck(lin, bits === 32); } catch (e) { res = { unsupported: `translator error: ${e.message} (${(String(e.stack).split('\n')[1] || '').replace(/^.*<anonymous>:/, 'dyn.js line ').replace(/\)$/, '')})` }; }
      if (!res.unsupported) continue;
      const k = res.unsupported.replace(/ at [0-9a-f]+$/, ''), e = out[k] || (out[k] = { count: 0, modules: {}, first: [] });
      e.count++; e.modules[name] = (e.modules[name] || 0) + 1; if (e.first.length < 8) e.first.push(`${name}+${hex(lin - m.meta.base)}`);
    }
  }
  log(JSON.stringify(out));
} else { log('usage: node tools/gapmap.mjs --standins [system.js] | --dyn reach.json [system.js]  (tools/staticmap.py runs both)'); process.exit(2); }
