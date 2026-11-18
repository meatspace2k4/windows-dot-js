// VMM32.VXD's containers: W4 (Windows 98's, its W3 in 8K chunks compressed as DoubleSpace compresses, "DS") and W3
// (the VxDs one after another, a directory of name, offset and size before them). The algorithm is W4DECOMP.C's
// ("Windows Undocumented File Formats"), as doslib's w4tow3.c has it
'use strict';
(function (root) {
  /** one W4 chunk: the bytes it expands to (at most `max`); null when the stream is not one */
  const chunk = (src, max) => {
    const out = new Uint8Array(max); let o = 0, s = 0, mb = 0, used = 0, cnt = 8, depth = 1;
    for (let i = 0; i < 4; i++) mb = ((mb >>> 8) | ((src[s++] || 0) << 24)) >>> 0;
    const load = () => { while (used) { used--; mb >>>= 1; if (--cnt === 0) { if (s < src.length) mb = (mb + (src[s++] << 24)) >>> 0; cnt += 8; } } };
    while (depth) {
      load();
      if ((mb & 3) === 1 || (mb & 3) === 2) { if (o >= max) break; out[o++] = (((mb & 0x1fc) >>> 2) + ((mb & 1) << 7)) & 0xff; used = 9; continue; }
      if ((mb & 3) === 0) { depth = (mb & 0xfc) >>> 2; used = 8; }
      else if ((mb & 7) === 3) { depth = ((mb & 0x7f8) >>> 3) + 0x40; used = 11; }
      else if ((mb & 7) === 7) { depth = ((mb & 0x7ff8) >>> 3) + 0x140; used = 15; }
      else return null;
      if (depth === 0x113f) { if (s >= src.length) break; continue; }
      if (!depth) break;
      load();
      let n;
      if (mb & 1) { n = 2; used = 1; }
      else if ((mb & 3) === 2) { n = ((mb & 4) >>> 2) + 3; used = 3; }
      else if ((mb & 7) === 4) { n = ((mb & 0x18) >>> 3) + 5; used = 5; }
      else if ((mb & 0xf) === 8) { n = ((mb & 0x70) >>> 4) + 9; used = 7; }
      else if ((mb & 0x1f) === 16) { n = ((mb & 0x1e0) >>> 5) + 17; used = 9; }
      else if ((mb & 0x3f) === 32) { n = ((mb & 0x7c0) >>> 6) + 33; used = 11; }
      else if ((mb & 0x7f) === 64) { n = ((mb & 0x1f80) >>> 7) + 65; used = 13; }
      else if ((mb & 0xff) === 128) { n = ((mb & 0x7f00) >>> 8) + 129; used = 15; }
      else if ((mb & 0x1ff) === 256) { n = ((mb & 0x1fe00) >>> 9) + 257; used = 17; }
      else return null;
      if (o - depth < 0 || o + n > max) return null;
      for (let i = 0; i < n; i++, o++) out[o] = out[o - depth];
    }
    return out.subarray(0, o);
  };
  const u16 = (d, o) => d[o] | d[o + 1] << 8, u32 = (d, o) => (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0;
  /** a W4 file as the W3 file it holds (the MZ stub kept in front, so its offsets stay the W3's own); a W3 as it is;
   *  null for neither */
  const w3 = data => {
    const at = u32(data, 0x3c); if (at + 16 > data.length) return null;
    if (data[at] === 0x57 && data[at + 1] === 0x33) return data;
    if (data[at] !== 0x57 || data[at + 1] !== 0x34 || data[at + 8] !== 0x44 || data[at + 9] !== 0x53) return null;
    const size = u16(data, at + 4), n = u16(data, at + 6), tab = [];
    for (let i = 0; i < n; i++) tab.push(u32(data, at + 16 + 4 * i));
    const parts = [data.subarray(0, at)]; let total = at;
    for (let i = 0; i < n; i++) {
      const a = tab[i], b = i + 1 < n ? tab[i + 1] : data.length, src = data.subarray(a, b);
      const p = b - a === size ? src : chunk(src, size); if (!p) return null;
      parts.push(p); total += p.length;
    }
    const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  /** the VxDs a W3 (or W4) VMM32.VXD carries: { NAME: LE file bytes }, each with its own offsets (an LE's data pages
   *  are at file offsets, the W3's, so a member is the W3 from its start with its header moved to 3Ch) */
  const members = data => {
    const d = w3(data); if (!d) return null;
    const at = u32(d, 0x3c), n = u16(d, at + 4), out = {};
    for (let i = 0; i < n; i++) {
      const e = at + 16 + 16 * i; let name = ''; for (let k = 0; k < 8; k++) name += String.fromCharCode(d[e + k]);
      name = name.replace(/[ \0]+$/, '').toUpperCase(); const off = u32(d, e + 8), len = u32(d, e + 12);
      out[name] = { d, off, len };
    }
    return out;
  };
  /** one member as an LE file leImage reads: the W3's bytes with 3Ch naming the member's LE header */
  const member = (data, name) => {
    const m = members(data); const e = m && m[name.toUpperCase().replace(/\.VXD$/, '')]; if (!e) return null;
    const f = new Uint8Array(e.d); f[0x3c] = e.off & 0xff; f[0x3d] = (e.off >>> 8) & 0xff; f[0x3e] = (e.off >>> 16) & 0xff; f[0x3f] = e.off >>> 24;
    return f;
  };
  const api = { chunk, w3, members, member };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.W4 = api;
})(typeof self !== 'undefined' ? self : this);
