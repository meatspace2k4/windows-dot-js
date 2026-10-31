"""Each VxD service stand-in (vmm.js) against Windows 95's own service, by static analysis of the originals, nothing
run: what the original leaves changed when it returns (the registers that no longer hold their own value, the flags it
sets on its way), what the bundle's callers read after the call
(findings/gapmap.json, tools/staticmap.py), and what the stand-in sets (tools/gapmap.mjs --standins). It reports

- missing: a result the original returns and callers read that the stand-in does not set;
- clobbers: a register or flag the stand-in sets that the original leaves as it was and callers read after the call
  (their own value, which the stand-in changes).

A call it cannot follow (indirect, or a service of a device it has no original of) may change EAX, ECX and EDX, as C
code may, and a callee it lost its way in any register: neither is reported. An original whose own stack it cannot
follow to its returns (a thread switch's ESP, a jump through a register) is left out, and counted. The originals: VMM32.VXD (its VMM) and the VxDs of the Windows 95 CD's
cabinets (WIN95_*.CAB), taken from cdrom.iso with 7z, or a folder of them. Writes findings/realcheck.json.

python3 tools/realcheck.py [--vxds DIR] [system.js]
"""
import json, os, shutil, struct, subprocess, sys, tempfile
import capstone
from capstone import x86_const as X
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from recomp import LE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]; vxdir = None
if '--vxds' in args: k = args.index('--vxds'); vxdir = args[k + 1]; del args[k:k + 2]
BUNDLE = args[0] if args else os.path.join(ROOT, 'system.js')

def originals(d):
    """the VxDs in folder d by device id (a W3 file's each, VMM32.VXD's VMM)"""
    out = {}
    for f in sorted(os.listdir(d)):
        if not os.path.isfile(os.path.join(d, f)): continue
        data = bytearray(open(os.path.join(d, f), 'rb').read())
        if len(data) < 0x40 or data[:2] != b'MZ': continue
        o = struct.unpack_from('<I', data, 0x3c)[0]
        try:
            if data[o:o + 2] == b'W3':
                for i in range(struct.unpack_from('<H', data, o + 4)[0]):
                    struct.pack_into('<I', data, 0x3c, struct.unpack_from('<I', data, o + 24 + 16 * i)[0])
                    le = LE(bytes(data), 0x10000); le.file = f; out.setdefault(le.vxd_id, le)
            elif data[o:o + 2] == b'LE':
                le = LE(bytes(data), 0x10000); le.file = f; out.setdefault(le.vxd_id, le)
        except Exception: pass
    return out

if not vxdir:
    vxdir = tempfile.mkdtemp(prefix='realcheck'); iso = os.path.join(ROOT, 'cdrom.iso'); cabs = os.path.join(vxdir, 'cabs')
    subprocess.run(['7z', 'e', '-y', '-o' + cabs, iso, 'WIN95/WIN95_*.CAB', 'WIN95/VMM32.VXD'], check=True, capture_output=True)
    for c in sorted(os.listdir(cabs)):
        if c.upper().endswith('.CAB'): subprocess.run(['7z', 'e', '-y', '-o' + vxdir, os.path.join(cabs, c), '*.vxd', '*.386'], capture_output=True)
    os.replace(os.path.join(cabs, 'VMM32.VXD'), os.path.join(vxdir, 'VMM32.VXD'))
    devs = originals(vxdir); shutil.rmtree(vxdir)
else: devs = originals(vxdir)

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32); md.detail = True
FULL = {}
for r32, parts in {'eax': ('eax', 'ax', 'al', 'ah'), 'ebx': ('ebx', 'bx', 'bl', 'bh'), 'ecx': ('ecx', 'cx', 'cl', 'ch'), 'edx': ('edx', 'dx', 'dl', 'dh'),
                   'esi': ('esi', 'si'), 'edi': ('edi', 'di'), 'ebp': ('ebp', 'bp'), 'esp': ('esp', 'sp')}.items():
    for p in parts: FULL[p] = r32
GPR = ('eax', 'ecx', 'edx', 'ebx', 'esi', 'edi', 'ebp')
IX = {r: k for k, r in enumerate(GPR)}
PUSHAD = ('edi', 'esi', 'ebp', 'esp', 'ebx', 'edx', 'ecx', 'eax')   # (the frame from its lowest dword)
FL = {'cf': (X.X86_EFLAGS_TEST_CF, X.X86_EFLAGS_MODIFY_CF | X.X86_EFLAGS_SET_CF | X.X86_EFLAGS_RESET_CF),
      'zf': (X.X86_EFLAGS_TEST_ZF, X.X86_EFLAGS_MODIFY_ZF | X.X86_EFLAGS_SET_ZF | X.X86_EFLAGS_RESET_ZF),
      'sf': (X.X86_EFLAGS_TEST_SF, X.X86_EFLAGS_MODIFY_SF | X.X86_EFLAGS_SET_SF | X.X86_EFLAGS_RESET_SF),
      'of': (X.X86_EFLAGS_TEST_OF, X.X86_EFLAGS_MODIFY_OF | X.X86_EFLAGS_SET_OF | X.X86_EFLAGS_RESET_OF)}
ALU = {'add', 'adc', 'sub', 'sbb', 'cmp', 'test', 'and', 'or', 'xor', 'neg', 'inc', 'dec', 'shl', 'shr', 'sar', 'sal', 'bt', 'bts', 'btr', 'btc'}
LIMIT = 20000

def insn(le, a):
    o = a - le.base
    if not 0 <= o < len(le.image): return None
    return next(md.disasm(bytes(le.image[o:o + 16]), a, 1), None)

def full(i, r): n = i.reg_name(r); return FULL.get(n, n)
def reg32(i, o): return o.type == X.X86_OP_REG and o.size == 4 and full(i, o.reg) in IX

def esp_slot(stack, k):
    """the stack entry [esp+k] is in, and the dword's index within it"""
    off = 0
    for idx in range(len(stack) - 1, -1, -1):
        size = 32 if stack[idx][0] == 'pd' else 4
        if off <= k < off + size: return idx, (k - off) // 4
        off += size
    return None, None

memo = {}
def summary(le, entry, depth=0):
    """on the ways from `entry` to a return: (the registers not holding their own value, those a call it cannot follow
    may have changed, the flags it sets, whether such a call may have set the flags, whether it lost its way)"""
    key = (le.vxd_id, entry)
    if key in memo: return memo[key]
    memo[key] = (frozenset(), frozenset(), frozenset(), False, True, 0)   # (recursion)
    outs, maybe, flags, fmaybe, unsure, pops = set(), set(), set(), False, False, None
    # a state: (address, each register's value: the register whose value on entry it holds, '?' another, '??' what a
    # call it cannot follow may have left, as C code may (EAX, ECX, EDX); the stack, entries ('v', value) and ('pd',
    # the registers' values, the frame's dwords stored to since); the stack's depth EBP was set at; the flags set, '?'
    # among them when such a call may have)
    work = [(entry, GPR, (), None, frozenset())]; seen = set(); steps = 0
    while work and steps < LIMIT:
        state = work.pop(); steps += 1
        if state in seen: continue
        seen.add(state)
        a, v, st, eb, fl = state
        i = insn(le, a)
        if i is None: unsure = True; continue
        m, ops = i.mnemonic, i.operands; nxt = a + i.size; v = list(v); st = list(st); fl = set(fl)
        def go(to, v=v, st=st, eb=eb, fl=fl): work.append((to, tuple(v), tuple(st), eb, frozenset(fl)))
        def clobber(regs, val='?'):
            for r in regs:
                if r in IX: v[IX[r]] = val
        def called(s):
            # (and the arguments a callee's ret n takes off the stack)
            # (a callee it lost its way in may have changed any register: what this one returns for sure stays sure)
            nonlocal st, unsure
            cw, cm, cf, cfm, cu, cpops = s
            if cpops is None: unsure = True   # (no return found: what it takes off the stack is not known)
            elif cpops: st = st[:max(0, len(st) - cpops // 4)]
            if cu: clobber(GPR, '??'); return {'?'}
            clobber(cw); clobber(cm, '??')
            return set(cf) | ({'?'} if cfm else set())
        def returns(n=0):
            nonlocal fmaybe, pops, unsure
            outs.update(r for r in GPR if v[IX[r]] not in (r, '??')); maybe.update(r for r in GPR if v[IX[r]] == '??')
            flags.update(fl - {'?'}); fmaybe |= '?' in fl
            if pops is None: pops = n
            elif pops != n: unsure = True
        if m == 'int' and i.op_str == '0x20':
            code = struct.unpack_from('<I', le.image, a + 2 - le.base)[0]; d, n = code >> 16, code & 0x7fff
            callee = devs.get(d)
            if callee and n < len(callee.services) and callee.in_code(callee.services[n]) and depth < 12: fl = called(summary(callee, callee.services[n], depth + 1))
            else: clobber(('eax', 'ecx', 'edx'), '??'); fl = {'?'}
            if code & 0x8000:   # (VxDJmp: its return is this one's, or to an address pushed for it)
                if st and st[-1][0] == 'ret': go(st[-1][1], v, st[:-1], eb, fl)
                elif st: unsure = True
                else: returns()
                continue
            go(a + 6, v, st, eb, fl); continue
        if m in ('ret', 'retf'):
            # (to an address the code pushed itself, push then jmp as a call; with more on the stack than this
            # function put there, a way the stack model lost)
            if st and st[-1][0] == 'ret': t = st.pop()[1]; st = st[:max(0, len(st) - (ops[0].imm // 4 if ops else 0))]; go(t, v, st, eb, fl); continue
            if st: unsure = True; continue
            returns(ops[0].imm if ops else 0); continue
        if m in ('iret', 'iretd', 'hlt', 'ud2', 'int3'): continue
        if m == 'push' and ops:
            o = ops[0]
            st.append(('v', v[IX[full(i, o.reg)]]) if reg32(i, o) else ('ret', o.imm & 0xffffffff) if o.type == X.X86_OP_IMM and le.in_code(o.imm & 0xffffffff) else ('v', '?'))
        elif m == 'pop' and ops:
            top = st.pop() if st else ('v', '?')
            if reg32(i, ops[0]): v[IX[full(i, ops[0].reg)]] = top[1] if top[0] == 'v' else '?'
        elif m == 'pushal': st.append(('pd', tuple(v), ()))
        elif m == 'popal':
            top = st.pop() if st else ('v', '?')
            if top[0] == 'pd':
                v = list(top[1])
                for r, val in top[2]: v[IX[r]] = val
            else: clobber(GPR)
        elif m in ('pushfd', 'pushf'): st.append(('v', '?'))
        elif m in ('popfd', 'popf'):
            if st: st.pop()
            fl = set()
        elif m == 'leave':
            if eb is not None: st = st[:eb]
            else: unsure = True
            top = st.pop() if st else ('v', '?'); v[IX['ebp']] = top[1] if top[0] == 'v' else '?'; eb = None
        elif m == 'enter': st.append(('v', v[IX['ebp']])); v[IX['ebp']] = '?'; eb = len(st); st += [('v', '?')] * (ops[0].imm // 4)   # (and its locals)
        elif m == 'mov' and len(ops) == 2 and ops[0].type == X.X86_OP_REG and full(i, ops[0].reg) == 'esp':
            if ops[1].type == X.X86_OP_REG and full(i, ops[1].reg) == 'ebp' and eb is not None: st = st[:eb]
            else: unsure = True
        elif m == 'mov' and len(ops) == 2 and ops[0].type == X.X86_OP_REG and full(i, ops[0].reg) == 'ebp' and ops[1].type == X.X86_OP_REG and full(i, ops[1].reg) == 'esp':
            eb = len(st); v[IX['ebp']] = '?'
        elif m == 'lea' and full(i, ops[0].reg) == 'esp':
            mm = ops[1].mem
            if mm.base and full(i, mm.base) == 'ebp' and mm.index == 0 and eb is not None and mm.disp <= 0: st = st[:eb + (-mm.disp) // 4]
            elif mm.base and full(i, mm.base) == 'esp' and mm.index == 0: n = mm.disp // 4; st = st[:len(st) - n] if n >= 0 else st + [('v', '?')] * -n
            else: unsure = True
        elif m in ('add', 'sub') and ops[0].type == X.X86_OP_REG and full(i, ops[0].reg) == 'esp':
            if ops[1].type != X.X86_OP_IMM: unsure = True
            else:
                n = ops[1].imm // 4 * (1 if m == 'add' else -1)
                st = st[:max(0, len(st) - n)] if n >= 0 else st + [('v', '?')] * -n
            fl = set(); go(nxt, v, st, eb, fl); continue
        elif m == 'call':
            t = ops[0].imm & 0xffffffff if ops and ops[0].type == X.X86_OP_IMM else None
            if t is not None and le.in_code(t) and depth < 12: fl = called(summary(le, t, depth + 1))
            else: clobber(('eax', 'ecx', 'edx'), '??'); fl = {'?'}
            go(nxt, v, st, eb, fl); continue
        elif m == 'mov' and len(ops) == 2 and reg32(i, ops[0]) and reg32(i, ops[1]): v[IX[full(i, ops[0].reg)]] = v[IX[full(i, ops[1].reg)]]
        elif m == 'xchg' and len(ops) == 2 and reg32(i, ops[0]) and reg32(i, ops[1]):
            x, y = IX[full(i, ops[0].reg)], IX[full(i, ops[1].reg)]; v[x], v[y] = v[y], v[x]
        else:
            # (a store to the stack: into a pushad frame it is what popad gives that register; over a saved value it is
            # that dword's now)
            for o in ops:
                if o.type == X.X86_OP_MEM and o.access & capstone.CS_AC_WRITE and o.mem.index == 0 and o.mem.base and full(i, o.mem.base) in ('esp', 'ebp'):
                    k = o.mem.disp
                    if full(i, o.mem.base) == 'ebp':
                        if eb is None: continue
                        k += sum(32 if e[0] == 'pd' else 4 for e in st[eb:])   # (EBP is ESP as it was then)
                    idx, sub = esp_slot(st, k)
                    if idx is None: continue
                    val = v[IX[full(i, ops[1].reg)]] if m == 'mov' and len(ops) == 2 and reg32(i, ops[1]) else '?'
                    e = st[idx]
                    if e[0] == 'pd':
                        if PUSHAD[sub] != 'esp': st[idx] = ('pd', e[1], tuple((r, x) for r, x in e[2] if r != PUSHAD[sub]) + ((PUSHAD[sub], val),))
                    else: st[idx] = ('v', val)
            clobber({full(i, r) for r in i.regs_access()[1]})
        for k, (test, mod) in FL.items():
            if i.eflags & mod or (m in ALU and not (k == 'cf' and m in ('inc', 'dec'))) or (k == 'cf' and m in ('clc', 'stc', 'cmc')): fl.add(k)
        if m in ('loop', 'loope', 'loopne'): clobber(('ecx',))
        if m == 'jmp':
            o = ops[0]
            if o.type == X.X86_OP_IMM: go(o.imm & 0xffffffff, v, st, eb, fl)
            elif o.type == X.X86_OP_MEM and o.mem.base == 0 and o.mem.scale == 4 and le.base <= (o.mem.disp & 0xffffffff) < le.base + len(le.image):
                # (a jump table: its entries while they are addresses of code)
                t = (o.mem.disp & 0xffffffff) - le.base
                for e in range(256):
                    x = struct.unpack_from('<I', le.image, t + 4 * e)[0] if t + 4 * e + 4 <= len(le.image) else 0
                    if not le.in_code(x): break
                    go(x, v, st, eb, fl)
                if e == 0: unsure = True
            else: unsure = True
            continue
        if capstone.CS_GRP_JUMP in i.groups and ops[0].type == X.X86_OP_IMM: go(ops[0].imm & 0xffffffff, v, st, eb, fl)
        go(nxt, v, st, eb, fl)
    if work: unsure = True
    r = (frozenset(outs), frozenset(maybe - outs), frozenset(flags), fmaybe, unsure, pops)
    memo[key] = r
    return r

gap = json.load(open(os.path.join(ROOT, 'findings', 'gapmap.json')))
reads = gap['services'].get('reads', {})
standins = json.loads(subprocess.run(['node', os.path.join(ROOT, 'tools', 'gapmap.mjs'), '--standins', BUNDLE], capture_output=True, text=True, check=True).stdout)
report, checked, unfollowed = {}, 0, []
for k, st in sorted(standins.items()):
    d, n = (int(x, 16) for x in k.split(':'))
    le = devs.get(d)
    if not le or n >= len(le.services) or not le.in_code(le.services[n]): continue
    w, mw, f, fm, unsure, _ = summary(le, le.services[n])
    if unsure: unfollowed.append(k); continue
    checked += 1
    # (what a call it could not follow may have changed is neither a result it returns for sure nor one it keeps)
    real = set(w) | set(f); sets = (set(st['sets']) | set(st.get('srcSets', []))) - {'esp', 'eip', 'budget', 'pf', 'df', 'if'}; rd = reads.get(k, {})
    missing = {r: rd[r] for r in sorted((real - sets) & set(rd))}
    clobbers = {r: rd[r] for r in sorted((sets - real - set(mw) - (set(FL) if fm else set())) & set(rd))}
    if missing or clobbers:
        report[k] = {'original': '%s+%x' % (le.file, le.services[n] - le.base), 'returns': sorted(real), **({'may': sorted(mw)} if mw else {}), 'standin': sorted(sets),
                     **({'missing': missing} if missing else {}), **({'clobbers': clobbers} if clobbers else {}), 'source': st['source']}
json.dump({'mismatches': report, 'unfollowed': unfollowed}, open(os.path.join(ROOT, 'findings', 'realcheck.json'), 'w'), indent=1)
print('stand-ins checked against an original: %d (and %d whose original it could not follow)' % (checked, len(unfollowed)))
for k, v in report.items():
    print('%s  %s  returns %s, the stand-in sets %s' % (k, v['original'], ' '.join(v['returns']), ' '.join(v['standin'])))
    for r, s in v.get('missing', {}).items(): print('    missing  %-4s read at %s' % (r, ' '.join(s[:4])))
    for r, s in v.get('clobbers', {}).items(): print('    clobbers %-4s read at %s' % (r, ' '.join(s[:4])))
