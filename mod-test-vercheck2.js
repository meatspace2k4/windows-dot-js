// (a test: VER.DLL's GetFileVersionInfoSize (#6), GetFileVersionInfo (#7) and VerQueryValue(\) (#11) for the ODBC
// files, the fixed file info's version words and the block's head, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p || !p.ne) return;
  const ver = p.ne.get('VER'); if (!ver) { console.warn('[vercheck2] VER is not loaded'); return; }
  const call = (ord, args) => { const ep = p.neExport(ver, ord); return p.call16(ep >>> 16, ep & 0xffff, args); };
  const buf = p.alloc(0x3000), sel = p.allocSels(buf, 0x3000), fp = sel << 16;
  for (const file of ['C:\\WINDOWS\\SYSTEM\\ODBCINT.DLL', 'C:\\WINDOWS\\SYSTEM\\ODBCCP32.DLL']) {
    p.u8.fill(0, buf, buf + 0x3000); p.writeA(buf, file); p.writeA(buf + 0x110, '\\');
    let out = '';
    try {
      const size = call(6, [['l', fp], ['l', fp | 0x100]]).dxax;
      const ok = call(7, [['l', fp], ['l', 0], ['l', Math.min(size, 0x2000)], ['l', fp | 0x200]]).ax;
      const head = Array.from(p.u8.slice(buf + 0x200, buf + 0x240), b => b.toString(16).padStart(2, '0')).join(' ');
      const q = call(11, [['l', fp | 0x200], ['l', fp | 0x110], ['l', fp | 0x120], ['l', fp | 0x124]]).ax;
      const ptr = p.r32(buf + 0x120), len = p.r16(buf + 0x124), lin = ptr ? p.lin(ptr) : 0;
      const ffi = lin ? [p.r32(lin), p.r32(lin + 8), p.r32(lin + 12)].map(v => v.toString(16)) : null;
      out = `size ${size.toString(16)} get ${ok} query ${q} ptr ${ptr.toString(16)} len ${len} sig/MS/LS ${ffi}\n  head ${head}`;
    } catch (e) { out = 'threw ' + e.message; }
    console.warn(`[vercheck2] ${file}: ${out}`);
  }
  p.free(buf);
})();
