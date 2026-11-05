// a running machine's KERNEL.#128 (GetPrivateProfileString) given ne16.js's quote handling without a restart: the
// thunk table holds each def's array itself, so its function is replaced in place (the page's mod, braid's sidecar)
(() => {
  const K = self.W95NE16 && self.W95NE16.K16, d = K && K['KERNEL.#128']; if (!d) return;
  const was = d[2];
  d[2] = function (app, key, dflt, buf, n, f) {
    const r = was.call(this, app, key, dflt, buf, n, f), at = this.lin(buf), len = r & 0xffff;
    if (len >= 2) { const q = this.u8[at]; if ((q === 0x22 || q === 0x27) && this.u8[at + len - 1] === q) { this.u8.copyWithin(at, at + 1, at + len - 1); this.u8[at + len - 2] = 0; return len - 2; } }
    return r;
  };
})();
