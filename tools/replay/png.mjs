// The share of black pixels in a PNG (8-bit RGB/RGBA, not interlaced), for spotting blank frames.
import zlib from 'node:zlib';
// the pixels of a PNG's top-left cropW x cropH area (RGB), for hashing a page's own area
export function cropPixels(buf, cropW, cropH, mask = null) {   // mask: [x0, y0, x1, y1] left out (set to 0)
  const r = { px: [] }; blackShare(buf, cropW, cropH, r);
  if (mask) { const cw = Math.min(cropW, buf.readUInt32BE(16)); for (let y = Math.max(0, mask[1]); y < Math.min(cropH, mask[3]); y++) for (let x = Math.max(0, mask[0]); x < Math.min(cw, mask[2]); x++) { const i = 3 * (y * cw + x); r.px[i] = r.px[i + 1] = r.px[i + 2] = 0; } }
  return Buffer.from(r.px);
}
export function blackShare(buf, cropW = Infinity, cropH = Infinity, sink = null) {   // within the top-left cropW x cropH pixels
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  let prev = Buffer.alloc(stride), black = 0; const cw = Math.min(w, cropW), ch = Math.min(h, cropH);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    if (y < ch) for (let x = 0; x < cw * bpp; x += bpp) { if (line[x] < 8 && line[x + 1] < 8 && line[x + 2] < 8) black++; if (sink) sink.px.push(line[x], line[x + 1], line[x + 2]); }
    prev = line;
  }
  return black / (cw * ch);
}
