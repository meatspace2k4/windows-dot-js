// (a test: VER.DLL's GetFileVersionInfoSize (#6) asked for the ODBC files and a control, with the 16-bit KERNEL and
// LZEXPAND calls it makes meanwhile and their answers, into self.W95VerCheck and the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc, N = self.W95NE16, K16 = N && N.K16;
  if (!p || !K16 || !p.ne) return;
  const ver = p.ne.get('VER'); if (!ver) { console.warn('[vercheck] VER is not loaded'); return; }
  const log = [], on = { v: false };
  if (!K16.__verWrapped) {
    K16.__verWrapped = true;
    for (const k of Object.keys(K16)) {
      if (!/^(KERNEL|LZEXPAND)\.#/.test(k)) continue;
      const d = K16[k]; if (!Array.isArray(d) || typeof d[2] !== 'function') continue; const f = d[2];
      d[2] = function (...a) { const r = f.apply(this, a); if (self.W95VerCheckOn) self.W95VerCheckLog.push(`${k}(${a.map(v => typeof v === 'number' ? (v >>> 0).toString(16) : String(v)).join(', ')}) = ${typeof r === 'number' ? (r >>> 0).toString(16) : String(r)}`); return r; };
    }
  }
  const buf = p.alloc(0x200), sel = p.allocSels(buf, 0x200), out = {};
  for (const file of ['C:\\WINDOWS\\SYSTEM\\ODBCINT.DLL', 'C:\\WINDOWS\\SYSTEM\\ODBCCP32.DLL', 'C:\\WINDOWS\\SYSTEM\\VERSION.DLL']) {
    p.writeA(buf, file); p.w32(buf + 0x100, 0);
    self.W95VerCheckLog = []; self.W95VerCheckOn = true;
    let r; try { const ep = p.neExport(ver, 6); r = p.call16(ep >>> 16, ep & 0xffff, [['l', sel << 16], ['l', (sel << 16) | 0x100]]).dxax; } catch (e) { r = 'threw ' + e.message; }
    self.W95VerCheckOn = false;
    out[file] = { size: typeof r === 'number' ? r.toString(16) : r, calls: self.W95VerCheckLog.slice(0, 60) };
    console.warn(`[vercheck] ${file}: ${out[file].size}\n  ${out[file].calls.join('\n  ')}`);
  }
  self.W95VerCheck = out;
  p.free(buf);
})();
