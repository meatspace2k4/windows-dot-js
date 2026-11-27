// (a test: every MoveFile/MoveFileEx the guest makes, and the INT 21h renames (56h, 7156h), logged with what was asked)
(() => {
  const W = self.W95Win32, K = W && W.API && W.API.KERNEL32; if (!K || K.__renTraced) return; K.__renTraced = true;
  const s = (p, v) => { try { return JSON.stringify(p.readA(v, 260)); } catch (_) { return String(v); } };
  for (const nm of ['MoveFileA', 'MoveFileExA']) {
    const d = K[nm]; if (!d) continue; const f = d[1];
    d[1] = function (a, b, fl) { const r = f.call(this, a, b, fl); console.warn(`[rentrace] ${nm}(${s(this, a)}, ${s(this, b)}${fl !== undefined ? ', ' + fl : ''}) = ${r} lastError ${this.lastError} (${this.thread16 && this.thread16.pc ? this.thread16.pc.path : '?'})`); return r; };
  }
  const P = W.Process.prototype, fsOf = p => p.fs;
  if (typeof machine !== 'undefined' && machine.proc && machine.proc.fs && !machine.proc.__renFs) {
    const p = machine.proc; p.__renFs = true; const base = p.fs;
    p.fs = new Proxy(base, { get(t, k) { const v = t[k]; if (k === 'rename' && typeof v === 'function') return (a, b) => { console.warn(`[rentrace] fs.rename(${JSON.stringify(a)}, ${JSON.stringify(b)}) thread ${p.thread16 ? p.thread16.id : 'main'}`); return v.call(t, a, b); }; return v; }, set(t, k, v) { t[k] = v; return true; } });
  }
})();
