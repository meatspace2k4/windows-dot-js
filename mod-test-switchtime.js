// (a test: a thread switch's parts timed apart, into switchMs (cmd 'views'): imgU, dll, arena, cwd, tdb)
(() => {
  const P = self.W95Win32.Process.prototype; if (P.__switchTimed) return; P.__switchTimed = true;
  const wrap = (name, key) => { const f = P[name]; if (typeof f !== 'function') return; P[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { const s = this.switchMs; if (s) s[key] = (s[key] || 0) + performance.now() - t; } }; };
  wrap('imgUse', 'imgU'); wrap('dllUse', 'dll'); wrap('arenaUse', 'arena'); wrap('cwdSwitch', 'cwd'); wrap('tdbCurrent', 'tdb');
})();
