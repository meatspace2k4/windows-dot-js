"""The gap map for programs the bundle does not carry, by static analysis of their files, nothing run: Windows 3.x (NE)
modules as KERNEL's loader maps them from disk, their code translated as it runs. For each module, from its entry
point and exports along direct control flow (near transfers in a segment, far ones through its relocations to its
own segments):

- interrupts: every INT reached and KERNEL's DOS3Call (INT 21h), with AX as the code before it sets it (a MOV of a
  constant to AX, AH or AL on the way from the block's start), checked against the emulator's own handlers
  (tools/gapmap.mjs --ints: the interrupt run on an empty machine, an "unhandled" answer a gap);
- imports: every far call through an import relocation, by module and ordinal or name: one the system does not
  export (no stand-in, no export of the bundle's module of that name), and a stand-in answering a word (AX) whose
  caller reads DX after the call without setting it (KERNEL's GetVersion, whose DX is the MS-DOS version);
- ports: every IN and OUT with a constant port (an immediate, or DX set to one before it), with the handlers that take
  it (tools/gapmap.mjs --ports);
- run-time translation: the reached block starts dyn.js cannot translate (tools/gapmap.mjs --dyn, as staticmap.py).

python3 tools/filemap.py <file or folder> ... [--out findings/filemap.json]
"""
import json, os, struct, subprocess, sys
from collections import defaultdict
import capstone
from capstone import x86_const as X

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:]]
out_path = os.path.join(ROOT, 'findings', 'filemap.json')
if '--out' in args: i = args.index('--out'); out_path = args[i + 1]; del args[i:i + 2]
files = []
for a in args:
    if os.path.isdir(a): files += [os.path.join(a, f) for f in sorted(os.listdir(a))]
    else: files.append(a)

u16 = lambda d, o: struct.unpack_from('<H', d, o)[0]
u32 = lambda d, o: struct.unpack_from('<I', d, o)[0]
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_16); md.detail = True

class NE:
    """an NE file: its segments' bytes, its relocations by segment and offset, its entry table, its imported names"""
    def __init__(self, path):
        d = self.d = open(path, 'rb').read(); n = self.n = u32(d, 0x3c)
        if d[n:n + 2] != b'NE': raise ValueError('not NE')
        self.path, shift = path, u16(d, n + 0x32) or 9
        self.name = d[n + u16(d, n + 0x26) + 1:n + u16(d, n + 0x26) + 1 + d[n + u16(d, n + 0x26)]].decode('latin1')
        self.mods = []
        for i in range(u16(d, n + 0x1e)):
            p = n + u16(d, n + 0x2a) + u16(d, n + u16(d, n + 0x28) + 2 * i); self.mods.append(d[p + 1:p + 1 + d[p]].decode('latin1').upper())
        self.segs, self.fix = [], {}
        for i in range(u16(d, n + 0x1c)):
            o = n + u16(d, n + 0x22) + 8 * i; off, ln, fl = u16(d, o) << shift, u16(d, o + 2) or 0x10000, u16(d, o + 4)
            data = d[off:off + ln] if off else b''
            self.segs.append({'num': i + 1, 'data': data, 'flags': fl, 'code': not fl & 1})
            fx = self.fix[i + 1] = {}
            if off and fl & 0x100:
                r = off + ln; cnt = u16(d, r); r += 2
                for k in range(cnt):
                    at, rt, o2, a1, a2 = d[r], d[r + 1], u16(d, r + 2), u16(d, r + 4), u16(d, r + 6); r += 8
                    t = rt & 3
                    if t == 0: tgt = ('int', a1, a2) if at != 2 else ('sel', a1)   # (a selector alone: the offset is the code's own)
                    elif t == 1: tgt = ('imp', self.mods[a1 - 1], '#%d' % a2)
                    elif t == 2: q = n + u16(d, n + 0x2a) + a2; tgt = ('imp', self.mods[a1 - 1], d[q + 1:q + 1 + d[q]].decode('latin1'))
                    else: continue
                    if rt & 4: fx[o2] = tgt; continue   # (additive: one place)
                    seen = set()
                    while o2 != 0xffff and o2 < len(data) and o2 not in seen:   # (a chain through the places it goes)
                        seen.add(o2); fx[o2] = tgt; o2 = u16(data, o2) if at in (2, 3, 5) else 0xffff
        # the entry table: ordinal -> (segment, offset); 0FFh bundles' movable entries through their segment
        self.entries = {}; p = n + u16(d, n + 4); ordn = 1
        while True:
            cnt, seg = d[p], d[p + 1]; p += 2
            if cnt == 0: break
            for _ in range(cnt):
                if seg == 0: ordn += 1; continue
                if seg == 0xff: self.entries[ordn] = (d[p + 3], u16(d, p + 4)); p += 6
                else: self.entries[ordn] = (seg, u16(d, p + 1)); p += 3
                ordn += 1
        cs, ip = u16(d, n + 0x16), u16(d, n + 0x14)
        self.start = [(cs, ip)] if cs else []
    def fixup(self, seg, off):
        """the relocation that fills the far pointer at seg:off (an internal target as (seg, off); an import)"""
        t = self.fix.get(seg, {}).get(off)
        if not t: return None
        if t[0] == 'int': return ('int', self.entries.get(t[2], (None, 0)) if t[1] == 0xff else (t[1], t[2]))
        return t

def reach(ne, scan=True):
    """recursive descent over each code segment from the entry points; the instructions and the block starts. With
    `scan`, from each address of its code a relocation fills in anywhere in it too (far pointers in tables, callbacks,
    window procedures), as staticmap.py takes the image's pointers to blocks: some are data in a code segment"""
    ptrs = [ne.fixup(s, o)[1] for s, fx in ne.fix.items() for o, t in fx.items() if t[0] == 'int'] if scan else []
    work = [e for e in ne.start + list(ne.entries.values()) + ptrs if e[0] and e[0] <= len(ne.segs) and ne.segs[e[0] - 1]['code']]
    seen, insns, starts = set(), {}, set(work)
    while work:
        seg, a = work.pop(); data = ne.segs[seg - 1]['data']
        while (seg, a) not in seen and a < len(data):
            i = next(md.disasm(data[a:a + 16], a, 1), None)
            if i is None: break
            seen.add((seg, a)); insns[(seg, a)] = i; nxt = a + i.size; g = i.groups
            if i.mnemonic in ('lcall', 'ljmp') and i.size == 5:
                f = ne.fixup(seg, a + 1)
                if f is None:   # (the selector alone relocated, at +3: the offset is the instruction's)
                    s3 = ne.fix.get(seg, {}).get(a + 3)
                    if s3 and s3[0] == 'sel' and s3[1] != 0xff: f = ('int', (s3[1], u16(data, a + 1)))
                if f and f[0] == 'int' and f[1][0]: work.append(f[1]); starts.add(f[1])
                if i.mnemonic == 'ljmp': break
                starts.add((seg, nxt)); a = nxt; continue
            if capstone.CS_GRP_JUMP in g or capstone.CS_GRP_CALL in g:
                op = i.operands[0] if i.operands else None
                if op is not None and op.type == X.X86_OP_IMM: t = (seg, op.imm & 0xffff); work.append(t); starts.add(t)
                if i.mnemonic == 'jmp': break
                starts.add((seg, nxt))
            if i.mnemonic in ('ret', 'retf', 'iret', 'hlt') or capstone.CS_GRP_RET in g: break
            a = nxt
    return insns, starts

def consts_before(insns, starts, seg, a):
    """the constants AX, BX, CX and DX hold at seg:a, from the moves of constants since its block's start"""
    s = max((o for (sg, o) in starts if sg == seg and o <= a), default=a)
    v = {}; p = s
    while p < a:
        i = insns.get((seg, p))
        if i is None: break
        ops = i.operands
        if i.mnemonic == 'mov' and len(ops) == 2 and ops[0].type == X.X86_OP_REG and ops[1].type == X.X86_OP_IMM:
            r = i.reg_name(ops[0].reg); imm = ops[1].imm
            if r in ('ax', 'bx', 'cx', 'dx'): v[r] = imm & 0xffff
            elif r in ('ah', 'bh', 'ch', 'dh'): k = r[0] + 'x'; v[k] = ((imm & 0xff) << 8) | (v.get(k, 0x10000) & 0xff) if k in v else ((imm & 0xff) << 8) | 0x100000
            elif r in ('al', 'bl', 'cl', 'dl'): k = r[0] + 'x'; v[k] = (v[k] & 0xff00) | (imm & 0xff) if k in v and v[k] < 0x10000 else (imm & 0xff) | 0x200000
        elif i.mnemonic == 'xor' and len(ops) == 2 and ops[0].type == ops[1].type == X.X86_OP_REG and ops[0].reg == ops[1].reg and i.reg_name(ops[0].reg) in ('ax', 'bx', 'cx', 'dx'):
            v[i.reg_name(ops[0].reg)] = 0
        else:
            for r in i.regs_access()[1]:
                n = i.reg_name(r); k = n[0] + 'x' if n in ('ah', 'al', 'bh', 'bl', 'ch', 'cl', 'dh', 'dl', 'ax', 'bx', 'cx', 'dx', 'eax', 'ebx', 'ecx', 'edx') else None
                if n in ('eax', 'ebx', 'ecx', 'edx'): k = n[1] + 'x'
                if k: v.pop(k, None)
        p += i.size
    return v   # (100000h | AH<<8: only AH known; 200000h | AL: only AL known)

def reads_dx_after(insns, seg, a, limit=16):
    """whether DX (or EDX, DL, DH) is read after the call at seg:a before something writes it, straight on"""
    p = a; n = 0
    while n < limit:
        i = insns.get((seg, p))
        if i is None: return False
        rd, wr = i.regs_access(); rn = {i.reg_name(r) for r in rd}; wn = {i.reg_name(r) for r in wr}
        ops = i.operands
        if i.mnemonic in ('sub', 'xor') and len(ops) == 2 and ops[0].type == ops[1].type == X.X86_OP_REG and ops[0].reg == ops[1].reg: rn -= {i.reg_name(ops[0].reg)}   # (sub dx, dx: a write)
        if rn & {'dx', 'edx', 'dl', 'dh'}: return True
        if wn & {'dx', 'edx'}: return False
        if i.mnemonic in ('ret', 'retf', 'jmp', 'ljmp', 'lcall', 'call') or capstone.CS_GRP_JUMP in i.groups: return False
        p += i.size; n += 1
    return False

mods, ints, imports, ports, dyn_starts, bases = {}, defaultdict(list), defaultdict(list), defaultdict(list), {}, {}
lin = 0x01000000   # (where each module's segments are put for the run-time translation check: 64 KB apart)
for path in files:
    try: ne = NE(path)
    except Exception: continue
    insns, starts = reach(ne); flow = set(reach(ne, scan=False)[0])
    name = os.path.basename(path).upper()
    for (seg, a), i in sorted(insns.items()):
        site = '%s %d:%x%s' % (name, seg, a, '' if (seg, a) in flow else ' (pointer)')   # (pointer: reached only from a relocated address)
        if i.mnemonic == 'int':
            vec = int(i.op_str, 16); v = consts_before(insns, starts, seg, a); ints[(vec, v.get('ax'), v.get('bx'), v.get('cx'))].append(site)
        elif i.mnemonic == 'lcall' and i.size == 5:
            f = ne.fixup(seg, a + 1)
            if f and f[0] == 'imp':
                key = '%s.%s' % (f[1], f[2]); dx = reads_dx_after(insns, seg, a + 5)
                imports[key].append([site, dx])
                if key == 'KERNEL.#102': v = consts_before(insns, starts, seg, a); ints[(0x21, v.get('ax'), v.get('bx'), v.get('cx'))].append(site + ' (DOS3Call)')
        elif i.mnemonic in ('in', 'out'):
            ops = i.operands; po = ops[1] if i.mnemonic == 'in' else ops[0]
            port = po.imm if po.type == X.X86_OP_IMM else consts_before(insns, starts, seg, a).get('dx')
            if port is not None and port < 0x10000: ports[(port, i.mnemonic)].append(site)
    segs = {}
    for s in ne.segs:
        if s['code'] and s['data']: segs[s['num']] = lin; lin += 0x10000
    dyn_starts[name] = {'segs': {str(k): v for k, v in segs.items()}, 'file': path, 'starts': sorted('%d:%x%s' % (sa[0], sa[1], '' if sa in flow else '*') for sa in starts if sa[0] in segs)}
    mods[name] = {'module': ne.name, 'imports': ne.mods, 'reachable': len(insns), 'blockStarts': len(starts)}

# the emulator's answers: tools/gapmap.mjs runs its handlers and reads its tables
q = {'ints': [[k[0], k[1], k[2], k[3]] for k in ints], 'imports': sorted(imports), 'ports': sorted({p for p, _ in ports}), 'dyn': dyn_starts}
tmp = os.path.join(ROOT, 'findings', '.filemap-q.json'); os.makedirs(os.path.dirname(tmp), exist_ok=True); json.dump(q, open(tmp, 'w'))
ans = json.loads(subprocess.run(['node', os.path.join(ROOT, 'tools', 'gapmap.mjs'), '--files', tmp], capture_output=True, text=True, check=True).stdout)
os.remove(tmp)

def axs(v):
    if v is None: return '?'
    if v & 0x100000: return '%02x??' % ((v >> 8) & 0xff)
    if v & 0x200000: return '??%02x' % (v & 0xff)
    return '%04x' % v
res = {'modules': mods, 'interrupts': {}, 'imports': {}, 'ports': {}, 'dynUntranslatable': ans['dyn']}
for k, sites in ints.items():
    a = ans['ints'].get(','.join(json.dumps(x) for x in k))
    res['interrupts']['int %02xh ax=%s%s' % (k[0], axs(k[1]), '' if k[2] is None else ' bx=%04x' % (k[2] & 0xffff))] = {'answer': a, 'sites': sites[:6], 'count': len(sites)}
# a module the bundle carries (Windows 95's own, recompiled), or one of the files analysed (the program's own): its
# export by ordinal or name. Where both have the module, both are said: which one the loader takes decides the code run
src = open(os.path.join(ROOT, 'system.js')).read(); at = src.index('window.W95SYSTEM = ') + 19
NEB = json.loads(src[at:src.rindex(';')])['ne']; del src
own = {}
for path in files:
    try: x = NE(path)
    except Exception: continue
    own[x.name.upper()] = ({str(k) for k in x.entries}, x)
def native(mod, fn):
    m = NEB.get(mod)
    if not m: return None
    meta = m['meta']; return fn[1:] in meta.get('exports', {}) if fn[0] == '#' else fn.upper() in {k.upper() for k in meta.get('names', {})}
for k, calls in imports.items():
    a = ans['imports'].get(k, {}); dx = [s for s, r in calls if r]
    mod, fn = k.split('.', 1)
    have = a.get('have') or ('Windows 95 module' if native(mod, fn) else None)
    if mod in own and (fn[0] != '#' or fn[1:] in own[mod][0]): have = (have + ' and the program\'s own') if have else 'the program\'s own'
    a = {**a, 'have': have}
    e = {'have': a.get('have'), 'count': len(calls)}
    if not a.get('have'): e['sites'] = [s for s, _ in calls[:4]]
    if a.get('ret') == 'w' and dx: e['dxRead'] = dx[:4]
    res['imports'][k] = e
for (p, op), sites in ports.items():
    res['ports']['%s %xh' % (op, p)] = {'handled': ans['ports'].get(str(p)), 'sites': sites[:4], 'count': len(sites)}
json.dump(res, open(out_path, 'w'), indent=1)

print('modules:', len(mods), 'reachable instructions:', sum(m['reachable'] for m in mods.values()))
print('interrupts the emulator does not answer:')
for k, e in sorted(res['interrupts'].items()):
    if e['answer'] and e['answer'].startswith('unhandled'): print('  %-30s %3d  %s   %s' % (k, e['count'], ' '.join(e['sites'][:2]), e['answer']))
print('interrupts whose function the code leaves unknown here (AX set elsewhere):', sum(1 for k in res['interrupts'] if '?' in k.split('ax=')[1][:4]))
print('imports the system does not have:')
for k, e in sorted(res['imports'].items()):
    if not e['have']: print('  %-24s %3d  %s' % (k, e['count'], ' '.join(e['sites'][:2])))
print('stand-ins answering AX alone whose callers read DX:')
for k, e in sorted(res['imports'].items()):
    if e.get('dxRead'): print('  %-24s %s' % (k, ' '.join(e['dxRead'][:3])))
print('ports nothing handles:')
for k, e in sorted(res['ports'].items()):
    if not e['handled']: print('  %-10s %3d  %s' % (k, e['count'], ' '.join(e['sites'][:2])))
print('run-time translation, blocks it cannot take, by control flow (and only through a relocated address):')
for k, e in sorted(ans['dyn'].items(), key=lambda kv: (-kv[1]['flow'], -kv[1]['count'])): print('  %5d (%5d)  %-40s %s' % (e['flow'], e['count'] - e['flow'], k, ' '.join((e['flowAt'] or e['first'])[:3])))
