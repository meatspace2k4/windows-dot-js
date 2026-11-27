// (a test: the wall time the worker spends in its synchronous calls to the page (rpc), per method, since this mod first
// loaded, against the wall time since then; loaded again it reports)
(() => {
  const R = self.__rpcT || (self.__rpcT = { t0: performance.now(), by: {}, total: 0, n: 0 });
  if (!R.wrapped && typeof self.rpc === 'function') {
    const o = self.rpc;
    self.rpc = function (target, method) { const s = performance.now(); try { return o.apply(this, arguments); } finally { const d = performance.now() - s, k = target + '.' + method, r = R.by[k] || (R.by[k] = { n: 0, ms: 0 }); r.n++; r.ms += d; R.total += d; R.n++; } };
    R.wrapped = true;
  }
  const wall = performance.now() - R.t0;
  console.warn('[rpct] ' + JSON.stringify({ wrapped: R.wrapped, wallMs: Math.round(wall), rpcMs: Math.round(R.total), n: R.n, avg: R.n ? +(R.total / R.n).toFixed(2) : null,
    top: Object.entries(R.by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => `${k} n${v.n} ${Math.round(v.ms)}ms`) }));
})();
