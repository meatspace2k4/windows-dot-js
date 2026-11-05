// (a test: the KERNEL32 calls VERSION.DLL reads a file's version through, logged with their answers)
(() => {
  const W = self.W95Win32, K = W && W.API && W.API.KERNEL32; if (!K || K.__verTraced) return; K.__verTraced = true;
  const str = (p, v) => { try { return v >>> 16 ? JSON.stringify(p.readA(v, 80)) : '#' + v; } catch (_) { return String(v); } };
  for (const nm of ['LoadLibraryExA', 'FindResourceA', 'LoadResource', 'SizeofResource', 'SearchPathA', 'GetShortPathNameA', 'FreeLibrary']) {
    const d = K[nm]; if (!d) continue; const f = d[1];
    d[1] = function (...a) {
      const r = f.apply(this, a);
      const args = nm === 'LoadLibraryExA' ? [str(this, a[0]), a[2]] : nm === 'FindResourceA' ? [a[0].toString(16), str(this, a[1]), str(this, a[2])] : nm === 'SearchPathA' ? [str(this, a[0]), str(this, a[1]), str(this, a[2])] : nm === 'GetShortPathNameA' ? [str(this, a[0])] : a.map(x => (x >>> 0).toString(16));
      console.warn(`[vertrace] ${nm}(${args.join(', ')}) = ${(r >>> 0).toString(16)}${nm === 'SearchPathA' || nm === 'GetShortPathNameA' ? ' ' + str(this, a[nm === 'SearchPathA' ? 4 : 1]) : ''} lastError ${this.lastError}`);
      return r;
    };
  }
})();
