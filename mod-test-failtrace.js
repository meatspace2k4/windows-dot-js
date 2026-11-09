// (a test: every KERNEL32/ADVAPI32/OLE call of the JS that leaves ERROR_FILE_NOT_FOUND or ERROR_PATH_NOT_FOUND (or a
// failing HRESULT 80070002/3), logged with its string arguments)
(() => {
  const W = self.W95Win32, API = W && W.API; if (!API || API.__failTraced3) return; API.__failTraced3 = true;
  W.Process.prototype.__failOn = true;
  const only = /winhlp/i;   // (the program under test)
  const strOf =(p, v) => { if (!(v >>> 16)) return null; try { const s = p.readA(v, 200); return s && /^[\x20-\x7e]{2,}$/.test(s) ? s : null; } catch (_) { return null; } };
  for (const dll of Object.keys(API)) for (const nm of Object.keys(API[dll])) {
    const d = API[dll][nm]; if (!Array.isArray(d) || typeof d[1] !== 'function' || d[0] === 'regs') continue; const f = d[1];
    d[1] = function (...a) {
      const before = this.lastError, r = f.apply(this, a);
      if (typeof r !== 'number' && r !== undefined) return r;   // (YIELD, a symbol: the call goes on later)
      if (this.__failOn && only.test((this.thread16 && this.thread16.pc && this.thread16.pc.path) || '') && ((this.lastError === 2 || this.lastError === 3) && before !== this.lastError || (r >>> 0) === 0x80070002 || (r >>> 0) === 0x80070003 || (dll === 'ADVAPI32' && /^Reg/.test(nm) && (r === 2 || r === 3))))
        console.warn(`[failtrace] ${dll}!${nm}(${a.map(v => { const s = strOf(this, v); return s !== null ? JSON.stringify(s) : (v >>> 0).toString(16); }).join(', ')}) = ${(r >>> 0).toString(16)} lastError ${this.lastError} (${this.thread16 && this.thread16.pc ? this.thread16.pc.path : '?'})`);
      return r;
    };
  }
})();
