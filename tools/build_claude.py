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
IMPORTS = [('CLAUDE.DLL', ['Start']), ('USER32.dll', ['GetMessageA', 'IsDialogMessageA', 'TranslateMessage', 'DispatchMessageA']),
           ('KERNEL32.dll', ['ExitProcess'])]
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
    code = bytearray(); fix = []   # (offset of a rel32, label)
    label = {}
    def emit(*b): code.extend(b)
    def call(n): emit(0xFF, 0x15); code.extend(struct.pack('<I', iat[n]))
    def jcc(op, to): emit(0x0F, op); fix.append((len(code), to)); code.extend(b'\0\0\0\0')
    def jmp(to): emit(0xE9); fix.append((len(code), to)); code.extend(b'\0\0\0\0')
    MSG, HWND = 0xE4, 0xE0   # [ebp-28]: the MSG; [ebp-32]: the window
    emit(0x55, 0x89, 0xE5, 0x83, 0xEC, 0x24)            # push ebp; mov ebp, esp; sub esp, 36
    call('Start')                                        # the window, or 0
    emit(0x85, 0xC0); jcc(0x84, 'done')                  # test eax, eax; jz done
    emit(0x89, 0x45, HWND)                               # mov [ebp-32], eax
    label['loop'] = len(code)
    emit(0x6A, 0, 0x6A, 0, 0x6A, 0, 0x8D, 0x45, MSG, 0x50); call('GetMessageA')   # GetMessageA(&msg, 0, 0, 0)
    emit(0x85, 0xC0); jcc(0x84, 'done')                  # WM_QUIT
    emit(0x83, 0xF8, 0xFF); jcc(0x84, 'done')            # -1: an error
    emit(0x8D, 0x45, MSG, 0x50, 0xFF, 0x75, HWND); call('IsDialogMessageA')   # Tab between the controls, Enter as Send
    emit(0x85, 0xC0); jcc(0x85, 'loop')
    emit(0x8D, 0x45, MSG, 0x50); call('TranslateMessage')
    emit(0x8D, 0x45, MSG, 0x50); call('DispatchMessageA')
    jmp('loop')
    label['done'] = len(code)
    emit(0x6A, 0); call('ExitProcess'); emit(0xC3)
    for at, to in fix: struct.pack_into('<i', code, at, label[to] - (at + 4))
    return bytes(code)

def pe():
    imp, iat = idata(); code = text(iat)
    pad = lambda b, n: b + bytes(-len(b) % n)
    code_f, imp_f = pad(code, FALIGN), pad(imp, FALIGN)
    hdr = bytearray(0x400)
    hdr[0:2] = b'MZ'; struct.pack_into('<I', hdr, 0x3C, 0x80)
    hdr[0x40:0x40 + 39] = b'This program requires Microsoft Windows.'[:39]
    o = 0x80; hdr[o:o + 4] = b'PE\0\0'
    # COFF: i386, two sections, an optional header of 224 bytes, executable, 32-bit, relocations stripped (loaded at its own base)
    struct.pack_into('<HHIIIHH', hdr, o + 4, 0x14C, 2, 0x3C000000, 0, 0, 224, 0x0103)
    opt = o + 24
    struct.pack_into('<HBBIIIIII', hdr, opt, 0x10B, 2, 50, len(code_f), len(imp_f), 0, TEXT_RVA, TEXT_RVA, IDATA_RVA)
    struct.pack_into('<IIIHHHHHHIIIIHHIIIIII', hdr, opt + 28,
                     BASE, ALIGN, FALIGN, 4, 0, 1, 0, 4, 0, 0, 0x3000, 0x400, 0, 2, 0,   # Windows 4.0, a GUI program
                     0x100000, 0x1000, 0x100000, 0x1000, 0, 16)
    struct.pack_into('<II', hdr, opt + 96 + 8, IDATA_RVA, len(imp))   # the import directory
    sec = opt + 224
    struct.pack_into('<8sIIIIIIHHI', hdr, sec, b'.text', len(code), TEXT_RVA, len(code_f), 0x400, 0, 0, 0, 0, 0x60000020)
    struct.pack_into('<8sIIIIIIHHI', hdr, sec + 40, b'.idata', len(imp), IDATA_RVA, len(imp_f), 0x400 + len(code_f), 0, 0, 0, 0, 0xC0000040)
    return bytes(hdr) + code_f + imp_f

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
