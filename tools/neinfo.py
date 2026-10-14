"""Dump an NE (16-bit Windows) module: segments, entry points, imported modules and relocation targets."""
import struct, sys
from collections import Counter
def u8(d, o): return d[o]
def u16(d, o): return struct.unpack_from('<H', d, o)[0]
def u32(d, o): return struct.unpack_from('<I', d, o)[0]
def ne(path):
    d = open(path, 'rb').read(); n = u32(d, 0x3c)
    assert d[n:n + 2] == b'NE'
    h = dict(entry_off=u16(d, n + 4), flags=u16(d, n + 0xc), autodata=u16(d, n + 0xe), heap=u16(d, n + 0x10), stack=u16(d, n + 0x12),
             csip=u32(d, n + 0x14), sssp=u32(d, n + 0x18), nseg=u16(d, n + 0x1c), nmod=u16(d, n + 0x1e), nrnames=u16(d, n + 0x20),
             seg_off=u16(d, n + 0x22), res_off=u16(d, n + 0x24), resname_off=u16(d, n + 0x26), modref_off=u16(d, n + 0x28),
             imp_off=u16(d, n + 0x2a), nrname_off=u32(d, n + 0x2c), align=u16(d, n + 0x32), entry_len=u16(d, n + 6))
    segs = []
    for i in range(h['nseg']):
        o = n + h['seg_off'] + 8 * i
        segs.append(dict(off=u16(d, o) << h['align'], len=u16(d, o + 2) or 0x10000, flags=u16(d, o + 4), alloc=u16(d, o + 6) or 0x10000))
    mods = []
    for i in range(h['nmod']):
        p = n + h['imp_off'] + u16(d, n + h['modref_off'] + 2 * i); mods.append(d[p + 1:p + 1 + d[p]].decode())
    names = {}
    p = n + h['resname_off']; first = True
    while d[p]:
        s = d[p + 1:p + 1 + d[p]].decode('latin1'); o = u16(d, p + 1 + d[p]); p += 3 + d[p]
        if first: h['name'] = s; first = False
        else: names[o] = s
    p = h['nrname_off']; first = True
    while p < len(d) and d[p]:
        s = d[p + 1:p + 1 + d[p]].decode('latin1'); o = u16(d, p + 1 + d[p]); p += 3 + d[p]
        if first: first = False
        else: names.setdefault(o, s)
    # entry table
    entries = {}; p = n + h['entry_off']; ordn = 1
    while True:
        cnt, seg = d[p], d[p + 1]; p += 2
        if cnt == 0: break
        for k in range(cnt):
            if seg == 0: pass
            elif seg == 0xff: entries[ordn] = (d[p + 3], u16(d, p + 4)); p += 6; ordn += 1; continue
            else: entries[ordn] = (seg, u16(d, p + 1)); p += 3; ordn += 1; continue
            ordn += 1
    # relocations per segment
    imports = Counter()
    for i, s in enumerate(segs):
        if not (s['flags'] & 0x100): continue
        r = s['off'] + s['len']; cnt = u16(d, r); r += 2
        for k in range(cnt):
            atype, rtype, off, a1, a2 = d[r], d[r + 1], u16(d, r + 2), u16(d, r + 4), u16(d, r + 6); r += 8
            t = rtype & 3
            if t == 1: imports[(mods[a1 - 1], '#%d' % a2)] += 1
            elif t == 2:
                q = n + h['imp_off'] + a2; imports[(mods[a1 - 1], d[q + 1:q + 1 + d[q]].decode())] += 1
    return d, h, segs, mods, names, entries, imports
if __name__ == '__main__':
    d, h, segs, mods, names, entries, imports = ne(sys.argv[1])
    print(h.get('name'), {k: h[k] for k in ('flags', 'autodata', 'heap', 'stack', 'nseg', 'csip')})
    for i, s in enumerate(segs, 1):
        print(' seg %2d off=%06x len=%05x alloc=%05x flags=%04x %s%s%s' % (i, s['off'], s['len'], s['alloc'], s['flags'],
              'DATA' if s['flags'] & 1 else 'CODE', ' 32BIT' if s['flags'] & 0x2000 else '', ' RELOC' if s['flags'] & 0x100 else ''))
    print(' modules:', mods)
    by = Counter(m for m, _ in imports)
    print(' import refs per module:', dict(by))
    print(' distinct imports:', len(imports))
    if len(sys.argv) > 2:
        for (m, f), c in sorted(imports.items()): print('   %s.%s x%d' % (m, f, c))
    print(' exports:', len(entries), 'named:', len(names))
