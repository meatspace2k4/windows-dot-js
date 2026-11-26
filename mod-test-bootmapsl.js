// (a test, loaded before the system's machine is made (window.W95BOOTMODS): each MapSL KERNEL32 answers while the
// machine boots, its 16:16 pointer, whether its selector is valid, its base and limit, the flat address answered and the
// caller's return address, the first 200, into the log ('[mapsl]'))
(() => { for (const nm of ['MapSL', 'MapSLFix']) {
  const API = self.W95Win32 && self.W95Win32.API, d = API && API.KERNEL32[nm]; if (!d || d[1].__probe) continue;
  const f = d[1]; let n = 0;
  d[1] = function (sp) {
    const r = f.call(this, sp);
    if (n++ < 200) {
      const sel = sp >>> 16; let ok = false, base = null, lim = null; try { ok = !!this.selValid(sel); if (ok) { base = this.selBase(sel); lim = this.selLimit ? this.selLimit(sel) : null; } } catch (_) { /* a probe */ }
      const ret = this.r32(this.reg('esp'));
      self.W95Win32.log('warn', 'mapsl', `${nm}(${(sp >>> 0).toString(16)}) = ${(r >>> 0).toString(16)}; sel ${sel.toString(16)} ${ok ? `base ${(base >>> 0).toString(16)} limit ${lim === null ? '?' : (lim >>> 0).toString(16)}` : 'not valid'}; from ${this.whereOf ? this.whereOf(ret) : ret.toString(16)}`);
    }
    return r;
  };
  d[1].__probe = true;
} })();
