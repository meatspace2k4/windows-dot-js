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
import hashlib, json, struct, sys
import capstone
from capstone import x86_const as X

# ---------------------------------------------------------------- layout shared with the JS runtime
SENTINEL = 0xFFFFFFF0
THUNK_BASE = 0xFFFF0000
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
                                  'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip'])}
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

# ---------------------------------------------------------------- discovery
class Insn:
    __slots__ = ('i', 'addr', 'size', 'next', 'mn', 'ops', 'prefix', 'live', 'id')
def decode_all(pe):
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32); md.detail = True
    insns, todo, seen_entries = {}, [pe.entry] if pe.entry else [], set()
    todo += export_entries(pe)
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
            insns[a] = ins
            for op in got.operands:
                if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.disp: data_refs.add(op.mem.disp & 0xffffffff)
            g = got.groups
            if capstone.CS_GRP_JUMP in g or capstone.CS_GRP_CALL in g:
                if got.operands and got.operands[0].type == X.X86_OP_IMM:
                    todo.append(got.operands[0].imm & 0xffffffff)
            if ins.mn in ('jmp', 'ret', 'retf', 'hlt', 'int3', 'ud2') or ins.mn.startswith('iret'): return
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

def build_blocks(pe, insns, entries):
    starts = set(e for e in entries if e in insns)
    for ins in insns.values():
        g = ins.i.groups
        if capstone.CS_GRP_JUMP in g or capstone.CS_GRP_CALL in g or ins.mn.startswith('ret'):
            if ins.next in insns: starts.add(ins.next)
            if ins.ops and ins.ops[0].type == X.X86_OP_IMM:
                t = ins.ops[0].imm & 0xffffffff
                if t in insns: starts.add(t)
    blocks = {}
    for s in sorted(starts):
        lst, a = [], s
        while a in insns:
            ins = insns[a]; lst.append(ins); a = ins.next
            g = ins.i.groups
            if capstone.CS_GRP_JUMP in g or capstone.CS_GRP_CALL in g or ins.mn.startswith('ret') or ins.mn in ('hlt', 'int3', 'ud2'): break
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
    if mn in ('lahf', 'pushfd', 'adc', 'sbb'): return ALLF, 0
    return 0, 0

def liveness(blocks):
    succ = {}
    for s, lst in blocks.items():
        last = lst[-1]; out = []
        g = last.i.groups
        if last.mn == 'jmp' or capstone.CS_GRP_CALL in g or last.mn.startswith('ret'):
            if last.mn == 'jmp' and last.ops[0].type == X.X86_OP_IMM: out.append(last.ops[0].imm & 0xffffffff)
        elif capstone.CS_GRP_JUMP in g:
            out += [last.ops[0].imm & 0xffffffff, last.next]
        else: out.append(last.next)
        succ[s] = [t for t in out if t in blocks]
    live_in = {s: 0 for s in blocks}
    changed = True
    while changed:
        changed = False
        for s in sorted(blocks, reverse=True):
            live = 0
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
    if seg and m.segment == X.X86_REG_FS: f.gg('fs').e(OPS['add'])
    elif seg and m.segment not in (0, X.X86_REG_DS, X.X86_REG_SS, X.X86_REG_ES, X.X86_REG_CS): raise Unsupported('segment')

# ---- flag helpers. All take locals holding zero-extended operands/result.
def set_szp(f, r, sz, live):
    if live & ZF: f.lg(r).e(OPS['eqz']).gs('zf')
    if live & SF: f.lg(r).c(8 * sz - 1).e(OPS['shr_u']).c(1).e(OPS['and_']).gs('sf')
    if live & PF: f.lg(r).c(0xff).e(OPS['and_']).e(OPS['popcnt']).c(1).e(OPS['and_']).c(1).e(OPS['xor']).gs('pf')

def push_val(f, val):
    f.gg('esp').c(4).e(OPS['sub']).gs('esp')
    t = f.i(); val(); f.ls(t)
    f.gg('esp').lg(t).mem(0x36)
def pop_to(f, t):
    f.gg('esp').mem(0x28).ls(t); f.gg('esp').c(4).e(OPS['add']).gs('esp')

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
    """round f64 on stack per FCW rounding control"""
    t = f.d(); f.ls(t)
    rc = f.i(); f.gg('fcw').c(10).e(OPS['shr_u']).c(3).e(OPS['and_']).ls(rc)
    f.lg(t).e(D['trunc'])
    f.lg(t).e(D['ceil']); f.lg(rc).c(2).e(OPS['eq']).e(SELECT)
    f.lg(t).e(D['floor']); f.lg(rc).c(1).e(OPS['eq']).e(SELECT)
    f.lg(t).e(D['nearest']); f.lg(rc).e(OPS['eqz']).e(SELECT)

class Translator:
    TRACE = False
    def __init__(self, pe, blocks):
        self.pe, self.blocks = pe, blocks
        self.unsupported = {}
    def block(self, start, lst):
        f = Fn()
        if self.TRACE: f.c(start).e(0x10, uleb(IMP['btrace']))
        try:
            for ins in lst:
                f.ti = 0; f.tq = 0; f.td = 0
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
            f.c(ops[0].imm).c(ins.next).lg(t).e(SELECT).e(RETURN); return True
        if c and mn.startswith('set'):
            Loc(f, ops[0]).write(lambda: cond(f, c)); return
        if c and mn.startswith('cmov'):
            d, s = Loc(f, ops[0]), Loc(f, ops[1])
            d.write(lambda: (s.read(), d.read(), cond(f, c), f.e(SELECT))); return
        if mn in ('add', 'sub', 'adc', 'sbb', 'cmp', 'and', 'or', 'xor', 'test'): return self.alu(f, ins, mn)
        if mn.rstrip('bwd') in ('movs', 'stos', 'lods', 'scas', 'cmps') and len(mn) == 5:
            return self.string(f, ins, mn[:4], {'b': 1, 'w': 2, 'd': 4}[mn[4]], rep)
        if mn.startswith('f'): return self.fpu(f, ins, mn, ops)
        raise Unsupported(mn)

    # ---- data movement
    def x_mov(self, f, ins, ops, live):
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
        s = Loc(f, ops[0], 4)
        if ops[0].type == X.X86_OP_IMM: push_val(f, lambda: f.c(ops[0].imm))
        else: push_val(f, lambda: s.read())
    def x_pop(self, f, ins, ops, live):
        t = f.i(); pop_to(f, t)
        Loc(f, ops[0]).write(lambda: f.lg(t))
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
        t = f.i(); f.gg('ebp').gs('esp'); pop_to(f, t); f.lg(t).gs('ebp')
    def x_cdq(self, f, ins, ops, live): f.gg('eax').c(31).e(OPS['shr_s']).gs('edx')
    def x_cwde(self, f, ins, ops, live): f.gg('eax').c(16).e(OPS['shl']).c(16).e(OPS['shr_s']).gs('eax')
    def x_cbw(self, f, ins, ops, live):
        f.gg('eax').c(~0xffff).e(OPS['and_']).gg('eax').c(24).e(OPS['shl']).c(24).e(OPS['shr_s']).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
    def x_cwd(self, f, ins, ops, live):
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
    def target(self, f, op):
        if op.type == X.X86_OP_IMM: f.c(op.imm)
        else: Loc(f, op, 4).read()
    def x_jmp(self, f, ins, ops, live): self.target(f, ops[0]); f.e(RETURN); return True
    def x_call(self, f, ins, ops, live):
        t = f.i(); self.target(f, ops[0]); f.ls(t)
        push_val(f, lambda: f.c(ins.next)); f.lg(t).e(RETURN); return True
    def x_ret(self, f, ins, ops, live):
        t = f.i(); pop_to(f, t)
        if ops: f.gg('esp').c(ops[0].imm).e(OPS['add']).gs('esp')
        f.lg(t).e(RETURN); return True
    def x_jecxz(self, f, ins, ops, live):
        f.c(ops[0].imm).c(ins.next).gg('ecx').e(OPS['eqz']).e(SELECT).e(RETURN); return True
    def x_loop(self, f, ins, ops, live):
        f.gg('ecx').c(1).e(OPS['sub']).gs('ecx')
        f.c(ops[0].imm).c(ins.next).gg('ecx').e(SELECT).e(RETURN); return True
    def x_int3(self, f, ins, ops, live):
        f.c(ins.addr).c(3).e(0x10, uleb(IMP['trap'])); f.c(SENTINEL).e(RETURN); return True
    x_hlt = x_int3; x_ud2 = x_int3
    def x_int(self, f, ins, ops, live): return self.x_int3(f, ins, ops, live)

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
    def x_shld(self, f, ins, ops, live): self.dshift(f, ops, live, True)
    def x_shrd(self, f, ins, ops, live): self.dshift(f, ops, live, False)
    def dshift(self, f, ops, live, left):
        d, s = Loc(f, ops[0]), Loc(f, ops[1]); n, a, b = f.i(), f.i(), f.i()
        d.read(); f.ls(a); s.read(); f.ls(b); Loc(f, ops[2], 1).read(); f.c(31).e(OPS['and_']).ls(n)
        q = f.q()
        if left:
            f.lg(a).e(EXT_U).c64(32).e(Q['shl']).lg(b).e(EXT_U).e(Q['or_']).lg(n).e(EXT_U).e(Q['shl']).c64(32).e(Q['shr_u']).ls(q)
        else:
            f.lg(b).e(EXT_U).c64(32).e(Q['shl']).lg(a).e(EXT_U).e(Q['or_']).lg(n).e(EXT_U).e(Q['shr_u']).ls(q)
        d.write(lambda: (f.lg(q), f.e(WRAP), f.lg(a), f.lg(n), f.e(SELECT)))
        if live & CF:
            if left: f.lg(a).c(32).lg(n).e(OPS['sub']).e(OPS['shr_u']).c(1).e(OPS['and_'])
            else: f.lg(a).lg(n).c(1).e(OPS['sub']).e(OPS['shr_u']).c(1).e(OPS['and_'])
            f.gg('cf').lg(n).e(SELECT).gs('cf')
        r = f.i(); d.read(); f.ls(r); set_szp(f, r, 4, live & (ZF | SF | PF))
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
                self.divzero(f, v)
                f.lg(q).lg(v).e(Q['div_s' if signed else 'div_u']).e(WRAP)
                f.lg(q).lg(v).e(Q['rem_s' if signed else 'rem_u']).e(WRAP).gs('edx').gs('eax')
        elif sz == 2:
            if kind in ('mul', 'imul'):
                f.gg('eax').c(0xffff).e(OPS['and_'])
                if signed: f.c(16).e(OPS['shl']).c(16).e(OPS['shr_s'])
                f.e(EXT_S if signed else EXT_U).lg(v).e(Q['mul']).ls(q)
                f.gg('eax').c(~0xffff).e(OPS['and_']).lg(q).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
                f.gg('edx').c(~0xffff).e(OPS['and_']).lg(q).c64(16).e(Q['shr_u']).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('edx')
            else:
                self.divzero(f, v)
                f.gg('edx').c(16).e(OPS['shl']).gg('eax').c(0xffff).e(OPS['and_']).e(OPS['or_'])
                f.e(EXT_S if signed else EXT_U).ls(q)
                t, u = f.i(), f.i()
                f.lg(q).lg(v).e(Q['div_s' if signed else 'div_u']).e(WRAP).c(0xffff).e(OPS['and_']).ls(t)
                f.lg(q).lg(v).e(Q['rem_s' if signed else 'rem_u']).e(WRAP).c(0xffff).e(OPS['and_']).ls(u)
                f.gg('eax').c(~0xffff).e(OPS['and_']).lg(t).e(OPS['or_']).gs('eax')
                f.gg('edx').c(~0xffff).e(OPS['and_']).lg(u).e(OPS['or_']).gs('edx')
        else:
            if kind in ('mul', 'imul'):
                f.gg('eax').c(0xff).e(OPS['and_'])
                if signed: f.c(24).e(OPS['shl']).c(24).e(OPS['shr_s'])
                f.e(EXT_S if signed else EXT_U).lg(v).e(Q['mul']).ls(q)
                f.gg('eax').c(~0xffff).e(OPS['and_']).lg(q).e(WRAP).c(0xffff).e(OPS['and_']).e(OPS['or_']).gs('eax')
                if live & (CF | OF):
                    t = f.i(); f.lg(q).e(WRAP).c(0xff00).e(OPS['and_']).c(0).e(OPS['ne']).ls(t); f.lg(t).gs('cf'); f.lg(t).gs('of')
            else:
                self.divzero(f, v)
                f.gg('eax').c(0xffff).e(OPS['and_'])
                if signed: f.c(16).e(OPS['shl']).c(16).e(OPS['shr_s'])
                f.e(EXT_S if signed else EXT_U).ls(q)
                t, u = f.i(), f.i()
                f.lg(q).lg(v).e(Q['div_s' if signed else 'div_u']).e(WRAP).c(0xff).e(OPS['and_']).ls(t)
                f.lg(q).lg(v).e(Q['rem_s' if signed else 'rem_u']).e(WRAP).c(0xff).e(OPS['and_']).ls(u)
                f.gg('eax').c(~0xffff).e(OPS['and_']).lg(t).e(OPS['or_']).lg(u).c(8).e(OPS['shl']).e(OPS['or_']).gs('eax')
    def divzero(self, f, v):
        f.lg(v).e(Q['eqz']).e(0x04, 0x40)
        f.c(0).c(0).e(0x10, uleb(IMP['trap'])).c(SENTINEL).e(RETURN)
        f.e(0x0b)

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
    def string(self, f, ins, kind, sz, rep):
        step = f.i()
        f.c(-sz).c(sz).gg('df').e(SELECT).ls(step)      # DF=1 decrements
        def one():
            if kind == 'movs':
                f.gg('edi').gg('esi').mem(LOAD[sz]).mem(STORE[sz])
                f.gg('esi').lg(step).e(OPS['add']).gs('esi'); f.gg('edi').lg(step).e(OPS['add']).gs('edi')
            elif kind == 'stos':
                f.gg('edi').gg('eax').mem(STORE[sz]); f.gg('edi').lg(step).e(OPS['add']).gs('edi')
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
    r.lg(EIP).c(THUNK_BASE).e(OPS['ge_u']).e(0x04, 0x40)
    r.lg(EIP).gs('eip').lg(EIP).e(0x10, uleb(IMP['api'])).ls(EIP)
    r.lg(EIP).c(-1).e(OPS['eq']).e(0x04, 0x40).c(1).e(RETURN).e(0x0b)
    r.e(0x0c, uleb(1)).e(0x0b)                              # br loop
    text_lo = min(pe.base + a for a, n in pe.code); text_hi = max(pe.base + a + n for a, n in pe.code)
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
    open(out + '.wasm', 'wb').write(mod)
    meta = dict(sha256=hashlib.sha256(data).hexdigest(), base=pe.base, prefBase=pe.pref, entry=pe.entry, textLo=text_lo, textHi=text_hi,
                lookup=lookup, blocks=order, layout=dict(sentinel=SENTINEL, thunkBase=THUNK_BASE, fpuBase=FPU_BASE, pages=MEM_PAGES))
    json.dump(meta, open(out + '.json', 'w'))
    print('%s: %d insns, %d blocks, wasm %d bytes' % (path.split('/')[-1], len(insns), len(blocks), len(mod)))
    if tr.unsupported: print('  unsupported:', tr.unsupported)

if __name__ == '__main__':
    a = sys.argv[1:]; kw = {}
    if '--trace' in a: a.remove('--trace'); Translator.TRACE = True
    while len(a) > 2:
        v = int(a.pop(), 0); k = a.pop().lstrip('-'); kw[k] = v
    build(a[0], a[1], **kw)
