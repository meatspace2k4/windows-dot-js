// (a test: an RGI*.TMP that DeleteFileA removes (ADVPACK's REGINST INF) copied first to C:\RGI_<n>.INF)
(() => {
  const W = self.W95Win32, K = W && W.API && W.API.KERNEL32; if (!K || K.__keepInf) return; K.__keepInf = true;
  const d = K.DeleteFileA, f = d[1]; let n = 0;
  d[1] = function (p) {
    try { const s = this.readA(p) || ''; if (/\\RGI[^\\]*\.TMP$/i.test(s)) this.fs.writeFile(`C:\\RGI_${++n}.INF`, this.fs.readFile(s)); } catch (_) { /* a test */ }
    return f.call(this, p);
  };
})();
