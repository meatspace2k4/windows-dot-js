// the running machine given win32.js's dllUse short cut without a restart: the view in place already the process's,
// and no module come or gone since, nothing is walked (attach and dllForget make it walk again)
(() => {
  const P = self.W95Win32 && self.W95Win32.Process.prototype; if (!P || P.dllUse.__inplace) return;
  const use = P.dllUse, forget = P.dllForget, attach = P.attach;
  P.dllUse = function (pc) {
    const key = pc || this.pc0 || (this.pc0 = { pid: 0x50 }), n = (this.modules || []).length;
    if (this.dllInPlace === key && this.dllInPlaceN === n) return;
    use.call(this, pc); this.dllInPlace = key; this.dllInPlaceN = n;
  };
  P.dllUse.__inplace = true;
  P.dllForget = function (pc) { this.dllInPlace = null; return forget.call(this, pc); };
  P.attach = function (m) { this.dllInPlace = null; const r = attach.call(this, m); this.dllInPlace = null; return r; };
})();
