// (a test: the wall time the worker spends inside its machine's steps, and how many steps, against the wall time since
// this mod first loaded; the gaps between steps are the worker idle (timers) or busy with messages; loaded again it reports)
(() => {
  const m = typeof machine !== 'undefined' && machine; if (!m) return;
  const S = self.__stepT || (self.__stepT = { t0: performance.now(), ms: 0, n: 0, long: 0, gaps: 0, last: 0, msgs: 0, msgMs: 0 });
  if (!S.wrapped) {
    const o = m.step;
    m.step = function () { const s = performance.now(); if (S.last) S.gaps += s - S.last; try { return o.apply(this, arguments); } finally { const e = performance.now(), d = e - s; S.ms += d; S.n++; if (d > 50) S.long++; S.last = e; } };
    const om = self.onmessage;
    if (typeof om === 'function') self.onmessage = function (e) { const s = performance.now(); try { return om.apply(this, arguments); } finally { S.msgs++; S.msgMs += performance.now() - s; } };
    S.wrapped = true;
  }
  const wall = performance.now() - S.t0;
  console.warn('[stept] ' + JSON.stringify({ wallMs: Math.round(wall), stepMs: Math.round(S.ms), steps: S.n, longSteps: S.long, gapMs: Math.round(S.gaps), msgs: S.msgs, msgMs: Math.round(S.msgMs), fast: m.fast, scale: m.vclock && m.vclock.scale }));
})();
