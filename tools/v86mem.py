"""Where a VxD reads or writes the system VM's first megabyte itself, not through a VMM service: the places the
emulator's state must be in guest memory, not in a stand-in's own tables.

    python3 tools/v86mem.py <folder of .vxd files> [--json findings/v86mem.json]

VNETBIOS read the INT 5Ch vector at 170h with `mov eax, [eax*4]` and far-called through it; the vectors lived in a
map in vmm.js (Set_V86_Int_Vector) and memory held 0000:0000, so the call ran the null page (Windows 98 Setup, Saving
System Files). The signs, by static scan of each VxD's bytes (capstone over every byte offset is too slow and
ambiguous for a VxD's LE objects; the patterns are the instruction encodings themselves):

- `[reg*4]` with no base and a 32-bit displacement below 400h: an interrupt vector read or written by its number;
- a 32-bit absolute address below 100000h in a memory operand (disp32, no base, no index): BIOS data, the IVT, DOS;
- `shl eax, 12; shr ax, 12`: a linear address made into a real-mode segment:offset, so the VxD hands real-mode code
  an address it will run or read from (every such address must lie below 1 MB and be where the VxD put it).

Each hit names the VxD, the file offset, the bytes and what it means. A stand-in whose state those places touch is
the emulator's own bug waiting: the state belongs in memory.
"""
import glob, json, os, re, struct, sys

PATTERNS = [
    # ModRM with mod=00 rm=101 (disp32) after a SIB? no: SIB form: ModRM mod=00 rm=100, SIB scale=10 (×4) base=101 (none, disp32)
    (re.compile(rb'[\x8b\x89\x8a\x88\x8d\xff\xc7\x3b\x39\x0f]([\x04\x0c\x14\x1c\x24\x2c\x34\x3c])([\x85\x8d\x95\x9d\xa5\xad\xb5\xbd])(.{4})', re.S), 'ivt'),
]
ABS = re.compile(rb'(\x8b|\x89|\xa1|\xa3|\xff|\x8a|\x88|\x0f\xb7|\x0f\xb6|\x66\x8b|\x66\x89)([\x05\x0d\x15\x1d\x25\x2d\x35\x3d])(.{4})', re.S)
SEGOFF = re.compile(rb'\xc1\xe0\x0c\x66\xc1\xe8\x0c')
BY_OP = {0x8b: 'mov r,m', 0x89: 'mov m,r', 0x8a: 'mov r8,m', 0x88: 'mov m,r8', 0x8d: 'lea', 0xff: 'push/call/jmp m', 0xc7: 'mov m,imm', 0x3b: 'cmp r,m', 0x39: 'cmp m,r'}

def fixups(d):
    """the file offsets of every fixed-up dword in an LE file (a jump table's displacement is one: it is the VxD's own
    memory, not the first megabyte); nothing when the file is not LE"""
    out = set()
    try:
        le = struct.unpack_from('<I', d, 0x3c)[0]
        if d[le:le + 2] != b'LE': return out
        page = struct.unpack_from('<I', d, le + 0x28)[0]; npages = struct.unpack_from('<I', d, le + 0x14)[0]
        fpt = le + struct.unpack_from('<I', d, le + 0x68)[0]; frt = le + struct.unpack_from('<I', d, le + 0x6c)[0]
        data = struct.unpack_from('<I', d, le + 0x80)[0]
        for i in range(npages):
            lo, hi = struct.unpack_from('<II', d, fpt + 4 * i); r = frt + lo
            while r < frt + hi:
                src, flags = d[r], d[r + 1]; r += 2
                n = d[r] if src & 0x20 else 1
                if src & 0x20: r += 1
                srcs = []
                if not src & 0x20: srcs.append(struct.unpack_from('<H', d, r)[0]); r += 2
                r += 2 if flags & 0x40 else 1   # object number
                if (flags & 3) == 0 and (src & 0xf) != 2: r += 4 if flags & 0x10 else 2   # target offset
                if (flags & 3) == 1 or (flags & 3) == 2: r += 2 if flags & 0x40 else 1; r += (4 if flags & 0x10 else 2) if (flags & 3) == 1 and not flags & 4 else 0
                if flags & 4: r += 4 if flags & 0x10 else 2
                if src & 0x20:
                    for _ in range(n): srcs.append(struct.unpack_from('<H', d, r)[0]); r += 2
                for s in srcs: out.add(data + i * page + (s & 0xffff))
    except (struct.error, IndexError): pass
    return out

def scan(path):
    d = open(path, 'rb').read(); name = os.path.basename(path).upper(); out = []; fixed = fixups(d)
    for m in PATTERNS[0][0].finditer(d):
        disp = struct.unpack_from('<I', m.group(3))[0]; op = m.group(0)[0]
        if m.start(3) in fixed or op == 0x8d: continue   # (a jump table of the VxD's own; lea [reg*4] is arithmetic, no access)
        if disp < 0x400 and disp % 4 == 0:
            out.append({'vxd': name, 'at': '%x' % m.start(), 'bytes': m.group(0).hex(' '), 'kind': 'vector', 'what': '%s [reg*4 + %xh]: interrupt vector %s by number' % (BY_OP.get(op, '%02x' % op), disp, 'read/written' if disp == 0 else 'at %xh' % disp)})
    for m in ABS.finditer(d):
        if m.start(3) in fixed: continue
        disp = struct.unpack_from('<I', m.group(3))[0]
        if 0 < disp < 0x100000 and (disp < 0x600 or 0x400 <= disp < 0x500 or 0xa0000 <= disp < 0x100000):
            out.append({'vxd': name, 'at': '%x' % m.start(), 'bytes': m.group(0).hex(' '), 'kind': 'absolute', 'what': 'absolute %xh: %s' % (disp, 'the IVT' if disp < 0x400 else 'the BIOS data area' if disp < 0x600 else 'the adapter or ROM area')})
    for m in SEGOFF.finditer(d):
        out.append({'vxd': name, 'at': '%x' % m.start(), 'bytes': m.group(0).hex(' '), 'kind': 'segoff', 'what': 'linear made segment:offset: an address handed to real-mode code'})
    return out

def main():
    folder = sys.argv[1]; js = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
    hits = []
    for f in sorted(glob.glob(os.path.join(folder, '*.vxd')) + glob.glob(os.path.join(folder, '*.VXD'))): hits += scan(f)
    for h in hits: print('%-14s %6s  %-28s %s' % (h['vxd'], h['at'], h['bytes'], h['what']))
    by = {}
    for h in hits: by.setdefault(h['vxd'], []).append(h['kind'])
    print('\n%d places in %d VxDs: %s' % (len(hits), len(by), ', '.join('%s (%s)' % (k, ','.join(sorted(set(v)))) for k, v in sorted(by.items()))))
    if js: json.dump(hits, open(js, 'w'), indent=1)

if __name__ == '__main__': main()
