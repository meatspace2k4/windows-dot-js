// (a test: USER's GetDC(0) and GetDC of each top-level window as the system's context, released at once, into the
// console: whether USER still hands out a DC (its cache of five common DCs all taken: GetDC answers 0, and WinHelp's
// index reports "(null) (2)", out of memory))
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p || !p.user16) return;
  const u = (o, a) => { const r = p.user16(o, a); return r && typeof r === 'object' ? (r.ax !== undefined ? r.ax : r.dxax) & 0xffff : r & 0xffff; };
  const out = [];
  const d0 = u(66, [['w', 0]]); out.push(`GetDC(0)=${d0.toString(16)}`); if (d0) u(68, [['w', 0], ['w', d0]]);
  const got = []; for (let i = 0; i < 8; i++) { const d = u(66, [['w', 0]]); got.push(d.toString(16)); if (!d) break; }
  out.push('held ' + got.join(','));
  for (const d of got) { const h = parseInt(d, 16); if (h) u(68, [['w', 0], ['w', h]]); }
  console.warn('[getdc] ' + out.join(' | '));
})();
