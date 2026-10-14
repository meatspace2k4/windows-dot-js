"""Dump icons, bitmaps, cursors and FNT fonts from NE/PE binaries to PNG/JSON."""
import json, os, struct, sys
from PIL import Image

def u16(d, o): return struct.unpack_from('<H', d, o)[0]
def u32(d, o): return struct.unpack_from('<I', d, o)[0]

RT = {1: 'cursor', 2: 'bitmap', 3: 'icon', 8: 'font', 12: 'group_cursor', 14: 'group_icon'}

def ne_resources(d):
    ne = u32(d, 0x3c)
    rt = ne + u16(d, ne + 0x24)
    shift = u16(d, rt); p = rt + 2
    out = {}
    while True:
        tid = u16(d, p)
        if tid == 0: break
        cnt = u16(d, p + 2); p += 8
        for _ in range(cnt):
            off, ln, fl, rid = struct.unpack_from('<HHHH', d, p); p += 12
            key = (tid & 0x7fff) if tid & 0x8000 else ('str', tid)
            name = (rid & 0x7fff) if rid & 0x8000 else ne_name(d, rt, rid)
            out.setdefault(key, {})[name] = d[off << shift:(off << shift) + (ln << shift)]
    return out

def ne_name(d, rt, o):
    n = d[rt + o]; return d[rt + o + 1: rt + o + 1 + n].decode('latin1')

def pe_resources(d):
    pe = u32(d, 0x3c)
    nsec = u16(d, pe + 6); opt = u16(d, pe + 20)
    sec = pe + 24 + opt
    magic = u16(d, pe + 24)
    dd = pe + 24 + (96 if magic == 0x10b else 112)
    rva = u32(d, dd + 2 * 8)
    secs = [struct.unpack_from('<IIII', d, sec + 40 * i + 8) for i in range(nsec)]
    def r2o(r):
        for vs, va, rs, ro in secs:
            if va <= r < va + max(vs, rs): return r - va + ro
        raise ValueError(r)
    base = r2o(rva)
    def name_of(e):
        if e & 0x80000000:
            o = base + (e & 0x7fffffff); n = u16(d, o)
            return d[o + 2:o + 2 + 2 * n].decode('utf-16le')
        return e
    def walk(o):
        ne, ie = u16(d, o + 12), u16(d, o + 14)
        for i in range(ne + ie):
            nm, ptr = struct.unpack_from('<II', d, o + 16 + 8 * i)
            yield name_of(nm), ptr
    out = {}
    for t, p1 in walk(base):
        for n, p2 in walk(base + (p1 & 0x7fffffff)):
            for _, p3 in walk(base + (p2 & 0x7fffffff)):
                drva, sz = struct.unpack_from('<II', d, base + p3)
                o = r2o(drva)
                out.setdefault(t, {}).setdefault(n, d[o:o + sz])
                break
    return out

def rle_decode(s, w, h, bpp, stride):
    px = [[0] * w for _ in range(h)]
    x = y = i = 0
    def put(v):
        nonlocal x
        if x < w and y < h: px[y][x] = v
        x += 1
    while i < len(s) - 1:
        n, c = s[i], s[i + 1]; i += 2
        if n:
            for k in range(n):
                put(c if bpp == 8 else (c >> 4 if k % 2 == 0 else c & 15))
        elif c == 0: x = 0; y += 1
        elif c == 1: break
        elif c == 2: x += s[i]; y += s[i + 1]; i += 2
        else:
            nb = c if bpp == 8 else (c + 1) // 2
            for k in range(c):
                put(s[i + k] if bpp == 8 else (s[i + k // 2] >> 4 if k % 2 == 0 else s[i + k // 2] & 15))
            i += nb + (nb & 1)
    out = bytearray(stride * h)
    for yy in range(h):
        for xx in range(w):
            v = px[yy][xx]
            if bpp == 8: out[yy * stride + xx] = v
            else: out[yy * stride + xx // 2] |= v << (4 if xx % 2 == 0 else 0)
    return bytes(out)

def dib_to_image(b, icon=False):
    hs = u32(b, 0)
    if hs == 12:
        w, h, planes, bpp = struct.unpack_from('<HHHH', b, 4); comp = 0; clr = 0; pe = 3
    else:
        w, h, planes, bpp, comp = struct.unpack_from('<iiHHI', b, 4); clr = u32(b, 32); pe = 4
    if icon: h //= 2
    flip = h > 0; h = abs(h)
    ncol = clr or (1 << bpp if bpp <= 8 else 0)
    pal = [(b[hs + i * pe + 2], b[hs + i * pe + 1], b[hs + i * pe]) for i in range(ncol)]
    px = hs + ncol * pe
    if comp == 3 and hs == 40: px += 12
    stride = ((w * bpp + 31) // 32) * 4
    if comp in (1, 2):
        b = b[:px] + rle_decode(b[px:], w, abs(h), bpp, stride)
    img = Image.new('RGBA', (w, h))
    P = img.load()
    for y in range(h):
        row = px + y * stride; yy = h - 1 - y if flip else y
        for x in range(w):
            if bpp <= 8:
                bit = x * bpp; v = (b[row + bit // 8] >> (8 - bpp - bit % 8)) & ((1 << bpp) - 1)
                c = pal[v] if v < len(pal) else (0, 0, 0)
            elif bpp == 24:
                o = row + x * 3; c = (b[o + 2], b[o + 1], b[o])
            elif bpp == 32:
                o = row + x * 4; c = (b[o + 2], b[o + 1], b[o])
            else:
                v = u16(b, row + x * 2); c = (((v >> 10) & 31) << 3, ((v >> 5) & 31) << 3, (v & 31) << 3)
            P[x, yy] = c + (255,)
    if icon:
        ms = ((w + 31) // 32) * 4; mo = px + stride * h
        for y in range(h):
            yy = h - 1 - y
            for x in range(w):
                if (b[mo + y * ms + x // 8] >> (7 - x % 8)) & 1:
                    r, g, bb, _ = P[x, yy]
                    # masked: black => transparent, otherwise XOR (invert) pixel
                    P[x, yy] = (0, 0, 0, 0) if (r, g, bb) == (0, 0, 0) else (r, g, bb, 254)
    return img

def fnt_to_json(b):
    ver = u16(b, 0)
    f = dict(points=u16(b, 68), vres=u16(b, 70), hres=u16(b, 72), ascent=u16(b, 74),
             height=u16(b, 88), weight=u16(b, 83), italic=b[80], first=b[95], last=b[96],
             default=b[97], brk=b[98], pixwidth=u16(b, 86))
    fo = u32(b, 105); f['face'] = b[fo:b.index(b'\0', fo)].decode('latin1')
    ct, es = (148, 6) if ver == 0x300 else (118, 4)
    glyphs = {}
    for i in range(f['last'] - f['first'] + 2):
        w = u16(b, ct + i * es)
        off = u32(b, ct + i * es + 2) if es == 6 else u16(b, ct + i * es + 2)
        rows = []
        for y in range(f['height']):
            bits = 0
            for col in range((w + 7) // 8):
                bits = (bits << 8) | b[off + col * f['height'] + y]
            bits >>= ((w + 7) // 8) * 8 - w
            rows.append(bits)
        glyphs[f['first'] + i] = [w, rows]
    f['glyphs'] = glyphs
    return f

def main(src, outdir):
    os.makedirs(outdir, exist_ok=True)
    d = open(src, 'rb').read()
    kind = d[u32(d, 0x3c):u32(d, 0x3c) + 2]
    res = ne_resources(d) if kind == b'NE' else pe_resources(d)
    stem = os.path.basename(src).split('.')[0].lower()
    for rid, b in res.get(2, {}).items():
        try: dib_to_image(b).save(f'{outdir}/{stem}_bmp_{rid}.png')
        except Exception as e: print('bmp', rid, e)
    icons = res.get(3, {})
    for gid, g in res.get(14, {}).items():
        for i in range(u16(g, 4)):
            w, h, cc, _, pl, bc, sz, iid = struct.unpack_from('<BBBBHHIH', g, 6 + 14 * i)
            if iid in icons:
                try:
                    im = dib_to_image(icons[iid], icon=True)
                    im.save(f'{outdir}/{stem}_ico_{gid}_{im.width}x{im.height}_{bc or cc}.png')
                except Exception as e: print('ico', gid, e)
    curs = res.get(1, {})
    for gid, g in res.get(12, {}).items():
        iid = u16(g, 6 + 12)
        if iid in curs:
            c = curs[iid]; hx, hy = u16(c, 0), u16(c, 2)
            dib_to_image(c[4:], icon=True).save(f'{outdir}/{stem}_cur_{gid}_{hx}_{hy}.png')
    for fid, b in res.get(8, {}).items():
        f = fnt_to_json(b)
        json.dump(f, open(f'{outdir}/{stem}_font_{f["face"].replace(" ", "")}_{f["height"]}_{f["weight"]}.json', 'w'))
    print(src, {RT.get(k, k): len(v) for k, v in res.items()})

if __name__ == '__main__':
    for s in sys.argv[2:]: main(s, sys.argv[1])
