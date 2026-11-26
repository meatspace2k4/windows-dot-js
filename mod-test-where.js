// (a test: what is at the addresses in self.W95Where, or the faults' (e4b312, 151d9be), into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  { const t = p.thunks && p.thunks[(0xffff021c - 0xffff0000) >> 2]; console.warn(`[where] thunk ffff021c: ${t ? t.dll + '!' + t.nm + ' def ' + !!t.def : 'none'}`); }
  for (const a of self.W95Where || [0x851a3d, 0x872e4f]) {
    const m = p.modules.find(x => x.size && a >= x.base && a < x.base + x.size);
    console.warn(`[where] ${a.toString(16)}: ${p.whereOf(a)} | module ${m ? m.name + ' ' + m.base.toString(16) + '+' + (a - m.base).toString(16) + (m.meta && m.meta.path ? ' ' + m.meta.path : '') : 'none'} | bytes ${Array.from(p.u8.slice(a - 8, a + 8), b => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
})();
