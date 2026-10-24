// SHELL32.DLL for guest programs: the Win95 exports, answered by the running shell (window.W95SHELL, set by
// win95.js). Structures are the Win32 ones, byte-packed as shellapi.h packs them on x86.
(() => {
const { def, YIELD } = window.W95Win32;
const S = () => window.W95SHELL;
const { FSError, basename, dirname, join } = window.W95FS;

const ERR = { FILE_NOT_FOUND: 2, PATH_NOT_FOUND: 3, ACCESS_DENIED: 5, NOASSOC: 31 };

// A call that waits on a shell dialog: the first entry opens it and yields; the shell's answer resumes the guest,
// which re-enters the same call and gets the result.
function waitFor(p, open) {
  if (p.dlgDone) { const r = p.dlgDone.result; p.dlgDone = null; return r; }
  p.modal = { kind: 'shell' }; p.waiting = true;
  open(result => { p.modal = null; p.dlgDone = { result }; });
  return YIELD;
}

// Item ID lists are handles naming a path (or null for My Computer); SHGetPathFromIDList reads them back.
const pidl = (p, path) => p.newHandle({ kind: 'pidl', path });
const pidlPath = (p, h) => { const o = p.obj(h); return o && o.kind === 'pidl' ? o.path : undefined; };
// double-null-terminated string lists (SHFILEOPSTRUCT.pFrom/pTo)
function strList(p, a) { const out = []; if (!a) return out; for (;;) { const s = p.readA(a); if (!s) return out; out.push(s); a += s.length + 1; } }

function run(p, verb, file, params) {
  const sh = S(), fs = sh.fs;
  verb = (verb || 'open').toLowerCase();
  if (!file) return ERR.FILE_NOT_FOUND;
  if (/^[a-z]+:\/\//i.test(file)) return ERR.NOASSOC;
  if (!fs.exists(file)) return dirname(file) && !fs.exists(dirname(file)) ? ERR.PATH_NOT_FOUND : ERR.FILE_NOT_FOUND;
  const st = fs.stat(file);
  if (verb === 'explore' || verb === 'open' && st.isDir) return sh.explore(file) ? 33 : ERR.FILE_NOT_FOUND;
  if (verb !== 'open') return ERR.NOASSOC;
  if (!sh.typeOf(st.name, false).open) return ERR.NOASSOC;
  return sh.open(file, params || '') ? 33 : ERR.FILE_NOT_FOUND;
}

def('SHELL32', 'ShellExecuteA', 6, function (hwnd, verb, file, params, dir, show) {
  return run(this, this.readA(verb), this.readA(file), this.readA(params));
});
def('SHELL32', 'ShellExecuteExA', 1, function (sei) {
  const mask = this.r32(sei + 4), file = mask & 4 ? pidlPath(this, this.r32(sei + 40)) : this.readA(this.r32(sei + 16));
  const r = run(this, this.readA(this.r32(sei + 12)), file, this.readA(this.r32(sei + 20)));
  this.w32(sei + 32, r);
  return r > 32 ? 1 : 0;
});
def('SHELL32', 'FindExecutableA', 3, function (file, dir, out) {
  const sh = S(), f = this.readA(file);
  if (!f || !sh.fs.exists(f)) { this.writeA(out, ''); return ERR.FILE_NOT_FOUND; }
  const ext = f.split('.').pop().toLowerCase();
  const exe = ['exe', 'com', 'bat'].includes(ext) ? sh.fs.realpath(f) : sh.typeOf(f, false).open ? 'C:\\WINDOWS\\NOTEPAD.EXE' : null;
  if (!exe) { this.writeA(out, ''); return ERR.NOASSOC; }
  this.writeA(out, exe); return 42;
});

// SHFILEINFOA: hIcon +0, iIcon +4, dwAttributes +8, szDisplayName[260] +12, szTypeName[80] +272
const SHGFI = { ICON: 0x100, DISPLAYNAME: 0x200, TYPENAME: 0x400, ATTRIBUTES: 0x800, EXETYPE: 0x2000, SYSICONINDEX: 0x4000, PIDL: 0x8, USEFILEATTRIBUTES: 0x10 };
const SFGAO = { FOLDER: 0x20000000, FILESYSTEM: 0x40000000, HASSUBFOLDER: 0x80000000, CANCOPY: 1, CANMOVE: 2, CANRENAME: 0x10, CANDELETE: 0x20, HASPROPSHEET: 0x40, LINK: 0x10000, READONLY: 0x40000 };
const ICONS = [];
const iconIndex = name => { let i = ICONS.indexOf(name); if (i < 0) { i = ICONS.length; ICONS.push(name); } return i; };
def('SHELL32', 'SHGetFileInfoA', 5, function (path, fattrs, psfi, cb, flags) {
  const sh = S(), fs = sh.fs;
  let name, isDir, attrs = fattrs, real = null;
  const p = flags & SHGFI.PIDL ? pidlPath(this, path) : this.readA(path);
  if (p === undefined) return 0;
  if (p === null) { name = 'My Computer'; isDir = true; }
  else if (flags & SHGFI.USEFILEATTRIBUTES) { name = basename(p) || p; isDir = !!(fattrs & 0x10); }
  else {
    if (!fs.exists(p)) return 0;
    const st = fs.stat(p); real = st.path; name = st.name || st.path; isDir = st.isDir; attrs = st.attrs;
  }
  if (flags & SHGFI.EXETYPE) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'com' || ext === 'bat') return 0x5a4d;
    if (ext !== 'exe' || !real) return 0;
    const b = fs.readFile(real); if (b[0] !== 0x4d || b[1] !== 0x5a) return 0;
    const pe = b[0x3c] | b[0x3d] << 8;
    return b[pe] === 0x50 && b[pe + 1] === 0x45 ? 0x4550 | 0x0400 << 16 : b[pe] === 0x4e && b[pe + 1] === 0x45 ? 0x454e | 0x0400 << 16 : 0x5a4d;
  }
  const t = p === null ? { desc: 'System Folder', icon: 'mycomputer' } : /^[a-z]:\\?$/i.test(p) ? { desc: 'Local Disk', icon: 'hdd' } : sh.typeOf(name, isDir);
  if (!psfi) return 1;
  this.u8.fill(0, psfi, psfi + 352);
  if (flags & (SHGFI.ICON | SHGFI.SYSICONINDEX)) this.w32(psfi + 4, iconIndex(t.icon));
  if (flags & SHGFI.ICON) this.w32(psfi, this.newHandle({ kind: 'icon', shell: t.icon }));
  if (flags & SHGFI.DISPLAYNAME) this.writeA(psfi + 12, p === null ? name : /^[a-z]:\\?$/i.test(p) ? `(${p[0].toUpperCase()}:)` : sh.displayName(name, isDir), 260);
  if (flags & SHGFI.TYPENAME) this.writeA(psfi + 272, t.desc, 80);
  if (flags & SHGFI.ATTRIBUTES) {
    let a = SFGAO.CANCOPY | SFGAO.CANMOVE | SFGAO.CANRENAME | SFGAO.CANDELETE | SFGAO.HASPROPSHEET;
    if (isDir) a |= SFGAO.FOLDER | (real && fs.readdir(real).some(i => i.isDir) ? SFGAO.HASSUBFOLDER : 0);
    if (real || flags & SHGFI.USEFILEATTRIBUTES) a |= SFGAO.FILESYSTEM;
    if (/\.lnk$/i.test(name)) a |= SFGAO.LINK;
    if (attrs & 1) a |= SFGAO.READONLY;
    this.w32(psfi + 8, a);
  }
  return 1;
});

// SHFILEOPSTRUCTA: hwnd +0, wFunc +4, pFrom +8, pTo +12, fFlags +16 (WORD), fAnyOperationsAborted +18,
// hNameMappings +22, lpszProgressTitle +26
const FO = { MOVE: 1, COPY: 2, DELETE: 3, RENAME: 4 };
const FOF = { MULTIDESTFILES: 1, SILENT: 4, RENAMEONCOLLISION: 8, NOCONFIRMATION: 0x10, ALLOWUNDO: 0x40, FILESONLY: 0x80, NOCONFIRMMKDIR: 0x200 };
def('SHELL32', 'SHFileOperationA', 1, function (op) {
  const sh = S(), fs = sh.fs;
  const func = this.r32(op + 4), from = strList(this, this.r32(op + 8)), to = strList(this, this.r32(op + 12)), flags = this.r16(op + 16);
  this.w32(op + 18, 0);
  const expand = s => {
    if (!/[*?]/.test(s)) return fs.exists(s) ? [fs.realpath(s)] : [];
    const dir = dirname(s); if (!fs.exists(dir)) return [];
    return fs.readdir(dir, basename(s)).filter(i => !(flags & FOF.FILESONLY) || !i.isDir).map(i => i.path);
  };
  const free = (dir, name) => {
    if (!(flags & FOF.RENAMEONCOLLISION) || !fs.exists(join(dir, name))) return join(dir, name);
    for (let n = 1; ; n++) { const c = join(dir, `Copy ${n > 1 ? `(${n}) ` : ''}of ${name}`); if (!fs.exists(c)) return c; }
  };
  try {
    const srcs = from.flatMap(expand);
    if (!srcs.length) return ERR.FILE_NOT_FOUND;
    srcs.forEach((src, i) => {
      if (func === FO.DELETE) {
        if (flags & FOF.ALLOWUNDO && /^C:/i.test(src)) sh.recycle(src);
        else if (fs.stat(src).isDir) fs.rmdir(src, { recursive: true }); else fs.unlink(src);
        return;
      }
      const target = to[flags & FOF.MULTIDESTFILES ? i : 0];
      if (!target) throw new FSError(3, '');
      if (func === FO.RENAME) { fs.rename(src, target); return; }
      const intoDir = !(flags & FOF.MULTIDESTFILES) && (srcs.length > 1 || fs.exists(target) && fs.stat(target).isDir);
      if (intoDir && !fs.exists(target)) fs.mkdir(target, { recursive: true });
      const dst = intoDir ? free(target, basename(src)) : target;
      if (!fs.exists(dirname(dst))) fs.mkdir(dirname(dst), { recursive: true });
      if (func === FO.COPY) fs.copy(src, dst, { overwrite: true });
      else if (func === FO.MOVE) fs.rename(src, dst, { overwrite: true });
    });
    return 0;
  } catch (e) {
    if (!(e instanceof FSError)) throw e;
    this.w32(op + 18, 1);
    return e.code || ERR.ACCESS_DENIED;
  }
});

// special folders by CSIDL
const CSIDL = { 0: 'desktop', 2: 'programs', 5: 'personal', 7: 'startup', 8: 'recent', 9: 'sendto', 0x0b: 'startmenu', 0x10: 'desktop', 0x14: 'fonts', 0x15: 'templates' };
def('SHELL32', 'SHGetSpecialFolderLocation', 3, function (hwnd, csidl, out) {
  if (csidl === 0x11) { this.w32(out, pidl(this, null)); return 0; }  // My Computer
  const path = S().special(CSIDL[csidl]); if (!path) { this.w32(out, 0); return 0x80004005; }
  if (!S().fs.exists(path)) S().fs.mkdir(path, { recursive: true });
  this.w32(out, pidl(this, path)); return 0;
});
def('SHELL32', 'SHGetPathFromIDListA', 2, function (h, out) {
  const path = pidlPath(this, h); if (!path) { if (out) this.writeA(out, ''); return 0; }
  this.writeA(out, path, 260); return 1;
});
def('SHELL32', 'SHGetMalloc', 1, () => 0x80004001);
def('SHELL32', 'ILFree', 1, function (h) { if (pidlPath(this, h) !== undefined) this.handles.delete(h); });
def('SHELL32', 'SHFree', 1, function (h) { if (pidlPath(this, h) !== undefined) this.handles.delete(h); });

// BROWSEINFOA: hwndOwner +0, pidlRoot +4, pszDisplayName +8, lpszTitle +12, ulFlags +16, lpfn +20, lParam +24, iImage +28
def('SHELL32', 'SHBrowseForFolderA', 1, function (bi) {
  const title = this.readA(this.r32(bi + 12)) || '';
  return waitFor(this, done => S().browseFolder(title, path => {
    if (!path) return done(0);
    const name = this.r32(bi + 8); if (name) this.writeA(name, basename(path) || path, 260);
    done(pidl(this, path));
  }));
});

// NOTIFYICONDATAA: cbSize +0, hWnd +4, uID +8, uFlags +12, uCallbackMessage +16, hIcon +20, szTip[64] +24
const NIF = { MESSAGE: 1, ICON: 2, TIP: 4 };
def('SHELL32', 'Shell_NotifyIconA', 2, function (msg, d) {
  const hwnd = this.r32(d + 4), id = this.r32(d + 8), fl = this.r32(d + 12);
  if (msg === 2) return S().traySet(this, hwnd, id, null) ? 1 : 0;
  if (msg !== 0 && msg !== 1) return 0;
  const o = { add: msg === 0 };
  if (fl & NIF.MESSAGE) o.msg = this.r32(d + 16);
  if (fl & NIF.ICON) { const ic = this.obj(this.r32(d + 20)); o.icon = ic && ic.shell ? ic.shell : 'app'; }
  if (fl & NIF.TIP) o.tip = this.readA(d + 24, 64) || '';
  return S().traySet(this, hwnd, id, o) ? 1 : 0;
});

def('SHELL32', 'ShellAboutA', 4, function (hwnd, app, other, icon) {
  const a = (this.readA(app) || 'Windows').split('#')[0];
  return waitFor(this, done => S().about(a, this.readA(other) || '', () => done(1)));
});
def('SHELL32', 'SHAddToRecentDocs', 2, function (flags, pv) {
  const path = flags === 2 ? this.readA(pv) : flags === 1 ? pidlPath(this, pv) : null;
  if (path && S().fs.exists(path)) S().addRecent(S().fs.realpath(path));
});
def('SHELL32', 'SHChangeNotify', 4, () => 0);      // the file system announces its own changes to every view
def('SHELL32', 'SHEmptyRecycleBinA', 3, function () { S().emptyBin(); return 0; });

// Files dropped on a window: the shell posts none yet, so a guest that accepts them never receives a drop.
def('SHELL32', 'DragAcceptFiles', 2, () => 0);
def('SHELL32', 'DragQueryFileA', 4, () => 0);
def('SHELL32', 'DragFinish', 1, () => 0);
def('SHELL32', 'DragQueryPoint', 2, () => 0);

// Icon resources inside files are not read yet: every file reports none.
def('SHELL32', 'ExtractIconA', 3, () => 0);
})();
