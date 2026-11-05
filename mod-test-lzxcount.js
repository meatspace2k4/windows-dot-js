// (a test: whether SETUPX's LZX decoder is answered in JS (setupx-lzx.js) in this machine: frames so far, failures,
// and the wall time spent in the JS decoder since this mod first loaded, against the wall time since then)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  const T = self.__lzxT || (self.__lzxT = { t0: performance.now(), f0: p.lzxFrames || 0, ms: 0, wrapped: false });
  const wrap = h => { const w = function () { const s = performance.now(); try { return h.apply(this, arguments); } finally { T.ms += performance.now() - s; } }; w.__lzxjs = true; T.wrapped = true; return w; };
  if (!T.wrapped && p.entryHooks) for (const [at, h] of p.entryHooks) if (h && h.__lzxjs) p.entryHooks.set(at, wrap(h));
  if (!T.wrapped && p.entryLists) for (const l of p.entryLists.values()) if (l && l.fns) l.fns = l.fns.map(f => (f && f.__lzxjs && !T.wrapped ? wrap(f) : f));
  const wall = performance.now() - T.t0, fr = (p.lzxFrames || 0) - T.f0;
  console.warn('[lzx] ' + JSON.stringify({ wrapped: T.wrapped, frames: p.lzxFrames || 0, framesSince: fr, wallMs: Math.round(wall), decodeMs: Math.round(T.ms), perFrameMs: fr ? +(T.ms / fr).toFixed(2) : null, fails: p.lzxLog || [] }));
})();
