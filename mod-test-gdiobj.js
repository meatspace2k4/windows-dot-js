// (a test: where GDI32's stock-object table ([GDI32+1f2bc]) lies against GDI.EXE's data segment: the table's bytes
// searched for in the segment, and the handles it holds checked as ISGDIOBJECT checks them, into C:\GDIOBJ.TXT)
(() => {
  const p = machine.proc, L = [], hex = v => (v >>> 0).toString(16);
  const g = [...p.ne.values()].find(m => m.name === 'GDI'), g32 = p.modules.find(m => /^GDI32/i.test(m.name));
  const sel = g.dgroup, base = p.selBase(sel), lim = p.selLimit(sel), t = p.r32(g32.base + 0x1f2bc) >>> 0;
  L.push(`GDI DS ${hex(sel)} base ${hex(base)} limit ${hex(lim)}; GDI32 table at ${hex(t)} (DS ${t >= base && t <= base + lim ? '+' + hex(t - base) : 'outside'})`);
  for (const off of [0x1f2b0, 0x1f2b4, 0x1f2b8, 0x1f2bc, 0x1f2c0, 0x1f2cc, 0x1f2d4, 0x1f8fe, 0x1f902]) { const v = p.r32(g32.base + off) >>> 0; L.push(`GDI32+${hex(off)} = ${hex(v)} ${v >= base && v <= base + lim ? 'DS+' + hex(v - base) : ''}`); }
  const pat = [...p.u8.subarray(t, t + 16)];
  L.push(`table bytes: ${pat.map(hex).join(' ')}`);
  for (let o = 0; o + 16 <= lim; o++) { let k = 0; while (k < 16 && p.u8[base + o + k] === pat[k]) k++; if (k === 16) L.push(`found in DS at +${hex(o)} (old base would be ${hex(t - o)})`); }
  self.W95GdiObj = L; p.fs.writeFile('C:\\GDIOBJ.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
