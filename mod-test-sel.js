// (a test: the selectors self.W95SelQ names (base, limit, valid), the function at self.W95WhereQ ([sel, off] pairs) and the
// running threads' stack selectors and flat stacks, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  const sels = (self.W95SelQ || [0x421f, 0x422f, 0x4237]).map(s => { let base = null, lim = null, ok = false; try { ok = !!p.selValid(s); base = p.selBase(s); lim = p.selLimit ? p.selLimit(s) : null; } catch (e) { base = 'err ' + e.message; } return { sel: s.toString(16), ok, base: base === null ? null : (typeof base === 'number' ? (base >>> 0).toString(16) : base), lim: lim === null ? null : (lim >>> 0).toString(16) }; });
  const where = (self.W95WhereQ || []).map(([s, o]) => { try { return s.toString(16) + ':' + o.toString(16) + ' ' + (p.whereOf16 ? p.whereOf16(s, o) : p.whereOf(p.selBase(s) + o)); } catch (e) { return 'err ' + e.message; } });
  const th = [...(p.threadsById || new Map()).values()].filter(t => t.pc && /winhlp|rundll|ddhelp/i.test(t.pc.path || '')).map(t => ({ id: t.id, path: t.pc.path, ssel: t.ssel && t.ssel.toString(16), stackBase: t.stackBase && t.stackBase.toString(16), stackSize: t.stackSize, state: t.state }));
  console.warn('[sel] ' + JSON.stringify({ sels, where, th }));
})();
