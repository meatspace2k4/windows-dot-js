"""tools/imports_risk.py: the PE import reader on a PE built here, and the classifier on it and on a real NE."""
import os, struct, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import imports_risk as ir
from neinfo import ne

def build_pe(dlls):
    """A PE32 image whose one section holds an import table: dlls is [(dll, [name or ordinal, ...])]."""
    va, raw = 0x1000, 0x200
    sec = bytearray()
    def put(b):
        o = len(sec); sec.extend(b); return va + o
    descs_at = len(sec); sec.extend(b'\0' * 20 * (len(dlls) + 1))
    for i, (dll, funcs) in enumerate(dlls):
        name_rva = put(dll.encode() + b'\0')
        hints = [f if isinstance(f, int) else put(b'\0\0' + f.encode() + b'\0') for f in funcs]
        while len(sec) % 4: sec.append(0)
        thunks = [h | (1 << 31) if isinstance(f, int) else h for f, h in zip(funcs, hints)]
        ilt = put(b''.join(struct.pack('<I', t) for t in thunks) + b'\0' * 4)
        iat = put(b''.join(struct.pack('<I', t) for t in thunks) + b'\0' * 4)
        struct.pack_into('<IIIII', sec, descs_at + 20 * i, ilt, 0, 0, name_rva, iat)
    sec.extend(b'\0' * (-len(sec) % 0x200))
    mz = bytearray(0x40); mz[:2] = b'MZ'; struct.pack_into('<I', mz, 0x3c, 0x40)
    coff = struct.pack('<4sHHIIIHH', b'PE\0\0', 0x14c, 1, 0, 0, 0, 0xe0, 0x102)
    opt = bytearray(0xe0)
    struct.pack_into('<H', opt, 0, 0x10b)
    struct.pack_into('<I', opt, 56, va + len(sec))  # SizeOfImage
    struct.pack_into('<I', opt, 60, raw)            # SizeOfHeaders
    struct.pack_into('<I', opt, 92, 16)             # NumberOfRvaAndSizes
    struct.pack_into('<II', opt, 104, va + descs_at, 20 * (len(dlls) + 1))  # import directory
    sh = struct.pack('<8sIIIIIIHHI', b'.idata', len(sec), va, len(sec), raw, 0, 0, 0, 0, 0xc0000040)
    hdr = bytes(mz) + coff + bytes(opt) + sh
    return hdr + b'\0' * (raw - len(hdr)) + bytes(sec)

# two imports by name
pe = build_pe([('KERNEL32.dll', ['GetTickCount']), ('USER32.dll', ['FindWindowA'])])
imps = ir.pe_imports(pe)
assert dict(imps) == {('KERNEL32.dll', 'GetTickCount'): 1, ('USER32.dll', 'FindWindowA'): 1}, imps
r = ir.classify(imps)
assert r == {'hidden-input': ['KERNEL32!GetTickCount'], 'singleton-probe': ['USER32!FindWindowA']}, r
assert ir.single_instance(r)

# by ordinal, and a name that is no risk
imps = ir.pe_imports(build_pe([('COMCTL32.DLL', [17]), ('KERNEL32.DLL', ['ExitProcess', 'CreateMutexA'])]))
assert set(imps) == {('COMCTL32.DLL', '#17'), ('KERNEL32.DLL', 'ExitProcess'), ('KERNEL32.DLL', 'CreateMutexA')}, imps
r = ir.classify(imps)
assert r == {'singleton-probe': ['KERNEL32!CreateMutexA']} and ir.single_instance(r), r
assert not ir.single_instance(ir.classify([('USER32', 'RegisterWindowMessageA')]))

# not PE
assert ir.pe_imports(b'MZ' + b'\0' * 0x80) is None
assert ir.pe_imports(b'hello') is None

# 16-bit by ordinal and by name
r = ir.classify([('USER', '#13'), ('KERNEL', '#102'), ('USER', 'MESSAGEBOX'), ('KERNEL', '#13'), ('USER', '#237')])
assert r == {'hidden-input': ['KERNEL!DOS3Call', 'USER!GetTickCount'], 'modal': ['USER!MessageBox']}, r

# a real NE
src = None
for dp, _, fs in os.walk(ir.INPUTS):
    for f in fs:
        if f.upper() == 'PROGMAN.EXE': src = os.path.join(dp, f)
if src:
    assert ir.scan(src)[0] == 'NE' and ir.pe_imports(src) is None
    r = ir.classify(ne(src)[6])
    assert 'KERNEL!DOS3Call' in r['hidden-input'] and 'USER!GlobalAddAtom' in r['singleton-probe'], r
    print('real NE', os.path.basename(src), {c: len(v) for c, v in r.items()})
else:
    print('skip real NE: no PROGMAN.EXE under', ir.INPUTS)
print('ok')
