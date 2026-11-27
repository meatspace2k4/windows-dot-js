// Test: the first batches of samples the sound card sends to the output, each with its first samples and its range
// per channel, in the machine's log (#mod=test-soundstart): what the speakers get as the card starts
(() => {
  const W = self.W95Win32, sink = self.W95AudioSink; if (!sink) { W.log('warn', 'mod', 'test-soundstart: no sink'); return; }
  let n = 0;
  const f = a => Math.round(a * 1000) / 1000;
  self.W95AudioSink = function (proc, rate, L, R, k) {
    if (n < 12) {
      n++;
      let lo = [1, 1], hi = [-1, -1]; for (let i = 0; i < k; i++) { lo[0] = Math.min(lo[0], L[i]); hi[0] = Math.max(hi[0], L[i]); lo[1] = Math.min(lo[1], R[i]); hi[1] = Math.max(hi[1], R[i]); }
      const c = proc.ad1848, fmt = c ? (c.regs[8] >> 5) & 3 : -1, st = c ? !!(c.regs[8] & 0x10) : null;
      W.log('info', 'mod', `soundstart #${n} rate ${rate} frames ${k} fmt ${fmt} stereo ${st} L[${f(lo[0])}..${f(hi[0])}] R[${f(lo[1])}..${f(hi[1])}] first L ${Array.from(L.slice(0, 6), f).join(',')} R ${Array.from(R.slice(0, 6), f).join(',')}`);
    }
    return sink.apply(this, arguments);
  };
  W.log('info', 'mod', 'test-soundstart: watching');
})();
