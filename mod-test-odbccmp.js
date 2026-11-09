// (a test: at ODBCCP32's version comparison (its +13C2, after the second VerQueryValueA), the two fixed-file-info
// pointers ([EBP-0Ch], [EBP-8]) and what they read, into the console; hooked as ODBCCP32 loads)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p || p.__odbcCmp) return; p.__odbcCmp = true;
  const hook = m => p.addEntryHook(m.base + 0x13c2, function () {
    const ebp = u => this.r32((this.cpu.ebp.value >>> 0) + u), a = ebp(-0xc), b = ebp(-8), v = x => x && x < this.u8.length ? [this.r32(x), this.r32(x + 8), this.r32(x + 12)].map(n => n.toString(16)) : null;
    console.warn(`[odbccmp] eax ${(this.cpu.eax.value >>> 0).toString(16)} p1 ${a.toString(16)} ${v(a)} p2 ${b.toString(16)} ${v(b)} buf1 ${ebp(8).toString(16)} buf2 ${ebp(0xc).toString(16)}`);
  });
  const was = p.onModuleLoad; p.onModuleLoad = function (name, m) { if (was) was.call(this, name, m); if (name === 'ODBCCP32') hook(m); };
  const m = p.byName.get('ODBCCP32'); if (m) hook(m);
})();
