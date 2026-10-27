// The audio CD in the second CD drive (E:), as the drive plays one: its table of contents (audiocd.json, from
// tools/build_audiocd.py) and its sectors (audiocd.bin: Red Book audio, 44.1 kHz 16-bit stereo in 2352-byte sectors),
// read a few seconds at a time from the server as they play, straight to the speakers as a drive's analog output goes
// to the sound card. The machine's CD driver (MSCDEX's device request, ne16.js cdRequest) says play from one sector
// to another, or stop; it keeps the drive's position itself.
(function () {
  const SECTOR = 2352, CHUNK = 75 * 4;   // (sectors fetched at once: 4 seconds)
  // the disc: its table of contents, or null when the server has none (no disc in the drive)
  const toc = (() => {
    try {
      const x = new XMLHttpRequest(); x.open('GET', 'audiocd.json', false); x.send();
      return x.status === 200 ? JSON.parse(x.responseText) : null;
    } catch (_) { return null; }
  })();
  // the files CDFS shows for an audio disc: Track01.cda ..., each a RIFF CDDA header naming its track (its number, the
  // disc's serial number, its first sector and length, and those in minutes, seconds and frames, 2 seconds on)
  const cda = t => {
    const b = new Uint8Array(44), d = new DataView(b.buffer), s = (o, x) => [...x].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
    const msf = (o, n) => { b[o] = n % 75; b[o + 1] = Math.floor(n / 75) % 60; b[o + 2] = Math.floor(n / 4500); };
    s(0, 'RIFF'); d.setUint32(4, 36, true); s(8, 'CDDA'); s(12, 'fmt '); d.setUint32(16, 24, true);
    d.setUint16(20, 1, true); d.setUint16(22, t.number, true); d.setUint32(24, serial(), true);
    d.setUint32(28, t.lba, true); d.setUint32(32, t.sectors, true); msf(36, t.lba + 150); msf(40, t.sectors);
    return b;
  };
  // (the disc's serial number as CDFS makes one for an audio disc: from its tracks' places)
  const serial = () => toc.tracks.reduce((h, t) => (Math.imul(h, 31) + t.lba + t.sectors) >>> 0, toc.leadout >>> 0);
  let ctx = null, gen = 0, sources = [];
  // play sectors [from, to): fetched CHUNK at a time, each scheduled after the last, the next fetched while one plays
  const play = async (from, to) => {
    const my = ++gen; stopSources();
    ctx = ctx || new AudioContext({ latencyHint: 'playback' });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    let at = ctx.currentTime + 0.1;
    for (let s = from; s < to && my === gen; s += CHUNK) {
      const n = Math.min(CHUNK, to - s);
      let pcm;
      try {
        const r = await fetch(toc.file, { headers: { Range: `bytes=${s * SECTOR}-${(s + n) * SECTOR - 1}` } });
        pcm = new Int16Array(await r.arrayBuffer());
      } catch (e) { console.warn('[cdaudio]', e); return; }
      if (my !== gen) return;
      const frames = pcm.length >> 1, buf = ctx.createBuffer(2, frames, 44100), l = buf.getChannelData(0), rt = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) { l[i] = pcm[2 * i] / 32768; rt[i] = pcm[2 * i + 1] / 32768; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      at = Math.max(at, ctx.currentTime + 0.05); src.start(at); at += buf.duration;
      sources.push(src); src.onended = () => { sources = sources.filter(x => x !== src); };
      // (wait to fetch the next until this one is under way: a few seconds ahead, not the whole disc)
      while (my === gen && at - ctx.currentTime > CHUNK / 75 + 1) await new Promise(ok => setTimeout(ok, 250));
    }
  };
  const stopSources = () => { for (const s of sources) { try { s.stop(); } catch (_) { /* not started */ } } sources = []; };
  const stop = () => { gen++; stopSources(); };
  window.W95CDAudio = { toc, cda, serial: () => (toc ? serial() : 0), play, stop };
})();
