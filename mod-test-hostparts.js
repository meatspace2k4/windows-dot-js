// (a test: the host's own time inside the threads' run: each 16-bit stand-in (K16), each INT handler (INTS), each Win32
// stand-in (API), and the machine's time switching threads (switchMs), since this mod first loaded; loaded again it reports.
// A stand-in that runs guest code inside it (a callback) counts that guest time as its own)
(() => {
  const m = typeof machine !== 'undefined' && machine, p = m && m.proc; if (!p) return;
  const S = self.__host || (self.__host = { t0: performance.now(), by: {}, total: 0, sw0: null });
  let depth = 0;
  const timed = (label, f) => { const w = function () { if (depth++) { try { return f.apply(this, arguments); } finally { depth--; } } const s = performance.now(); try { return f.apply(this, arguments); } finally { depth--; const d = performance.now() - s, r = S.by[label] || (S.by[label] = { n: 0, ms: 0 }); r.n++; r.ms += d; S.total += d; } }; w.__host = true; return w; };
  if (!S.wrapped) {
    const N = self.W95NE16;
    for (const k of Object.keys(N.K16)) { const d = N.K16[k]; if (Array.isArray(d) && typeof d[2] === 'function' && !d[2].__host) d[2] = timed('16 ' + k, d[2]); }
    for (const k of Object.keys(N.INTS)) { const f = N.INTS[k]; if (typeof f === 'function' && !f.__host) N.INTS[k] = timed('int ' + (+k).toString(16), f); }
    const API = self.W95Win32 && self.W95Win32.API;
    if (API) for (const dll of Object.keys(API)) for (const nm of Object.keys(API[dll])) { const d = API[dll][nm]; if (Array.isArray(d) && typeof d[1] === 'function' && !d[1].__host) d[1] = timed('32 ' + dll + '!' + nm, d[1]); }
    S.sw0 = { ...(m.switchMs || p.switchMs || {}) };
    S.wrapped = true;
  }
  const sw = m.switchMs || p.switchMs || {}, d = k => Math.round((sw[k] || 0) - ((S.sw0 && S.sw0[k]) || 0));
  console.warn('[host] ' + JSON.stringify({ wallMs: Math.round(performance.now() - S.t0), hostMs: Math.round(S.total), threadRun: d('run'), switches: d('n'), switchCost: d('img') + d('load') + d('save'),
    top: Object.entries(S.by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 18).map(([k, v]) => `${k} ${Math.round(v.ms)}ms n${v.n}`) }));
})();
