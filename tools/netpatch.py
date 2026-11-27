"""The fixes netpatch.js keeps for Windows' own files (by the file's SHA-256), applied to a file's bytes before it is
recompiled and bundled (build_system.py), as dyn.js applies them to a module loaded from its file before translating it.

    file(path, tmpdir) -> the path of a fixed copy of the file, or the path itself when no fix names it
"""
import hashlib, json, os, re, struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def table():
    t = open(os.path.join(ROOT, 'netpatch.js'), encoding='utf-8').read()
    m = re.search(r'/\*JSON\*/(.*?)/\*END\*/', t, re.S)
    return json.loads(m.group(1)) if m else {}

def offset(b, at):
    """the file offset of a patch's place: S:OFF in a 16-bit module's segment S, rva:OFF in an image"""
    m = re.fullmatch(r'(?:(\d+)|rva):([0-9a-fA-F]+)', at)
    if not m: raise ValueError('a patch at %r: S:OFF or rva:OFF' % at)
    off = int(m.group(2), 16)
    hdr = struct.unpack_from('<I', b, 0x3c)[0]
    if m.group(1):
        if b[hdr:hdr + 2] != b'NE': raise ValueError('S:OFF in a file with no NE header')
        seg = int(m.group(1)); segtab = hdr + struct.unpack_from('<H', b, hdr + 0x22)[0]; shift = struct.unpack_from('<H', b, hdr + 0x32)[0] or 9
        sector = struct.unpack_from('<H', b, segtab + 8 * (seg - 1))[0]
        return (sector << shift) + off
    if b[hdr:hdr + 4] != b'PE\0\0': raise ValueError('rva:OFF in a file with no PE header')
    nsec, osz = struct.unpack_from('<H', b, hdr + 6)[0], struct.unpack_from('<H', b, hdr + 20)[0]
    for i in range(nsec):
        s = hdr + 24 + osz + 40 * i; vs, va, rs, rp = struct.unpack_from('<IIII', b, s + 8)
        if va <= off < va + max(vs, rs): return off - va + rp
    raise ValueError('rva %x in no section' % off)

def apply(b, entry):
    """the file's bytes with entry's byte patches made (handlers are the host's, made as the module loads)"""
    b = bytearray(b)
    for p in entry.get('patches', []):
        if 'handler' in p: continue
        at, want, put = offset(b, p['at']), bytes.fromhex(p['expect']), bytes.fromhex(p['bytes'])
        if len(want) != len(put): raise ValueError('%s %s: expect and bytes differ in length' % (entry.get('name'), p['at']))
        if b[at:at + len(put)] == put: continue
        if b[at:at + len(want)] != want: raise ValueError('%s %s: the file has %s there, not %s' % (entry.get('name'), p['at'], b[at:at + len(want)].hex(), p['expect']))
        b[at:at + len(put)] = put
    return bytes(b)

def file(path, tmpdir):
    b = open(path, 'rb').read(); entry = table().get(hashlib.sha256(b).hexdigest())
    if not entry or not any('handler' not in p for p in entry.get('patches', [])): return path
    d = os.path.join(tmpdir, 'netpatch'); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, os.path.basename(path))   # (its own name: the recompiler names some modules by their file)
    open(out, 'wb').write(apply(b, entry))
    return out
