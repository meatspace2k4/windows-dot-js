"""Static recompiler: 32-bit x86 Win32 PE images -> WebAssembly.

Every guest basic block becomes one wasm function returning the next guest EIP.
Guest registers and flags live in wasm globals, guest memory is the imported
linear memory (guest address == wasm address), and calls/returns go through the
guest stack. `run(eip)` dispatches blocks until EIP hits the sentinel, an import
thunk (handled by the JS Win32 layer, which may ask to yield) or an unknown
address. The x87 stack lives in linear memory.

usage: recomp.py IMAGE OUT_BASENAME [--base ADDR] [--lookup ADDR]
--base relocates the image (using its .reloc table) before translation; --lookup places the
module's block table. Registers are imported mutable globals so modules share one CPU state.
`run` returns 3 when control leaves the module (another module or an import thunk handled by JS).
writes OUT_BASENAME.wasm and OUT_BASENAME.json (block map + image hash).
"""
import hashlib, json, os, struct, sys
import capstone
from capstone import x86_const as X

# ---------------------------------------------------------------- layout shared with the JS runtime
SENTINEL = 0xFFFFFFF0
THUNK_BASE = 0xFFFF0000
THUNK16_BASE = 0xFFFE0000      # 16-bit import thunks (selector THUNK16_SEL)
THUNK16_SEL = 0xFFF7
LDT_BASE = 0x00030000          # 8192 x {base u32, limit u32}, indexed by selector >> 3; access rights u32 at +0x10000
FPU_BASE = 0x00010000          # 8 x f64 registers
LOOKUP_BYTES = 0x01000000     # per-module table (i32 per code byte: block id + 1) lives at a caller-chosen base
MEM_PAGES = 2048               # 128 MiB

# ---------------------------------------------------------------- wasm encoding
def uleb(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def sleb(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if (n == 0 and not b & 0x40) or (n == -1 and b & 0x40): out.append(b); return bytes(out)
        out.append(b | 0x80)
def s32(v): v &= 0xffffffff; return v - (1 << 32) if v & 0x80000000 else v
def vec(items): return uleb(len(items)) + b''.join(items)
def name(s): b = s.encode(); return uleb(len(b)) + b
I32, I64, F32, F64 = 0x7f, 0x7e, 0x7d, 0x7c

G = {n: i for i, n in enumerate(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
                                  'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
                                  # segment selectors and their cached bases (segmented NE code)
                                  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb'])}
REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']

# imported functions (index order matters)
IMPORTS = [('api', [I32], [I32]), ('trap', [I32, I32], []),
           ('fsin', [F64], [F64]), ('fcos', [F64], [F64]), ('ftan', [F64], [F64]), ('fatan2', [F64, F64], [F64]),
           ('fexp2', [F64], [F64]), ('flog2', [F64], [F64]), ('fmod', [F64, F64], [F64]), ('frem', [F64, F64], [F64]),
           ('f80load', [I32], [F64]), ('f80store', [I32, F64], []), ('btrace', [I32], [])]
IMP = {n: i for i, (n, _, _) in enumerate(IMPORTS)}
NIMP = len(IMPORTS)

CF, PF, ZF, SF, OF = 1, 2, 4, 8, 16
ALLF = CF | PF | ZF | SF | OF
FLAG_G = {CF: 'cf', PF: 'pf', ZF: 'zf', SF: 'sf', OF: 'of'}

# ---------------------------------------------------------------- PE parsing
def u16(d, o): return struct.unpack_from('<H', d, o)[0]
def u32(d, o): return struct.unpack_from('<I', d, o)[0]
class PE:
    def __init__(self, data):
        self.data = data; p = u32(data, 0x3c); opt = p + 24
        self.base = u32(data, opt + 28); self.entry = self.base + u32(data, opt + 16) if u32(data, opt + 16) else 0
        self.size = u32(data, opt + 56)
        self.secs = []
        for i in range(u16(data, p + 6)):
            o = opt + u16(data, p + 20) + 40 * i
            nm = data[o:o + 8].rstrip(b'\0').decode('latin1')
            vs, va, rs, ro, ch = u32(data, o + 8), u32(data, o + 12), u32(data, o + 16), u32(data, o + 20), u32(data, o + 36)
            self.secs.append((nm, va, vs, ro, rs, ch))
        self.image = bytearray(self.size)
        self.image[:u32(data, opt + 60)] = data[:u32(data, opt + 60)]
        for nm, va, vs, ro, rs, ch in self.secs:
            n = min(rs, vs or rs); self.image[va:va + n] = data[ro:ro + n]
        rel_rva, rel_sz = u32(data, opt + 96 + 5 * 8), u32(data, opt + 96 + 5 * 8 + 4)
        self.relocs = []
        o = rel_rva
        while rel_sz and o < rel_rva + rel_sz:
            page, blk = u32(self.image, o), u32(self.image, o + 4)
            if not blk: break
            for k in range((blk - 8) // 2):
                e = u16(self.image, o + 8 + 2 * k)
                if e >> 12 == 3: self.relocs.append(page + (e & 0xfff))
            o += blk
        self.code = [(va, max(vs, rs)) for nm, va, vs, ro, rs, ch in self.secs if ch & 0x20000000]
        self.pref = self.base
    def rebase(self, nb):
        delta = (nb - self.base) & 0xffffffff
        for r in self.relocs:
            v = (u32(self.image, r) + delta) & 0xffffffff
            struct.pack_into('<I', self.image, r, v)
        if self.entry: self.entry = (self.entry - self.base + nb) & 0xffffffff
        self.base = nb
    def in_code(self, va):
        r = va - self.base
        return any(a <= r < a + n for a, n in self.code)
    def u32va(self, va): return u32(self.image, va - self.base)

class LE:
    """A VxD (LE image) laid out the way PE is: its objects one after another from the load base, every internal
    fixup applied, the code objects as code. Entry points are the procedures its DDB names (control, V86 API,
    PM API) and its service table; an INT 20h is a VxDCall/VMMCall with the service's dword after it."""
    VXD = True
    def __init__(self, data, base=0x10000):
        self.data = data; le = u32(data, 0x3c); assert data[le:le + 2] == b'LE'
        self.pgsz = u32(data, le + 0x28); last = u32(data, le + 0x2c); objtab = le + u32(data, le + 0x40); nobj = u32(data, le + 0x44)
        fpt = le + u32(data, le + 0x68); frt = le + u32(data, le + 0x6c); datapg = u32(data, le + 0x80); npages = u32(data, le + 0x14)
        enttab = le + u32(data, le + 0x5c)
        objs = []
        for i in range(nobj):
            vsize, ob, flags, pgidx, pgcnt, _ = struct.unpack_from('<6I', data, objtab + 24 * i)
            objs.append(dict(vsize=vsize, flags=flags, pgidx=pgidx, pgcnt=pgcnt))
        off = 0
        for o in objs: o['rva'] = off; off += (o['vsize'] + 0xfff) & ~0xfff
        self.size = off; self.image = bytearray(off); self.base = base; self.pref = base; self.relocs = []
        for o in objs:
            for k in range(o['pgcnt']):
                pg = o['pgidx'] + k; n = self.pgsz if pg < npages else last; src = datapg + (pg - 1) * self.pgsz
                self.image[o['rva'] + k * self.pgsz:o['rva'] + k * self.pgsz + n] = data[src:src + n]
        for o in objs:
            for k in range(o['pgcnt']):
                pg = o['pgidx'] + k - 1; q, end = frt + u32(data, fpt + 4 * pg), frt + u32(data, fpt + 4 * pg + 4)
                while q < end:
                    src, fl = data[q], data[q + 1]; q += 2
                    if src & 0x20: cnt = data[q]; q += 1; offs = None
                    else: offs = [struct.unpack_from('<h', data, q)[0]]; q += 2
                    assert fl & 3 == 0, 'import fixup in a VxD'
                    if fl & 0x40: tobj = u16(data, q); q += 2
                    else: tobj = data[q]; q += 1
                    toff = 0
                    if src & 0xf != 2:
                        if fl & 0x10: toff = u32(data, q); q += 4
                        else: toff = u16(data, q); q += 2
                    if offs is None: offs = [struct.unpack_from('<h', data, q + 2 * i)[0] for i in range(cnt)]; q += 2 * cnt
                    val = base + objs[tobj - 1]['rva'] + toff
                    for so in offs:
                        at = o['rva'] + k * self.pgsz + so
                        if at < 0 or at + 4 > off: continue
                        if src & 0xf == 7: struct.pack_into('<I', self.image, at, val & 0xffffffff); self.relocs.append(at)
                        elif src & 0xf == 8: struct.pack_into('<i', self.image, at, s32(val - (base + at + 4)))
                        elif src & 0xf == 5: struct.pack_into('<H', self.image, at, val & 0xffff)
        self.objs = objs
        self.code = [(o['rva'], o['vsize']) for o in objs if o['flags'] & 4]   # executable objects
        # the DDB: the first entry of the first bundle
        tobj = u16(data, enttab + 2); self.ddb = base + objs[tobj - 1]['rva'] + u32(data, enttab + 5)
        d = self.ddb - base
        self.vxd_id = u16(self.image, d + 6); self.vxd_name = bytes(self.image[d + 0xc:d + 0x14]).rstrip(b' \0').decode('latin1')
        self.procs = dict(control=u32(self.image, d + 0x18), v86=u32(self.image, d + 0x1c), pm=u32(self.image, d + 0x20))
        svc, nsvc = u32(self.image, d + 0x24), u32(self.image, d + 0x28)
        self.services = [u32(self.image, svc - base + 4 * i) for i in range(nsvc)] if svc and nsvc else []
        self.entry = 0
    def entries(self): return [a for a in list(self.procs.values()) + self.services if a and self.in_code(a)]
    def rebase(self, nb): raise ValueError('a VxD loads at the base given to LE()')
    def in_code(self, va):
        r = va - self.base
        return any(a <= r < a + n for a, n in self.code)
    def u32va(self, va): return u32(self.image, va - self.base)

# ---------------------------------------------------------------- discovery
class Insn:
    __slots__ = ('i', 'addr', 'size', 'next', 'mn', 'ops', 'prefix', 'live', 'id', 'segbase', 'bits', 'tgt', 'farsel')
    def __init__(self): self.segbase = None; self.bits = 32; self.tgt = None; self.farsel = None

def imm_target(ins):
    """linear target of a direct branch, or None"""
    if ins.tgt is not None: return ins.tgt
    if ins.ops and ins.ops[0].type == X.X86_OP_IMM and ins.segbase is None: return ins.ops[0].imm & 0xffffffff
    return None
def decode_all(pe):
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32); md.detail = True
    insns, todo, seen_entries = {}, [pe.entry] if pe.entry else [], set()
    todo += pe.entries() if getattr(pe, 'VXD', False) else export_entries(pe)
    reloc_vals = [pe.u32va(pe.base + r) for r in pe.relocs]
    data_refs = set()
    def walk(start):
        a = start
        while a not in insns:
            if not pe.in_code(a): return
            off = a - pe.base
            got = next(md.disasm(bytes(pe.image[off:off + 16]), a, 1), None)
            if got is None: return
            ins = Insn(); ins.i = got; ins.addr = a; ins.size = got.size; ins.next = a + got.size
            ins.mn = got.mnemonic.split()[-1]; ins.ops = got.operands; ins.prefix = got.prefix
            if getattr(pe, 'VXD', False) and got.bytes[:2] == b'\xcd\x20': ins.size = 6; ins.next = a + 6   # VxDCall: the service dword follows
            insns[a] = ins
            for op in got.operands:
                if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.disp: data_refs.add(op.mem.disp & 0xffffffff)
            g = got.groups
            if capstone.CS_GRP_JUMP in g or capstone.CS_GRP_CALL in g:
                if imm_target(ins) is not None: todo.append(imm_target(ins))
            if ins.mn in ('jmp', 'ljmp', 'ret', 'retf', 'hlt', 'int3', 'ud2') or ins.mn.startswith('iret'): return
            a = ins.next
    while True:
        while todo:
            t = todo.pop()
            if t not in seen_entries: seen_entries.add(t); walk(t)
        # relocated pointers into code that are not used as data operands are code entries
        new = [v for v in reloc_vals if pe.in_code(v) and v not in seen_entries and v not in data_refs]
        if not new: break
        todo.extend(new)
    return insns, seen_entries

def export_entries(pe):
    d = pe.data; p = u32(d, 0x3c); rva = u32(d, p + 24 + 96)
    if not rva: return []
    img = pe.image; n = u32(img, rva + 20); funcs = u32(img, rva + 28)
    return [pe.base + u32(img, funcs + 4 * i) for i in range(n) if u32(img, funcs + 4 * i)]

FLOW = ('loop', 'loope', 'loopne', 'jcxz', 'jecxz', 'lcall', 'ljmp', 'int', 'into')
def ends_block(ins):
    g = ins.i.groups
    return capstone.CS_GRP_JUMP in g or capstone.CS_GRP_CALL in g or ins.mn.startswith('ret') or ins.mn in FLOW
def build_blocks(pe, insns, entries):
    starts = set(e for e in entries if e in insns)
    starts |= {a for a, i in insns.items() if i.mn in ('div', 'idiv')}   # restartable after a divide fault
    for ins in insns.values():
        if ends_block(ins):
            if ins.next in insns: starts.add(ins.next)
            t = imm_target(ins)
            if t is not None and t in insns: starts.add(t)
    blocks = {}
    for s in sorted(starts):
        lst, a = [], s
        while a in insns:
            ins = insns[a]; lst.append(ins); a = ins.next
            if ends_block(ins) or ins.mn in ('hlt', 'int3', 'ud2', 'iret', 'iretd'): break
            if a in starts: break
        blocks[s] = lst
    return blocks

# ---------------------------------------------------------------- flag liveness
COND = {'o': OF, 'no': OF, 'b': CF, 'ae': CF, 'e': ZF, 'ne': ZF, 'be': CF | ZF, 'a': CF | ZF,
        's': SF, 'ns': SF, 'p': PF, 'np': PF, 'l': SF | OF, 'ge': SF | OF, 'le': ZF | SF | OF, 'g': ZF | SF | OF}
def cond_of(mn):
    for p in ('set', 'cmov', 'j'):
        if mn.startswith(p) and mn[len(p):] in COND: return mn[len(p):]
    return None
def flag_use_def(ins):
    mn = ins.mn
    c = cond_of(mn)
    if c: return COND[c], 0
    if mn in ('add', 'sub', 'cmp', 'neg', 'and', 'or', 'xor', 'test', 'imul', 'mul', 'cmpsb', 'cmpsw', 'cmpsd', 'scasb', 'scasw', 'scasd', 'popfd', 'sahf', 'xadd', 'cmpxchg', 'bsf', 'bsr'):
        if mn in ('cmpsb', 'cmpsw', 'cmpsd', 'scasb', 'scasw', 'scasd') and ins.prefix[0]: return ALLF, ALLF
        return 0, ALLF
    if mn in ('adc', 'sbb'): return CF, ALLF
    if mn in ('inc', 'dec'): return 0, ALLF & ~CF
    if mn in ('shl', 'sal', 'shr', 'sar', 'shld', 'shrd', 'rol', 'ror'):
        cnt = ins.ops[-1] if len(ins.ops) > 1 else None
        d = ALLF if mn not in ('rol', 'ror') else CF | OF
        if cnt is not None and cnt.type == X.X86_OP_IMM and cnt.imm & 31: return 0, d
        return d, d
    if mn in ('rcl', 'rcr'): return CF, CF | OF
    if mn in ('bt', 'bts', 'btr', 'btc', 'clc', 'stc', 'cmc'): return (CF if mn == 'cmc' else 0), CF
    if mn in ('lahf', 'pushfd', 'pushf', 'adc', 'sbb'): return ALLF, 0
    if mn == 'popf': return 0, ALLF
    return 0, 0

ALL_FLAGS = CF | PF | ZF | SF | OF
def liveness(blocks):
    # Flags are tracked precisely only along direct jumps and fall-through. Returns, calls, far and indirect
    # transfers keep every flag live: hand-written code returns status in CF/ZF across `ret`.
    succ, opaque = {}, set()
    for s, lst in blocks.items():
        last = lst[-1]; out = []
        g = last.i.groups
        if last.mn in ('jmp', 'ljmp') or capstone.CS_GRP_CALL in g or last.mn.startswith('ret') or last.mn in ('int', 'into', 'iret', 'iretd', 'lcall'):
            if last.mn == 'jmp' and imm_target(last) is not None: out.append(imm_target(last))
            else: opaque.add(s)
        elif capstone.CS_GRP_JUMP in g or last.mn in ('loop', 'loope', 'loopne', 'jcxz', 'jecxz'):
            out += [imm_target(last), last.next]
        else: out.append(last.next)
        succ[s] = [t for t in out if t in blocks]
        if len(succ[s]) < len([t for t in out if t is not None]): opaque.add(s)
    live_in = {s: 0 for s in blocks}
    changed = True
    while changed:
        changed = False
        for s in sorted(blocks, reverse=True):
            live = ALL_FLAGS if s in opaque else 0
            for t in succ[s]: live |= live_in[t]
            for ins in reversed(blocks[s]):
                ins.live = live
                u, d = flag_use_def(ins)
                live = u | (live & ~d)
            if live != live_in[s]: live_in[s] = live; changed = True

# ---------------------------------------------------------------- code emission
class Fn:
    """One wasm function body. Locals: i32 t0.., i64 q0.., f64 d0.."""
    NI, NQ, ND = 24, 6, 6
    def __init__(self, nparams=0):
        self.b = bytearray(); self.np = nparams; self.ti = 0; self.tq = 0; self.td = 0
    def e(self, *bs):
        for x in bs: self.b += x if isinstance(x, (bytes, bytearray)) else bytes([x])
        return self
    def i(self):
        assert self.ti < self.NI, 'out of i32 temps'; v = self.np + self.ti; self.ti += 1; return v
    def q(self): v = self.np + self.NI + self.tq; self.tq += 1; return v
    def d(self): v = self.np + self.NI + self.NQ + self.td; self.td += 1; return v
    def c(self, v): return self.e(0x41, sleb(s32(v)))
    def c64(self, v): return self.e(0x42, sleb(v))
    def cf(self, v): return self.e(0x44, struct.pack('<d', v))
    def lg(self, i): return self.e(0x20, uleb(i))
    def ls(self, i): return self.e(0x21, uleb(i))
    def lt(self, i): return self.e(0x22, uleb(i))
    def gg(self, n): return self.e(0x23, uleb(G[n]))
    def gs(self, n): return self.e(0x24, uleb(G[n]))
    def mem(self, op): return self.e(op, 0, 0)   # align 0, offset 0
    def body(self):
        loc = vec([uleb(self.NI) + bytes([I32]), uleb(self.NQ) + bytes([I64]), uleb(self.ND) + bytes([F64])])
        code = loc + bytes(self.b) + b'\x0b'
        return uleb(len(code)) + code

OPS = dict(add=0x6a, sub=0x6b, mul=0x6c, div_s=0x6d, div_u=0x6e, rem_s=0x6f, rem_u=0x70, and_=0x71, or_=0x72, xor=0x73,
           shl=0x74, shr_s=0x75, shr_u=0x76, rotl=0x77, rotr=0x78, eqz=0x45, eq=0x46, ne=0x47, lt_s=0x48, lt_u=0x49,
           gt_s=0x4a, gt_u=0x4b, le_s=0x4c, le_u=0x4d, ge_s=0x4e, ge_u=0x4f, clz=0x67, ctz=0x68, popcnt=0x69)
Q = dict(add=0x7c, sub=0x7d, mul=0x7e, div_s=0x7f, div_u=0x80, rem_s=0x81, rem_u=0x82, and_=0x83, or_=0x84, xor=0x85,
         shl=0x86, shr_s=0x87, shr_u=0x88, eqz=0x50, eq=0x51, ne=0x52, lt_s=0x53)
WRAP, EXT_S, EXT_U = 0xa7, 0xac, 0xad
D = dict(add=0xa0, sub=0xa1, mul=0xa2, div=0xa3, min=0xa4, max=0xa5, abs=0x99, neg=0x9a, ceil=0x9b, floor=0x9c,
         trunc=0x9d, nearest=0x9e, sqrt=0x9f, eq=0x61, ne=0x62, lt=0x63, gt=0x64, le=0x65, ge=0x66)
SELECT, DROP, RETURN = 0x1b, 0x1a, 0x0f
LOAD = {1: 0x2d, 2: 0x2f, 4: 0x28}; LOADS = {1: 0x2c, 2: 0x2e, 4: 0x28}; STORE = {1: 0x3a, 2: 0x3b, 4: 0x36}
MASK = {1: 0xff, 2: 0xffff, 4: 0xffffffff}

R32 = {X.X86_REG_EAX: 0, X.X86_REG_ECX: 1, X.X86_REG_EDX: 2, X.X86_REG_EBX: 3, X.X86_REG_ESP: 4, X.X86_REG_EBP: 5, X.X86_REG_ESI: 6, X.X86_REG_EDI: 7}
R16 = {X.X86_REG_AX: 0, X.X86_REG_CX: 1, X.X86_REG_DX: 2, X.X86_REG_BX: 3, X.X86_REG_SP: 4, X.X86_REG_BP: 5, X.X86_REG_SI: 6, X.X86_REG_DI: 7}
R8L = {X.X86_REG_AL: 0, X.X86_REG_CL: 1, X.X86_REG_DL: 2, X.X86_REG_BL: 3}
R8H = {X.X86_REG_AH: 0, X.X86_REG_CH: 1, X.X86_REG_DH: 2, X.X86_REG_BH: 3}
ST = {getattr(X, 'X86_REG_ST%d' % i): i for i in range(8)}

class Unsupported(Exception): pass

def reginfo(r):
    if r in R32: return REGS[R32[r]], 4, 0
    if r in R16: return REGS[R16[r]], 2, 0
    if r in R8L: return REGS[R8L[r]], 1, 0
    if r in R8H: return REGS[R8H[r]], 1, 8
    raise Unsupported('reg %d' % r)

class Loc:
    """An operand resolved for reading and writing (memory address held in a local)."""
    def __init__(self, f, op, size=None):
        self.f, self.op = f, op; self.size = size or op.size; self.addr = None
        if op.type == X.X86_OP_MEM:
            self.addr = f.i(); emit_addr(f, op.mem); f.ls(self.addr)
    def read(self, signed=False):
        f, op, sz = self.f, self.op, self.size
        if op.type == X.X86_OP_IMM:
            v = op.imm & MASK[sz]
            if signed and sz < 4 and v & (1 << (8 * sz - 1)): v -= 1 << (8 * sz)
            return f.c(v)
        if op.type == X.X86_OP_MEM:
            return f.lg(self.addr).mem((LOADS if signed else LOAD)[sz])
        g, rs, sh = reginfo(op.reg)
        f.gg(g)
        if rs == 4: return f
        if sh: f.c(8).e(OPS['shr_u'])
        if signed: f.c(32 - 8 * rs).e(OPS['shl']).c(32 - 8 * rs).e(OPS['shr_s'])
        else: f.c(MASK[rs]).e(OPS['and_'])
        return f
    def write(self, val):
        f, op, sz = self.f, self.op, self.size
        if op.type == X.X86_OP_MEM:
            f.lg(self.addr); val(); f.mem(STORE[sz]); return
        g, rs, sh = reginfo(op.reg)
        if rs == 4: val(); f.gs(g); return
        f.gg(g).c(~(MASK[rs] << sh)).e(OPS['and_'])
        val(); f.c(MASK[rs]).e(OPS['and_'])
        if sh: f.c(sh).e(OPS['shl'])
        f.e(OPS['or_']).gs(g)

# ---- segmented (NE) mode. CUR is the instruction being translated.
CUR = None
def segmode(): return CUR is not None and CUR.segbase is not None
# flat code that has just loaded a 16-bit SS (USER32's callback relays: `lss sp, [ebx]` then a 16-bit retf back into
# USER.EXE) addresses the stack as SS:SP for the rest of that block
STK16 = False
def stack16(): return segmode() or STK16
def opsize(ins):
    d = 4 if ins.bits == 32 else 2
    return (6 - d) if ins.prefix[2] == 0x66 else d
def addr16(ins): return ins.i.addr_size == 2
SREG = {X.X86_REG_CS: ('cs', 'csb'), X.X86_REG_DS: ('ds', 'dsb'), X.X86_REG_ES: ('es', 'esb'), X.X86_REG_SS: ('ss', 'ssb'),
        X.X86_REG_FS: ('fsel', 'fs'), X.X86_REG_GS: ('gsel', 'gsb')}
SELBASE = {}   # selector -> linear base, known at build time
def sel_base(f):
    """selector on stack -> its linear base from the LDT in guest memory"""
    f.c(3).e(OPS['shr_u']).c(3).e(OPS['shl']).c(LDT_BASE).e(OPS['add']).mem(0x28)
def load_sreg(f, reg, val):
    s, b = SREG[reg]; t = f.i(); val(); f.c(0xffff).e(OPS['and_']).ls(t)
    f.lg(t).gs(s); f.lg(t); sel_base(f); f.gs(b)

def load_sreg_flat(f, reg, val):
    """flat code loading ES or GS: an LDT selector (TI bit) gets its base, the flat ones (GDT) base 0"""
    s, b = SREG[reg]; t = f.i(); val(); f.c(0xffff).e(OPS['and_']).ls(t)
    f.lg(t).gs(s); f.lg(t); sel_base(f); f.c(0); f.lg(t).c(4).e(OPS['and_']); f.e(SELECT); f.gs(b)

def emit_addr(f, m, seg=True):
    parts = 0
    if m.base:
        g, _, _ = reginfo(m.base); f.gg(g); parts += 1
    if m.index:
        g, _, _ = reginfo(m.index); f.gg(g)
        if m.scale > 1: f.c({2: 1, 4: 2, 8: 3}[m.scale]).e(OPS['shl'])
        if parts: f.e(OPS['add'])
        parts += 1
    if m.disp or not parts:
        f.c(m.disp)
        if parts: f.e(OPS['add'])
        parts += 1
    if segmode():
        if addr16(CUR): f.c(0xffff).e(OPS['and_'])
        if seg:
            sreg = m.segment or (X.X86_REG_SS if m.base in (X.X86_REG_BP, X.X86_REG_EBP, X.X86_REG_SP, X.X86_REG_ESP) else X.X86_REG_DS)
            f.gg(SREG[sreg][1]).e(OPS['add'])
        return
    if seg and m.segment == X.X86_REG_FS: f.gg('fs').e(OPS['add'])
    elif seg and m.segment == X.X86_REG_GS: f.gg('gsb').e(OPS['add'])
    elif seg and m.segment == X.X86_REG_ES: f.gg('esb').e(OPS['add'])   # flat code that loaded a 16-bit selector (USER32)
    elif seg and m.segment not in (0, X.X86_REG_DS, X.X86_REG_SS, X.X86_REG_ES, X.X86_REG_CS): raise Unsupported('segment')

# ---- flag helpers. All take locals holding zero-extended operands/result.
def set_szp(f, r, sz, live):
    if live & ZF: f.lg(r).e(OPS['eqz']).gs('zf')
    if live & SF: f.lg(r).c(8 * sz - 1).e(OPS['shr_u']).c(1).e(OPS['and_']).gs('sf')
    if live & PF: f.lg(r).c(0xff).e(OPS['and_']).e(OPS['popcnt']).c(1).e(OPS['and_']).c(1).e(OPS['xor']).gs('pf')

def sp_adjust(f, delta):
    if stack16():   # 16-bit stack: SP wraps within SS, the high half of ESP is preserved
        f.gg('esp').c(~0xffff).e(OPS['and_']).gg('esp').c(delta).e(OPS['add']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('esp')
    else: f.gg('esp').c(delta).e(OPS['add']).gs('esp')
def sp_addr(f):
    if stack16(): f.gg('ssb').gg('esp').c(0xffff).e(OPS['and_']).e(OPS['add'])
    else: f.gg('esp')
def push_val(f, val, size=4):
    # the value is taken before ESP moves, so PUSH ESP stores the old ESP
    t = f.i(); val(); f.ls(t)
    sp_adjust(f, -size)
    sp_addr(f); f.lg(t).mem(STORE[size])
def pop_to(f, t, size=4):
    sp_addr(f); f.mem(LOAD[size]).ls(t); sp_adjust(f, size)

def cond(f, c):
    """push i32 0/1 for condition code c"""
    g = lambda n: f.gg(n)
    if c in ('o', 'no'): g('of')
    elif c in ('b', 'ae'): g('cf')
    elif c in ('e', 'ne'): g('zf')
    elif c in ('be', 'a'): g('cf'); g('zf'); f.e(OPS['or_'])
    elif c in ('s', 'ns'): g('sf')
    elif c in ('p', 'np'): g('pf')
    elif c in ('l', 'ge'): g('sf'); g('of'); f.e(OPS['ne'])
    elif c in ('le', 'g'): g('zf'); g('sf'); g('of'); f.e(OPS['ne']); f.e(OPS['or_'])
    if c in ('no', 'ae', 'ne', 'a', 'ns', 'np', 'ge', 'g'): f.e(OPS['eqz'])

# ---- x87 helpers
def st_addr(f, i):
    f.gg('ftop')
    if i: f.c(i).e(OPS['add'])
    f.c(7).e(OPS['and_']).c(3).e(OPS['shl']).c(FPU_BASE).e(OPS['add'])
def st_get(f, i): st_addr(f, i); f.mem(0x2b)
def st_set(f, i, val):
    st_addr(f, i); val(); f.mem(0x39)
def fpush(f, val):
    t = f.d(); val(); f.ls(t)
    f.gg('ftop').c(1).e(OPS['sub']).c(7).e(OPS['and_']).gs('ftop')
    st_set(f, 0, lambda: f.lg(t))
def fpop(f): f.gg('ftop').c(1).e(OPS['add']).c(7).e(OPS['and_']).gs('ftop')
def fmem_load(f, op, integer=False):
    loc = Loc(f, op); sz = op.size
    if integer:
        if sz == 2: f.lg(loc.addr).mem(0x2e).e(0xb7)          # i32.load16_s, f64.convert_i32_s
        elif sz == 4: f.lg(loc.addr).mem(0x28).e(0xb7)
        else: f.lg(loc.addr).mem(0x29).e(0xb9)                 # f64.convert_i64_s
    else:
        if sz == 4: f.lg(loc.addr).mem(0x2a).e(0xbb)          # f64.promote_f32
        elif sz == 8: f.lg(loc.addr).mem(0x2b)
        else: f.lg(loc.addr).e(0x10, uleb(IMP['f80load']))
def fround(f):
    """round f64 on stack per FCW rounding control: 0 nearest-even, 1 down, 2 up, 3 truncate"""
    t, cur = f.d(), f.d(); f.ls(t)
    rc = f.i(); f.gg('fcw').c(10).e(OPS['shr_u']).c(3).e(OPS['and_']).ls(rc)
    f.lg(t).e(D['nearest']).ls(cur)
    for op, code in (('floor', 1), ('ceil', 2), ('trunc', 3)):
        f.lg(t).e(D[op]).lg(cur).lg(rc).c(code).e(OPS['eq']).e(SELECT).ls(cur)
    f.lg(cur)

class Translator:
    TRACE = False
    def __init__(self, pe, blocks):
        self.pe, self.blocks = pe, blocks
        self.unsupported = {}
    def block(self, start, lst):
        f = Fn()
        if self.TRACE: f.c(start).e(0x10, uleb(IMP['btrace']))
        try:
            global CUR, STK16
            STK16 = False
            for ins in lst:
                f.ti = 0; f.tq = 0; f.td = 0; CUR = ins
                nxt = self.insn(f, ins)
                if nxt is not None: return f
            f.c(lst[-1].next).e(RETURN)
        except Unsupported as e:
            key = '%s %s' % (ins.mn, ins.i.op_str) if 'reg' in str(e) or 'segment' in str(e) else ins.mn
            self.unsupported[key] = self.unsupported.get(key, 0) + 1
            f = Fn(); f.c(ins.addr).c(1).e(0x10, uleb(IMP['trap'])); f.c(SENTINEL).e(RETURN)
        return f

    # returns non-None when the block's terminating return has been emitted
    def insn(self, f, ins):
        mn, ops, live = ins.mn, ins.ops, ins.live
        rep = ins.prefix[0]
        if mn in ('nop', 'fwait', 'wait', 'fnclex', 'fclex', 'ffree', 'lock') or mn.startswith('prefetch'): return
        h = getattr(self, 'x_' + mn, None)
        if h: return h(f, ins, ops, live)
        c = cond_of(mn)
        if c and mn.startswith('j'):
            cond(f, c); t = f.i(); f.ls(t)
            f.c(imm_target(ins)).c(ins.next).lg(t).e(SELECT).e(RETURN); return True
        if c and mn.startswith('set'):
            Loc(f, ops[0]).write(lambda: cond(f, c)); return
        if c and mn.startswith('cmov'):
            d, s = Loc(f, ops[0]), Loc(f, ops[1])
            d.write(lambda: (s.read(), d.read(), cond(f, c), f.e(SELECT))); return
        if mn in ('add', 'sub', 'adc', 'sbb', 'cmp', 'and', 'or', 'xor', 'test'): return self.alu(f, ins, mn)
        if mn.rstrip('bwd') in ('movs', 'stos', 'lods', 'scas', 'cmps') and len(mn) == 5:
            return self.string(f, ins, mn[:4], {'b': 1, 'w': 2, 'd': 4}[mn[4]], rep)
        if mn[:-1] in ('ins', 'outs') and mn[-1] in 'bwd':
            return self.string(f, ins, mn[:-1], {'b': 1, 'w': 2, 'd': 4}[mn[-1]], rep)
        if mn.startswith('f'): return self.fpu(f, ins, mn, ops)
        if mn in ('lds', 'les', 'lss', 'lfs', 'lgs'): return self.lptr(f, ins, ops, {'lds': X.X86_REG_DS, 'les': X.X86_REG_ES, 'lss': X.X86_REG_SS, 'lfs': X.X86_REG_FS, 'lgs': X.X86_REG_GS}[mn])
        raise Unsupported(mn)

    # ---- data movement
    def x_mov(self, f, ins, ops, live):
        if segmode():
            if ops[0].type == X.X86_OP_REG and ops[0].reg in SREG:
                s = Loc(f, ops[1], 2); load_sreg(f, ops[0].reg, lambda: s.read()); return
            if ops[1].type == X.X86_OP_REG and ops[1].reg in SREG:
                Loc(f, ops[0]).write(lambda: f.gg(SREG[ops[1].reg][0])); return
        # flat code: GS and ES may hold a 16-bit selector; the others stay flat
        if ops[0].type == X.X86_OP_REG and ops[0].reg in (X.X86_REG_GS, X.X86_REG_ES):
            s = Loc(f, ops[1], 2); load_sreg_flat(f, ops[0].reg, lambda: s.read()); return
        if ops[1].type == X.X86_OP_REG and ops[1].reg == X.X86_REG_GS:
            Loc(f, ops[0]).write(lambda: f.gg('gsel')); return
        if ops[0].type == X.X86_OP_REG and ops[0].reg in (X.X86_REG_ES, X.X86_REG_DS, X.X86_REG_FS, X.X86_REG_SS): return
        if ops[1].type == X.X86_OP_REG and ops[1].reg in (X.X86_REG_ES, X.X86_REG_DS, X.X86_REG_FS, X.X86_REG_SS, X.X86_REG_CS):
            Loc(f, ops[0]).write(lambda: f.c(0x23)); return
        d, s = Loc(f, ops[0]), Loc(f, ops[1], ops[0].size)
        d.write(lambda: s.read())
    def x_movzx(self, f, ins, ops, live):
        d, s = Loc(f, ops[0]), Loc(f, ops[1]); d.write(lambda: s.read())
    def x_movsx(self, f, ins, ops, live):
        d, s = Loc(f, ops[0]), Loc(f, ops[1])
        d.write(lambda: (s.read(signed=True), f.c(MASK[ops[0].size]).e(OPS['and_'])))
    def x_lea(self, f, ins, ops, live):
        Loc(f, ops[0]).write(lambda: emit_addr(f, ops[1].mem, seg=False))
    def x_xchg(self, f, ins, ops, live):
        a, b = Loc(f, ops[0]), Loc(f, ops[1]); t = f.i(); a.read(); f.ls(t)
        a.write(lambda: b.read()); b.write(lambda: f.lg(t))
    def x_push(self, f, ins, ops, live):
        sz = opsize(ins)    # 66h-prefixed pushes move a word in 32-bit code too (thunk code builds 16-bit frames this way)
        if ops[0].type == X.X86_OP_REG and ops[0].reg in SREG:
            if segmode(): push_val(f, lambda: f.gg(SREG[ops[0].reg][0]), sz)
            elif ops[0].reg == X.X86_REG_GS: push_val(f, lambda: f.gg('gsel'), sz)
            else: push_val(f, lambda: f.c(0x23), sz)
            return
        s = Loc(f, ops[0], sz)
        if ops[0].type == X.X86_OP_IMM: push_val(f, lambda: f.c(ops[0].imm), sz)
        else: push_val(f, lambda: s.read(), sz)
    def x_pop(self, f, ins, ops, live):
        sz = opsize(ins)
        t = f.i(); pop_to(f, t, sz)
        if ops[0].type == X.X86_OP_REG and ops[0].reg in SREG:
            if segmode(): load_sreg(f, ops[0].reg, lambda: f.lg(t))
            elif ops[0].reg in (X.X86_REG_GS, X.X86_REG_ES): load_sreg_flat(f, ops[0].reg, lambda: f.lg(t))
            return
        Loc(f, ops[0], sz).write(lambda: f.lg(t))
    def lptr(self, f, ins, ops, sreg):
        global STK16
        d, m = Loc(f, ops[0]), Loc(f, ops[1], ops[0].size); sz = ops[0].size
        t = f.i(); f.lg(m.addr).mem(LOAD[sz]).ls(t)
        load_sreg(f, sreg, lambda: (f.lg(m.addr), f.c(sz), f.e(OPS['add']), f.mem(0x2f)))
        d.write(lambda: f.lg(t))
        if sreg == X.X86_REG_SS and sz == 2 and not segmode(): STK16 = True
    def x_pushaw(self, f, ins, ops, live):
        t = f.i(); f.gg('esp').ls(t)
        for r in REGS: push_val(f, (lambda r=r: f.lg(t) if r == 'esp' else f.gg(r)), 2)
    def x_popaw(self, f, ins, ops, live):
        t = f.i()
        for r in reversed(REGS):
            pop_to(f, t, 2)
            if r != 'esp': f.gg(r).c(~0xffff).e(OPS['and_']).lg(t).e(OPS['or_']).gs(r)
    def x_pushf(self, f, ins, ops, live):
        def v():
            f.c(0x202).gg('cf').e(OPS['or_'])
            for n, b in (('pf', 2), ('zf', 6), ('sf', 7), ('df', 10), ('of', 11)): f.gg(n).c(b).e(OPS['shl']).e(OPS['or_'])
        push_val(f, v, opsize(ins) if segmode() else 2)
    def x_popf(self, f, ins, ops, live):
        t = f.i(); pop_to(f, t, opsize(ins) if segmode() else 2)
        for n, b in (('cf', 0), ('pf', 2), ('zf', 6), ('sf', 7), ('df', 10), ('of', 11)): f.lg(t).c(b).e(OPS['shr_u']).c(1).e(OPS['and_']).gs(n)
    def x_enter(self, f, ins, ops, live):
        if ops[1].imm & 31: raise Unsupported('enter with nesting')
        sz = opsize(ins) if segmode() else 4
        push_val(f, lambda: f.gg('ebp'), sz)
        if segmode() and sz == 2: f.gg('ebp').c(~0xffff).e(OPS['and_']).gg('esp').c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('ebp')
        else: f.gg('esp').gs('ebp')
        sp_adjust(f, -ops[0].imm)
    def x_xlatb(self, f, ins, ops, live):
        m = ins.ops[0].mem if ins.ops else None
        f.gg('eax').c(~0xff).e(OPS['and_'])
        f.gg('ebx')
        if segmode() and addr16(ins): f.c(0xffff).e(OPS['and_'])
        f.gg('eax').c(0xff).e(OPS['and_']).e(OPS['add'])
        if segmode():
            if addr16(ins): f.c(0xffff).e(OPS['and_'])
            f.gg(SREG[(m.segment if m and m.segment else X.X86_REG_DS)][1]).e(OPS['add'])
        f.mem(0x2d).e(OPS['or_']).gs('eax')
    def x_pushal(self, f, ins, ops, live):
        t = f.i(); f.gg('esp').ls(t)
        for r in REGS: push_val(f, (lambda r=r: f.lg(t) if r == 'esp' else f.gg(r)))
    x_pushad = x_pushal
    def x_popal(self, f, ins, ops, live):
        t = f.i()
        for r in reversed(REGS):
            pop_to(f, t)
            if r != 'esp': f.lg(t).gs(r)
    x_popad = x_popal
    def x_pushfd(self, f, ins, ops, live):
        def v():
            f.c(0x202).gg('cf').e(OPS['or_'])
            for n, b in (('pf', 2), ('zf', 6), ('sf', 7), ('df', 10), ('of', 11)): f.gg(n).c(b).e(OPS['shl']).e(OPS['or_'])
        push_val(f, v)
    def x_popfd(self, f, ins, ops, live):
        t = f.i(); pop_to(f, t)
        for n, b in (('cf', 0), ('pf', 2), ('zf', 6), ('sf', 7), ('df', 10), ('of', 11)): f.lg(t).c(b).e(OPS['shr_u']).c(1).e(OPS['and_']).gs(n)
    def x_leave(self, f, ins, ops, live):
        t = f.i()
        if segmode():
            sz = opsize(ins)
            f.gg('esp').c(~0xffff).e(OPS['and_']).gg('ebp').c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('esp'); pop_to(f, t, sz)
            if sz == 2: f.gg('ebp').c(~0xffff).e(OPS['and_']).lg(t).e(OPS['or_']).gs('ebp')
            else: f.lg(t).gs('ebp')
            return
        f.gg('ebp').gs('esp'); pop_to(f, t); f.lg(t).gs('ebp')
    # 98h/99h mean CBW/CWD or CWDE/CDQ by operand size; capstone names them by the 32-bit form in 16-bit code
    def x_cdq(self, f, ins, ops, live):
        if opsize(ins) == 2: return self.x_cwd(f, ins, ops, live)
        f.gg('eax').c(31).e(OPS['shr_s']).gs('edx')
    def x_cwde(self, f, ins, ops, live):
        if opsize(ins) == 2: return self.x_cbw(f, ins, ops, live)
        f.gg('eax').c(16).e(OPS['shl']).c(16).e(OPS['shr_s']).gs('eax')
    def x_cdq_32(self, f): f.gg('eax').c(31).e(OPS['shr_s']).gs('edx')
    def x_cbw(self, f, ins, ops, live):
        f.gg('eax').c(~0xffff).e(OPS['and_']).gg('eax').c(24).e(OPS['shl']).c(24).e(OPS['shr_s']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
    def x_cwd(self, f, ins, ops, live):
        if opsize(ins) == 4: return self.x_cdq_32(f)
        f.gg('edx').c(~0xffff).e(OPS['and_']).gg('eax').c(16).e(OPS['shl']).c(31).e(OPS['shr_s']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('edx')
    def x_bswap(self, f, ins, ops, live):
        d = Loc(f, ops[0]); t = f.i(); d.read(); f.ls(t)
        d.write(lambda: (f.lg(t).c(24).e(OPS['shl']), f.lg(t).c(8).e(OPS['shl']).c(0xff0000).e(OPS['and_']).e(OPS['or_']),
                         f.lg(t).c(8).e(OPS['shr_u']).c(0xff00).e(OPS['and_']).e(OPS['or_']), f.lg(t).c(24).e(OPS['shr_u']).e(OPS['or_'])))
    def x_cld(self, f, ins, ops, live): f.c(0).gs('df')
    def x_std(self, f, ins, ops, live): f.c(1).gs('df')
    def x_clc(self, f, ins, ops, live): f.c(0).gs('cf')
    def x_stc(self, f, ins, ops, live): f.c(1).gs('cf')
    def x_cmc(self, f, ins, ops, live): f.gg('cf').e(OPS['eqz']).gs('cf')
    def x_sahf(self, f, ins, ops, live):
        for n, b in (('cf', 8), ('pf', 10), ('zf', 14), ('sf', 15)): f.gg('eax').c(b).e(OPS['shr_u']).c(1).e(OPS['and_']).gs(n)
    def x_lahf(self, f, ins, ops, live):
        f.gg('eax').c(~0xff00).e(OPS['and_']).c(0x200).gg('cf').c(8).e(OPS['shl']).e(OPS['or_'])
        for n, b in (('pf', 10), ('zf', 14), ('sf', 15)): f.gg(n).c(b).e(OPS['shl']).e(OPS['or_'])
        f.e(OPS['or_']).gs('eax')

    # ---- control flow
    def target(self, f, ins, op):
        if imm_target(ins) is not None: f.c(imm_target(ins)); return
        if segmode():
            sz = opsize(ins); Loc(f, op, sz).read()
            if sz == 2: f.c(0xffff).e(OPS['and_'])
            f.c(ins.segbase).e(OPS['add'])
        else: Loc(f, op, 4).read()
    def x_jmp(self, f, ins, ops, live): self.target(f, ins, ops[0]); f.e(RETURN); return True
    def x_call(self, f, ins, ops, live):
        t = f.i(); self.target(f, ins, ops[0]); f.ls(t)
        if segmode(): push_val(f, lambda: f.c(ins.next - ins.segbase), opsize(ins))
        else: push_val(f, lambda: f.c(ins.next))
        f.lg(t).e(RETURN); return True
    def x_ret(self, f, ins, ops, live):
        t = f.i()
        if segmode():
            pop_to(f, t, opsize(ins))
            if ops: sp_adjust(f, ops[0].imm)
            f.lg(t).c(ins.segbase).e(OPS['add']).e(RETURN); return True
        pop_to(f, t)
        if ops: f.gg('esp').c(ops[0].imm).e(OPS['add']).gs('esp')
        f.lg(t).e(RETURN); return True
    # far control flow: CS:IP. Targets known at build time are resolved through SELBASE.
    def far_dest(self, f, ins, ops, push_ret):
        sz = opsize(ins); sel, off = f.i(), f.i()
        if ops[0].type == X.X86_OP_IMM:
            f.c(ops[0].imm & 0xffff).ls(sel); f.c(ops[1].imm).ls(off)
        else:
            m = Loc(f, ops[0], sz)
            f.lg(m.addr).mem(LOAD[sz]).ls(off); f.lg(m.addr).c(sz).e(OPS['add']).mem(0x2f).ls(sel)
        if push_ret:
            push_val(f, lambda: f.gg('cs'), sz)
            push_val(f, lambda: f.c(ins.next - (ins.segbase or 0)), sz)
        load_sreg(f, X.X86_REG_CS, lambda: f.lg(sel))
        f.gg('csb').lg(off).e(OPS['add']).e(RETURN); return True
    def x_lcall(self, f, ins, ops, live): return self.far_dest(f, ins, ops, True)
    def x_ljmp(self, f, ins, ops, live): return self.far_dest(f, ins, ops, False)
    def x_retf(self, f, ins, ops, live):
        sz = opsize(ins); off, sel = f.i(), f.i()
        pop_to(f, off, sz); pop_to(f, sel, sz)
        if ops: sp_adjust(f, ops[0].imm)
        load_sreg(f, X.X86_REG_CS, lambda: f.lg(sel))
        f.gg('csb').lg(off).e(OPS['add']).e(RETURN); return True
    def counter(self, f, ins):
        """push CX or ECX per address size, and return a setter for its decremented value"""
        if segmode() and addr16(ins): f.gg('ecx').c(0xffff).e(OPS['and_']); return True
        f.gg('ecx'); return False
    def x_jecxz(self, f, ins, ops, live):
        f.c(imm_target(ins)).c(ins.next); self.counter(f, ins); f.e(OPS['eqz']).e(SELECT).e(RETURN); return True
    x_jcxz = x_jecxz
    def x_loop(self, f, ins, ops, live): return self.loopx(f, ins, None)
    def x_loope(self, f, ins, ops, live): return self.loopx(f, ins, 'e')
    def x_loopne(self, f, ins, ops, live): return self.loopx(f, ins, 'ne')
    def loopx(self, f, ins, cc):
        if segmode() and addr16(ins):
            f.gg('ecx').c(~0xffff).e(OPS['and_']).gg('ecx').c(1).e(OPS['sub']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('ecx')
        else: f.gg('ecx').c(1).e(OPS['sub']).gs('ecx')
        t = f.i(); self.counter(f, ins); f.c(0).e(OPS['ne'])
        if cc: cond(f, cc); f.e(OPS['and_'])
        f.ls(t); f.c(imm_target(ins)).c(ins.next).lg(t).e(SELECT).e(RETURN); return True
    def x_int3(self, f, ins, ops, live):
        f.c(ins.addr).c(3).e(0x10, uleb(IMP['trap'])); f.c(SENTINEL).e(RETURN); return True
    x_hlt = x_int3; x_ud2 = x_int3
    def x_int(self, f, ins, ops, live):
        # the host services the interrupt and leaves the continuation (ins.next, or the sentinel) in the eip global
        f.c(ins.next).c(0x100 + (ops[0].imm & 0xff)).e(0x10, uleb(IMP['trap'])); f.gg('eip').e(RETURN); return True
    # port I/O goes to the host: trap(next, 0x1000000 | in << 23 | size << 16 | port), data in AL/AX/EAX
    def port_io(self, f, ins, port_op, size, is_in):
        f.c(ins.next)
        if port_op.type == X.X86_OP_IMM: f.c(0x1000000 | (is_in << 23) | (size << 16) | (port_op.imm & 0xff))
        else: f.gg('edx').c(0xffff).e(OPS['and_']).c(0x1000000 | (is_in << 23) | (size << 16)).e(OPS['or_'])
        f.e(0x10, uleb(IMP['trap']))
    def x_in(self, f, ins, ops, live): self.port_io(f, ins, ops[1], ops[0].size, 1)
    def x_out(self, f, ins, ops, live): self.port_io(f, ins, ops[0], ops[1].size, 0)
    def x_cli(self, f, ins, ops, live): return
    x_sti = x_cli

    # ---- arithmetic
    def alu(self, f, ins, mn):
        ops, live = ins.ops, ins.live
        d = Loc(f, ops[0]); s = Loc(f, ops[1], ops[0].size); sz = ops[0].size; bits = 8 * sz
        a, b, r = f.i(), f.i(), f.i()
        if mn in ('xor', 'sub') and ops[0].type == X.X86_OP_REG and ops[1].type == X.X86_OP_REG and ops[0].reg == ops[1].reg:
            d.write(lambda: f.c(0))
            if live & ZF: f.c(1).gs('zf')
            if live & PF: f.c(1).gs('pf')
            for fl in (CF, SF, OF):
                if live & fl: f.c(0).gs(FLAG_G[fl])
            return
        d.read(); f.ls(a); s.read(); f.c(MASK[sz]).e(OPS['and_']).ls(b)
        if mn in ('and', 'test', 'or', 'xor'):
            f.lg(a).lg(b).e(OPS[{'and': 'and_', 'test': 'and_', 'or': 'or_', 'xor': 'xor'}[mn]]).ls(r)
            if mn != 'test': d.write(lambda: f.lg(r))
            set_szp(f, r, sz, live)
            if live & CF: f.c(0).gs('cf')
            if live & OF: f.c(0).gs('of')
            return
        sub = mn in ('sub', 'sbb', 'cmp')
        carry = mn in ('adc', 'sbb')
        q = f.q()
        f.lg(a).e(EXT_U).lg(b).e(EXT_U).e(Q['sub' if sub else 'add'])
        if carry: f.gg('cf').e(EXT_U).e(Q['sub' if sub else 'add'])
        f.ls(q)
        f.lg(q).e(WRAP)
        if sz < 4: f.c(MASK[sz]).e(OPS['and_'])
        f.ls(r)
        if mn != 'cmp': d.write(lambda: f.lg(r))
        if live & CF:
            if sub: f.lg(q).c64(63).e(Q['shr_u']).e(WRAP)
            else: f.lg(q).c64(bits).e(Q['shr_u']).e(WRAP).c(1).e(OPS['and_'])
            f.gs('cf')
        if live & OF:
            if sub: f.lg(a).lg(b).e(OPS['xor']).lg(a).lg(r).e(OPS['xor']).e(OPS['and_'])
            else: f.lg(a).lg(r).e(OPS['xor']).lg(b).lg(r).e(OPS['xor']).e(OPS['and_'])
            f.c(bits - 1).e(OPS['shr_u']).c(1).e(OPS['and_']).gs('of')
        set_szp(f, r, sz, live)

    def x_inc(self, f, ins, ops, live): self.incdec(f, ins, ops, live, 1)
    def x_dec(self, f, ins, ops, live): self.incdec(f, ins, ops, live, -1)
    def incdec(self, f, ins, ops, live, delta):
        d = Loc(f, ops[0]); sz = ops[0].size; a, r = f.i(), f.i()
        d.read(); f.ls(a); f.lg(a).c(delta).e(OPS['add']).c(MASK[sz]).e(OPS['and_']).ls(r)
        d.write(lambda: f.lg(r))
        if live & OF:
            f.lg(r).c(1 << (8 * sz - 1) if delta > 0 else (1 << (8 * sz - 1)) - 1).e(OPS['eq']).gs('of')
        set_szp(f, r, sz, live)
    def x_neg(self, f, ins, ops, live):
        d = Loc(f, ops[0]); sz = ops[0].size; a, r = f.i(), f.i()
        d.read(); f.ls(a); f.c(0).lg(a).e(OPS['sub']).c(MASK[sz]).e(OPS['and_']).ls(r)
        d.write(lambda: f.lg(r))
        if live & CF: f.lg(a).c(0).e(OPS['ne']).gs('cf')
        if live & OF: f.lg(a).c(1 << (8 * sz - 1)).e(OPS['eq']).gs('of')
        set_szp(f, r, sz, live)
    def x_not(self, f, ins, ops, live):
        d = Loc(f, ops[0]); d.write(lambda: (d.read(), f.c(-1).e(OPS['xor'])))

    def shift(self, f, ins, ops, live, kind):
        d = Loc(f, ops[0]); sz = ops[0].size; bits = 8 * sz
        a, n, r, cfv, ofv = f.i(), f.i(), f.i(), f.i(), f.i()
        d.read(); f.ls(a)
        if len(ops) > 1: Loc(f, ops[1], 1).read()
        else: f.c(1)
        f.c(31).e(OPS['and_']).ls(n)
        const = len(ops) > 1 and ops[1].type == X.X86_OP_IMM
        if const and not (ops[1].imm & 31): return
        q = f.q()
        if kind == 'shl':
            f.lg(a).e(EXT_U).lg(n).e(EXT_U).e(Q['shl']).ls(q)
            f.lg(q).e(WRAP).c(MASK[sz]).e(OPS['and_']).ls(r)
            f.lg(q).c64(bits).e(Q['shr_u']).e(WRAP).c(1).e(OPS['and_']).ls(cfv)
            f.lg(r).c(bits - 1).e(OPS['shr_u']).lg(cfv).e(OPS['xor']).c(1).e(OPS['and_']).ls(ofv)
        elif kind == 'shr':
            f.lg(a).lg(n).e(OPS['shr_u']).ls(r)
            f.lg(a).e(EXT_U).c64(1).e(Q['shl']).lg(n).e(EXT_U).e(Q['shr_u']).e(WRAP).c(1).e(OPS['and_']).ls(cfv)
            f.lg(a).c(bits - 1).e(OPS['shr_u']).ls(ofv)
        elif kind == 'sar':
            sa = f.i(); f.lg(a).c(32 - bits).e(OPS['shl']).c(32 - bits).e(OPS['shr_s']).ls(sa)
            f.lg(sa).e(EXT_S).c64(1).e(Q['shl']).lg(n).e(EXT_U).e(Q['shr_s']).e(WRAP).c(1).e(OPS['and_']).ls(cfv)
            f.lg(sa).lg(n).e(OPS['shr_s']).c(MASK[sz]).e(OPS['and_']).ls(r)
            f.c(0).ls(ofv)
        elif kind in ('rcl', 'rcr'):
            m, v = f.i(), f.q(); W = bits + 1
            f.lg(n).c(W).e(OPS['rem_u']).ls(m)
            f.gg('cf').e(EXT_U).c64(bits).e(Q['shl']).lg(a).e(EXT_U).e(Q['or_']).ls(v)
            sh1, sh2 = ('shl', 'shr_u') if kind == 'rcl' else ('shr_u', 'shl')
            f.lg(v).lg(m).e(EXT_U).e(Q[sh1]).lg(v).c64(W).lg(m).e(EXT_U).e(Q['sub']).e(Q[sh2]).e(Q['or_']).ls(v)
            f.lg(v).e(WRAP).c(MASK[sz]).e(OPS['and_']).ls(r)
            f.lg(v).c64(bits).e(Q['shr_u']).e(WRAP).c(1).e(OPS['and_']).ls(cfv)
            if kind == 'rcl': f.lg(r).c(bits - 1).e(OPS['shr_u']).lg(cfv).e(OPS['xor']).c(1).e(OPS['and_']).ls(ofv)
            else: f.lg(r).c(bits - 1).e(OPS['shr_u']).lg(r).c(bits - 2).e(OPS['shr_u']).e(OPS['xor']).c(1).e(OPS['and_']).ls(ofv)
            sel_ = (lambda newv, g: (f.lg(newv), f.gg(g), f.lg(m), f.e(SELECT), f.gs(g)))
            d.write(lambda: (f.lg(r), f.lg(a), f.lg(m), f.e(SELECT)))
            if live & CF: sel_(cfv, 'cf')
            if live & OF: sel_(ofv, 'of')
            return
        elif kind in ('rol', 'ror'):
            m = f.i()
            f.lg(n).c(bits).e(OPS['rem_u']).ls(m)
            if bits == 32: f.lg(a).lg(m).e(OPS['rotl' if kind == 'rol' else 'rotr']).ls(r)
            else:
                if kind == 'rol': f.lg(a).lg(m).e(OPS['shl']).lg(a).c(bits).lg(m).e(OPS['sub']).e(OPS['shr_u']).e(OPS['or_'])
                else: f.lg(a).lg(m).e(OPS['shr_u']).lg(a).c(bits).lg(m).e(OPS['sub']).e(OPS['shl']).e(OPS['or_'])
                f.c(MASK[sz]).e(OPS['and_']).ls(r)
            if kind == 'rol': f.lg(r).c(1).e(OPS['and_']).ls(cfv); f.lg(r).c(bits - 1).e(OPS['shr_u']).lg(cfv).e(OPS['xor']).ls(ofv)
            else: f.lg(r).c(bits - 1).e(OPS['shr_u']).ls(cfv); f.lg(r).c(bits - 2).e(OPS['shr_u']).lg(cfv).e(OPS['xor']).c(1).e(OPS['and_']).ls(ofv)
        d.write(lambda: f.lg(r))
        sel = (lambda newv, g: (f.lg(newv), f.gg(g), f.lg(n), f.e(SELECT), f.gs(g))) if not const else (lambda newv, g: (f.lg(newv), f.gs(g)))
        if live & CF: sel(cfv, 'cf')
        if live & OF: sel(ofv, 'of')
        if kind not in ('rol', 'ror'):
            for fl, comp in ((ZF, lambda: (f.lg(r), f.e(OPS['eqz']))), (SF, lambda: (f.lg(r), f.c(bits - 1), f.e(OPS['shr_u']))),
                             (PF, lambda: (f.lg(r), f.c(0xff), f.e(OPS['and_']), f.e(OPS['popcnt']), f.c(1), f.e(OPS['and_']), f.c(1), f.e(OPS['xor'])))):
                if live & fl:
                    t = f.i(); comp(); f.ls(t); sel(t, FLAG_G[fl])
    def x_shl(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'shl')
    x_sal = x_shl
    def x_shr(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'shr')
    def x_sar(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'sar')
    def x_rol(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'rol')
    def x_ror(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'ror')
    def x_rcl(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'rcl')
    def x_rcr(self, f, ins, ops, live): self.shift(f, ins, ops, live, 'rcr')
    def descr(self, f, ops, off):
        """lar/lsl: word at LDT entry + off for the selector in ops[1]; ZF = descriptor present"""
        t, v = f.i(), f.i()
        Loc(f, ops[1]).read(); f.c(0xfff8).e(OPS['and_']).c(LDT_BASE).e(OPS['add']).ls(t)
        f.lg(t).e(0x28, 0, uleb(4)).lg(t).mem(0x28).e(OPS['or_']).c(0).e(OPS['ne']).gs('zf')
        f.lg(t).e(0x28, 0, uleb(off)).ls(v)
        d = Loc(f, ops[0]); f.gg('zf').e(0x04, 0x40); d.write(lambda: f.lg(v)); f.e(0x0b)
    def x_lsl(self, f, ins, ops, live): self.descr(f, ops, 4)
    def x_lar(self, f, ins, ops, live): self.descr(f, ops, 0x10000)   # access rights table at LDT_BASE + 0x10000
    def x_shld(self, f, ins, ops, live): self.dshift(f, ops, live, True)
    def x_shrd(self, f, ins, ops, live): self.dshift(f, ops, live, False)
    def dshift(self, f, ops, live, left):
        d, s = Loc(f, ops[0]), Loc(f, ops[1]); n, a, b = f.i(), f.i(), f.i()
        sz = ops[0].size; bits = 8 * sz
        d.read(); f.ls(a); s.read(); f.ls(b); Loc(f, ops[2], 1).read(); f.c(31).e(OPS['and_']).ls(n)
        q = f.q()
        if left:   # (a:b << n) >> bits
            f.lg(a).e(EXT_U).c64(bits).e(Q['shl']).lg(b).e(EXT_U).e(Q['or_']).lg(n).e(EXT_U).e(Q['shl']).c64(bits).e(Q['shr_u']).ls(q)
        else:      # (b:a >> n)
            f.lg(b).e(EXT_U).c64(bits).e(Q['shl']).lg(a).e(EXT_U).e(Q['or_']).lg(n).e(EXT_U).e(Q['shr_u']).ls(q)
        d.write(lambda: (f.lg(q), f.e(WRAP), f.c(MASK[sz]), f.e(OPS['and_']), f.lg(a), f.lg(n), f.e(SELECT)))
        if live & CF:
            if left: f.lg(a).c(bits).lg(n).e(OPS['sub']).e(OPS['shr_u']).c(1).e(OPS['and_'])
            else: f.lg(a).lg(n).c(1).e(OPS['sub']).e(OPS['shr_u']).c(1).e(OPS['and_'])
            f.gg('cf').lg(n).e(SELECT).gs('cf')
        r = f.i(); d.read(); f.ls(r); set_szp(f, r, sz, live & (ZF | SF | PF))
        if live & OF: f.c(0).gs('of')

    def x_mul(self, f, ins, ops, live): self.muldiv(f, ops, live, 'mul')
    def x_div(self, f, ins, ops, live): self.muldiv(f, ops, live, 'div')
    def x_idiv(self, f, ins, ops, live): self.muldiv(f, ops, live, 'idiv')
    def x_imul(self, f, ins, ops, live):
        if len(ops) == 1: return self.muldiv(f, ops, live, 'imul')
        d = Loc(f, ops[0]); sz = ops[0].size
        a, b = (Loc(f, ops[1]), Loc(f, ops[2], sz)) if len(ops) == 3 else (d, Loc(f, ops[1], sz))
        q = f.q()
        a.read(signed=True); f.e(EXT_S); b.read(signed=True); f.e(EXT_S); f.e(Q['mul']).ls(q)
        d.write(lambda: (f.lg(q), f.e(WRAP), f.c(MASK[sz]), f.e(OPS['and_'])))
        if live & (CF | OF):
            t = f.i()
            f.lg(q).lg(q).e(WRAP)
            if sz < 4: f.c(32 - 8 * sz).e(OPS['shl']).c(32 - 8 * sz).e(OPS['shr_s'])
            f.e(EXT_S).e(Q['ne']).ls(t)
            if live & CF: f.lg(t).gs('cf')
            if live & OF: f.lg(t).gs('of')
        if live & (ZF | SF | PF):
            r = f.i(); f.lg(q).e(WRAP).c(MASK[sz]).e(OPS['and_']).ls(r); set_szp(f, r, sz, live)
    def muldiv(self, f, ops, live, kind):
        s = Loc(f, ops[0]); sz = ops[0].size; signed = kind in ('imul', 'idiv')
        q, v = f.q(), f.q()
        s.read(signed=signed); f.e(EXT_S if signed else EXT_U).ls(v)
        if sz == 4:
            lo = lambda: (f.gg('eax'), f.e(EXT_S if (signed and kind == 'imul') else EXT_U))
            if kind in ('mul', 'imul'):
                lo(); f.lg(v).e(Q['mul']).ls(q)
                f.lg(q).e(WRAP).gs('eax'); f.lg(q).c64(32).e(Q['shr_u']).e(WRAP).gs('edx')
                if live & (CF | OF):
                    t = f.i()
                    if signed: f.gg('edx').gg('eax').c(31).e(OPS['shr_s']).e(OPS['ne']).ls(t)
                    else: f.gg('edx').c(0).e(OPS['ne']).ls(t)
                    f.lg(t).gs('cf'); f.lg(t).gs('of')
            else:
                f.gg('edx').e(EXT_U).c64(32).e(Q['shl']).gg('eax').e(EXT_U).e(Q['or_']).ls(q)
                self.divide(f, q, v, signed, 4)
        elif sz == 2:
            if kind in ('mul', 'imul'):
                f.gg('eax').c(0xffff).e(OPS['and_'])
                if signed: f.c(16).e(OPS['shl']).c(16).e(OPS['shr_s'])
                f.e(EXT_S if signed else EXT_U).lg(v).e(Q['mul']).ls(q)
                f.gg('eax').c(~0xffff).e(OPS['and_']).lg(q).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
                f.gg('edx').c(~0xffff).e(OPS['and_']).lg(q).c64(16).e(Q['shr_u']).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('edx')
            else:
                f.gg('edx').c(16).e(OPS['shl']).gg('eax').c(0xffff).e(OPS['and_']).e(OPS['or_'])
                f.e(EXT_S if signed else EXT_U).ls(q)
                self.divide(f, q, v, signed, 2)
        else:
            if kind in ('mul', 'imul'):
                f.gg('eax').c(0xff).e(OPS['and_'])
                if signed: f.c(24).e(OPS['shl']).c(24).e(OPS['shr_s'])
                f.e(EXT_S if signed else EXT_U).lg(v).e(Q['mul']).ls(q)
                f.gg('eax').c(~0xffff).e(OPS['and_']).lg(q).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
                if live & (CF | OF):
                    t = f.i(); f.lg(q).e(WRAP).c(0xff00).e(OPS['and_']).c(0).e(OPS['ne']).ls(t); f.lg(t).gs('cf'); f.lg(t).gs('of')
            else:
                f.gg('eax').c(0xffff).e(OPS['and_'])
                if signed: f.c(16).e(OPS['shl']).c(16).e(OPS['shr_s'])
                f.e(EXT_S if signed else EXT_U).ls(q)
                self.divide(f, q, v, signed, 1)
    def divide(self, f, q, v, signed, sz):
        """q (i64 dividend) / v (i64 divisor) into AL/AH, AX/DX or EAX/EDX; #DE on a zero divisor or an overflowing quotient"""
        quo, rem = f.q(), f.q(); bits = 8 * sz
        f.lg(v).e(Q['eqz']).e(0x04, 0x40); self.fault(f); f.e(0x0b)
        if signed:   # x / -1 is a negation (i64 INT_MIN / -1 would trap in wasm)
            f.c64(0).lg(q).e(Q['sub']).lg(q).lg(v).e(Q['div_s']).lg(v).c64(-1).e(Q['eq']).e(SELECT).ls(quo)
            f.c64(0).lg(q).lg(v).e(Q['rem_s']).lg(v).c64(-1).e(Q['eq']).e(SELECT).ls(rem)
            f.lg(quo).c64(-(1 << (bits - 1))).e(Q['lt_s']).lg(quo).c64((1 << (bits - 1)) - 1).e(0x55).e(OPS['or_'])   # i64.gt_s
        else:
            f.lg(q).lg(v).e(Q['div_u']).ls(quo); f.lg(q).lg(v).e(Q['rem_u']).ls(rem)
            f.lg(quo).c64((1 << bits) - 1).e(0x56)                                                                    # i64.gt_u
        f.e(0x04, 0x40); self.fault(f); f.e(0x0b)
        if sz == 4: f.lg(quo).e(WRAP).gs('eax'); f.lg(rem).e(WRAP).gs('edx')
        elif sz == 2:
            f.gg('eax').c(~0xffff).e(OPS['and_']).lg(quo).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
            f.gg('edx').c(~0xffff).e(OPS['and_']).lg(rem).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('edx')
        else:
            f.gg('eax').c(~0xffff).e(OPS['and_']).lg(quo).e(WRAP).c(0xff).e(OPS['and_']).e(OPS['or_'])
            f.lg(rem).e(WRAP).c(0xff).e(OPS['and_']).c(8).e(OPS['shl']).e(OPS['or_']).gs('eax')
    def fault(self, f):
        """#DE at the current instruction: the host dispatches it and leaves the continuation in the eip global"""
        f.c(CUR.addr).c(0).e(0x10, uleb(IMP['trap'])).gg('eip').e(RETURN)

    def x_bt(self, f, ins, ops, live): self.bit(f, ops, live, None)
    def x_bts(self, f, ins, ops, live): self.bit(f, ops, live, 'or_')
    def x_btr(self, f, ins, ops, live): self.bit(f, ops, live, 'and_')
    def x_btc(self, f, ins, ops, live): self.bit(f, ops, live, 'xor')
    def bit(self, f, ops, live, op):
        d = Loc(f, ops[0]); n, a = f.i(), f.i()
        Loc(f, ops[1]).read(); f.c(8 * ops[0].size - 1).e(OPS['and_']).ls(n)
        d.read(); f.ls(a)
        f.lg(a).lg(n).e(OPS['shr_u']).c(1).e(OPS['and_']).gs('cf')
        if op == 'and_': d.write(lambda: (f.lg(a), f.c(1), f.lg(n), f.e(OPS['shl']), f.c(-1), f.e(OPS['xor']), f.e(OPS['and_'])))
        elif op: d.write(lambda: (f.lg(a), f.c(1), f.lg(n), f.e(OPS['shl']), f.e(OPS[op])))
    def x_bsf(self, f, ins, ops, live): self.bscan(f, ops, live, 'ctz')
    def x_bsr(self, f, ins, ops, live): self.bscan(f, ops, live, 'clz')
    def bscan(self, f, ops, live, k):
        d = Loc(f, ops[0]); s = f.i(); Loc(f, ops[1]).read(); f.ls(s)
        f.lg(s).e(OPS['eqz']).gs('zf')
        if k == 'ctz': d.write(lambda: (f.lg(s), f.e(OPS['ctz']), d.read(), f.lg(s), f.e(SELECT)))
        else: d.write(lambda: (f.c(31), f.lg(s), f.e(OPS['clz']), f.e(OPS['sub']), d.read(), f.lg(s), f.e(SELECT)))
    def x_xadd(self, f, ins, ops, live):
        d, s = Loc(f, ops[0]), Loc(f, ops[1]); a, b = f.i(), f.i()
        d.read(); f.ls(a); s.read(); f.ls(b)
        s.write(lambda: f.lg(a)); d.write(lambda: (f.lg(a), f.lg(b), f.e(OPS['add']), f.c(MASK[ops[0].size]), f.e(OPS['and_'])))

    # ---- string instructions
    def port_elem(self, f, ins, kind, sz, addr):
        """one element of INS/OUTS: the port in DX, the data through AL/AX/EAX as IN/OUT carry it, EAX kept"""
        keep = f.i(); f.gg('eax').ls(keep)
        if kind == 'outs':
            if sz == 4: addr(); f.mem(0x28).gs('eax')
            else: f.gg('eax').c(~MASK[sz]).e(OPS['and_']); addr(); f.mem(LOAD[sz]).e(OPS['or_']).gs('eax')
        f.c(ins.next).gg('edx').c(0xffff).e(OPS['and_']).c(0x1000000 | ((kind == 'ins') << 23) | (sz << 16)).e(OPS['or_'])
        f.e(0x10, uleb(IMP['trap']))
        if kind == 'ins': addr(); f.gg('eax').mem(STORE[sz])
        f.lg(keep).gs('eax')
    def string(self, f, ins, kind, sz, rep):
        if segmode(): return self.string_seg(f, ins, kind, sz, rep)
        step = f.i()
        f.c(-sz).c(sz).gg('df').e(SELECT).ls(step)      # DF=1 decrements
        def one():
            if kind == 'movs':
                f.gg('edi').gg('esi').mem(LOAD[sz]).mem(STORE[sz])
                f.gg('esi').lg(step).e(OPS['add']).gs('esi'); f.gg('edi').lg(step).e(OPS['add']).gs('edi')
            elif kind == 'stos':
                f.gg('edi').gg('eax').mem(STORE[sz]); f.gg('edi').lg(step).e(OPS['add']).gs('edi')
            elif kind == 'outs': self.port_elem(f, ins, kind, sz, lambda: f.gg('esi')); f.gg('esi').lg(step).e(OPS['add']).gs('esi')
            elif kind == 'ins': self.port_elem(f, ins, kind, sz, lambda: f.gg('edi')); f.gg('edi').lg(step).e(OPS['add']).gs('edi')
            elif kind == 'lods':
                if sz == 4: f.gg('esi').mem(0x28).gs('eax')
                else: f.gg('eax').c(~MASK[sz]).e(OPS['and_']).gg('esi').mem(LOAD[sz]).e(OPS['or_']).gs('eax')
                f.gg('esi').lg(step).e(OPS['add']).gs('esi')
            else:
                a, b, r = f.i(), f.i(), f.i()
                if kind == 'cmps':
                    f.gg('esi').mem(LOAD[sz]).ls(a); f.gg('edi').mem(LOAD[sz]).ls(b)
                    f.gg('esi').lg(step).e(OPS['add']).gs('esi')
                else:
                    f.gg('eax').c(MASK[sz]).e(OPS['and_']).ls(a); f.gg('edi').mem(LOAD[sz]).ls(b)
                f.gg('edi').lg(step).e(OPS['add']).gs('edi')
                f.lg(a).lg(b).e(OPS['sub']).c(MASK[sz]).e(OPS['and_']).ls(r)
                f.lg(a).lg(b).e(OPS['lt_u']).gs('cf')
                f.lg(a).lg(b).e(OPS['xor']).lg(a).lg(r).e(OPS['xor']).e(OPS['and_']).c(8 * sz - 1).e(OPS['shr_u']).c(1).e(OPS['and_']).gs('of')
                set_szp(f, r, sz, ALLF)
        if not rep: one(); return
        # block { loop { br_if ecx==0 ; one ; ecx-- ; [cmp: br_if zf mismatch] ; br loop } }
        f.e(0x02, 0x40, 0x03, 0x40)
        f.gg('ecx').e(OPS['eqz']).e(0x0d, uleb(1))
        one()
        f.gg('ecx').c(1).e(OPS['sub']).gs('ecx')
        if kind in ('cmps', 'scas'):
            f.gg('zf')
            if rep == 0xf2: pass            # repne: stop when ZF=1
            else: f.e(OPS['eqz'])           # repe: stop when ZF=0
            f.e(0x0d, uleb(1))
        f.e(0x0c, uleb(0), 0x0b, 0x0b)

    def string_seg(self, f, ins, kind, sz, rep):
        a16 = addr16(ins); mask = 0xffff if a16 else 0xffffffff
        srcop = next((o for o in ins.ops if o.type == X.X86_OP_MEM and o.mem.base in (X.X86_REG_SI, X.X86_REG_ESI)), None)
        sseg = SREG[(srcop.mem.segment if srcop is not None and srcop.mem.segment else X.X86_REG_DS)][1]
        step = f.i(); f.c(-sz).c(sz).gg('df').e(SELECT).ls(step)
        idx = lambda r: (f.gg(r), f.c(mask), f.e(OPS['and_'])) if a16 else f.gg(r)
        src = lambda: (idx('esi'), f.gg(sseg), f.e(OPS['add']))
        dst = lambda: (idx('edi'), f.gg('esb'), f.e(OPS['add']))
        def bump(r):
            if a16: f.gg(r).c(~0xffff).e(OPS['and_']).gg(r).lg(step).e(OPS['add']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs(r)
            else: f.gg(r).lg(step).e(OPS['add']).gs(r)
        def one():
            if kind == 'movs': dst(); src(); f.mem(LOAD[sz]).mem(STORE[sz]); bump('esi'); bump('edi')
            elif kind == 'stos': dst(); f.gg('eax').mem(STORE[sz]); bump('edi')
            elif kind == 'outs': self.port_elem(f, ins, kind, sz, src); bump('esi')
            elif kind == 'ins': self.port_elem(f, ins, kind, sz, dst); bump('edi')
            elif kind == 'lods':
                if sz == 4: src(); f.mem(0x28).gs('eax')
                else: f.gg('eax').c(~MASK[sz]).e(OPS['and_']); src(); f.mem(LOAD[sz]).e(OPS['or_']).gs('eax')
                bump('esi')
            else:
                a, b, r = f.i(), f.i(), f.i()
                if kind == 'cmps': src(); f.mem(LOAD[sz]).ls(a); dst(); f.mem(LOAD[sz]).ls(b); bump('esi')
                else: f.gg('eax').c(MASK[sz]).e(OPS['and_']).ls(a); dst(); f.mem(LOAD[sz]).ls(b)
                bump('edi')
                f.lg(a).lg(b).e(OPS['sub']).c(MASK[sz]).e(OPS['and_']).ls(r)
                f.lg(a).lg(b).e(OPS['lt_u']).gs('cf')
                f.lg(a).lg(b).e(OPS['xor']).lg(a).lg(r).e(OPS['xor']).e(OPS['and_']).c(8 * sz - 1).e(OPS['shr_u']).c(1).e(OPS['and_']).gs('of')
                set_szp(f, r, sz, ALLF)
        if not rep: one(); return
        f.e(0x02, 0x40, 0x03, 0x40)
        f.gg('ecx').c(mask).e(OPS['and_']).e(OPS['eqz']).e(0x0d, uleb(1))
        one()
        if a16: f.gg('ecx').c(~0xffff).e(OPS['and_']).gg('ecx').c(1).e(OPS['sub']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('ecx')
        else: f.gg('ecx').c(1).e(OPS['sub']).gs('ecx')
        if kind in ('cmps', 'scas'):
            f.gg('zf')
            if rep != 0xf2: f.e(OPS['eqz'])
            f.e(0x0d, uleb(1))
        f.e(0x0c, uleb(0), 0x0b, 0x0b)

    # ---- x87
    def fpu(self, f, ins, mn, ops):
        regs = [o for o in ops if o.type == X.X86_OP_REG and o.reg in ST]
        mems = [o for o in ops if o.type == X.X86_OP_MEM]
        sti = lambda o: ST[o.reg]
        if mn in ('fld', 'fild'):
            if mems: fpush(f, lambda: fmem_load(f, mems[0], mn == 'fild'))
            else:
                i = sti(regs[0]); t = f.d(); st_get(f, i); f.ls(t); fpush(f, lambda: f.lg(t))
            return
        consts = {'fldz': 0.0, 'fld1': 1.0, 'fldpi': 3.141592653589793, 'fldl2e': 1.4426950408889634, 'fldl2t': 3.321928094887362,
                  'fldlg2': 0.3010299956639812, 'fldln2': 0.6931471805599453}
        if mn in consts: fpush(f, lambda: f.cf(consts[mn])); return
        if mn in ('fst', 'fstp'):
            if mems:
                loc = Loc(f, mems[0]); sz = mems[0].size
                if sz == 4: f.lg(loc.addr); st_get(f, 0); f.e(0xb6).mem(0x38)
                elif sz == 8: f.lg(loc.addr); st_get(f, 0); f.mem(0x39)
                else: f.lg(loc.addr); st_get(f, 0); f.e(0x10, uleb(IMP['f80store']))
            else:
                t = f.d(); st_get(f, 0); f.ls(t); st_set(f, sti(regs[0]), lambda: f.lg(t))
            if mn == 'fstp': fpop(f)
            return
        if mn in ('fist', 'fistp', 'fisttp'):
            loc = Loc(f, mems[0]); sz = mems[0].size
            f.lg(loc.addr); st_get(f, 0)
            if mn == 'fisttp': f.e(D['trunc'])
            else: fround(f)
            if sz == 8: f.e(0xfc, 6).mem(0x37)          # i64.trunc_sat_f64_s
            else:
                f.e(0xfc, 2)                            # i32.trunc_sat_f64_s
                f.mem(0x3b if sz == 2 else 0x36)
            if mn != 'fist': fpop(f)
            return
        if mn == 'fxch':
            i = sti(regs[0]) if regs else 1
            if i == 0 and len(regs) > 1: i = sti(regs[1])
            a, b = f.d(), f.d(); st_get(f, 0); f.ls(a); st_get(f, i); f.ls(b)
            st_set(f, 0, lambda: f.lg(b)); st_set(f, i, lambda: f.lg(a)); return
        arith = {'fadd': 'add', 'fmul': 'mul', 'fsub': 'sub', 'fsubr': 'subr', 'fdiv': 'div', 'fdivr': 'divr'}
        base = mn[:-1] if mn.endswith('p') and mn[:-1] in arith else mn
        ibase = 'f' + base[2:] if base.startswith('fi') and ('f' + base[2:]) in arith else None
        if base in arith or ibase:
            kind = arith[ibase or base]; pop = mn.endswith('p')
            if mems:
                dst = 0; src = lambda: fmem_load(f, mems[0], bool(ibase))
            elif len(regs) == 2:
                dst = sti(regs[0]); s_i = sti(regs[1]); src = lambda: st_get(f, s_i)
            elif len(regs) == 1:
                # capstone prints D8 /r (ST0 op= ST(i)) and DE /r (ST(i) op= ST0, pop) both as "fop st(i)"
                i = sti(regs[0])
                if pop: dst = i; src = lambda: st_get(f, 0)
                else: dst = 0; src = (lambda i=i: st_get(f, i))
            else:
                dst = 1; src = lambda: st_get(f, 0)
            a, b = f.d(), f.d(); st_get(f, dst); f.ls(a); src(); f.ls(b)
            def val():
                if kind in ('subr', 'divr'): f.lg(b).lg(a).e(D[kind[:3]])
                else: f.lg(a).lg(b).e(D[kind])
            st_set(f, dst, val)
            if pop: fpop(f)
            return
        if mn in ('fcom', 'fcomp', 'fcompp', 'fucom', 'fucomp', 'fucompp', 'ficom', 'ficomp', 'ftst'):
            if mn == 'ftst': src = lambda: f.cf(0.0)
            elif mems: src = lambda: fmem_load(f, mems[0], mn.startswith('fi'))
            elif regs: i = sti(regs[-1]); src = lambda: st_get(f, i)
            else: src = lambda: st_get(f, 1)
            a, b, v = f.d(), f.d(), f.i()
            st_get(f, 0); f.ls(a); src(); f.ls(b)
            f.lg(a).lg(b).e(D['lt']).c(8).e(OPS['shl']).lg(a).lg(b).e(D['eq']).c(14).e(OPS['shl']).e(OPS['or_']).ls(v)
            f.lg(v).c(0x4500).lg(a).lg(a).e(D['eq']).lg(b).lg(b).e(D['eq']).e(OPS['and_']).e(SELECT).ls(v)
            f.gg('fsw').c(~0x4500).e(OPS['and_']).lg(v).e(OPS['or_']).gs('fsw')
            if mn.endswith('pp'): fpop(f); fpop(f)
            elif mn.endswith('p'): fpop(f)
            return
        if mn in ('fcomi', 'fcomip', 'fucomi', 'fucomip'):
            i = sti(regs[-1]); a, b = f.d(), f.d(); st_get(f, 0); f.ls(a); st_get(f, i); f.ls(b)
            un = f.i(); f.lg(a).lg(a).e(D['ne']).lg(b).lg(b).e(D['ne']).e(OPS['or_']).ls(un)
            f.lg(a).lg(b).e(D['lt']).lg(un).e(OPS['or_']).gs('cf')
            f.lg(a).lg(b).e(D['eq']).lg(un).e(OPS['or_']).gs('zf')
            f.lg(un).gs('pf'); f.c(0).gs('of'); f.c(0).gs('sf')
            if mn.endswith('p'): fpop(f)
            return
        if mn in ('fnstsw', 'fstsw'):
            v = lambda: (f.gg('fsw'), f.c(~0x3800), f.e(OPS['and_']), f.gg('ftop'), f.c(11), f.e(OPS['shl']), f.e(OPS['or_']))
            if mems: loc = Loc(f, mems[0]); f.lg(loc.addr); v(); f.mem(0x3b)
            else: f.gg('eax').c(~0xffff).e(OPS['and_']); v(); f.c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
            return
        if mn in ('fnstcw', 'fstcw'): loc = Loc(f, mems[0]); f.lg(loc.addr).gg('fcw').mem(0x3b); return
        if mn == 'fldcw': loc = Loc(f, mems[0]); f.lg(loc.addr).mem(0x2f).gs('fcw'); return
        if mn in ('fninit', 'finit'): f.c(0).gs('ftop').c(0x37f).gs('fcw').c(0).gs('fsw'); return
        if mn == 'fincstp': fpop(f); return
        if mn == 'fdecstp': f.gg('ftop').c(1).e(OPS['sub']).c(7).e(OPS['and_']).gs('ftop'); return
        unary = {'fchs': lambda: f.e(D['neg']), 'fabs': lambda: f.e(D['abs']), 'fsqrt': lambda: f.e(D['sqrt']),
                 'fsin': lambda: f.e(0x10, uleb(IMP['fsin'])), 'fcos': lambda: f.e(0x10, uleb(IMP['fcos'])),
                 'frndint': lambda: fround(f), 'f2xm1': lambda: (f.e(0x10, uleb(IMP['fexp2'])), f.cf(1.0), f.e(D['sub']))}
        if mn in unary:
            t = f.d(); st_get(f, 0); unary[mn](); f.ls(t); st_set(f, 0, lambda: f.lg(t))
            if mn in ('fsin', 'fcos'): f.gg('fsw').c(~0x400).e(OPS['and_']).gs('fsw')
            return
        if mn == 'fptan':
            t = f.d(); st_get(f, 0); f.e(0x10, uleb(IMP['ftan'])); f.ls(t); st_set(f, 0, lambda: f.lg(t)); fpush(f, lambda: f.cf(1.0)); return
        if mn == 'fsincos':
            t, s = f.d(), f.d(); st_get(f, 0); f.ls(t)
            st_set(f, 0, lambda: (f.lg(t), f.e(0x10, uleb(IMP['fsin'])))); fpush(f, lambda: (f.lg(t), f.e(0x10, uleb(IMP['fcos'])))); return
        two = {'fpatan': lambda a, b: (f.lg(b), f.lg(a), f.e(0x10, uleb(IMP['fatan2']))),       # st1 = atan2(st1, st0)
               'fyl2x': lambda a, b: (f.lg(b), f.lg(a), f.e(0x10, uleb(IMP['flog2'])), f.e(D['mul'])),
               'fyl2xp1': lambda a, b: (f.lg(b), f.lg(a), f.cf(1.0), f.e(D['add']), f.e(0x10, uleb(IMP['flog2'])), f.e(D['mul']))}
        if mn in two:
            a, b, r = f.d(), f.d(), f.d(); st_get(f, 0); f.ls(a); st_get(f, 1); f.ls(b)
            two[mn](a, b); f.ls(r); st_set(f, 1, lambda: f.lg(r)); fpop(f); return
        if mn in ('fprem', 'fprem1', 'fscale'):
            a, b, r = f.d(), f.d(), f.d(); st_get(f, 0); f.ls(a); st_get(f, 1); f.ls(b)
            if mn == 'fscale': f.lg(a).lg(b).e(D['trunc']).e(0x10, uleb(IMP['fexp2'])).e(D['mul'])
            else: f.lg(a).lg(b).e(0x10, uleb(IMP['fmod' if mn == 'fprem' else 'frem']))
            f.ls(r); st_set(f, 0, lambda: f.lg(r))
            if mn != 'fscale': f.gg('fsw').c(~0x400).e(OPS['and_']).gs('fsw')
            return
        if mn == 'fxam':
            a = f.d(); st_get(f, 0); f.ls(a)
            # normal finite -> C2 ; zero -> C3 ; sign -> C1
            f.lg(a).cf(0.0).e(D['eq']).c(0x4000).e(OPS['mul']).lg(a).cf(0.0).e(D['ne']).c(0x400).e(OPS['mul']).e(OPS['or_'])
            f.lg(a).cf(0.0).e(D['lt']).c(0x200).e(OPS['mul']).e(OPS['or_'])
            f.gg('fsw').c(~0x4700).e(OPS['and_']).e(OPS['or_']).gs('fsw'); return
        raise Unsupported(mn)

# ---------------------------------------------------------------- module assembly
# ---------------------------------------------------------------- NE (16-bit) modules
class NE:
    """An NE module laid out for execution: segment i at base + i*64K with LDT selector selbase + 8*i."""
    def __init__(self, data, base, selbase):
        self.data = d = data; n = u32(d, 0x3c); self.n = n
        self.align = u16(d, n + 0x32); nseg = u16(d, n + 0x1c); self.autodata = u16(d, n + 0xe)
        csip = u32(d, n + 0x14); self.entry_seg, self.entry_off = csip >> 16, csip & 0xffff
        self.mods = []
        for i in range(u16(d, n + 0x1e)):
            q = n + u16(d, n + 0x2a) + u16(d, n + u16(d, n + 0x28) + 2 * i); self.mods.append(d[q + 1:q + 1 + d[q]].decode())
        q = n + u16(d, n + 0x26); self.name = d[q + 1:q + 1 + d[q]].decode()
        self.segs = []; cur = base
        for i in range(nseg):
            o = n + u16(d, n + 0x22) + 8 * i
            off, ln, fl, al = u16(d, o) << self.align, u16(d, o + 2) or 0x10000, u16(d, o + 4), u16(d, o + 6) or 0x10000
            if not u16(d, o): ln = 0
            sg = dict(num=i + 1, fileoff=off, len=ln, flags=fl, alloc=ln if not fl & 1 else max(al, ln), minalloc=al, sel=selbase + 8 * i,
                      bits=32 if fl & 0x2000 else 16, code=not fl & 1)
            if i + 1 == self.autodata: sg['alloc'] = 0x10000          # DGROUP: local heap may grow to 64K
            sg['base'] = cur; cur += (max(sg['alloc'], 1) + 15) & ~15
            self.segs.append(sg)
        self.size = cur - base
        self.entries = {}; self.entry_flags = {}
        p = n + u16(d, n + 4); ordn = 1
        while True:
            cnt, seg = d[p], d[p + 1]; p += 2
            if cnt == 0: break
            for _ in range(cnt):
                if seg == 0: ordn += 1; continue
                self.entry_flags[ordn] = d[p]
                if seg == 0xff: self.entries[ordn] = (d[p + 3], u16(d, p + 4)); p += 6
                else: self.entries[ordn] = (seg, u16(d, p + 1)); p += 3
                ordn += 1
        self.names = {}
        for tab, absolute in ((n + u16(d, n + 0x26), False), (u32(d, n + 0x2c), True)):
            q = tab; first = True
            while q < len(d) and d[q]:
                nm = d[q + 1:q + 1 + d[q]].decode('latin1'); o = u16(d, q + 1 + d[q]); q += 3 + d[q]
                if not first: self.names[nm.upper()] = o
                first = False
        self.image = bytearray(self.size + 16); self.base = base
        for sg in self.segs:
            if sg['len']: self.image[sg['base'] - base: sg['base'] - base + sg['len']] = d[sg['fileoff']: sg['fileoff'] + sg['len']]
        for sg in self.segs: SELBASE[sg['sel']] = sg['base']
        SELBASE[THUNK16_SEL] = THUNK16_BASE
    def seg_of(self, lin):
        for sg in self.segs:
            if sg['base'] <= lin < sg['base'] + max(sg['alloc'], 1): return sg
        return None
    def in_code(self, lin):
        sg = self.seg_of(lin); return bool(sg and sg['code'] and lin - sg['base'] < sg['len'])
    def export(self, key):
        """(selector, offset) of an exported ordinal or name"""
        if isinstance(key, str): key = self.names.get(key.upper())
        e = self.entries.get(key)
        if not e: return None
        return self.segs[e[0] - 1]['sel'], e[1]
    def patch_prologs(self, fixups):
        """the Win16 loader turns `push ds; pop ax; nop` / `mov ax, ds; nop` at exported shared-data entries into `mov ax, DGROUP`"""
        if not self.autodata: return
        dg = self.segs[self.autodata - 1]['sel']
        for o, (s_, off) in self.entries.items():
            sg = self.segs[s_ - 1]
            if not (self.entry_flags.get(o, 0) & 2) or not sg['code']: continue
            a = sg['base'] - self.base + off
            if bytes(self.image[a:a + 3]) in (b'\x1e\x58\x90', b'\x8c\xd8\x90'):
                self.image[a:a + 3] = bytes([0xb8, dg & 0xff, dg >> 8])
                fixups.append([sg['base'] + off, 1, 0xb8]); fixups.append([sg['base'] + off + 1, 2, dg])
    def relocate(self, resolve):
        """apply NE relocations; returns (fixups [linear, size, value], far code targets)"""
        d, fixups, targets = self.data, [], []
        self.selrefs = []   # (site of a selector fixup, code segment it names)
        def put(lin, size, val):
            o = lin - self.base
            self.image[o:o + size] = (val & ((1 << (8 * size)) - 1)).to_bytes(size, 'little'); fixups.append([lin, size, val & ((1 << (8 * size)) - 1)])
        for sg in self.segs:
            if not sg['flags'] & 0x100 or not sg['len']: continue
            r = sg['fileoff'] + sg['len']; cnt = u16(d, r); r += 2
            for _ in range(cnt):
                atype, rtype, off, a1, a2 = d[r], d[r + 1], u16(d, r + 2), u16(d, r + 4), u16(d, r + 6); r += 8
                kind, additive = rtype & 3, bool(rtype & 4)
                if kind == 3: continue                                  # OSFIXUP (FP emulation): no-op on a real FPU
                if kind == 0:
                    if a1 == 0xff: es, eo = self.entries[a2]; tsel, toff = self.segs[es - 1]['sel'], eo
                    else: tsel, toff = self.segs[a1 - 1]['sel'], a2
                    tsg = self.segs[(tsel - self.segs[0]['sel']) // 8]
                    if tsg['code'] and atype in (3, 11): targets.append(tsg['base'] + toff)
                    selref = tsg if tsg['code'] and atype == 2 else None
                else:
                    selref = None
                    mod = self.mods[a1 - 1]
                    if kind == 1: key = a2
                    else: q = self.n + u16(d, self.n + 0x2a) + a2; key = d[q + 1:q + 1 + d[q]].decode()
                    tsel, toff = resolve(mod, key)
                o = off
                while True:
                    lin = sg['base'] + o; cur = int.from_bytes(self.image[lin - self.base: lin - self.base + 4], 'little')
                    if selref is not None:
                        self.selrefs.append((lin, selref))
                        # {offset, selector} far pointers kept in tables: the word in front of the selector fixup
                        pw = int.from_bytes(self.image[lin - self.base - 2: lin - self.base], 'little')
                        if o >= 2 and 0 < pw < selref['len']: targets.append(selref['base'] + pw)
                    nxt = cur & 0xffff
                    if atype == 0: put(lin, 1, (cur & 0xff) + (toff if additive else 0) if additive else toff)
                    elif atype == 2: put(lin, 2, ((cur & 0xffff) + tsel) if additive else tsel)
                    elif atype == 5: put(lin, 2, ((cur & 0xffff) + toff) if additive else toff)
                    elif atype == 13: put(lin, 4, ((cur & 0xffffffff) + toff) if additive else toff)
                    elif atype == 3: put(lin, 2, ((cur & 0xffff) + toff) if additive else toff); put(lin + 2, 2, tsel)
                    elif atype == 11: put(lin, 4, toff); put(lin + 4, 2, tsel)
                    else: raise ValueError('reloc address type %d' % atype)
                    if additive or nxt == 0xffff or nxt >= sg['len']: break
                    o = nxt
        self.patch_prologs(fixups)
        return fixups, targets

def decode_ne(ne, entries):
    md = {16: capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_16), 32: capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)}
    for m in md.values(): m.detail = True
    insns, todo, seen = {}, list(entries), set()
    def table(ins, sg, recent):
        """targets of `jmp/call word ptr cs:[reg + table]` (switch tables have no relocations in NE code), and of
        `mov r16, [reg + table]; jmp/call r16` with the table in DGROUP"""
        op = ins.ops[0]
        if ins.mn in ('jmp', 'call') and op.type == X.X86_OP_REG and op.size == 2 and ne.autodata:
            for prev in reversed(recent[-8:-1]):
                if prev.mn == 'mov' and prev.ops[0].type == X.X86_OP_REG and prev.ops[0].reg == op.reg:
                    m = prev.ops[1]
                    if m.type != X.X86_OP_MEM or m.mem.segment not in (0, X.X86_REG_DS) or not m.mem.disp or not (m.mem.base or m.mem.index): return []
                    dg = ne.segs[ne.autodata - 1]; out = []
                    for k in range(32):
                        o = (m.mem.disp & 0xffff) + 2 * k
                        if o + 2 > dg['len']: break
                        v = int.from_bytes(ne.image[dg['base'] - ne.base + o: dg['base'] - ne.base + o + 2], 'little')
                        if v >= sg['len']: break
                        out.append(sg['base'] + v)
                    return out
            return []
        if ins.mn in ('jmp', 'call') and op.type == X.X86_OP_MEM and op.size == 2 and op.mem.segment in (0, X.X86_REG_DS) \
                and not op.mem.base and not op.mem.index and ne.autodata:
            # `jmp word ptr [var]`: the variable's initial value in DGROUP is a target too
            dg = ne.segs[ne.autodata - 1]; o = op.mem.disp & 0xffff
            if o + 2 <= dg['len']:
                v = int.from_bytes(ne.image[dg['base'] - ne.base + o: dg['base'] - ne.base + o + 2], 'little')
                if 0 < v < sg['len']: return [sg['base'] + v]
            return []
        if ins.mn in ('mov', 'movzx') and len(ins.ops) == 2: op = ins.ops[1]   # table loaded into a register, called later
        if op.type != X.X86_OP_MEM or op.mem.segment != X.X86_REG_CS or not op.mem.disp or op.size not in (2, 4) \
                or not (op.mem.base or op.mem.index): return []
        reg = op.mem.base or op.mem.index; count = None
        for prev in reversed(recent[-6:]):
            if prev.mn == 'cmp' and prev.ops[0].type == X.X86_OP_REG and prev.ops[1].type == X.X86_OP_IMM:
                count = (prev.ops[1].imm & 0xffff) + 1; break
        out, tab = [], op.mem.disp & 0xffff
        if count is None: count = 64
        w = op.size
        for k in range(count):
            o = tab + w * k
            if o + w > sg['len']: break
            v = int.from_bytes(ne.image[sg['base'] - ne.base + o: sg['base'] - ne.base + o + w], 'little')
            if v >= sg['len']: break
            if v: out.append(sg['base'] + v)
        return out
    def walk(start):
        a = start; recent = []
        while a not in insns:
            if not ne.in_code(a): return
            sg = ne.seg_of(a); off = a - sg['base']
            got = next(md[sg['bits']].disasm(bytes(ne.image[a - ne.base: a - ne.base + 16]), off, 1), None)
            if got is None: return
            ins = Insn(); ins.i = got; ins.addr = a; ins.size = got.size; ins.next = a + got.size
            ins.mn = got.mnemonic.split()[-1]; ins.ops = got.operands; ins.prefix = got.prefix
            ins.segbase = sg['base']; ins.bits = sg['bits']
            g = got.groups
            branch = ins.mn[0] == 'j' or ins.mn in ('call', 'lcall', 'ljmp', 'loop', 'loope', 'loopne')
            if branch and got.operands and got.operands[0].type == X.X86_OP_IMM:
                if ins.mn in ('lcall', 'ljmp'):
                    sel = got.operands[0].imm & 0xffff; ins.farsel = sel
                    if sel in SELBASE: ins.tgt = SELBASE[sel] + (got.operands[1].imm & 0xffffffff)
                else:
                    ins.tgt = sg['base'] + (got.operands[0].imm & (0xffff if sg['bits'] == 16 and got.prefix[2] != 0x66 else 0xffffffff))
            insns[a] = ins; recent.append(ins)
            if ins.tgt is not None: todo.append(ins.tgt)
            if (ins.mn in ('jmp', 'call') and got.operands and ins.tgt is None) or (ins.mn in ('mov', 'movzx') and len(got.operands) == 2):
                todo.extend(table(ins, sg, recent))
            if ins.mn in ('jmp', 'ljmp', 'ret', 'retf', 'hlt', 'int3', 'ud2', 'iret', 'iretd'): return
            a = ins.next
    def drain():
        while todo:
            t = todo.pop()
            if t not in seen: seen.add(t); walk(t)
    drain()
    # near code pointers kept in data: a segment that calls/jumps through `word ptr [mem]` gets every
    # `mov word ptr [mem], imm16` it contains treated as a possible entry within that segment
    while True:
        indirect = {i.segbase for i in insns.values() if i.segbase is not None and i.mn in ('call', 'jmp') and i.tgt is None
                    and i.ops and i.ops[0].type == X.X86_OP_MEM and i.ops[0].size == 2 and i.ops[0].mem.segment != X.X86_REG_CS}
        # `mov r16, imm16 ... mov word ptr [var], r16` where [var] is called or jumped through
        prev = {i.next: a for a, i in insns.items()}
        slots = {(i.segbase, i.i.op_str) for i in insns.values() if i.segbase is not None and i.mn in ('call', 'jmp') and i.tgt is None
                 and i.ops and i.ops[0].type == X.X86_OP_MEM and i.ops[0].size == 2}
        for i in list(insns.values()):
            if i.mn == 'mov' and len(i.ops) == 2 and i.ops[0].type == X.X86_OP_MEM and i.ops[1].type == X.X86_OP_REG \
                    and (i.segbase, i.i.op_str.split(',')[0]) in slots:
                reg, a = i.ops[1].reg, prev.get(i.addr)
                for _ in range(12):
                    if a is None: break
                    j = insns[a]
                    if j.mn == 'mov' and len(j.ops) == 2 and j.ops[0].type == X.X86_OP_REG and j.ops[0].reg == reg and j.ops[1].type == X.X86_OP_IMM:
                        sg = ne.seg_of(i.segbase); v = j.ops[1].imm & 0xffff
                        if v < sg['len'] and sg['base'] + v not in seen: todo.append(sg['base'] + v)
                    a = prev.get(a)
        # likewise `mov r16, imm16` for registers that a segment calls or jumps through
        viareg = {(i.segbase, i.ops[0].reg) for i in insns.values() if i.segbase is not None and i.mn in ('call', 'jmp')
                  and i.ops and i.ops[0].type == X.X86_OP_REG and i.ops[0].size == 2}
        for i in list(insns.values()):
            if i.mn != 'mov' or len(i.ops) != 2 or i.ops[1].type != X.X86_OP_IMM or i.ops[0].size != 2: continue
            if (i.segbase in indirect and i.ops[0].type == X.X86_OP_MEM) or (i.ops[0].type == X.X86_OP_REG and (i.segbase, i.ops[0].reg) in viareg):
                sg = ne.seg_of(i.segbase); t = sg['base'] + (i.ops[1].imm & 0xffff)
                if (i.ops[1].imm & 0xffff) < sg['len'] and t not in seen: todo.append(t)
        # far pointers assembled in code: a selector fixup naming one of our code segments with an imm16 next to it
        prev = {i.next: a for a, i in insns.items()}
        # Win16 parameter validation: `mov bp, sp; [push ds; pop ds;] push <error handler>` keeps the handler at [bp-2]
        for i in list(insns.values()):
            if i.segbase is None or i.mn != 'push' or not i.ops or i.ops[0].type != X.X86_OP_IMM: continue
            a, k = prev.get(i.addr), 0
            while a is not None and k < 3 and not (insns[a].mn == 'mov' and insns[a].i.op_str == 'bp, sp'): a, k = prev.get(a), k + 1
            if a is not None and k < 3:
                sg = ne.seg_of(i.segbase); v = i.ops[0].imm & 0xffff
                if v < sg['len'] and sg['base'] + v not in seen: todo.append(sg['base'] + v)
        # far pointers into this segment pushed as arguments: `push cs; push imm16` (timer and enumeration callbacks)
        for i in list(insns.values()):
            if i.segbase is None or i.mn != 'push' or not i.ops or i.ops[0].type != X.X86_OP_IMM: continue
            a = prev.get(i.addr)
            if a is not None and insns[a].mn == 'push' and insns[a].i.op_str == 'cs':
                sg = ne.seg_of(i.segbase); v = i.ops[0].imm & 0xffff
                if v < sg['len'] and sg['base'] + v not in seen: todo.append(sg['base'] + v)
        for site, tsg in getattr(ne, 'selrefs', []):
            host = next((insns[a] for a in range(site - 1, site - 6, -1) if a in insns and insns[a].next > site), None)
            if host is None: continue
            near, a = [], host.addr
            for _ in range(3):
                a = prev.get(a)
                if a is None: break
                near.append(insns[a])
            a = host.next
            for _ in range(12):   # far pointers built as `mov ax, sel; shl eax, 16; mov ax, off1 ... mov ax, off2`
                if a not in insns: break
                near.append(insns[a]); a = insns[a].next
            for i in near:
                if i.mn in ('mov', 'push') and i.ops and i.ops[-1].type == X.X86_OP_IMM and i.ops[-1].size <= 2 or (i.mn == 'push' and i.ops and i.ops[0].type == X.X86_OP_IMM):
                    v = i.ops[-1].imm & 0xffff
                    if v < tsg['len'] and tsg['base'] + v not in seen: todo.append(tsg['base'] + v)
        if not todo: break
        drain()
    return insns, seen

# KERNEL constants imported as relocations (__AHSHIFT, __AHINCR, __WINFLAGS, __FLATDS)
FLATDS_SEL = 0x000F
FLATCS_SEL = 0x0017              # KERNEL's __FLATCS: the flat 32-bit code selector (ne16.js L.FLATCS)
# selectors for fixed real-mode memory (__A000H and friends): LDT index 0x20.. (ne16.js creates them)
REALMODE_SELS = {183: (0x0107, 0x00000), 193: (0x010F, 0x00400), 174: (0x0117, 0xA0000), 181: (0x011F, 0xB0000), 182: (0x0127, 0xB8000),
                 195: (0x012F, 0xC0000), 179: (0x0137, 0xD0000), 190: (0x013F, 0xE0000), 194: (0x0147, 0xF0000), 173: (0x0147, 0xF0000)}
KERNEL_EQUATES = {113: 3, 114: 8, 178: 0x0C29, 454: FLATCS_SEL, 455: FLATDS_SEL, **{o: s for o, (s, b) in REALMODE_SELS.items()}}

def load_registry(path):
    try: return json.load(open(path))
    except (OSError, ValueError): return {'thunks': [], 'modules': {}}

def build_ne(path, out, base, selbase, lookup, registry):
    data = open(path, 'rb').read()
    reg = load_registry(registry)
    ne = NE(data, base, selbase)
    for m in reg['modules'].values():
        for sg in m['segs']: SELBASE[sg['sel']] = sg['base']
    def resolve(mod, key):
        if mod.upper() == 'KERNEL' and key in KERNEL_EQUATES: v = KERNEL_EQUATES[key]; return v, v
        m = reg['modules'].get(mod.upper())
        if m:
            k = str(key) if isinstance(key, int) else key.upper()
            hit = m['exports'].get(k) or (m['names'].get(k) and m['exports'].get(str(m['names'][k])))
            if hit: return tuple(hit)
        tk = '%s.%s' % (mod.upper(), ('#%d' % key) if isinstance(key, int) else key.upper())
        if tk not in reg['thunks']: reg['thunks'].append(tk)
        return THUNK16_SEL, 4 * reg['thunks'].index(tk)
    fixups, far_targets = ne.relocate(resolve)
    entries = [ne.segs[s - 1]['base'] + o for s, o in ne.entries.values() if ne.segs[s - 1]['code']]
    entries += [sg['base'] for sg in ne.segs if sg['code'] and sg['len']]   # far pointers to offset 0 look like nulls to the heuristics
    if ne.entry_seg: entries.append(ne.segs[ne.entry_seg - 1]['base'] + ne.entry_off)
    entries += far_targets
    # flat-thunk connection data: {checksum, 16:16 common entry}; the entry is reached only through it
    for nm, o in ne.names.items():
        if 'THKCONNECTIONDATA' in nm and o in ne.entries:
            s_, off = ne.entries[o]; sg = ne.segs[s_ - 1]; a = sg['base'] - ne.base + off
            ptr = int.from_bytes(ne.image[a + 4:a + 8], 'little')
            if ptr >> 16 in (0xffff, sg['sel']) and sg['code'] and (ptr & 0xffff) < sg['len']: entries.append(sg['base'] + (ptr & 0xffff))
    insns, seen = decode_ne(ne, entries)
    blocks = build_blocks(ne, insns, seen)
    liveness(blocks)
    tr = Translator(ne, blocks)
    order = sorted(blocks)
    bodies = [tr.block(st, blocks[st]) for st in order]
    code = [sg for sg in ne.segs if sg['code'] and sg['len']]
    text_lo, text_hi = min(sg['base'] for sg in code), max(sg['base'] + sg['len'] for sg in code)
    mod = assemble(bodies, text_lo, text_hi, lookup)
    open(out + '.wasm', 'wb').write(mod)
    exports = {str(o): [ne.segs[s - 1]['sel'], off] for o, (s, off) in ne.entries.items()}
    meta_size = ne.size
    reg['modules'][ne.name.upper()] = {'segs': [{k: sg[k] for k in ('num', 'sel', 'base', 'alloc', 'len', 'flags', 'bits')} for sg in ne.segs],
                                       'exports': exports, 'names': ne.names}
    json.dump(reg, open(registry, 'w'))
    meta = dict(kind='ne', name=ne.name, sha256=hashlib.sha256(data).hexdigest(), base=base, size=ne.size, selbase=selbase,
                segs=[{k: sg[k] for k in ('num', 'sel', 'base', 'alloc', 'minalloc', 'len', 'flags', 'bits', 'fileoff')} for sg in ne.segs],
                autodata=ne.autodata, entry=[ne.entry_seg, ne.entry_off], imports=ne.mods, exports=exports, names=ne.names, fixups=fixups,
                textLo=text_lo, textHi=text_hi, lookup=lookup, blocks=order, thunks=reg['thunks'],
                layout=dict(sentinel=SENTINEL, thunkBase=THUNK_BASE, thunk16Base=THUNK16_BASE, thunk16Sel=THUNK16_SEL, ldt=LDT_BASE, fpuBase=FPU_BASE, pages=MEM_PAGES))
    json.dump(meta, open(out + '.json', 'w'))
    print('%s: %d insns, %d blocks, wasm %d bytes, %d fixups, %d thunks' % (ne.name, len(insns), len(blocks), len(mod), len(fixups), len(reg['thunks'])))
    if tr.unsupported: print('  unsupported:', dict(sorted(tr.unsupported.items(), key=lambda kv: -kv[1])[:25]))

def assemble(bodies, text_lo, text_hi, lookup):
    types = [((), (I32,)), ((I32,), (I32,))]
    for _, p, r in IMPORTS:
        if (tuple(p), tuple(r)) not in types: types.append((tuple(p), tuple(r)))
    tidx = {t: i for i, t in enumerate(types)}
    sec = lambda n, b: bytes([n]) + uleb(len(b)) + b
    tsec = vec([b'\x60' + vec([bytes([x]) for x in p]) + vec([bytes([x]) for x in r]) for p, r in types])
    imps = [name('env') + name('mem') + b'\x02\x00' + uleb(MEM_PAGES)]
    imps += [name('cpu') + name(n) + bytes([0x03, I32, 1]) for n in G]
    imps += [name('env') + name(n) + b'\x00' + uleb(tidx[(tuple(p), tuple(r))]) for n, p, r in IMPORTS]
    nfuncs = 1 + len(bodies)
    fsec = vec([uleb(1)] + [uleb(0)] * len(bodies))
    tbl = b'\x70\x00' + uleb(len(bodies))
    exps = [name('run') + b'\x00' + uleb(NIMP)]
    elem = vec([b'\x00' + b'\x41\x00\x0b' + vec([uleb(NIMP + 1 + i) for i in range(len(bodies))])])

    # run(eip): dispatch loop
    r = Fn(nparams=1); EIP = 0; ID = 1
    r.e(0x03, 0x40)                                         # loop
    r.lg(EIP).c(SENTINEL).e(OPS['eq']).e(0x04, 0x40).lg(EIP).gs('eip').c(0).e(RETURN).e(0x0b)
    r.lg(EIP).c(THUNK16_BASE).e(OPS['ge_u']).e(0x04, 0x40)
    r.lg(EIP).gs('eip').lg(EIP).e(0x10, uleb(IMP['api'])).ls(EIP)
    r.lg(EIP).c(-1).e(OPS['eq']).e(0x04, 0x40).c(1).e(RETURN).e(0x0b)
    r.e(0x0c, uleb(1)).e(0x0b)                              # br loop
    assert (text_hi - text_lo) * 4 <= LOOKUP_BYTES
    r.lg(EIP).c(text_lo).e(OPS['sub']).lt(ID).c(text_hi - text_lo).e(OPS['ge_u'])
    r.e(0x04, 0x40).lg(EIP).gs('eip').c(3).e(RETURN).e(0x0b)
    r.lg(ID).c(2).e(OPS['shl']).e(0x28, 2, uleb(lookup)).lt(ID).e(OPS['eqz'])
    r.e(0x04, 0x40).lg(EIP).gs('eip').lg(EIP).c(2).e(0x10, uleb(IMP['trap'])).c(2).e(RETURN).e(0x0b)
    r.lg(EIP).gs('eip')
    r.lg(ID).c(1).e(OPS['sub']).e(0x11, uleb(0), 0x00).ls(EIP)   # call_indirect type 0 table 0
    r.e(0x0c, uleb(0)).e(0x0b)
    r.e(0x00)                                               # unreachable
    rbody = r.body()
    code = vec([rbody] + [b.body() for b in bodies])
    mod = b'\0asm\x01\0\0\0' + sec(1, tsec) + sec(2, vec(imps)) + sec(3, fsec) + sec(4, vec([tbl])) + \
          sec(7, vec(exps)) + sec(9, elem) + sec(10, code)
    return mod

def build(path, out, base=None, lookup=0x06000000):
    data = open(path, 'rb').read()
    pe = PE(data)
    if base is not None and base != pe.base: pe.rebase(base)
    insns, entries = decode_all(pe)
    blocks = build_blocks(pe, insns, entries)
    liveness(blocks)
    tr = Translator(pe, blocks)
    order = sorted(blocks)
    bodies = [tr.block(s, blocks[s]) for s in order]

    text_lo = min(pe.base + a for a, n in pe.code); text_hi = max(pe.base + a + n for a, n in pe.code)
    mod = assemble(bodies, text_lo, text_hi, lookup)
    open(out + '.wasm', 'wb').write(mod)
    meta = dict(sha256=hashlib.sha256(data).hexdigest(), base=pe.base, prefBase=pe.pref, entry=pe.entry, textLo=text_lo, textHi=text_hi,
                lookup=lookup, blocks=order, layout=dict(sentinel=SENTINEL, thunkBase=THUNK_BASE, fpuBase=FPU_BASE, pages=MEM_PAGES))
    json.dump(meta, open(out + '.json', 'w'))
    print('%s: %d insns, %d blocks, wasm %d bytes' % (path.split('/')[-1], len(insns), len(blocks), len(mod)))
    if tr.unsupported: print('  unsupported:', tr.unsupported)

def build_vxd(path, out, base, lookup):
    """a VxD: its LE image at `base`, translated like a PE's code; the metadata names its DDB, procedures and services"""
    data = open(path, 'rb').read()
    pe = LE(data, base)
    insns, entries = decode_all(pe)
    blocks = build_blocks(pe, insns, entries)
    liveness(blocks)
    tr = Translator(pe, blocks)
    order = sorted(blocks)
    bodies = [tr.block(s, blocks[s]) for s in order]
    text_lo = min(pe.base + a for a, n in pe.code); text_hi = max(pe.base + a + n for a, n in pe.code)
    mod = assemble(bodies, text_lo, text_hi, lookup)
    open(out + '.wasm', 'wb').write(mod)
    meta = dict(sha256=hashlib.sha256(data).hexdigest(), base=pe.base, size=pe.size, vxd=True, id=pe.vxd_id, name=pe.vxd_name,
                ddb=pe.ddb, procs=pe.procs, services=pe.services, textLo=text_lo, textHi=text_hi, lookup=lookup, blocks=order,
                layout=dict(sentinel=SENTINEL, thunkBase=THUNK_BASE, fpuBase=FPU_BASE, pages=MEM_PAGES))
    json.dump(meta, open(out + '.json', 'w'))
    open(out + '.img', 'wb').write(bytes(pe.image))
    print('%s (%s, VxD %xh): %d insns, %d blocks, wasm %d bytes' % (path.split('/')[-1], pe.vxd_name, pe.vxd_id, len(insns), len(blocks), len(mod)))
    if tr.unsupported: print('  unsupported:', tr.unsupported)

if __name__ == '__main__':
    a = sys.argv[1:]; kw = {}
    if '--trace' in a: a.remove('--trace'); Translator.TRACE = True
    reg = None
    if '--registry' in a: k = a.index('--registry'); reg = a[k + 1]; del a[k:k + 2]
    if '--vxd' in a: a.remove('--vxd')
    while len(a) > 2:
        v = int(a.pop(), 0); k = a.pop().lstrip('-'); kw[k] = v
    if '--vxd' in sys.argv: a = [x for x in a if x != '--vxd']
    if '--vxd' in sys.argv: build_vxd(a[0], a[1], kw['base'], kw.get('lookup', 0x06000000))
    elif reg: build_ne(a[0], a[1], kw['base'], kw['selbase'], kw.get('lookup', 0x06000000), reg)
    else: build(a[0], a[1], **kw)
