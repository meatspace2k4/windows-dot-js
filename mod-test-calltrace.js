// (a test: every JS-implemented call WINHLP32's threads make, with string arguments, answer and last error, into the
// console; YIELD answers passed through untouched)
(() => {
  const W = self.W95Win32, API = W && W.API; if (!API || API.__callTraced2) return; API.__callTraced2 = true;
  const only = /winhlp/i, strOf = (p, v) => { if (!(v >>> 16)) return null; try { const s = p.readA(v, 120); return s && /^[\x20-\x7e]{2,}$/.test(s) ? s : null; } catch (_) { return null; } };
  for (const dll of Object.keys(API)) for (const nm of Object.keys(API[dll])) {
    const d = API[dll][nm]; if (!Array.isArray(d) || typeof d[1] !== 'function' || d[0] === 'regs') continue; const f = d[1];
    d[1] = function (...a) {
      const on = only.test((this.thread16 && this.thread16.pc && this.thread16.pc.path) || '');
      const sa = on ? a.map(v => { const s = strOf(this, v); return s !== null ? JSON.stringify(s) : (v >>> 0).toString(16); }).join(', ') : '';
      const r = f.apply(this, a);
      if (on && (typeof r === 'number' || r === undefined)) {
        const L = self.W95CallTrace || (self.W95CallTrace = []); L.push(`${dll}!${nm}(${sa}) = ${((r || 0) >>> 0).toString(16)} le ${this.lastError}`);
        if (L.length % 40 === 0 || /wsprintf|#15|MessageBox/.test(nm)) try { const b = machine.proc.fs; b.writeFile('C:\\CALLTRACE.TXT', self.W95FS ? self.W95FS.encode(L.join('\r\n')) : new TextEncoder().encode(L.join('\r\n'))); } catch (_) { /* advice */ }
      }
      return r;
    };
  }
})();
