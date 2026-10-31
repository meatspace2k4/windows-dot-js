"""The emulator's map of its own gaps, by static analysis of the system bundle's modules, nothing run. Writes
findings/gapmap.json and prints what it found:

- reach: each module's code reachable from its entry points (a PE's entry and exports, a VxD's control, API and service
  procedures, an NE module's entry and exports, and any aligned dword of the image that holds the address of one of the
  recompiler's blocks: callbacks, window procedures, vtables), by recursive descent over direct jumps and calls;
- recompiler: the reachable instructions tools/recomp.py translated as an invalid opcode (its meta.unsupported kinds);
- run-time translation: the reachable block starts dyn.js cannot translate (tools/gapmap.mjs --dyn);
- services: every reachable VxDCall: a service nothing provides (no stand-in in vmm.js, no VxD of the bundle's), and
  a stand-in whose results the caller reads but the stand-in does not set: a flag the caller tests after the call, or
  a register it reads that it did not set before the call (NETBEUI's CF and EBX after Get_Crit_Status_No_Block,
  MMDEVLDR's EDX after _lstrlen).

python3 tools/staticmap.py [system.js]
"""
import base64, json, os, subprocess, sys
from collections import defaultdict
import capstone
from capstone import x86_const as X

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'system.js')
src = open(BUNDLE).read(); at = src.index('window.W95SYSTEM = ') + len('window.W95SYSTEM = ')
S = json.loads(src[at:src.rindex(';')])
b64 = base64.b64decode

FULL = {}
for r32, parts in {'eax': ('eax', 'ax', 'al', 'ah'), 'ebx': ('ebx', 'bx', 'bl', 'bh'), 'ecx': ('ecx', 'cx', 'cl', 'ch'), 'edx': ('edx', 'dx', 'dl', 'dh'),
                   'esi': ('esi', 'si'), 'edi': ('edi', 'di'), 'ebp': ('ebp', 'bp'), 'esp': ('esp', 'sp')}.items():
    for p in parts: FULL[p] = r32
FLAGS = {'cf': (X.X86_EFLAGS_TEST_CF, X.X86_EFLAGS_MODIFY_CF | X.X86_EFLAGS_SET_CF | X.X86_EFLAGS_RESET_CF | X.X86_EFLAGS_UNDEFINED_CF),
         'zf': (X.X86_EFLAGS_TEST_ZF, X.X86_EFLAGS_MODIFY_ZF | X.X86_EFLAGS_SET_ZF | X.X86_EFLAGS_RESET_ZF | X.X86_EFLAGS_UNDEFINED_ZF),
         'sf': (X.X86_EFLAGS_TEST_SF, X.X86_EFLAGS_MODIFY_SF | X.X86_EFLAGS_SET_SF | X.X86_EFLAGS_RESET_SF | X.X86_EFLAGS_UNDEFINED_SF),
         'of': (X.X86_EFLAGS_TEST_OF, X.X86_EFLAGS_MODIFY_OF | X.X86_EFLAGS_SET_OF | X.X86_EFLAGS_RESET_OF | X.X86_EFLAGS_UNDEFINED_OF)}

class Image:
    """a module's bytes where it loads: regions (base, bytes, bits)"""
    def __init__(self, name, group, meta): self.name, self.group, self.meta, self.regions = name, group, meta, []
    def add(self, base, data, bits): self.regions.append((base, bytes(data), bits))
    def at(self, a):
        for base, d, bits in self.regions:
            if base <= a < base + len(d): return d, a - base, bits
        return None, 0, 32

def map_pe(name, group, m):
    f = b64(m['file']); meta = m['meta']; im = Image(name, group, meta)
    pe = int.from_bytes(f[0x3c:0x40], 'little'); opt = pe + 24
    nsec = int.from_bytes(f[pe + 6:pe + 8], 'little'); shdr = opt + int.from_bytes(f[pe + 20:pe + 22], 'little')
    size = int.from_bytes(f[opt + 56:opt + 60], 'little'); img = bytearray(size); hdr = int.from_bytes(f[opt + 60:opt + 64], 'little')
    img[:hdr] = f[:hdr]
    im.exec = []   # (the sections that hold code: an export or a pointer elsewhere is data, MSVCRT20's variables)
    for i in range(nsec):
        o = shdr + 40 * i; vs, va, rs, ro = (int.from_bytes(f[o + k:o + k + 4], 'little') for k in (8, 12, 16, 20))
        n = min(rs, vs or rs); img[va:va + n] = f[ro:ro + n]
        if int.from_bytes(f[o + 36:o + 40], 'little') & 0x20000020: im.exec.append((meta['base'] + va, meta['base'] + va + max(vs, rs)))
    pref = int.from_bytes(f[opt + 28:opt + 32], 'little'); im.delta = meta['base'] - pref
    im.add(meta['base'], img, 32)
    entries = [meta['entry']] if meta.get('entry') else []
    exp = int.from_bytes(f[opt + 96:opt + 100], 'little')
    if exp:
        nf = int.from_bytes(img[exp + 20:exp + 24], 'little'); fa = int.from_bytes(img[exp + 28:exp + 32], 'little')
        for k in range(nf):
            r = int.from_bytes(img[fa + 4 * k:fa + 4 * k + 4], 'little')
            if r: entries.append(meta['base'] + r)
    return im, entries

def map_vxd(name, m):
    meta = m['meta']; im = Image(name, 'vxds', meta); img = b64(m['image']); im.delta = 0; im.add(meta['base'], img, 32)
    d = meta['ddb'] - meta['base']; dw = lambda o: int.from_bytes(img[o:o + 4], 'little')
    entries = [dw(d + 0x18), dw(d + 0x1c), dw(d + 0x20)]
    tab, n = dw(d + 0x30), dw(d + 0x34); im.svcs = []
    if tab and meta['base'] <= tab < meta['base'] + len(img): im.svcs = [(k, dw(tab - meta['base'] + 4 * k)) for k in range(min(n, 512))]; entries += [a for k, a in im.svcs]
    return im, [e for e in entries if e]

def map_ne(name, m):
    f = b64(m['file']); meta = m['meta']; im = Image(name, 'ne', meta); im.delta = 0
    base_of = {}; im.exec = []   # (code segments only: flags bit 0 marks a data segment, whose exports are variables)
    for g in meta['segs']:
        if g.get('fileoff') and g.get('len'): im.add(g['base'], f[g['fileoff']:g['fileoff'] + g['len']], g.get('bits', 16)); base_of[g['sel']] = g['base']; base_of[g['num']] = g['base']
        if not g.get('flags', 0) & 1: im.exec.append((g['base'], g['base'] + max(g.get('len', 0), g.get('alloc', 0))))
    entries = []
    es, eo = meta['entry'] if isinstance(meta.get('entry'), list) else (0, 0)
    if es in base_of: entries.append(base_of[es] + eo)
    for v in (meta.get('exports') or {}).values():
        if isinstance(v, list) and v[0] in base_of: entries.append(base_of[v[0]] + v[1])
    return im, entries

images = []
for n, m in S.get('vxds', {}).items(): images.append(map_vxd(n, m))
for g in ('dlls', 'programs', 'net', 'drivers'):
    for n, m in S.get(g, {}).items():
        if 'file' in m: images.append(map_pe(n, g, m))
for n, m in S.get('ne', {}).items(): images.append(map_ne(n, m))

md = {32: capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32), 16: capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_16)}
for c in md.values(): c.detail = True

def insn_at(im, a):
    """the instruction at linear `a`; 16-bit code decoded at its offset in the segment, so its targets are offsets"""
    d, o, bits = im.at(a)
    if d is None: return None, bits
    for i in md[bits].disasm(d[o:o + 16], a if bits == 32 else o, 1): return i, bits
    return None, bits

def target(im, a, i, bits):
    op = i.operands[0] if i.operands else None
    if op is None or op.type != X.X86_OP_IMM: return None
    if bits == 32: return op.imm & 0xffffffff
    d, o, _ = im.at(a); return a - o + (op.imm & 0xffff)

def is_vxdcall(i): return i.mnemonic == 'int' and i.op_str == '0x20'
# (the arithmetic and logic instructions write every status flag; capstone gives some forms no flag information, test
# of memory with a register)
ALU = {'add', 'adc', 'sub', 'sbb', 'cmp', 'test', 'and', 'or', 'xor', 'neg', 'shl', 'shr', 'sar', 'sal'}
def writes_flag(i, mod): return bool(i.eflags & mod) or i.mnemonic in ALU
BRANCH_END = {'ret', 'retf', 'iret', 'iretd', 'jmp', 'ljmp', 'hlt', 'ud2', 'int3'}

def reach(im, entries, scan=True):
    """recursive descent: every instruction reachable from the entries along direct transfers; the block starts. With
    `scan`, from data pointers too: the image's aligned dwords that hold one of the recompiler's block addresses
    (callbacks, window procedures, tables), which reach data the recompiler's sweep took for code as well"""
    blocks = set(im.meta.get('blocks') or []); text = (im.meta.get('textLo', 0), im.meta.get('textHi', 0))
    for base, d, bits in im.regions:
        if bits != 32 or not scan: continue
        for o in range(0, len(d) - 3, 4):
            v = (int.from_bytes(d[o:o + 4], 'little') + im.delta) & 0xffffffff
            if v in blocks: entries.append(v)
    entries = [e for e in entries if e not in getattr(im, 'dead', ())]
    code = lambda e: not getattr(im, 'exec', None) or any(lo <= e < hi for lo, hi in im.exec)
    seen, starts, work, insns = set(), set(), [e for e in entries if (text[0] <= e < text[1] or im.at(e)[0] is not None) and code(e)], {}
    starts.update(work); funcs = set(work)
    while work:
        a = work.pop()
        while a not in seen:
            i, bits = insn_at(im, a)
            if i is None: break
            seen.add(a); insns[a] = (i, bits)
            nxt = a + i.size
            if is_vxdcall(i):
                d, o, _ = im.at(a)
                code = int.from_bytes(d[o + 2:o + 6], 'little') if d else 0
                insns[a] = (i, bits, code); nxt = a + 6
                if code & 0x8000: break   # (VxDJmp: back to the caller's caller)
                starts.add(nxt); a = nxt; continue
            grp = i.groups
            if capstone.CS_GRP_JUMP in grp or capstone.CS_GRP_CALL in grp:
                t = target(im, a, i, bits) if i.mnemonic not in ('ljmp', 'lcall') else None
                if t is not None and im.at(t)[0] is not None:
                    work.append(t); starts.add(t)
                    if capstone.CS_GRP_CALL in grp: funcs.add(t)
                if i.mnemonic in ('jmp', 'ljmp'): break
                starts.add(nxt)
            if i.mnemonic in BRANCH_END or capstone.CS_GRP_RET in grp or capstone.CS_GRP_IRET in grp: break
            a = nxt
    return insns, starts, funcs

def full(reg_id, i):
    n = i.reg_name(reg_id); return FULL.get(n, n)

def reads_after(im, a, limit=24):
    """registers and flags read before being written along the paths from `a` (both ways at a branch, up to `limit`
    instructions a path, ending at a return, a call, an indirect jump or another VxDCall)"""
    regs, flags, seen = set(), set(), set()
    def walk(a, written, wflags, n):
        while n < limit and a not in seen:
            i, bits = insn_at(im, a)
            if i is None or is_vxdcall(i): return
            seen.add(a); n += 1
            rr, ww = i.regs_access()
            # (xor r, r and sub r, r read nothing; push r then a write of r saves it: neither reads a result)
            if i.mnemonic in ('xor', 'sub') and len(i.operands) == 2 and all(o.type == X.X86_OP_REG for o in i.operands) and i.operands[0].reg == i.operands[1].reg: rr = []
            if i.mnemonic in ('or', 'and') and len(i.operands) == 2 and i.operands[0].type == X.X86_OP_REG and i.operands[1].type == X.X86_OP_IMM and (i.operands[1].imm & 0xffffffff) == (0xffffffff if i.mnemonic == 'or' else 0): rr = []   # (or r, -1 and and r, 0: a constant)
            if i.mnemonic == 'push' and i.operands and i.operands[0].type == X.X86_OP_REG:
                j, _ = insn_at(im, a + i.size)
                if j is not None and full(i.operands[0].reg, i) in {full(r, j) for r in j.regs_access()[1]} - {full(r, j) for r in j.regs_access()[0]}: rr = []
            for r in rr:
                f = full(r, i)
                if f in ('eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp') and f not in written: regs.add(f)
            for k, (test, mod) in FLAGS.items():
                if i.eflags & test and k not in wflags: flags.add(k)
            for r in ww: written = written | {full(r, i)}
            for k, (test, mod) in FLAGS.items():
                if writes_flag(i, mod): wflags = wflags | {k}
            if capstone.CS_GRP_CALL in i.groups or capstone.CS_GRP_RET in i.groups or i.mnemonic in ('iret', 'iretd', 'hlt'): return
            if capstone.CS_GRP_JUMP in i.groups:
                t = target(im, a, i, bits)
                if t is None: return
                if i.mnemonic == 'jmp': a = t; continue
                walk(t, written, wflags, n)
            a += i.size
    walk(a, frozenset(), frozenset(), 0)
    return regs, flags

def version_vars(im, insns, dev):
    """where the module keeps device `dev`'s Get_Version result: the memory written after the call's CF test, the
    version or a count of it (an absent device's Get_Version sets CF)"""
    """, and the instructions straight on from that test with CF clear (the device's other services called there)"""
    out, past = set(), set()
    for a, rec in insns.items():
        if len(rec) != 3 or rec[2] != dev << 16: continue
        p, tested = a + 6, False
        for _ in range(12):
            i, bits = insn_at(im, p)
            if i is None: break
            if tested: past.add(p)
            if is_vxdcall(i): p += 6; continue
            if i.mnemonic in ('jb', 'jc', 'jae', 'jnc') and not tested:
                tested = True
                if i.mnemonic in ('jae', 'jnc'): t = target(im, p, i, bits); p = t if t is not None else p + i.size; continue
            elif tested and i.operands and i.operands[0].type == X.X86_OP_MEM and i.operands[0].access & capstone.CS_AC_WRITE and i.operands[0].mem.base == 0 and i.operands[0].mem.index == 0:
                out.add(i.operands[0].mem.disp & 0xffffffff)
            if i.mnemonic in BRANCH_END or capstone.CS_GRP_RET in i.groups: break
            p += i.size
    return out, past

def reads_var(im, funcs, a, var):
    """whether the function `a` is in reads one of `var` before `a`, straight through from its start"""
    s = max((x for x in funcs if x <= a and a - x < 0x2000), default=a); p = s
    while p < a:
        i, bits = insn_at(im, p)
        if i is None: return False
        if any(o.type == X.X86_OP_MEM and o.mem.base == 0 and o.mem.index == 0 and (o.mem.disp & 0xffffffff) in var for o in i.operands): return True
        p += 6 if is_vxdcall(i) else i.size
    return False

def before(im, funcs, a):
    """what the caller does from the start of its function to the call, straight through: the registers it writes, and
    each flag's state there: 'data' when an instruction last set it from data, 'known' when a conditional jump on it
    came after (on the way to the call it then has one value, so a test after the call asks the service), absent when
    nothing set it"""
    s = max((x for x in funcs if x <= a and a - x < 0x2000), default=a)
    regs, fl = set(), {}; p = s
    while p < a:
        i, bits = insn_at(im, p)
        if i is None: break
        if is_vxdcall(i):   # (an earlier service's results count as set: its stand-in's registers and flags)
            d, o, _ = im.at(p); code = int.from_bytes(d[o + 2:o + 6], 'little') if d else 0
            sets = set(standins.get('%04x:%04x' % (code >> 16, code & 0x7fff), {}).get('sets', []))
            regs |= sets; fl.update({k: 'data' for k in sets if k in FLAGS}); p += 6; continue
        for r in i.regs_access()[1]: regs.add(full(r, i))
        for k, (test, mod) in FLAGS.items():
            if i.eflags & test and capstone.CS_GRP_JUMP in i.groups and fl.get(k) == 'data': fl[k] = 'known'
            if writes_flag(i, mod): fl[k] = 'data'
        p += i.size
    return regs, fl

# the stand-ins' results (tools/gapmap.mjs --standins), and the devices the bundle's VxDs provide
standins = json.loads(subprocess.run(['node', os.path.join(ROOT, 'tools', 'gapmap.mjs'), '--standins', BUNDLE], capture_output=True, text=True, check=True).stdout)
provided = {m['meta']['id'] for m in S.get('vxds', {}).values()}

# (a device with neither: its Get_Version sets CF, P.absentService)
present = provided | {int(k.split(':')[0], 16) for k in standins}

result = {'modules': {}, 'recompUnsupported': defaultdict(lambda: {'count': 0, 'at': []}), 'services': {'missing': defaultdict(list), 'absent': defaultdict(lambda: {'guarded': [], 'unguarded': []}), 'contract': defaultdict(lambda: {'reads': defaultdict(list)}), 'reads': defaultdict(lambda: defaultdict(list))}}
dyn_starts = {}
# A VxD's service is entered only through a VxDCall (ring 0's code is all in the bundle and the stand-ins), and not
# when a stand-in provides it: the dispatcher never enters the VxD's own code then. So its service table's entries are
# the ones some reachable code calls, to a fixed point; the JavaScript calls SHELL's 3 and 6 itself (worker.js, vmm.js)
called = {(0x17, 3), (0x17, 6)}
while True:
    for im, entries in images:
        if im.group == 'vxds': im.dead = {a for k, a in im.svcs if '%04x:%04x' % (im.meta['id'], k) in standins or (im.meta['id'], k) not in called} - set(entries[:3])
    more = {(rec[2] >> 16, rec[2] & 0x7fff) for im, entries in images for rec in reach(im, list(entries))[0].values() if len(rec) == 3} - called
    if not more: break
    called |= more
for im, entries in images:
    # (flow: reached from the entry points by direct control flow; the rest only through a data pointer)
    flow = set(reach(im, list(entries), scan=False)[0])
    insns, starts, funcs = reach(im, list(entries))
    unsup = set(im.meta.get('unsupportedAt') or [])
    n_unsup = 0; callers = None
    for a, rec in insns.items():
        i = rec[0]; key = i.mnemonic if a in unsup else None
        if key:
            n_unsup += 1; e = result['recompUnsupported'][key]; e['count'] += 1
            if a in flow: e['flow'] = e.get('flow', 0) + 1; e.setdefault('flowAt', []).append('%s+%x' % (im.name, a - im.meta['base']))
            if len(e['at']) < 10: e['at'].append('%s+%x' % (im.name, a - im.meta['base']))
        if len(rec) == 3 and im.group in ('vxds', 'drivers'):
            code = rec[2]; dev, svc = code >> 16, code & 0x7fff; key = '%04x:%04x' % (dev, svc)
            site = '%s+%x' % (im.name, a - im.meta['base'])
            if key not in standins:
                if svc == 0 or dev in provided: continue
                if dev in present: result['services']['missing'][key].append(site); continue
                # (an absent device's service: called only if the caller goes on past its Get_Version's CF, as when the
                # function tests the variable the module keeps that result in first, or when every direct call of the
                # function is so guarded)
                vv, past = version_vars(im, insns, dev)
                if callers is None:
                    callers = defaultdict(set)
                    for c, r in insns.items():
                        if capstone.CS_GRP_CALL in r[0].groups and len(r) == 2:
                            t = target(im, c, r[0], r[1])
                            if t is not None: callers[t].add(c)
                    taken = {(int.from_bytes(d[o:o + 4], 'little') + im.delta) & 0xffffffff for base, d, bits in im.regions if bits == 32 for o in range(0, len(d) - 3)} | set(entries)
                def guarded(x, depth=0, seen=()):
                    if x in past or vv and reads_var(im, funcs, x, vv): return True
                    s = max((f for f in funcs if f <= x and x - f < 0x2000), default=None)
                    if s is None or s in taken or not callers.get(s) or depth > 6 or s in seen: return False
                    return all(guarded(c, depth + 1, seen + (s,)) for c in callers[s])
                result['services']['absent'][key]['guarded' if guarded(a) else 'unguarded'].append(site)
                continue
            if code & 0x8000: continue
            regs, flags = reads_after(im, a + 6)
            for r in regs | flags: result['services']['reads'][key][r].append(site)   # (all a caller reads after it: tools/realcheck.py)
            st = standins[key]; sets = set(st['sets'])
            wrote, fl = before(im, funcs, a)
            # (a flag tested after the call that the caller left unset, or had one value for on its way to the call: the
            # service's to set. A C service's ECX or EDX read after it, not set before: a result the service returns
            # beside EAX)
            for f in sorted(flags - sets):
                if fl.get(f) != 'data': result['services']['contract'][key]['reads'][f].append(site)
            if st.get('cdecl', '(arg)' in st['source'] or 'arg(' in st['source']):
                for r in sorted((regs & {'ecx', 'edx'}) - sets - wrote): result['services']['contract'][key]['reads'][r].append(site)
            if st.get('probe'): result['services']['contract'][key]['probe'] = st['probe']
            result['services']['contract'][key]['source'] = st['source']
    dyn_starts[im.name] = {'bits': {('%x' % a): bits for a in sorted(starts) for _, _, bits in [im.at(a)]}, 'flow': ['%x' % a for a in sorted(starts) if a in flow], 'base': im.meta['base']}
    result['modules'][im.name] = {'group': im.group, 'entries': len(entries), 'reachable': len(insns), 'blockStarts': len(starts), 'recompUnsupported': n_unsup}

# run-time translation over the reachable block starts
tmp = os.path.join(ROOT, 'findings', '.reach.json'); os.makedirs(os.path.dirname(tmp), exist_ok=True)
json.dump(dyn_starts, open(tmp, 'w'))
dyn = json.loads(subprocess.run(['node', os.path.join(ROOT, 'tools', 'gapmap.mjs'), '--dyn', tmp, BUNDLE], capture_output=True, text=True, check=True).stdout)
os.remove(tmp)
result['dynUntranslatable'] = dyn
# (a contract finding needs a read the stand-in leaves unset; keep the services that have one)
result['services']['contract'] = {k: {'reads': dict(v['reads']), **{x: v[x] for x in ('probe', 'source') if x in v}} for k, v in result['services']['contract'].items() if v['reads']}
result['services']['missing'] = dict(result['services']['missing'])
result['services']['absent'] = dict(result['services']['absent'])
result['services']['reads'] = {k: dict(v) for k, v in result['services']['reads'].items()}
# what the services and devices left are, read from Windows 95's own components (WIN95_02.CAB and the other CABs)
NAMES = {'002a:0018': "VWIN32_TerminateApp (EDI the thread: its saved ring-3 context back and VWIN32's APC queued that ends it; IFSMGR's, as its INT 21h dispatch returns -41h, which no VxD of the bundle and no stand-in returns)",
         0x21: 'PAGEFILE (DYNAPAGE.VXD)', 0x32: 'VSERVER', 0x41: 'VCDFSD', 0x482: 'SNAPVXD (SNAPSHOT.VXD)', 0x487: 'NWLINK (IPX/SPX), absent where the network is NetBEUI\'s as here',
         0x496: 'NDIS2SUP', 0x497: 'MSODISUP', 0x49b: 'VNBT (NetBIOS over TCP/IP)'}
result['services']['names'] = {k: NAMES.get(k) or NAMES.get(int(k.split(':')[0], 16)) for k in list(result['services']['missing']) + list(result['services']['absent']) if NAMES.get(k) or NAMES.get(int(k.split(':')[0], 16))}
result['recompUnsupported'] = dict(result['recompUnsupported'])
json.dump(result, open(os.environ.get('GAPMAP_OUT') or os.path.join(ROOT, 'findings', 'gapmap.json'), 'w'), indent=1)   # (W95_SCRIPTS, GAPMAP_OUT: the check run on other scripts, tools/gapmap.mjs)

print('reachable instructions:', sum(m['reachable'] for m in result['modules'].values()), 'in', len(result['modules']), 'modules')
print('recompiler #UD reached by control flow from an entry point (and only through a data pointer):')
for k, e in sorted(result['recompUnsupported'].items(), key=lambda kv: (-kv[1].get('flow', 0), -kv[1]['count'])):
    print('  %5d (%5d)  %-22s %s' % (e.get('flow', 0), e['count'] - e.get('flow', 0), k, ' '.join((e.get('flowAt') or e['at'])[:4])))
print('run-time translation, blocks it cannot take, by control flow (and only through a data pointer):')
for k, e in sorted(dyn.items(), key=lambda kv: (-kv[1].get('flow', 0), -kv[1]['count'])):
    print('  %5d (%5d)  %-45s %s' % (e.get('flow', 0), e['count'] - e.get('flow', 0), k, ' '.join((e.get('flowAt') or e['first'])[:4])))
print('VxD services nothing provides:')
for k, v in sorted(result['services']['missing'].items()): print('  %s  %d sites  %s' % (k, len(v), ' '.join(v[:3])))
print("services of devices the system does not have, unguarded (guarded: reached past a test of the device's version):")
for k, v in sorted(result['services']['absent'].items()): print('  %s  %d unguarded  %s  (%d guarded)' % (k, len(v['unguarded']), ' '.join(v['unguarded'][:3]), len(v['guarded'])))
print('stand-ins whose callers read a result they do not set:')
for k, v in sorted(result['services']['contract'].items()):
    print('  %s%s' % (k, '  (probe: %s)' % v['probe'] if 'probe' in v else ''))
    for r, sites in v['reads'].items(): print('      %-4s %d sites  %s' % (r, len(sites), ' '.join(sites[:3])))
