// Test: each batch of samples the sound card sends to the output, with the wall's time, the machine's clock and its
// frames, kept in self.__soundPace (#mod=test-soundpace; read with worker_eval): whether the card's samples come at
// the pace the speakers play them, and where they fall behind
(() => {
  const W = self.W95Win32, sink = self.W95AudioSink; if (!sink) { W.log('warn', 'mod', 'test-soundpace: no sink'); return; }
  const log = self.__soundPace = [];
  self.W95AudioSink = function (proc, rate, L, R, k) {
    const v = proc.host && proc.host.vclock;
    if (log.length < 20000) log.push([Math.round(performance.now()), v ? Math.round(v.now) : 0, rate, k]);
    return sink.apply(this, arguments);
  };
  W.log('info', 'mod', 'test-soundpace: watching');
})();
