// (a test: where a machine step's wall time goes, by part (the processor's slice, the 16-bit timers, the system's pump,
// the threads, the sound card, the network, the MS-DOS VMs, the frame sent to the page, the input poll), since this mod
// first loaded, against the steps' total; loaded again it reports)
(() => {
  const m = typeof machine !== 'undefined' && machine, p = m && m.proc; if (!p) return;
  const S = self.__parts || (self.__parts = { t0: performance.now(), by: {}, step: 0, n: 0 });
  const wrap = (o, k, label) => { const f = o[k]; if (typeof f !== 'function' || f.__parts) return; const w = function () { const s = performance.now(); try { return f.apply(this, arguments); } finally { const r = S.by[label] || (S.by[label] = { n: 0, ms: 0 }); r.n++; r.ms += performance.now() - s; } }; w.__parts = true; o[k] = w; };
  if (!S.wrapped) {
    for (const k of ['slice', 'timers16', 'systemPump', 'appy16', 'threads16', 'sound16', 'lanPoll', 'vmsRun', 'vxdRunTimeOuts']) wrap(p, k, 'proc.' + k);
    for (const k of ['frame', 'poll', 'feedMouse', 'feedKeys', 'postScan', 'sendText']) wrap(m, k, 'machine.' + k);
    const st = m.step; m.step = function () { const s = performance.now(); try { return st.apply(this, arguments); } finally { S.step += performance.now() - s; S.n++; } };
    S.wrapped = true;
  }
  // (the threads' own run inside threads16 and the dyn.js run inside slice, for the guest's share)
  const g = p.stats || {};
  console.warn('[parts] ' + JSON.stringify({ wallMs: Math.round(performance.now() - S.t0), stepMs: Math.round(S.step), steps: S.n,
    parts: Object.entries(S.by).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} ${Math.round(v.ms)}ms n${v.n}`) }));
})();
