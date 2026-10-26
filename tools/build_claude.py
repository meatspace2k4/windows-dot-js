"""Build CLAUDE.EXE, the Claude program Windows 95 runs, and write claude-exe.js: its file, its code recompiled as every
program's is (recomp.py) and its metadata, as a program of the system's (system.js W95SYSTEM.programs). The program is a
Win32 GUI image of its own: its entry calls CLAUDE.DLL's Start, which makes its window through the system's USER32
(claude-app.js: the DLL is implemented in JS, as SHELL32's stand-ins are), then runs the message loop every Windows
program runs (GetMessage, IsDialogMessage, TranslateMessage, DispatchMessage) until WM_QUIT, and exits.

    python3 tools/build_claude.py
"""
import base64, json, os, struct, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
BASE = 0x00570000      # its load base: a program base of its own (build_system.py PROGRAMS), the image's preferred base too
LOOKUP = 0x07FF0000    # its block table, past the other programs'
IMPORTS = [('CLAUDE.DLL', ['Start', 'Handle', 'Answer', 'Opened']), ('USER32.dll', ['GetMessageA', 'IsDialogMessageA', 'TranslateMessage', 'DispatchMessageA', 'DefWindowProcA', 'MessageBoxA',
                                                                           'TrackPopupMenu', 'DestroyMenu', 'DialogBoxIndirectParamA']),
           ('COMDLG32.dll', ['GetOpenFileNameA']), ('KERNEL32.dll', ['ExitProcess'])]
TEXT_RVA, IDATA_RVA, ALIGN, FALIGN = 0x1000, 0x2000, 0x1000, 0x200

# ---------------------------------------------------------------- the import section, laid out first (the code calls through its IAT)
def idata():
    out = bytearray(20 * (len(IMPORTS) + 1)); iat = {}; desc = []
    for dll, names in IMPORTS:
        ilt_at = len(out); out += bytes(4 * (len(names) + 1))
        iat_at = len(out); out += bytes(4 * (len(names) + 1))
        name_at = len(out); out += dll.encode() + b'\0'
        if len(out) & 1: out += b'\0'
        for i, n in enumerate(names):
            hint_at = len(out); out += struct.pack('<H', 0) + n.encode() + b'\0'
            if len(out) & 1: out += b'\0'
            struct.pack_into('<I', out, ilt_at + 4 * i, IDATA_RVA + hint_at); struct.pack_into('<I', out, iat_at + 4 * i, IDATA_RVA + hint_at)
            iat[n] = BASE + IDATA_RVA + iat_at + 4 * i
        desc.append((ilt_at, name_at, iat_at))
    for k, (ilt_at, name_at, iat_at) in enumerate(desc):
        struct.pack_into('<IIIII', out, 20 * k, IDATA_RVA + ilt_at, 0, 0, IDATA_RVA + name_at, IDATA_RVA + iat_at)
    return bytes(out), iat

# ---------------------------------------------------------------- the code: Start, then the message loop
def text(iat):
    code = bytearray(); fix = []; absfix = []   # (offset of a rel32, label); (offset of an address, label)
    label = {}
    def emit(*b): code.extend(b)
    def call(n): emit(0xFF, 0x15); code.extend(struct.pack('<I', iat[n]))
    def jcc(op, to): emit(0x0F, op); fix.append((len(code), to)); code.extend(b'\0\0\0\0')
    def jmp(to): emit(0xE9); fix.append((len(code), to)); code.extend(b'\0\0\0\0')
    MSG, HWND = 0xE4, 0xE0   # [ebp-28]: the MSG; [ebp-32]: the window
    emit(0x55, 0x89, 0xE5, 0x83, 0xEC, 0x24)            # push ebp; mov ebp, esp; sub esp, 36
    emit(0x68); absfix.append((len(code), 'wndproc')); code.extend(b'\0\0\0\0')   # push WndProc
    call('Start')                                        # Start(WndProc): the window, or 0
    emit(0x85, 0xC0); jcc(0x84, 'done')                  # test eax, eax; jz done
    emit(0x89, 0x45, HWND)                               # mov [ebp-32], eax
    label['loop'] = len(code)
    emit(0x6A, 0, 0x6A, 0, 0x6A, 0, 0x8D, 0x45, MSG, 0x50); call('GetMessageA')   # GetMessageA(&msg, 0, 0, 0)
    emit(0x85, 0xC0); jcc(0x84, 'done')                  # WM_QUIT
    emit(0x83, 0xF8, 0xFF); jcc(0x84, 'done')            # -1: an error    # (the system keys, Alt and Alt+letter, are the menu bar's: past IsDialogMessage, to DefWindowProc's menu loop, as in a
    # program with no dialog keys; IsDialogMessage would take Alt+letter as a control's mnemonic)
    emit(0x8B, 0x45, MSG + 4)                            # mov eax, [msg.message]
    emit(0x2D); code.extend(struct.pack('<I', 0x104))    # sub eax, WM_SYSKEYDOWN
    emit(0x83, 0xF8, 0x03); jcc(0x86, 'translate')       # cmp eax, 3; jbe translate (WM_SYSKEYDOWN, WM_SYSKEYUP, WM_SYSCHAR, WM_SYSDEADCHAR)
    emit(0x8D, 0x45, MSG, 0x50, 0xFF, 0x75, HWND); call('IsDialogMessageA')   # Tab between the controls, Enter as Send
    emit(0x85, 0xC0); jcc(0x85, 'loop')
    label['translate'] = len(code)
    emit(0x8D, 0x45, MSG, 0x50); call('TranslateMessage')
    emit(0x8D, 0x45, MSG, 0x50); call('DispatchMessageA')
    jmp('loop')
    label['done'] = len(code)
    emit(0x6A, 0); call('ExitProcess'); emit(0xC3)
    # WndProc(hwnd, msg, wp, lp): CLAUDE.DLL's Handle answers the messages that are Claude's (it writes the result and
    # returns 1); every other goes to DefWindowProcA from here, guest code calling guest code, so its own loops (moving
    # or sizing the window, a menu) wait for their messages as they do in any program
    label['wndproc'] = len(code)
    emit(0x55, 0x89, 0xE5, 0x83, 0xEC, 0x04)            # push ebp; mov ebp, esp; sub esp, 4
    # WM_APP+1 (text in wp, caption in lp): a question of the app's (an approval), asked as a program asks one, with
    # MessageBoxA (Yes, No); the answer goes to CLAUDE.DLL's Answer
    emit(0x81, 0x7D, 0x0C); code.extend(struct.pack('<I', 0x8001)); jcc(0x85, 'popup')    # cmp dword [ebp+12], 8001h; jne popup
    emit(0x6A, 0x24, 0xFF, 0x75, 0x14, 0xFF, 0x75, 0x10, 0xFF, 0x75, 0x08)   # push MB_YESNO|MB_ICONQUESTION; push lp; push wp; push hwnd
    call('MessageBoxA')
    emit(0x50); call('Answer')                           # Answer(IDYES / IDNO)
    emit(0x31, 0xC0, 0xC9, 0xC2, 0x10, 0x00)            # xor eax, eax; leave; ret 16
    # WM_APP+2 (the menu in wp, the screen point at [lp], [lp+4]): a shortcut menu of the app's (a session's), tracked as
    # a program tracks one; its choice arrives as WM_COMMAND, and the menu is destroyed after
    label['popup'] = len(code)
    emit(0x81, 0x7D, 0x0C); code.extend(struct.pack('<I', 0x8002)); jcc(0x85, 'open')
    emit(0x8B, 0x45, 0x14)                               # mov eax, [ebp+20]
    emit(0x6A, 0x00, 0xFF, 0x75, 0x08, 0x6A, 0x00, 0xFF, 0x70, 0x04, 0xFF, 0x30, 0x6A, 0x02, 0xFF, 0x75, 0x10)   # push 0; push hwnd; push 0; push y; push x; push TPM_RIGHTBUTTON; push menu
    call('TrackPopupMenu')
    emit(0xFF, 0x75, 0x10); call('DestroyMenu')
    emit(0x31, 0xC0, 0xC9, 0xC2, 0x10, 0x00)
    # WM_APP+3 (an OPENFILENAME at lp): a file to attach to the prompt, chosen in the system's Open dialog (COMDLG32's
    # GetOpenFileNameA, a modal loop of its own); whether one was chosen goes to CLAUDE.DLL's Opened
    label['open'] = len(code)
    emit(0x81, 0x7D, 0x0C); code.extend(struct.pack('<I', 0x8003)); jcc(0x85, 'dialog')
    emit(0xFF, 0x75, 0x14); call('GetOpenFileNameA')     # push lp; GetOpenFileNameA(lp)
    emit(0x50); call('Opened')                           # Opened(chosen)
    emit(0x31, 0xC0, 0xC9, 0xC2, 0x10, 0x00)
    # WM_APP+4 (a dialog template at wp, its dialog procedure at lp: CLAUDE.DLL's): a dialog of the program's (Rename
    # Session), shown modally as a program shows one; what it answers, its procedure keeps
    label['dialog'] = len(code)
    emit(0x81, 0x7D, 0x0C); code.extend(struct.pack('<I', 0x8004)); jcc(0x85, 'handle')
    emit(0x6A, 0x00, 0xFF, 0x75, 0x14, 0xFF, 0x75, 0x08, 0xFF, 0x75, 0x10, 0x6A, 0x00)   # push 0; push dlgproc; push hwnd; push template; push 0 (hInstance)
    call('DialogBoxIndirectParamA')
    emit(0x31, 0xC0, 0xC9, 0xC2, 0x10, 0x00)
    label['handle'] = len(code)
    emit(0x8D, 0x45, 0xFC, 0x50)                         # lea eax, [ebp-4]; push eax (&result)
    for off in (0x14, 0x10, 0x0C, 0x08): emit(0xFF, 0x75, off)   # push lp, wp, msg, hwnd
    call('Handle')
    emit(0x85, 0xC0); jcc(0x84, 'default')
    emit(0x8B, 0x45, 0xFC, 0xC9, 0xC2, 0x10, 0x00)      # mov eax, [ebp-4]; leave; ret 16
    label['default'] = len(code)
    for off in (0x14, 0x10, 0x0C, 0x08): emit(0xFF, 0x75, off)
    call('DefWindowProcA')
    emit(0xC9, 0xC2, 0x10, 0x00)                         # leave; ret 16
    for at, to in fix: struct.pack_into('<i', code, at, label[to] - (at + 4))
    for at, to in absfix: struct.pack_into('<I', code, at, BASE + TEXT_RVA + label[to])
    return bytes(code), [at for at, _ in absfix]

# ---------------------------------------------------------------- the relocations: the code's absolute addresses (the
# pushed WndProc), as a linker leaves them; they also tell the recompiler the address is code to translate
def reloc(offsets):
    entries = [(3 << 12) | (TEXT_RVA + o - TEXT_RVA) for o in offsets]
    if len(entries) & 1: entries.append(0)
    return struct.pack('<II', TEXT_RVA, 8 + 2 * len(entries)) + b''.join(struct.pack('<H', e) for e in entries)

RELOC_RVA = 0x3000
def pe():
    imp, iat = idata(); code, abs_at = text(iat); rel = reloc(abs_at)
    pad = lambda b, n: b + bytes(-len(b) % n)
    code_f, imp_f, rel_f = pad(code, FALIGN), pad(imp, FALIGN), pad(rel, FALIGN)
    hdr = bytearray(0x400)
    hdr[0:2] = b'MZ'; struct.pack_into('<I', hdr, 0x3C, 0x80)
    hdr[0x40:0x40 + 39] = b'This program requires Microsoft Windows.'[:39]
    o = 0x80; hdr[o:o + 4] = b'PE\0\0'
    # COFF: i386, three sections, an optional header of 224 bytes, executable, 32-bit
    struct.pack_into('<HHIIIHH', hdr, o + 4, 0x14C, 3, 0x3C000000, 0, 0, 224, 0x0102)
    opt = o + 24
    struct.pack_into('<HBBIIIIII', hdr, opt, 0x10B, 2, 50, len(code_f), len(imp_f), 0, TEXT_RVA, TEXT_RVA, IDATA_RVA)
    struct.pack_into('<IIIHHHHHHIIIIHHIIIIII', hdr, opt + 28,
                     BASE, ALIGN, FALIGN, 4, 0, 1, 0, 4, 0, 0, 0x4000, 0x400, 0, 2, 0,   # Windows 4.0, a GUI program
                     0x100000, 0x1000, 0x100000, 0x1000, 0, 16)
    struct.pack_into('<II', hdr, opt + 96 + 8, IDATA_RVA, len(imp))   # the import directory
    struct.pack_into('<II', hdr, opt + 96 + 40, RELOC_RVA, len(rel))  # the base relocations
    sec = opt + 224
    struct.pack_into('<8sIIIIIIHHI', hdr, sec, b'.text', len(code), TEXT_RVA, len(code_f), 0x400, 0, 0, 0, 0, 0x60000020)
    struct.pack_into('<8sIIIIIIHHI', hdr, sec + 40, b'.idata', len(imp), IDATA_RVA, len(imp_f), 0x400 + len(code_f), 0, 0, 0, 0, 0xC0000040)
    struct.pack_into('<8sIIIIIIHHI', hdr, sec + 80, b'.reloc', len(rel), RELOC_RVA, len(rel_f), 0x400 + len(code_f) + len(imp_f), 0, 0, 0, 0, 0x42000040)
    return bytes(hdr) + code_f + imp_f + rel_f

if __name__ == '__main__':
    os.environ['RECOMP_SHARED'] = '1'   # (the machines' memory is shared, as build_system.py builds every module)
    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, 'claude.exe'); open(exe, 'wb').write(pe())
        out = os.path.join(tmp, 'claude')
        subprocess.run([sys.executable, os.path.join(here, 'recomp.py'), exe, out, '--base', hex(BASE), '--lookup', hex(LOOKUP)], check=True)
        b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
        entry = {'file': b64(exe), 'wasm': b64(out + '.wasm'), 'meta': json.load(open(out + '.json'))}
    with open(os.path.join(root, 'claude-exe.js'), 'w') as f:
        f.write('// Generated by tools/build_claude.py: CLAUDE.EXE, a program of the system\'s (system.js W95SYSTEM.programs)\n')
        f.write(f"window.W95SYSTEM.programs['CLAUDE.EXE'] = {json.dumps(entry)};\n")
    print('claude-exe.js:', len(entry['file']), 'bytes of image (base64),', len(entry['meta']['blocks']), 'blocks')
