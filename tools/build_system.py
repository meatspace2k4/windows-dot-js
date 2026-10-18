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
      # the 16-bit common controls COMCTL32.DLL thunks to and SYSDM's property sheets use: Setup installs it from
      # KOMMCTRL.DLL (SETUPC.INF; PRECOPY1.CAB's COMMCTRL.DLL is Setup's own smaller one)
      ('commctrl.dll', 0x015A0000, 0x16B7, 0x05E00000),
      # the LZ decompression library VER.DLL opens files through (PRECOPY1.CAB)
      ('lzexpand.dll', 0x01BE0000, 0x1757, 0x07880000),
      # the version-information library VERSION.DLL thunks to, which file Properties loads (Setup installs WIN95_12.CAB's ver.new as it)
      ('ver.dll', 0x01BC0000, 0x1727, 0x07800000),
      # the multimedia system WINMM.DLL thunks to, and the Windows Sound System driver it loads for the card (WIN95_02.CAB)
      ('mmsystem.dll', 0x01700000, 0x17D7, 0x07900000), ('mssndsys.drv', 0x01740000, 0x1847, 0x07980000),
      # MMSYSTEM's background task, which it starts with LoadModule (WIN95_02.CAB)
      ('mmtask.tsk', 0x017C0000, 0x187F, 0x07A80000),
      # the audio compression manager and the wave mapper MMSYSTEM opens for WAVE_MAPPER (WIN95_02.CAB)
      ('msacm.dll', 0x01A80000, 0x188F, 0x07B00000), ('msacm.drv', 0x01AC0000, 0x18C7, 0x07B40000),
      # the card's OPL3 synthesizer driver (Drivers\midi\msopl.drv) and the MIDI mapper MMSYSTEM opens for MIDI_MAPPER (WIN95_13.CAB)
      ('msopl.drv', 0x01860000, 0x1907, 0x07D00000), ('midimap.drv', 0x01880000, 0x1947, 0x07D40000),
      # the MCI sequencer and waveaudio devices (MOTOWN.INF's MCISEQ and MCIWAVE, SYSTEM.INI [mci]) that play MIDI and
      # wave files for Media Player and mciSendString (WIN95_13.CAB)
      ('mciseq.drv', 0x018A0000, 0x1987, 0x07DC0000), ('mciwave.drv', 0x018C0000, 0x19C7, 0x07E00000),
      # the Setup engine (INF files, copying from the source disks, the registry), and the Add Printer wizard's 16-bit
      # half, which installs printer drivers through it (PRECOPY2.CAB)
      ('setupx.dll', 0x01130000, 0x1A17, 0x05CA0000), ('msprint.dll', 0x014E0000, 0x1B97, 0x06E20000),
      # Setup's device installer, which the wizard runs for the Printer class (SYSDM.CPL's InstallDevice_Rundll), and
      # the Setup helpers it imports (WIN95_27.CAB, WIN95_09.CAB)
      ('setup4.dll', 0x01510000, 0x1BCF, 0x06E80000), ('sysdm.cpl', 0x01530000, 0x1BDF, 0x070C0000),
      # printer drivers MSPRINT.INF installs from the CD (WIN95_27.CAB): the universal driver and the Generic / Text Only
      # minidriver on it. Setup leaves them on the CD; each loads once the Add Printer wizard has copied its file
      ('unidrv.dll', 0x01190000, 0x1C27, 0x06010000), ('tty.drv', 0x011E0000, 0x1CCF, 0x06110000),
      # the system's first task, which Windows 95 starts as it boots (WIN95_12.CAB): USER's first-task start-up loads
      # the installable drivers (MMSYSTEM, the sound card's) for it, and it plays SystemStart and starts the shell
      ('msgsrv32.exe', 0x01570000, 0x1CEF, 0x06130000)]
# the NE modules above that Setup leaves on the CD: a module of these loads only when its file is on the disk
ON_DISK = {'unidrv.dll', 'tty.drv'}
# Windows programs that run on the native USER (bootUser16): (file, load base, block-table base). Each has a base of
# its own, so programs one starts (WinExec, CreateProcess) share its address space and its window system
PROGRAMS = [('notepad.exe', 0x00400000, 0x06000000), ('rundll32.exe', 0x00410000, 0x06100000), ('mplayer.exe', 0x00420000, 0x06200000),
            ('mprexe.exe', 0x00500000, 0x05C90000),
            # Windows Help, which the shell's Help Topics and Start > Help run (WIN95_13.CAB)
            ('winhlp32.exe', 0x00450000, 0x06700000),
            # the print spooler WINSPOOL.DRV starts and talks to (WIN95_27.CAB)
            ('spool32.exe', 0x004A0000, 0x06BA0000)]
# 32-bit system DLLs: (file, load base, block-table base)
PE = [('gdi32.dll', 0x01D00000, 0x06C00000), ('user32.dll', 0x01D40000, 0x07340000), ('comdlg32.dll', 0x01D60000, 0x07380000),
      # the common controls and the shell, which COMDLG32's Explorer-style dialogs are built on (WIN95_02.CAB)
      ('comctl32.dll', 0x01F00000, 0x07500000), ('shell32.dll', 0x01600000, 0x07600000),
      # version resources for the shell's file properties (WIN95_02.CAB)
      ('version.dll', 0x01D80000, 0x07840000),
      # the 32-bit multimedia API (WIN95_02.CAB), which SHELL32 and Win32 programs play sounds through
      ('winmm.dll', 0x01760000, 0x079C0000),
      # the Multimedia and Sounds Control Panel applets (WIN95_02.CAB), which RUNDLL32 runs through SHELL32's Control_RunDLL
      ('mmsys.cpl', 0x01780000, 0x07A00000),
      # the 32-bit half of the audio compression manager, which MSACM.DLL thunks to (WIN95_02.CAB)
      ('msacm32.dll', 0x017D0000, 0x07B80000),
      # OLE (WIN95_02.CAB): SHELL32 puts files on the clipboard through it ("Shell IDList Array" data objects), with
      # the RPC runtime and the C runtime it imports
      ('ole32.dll', 0x01000000, 0x06300000), ('rpcrt4.dll', 0x010A0000, 0x06500000), ('msvcrt20.dll', 0x010E0000, 0x06600000),
      # Windows Help's full-text search, which it loads for the Find tab (WIN95_13.CAB)
      ('ftsrch.dll', 0x01400000, 0x06900000),
      # printing (WIN95_27.CAB): the spooler's client the common dialogs load, and the spooler's router SPOOL32 runs
      ('winspool.drv', 0x01460000, 0x06B20000), ('spoolss.dll', 0x01480000, 0x06B40000),
      # the Win32 side of 16-bit memory and handles (WOWGlobalLock16 and the rest), which WinHelp reads a 16-bit
      # WinHelp call's request through (WIN95_27.CAB)
      ('wow32.dll', 0x014A0000, 0x06BC0000),
      # the Add Printer wizard, which the Printers folder runs (SHELL32 calls its PrinterSetup32), thunking to MSPRINT.DLL (PRECOPY2.CAB)
      ('msprint2.dll', 0x01500000, 0x070A0000)]
# VxDs (ring-0 drivers), recompiled to run under the VMM in vmm.js: (file, load base, block-table base). MMDEVLDR is the
# device loader of MEDIA devnodes; MSSNDSYS the Windows Sound System card's driver (WIN95_02.CAB)
VXDS = [('mmdevldr.vxd', 0x01800000, 0x07C00000), ('mssndsys.vxd', 0x01810000, 0x07C40000),
        ('vtdapi.vxd', 0x01820000, 0x07C80000), ('dsound.vxd', 0x01830000, 0x07CC0000),
        # the OPL3's VxD, which arbitrates the synthesizer's ports (WIN95_13.CAB)
        ('msopl.vxd', 0x01840000, 0x07D80000),
        # Accessibility (ENABLE.INF, part of a Typical install, combined into VMM32): StickyKeys, FilterKeys and the
        # rest, whose state USER reads through its protected-mode API (WIN95_02.CAB)
        ('enable.vxd', 0x01850000, 0x069C0000),
        # the print spooler's VxD (dynamic: SPOOL32 opens \\.\spooler), which takes printing from MS-DOS programs (WIN95_09.CAB)
        ('spooler.vxd', 0x014C0000, 0x06BD0000),
        # the network (WIN95_02.CAB, PERF from WIN95_06.CAB): the file system manager and its cache, network support,
        # the Microsoft Networks redirector, NetBIOS, the NetBEUI protocol and the NDIS 3.1 wrapper
        ('ifsmgr.vxd', 0x01200000, 0x05800000), ('vcache.vxd', 0x01230000, 0x058C0000), ('vnetsup.vxd', 0x01240000, 0x058E0000),
        ('vredir.vxd', 0x01250000, 0x05900000), ('vnetbios.vxd', 0x01280000, 0x059A0000), ('netbeui.vxd', 0x01290000, 0x059C0000),
        ('ndis.vxd', 0x012A0000, 0x05A00000), ('perf.vxd', 0x012C0000, 0x05A80000),
        # the shell's ring-0 half, whose system-modal messages show on the blue screen when Windows cannot show them,
        # and Ctrl+Alt+Del's: the Close Program request, and the blue screens of a system that does not answer (WIN95_12.CAB)
        ('shell.vxd', 0x018E0000, 0x07E20000), ('reboot.vxd', 0x01900000, 0x07E80000)]
# NDIS miniports (PE images NDIS loads and links to its own exports): (file, load base, block-table base). NE2000.SYS
# drives the NE2000-compatible card (NETNOVEL.INF *PNP80D6)
DRIVERS = [('ne2000.sys', 0x012D0000, 0x05AC0000)]
# the network's Win32 half (WIN95_02.CAB, MSPWL32 from WIN95_06.CAB), loaded by MPREXE.EXE, the process Windows 95
# starts for it: the multiple provider router and its service, the Microsoft Networks provider and its LAN Manager
# API, the password cache and the server API: (file, load base, block-table base)
NET = [('mpr.dll', 0x01300000, 0x05AA0000), ('msnp32.dll', 0x01310000, 0x05AE0000), ('msnet32.dll', 0x01330000, 0x05B40000),
       ('mprserv.dll', 0x01350000, 0x05B90000), ('mspwl32.dll', 0x01380000, 0x05C30000), ('svrapi.dll', 0x01390000, 0x05C70000)]
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
        bundle['ne'][meta['name'].upper()] = {'file': b64(p), 'fileName': f.upper(), 'wasm': b64(base + '.wasm'), 'meta': meta, **({'onDisk': True} if f in ON_DISK else {})}
    bundle['thunks16'] = json.load(open(reg))['thunks']
    for f, b, lk in PE:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        trace = ['--trace'] if f.upper() in os.environ.get('TRACE_NE', '').upper().split(',') else []
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--lookup', hex(lk)] + trace, check=True)
        bundle['dlls'][f.upper()] = {'file': b64(p), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
    # the export names of KRNL386.EXE, which the personality's KERNEL answers for (GetProcAddress by name)
    sys.path.insert(0, here); from neinfo import ne as neparse
    bundle['names16'] = {'KERNEL': {v.upper(): k for k, v in neparse(os.path.join(src, 'krnl386.exe'))[4].items()}}
    bundle['vxds'] = {}
    for f, b, lk in VXDS:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        trace = ['--trace'] if f.upper() in os.environ.get('TRACE_NE', '').upper().split(',') else []
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--vxd', '--base', hex(b), '--lookup', hex(lk)] + trace, check=True)
        bundle['vxds'][f.upper()] = {'image': b64(base + '.img'), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
    bundle['drivers'] = {}
    for f, b, lk in DRIVERS:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--lookup', hex(lk)], check=True)
        bundle['drivers'][f.upper()] = {'file': b64(p), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
    bundle['net'] = {}
    for f, b, lk in NET:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--lookup', hex(lk)], check=True)
        bundle['net'][f.upper()] = {'file': b64(p), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
    for f, b, lk in PROGRAMS:
        p = os.path.join(src, f); base = os.path.join(tmp, f)
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), p, base, '--base', hex(b), '--lookup', hex(lk)], check=True)
        bundle['programs'][f.upper()] = {'file': b64(p), 'wasm': b64(base + '.wasm'), 'meta': json.load(open(base + '.json'))}
# the Setup INF files whose registry sections the shell applies (SHELL.INF: the shell's classes and folders)
INFS = ['shell.inf', 'motown.inf', 'mmopt.inf', 'wave.inf', 'netnovel.inf', 'nettrans.inf', 'netcli.inf', 'net.inf', 'netdef.inf',
        # the printer drivers' INFs the Add Printer wizard lists (PRECOPY2.CAB)
        'msprint.inf', 'msprint2.inf',
        # where each file of the CD's cabinets is, which Setup's engine copies from (PRECOPY2.CAB)
        'layout.inf', 'layout1.inf']
# the sounds Setup puts in C:\WINDOWS\MEDIA: MOTOWN.INF's start-up sound and MMOPT.INF's clips of a Typical install (WIN95_02.CAB)
MEDIA = ['mssound.wav', 'chimes.wav', 'chord.wav', 'ding.wav', 'tada.wav', 'canyon.mid', 'passport.mid']
bundle['media'] = {f.upper(): b64(os.path.join(src, f)) for f in MEDIA if os.path.exists(os.path.join(src, f))}
# the help files Setup puts in C:\WINDOWS\HELP: Windows' own topics and Notepad's, with their contents (WIN95_13.CAB)
HELP = ['windows.hlp', 'windows.cnt', 'notepad.hlp', 'notepad.cnt']
bundle['help'] = {f.upper(): b64(os.path.join(src, f)) for f in HELP if os.path.exists(os.path.join(src, f))}
# the real-mode drivers IO.SYS loads before Windows: IFSHLP.SYS, the file system manager's helper (WIN95_22.CAB)
DOS = ['ifshlp.sys',
       # the code-page fonts of the EGA and VGA text modes (C:\WINDOWS\COMMAND\EGA.CPI), whose 8x16 code page 437 font
       # the display's text mode shows (message mode's blue screens) (WIN95_12.CAB)
       'ega.cpi']
bundle['dos'] = {f.upper(): b64(os.path.join(src, f)) for f in DOS if os.path.exists(os.path.join(src, f))}
# files whose own text the system shows: KERNEL32.DLL's fault dialog and messages (Close Program, "This program has
# performed an illegal operation"), and VWIN32.VXD's fatal-exception blue screen (WIN95_12.CAB)
RES = ['kernel32.dll', 'vwin32.vxd']
bundle['res'] = {f.upper(): b64(os.path.join(src, f)) for f in RES if os.path.exists(os.path.join(src, f))}
bundle['infs'] = {f.upper(): open(os.path.join(src, f), 'rb').read().decode('latin1') for f in INFS if os.path.exists(os.path.join(src, f))}
# every module's block table (an i32 per code byte at its lookup base) lives in one address space with the others':
# two that overlap make a module dispatch through another's table once both are loaded
tables = sorted((m['meta']['lookup'], m['meta']['lookup'] + 4 * (m['meta']['textHi'] - m['meta']['textLo']), name)
                for group in bundle.values() if isinstance(group, dict)
                for name, m in group.items() if isinstance(m, dict) and isinstance(m.get('meta'), dict) and 'lookup' in m['meta'])
for (a0, a1, an), (b0, b1, bn) in zip(tables, tables[1:]):
    if b0 < a1: sys.exit(f'block tables overlap: {an} {a0:#x}-{a1:#x} and {bn} {b0:#x}-{b1:#x}')
with open(out, 'w') as fh:
    fh.write('// Generated by tools/build_system.py from the Windows 95 system files.\nwindow.W95SYSTEM = ')
    json.dump(bundle, fh, separators=(',', ':')); fh.write(';\n')
