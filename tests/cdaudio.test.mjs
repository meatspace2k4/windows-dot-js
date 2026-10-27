// The audio disc's page side (cdaudio.js): its table of contents from audiocd.json, the Track##.cda files CDFS shows
// (a RIFF CDDA header: the track, the disc's serial, its first sector and length, and those in minutes, seconds and
// frames 2 seconds on), and CD Player's disc ID (the sum of the tracks' packed starts, in hex: The Incredible Machine 3's
// disc is 20D49D5); no audiocd.json, no disc
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../cdaudio.js', import.meta.url), 'utf8');
const load = body => {
  const window = {};
  class XMLHttpRequest { open() {} send() { this.status = body ? 200 : 404; this.responseText = body || ''; } }
  new Function('window', 'XMLHttpRequest', src)(window, XMLHttpRequest);
  return window.W95CDAudio;
};
let toc = null; try { toc = JSON.parse(readFileSync(new URL('../audiocd.json', import.meta.url), 'utf8')); } catch (_) { /* not built in this checkout */ }
// (a table of contents of its own when the image has not been built here)
const T = toc || { album: 'A', performer: 'P', file: 'audiocd.bin', leadout: 26430, tracks: [{ number: 1, title: 'One', lba: 0, sectors: 13275 }, { number: 2, title: 'Two', lba: 13275, sectors: 13155 }] };
const A = load(JSON.stringify(T));
assert.deepEqual(A.toc.tracks.length, T.tracks.length);
const t2 = T.tracks[1], b = A.cda(t2), d = new DataView(b.buffer);
assert.equal(b.length, 44); assert.equal(String.fromCharCode(...b.subarray(0, 4)), 'RIFF'); assert.equal(String.fromCharCode(...b.subarray(8, 16)), 'CDDAfmt ');
assert.equal(d.getUint16(22, true), 2); assert.equal(d.getUint32(24, true), A.serial()); assert.equal(d.getUint32(28, true), t2.lba); assert.equal(d.getUint32(32, true), t2.sectors);
const f = t2.lba + 150; assert.deepEqual([b[36], b[37], b[38]], [f % 75, Math.floor(f / 75) % 60, Math.floor(f / 4500)]);
const want = T.tracks.reduce((s, t) => { const x = t.lba + 150; return s + ((Math.floor(x / 4500) << 16) | ((Math.floor(x / 75) % 60) << 8) | (x % 75)); }, 0).toString(16).toUpperCase();
assert.equal(A.discId(), want);
if (toc && /Incredible Machine 3/.test(toc.album)) assert.equal(A.discId(), '20D49D5', 'the disc ID CD Player looks this disc up by');
assert.equal(load(null).toc, null); assert.equal(load(null).discId(), null);
console.log('cdaudio: ok');
