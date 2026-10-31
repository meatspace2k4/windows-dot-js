"""Write msdos.js: what the MS-DOS machine (v86.js) boots from, taken from the Windows 95 CD's files: the boot sector
SYS.COM writes (FAT12/16, OEM name MSWIN4.1), IO.SYS (the CD's WINBOOT.SYS), COMMAND.COM, and what IO.SYS loads from
the Windows folder (IFSHLP.SYS; WIN.COM, whose start is where Windows takes the machine over: Setup builds it from
WIN.CNF). The files are looked for under each folder given (an extracted CD's cabinets, or a SYS_DIR).

    python3 tools/build_dos.py OUT.js DIR [DIR ...]
"""
import base64, json, os, re, sys

out, dirs = sys.argv[1], sys.argv[2:]
WANT = {'winboot.sys': 'IO.SYS', 'command.com': 'COMMAND.COM', 'ifshlp.sys': 'WINDOWS\\IFSHLP.SYS', 'win.cnf': 'WINDOWS\\WIN.COM', 'sys.com': None}
# the MS-DOS programs Setup puts in C:\WINDOWS\COMMAND (LDID_COMMAND), which the machine runs from there
COMMAND = ['attrib.exe', 'chkdsk.exe', 'choice.com', 'debug.exe', 'deltree.exe', 'diskcopy.com', 'doskey.com', 'edit.com', 'fc.exe', 'fdisk.exe',
           'find.exe', 'format.com', 'keyb.com', 'label.exe', 'mem.exe', 'mode.com', 'more.com', 'move.exe', 'mscdex.exe', 'nlsfunc.exe',
           'sort.exe', 'subst.exe', 'sys.com', 'xcopy.exe', 'xcopy32.exe']
# the Windows 3.x runtime libraries Setup puts in C:\WINDOWS\SYSTEM that nothing in the system bundle is recompiled
# from (programs load them as they are, ne16.js loadNEDynamic): the x87 emulator Visual Basic and C programs import,
# Network DDE, OLE 1 and the 16-bit OLE 2, Windows Sockets
SYSTEM = ['win87em.dll', 'nddeapi.dll', 'nddenb.dll', 'olecli.dll', 'olesvr.dll', 'compobj.dll', 'storage.dll', 'ole2.dll', 'ole2disp.dll',
          'ole2nls.dll', 'ole2conv.dll', 'typelib.dll', 'stdole.tlb', 'winsock.dll',
          'cards.dll',   # (the Games' card library, APPLETS.INF wingames.sys)
          'mmsound.drv',   # (Windows 3.x's sound functions, module SOUND: COPY.INF, SYSTEM.INI [boot] sound.drv; Minesweeper imports them)
          'riched32.dll',   # (the rich edit control, COPY.INF: WordPad loads it by name, LoadLibrary, not as an import)
          'vmm32.vxd']   # (the virtual machine manager and the static VxDs, which WIN.COM loads from SYSTEM to start Windows)
# the VxDs the machine's devices name (SYSTEM.INI [386Enh], the registry's StaticVxD) that VMM32.VXD does not hold, which
# VMM32's loader reads from the disk as WIN.COM starts Windows: one named *NAME from SYSTEM\VMM32 (LDID 22), the
# others from SYSTEM, where Setup copies them (MSMOUSE.INF, NETTRANS.INF, NET.INF)
VXDS = ['msmouse.vxd', 'ndis.vxd', 'ndis2sup.vxd', 'vnetbios.vxd', 'vnetsup.vxd', 'vredir.vxd']
# the VxDs Setup packs into VMM32.VXD with VMM as it installs Windows (the CD's VMM32.VXD holds VMM alone): the base
# set VMM's loader names, and the mouse's (VMOUSE, *vmouse in SYSTEM.INI)
PACKED = ['biosxlat', 'configmg', 'dosmgr', 'dynapage', 'ebios', 'ifsmgr', 'int13', 'ios', 'pageswap', 'qemmfix', 'shell', 'v86mmgr',
          'vcache', 'vcd', 'vcomm', 'vcond', 'vdd', 'vdmad', 'vfat', 'vkd', 'vmcpd', 'vpd', 'vpicd', 'vtd', 'vtdapi', 'vwin32', 'vxdldr', 'vmouse']
# Setup's optional components, installed as Setup installs one that is chosen (its INF: CopyFiles to the Windows folder,
# LDID 25, and the help folder, LDID 18; its links and registry): Clipboard Viewer (CLIP.INF), and the Games
# (APPLETS.INF [games]: wingames.files, wingames.help; their links, wingames.links)
GAMES = ['freecell', 'mshearts', 'sol', 'winmine']
WINDOWS = ['clipbrd.exe'] + [g + '.exe' for g in GAMES] + ['control.exe',   # (and the base install's CONTROL.EXE: Run's 'control')
           'regedit.exe', 'taskman.exe', 'winfile.exe', 'write.exe', 'progman.exe']   # (and its other programs in the Windows folder)
# the components a Typical install sets up (InstallType bit 2) that the system bundle does not carry: each one's files
# where its INF's CopyFiles and DestinationDirs put them, and the INF, whose AddReg, UpdateInis and links Windows makes
# as Setup does (win95.js installComponents)
TYPICAL = [('applets.inf', 'mspaint'), ('applets.inf', 'msonline'), ('applets.inf', 'Dialer'), ('applets.inf', 'DiskTools'),
           ('wordpad.inf', 'MSWordPad'), ('shell.inf', 'templates'), ('enable.inf', 'Install_Enable'),
           ('tapi.inf', 'tapi')]   # (and the base install's, its [BaseWinOptions]: Telephony, which HyperTerminal and Phone Dialer start)
HELP = ['clipbrd.hlp', 'clipbrd.cnt'] + [g + x for g in GAMES for x in ('.hlp', '.cnt')]
INFS = ['clip.inf']
found = {}
for d in dirs:
    for root, _, files in os.walk(d):
        for f in files:
            k = f.lower()
            if (k in WANT or k in COMMAND or k in SYSTEM or k in VXDS or k[:-4] in PACKED and k.endswith('.vxd') or k in WINDOWS or k in HELP or k in INFS) and k not in found: found[k] = os.path.join(root, f)
missing = [k for k in [*WANT, *COMMAND, *SYSTEM, *VXDS, *[p + '.vxd' for p in PACKED], *WINDOWS, *HELP, *INFS] if k not in found]
if missing: sys.exit(f'build_dos: not found under {dirs}: {missing}')
sysc = open(found['sys.com'], 'rb').read()
at = sysc.find(b'MSWIN4.1') - 3
boot = sysc[at:at + 512]
if at < 0 or boot[0x36:0x3e] != b'FAT12   ' or boot[510:512] != b'\x55\xaa': sys.exit('build_dos: no FAT12/16 boot sector in SYS.COM')
b64 = lambda b: base64.b64encode(b).decode()


def pack_vmm32(base, vxds):
    """VMM32.VXD as Setup builds it: the CD's (its real-mode loader, the W3 directory and VMM) with each VxD's LE added, its
    header and tables in one piece and an entry in the directory (its name, where it is, its size), its pages and
    non-resident names after, the LE's two file offsets to them (80h, 88h) set to where they now are"""
    out = bytearray(base)
    u32 = lambda b, o: int.from_bytes(b[o:o + 4], 'little')
    w3 = u32(base, 0x3c)
    if base[w3:w3 + 2] != b'W3': sys.exit('build_dos: VMM32.VXD has no W3 directory')
    n = int.from_bytes(base[w3 + 4:w3 + 6], 'little'); first = min(u32(base, w3 + 16 + 16 * i + 8) for i in range(n))
    if w3 + 16 + 16 * (n + len(vxds)) > first: sys.exit('build_dos: no room in VMM32.VXD\'s W3 directory')
    for name, f in vxds:
        e = u32(f, 0x3c); le = f[e:]
        if le[:2] != b'LE': sys.exit(f'build_dos: {name}: not an LE VxD')
        pages_at, npages, psize, last = u32(le, 0x80), u32(le, 0x14), u32(le, 0x28), u32(le, 0x2c)
        nonres, nonres_len = u32(le, 0x88), u32(le, 0x8c)
        head = bytearray(f[e:pages_at])
        pages = f[pages_at:pages_at + (npages - 1) * psize + last] if npages else b''
        while len(out) % 16: out.append(0)
        h = len(out); out += head
        while len(out) % 512: out.append(0)
        p = len(out); out += pages
        q = len(out); out += f[nonres:nonres + nonres_len]
        out[h + 0x80:h + 0x84] = p.to_bytes(4, 'little')
        if nonres_len: out[h + 0x88:h + 0x8c] = q.to_bytes(4, 'little')
        d = w3 + 16 + 16 * n
        out[d:d + 8] = name.upper().ljust(8).encode()[:8]; out[d + 8:d + 12] = h.to_bytes(4, 'little'); out[d + 12:d + 16] = len(head).to_bytes(4, 'little')
        n += 1
    out[w3 + 4:w3 + 6] = n.to_bytes(2, 'little')
    return bytes(out)


bundle = {'boot': b64(boot), 'files': {path: b64(open(found[k], 'rb').read()) for k, path in WANT.items() if path},
          'command': {k.upper(): b64(open(found[k], 'rb').read()) for k in COMMAND},
          'system': {k.upper(): b64(pack_vmm32(open(found[k], 'rb').read(), [(p, open(found[p + '.vxd'], 'rb').read()) for p in PACKED]) if k == 'vmm32.vxd' else open(found[k], 'rb').read()) for k in SYSTEM},
          'windows': {k.upper(): b64(open(found[k], 'rb').read()) for k in WINDOWS},
          'help': {k.upper(): b64(open(found[k], 'rb').read()) for k in HELP},
          'infs': {k.upper(): open(found[k], 'rb').read().decode('latin-1') for k in INFS},
          'vxds': {k.upper(): b64(open(found[k], 'rb').read()) for k in VXDS}}


def inf_parse(text):
    secs, cur = {}, None
    for line in text.replace('\r', '').split('\n'):
        m = re.match(r'\s*\[(.+?)\]', line)
        if m: cur = secs.setdefault(m.group(1).strip().lower(), []); continue
        line = line.split(';')[0].strip()
        if cur is not None and line: cur.append(line)
    strings = {}
    for line in secs.get('strings', []):
        if '=' in line: k, v = line.split('=', 1); strings[k.strip().lower()] = v.strip().strip('"')
    return secs, strings


LDID = {10: 'C:\\WINDOWS', 11: 'C:\\WINDOWS\\SYSTEM', 12: 'C:\\WINDOWS\\SYSTEM\\IOSUBSYS', 13: 'C:\\WINDOWS\\COMMAND', 17: 'C:\\WINDOWS\\INF',
        18: 'C:\\WINDOWS\\HELP', 20: 'C:\\WINDOWS\\FONTS', 21: 'C:\\WINDOWS\\SYSTEM\\VIEWERS', 22: 'C:\\WINDOWS\\SYSTEM\\VMM32', 23: 'C:\\WINDOWS\\SYSTEM\\COLOR',
        24: 'C:', 25: 'C:\\WINDOWS', 30: 'C:'}
cd = {}
for d in dirs:
    for root, _, files in os.walk(d):
        for f in files: cd.setdefault(f.lower(), os.path.join(root, f))
infs_dir = [d for d in dirs] + [os.path.join(os.path.dirname(d.rstrip('/')), 'infs') for d in dirs]
components = []
for inf, comp in TYPICAL:
    path = next((os.path.join(d, x) for d in infs_dir if os.path.isdir(d) for x in os.listdir(d) if x.lower() == inf), None) or cd.get(inf)
    if not path: sys.exit(f'build_dos: no {inf}')
    text = open(path, 'rb').read().decode('latin-1'); secs, strings = inf_parse(text)
    # (the INFs name the folders by their 8.3 names, "first 6 chars of Accessories, + ~1"; Setup makes them under their
    # long ones)
    LONG = {'progra~1': 'Program Files', 'access~1': 'Accessories', 'hypert~1': 'HyperTerminal'}
    long_ = lambda k: (lambda v: LONG.get((v or '').lower(), v))(strings.get(k))
    sub = lambda s: re.sub(r'%([^%]*)%', lambda m: long_(m.group(1).lower()) or m.group(0), s)
    dests = {k.strip().lower(): v.strip() for k, v in (x.split('=', 1) for x in secs.get('destinationdirs', []) if '=' in x)}
    body = {k.strip().lower(): v.strip() for k, v in (x.split('=', 1) for x in secs.get(comp.lower(), []) if '=' in x)}
    files = []
    for cf in [x.strip() for x in body.get('copyfiles', '').split(',') if x.strip()]:
        dd = dests.get(cf.lower(), dests.get('defaultdestdir'))
        if not dd: sys.exit(f'build_dos: {inf} {cf}: no destination')
        ld, _, rest = dd.partition(','); folder = LDID[int(ld)] + ('\\' + sub(rest.strip()) if rest.strip() else '')
        for line in secs.get(cf.lower(), []):
            f = [x.strip() for x in line.split(',')]; name, src = f[0], (f[1] if len(f) > 1 and f[1] else f[0])
            got = cd.get(src.lower()) or cd.get(name.lower())
            if not got: sys.exit(f'build_dos: {inf} {comp}: {src} not found')
            files.append([folder + '\\' + name.upper(), b64(open(got, 'rb').read())])
    components.append({'inf': inf.upper(), 'name': comp, 'files': files})
    bundle['infs'][inf.upper()] = text


def imports_of(b):
    """the modules a PE or NE image imports: a PE's by file name, an NE's by module name"""
    if len(b) < 0x40 or b[:2] != b'MZ': return []
    e = int.from_bytes(b[0x3c:0x40], 'little')
    if b[e:e + 2] == b'NE':
        n, mt, it = (int.from_bytes(b[e + o:e + o + 2], 'little') for o in (0x1e, 0x28, 0x2a))
        return [b[e + it + int.from_bytes(b[e + mt + 2 * i:e + mt + 2 * i + 2], 'little') + 1:][:b[e + it + int.from_bytes(b[e + mt + 2 * i:e + mt + 2 * i + 2], 'little')]].decode('latin-1') for i in range(n)]
    if b[e:e + 4] != b'PE\0\0': return []
    nsec, so = int.from_bytes(b[e + 6:e + 8], 'little'), int.from_bytes(b[e + 20:e + 22], 'little')
    opt = e + 24; secs = [(int.from_bytes(b[opt + so + 40 * i + 12:opt + so + 40 * i + 16], 'little'), max(int.from_bytes(b[opt + so + 40 * i + 8:opt + so + 40 * i + 12], 'little'), int.from_bytes(b[opt + so + 40 * i + 16:opt + so + 40 * i + 20], 'little')), int.from_bytes(b[opt + so + 40 * i + 20:opt + so + 40 * i + 24], 'little')) for i in range(nsec)]
    off = lambda r: next((r - va + ro for va, vs, ro in secs if va <= r < va + vs), None)
    o, out = off(int.from_bytes(b[opt + 104:opt + 108], 'little')), []
    while o is not None and o + 20 <= len(b) and int.from_bytes(b[o + 12:o + 16], 'little'):
        q = off(int.from_bytes(b[o + 12:o + 16], 'little')); out.append(b[q:b.index(b'\0', q)].decode('latin-1')); o += 20
    return out


# the DLLs the programs installed here need that the CD has, and theirs, each where Setup puts it (its line in
# COPY.INF, else SYSTEM): Paint's and WordPad's MFC and RICHED32, Phone Dialer's TAPI. (One the system bundle carries
# or implements is the bundle's: its file is written first, and the loader takes the bundle's module)
copyinf = next((os.path.join(d, x) for d in infs_dir if os.path.isdir(d) for x in os.listdir(d) if x.lower() == 'copy.inf'), None)
where = {}
if copyinf:
    for line in open(copyinf, 'rb').read().decode('latin-1').replace('\r', '').split('\n'):
        m = re.match(r'^\s*([^;=\s]+\.[A-Za-z0-9]{1,3})\s*=\s*(\d+)', line)
        if m and int(m.group(2)) in LDID: where.setdefault(m.group(1).lower(), LDID[int(m.group(2))])
# (the system bundle's own modules, tools/build_system.py's lists, and the DLLs the personality implements, KERNEL32
# and ADVAPI32: never taken from the CD, whose copies would not be what runs)
import ast
bundled = {'kernel32.dll', 'advapi32.dll'}
for node in ast.parse(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_system.py')).read()).body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and getattr(node.targets[0], 'id', '') in ('NE', 'PROGRAMS', 'PE', 'VXDS', 'DRIVERS', 'NET'):
        try: bundled |= {(e[0] if isinstance(e, tuple) else e).lower() for e in ast.literal_eval(node.value)}
        except ValueError: pass
placed = {p.rsplit('\\', 1)[1].lower() for c in components for p, _ in c['files']} | {k.lower() for k in WINDOWS + SYSTEM} | bundled
queue = [open(found[k], 'rb').read() for k in WINDOWS + SYSTEM if k.endswith(('.exe', '.dll', '.drv'))] + [base64.b64decode(d) for c in components for _, d in c['files']]
deps = {}
while queue:
    for imp in imports_of(queue.pop()):
        cands = [imp.lower()] if '.' in imp else [imp.lower() + x for x in ('.dll', '.drv', '.exe')]
        f = next((c for c in cands if c in cd), None)
        if not f or f in placed or f in deps: continue
        deps[f] = (where.get(f, LDID[11]) + '\\' + f.upper(), open(cd[f], 'rb').read()); queue.append(deps[f][1])
bundle['deps'] = [[p, b64(d)] for p, d in deps.values()]
bundle['components'] = components
with open(out, 'w') as f:
    f.write('// Generated by tools/build_dos.py from the Windows 95 CD: what the MS-DOS machine (v86.js) boots from\n')
    f.write(f'window.W95DOS = {json.dumps(bundle)};\n')
print(out, ', '.join(f'{p} {len(base64.b64decode(v))}' for p, v in bundle['files'].items()))
