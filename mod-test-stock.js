// (a test: GDI32's stock-object table as GetStockObject reads it ([GDI32+1f2bc], 18 handles) and the global GDI.EXE's
// LibEntry faulted on ([GDI32+1f8fe]), into C:\STOCK.TXT)
(() => {
  const p = machine.proc, g = p.modules.find(m => /^GDI32/i.test(m.name)), L = [];
  if (!g) L.push('no GDI32'); else {
    const t = p.r32(g.base + 0x1f2bc) >>> 0; L.push(`GDI32 at ${g.base.toString(16)} table ${t.toString(16)} [1f8fe] ${(p.r32(g.base + 0x1f8fe) >>> 0).toString(16)}`);
    if (t) { const h = []; for (let i = 0; i < 18; i++) h.push(p.r16(t + 2 * i).toString(16)); L.push(h.join(' ')); }
  }
  self.W95Stock = L; p.fs.writeFile('C:\\STOCK.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
