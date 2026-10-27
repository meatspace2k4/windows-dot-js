// The microphone plugged into the sound card's mic input: while the codec captures (sound.js captureRun, its driver
// recording for Sound Recorder), the page's microphone, asked for then (the browser asks the person once), its samples
// sent to the machine as they come (mono, at the audio device's rate); the microphone let go when capture stops.
// Refused or absent, the card records silence, as an empty jack does.
(function () {
  let want = false, stream = null, ctx = null, node = null, sink = null;
  const close = () => {
    if (node) { node.onaudioprocess = null; try { node.disconnect(); } catch (_) { /* gone */ } }
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = node = null;
  };
  const set = (on, send) => {
    want = on; sink = send;
    if (!on) { close(); return Promise.resolve(false); }
    if (stream) return Promise.resolve(true);
    const md = navigator.mediaDevices; if (!md || !md.getUserMedia) return Promise.resolve(false);
    return md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(s => {
      if (!want) { s.getTracks().forEach(t => t.stop()); return false; }   // (capture stopped while the person was asked)
      stream = s; ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(s); node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = e => { if (sink) sink(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate); };
      src.connect(node); node.connect(ctx.destination);   // (a processor runs only connected; its output stays silent)
      return true;
    }, e => { console.warn('[mic]', e && e.message); return false; });
  };
  window.W95Mic = { set, open: () => !!stream };
})();
