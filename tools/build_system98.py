"""Recompile Windows 98's 16-bit system modules, the files Windows 98 Setup leaves on the disk in place of Windows 95's,
and write system98.js: each one's file, translated wasm and metadata, as tools/build_system.py does for Windows 95's,
which ne16.js loads in place of the Windows 95 build when the disk's file is this one (its SHA-256).
Each module is translated whole by tools/recomp.py, from its own entries and from the block starts run-time code
reached in it as Windows 98 ran (findings/dynentries/NAME-SHA.json, which the dev server keeps: worker.js
dynEntriesPost), at an image range, block table and selectors no module that may load with it holds (below); the
modules link to each other, and their 16-bit import thunks extend the bundle's table (system.js
thunks16), whose numbers stay as they are. The files are the ones that ran, kept beside their entries
(findings/dynentries/NAME-SHA.bin): a module of the bundle's that has not run from its file yet is left to run-time
code until it has. Usage: build_system98.py SYSTEM_JS OUT.js"""
import ast, base64, glob, hashlib, json, os, subprocess, sys, tempfile
sysjs, out = sys.argv[1:3]
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
os.environ['RECOMP_SHARED'] = '1'
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
# the bundle's NE modules, in its build order, with their load bases and block tables (tools/build_system.py NE)
tree = ast.parse(open(os.path.join(here, 'build_system.py')).read())
NE = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, 'id', '') == 'NE' for t in n.targets))
DISPLAY_DRIVERS = {'tseng.drv', 'vga.drv', 'supervga.drv'}
MMIO = {'tseng.drv': '0xb8000:0x8000'}
s = open(sysjs).read(); i = s.index('window.W95SYSTEM = ') + len('window.W95SYSTEM = ')
bundle = json.loads(s[i:s.rindex(';')])
sys.path.insert(0, here); from recomp import NE as NELayout
# (each file that ran, by its file name: the record names it)
ran = {}
for j in glob.glob(os.path.join(root, 'findings', 'dynentries', '*.json')):
    rec = json.load(open(j)); b_ = j[:-5] + '.bin'
    if os.path.exists(b_) and rec.get('file'): ran[rec['file'].lower()] = (b_, j)
# where each build goes: an image range, a block table and a run of selectors that nothing else the machine may load
# with it holds. ne16.js neBundle loads Windows 98's builds, and none of Windows 95's builds of the same modules, so
# the space those hold is free to them; the rest of the bundle's (UNIDRV, NETDI, SYSDM, MSACM, ...) stays where it is.
# (at Windows 95's places, Windows 98's larger USER ran over MSACM's image and SYSDM's table, MSGSRV32's table over
# NETDI's, SETUPX over UNIDRV, and the selectors, packed from the bundle's first, over other modules')
replaced = {f.upper() for f, *_ in NE if f in ran}
kept_ne = {n: m for n, m in bundle['ne'].items() if m.get('fileName') not in replaced}
def pe_size(m):
    if 'size' in m['meta']: return m['meta']['size']
    if 'file' not in m: return None
    d = base64.b64decode(m['file']); pe = int.from_bytes(d[0x3c:0x40], 'little'); return int.from_bytes(d[pe + 24 + 56:pe + 24 + 60], 'little')
images = [(0, 0x00620000), (0x01000000, 0x01100000)]   # (below the relocated DLLs' arena; the programs linked at 1000000h, win32.js imageRoom)
for m in kept_ne.values():
    for g in m['meta']['segs']: images.append((g['base'], g['base'] + max(g.get('alloc', 0), g.get('len', 0), 1)))
for gname, grp in bundle.items():
    if gname == 'ne' or not isinstance(grp, dict): continue
    for n, m in grp.items():
        if isinstance(m, dict) and isinstance(m.get('meta'), dict) and 'base' in m['meta'] and 'segs' not in m['meta']:
            z = pe_size(m)
            if z: images.append((m['meta']['base'], m['meta']['base'] + z))
tables = [(m['meta']['lookup'], m['meta']['lookup'] + 4 * (m['meta']['textHi'] - m['meta']['textLo']))
          for gname, grp in bundle.items() if isinstance(grp, dict)
          for n, m in grp.items() if isinstance(m, dict) and isinstance(m.get('meta'), dict) and 'lookup' in m['meta'] and not (gname == 'ne' and n not in kept_ne)]
sels = [(m['meta']['selbase'], m['meta']['selbase'] + 8 * len(m['meta']['segs'])) for m in kept_ne.values()]
def place(taken, size, pref, lo, hi, align, what):
    clear = lambda a: lo <= a and a + size <= hi and not any(a < t1 and t0 < a + size for t0, t1 in taken)
    if clear(pref): taken.append((pref, pref + size)); return pref   # (its Windows 95 build's place, when it is free)
    a = lo
    while a + size <= hi:
        hit = next((t1 for t0, t1 in taken if a < t1 and t0 < a + size), None)
        if hit is None: taken.append((a, a + size)); return a
        a = (hit + align - 1) // align * align
    sys.exit(f'no room for {what} ({size:#x} bytes)')
SEL_LO = min(m['meta']['selbase'] for m in bundle['ne'].values())
w95 = {m['fileName'].lower(): m['meta'] for m in bundle['ne'].values() if m.get('fileName')}
# (each one's sizes, from its layout, then its places, largest first: in the order of the build, USER's 1.9 MB table
# found no run left that long)
todo = []
for f, *_ in NE:
    if f not in ran: print(f'{f}: has not run from its file, left out'); continue
    p, ej = ran[f]; d = open(p, 'rb').read()
    if json.load(open(ej)).get('sha256') != hashlib.sha256(d).hexdigest(): sys.exit(f'{p}: not the file its entries are for')
    lay = NELayout(d, 0, 0); code = [g for g in lay.segs if g['code'] and g['len']]
    text = max(g['base'] + g['len'] for g in code) - min(g['base'] for g in code) if code else 1
    todo.append(dict(f=f, p=p, ej=ej, size=lay.size, table=4 * text, nsel=8 * len(lay.segs), old=w95.get(f, {})))
at = {}
# (block tables from 5600000h to the address space's end, 8000000h: below them, at 5500000h, the page protection map,
# win32.js LAYOUT.PROT; COMMCTRL's table placed there read as protected pages, and GDI32 faulted in GDI's heap)
for t in sorted(todo, key=lambda t: -t['table']): at.setdefault(t['f'], {})['lk'] = place(tables, t['table'], t['old'].get('lookup', 0), 0x05600000, 0x08000000, 0x1000, t['f'] + ' block table')
for t in sorted(todo, key=lambda t: -t['size']): at[t['f']]['b'] = place(images, t['size'], t['old'].get('base', 0), 0x00620000, 0x02000000, 0x10000, t['f'] + ' image')
# (placed as descriptor indexes, each selector LDT and ring 3, low bits 7: placed as they are, SYSTEM.DRV's came out
# at 1180h, a GDT selector)
sel0 = [(a - 7, b - 7) for a, b in sels]
for t in sorted(todo, key=lambda t: -t['nsel']): at[t['f']]['sel'] = 7 + place(sel0, t['nsel'], t['old'].get('selbase', 7) - 7, SEL_LO - 7, 0x3000, 8, t['f'] + ' selectors')
out98 = {'ne': {}}
with tempfile.TemporaryDirectory() as tmp:
    reg = os.path.join(tmp, 'registry.json')
    json.dump({'thunks': list(bundle['thunks16']), 'modules': {}}, open(reg, 'w'))
    for t in todo:
        f, p, ent = t['f'], t['p'], [t['ej']]; b, lk, sel = at[f]['b'], at[f]['lk'], at[f]['sel']
        base = os.path.join(tmp, f)
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--selbase', hex(sel), '--lookup', hex(lk), '--registry', reg]
                       + (['--entries', ent[0]] if ent else []) + (['--mmio', MMIO[f]] if f in MMIO else []) + (['--unlinked'] if f in DISPLAY_DRIVERS else []), check=True)
        meta = json.load(open(base + '.json'))
        key = meta['name'].upper() if meta['name'].upper() not in out98['ne'] else f.upper().split('.')[0]
        out98['ne'][key] = {'file': b64(p), 'fileName': f.upper(), 'wasm': b64(base + '.wasm'), 'meta': meta}
        print(f'{f}: image {b:#x}, table {lk:#x}, selectors {sel:#x}, {len(json.load(open(ent[0]))["entries"]) if ent else 0} recorded entries')
    out98['thunks16'] = json.load(open(reg))['thunks']
assert out98['thunks16'][:len(bundle['thunks16'])] == bundle['thunks16'], 'the bundle\'s thunk numbers changed'
with open(out, 'w') as fh:
    fh.write('// Generated by tools/build_system98.py from the Windows 98 system files (findings/dynentries).\nwindow.W95SYSTEM98 = ')
    json.dump(out98, fh, separators=(',', ':')); fh.write(';\n')
