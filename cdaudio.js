// The audio CD in the second CD drive (E:), as the drive plays one: its table of contents (audiocd.json, from
// tools/build_audiocd.py) and its sectors (audiocd.bin: Red Book audio, 44.1 kHz 16-bit stereo in 2352-byte sectors),
// read a few seconds at a time from the server as they play, straight to the speakers as a drive's analog output goes
// to the sound card. The machine's CD driver (MSCDEX's device request, ne16.js cdRequest) says play from one sector
// to another, or stop; it keeps the drive's position itself.
(function () {
  const SECTOR = 2352, CHUNK = 75 * 4;   // (sectors fetched at once: 4 seconds)
  // the disc: its table of contents (the app's host has it, a page reads audiocd.json from the server)
  const H = window.W95HOST && window.W95HOST.audio;
  const toc = H ? H.toc : (() => {
    const x = new XMLHttpRequest(); x.open('GET', 'audiocd.json', false); x.send();
    if (x.status !== 200) throw new Error(`audiocd.json: ${x.status}`);
    return JSON.parse(x.responseText);
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
  // (the disc's serial number is its identity, the one MCICDA answers for it: the sum of the tracks' packed starts)
  const serial = () => parseInt(discId(), 16) >>> 0;
  let ctx = null, gen = 0, sources = [], out = null, levels = [1, 1];
  // the drive's output as the sound card mixes it: each channel through its gain (the codec's AUX1, sound.js)
  const output = () => {
    if (out) return out.in;
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), g = [ctx.createGain(), ctx.createGain()];
    g.forEach((x, i) => { x.gain.value = level(i); split.connect(x, i); x.connect(merge, 0, i); });
    merge.connect(ctx.destination); out = { in: split, g };
    return split;
  };
  const muted = () => { try { return /^(1|true)$/i.test(new URLSearchParams(location.search).get('mute') || ''); } catch (_) { return !!window.W95MUTE; } };
  const level = i => (muted() ? 0 : levels[i]);   // (none on a page asked to be silent, ?mute=1)
  const gain = (l, r) => { levels = [l, r]; if (out) out.g.forEach((x, i) => { x.gain.setValueAtTime(level(i), ctx.currentTime); }); };
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
        const r = H ? await H.read(s * SECTOR, n * SECTOR) : new Uint8Array(await (await fetch(toc.file, { headers: { Range: `bytes=${s * SECTOR}-${(s + n) * SECTOR - 1}` } })).arrayBuffer());
        pcm = new Int16Array(r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength));
      } catch (e) { console.warn('[cdaudio]', e); return; }
      if (my !== gen) return;
      const frames = pcm.length >> 1, buf = ctx.createBuffer(2, frames, 44100), l = buf.getChannelData(0), rt = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) { l[i] = pcm[2 * i] / 32768; rt[i] = pcm[2 * i + 1] / 32768; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(output());
      at = Math.max(at, ctx.currentTime + 0.05); src.start(at); at += buf.duration;
      sources.push(src); src.onended = () => { sources = sources.filter(x => x !== src); };
      // (wait to fetch the next until this one is under way: a few seconds ahead, not the whole disc)
      while (my === gen && at - ctx.currentTime > CHUNK / 75 + 1) await new Promise(ok => setTimeout(ok, 250));
    }
  };
  const stopSources = () => { for (const s of sources) { try { s.stop(); } catch (_) { /* not started */ } } sources = []; };
  const stop = () => { gen++; stopSources(); };
  // the disc's ID as CD Player makes one, its section in CDPLAYER.INI: the sum of the tracks' starts, each as minute,
  // second and frame packed in a word (MSF 00:02:00 on), in hex
  const discId = () => toc.tracks.reduce((s, t) => { const f = t.lba + 150; return (s + ((Math.floor(f / 4500) << 16) | ((Math.floor(f / 75) % 60) << 8) | (f % 75))) >>> 0; }, 0).toString(16).toUpperCase();
  window.W95CDAudio = { toc, cda, serial, discId, play, stop, gain, levels: () => levels };
})();
