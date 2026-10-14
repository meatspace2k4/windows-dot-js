"""Recompile the Windows 95 system modules that run natively under the 16-bit personality (ne16.js), and the
programs that run on them, and write system.js: original file bytes, translated wasm and metadata for each, the
shared table of 16-bit import thunks, and the font files. Usage: build_system.py SYS_DIR OUT.js [FONTS_DIR]"""
import base64, json, os, subprocess, sys, tempfile
src, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
# NE modules, in dependency order: (file, load base, first selector, block-table base)
NE = [('gdi.exe', 0x01C00000, 0x1007, 0x06A00000), ('dibeng.dll', 0x01E00000, 0x1207, 0x06D00000),
      ('framebuf.drv', 0x01E80000, 0x1307, 0x06E00000),
      # USER's drivers and DDEML before USER, so its calls into them link directly
      # (first selectors spaced by segment count: SYSTEM 2, KEYBOARD 10, MOUSE 2, COMM 3, DDEML 3)
      ('system.drv', 0x01B00000, 0x1507, 0x07200000), ('keyboard.drv', 0x01B10000, 0x1527, 0x07240000),
      ('mouse.drv', 0x01B20000, 0x1587, 0x07280000), ('comm.drv', 0x01B30000, 0x15A7, 0x072C0000),
      ('ddeml.dll', 0x01B40000, 0x15C7, 0x07300000),
      ('user.exe', 0x01A00000, 0x1407, 0x06F00000),
      # the common dialogs: COMDLG32.DLL is a thunk layer over this (Setup installs WIN95_02.CAB's commdlg.new as it)
      ('commdlg.dll', 0x01B50000, 0x15E7, 0x07400000),
      # the shell's 16-bit half, which SHELL32.DLL thunks to (PRECOPY1.CAB)
      ('shell.dll', 0x01B80000, 0x1647, 0x07480000),
      # the 16-bit common controls COMCTL32.DLL thunks to (PRECOPY1.CAB)
      ('commctrl.dll', 0x01BA0000, 0x16B7, 0x074C0000),
      # the LZ decompression library VER.DLL opens files through (PRECOPY1.CAB)
      ('lzexpand.dll', 0x01BE0000, 0x1757, 0x07880000),
      # the version-information library VERSION.DLL thunks to, which file Properties loads (Setup installs WIN95_12.CAB's ver.new as it)
      ('ver.dll', 0x01BC0000, 0x1727, 0x07800000)]
# Windows programs that run on the native USER (bootUser16): (file, block-table base); each loads at its own base
PROGRAMS = [('notepad.exe', 0x06000000)]
# 32-bit system DLLs: (file, load base, block-table base)
PE = [('gdi32.dll', 0x01D00000, 0x06C00000), ('user32.dll', 0x01D40000, 0x07340000), ('comdlg32.dll', 0x01D60000, 0x07380000),
      # the common controls and the shell, which COMDLG32's Explorer-style dialogs are built on (WIN95_02.CAB)
      ('comctl32.dll', 0x01F00000, 0x07500000), ('shell32.dll', 0x01600000, 0x07600000),
      # version resources for the shell's file properties (WIN95_02.CAB)
      ('version.dll', 0x01D80000, 0x07840000)]
# fonts a VGA install of Windows 95 puts in C:\WINDOWS\FONTS (WIN95_02.CAB)
FONTS = ['vgasys.fon', 'vgafix.fon', 'vgaoem.fon', 'sserife.fon', 'serife.fon', 'coure.fon', 'smalle.fon', 'symbole.fon',
         'modern.fon', 'dosapp.fon', 'arial.ttf', 'arialbd.ttf', 'arialbi.ttf', 'ariali.ttf', 'cour.ttf', 'courbd.ttf',
         'courbi.ttf', 'couri.ttf', 'times.ttf', 'timesbd.ttf', 'timesbi.ttf', 'timesi.ttf', 'symbol.ttf', 'wingding.ttf', 'marlett.ttf']
fonts_dir = sys.argv[3] if len(sys.argv) > 3 else None
bundle = {'ne': {}, 'dlls': {}, 'programs': {}, 'thunks16': [], 'fonts': {}}
if fonts_dir:
    for f in FONTS: bundle['fonts'][f.upper()] = b64(os.path.join(fonts_dir, f))
with tempfile.TemporaryDirectory() as tmp:
    reg = os.path.join(tmp, 'registry.json')
    for f, b, sel, lk in NE:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        trace = ['--trace'] if f.upper() in os.environ.get('TRACE_NE', '').upper().split(',') else []
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--selbase', hex(sel),
                        '--lookup', hex(lk), '--registry', reg] + trace, check=True)
        meta = json.load(open(base + '.json'))
        bundle['ne'][meta['name'].upper()] = {'file': b64(p), 'fileName': f.upper(), 'wasm': b64(base + '.wasm'), 'meta': meta}
    bundle['thunks16'] = json.load(open(reg))['thunks']
    for f, b, lk in PE:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        trace = ['--trace'] if f.upper() in os.environ.get('TRACE_NE', '').upper().split(',') else []
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--lookup', hex(lk)] + trace, check=True)
        bundle['dlls'][f.upper()] = {'file': b64(p), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
    for f, lk in PROGRAMS:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--lookup', hex(lk)], check=True)
        bundle['programs'][f.upper()] = {'file': b64(p), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
# the Setup INF files whose registry sections the shell applies (SHELL.INF: the shell's classes and folders)
INFS = ['shell.inf']
bundle['infs'] = {f.upper(): open(os.path.join(src, f), 'rb').read().decode('latin1') for f in INFS if os.path.exists(os.path.join(src, f))}
with open(out, 'w') as fh:
    fh.write('// Generated by tools/build_system.py from the Windows 95 system files.\nwindow.W95SYSTEM = ')
    json.dump(bundle, fh, separators=(',', ':')); fh.write(';\n')
