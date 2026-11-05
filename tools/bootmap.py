#!/usr/bin/env python3
"""The boot's map, by static analysis of the Windows files a disk holds and the stand-in table (win32.js, ne16.js),
nothing run: what a boot of them would meet before the emulator meets it. Writes findings/bootmap.json and prints
what it found.

python3 tools/bootmap.py <folder of the disk's Windows files> [--roots GDI.EXE,USER.EXE] [--scripts <folder>]

The boot closure grows from the roots' LibEntry (Windows 98's GDI.EXE loads GDI32 and, through GDI32's colour
matching, ICM32, MSCMS and USER32): each 16-bit module's imports and the files its code names (KERNEL's LoadLibrary
and LoadLibraryEx32W), each 32-bit module's imports and the files its code names before a LoadLibrary. Over that
closure:

1. Thunk order. A 32-bit DLL's DllMain hands its 16-bit half its target tables (KERNEL32's ThunkInitSL, ThunkInitLS,
   ThunkInitLSF, ThunkConnect32: the 16-bit module and the export holding the thunk data are string immediates).
   A 16-bit module's stubs load the table's address from a variable (`mov bx, var; mov edx, es:[bx]; ... jmp
   KERNEL.#630`, C16ThkSL) that only the DllMain writes. So: a 16-bit module whose LibEntry reaches such a stub needs
   that DllMain first; and the DllMain's ThunkInitSL loads the 16-bit module if it is not there, running its LibEntry
   under the DllMain, before the table is written: the module's LibEntry must wait (ne16.js initAfter32). Both are
   checked against ne16.js. (USER.EXE, loaded by USER32's ThunkInitSL under ICM32's load from GDI's LibEntry, ran its
   LibEntry before USER32 had written its tables and jumped through the unset one.)
   And the tables' targets themselves: a global a target reads that only another target writes, where the 16-bit
   LibEntry reaches the reader and not the writer, is read unset. (GDI32's colour matcher loader, SL target 8, read
   the matcher table at 1F8FEh that only target 10, IcmInit, writes; GDI's LibEntry calls 8 and never 10.)
2. Stand-in answers dereferenced. A stand-in that can answer 0, or a handle with no memory behind it (jsDll's
   10000000h+n), whose caller reads through EAX within the next instructions: MSVCRT's __heap_select reads the PE
   header through GetModuleHandleA(NULL), which answered 0 for the system's process.
3. Imports nothing provides: a 32-bit import of a stand-in DLL that is neither defined (def) nor an export of the
   file (whose common unimplemented stub the loader takes), a disk DLL's export that is not there; a 16-bit import
   of an ordinal the module's file does not export (or, for a JS16 module, def16 does not define).

The register-level semantics, the timing and the state a boot meets stay the emulator's; this pass takes what the
files decide. Reach is by direct jumps and calls (near, and far through the relocations): a call through a pointer
is not followed, so "the LibEntry does not call" means "not by a direct path".

Run over the disk the first boot found (Windows 95's GDI.EXE and USER.EXE left beside Windows 98's GDI32 and USER32),
it reports MSVCRT+3A90's read through GetModuleHandleA(NULL) and GDI's LibEntry reading the colour matcher table
(GDI32+1F8FE) through target 8 with target 9 never called; over Windows 98's own files, USER32's SL table has the
same shape at USER32+E2EC (target 1 reads what targets 25 and 26 write).
"""
import json, os, re, struct, sys
from collections import defaultdict
import capstone
from capstone import x86_const as X

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = {a.split('=')[0][2:]: (a.split('=', 1)[1] if '=' in a else True) for a in sys.argv[1:] if a.startswith('--')}
if not args: print(__doc__); sys.exit(1)
DISK = args[0]; SCRIPTS = opt.get('scripts', ROOT)
ROOTS = [r.upper() for r in str(opt.get('roots', 'GDI.EXE,USER.EXE')).split(',')]
ROOTS_KEYS = {r.rsplit('.', 1)[0] for r in ROOTS}
u16 = lambda d, o: struct.unpack_from('<H', d, o)[0]
u32 = lambda d, o: struct.unpack_from('<I', d, o)[0]
md32 = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32); md32.detail = True
md16 = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_16); md16.detail = True

files = {}   # upper file name -> path
for n in os.listdir(DISK): files[n.upper()] = os.path.join(DISK, n)
def find_file(name):
    name = name.upper().replace('/', '\\').split('\\')[-1]
    if name in files: return files[name]
    if '.' not in name:
        for ext in ('.DLL', '.EXE', '.DRV'):
            if name + ext in files: return files[name + ext]
    return None
def modname(path): return os.path.basename(path).upper().rsplit('.', 1)[0]

# ---------------------------------------------------------------- the files: a PE at its preferred base, an NE by segment
class PE:
    def __init__(self, path):
        self.path = path; self.name = modname(path); d = self.d = open(path, 'rb').read()
        pe = u32(d, 0x3c); o = pe + 24; self.base = u32(d, o + 28); self.entry = u32(d, o + 16); size = u32(d, o + 56)
        nsec = u16(d, pe + 6); sh = o + u16(d, pe + 20); img = bytearray(size); img[:u32(d, o + 60)] = d[:u32(d, o + 60)]
        self.text = []; self.data = []
        for i in range(nsec):
            s = sh + 40 * i; vs, va, rs, ro, ch = u32(d, s + 8), u32(d, s + 12), u32(d, s + 16), u32(d, s + 20), u32(d, s + 36)
            n = min(rs, vs or rs); img[va:va + n] = d[ro:ro + n]
            (self.text if ch & 0x20000020 else self.data).append((self.base + va, self.base + va + max(vs, rs)))
        self.img = bytes(img); self.size = size; self.entry += self.base
        R32 = lambda r: u32(img, r) if 0 <= r <= size - 4 else 0; R16 = lambda r: u16(img, r) if 0 <= r <= size - 2 else 0   # (by RVA)
        self.exports = {}; self.ord = {}   # name -> va, ordinal -> va
        ex = u32(d, o + 96)
        if ex:
            nf, nn, fa, na, oa, ob = R32(ex + 20), R32(ex + 24), R32(ex + 28), R32(ex + 32), R32(ex + 36), R32(ex + 16)
            for k in range(nf):
                r = R32(fa + 4 * k)
                if r: self.ord[ob + k] = self.base + r
            for k in range(nn): self.exports[self.str(R32(na + 4 * k))] = self.base + R32(fa + 4 * R16(oa + 2 * k))
        self.imports = {}   # IAT va -> (DLL, name)
        imp = u32(d, o + 104)
        while imp and R32(imp + 12):
            dll = self.str(R32(imp + 12)).upper().replace('.DLL', ''); lut = R32(imp) or R32(imp + 16); iat = R32(imp + 16); k = 0
            while R32(lut + 4 * k):
                v = R32(lut + 4 * k); nm = '#%d' % (v & 0xffff) if v & 0x80000000 else self.str(v + 2)
                self.imports[self.base + iat + 4 * k] = (dll, nm); k += 1
            imp += 20
        self.stubs = {}   # va of `jmp [iat]` -> import
        for lo, hi in self.text:
            for m in re.finditer(rb'\xff\x25(....)', self.img[lo - self.base:hi - self.base], re.S):
                t = struct.unpack('<I', m.group(1))[0]
                if t in self.imports: self.stubs[lo + m.start()] = self.imports[t]
    def r8(self, a): return self.img[a - self.base] if self.base <= a < self.base + self.size else 0
    def r16(self, a): return u16(self.img, a - self.base) if 0 <= a - self.base <= self.size - 2 else 0
    def r32(self, a): return u32(self.img, a - self.base) if 0 <= a - self.base <= self.size - 4 else 0
    def str(self, a):
        o = a - self.base if a >= self.base else a
        if not 0 <= o < self.size: return ''
        e = self.img.find(b'\0', o); return self.img[o:e if e >= 0 else o + 64].decode('latin1')
    def in_text(self, a): return any(lo <= a < hi for lo, hi in self.text)
    def in_data(self, a): return any(lo <= a < hi for lo, hi in self.data)
    def in_image(self, a): return self.base <= a < self.base + self.size
    def insn(self, a):
        o = a - self.base
        for i in md32.disasm(self.img[o:o + 16], a): return i
        return None
    def import_at(self, a):
        """the import a call or jump reaches: through [IAT], or a stub that jumps through one"""
        return self.imports.get(a) or self.stubs.get(a)

class NE:
    def __init__(self, path):
        self.path = path; self.name = modname(path); d = self.d = open(path, 'rb').read(); n = self.n = u32(d, 0x3c)
        self.modname = ''
        self.flags = u16(d, n + 0xc); self.entry = (u16(d, n + 0x16), u16(d, n + 0x14)); nseg = u16(d, n + 0x1c)
        seg_off, imp_off, modref_off, align = u16(d, n + 0x22), u16(d, n + 0x2a), u16(d, n + 0x28), u16(d, n + 0x32) or 9
        self.mods = []
        for i in range(u16(d, n + 0x1e)):
            p = n + imp_off + u16(d, n + modref_off + 2 * i); self.mods.append(d[p + 1:p + 1 + d[p]].decode('latin1').upper())
        self.impname = lambda o: d[n + imp_off + o + 1:n + imp_off + o + 1 + d[n + imp_off + o]].decode('latin1')
        self.segs = {}   # 1-based -> dict(data, code, relocs: off -> target)
        for i in range(nseg):
            so = n + seg_off + 8 * i; off = u16(d, so) << align; ln = u16(d, so + 2) or 0x10000; fl = u16(d, so + 4)
            data = d[off:off + ln] if off else b'\0' * ln; relocs = {}
            if off and fl & 0x100:
                rp = off + ln; nr = u16(d, rp); rp += 2
                for k in range(nr):
                    typ, f, ro, t1, t2 = d[rp], d[rp + 1], u16(d, rp + 2), u16(d, rp + 4), u16(d, rp + 6); rp += 8
                    kind = f & 3
                    if kind == 0: tgt = ('int', t1, t2) if t1 != 0xff else ('ord', self.name, t2)   # (seg, off) or own ordinal
                    elif kind == 1: tgt = ('ord', self.mods[t1 - 1] if 0 < t1 <= len(self.mods) else '?', t2)
                    elif kind == 2: tgt = ('name', self.mods[t1 - 1] if 0 < t1 <= len(self.mods) else '?', self.impname(t2))
                    else: tgt = ('os', t1, t2)
                    o2 = ro; seen = set()
                    while 0 <= o2 < ln and o2 not in seen:
                        seen.add(o2); relocs[o2] = (typ, tgt)
                        if f & 4: break
                        nxt = u16(data, o2) if o2 + 2 <= ln else 0xffff
                        if nxt in (0xffff, 0): break
                        o2 = nxt
            self.segs[i + 1] = dict(data=data, code=not (fl & 1), relocs=relocs, len=ln)
        self.names = {}
        for base, first in ((n + u16(d, n + 0x26), True), (u32(d, n + 0x2c), True)):
            p = base; f1 = first
            while 0 <= p < len(d) and d[p]:
                s = d[p + 1:p + 1 + d[p]].decode('latin1'); o = u16(d, p + 1 + d[p]); p += 3 + d[p]
                if f1: f1 = False; self.modname = self.modname or s; continue
                self.names[o] = s
        self.ents = {}   # ordinal -> (seg, off)
        p = n + u16(d, n + 4); ordn = 1
        while True:
            cnt = d[p]; p += 1
            if cnt == 0: break
            typ = d[p]; p += 1
            for i in range(cnt):
                if typ == 0: ordn += 1; continue
                if typ == 0xff: self.ents[ordn] = (d[p + 3], u16(d, p + 4)); p += 6
                else: self.ents[ordn] = (typ, u16(d, p + 1)); p += 3
                ordn += 1
        self.exports = {v: k for k, v in self.names.items()}   # name -> ordinal
    def at(self, seg, off): return self.segs[seg]['data'] if seg in self.segs else b''
    def insn(self, seg, off):
        d = self.at(seg, off)
        for i in md16.disasm(d[off:off + 16], off): return i
        return None
    def reloc_in(self, seg, off, size):
        """the relocation a slice of an instruction carries, if any: (address type, target); a segment-only fixup
        (type 2) leaves the offset in the instruction"""
        r = self.segs[seg]['relocs']
        for k in range(1, size):
            if off + k in r: return r[off + k]
        return None
    def sym(self, seg, off):
        for o, (s, f) in self.ents.items():
            if (s, f) == (seg, off): return self.names.get(o, '#%d' % o)
        return None

# ---------------------------------------------------------------- the stand-in table: win32.js's def(), ne16.js's K()/KR()/def16()
def read(p):
    try: return open(p).read()
    except OSError: return ''
JS = {n: read(os.path.join(SCRIPTS, n)) for n in ('win32.js', 'ne16.js')}
DEF32 = defaultdict(dict)   # DLL -> name -> body text
for src in JS.values():
    for m in re.finditer(r"^(?:def\('([A-Z0-9_.]+)', '([^']+)'|(K|KR)\('([^']+)')", src, re.M):
        dll, name = (m.group(1), m.group(2)) if m.group(1) else ('KERNEL32', m.group(4))
        end = src.find('\n', m.end()); nxt = re.compile(r"^(?:def\(|def16\(|K\(|KR\(|/\*\*|// ----)", re.M).search(src, end + 1)
        DEF32[dll][name] = src[m.start():nxt.start() if nxt else end + 400][:4000]
DEF32_PREFIX = defaultdict(set)   # DLL -> name prefixes defined in a loop (KR('FT_Exit' + n, ...))
for m in re.finditer(r"(?:K|KR)\('([A-Za-z0-9_]+)' \+ ", JS['ne16.js']): DEF32_PREFIX['KERNEL32'].add(m.group(1))
def defined32(dll, name): return name in DEF32.get(dll, {}) or any(name.startswith(p) for p in DEF32_PREFIX.get(dll, ()))
# the DLLs the system bundle carries as modules of their own (their exports are the module's, not stand-ins')
BUNDLED = set()
try:
    with open(os.path.join(SCRIPTS, 'system.js'), 'rb') as f:
        for m in re.finditer(rb'"([A-Z0-9_]+)\.DLL":\{"', f.read()): BUNDLED.add(m.group(1).decode())
except OSError: pass
DEF16 = defaultdict(set)   # module -> ordinals
for m in re.finditer(r"def16\('([A-Z0-9_]+)', (\d+)", JS['ne16.js']): DEF16[m.group(1)].add(int(m.group(2)))
for m in re.finditer(r"'([A-Z0-9_]+)\.#(\d+)'", JS['ne16.js']): DEF16[m.group(1)].add(int(m.group(2)))   # (an export answered under its key)
eq = re.search(r'const KERNEL_EQUATES = \{([^}]*)\}', JS['ne16.js'])   # (KERNEL's data exports: constants)
if eq: DEF16['KERNEL'].update(int(x) for x in re.findall(r'(\d+):', eq.group(1)))
JS16 = set(re.findall(r"'([A-Z0-9_]+)'", (re.search(r'const JS16 = \[([^\]]*)\]', JS['ne16.js']) or re.search(r'JS16 = \[([^\]]*)\]', JS['ne16.js']) or [None, ''])[1] if True else ''))
INIT_AFTER = set(re.findall(r"'([A-Z0-9]+)'", re.search(r'initAfter32 = new Set\(([^;]*)\);', JS['ne16.js']).group(1))) if re.search(r'initAfter32 = new Set\(', JS['ne16.js']) else set()
BOOT_ORDER = re.findall(r"'([A-Z0-9]+)'", (re.search(r"for \(const m of \[([^\]]*)\]\) this\.loadLibrary16\(m, true\)", JS['ne16.js']) or [None, ''])[1])
# a stand-in that can answer 0 or a handle with no memory behind it: one that answers an address or a handle (a module's
# base, jsDll's, a block's) and whose body has a way to answer nothing
POINTERISH = re.compile(r'Handle|Address|Alloc|Lock\b|Load|Strings|Environment|CommandLine|Ptr|View|Heap(Re)?Alloc|Create|Open|Map')
def may_answer_nothing(name, body):
    return bool(re.search(r'\breturn 0\b|[?:] 0\)|: 0;|\? 0 :|jsDll\(|return null\b|\|\| 0\b', body)) and bool(POINTERISH.search(name) or re.search(r'\.base\b|jsDll\(', body))

# ---------------------------------------------------------------- the boot closure
mods = {}   # name -> PE | NE
loads = defaultdict(set)   # name -> names it brings (imports, LoadLibrary strings)
DLLNAME = re.compile(rb'[A-Z0-9_$~!@#%&()-]{1,8}\.(?:DLL|EXE|DRV)\0', re.I)
def load(name):
    key = name.upper().rsplit('.', 1)[0]
    if key in mods: return mods[key]
    p = find_file(name)
    if not p: return None
    d = open(p, 'rb').read(0x40)
    if len(d) < 0x40 or d[:2] != b'MZ': return None
    full = open(p, 'rb').read(); n = u32(full, 0x3c)
    m = PE(p) if full[n:n + 2] == b'PE' else NE(p) if full[n:n + 2] == b'NE' else None
    if m: mods[key] = m
    return m
LOADER32 = {'LoadLibraryA', 'LoadLibraryExA', 'LoadLibraryW', 'LoadLibraryExW'}
def pe_reach(pe, entries):
    """code reachable from the entries by direct jumps and calls: addresses of its instructions, in discovery order"""
    seen = set(); order = []; todo = list(entries); pe.prev = {}
    while todo:
        a = todo.pop()
        while a not in seen and pe.in_text(a):
            i = pe.insn(a)
            if not i: break
            seen.add(a); order.append(a)
            g = i.groups
            if (X.X86_GRP_JUMP in g or X.X86_GRP_CALL in g) and i.operands and i.operands[0].type == X.X86_OP_IMM:
                t = i.operands[0].imm & 0xffffffff
                if pe.in_text(t): todo.append(t)
            if i.mnemonic == 'ret' or X.X86_GRP_RET in g or i.mnemonic in ('jmp', 'ljmp') or i.mnemonic in ('int3', 'hlt'): break
            pe.prev[a + i.size] = a; a += i.size
    return seen, order
def import_of(pe, i):
    """the import a call or jump reaches: through [IAT], or a stub that jumps through one"""
    op = i.operands[0] if i.operands else None
    if op is None: return None
    if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.index == 0: return pe.imports.get(op.mem.disp & 0xffffffff)
    if op.type == X.X86_OP_IMM: return pe.stubs.get(op.imm & 0xffffffff)
    return None
def calls_loader(pe, f, n=48):
    """a function whose first instructions call LoadLibrary: its callers hand it the file's name (GDI32's colour
    matcher loader, given ICM32.DLL)"""
    a = f
    for _ in range(n):
        i = pe.insn(a)
        if not i or not pe.in_text(a): return False
        if i.mnemonic == 'call':
            imp = import_of(pe, i)
            if imp and imp[1] in LOADER32: return True
        if i.mnemonic in ('ret', 'jmp') or X.X86_GRP_RET in i.groups: return False
        a += i.size
def pe_loads(pe, insns):
    """file names the code hands LoadLibrary: a string immediate within the instructions before a call to one, or to a
    function that calls one at once"""
    out = set(); loaders = {}
    for a in insns:
        i = pe.insn(a)
        if i.mnemonic != 'call': continue
        imp = import_of(pe, i)
        if not imp or imp[1] not in LOADER32:
            t = i.operands[0].imm & 0xffffffff if i.operands[0].type == X.X86_OP_IMM else None
            if t is None or t in pe.stubs or not pe.in_text(t): continue
            if t not in loaders: loaders[t] = calls_loader(pe, t)
            if not loaders[t]: continue
        x = a
        for _ in range(12):
            x = pe.prev.get(x)
            if x is None: break
            j = pe.insn(x)
            for o in j.operands:
                if o.type == X.X86_OP_IMM and pe.in_image(o.imm & 0xffffffff):
                    s = pe.str(o.imm & 0xffffffff)
                    if re.fullmatch(r'[A-Za-z0-9_$~!@#%&()-]{1,8}\.[Dd][Ll][Ll]', s): out.add(s.upper())
    return out
def pe_strings(pe, insns):
    """file names the code names as immediates"""
    out = set()
    for a in insns:
        i = pe.insn(a)
        for op in i.operands:
            if op.type == X.X86_OP_IMM and pe.in_image(op.imm & 0xffffffff):
                s = pe.str(op.imm & 0xffffffff)
                if re.fullmatch(r'[A-Za-z0-9_$~!@#%&()-]{1,8}\.(?:[Dd][Ll][Ll]|[Ee][Xx][Ee])', s): out.add(s.upper())
    return out
def ne_strings(ne):
    out = set()
    for s in ne.segs.values():   # (code segments too: GDI.EXE's thunk data names GDI32.DLL beside its stubs; DLLs only: a program a module names is not loaded by it)
        for m in DLLNAME.finditer(s['data']):
            n = m.group(0)[:-1].decode().upper()
            if n.endswith('.DLL'): out.add(n)
    return out
todo = list(ROOTS); closure = []
while todo:
    n = todo.pop(0); key = n.upper().rsplit('.', 1)[0]
    if key in mods or key in ('KERNEL', 'KRNL386'): continue
    m = load(n)
    if not m: continue
    closure.append(key)
    if isinstance(m, NE):
        for imp in m.mods: loads[key].add(imp); todo.append(imp)
        for s in ne_strings(m): loads[key].add(s.rsplit('.', 1)[0]); todo.append(s)
    else:
        m.reach, m.order = pe_reach(m, [m.entry] + list(m.exports.values()))
        for dll, nm in set(m.imports.values()): loads[key].add(dll); todo.append(dll)
        for s in pe_loads(m, m.order): loads[key].add(s.rsplit('.', 1)[0]); todo.append(s)

# ---------------------------------------------------------------- 1. thunk order
def pushes_before(pe, a, n=6):
    """the immediates pushed in the block before `a` (nearest first), through a `pop edx ... push edx` return shuffle"""
    block = []; x = a
    while pe.prev.get(x) is not None: x = pe.prev[x]; block.append(x)
    shuffle = bool(block) and pe.insn(block[-1]).mnemonic == 'pop'   # (a stub that pops its return address and pushes it back after its own arguments)
    out = []
    for x in block:
        if len(out) >= n: break
        i = pe.insn(x)
        if i.mnemonic == 'push' and i.operands[0].type == X.X86_OP_IMM: out.append(i.operands[0].imm & 0xffffffff)
        elif i.mnemonic == 'push' and shuffle and i.operands[0].type == X.X86_OP_REG and i.reg_name(i.operands[0].reg) == 'edx': pass
        elif i.mnemonic == 'pop': pass
        elif i.mnemonic in ('mov', 'lea') and i.operands[0].type == X.X86_OP_REG: pass
        elif i.mnemonic == 'push': out.append(None)
        else: break
    return out
inits = []   # {dll32, call, kind, dll16, export16, table}
KINDS = {'#41': 'ThunkInitLSF', '#43': 'ThunkInitLS', '#46': 'ThunkInitSL', '#44': 'ThunkInitSL(F)', 'ThunkConnect32': 'ThunkConnect32'}
for key in closure:
    m = mods[key]
    if not isinstance(m, PE): continue
    for a in m.order:
        i = m.insn(a)
        if i.mnemonic not in ('call', 'jmp') or not i.operands: continue
        op = i.operands[0]; imp = None
        if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.index == 0: imp = m.imports.get(op.mem.disp & 0xffffffff)
        elif op.type == X.X86_OP_IMM: imp = m.stubs.get(op.imm & 0xffffffff)
        if not imp or imp[0] != 'KERNEL32' or imp[1] not in KINDS: continue
        ps = pushes_before(m, a)
        s = lambda v: m.str(v) if v and m.in_image(v) else None
        if imp[1] == 'ThunkConnect32':   # (td, f16, m16, m32, hmod, reason): the thunk data first, by its magic
            k = next((n for n, v in enumerate(ps) if v and m.in_image(v) and m.str(v)[:4] in ('LS01', 'SL01', 'LB01')), None)
            if k is None: continue
            rec = dict(dll32=key, at='%s+%x' % (key, a - m.base), kind=KINDS[imp[1]], table=ps[k], export16=s(ps[k + 1]) if len(ps) > k + 1 else None, dll16=s(ps[k + 2]) if len(ps) > k + 2 else None)
            if rec['dll16'] and rec['export16']: inits.append(rec)
            continue
        # (thunk, thkbuf, len, dll16); in a stub entered by a jump after the return address was popped and pushed back
        # (GDI32's), the 16-bit module's name was pushed by the stub's callers
        rec = dict(dll32=key, at='%s+%x' % (key, a - m.base), kind=KINDS[imp[1]], table=ps[0] if ps else None, export16=s(ps[1]) if len(ps) > 1 else None, dll16=s(ps[3]) if len(ps) > 3 else None)
        if not rec['export16']: continue
        if rec['dll16']: inits.append(rec); continue
        start = a
        while m.prev.get(start) is not None: start = m.prev[start]
        callers = [c for c in m.order if (lambda j: j.mnemonic == 'call' and j.operands[0].type == X.X86_OP_IMM and (j.operands[0].imm & 0xffffffff) == start)(m.insn(c))]
        for c in callers:
            cps = pushes_before(m, c, 2)
            if cps and s(cps[0]): inits.append(dict(rec, dll16=s(cps[0]), at='%s+%x' % (key, c - m.base)))
# the 16-bit stubs: `mov ax, seg; mov es, ax; mov bx, var; mov edx, es:[bx]` ... `ljmp KERNEL.#630`, entered by `mov cx, n; jmp`
stubs16 = []   # {mod, seg, common, var: (seg, off), export, targets: {cx: (off, name)}}
for key in closure:
    m = mods[key]
    if not isinstance(m, NE): continue
    for sn, s in m.segs.items():
        if not s['code']: continue
        d = s['data']
        for mm in re.finditer(rb'\xb8(..)\x8e\xc0\xbb(..)\x66\x26\x8b\x17', d, re.S):   # (re.S: a byte of 0Ah is no line end)
            var = u16(mm.group(2), 0); rel = s['relocs'].get(mm.start() + 1)
            vseg = rel[1][1] if rel and rel[1][0] == 'int' else None
            common = mm.start()
            # whose export holds the far pointer (var's segment and offset at +4..+8 of the thunk data)
            export = None
            for o, (es, eo) in m.ents.items():
                if es != sn: continue
                sd = m.segs[es]['data']
                if eo + 8 <= len(sd) and u16(sd, eo + 4) == var and m.segs[es]['relocs'].get(eo + 6, (0, ('', -1)))[1][1:2] == (vseg,): export = m.names.get(o, '#%d' % o)
            targets = {}
            for t in re.finditer(rb'\xb9(..)(?:\xeb(.)|\xe9(..))', d, re.S):
                cx = u16(t.group(1), 0); nxt = t.end()
                dst = (nxt + struct.unpack('<b', t.group(2))[0]) & 0xffff if t.group(2) else (nxt + struct.unpack('<h', t.group(3))[0]) & 0xffff
                # (a stub jumps to the common block, or to a jump that does)
                for _ in range(3):
                    if dst == common: break
                    j = m.insn(sn, dst)
                    if j and j.mnemonic == 'jmp' and j.operands[0].type == X.X86_OP_IMM: dst = j.operands[0].imm & 0xffff
                    else: break
                if dst == common: targets[cx] = (t.start(), m.sym(sn, t.start()))
            stubs16.append(dict(mod=key, seg=sn, common=common, var=(vseg, var), export=export, targets=targets))
# which stubs a 16-bit module's LibEntry reaches: recursive descent over near jumps/calls and far ones through relocations
def ne_reach(m, start):
    seen = set(); todo = [start]
    while todo:
        seg, off = todo.pop()
        while (seg, off) not in seen and seg in m.segs and m.segs[seg]['code'] and off < m.segs[seg]['len']:
            i = m.insn(seg, off)
            if not i: break
            seen.add((seg, off)); g = i.groups
            rel = m.reloc_in(seg, off, i.size)
            if rel:
                typ, tgt = rel; imm = (i.operands[-1].imm & 0xffff) if i.operands and i.operands[-1].type == X.X86_OP_IMM else 0   # (a far call's operands: segment, then offset)
                if tgt[0] == 'int': todo.append((tgt[1], imm if typ == 2 else tgt[2]))
                elif tgt[0] == 'ord' and tgt[1] == m.name and tgt[2] in m.ents: todo.append(m.ents[tgt[2]])
            if (X.X86_GRP_JUMP in g or X.X86_GRP_CALL in g) and i.operands and i.operands[0].type == X.X86_OP_IMM and i.mnemonic in ('jmp', 'call', 'loop', 'jcxz') or (i.mnemonic.startswith('j') and i.operands and i.operands[0].type == X.X86_OP_IMM):
                if i.mnemonic not in ('ljmp', 'lcall'): todo.append((seg, i.operands[0].imm & 0xffff))
            if i.mnemonic in ('ret', 'retf', 'iret', 'jmp', 'ljmp', 'int3', 'hlt') or X.X86_GRP_RET in g: break
            off += i.size
    return seen
order_findings = []
for key in closure:
    m = mods[key]
    if not isinstance(m, NE) or not m.entry[0]: continue
    reach = ne_reach(m, m.entry); m.reach16 = reach
    for st in [s for s in stubs16 if s['mod'] == key]:
        hit = {cx: t for cx, t in st['targets'].items() if (st['seg'], t[0]) in reach}
        writers = [i for i in inits if i['dll16'] and i['dll16'].upper().rsplit('.', 1)[0] == key and (i['export16'] or '').upper() == (st['export'] or '').upper()]
        st['libentry_calls'] = sorted(hit); st['writers'] = [w['dll32'] for w in writers]
        if hit:
            order_findings.append(dict(kind='libentry-needs-table', mod=key, export=st['export'], via=[w['dll32'] + ' ' + w['kind'] for w in writers] or ['no 32-bit DllMain writes it'],
                targets=['cx %x%s' % (cx, ' ' + t[1] if t[1] else '') for cx, t in sorted(hit.items())], deferred=key in INIT_AFTER,
                ok=key in INIT_AFTER or not writers,
                why="%s's LibEntry calls through %s's table, written by %s's DllMain: that DllMain first, so the LibEntry waits (ne16.js initAfter32: %s)" % (key, st['export'], ', '.join(sorted({w['dll32'] for w in writers})) or 'nothing', 'yes' if key in INIT_AFTER else 'NO')))
# a DllMain's ThunkInitSL loads its 16-bit half if it is not there: that half's LibEntry runs under the DllMain, before the table
for i in inits:
    k16 = i['dll16'].upper().rsplit('.', 1)[0]
    if k16 not in mods or not isinstance(mods[k16], NE): continue
    order_findings.append(dict(kind='dllmain-loads-half', dll32=i['dll32'], dll16=k16, export=i['export16'], at=i['at'], deferred=k16 in INIT_AFTER, ok=k16 in INIT_AFTER,
        why="%s's DllMain (%s %s) loads %s when it is not loaded yet: %s's LibEntry would run under it, before the table is written (ne16.js initAfter32: %s)" % (i['dll32'], i['kind'], i['export16'], k16, k16, 'yes' if k16 in INIT_AFTER else 'NO')))
# the SL tables' targets: globals a target reads that only another writes
def pe_globals(pe, start, depth=2):
    reads, writes = {}, {}
    def walk(a, dep, seen):
        todo = [a]
        while todo:
            x = todo.pop()
            while x not in seen and pe.in_text(x):
                i = pe.insn(x)
                if not i: break
                seen.add(x)
                for n, op in enumerate(i.operands):
                    if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.index == 0 and pe.in_data(op.mem.disp & 0xffffffff):
                        g = op.mem.disp & 0xffffffff
                        if n == 0 and i.mnemonic not in ('cmp', 'test', 'push'): writes.setdefault(g, x)
                        else: reads.setdefault(g, x)
                        if i.mnemonic in ('add', 'sub', 'or', 'and', 'inc', 'dec') and n == 0: reads.setdefault(g, x)
                if i.mnemonic == 'call' and i.operands[0].type == X.X86_OP_IMM and dep > 0:
                    t = i.operands[0].imm & 0xffffffff
                    if pe.in_text(t) and t not in pe.stubs: walk(t, dep - 1, seen)
                if i.mnemonic in ('ret', 'jmp') or X.X86_GRP_RET in i.groups: break
                if i.mnemonic.startswith('j') and i.operands[0].type == X.X86_OP_IMM: todo.append(i.operands[0].imm & 0xffffffff)
                x += i.size
    walk(start, depth, set()); return reads, writes
table_findings = []
for i in inits:
    if i['kind'] != 'ThunkInitSL' or not i['table']: continue
    pe = mods[i['dll32']]; t = i['table']
    if not pe.in_image(t): continue
    entries = []
    while pe.in_text(pe.r32(t + 4 * len(entries))) and len(entries) < 64: entries.append(pe.r32(t + 4 * len(entries)))
    k16 = i['dll16'].upper().rsplit('.', 1)[0]
    st = next((s for s in stubs16 if s['mod'] == k16 and (s['export'] or '').upper() == i['export16'].upper()), None)
    called = set(st['libentry_calls']) if st else set()
    per = []
    for n, relay in enumerate(entries):
        # the relay's worker: the last direct call before its jump back
        worker = None; a = relay
        for _ in range(40):
            ins = pe.insn(a)
            if not ins: break
            if ins.mnemonic == 'call' and ins.operands[0].type == X.X86_OP_IMM and pe.in_text(ins.operands[0].imm & 0xffffffff) and (ins.operands[0].imm & 0xffffffff) not in pe.stubs: worker = ins.operands[0].imm & 0xffffffff
            if ins.mnemonic == 'jmp': break
            a += ins.size
        r, w = pe_globals(pe, worker) if worker else ({}, {})
        per.append(dict(n=n, cx=4 * n, relay=relay, worker=worker, reads=r, writes=w))
    inside = set()   # (the table's targets' own writes: a write anywhere else in the image, the DllMain's or an export's, sets the global)
    for q in per:
        if q['worker']: inside.update(pe_globals(pe, q['worker'])[1].values())
    for p in per:
        for g, at in p['reads'].items():
            writers = [q['n'] for q in per if g in q['writes']]
            if not writers or p['n'] in writers or g in p['writes']: continue
            others = [x for x in pe.order if (lambda ins: ins.operands and ins.operands[0].type == X.X86_OP_MEM and ins.operands[0].mem.base == 0 and ins.operands[0].mem.index == 0 and (ins.operands[0].mem.disp & 0xffffffff) == g and ins.mnemonic not in ('cmp', 'test', 'push'))(pe.insn(x))]
            if any(x not in inside for x in others): continue
            if p['cx'] in called and not any(4 * wn in called for wn in writers):
                table_findings.append(dict(dll32=i['dll32'], export16=i['export16'], mod16=k16, target=p['n'], cx=p['cx'], reads='%s+%x' % (i['dll32'], g - pe.base), at='%s+%x' % (i['dll32'], at - pe.base), writers=writers,
                    why="%s's LibEntry calls %s target %d (cx %x), which reads %s+%x, written only by target%s %s, which the LibEntry does not call: read unset" % (k16, i['export16'], p['n'], p['cx'], i['dll32'], g - pe.base, 's' if len(writers) > 1 else '', ', '.join(str(x) for x in writers))))
    i['targets'] = [dict(n=p['n'], relay='%x' % p['relay'], worker='%x' % p['worker'] if p['worker'] else None) for p in per]
    i['libentry_calls'] = sorted(called)

# ---------------------------------------------------------------- 2. stand-in answers dereferenced
deref_findings = []
EAX = {X.X86_REG_EAX, X.X86_REG_AX, X.X86_REG_AL, X.X86_REG_AH}
for key in closure:
    m = mods[key]
    if not isinstance(m, PE): continue
    for a in m.order:
        i = m.insn(a)
        if i.mnemonic != 'call': continue
        op = i.operands[0]; imp = None
        if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.index == 0: imp = m.imports.get(op.mem.disp & 0xffffffff)
        elif op.type == X.X86_OP_IMM: imp = m.stubs.get(op.imm & 0xffffffff)
        if not imp or imp[0] not in DEF32 or imp[1] not in DEF32[imp[0]] or not may_answer_nothing(imp[1], DEF32[imp[0]][imp[1]]): continue
        # the instructions after: a memory operand based on EAX before EAX is written again (a test of it first is a check)
        x = a + i.size; checked = False
        for _ in range(8):
            j = m.insn(x)
            if not j: break
            if j.mnemonic in ('test', 'cmp', 'or') and any(o.type == X.X86_OP_REG and o.reg in EAX for o in j.operands) and not any(o.type == X.X86_OP_MEM for o in j.operands): checked = True; break
            if j.mnemonic.startswith('j') or j.mnemonic in ('ret', 'call'): break
            hit = j.mnemonic != 'lea' and any(o.type == X.X86_OP_MEM and o.mem.base in EAX for o in j.operands)
            if hit:
                deref_findings.append(dict(dll=key, at='%s+%x' % (key, x - m.base), call='%s!%s' % imp, insn='%s %s' % (j.mnemonic, j.op_str),
                    why="%s+%x reads through EAX right after %s!%s, a stand-in that can answer 0 or a handle with no memory behind it" % (key, x - m.base, imp[0], imp[1]))); break
            if any(o.type == X.X86_OP_REG and o.reg in EAX and n == 0 for n, o in enumerate(j.operands)) and j.mnemonic not in ('test', 'cmp'): break
            x += j.size

# ---------------------------------------------------------------- 3. imports nothing provides
import_findings = []
UNIMP = re.compile(rb'\x33\xc0\xb1.(?:\xe9|\xeb)', re.S)   # KERNEL32's CommonUnimpStub, as a DLL's file exports an unimplemented call
for key in closure:
    m = mods[key]
    if isinstance(m, PE):
        for dll, nm in sorted(set(m.imports.values())):
            if defined32(dll, nm): continue
            f = load(dll); has = bool(f and isinstance(f, PE) and (nm in f.exports or (nm.startswith('#') and int(nm[1:]) in f.ord)))
            if dll in DEF32 and dll not in BUNDLED:   # (a stand-in with no module of its own: its defs, else the file's unimplemented stub)
                va = f and isinstance(f, PE) and (f.exports.get(nm) or (nm.startswith('#') and f.ord.get(int(nm[1:]))))
                stub = bool(va and UNIMP.match(f.img[va - f.base:va - f.base + 6]))
                if not stub: import_findings.append(dict(dll=key, imports='%s!%s' % (dll, nm), why='no stand-in; %s' % ('the file exports real code for it, not the unimplemented stub: a dead thunk' if has else 'the file does not export it' if f else 'no file')))
            elif not f: import_findings.append(dict(dll=key, imports='%s!%s' % (dll, nm), why='no such DLL on the disk and no stand-in'))
            elif not has: import_findings.append(dict(dll=key, imports='%s!%s' % (dll, nm), why='the file does not export it'))
    else:
        for sn, s in m.segs.items():
            for off, (typ, tgt) in s['relocs'].items():
                if tgt[0] == 'ord' and tgt[1] != m.name:
                    mod, o = tgt[1], tgt[2]
                    if mod in ('KERNEL', 'KRNL386'): f = None; ok = o in DEF16['KERNEL']
                    else:
                        f = load(mod); ok = bool(f and isinstance(f, NE) and o in f.ents) or (mod in JS16 and o in DEF16[mod])
                    if not ok and (f or mod in ('KERNEL', 'KRNL386') or mod in JS16): import_findings.append(dict(dll=key, imports='%s.#%d' % (mod, o), at='%d:%04x' % (sn, off), why='the module does not export the ordinal' if f else 'no def16 for it'))
                elif tgt[0] == 'name' and tgt[1] != m.name:
                    f = load(tgt[1])
                    if f and isinstance(f, NE) and tgt[2].upper() not in f.exports: import_findings.append(dict(dll=key, imports='%s.%s' % (tgt[1], tgt[2]), at='%d:%04x' % (sn, off), why='the module does not export the name'))
import_findings = list({(x['dll'], x['imports']): x for x in import_findings}.values())

# ---------------------------------------------------------------- the report
out = dict(disk=os.path.abspath(DISK), roots=ROOTS, closure=closure, loads={k: sorted(v) for k, v in loads.items()},
    boot_order=BOOT_ORDER, init_after32=sorted(INIT_AFTER), bundled=sorted(BUNDLED),
    reach16={k: len(getattr(mods[k], 'reach16', ())) for k in closure if isinstance(mods[k], NE)},
    reach16segs={k: {str(s): sum(1 for q in getattr(mods[k], 'reach16', ()) if q[0] == s) for s in mods[k].segs} for k in closure if isinstance(mods[k], NE) and k in ROOTS_KEYS},
    reach16stubs={'%s/%d' % (s['mod'], s['seg']): sorted('%04x' % q[1] for q in getattr(mods[s['mod']], 'reach16', ()) if q[0] == s['seg']) for s in stubs16},
    reach32={k: len(mods[k].order) for k in closure if isinstance(mods[k], PE)},
    thunk_inits=[{k: ('%x' % v if isinstance(v, int) else v) for k, v in i.items()} for i in inits],
    stubs16=[dict(mod=s['mod'], seg=s['seg'], export=s['export'], var='%s:%04x' % (s['var'][0], s['var'][1]), targets={'%x' % cx: t[1] or '%04x' % t[0] for cx, t in sorted(s['targets'].items())}, libentry_calls=['%x' % c for c in s.get('libentry_calls', [])], writers=s.get('writers', [])) for s in stubs16],
    order=order_findings, tables=table_findings, derefs=deref_findings, imports=import_findings)
os.makedirs(os.path.join(ROOT, 'findings'), exist_ok=True)
with open(os.path.join(ROOT, 'findings', 'bootmap.json'), 'w') as f: json.dump(out, f, indent=1)
print('closure from %s: %s' % (', '.join(ROOTS), ' '.join(closure)))
print('boot order (ne16.js bootUser16): %s, then USER; LibEntry deferred: %s' % (' '.join(BOOT_ORDER), ' '.join(sorted(INIT_AFTER))))
print('\n1. thunk order')
for f in order_findings: print('  %s %s' % ('ok ' if f['ok'] else 'BAD', f['why']))
for f in table_findings: print('  BAD %s' % f['why'])
if not order_findings and not table_findings: print('  (nothing)')
print('\n2. stand-in answers dereferenced')
for f in deref_findings: print('  BAD %s: %s' % (f['why'], f['insn']))
if not deref_findings: print('  (nothing)')
print('\n3. imports nothing provides (%d)' % len(import_findings))
for f in import_findings[:60]: print('  %s imports %s: %s' % (f['dll'], f['imports'], f['why']))
if len(import_findings) > 60: print('  ... %d more in findings/bootmap.json' % (len(import_findings) - 60))
