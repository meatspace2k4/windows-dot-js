"""List per program the imported APIs that make it behave differently per machine, or clash across machines, in a shared session.

python3 tools/imports_risk.py [extra files or folders...]
Reads NE and PE modules under the build inputs' sys folder, writes findings/import-risk.json and prints a table.
"""
import json, os, struct, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from neinfo import ne

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUTS = os.path.expanduser('~/Win95-build-inputs/sys')
OUT = os.path.join(ROOT, 'findings', 'import-risk.json')
EXTS = ('.EXE', '.SCR', '.CPL', '.DLL')
ORDER = ('hidden-input', 'singleton-probe', 'shared-write', 'broadcast', 'exclusive-device', 'modal')

def aw(*names):
    """Each name with its A and W forms."""
    return [n + s for n in names for s in ('A', 'W')]

# 32-bit imports by (DLL, name)
API32 = {
    'hidden-input': {
        'KERNEL32': ['GetTickCount', 'QueryPerformanceCounter', 'GetSystemTime', 'GetLocalTime', 'GetSystemTimeAsFileTime'],
        'WINMM': ['timeGetTime', 'timeGetSystemTime'],
        'USER32': ['GetCursorPos', 'GetAsyncKeyState', 'GetKeyState', 'GetKeyboardState'],
        'OLE32': ['CoCreateGuid'],
        'RPCRT4': ['UuidCreate', 'UuidCreateSequential'],
    },
    'singleton-probe': {
        'USER32': aw('FindWindow', 'FindWindowEx', 'RegisterWindowMessage'),
        'KERNEL32': aw('CreateMutex', 'OpenMutex', 'CreateSemaphore', 'OpenSemaphore', 'CreateEvent', 'OpenEvent',
                       'GlobalAddAtom', 'GlobalFindAtom', 'CreateFileMapping', 'OpenFileMapping'),
    },
    'shared-write': {
        'KERNEL32': aw('WriteProfileString', 'WritePrivateProfileString', 'WriteProfileSection', 'WritePrivateProfileSection',
                       'WritePrivateProfileStruct', 'CreateFile', 'DeleteFile', 'MoveFile', 'MoveFileEx', 'CopyFile',
                       'CreateDirectory', 'RemoveDirectory', 'SetFileAttributes') + ['_lcreat'],
        'ADVAPI32': aw('RegSetValue', 'RegSetValueEx', 'RegCreateKey', 'RegCreateKeyEx', 'RegDeleteKey', 'RegDeleteValue'),
        'SHELL32': ['SHFileOperation', 'SHFileOperationA', 'SHFileOperationW'],
        'USER32': aw('SystemParametersInfo') + ['SetSysColors'],
    },
    'broadcast': {
        'USER32': aw('BroadcastSystemMessage', 'SendMessageTimeout', 'SendNotifyMessage') + ['BroadcastSystemMessage'],
        'SHELL32': ['SHChangeNotify'],
    },
    'exclusive-device': {
        'WINMM': ['waveOutOpen', 'waveInOpen', 'midiOutOpen', 'midiInOpen', 'joyGetPos', 'joyGetPosEx', 'PlaySound']
                 + aw('mciSendCommand', 'mciSendString', 'sndPlaySound', 'PlaySound'),
    },
    'modal': {
        'USER32': aw('DialogBoxParam', 'DialogBoxIndirectParam', 'MessageBox', 'MessageBoxEx', 'MessageBoxIndirect')
                  + ['TrackPopupMenu', 'TrackPopupMenuEx'],
        'COMDLG32': aw('GetOpenFileName', 'GetSaveFileName', 'ChooseColor', 'ChooseFont', 'PrintDlg', 'PageSetupDlg'),
    },
}

# 16-bit imports by (module, ordinal), ordinals as the system's own modules export them
API16 = {
    'hidden-input': {
        'USER': {13: 'GetTickCount', 15: 'GetCurrentTime', 17: 'GetCursorPos', 106: 'GetKeyState', 222: 'GetKeyboardState',
                 249: 'GetAsyncKeyState'},
        'KERNEL': {102: 'DOS3Call'},
        'MMSYSTEM': {601: 'timeGetSystemTime', 607: 'timeGetTime'},
    },
    'singleton-probe': {
        'USER': {50: 'FindWindow', 118: 'RegisterWindowMessage', 268: 'GlobalAddAtom', 270: 'GlobalFindAtom', 427: 'FindWindowEx'},
    },
    'shared-write': {
        'KERNEL': {59: 'WriteProfileString', 83: '_lcreat', 129: 'WritePrivateProfileString', 146: 'DeleteFile',
                   218: 'RegCreateKey', 219: 'RegDeleteKey', 221: 'RegSetValue', 222: 'RegDeleteValue', 226: 'RegSetValueEx',
                   416: 'WritePrivateProfileSection', 417: 'WriteProfileSection'},
        'SHELL': {2: 'RegCreateKey', 4: 'RegDeleteKey', 5: 'RegSetValue'},
        'USER': {181: 'SetSysColors', 483: 'SystemParametersInfo'},
    },
    'broadcast': {
        'USER': {604: 'BroadcastSystemMessage'},
    },
    'exclusive-device': {
        'MMSYSTEM': {2: 'sndPlaySound', 3: 'PlaySound', 103: 'joyGetPos', 110: 'joyGetPosEx', 204: 'midiOutOpen',
                     304: 'midiInOpen', 404: 'waveOutOpen', 504: 'waveInOpen', 701: 'mciSendCommand', 702: 'mciSendString'},
        'USER': {200: 'OpenComm'},
    },
    'modal': {
        'USER': {1: 'MessageBox', 87: 'DialogBox', 218: 'DialogBoxIndirect', 239: 'DialogBoxParam', 240: 'DialogBoxIndirectParam',
                 416: 'TrackPopupMenu', 667: 'TrackPopupMenuEx', 827: 'MessageBoxIndirect'},
        'COMMDLG': {1: 'GetOpenFileName', 2: 'GetSaveFileName', 5: 'ChooseColor', 15: 'ChooseFont', 20: 'PrintDlg'},
    },
}

# names whose import means a second start may hand off to the first
SINGLE = ('FindWindow', 'CreateMutex', 'OpenMutex')

def _table():
    """(MODULE, name) -> (category, display name); 16-bit also keyed by '#ord' and by upper-case name."""
    t = {}
    for cat, mods in API32.items():
        for m, names in mods.items():
            for n in names: t[(m, n)] = (cat, n)
    for cat, mods in API16.items():
        for m, ords in mods.items():
            for o, n in ords.items():
                t[(m, '#%d' % o)] = (cat, n); t[(m, n.upper())] = (cat, n)
    return t
TABLE = _table()

def categories():
    """The table as JSON: category -> sorted 'DLL!Name' (16-bit with its ordinal)."""
    out = {}
    for cat in ORDER:
        s = set('%s!%s' % (m, n) for m, ns in API32.get(cat, {}).items() for n in ns)
        s |= set('%s!%s (#%d)' % (m, n, o) for m, os_ in API16.get(cat, {}).items() for o, n in os_.items())
        out[cat] = sorted(s)
    return out

def modname(m):
    """KERNEL32.dll -> KERNEL32."""
    m = m.upper()
    return m[:-4] if m.endswith(('.DLL', '.EXE', '.DRV')) else m

def classify(imports):
    """Imports ((module, name or '#ord') pairs) -> {category: sorted ['DLL!Name']}, only categories hit."""
    risks = {}
    for m, f in imports:
        m = modname(m)
        hit = TABLE.get((m, f)) or (TABLE.get((m, f.upper())) if not f.startswith('#') else None)
        if hit: risks.setdefault(hit[0], set()).add('%s!%s' % (m, hit[1]))
    return {c: sorted(v) for c, v in risks.items()}

def single_instance(risks):
    return any(n.split('!', 1)[1].startswith(SINGLE) for n in risks.get('singleton-probe', ()))

def pe_imports(path):
    """Import table of a PE file (path or bytes) -> Counter of (DLL, name or '#ord'); None when not PE."""
    d = path if isinstance(path, (bytes, bytearray)) else open(path, 'rb').read()
    if len(d) < 0x40 or d[:2] != b'MZ': return None
    n = struct.unpack_from('<I', d, 0x3c)[0]
    if n + 24 > len(d) or d[n:n + 4] != b'PE\0\0': return None
    nsec, optsz = struct.unpack_from('<H', d, n + 6)[0], struct.unpack_from('<H', d, n + 20)[0]
    opt = n + 24; magic = struct.unpack_from('<H', d, opt)[0]
    if magic == 0x10b: dirs, tsz, flag = opt + 96, 4, 1 << 31
    elif magic == 0x20b: dirs, tsz, flag = opt + 112, 8, 1 << 63
    else: return None
    ndirs = struct.unpack_from('<I', d, dirs - 4)[0]
    imports = Counter()
    if ndirs < 2: return imports
    irva = struct.unpack_from('<I', d, dirs + 8)[0]
    if not irva: return imports
    hdrsz = struct.unpack_from('<I', d, opt + 60)[0]
    secs = []
    for i in range(nsec):
        s = opt + optsz + 40 * i
        vsz, va, rsz, raw = struct.unpack_from('<IIII', d, s + 8)
        secs.append((va, max(vsz, rsz), raw, rsz))
    def off(rva):
        if rva < hdrsz: return rva
        for va, sz, raw, rsz in secs:
            if va <= rva < va + sz and rva - va < rsz: return raw + rva - va
        return None
    def cstr(o):
        e = d.index(b'\0', o); return d[o:e].decode('latin1')
    p = off(irva)
    while p is not None and p + 20 <= len(d):
        ilt, _, _, name, iat = struct.unpack_from('<IIIII', d, p); p += 20
        if not (ilt or name or iat): break
        no = off(name)
        if no is None: continue
        dll = cstr(no); t = off(ilt or iat)
        while t is not None and t + tsz <= len(d):
            v = struct.unpack_from('<I' if tsz == 4 else '<Q', d, t)[0]; t += tsz
            if not v: break
            if v & flag: imports[(dll, '#%d' % (v & 0xffff))] += 1
            else:
                h = off(v & 0x7fffffff)
                if h is not None: imports[(dll, cstr(h + 2))] += 1
    return imports

def ne_imports(path):
    """Imports of an NE module -> Counter; None when not NE."""
    try:
        with open(path, 'rb') as f: hd = f.read(0x40)
        if hd[:2] != b'MZ': return None
        n = struct.unpack_from('<I', hd, 0x3c)[0]
        with open(path, 'rb') as f: f.seek(n); sig = f.read(2)
        if sig != b'NE': return None
        return ne(path)[6]
    except Exception:
        return None

def scan(path):
    """(kind, imports) for an NE or PE file, else None."""
    try:
        i = ne_imports(path)
        if i is not None: return 'NE', i
        i = pe_imports(path)
        if i is not None: return 'PE', i
    except Exception:
        pass
    return None

def files(roots, explicit):
    """Module files under the roots by extension, plus files named outright."""
    out = []
    for r in roots:
        if os.path.isfile(r): out.append(r); continue
        for dp, _, fs in os.walk(r):
            out += [os.path.join(dp, f) for f in fs if f.upper().endswith(EXTS)]
    return out + [f for f in explicit if os.path.isfile(f)]

def main(argv):
    extra = argv[1:]
    roots = [INPUTS] + [a for a in extra if os.path.isdir(a)]
    progs = {}
    for f in sorted(set(files(roots, [a for a in extra if os.path.isfile(a)]))):
        r = scan(f)
        if not r: continue
        risks = classify(r[1])
        if not risks: continue
        key = os.path.basename(f).upper()
        if key in progs: key = os.path.relpath(f, INPUTS).upper() if f.startswith(INPUTS) else f
        e = {'kind': r[0], 'risks': risks}
        if single_instance(risks): e['single_instance'] = True
        progs[key] = e
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump({'programs': progs, 'categories': categories()}, fh, indent=1, sort_keys=True); fh.write('\n')
    short = ('time', 'single', 'write', 'bcast', 'device', 'modal')
    print('%-14s %-2s %s' % ('file', '', ' '.join('%6s' % s for s in short)))
    for k in sorted(progs):
        e = progs[k]
        print('%-14s %-2s %s%s' % (k, e['kind'], ' '.join('%6d' % len(e['risks'].get(c, ())) for c in ORDER),
                                    '  single-instance' if e.get('single_instance') else ''))
        for c in ('singleton-probe', 'hidden-input'):
            if e['risks'].get(c): print('    %s: %s' % (c, ', '.join(e['risks'][c])))
    print('%d programs flagged -> %s' % (len(progs), os.path.relpath(OUT, ROOT)))

if __name__ == '__main__':
    main(sys.argv)
