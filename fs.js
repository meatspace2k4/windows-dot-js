'use strict';
// In-memory VFAT-style file system: drive letters, long names with generated 8.3
// aliases, DOS attributes, timestamps, per-volume cluster accounting and
// Win32-style errors. File I/O goes through numeric handles (open/read/write/
// seek/truncate/close). Text is stored as Windows-1252 bytes.
(() => {
const E = {
  FILE_NOT_FOUND: 2, PATH_NOT_FOUND: 3, TOO_MANY_OPEN_FILES: 4, ACCESS_DENIED: 5, INVALID_HANDLE: 6,
  NOT_SAME_DEVICE: 17, WRITE_PROTECT: 19, NOT_READY: 21, READ_FAULT: 30, SHARING_VIOLATION: 32,
  FILE_EXISTS: 80, INVALID_PARAMETER: 87, DISK_FULL: 112, INVALID_NAME: 123, NEGATIVE_SEEK: 131,
  DIR_NOT_EMPTY: 145, ALREADY_EXISTS: 183, DIRECTORY: 267,
};
const MSG = {
  2: 'The system cannot find the file specified.', 3: 'The system cannot find the path specified.',
  4: 'The system cannot open the file.', 5: 'Access is denied.', 6: 'The handle is invalid.',
  17: 'The system cannot move the file to a different disk drive.', 19: 'The media is write protected.',
  21: 'The device is not ready.', 30: 'The system cannot read from the specified device.',
  32: 'The process cannot access the file because it is being used by another process.',
  80: 'The file exists.', 87: 'The parameter is incorrect.', 112: 'There is not enough space on the disk.',
  123: 'The filename, directory name, or volume label syntax is incorrect.',
  131: 'An attempt was made to move the file pointer before the beginning of the file.',
  145: 'The directory is not empty.', 183: 'Cannot create a file when that file already exists.',
  267: 'The directory name is invalid.',
};
class FSError extends Error {
  constructor(code, path) { super(MSG[code] || `Error ${code}`); this.name = 'FSError'; this.code = code; this.path = path || ''; }
}

const ATTR = { READONLY: 1, HIDDEN: 2, SYSTEM: 4, DIRECTORY: 16, ARCHIVE: 32 };

// ---------------------------------------------------------------- Windows-1252
const HI = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
           '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
const ENC = new Map([...HI].map((c, i) => [c.charCodeAt(0), 0x80 + i]));
function encode(s) {
  const out = new Uint8Array(s.length); let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out[n++] = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : (ENC.get(c) ?? 0x3f);
  }
  return out.slice(0, n);
}
function decode(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) {
    const part = b.subarray(i, i + 8192), chars = new Array(part.length);
    for (let j = 0; j < part.length; j++) { const v = part[j]; chars[j] = v >= 0x80 && v < 0xa0 ? HI[v - 0x80] : String.fromCharCode(v); }
    s += chars.join('');
  }
  return s;
}

// ---------------------------------------------------------------- names
const BAD = /[\\/:*?"<>|\x00-\x1f]/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-4]|LPT[1-3]|CLOCK\$)(\..*)?$/i;
const SFN_OK = /^[A-Z0-9!#$%&'()\-@^_`{}~\x80-\xff]+$/;
const SFN_BAD = /[^A-Z0-9!#$%&'()\-@^_`{}~\x80-\xff]/g;
function cleanName(n, path) {
  n = n.replace(/[. ]+$/, '');
  if (!n || n.length > 255 || BAD.test(n)) throw new FSError(E.INVALID_NAME, path || n);
  if (RESERVED.test(n)) throw new FSError(E.ACCESS_DENIED, path || n);
  return n;
}
function is83(n) {
  const m = /^([^.]{1,8})(?:\.([^.]{1,3}))?$/.exec(n);
  return !!m && SFN_OK.test(m[1]) && (!m[2] || SFN_OK.test(m[2]));
}
function shortFor(dir, name) {
  const up = name.toUpperCase();
  if (is83(up) && !dir.byShort.has(up) && !dir.kids.has(up)) return up;
  const dot = up.lastIndexOf('.');
  let base = (dot > 0 ? up.slice(0, dot) : up).replace(/[ .]/g, '').replace(SFN_BAD, '_') || '_';
  const ext = dot > 0 ? up.slice(dot + 1).replace(/ /g, '').replace(SFN_BAD, '_').slice(0, 3) : '';
  for (let i = 1; ; i++) {
    const t = '~' + i, s = base.slice(0, 8 - t.length) + t + (ext ? '.' + ext : '');
    if (!dir.byShort.has(s) && !dir.kids.has(s)) return s;
  }
}
function wildRe(pattern) {
  if (!pattern || pattern === '*' || pattern === '*.*') return null;
  const src = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + src + (pattern.includes('.') ? '' : '(\\..*)?') + '$', 'i');
}

// ---------------------------------------------------------------- nodes and volumes
let inoSeq = 1;
const IMG_MAGIC = [0x57, 0x39, 0x35, 0x44]; // 'W95D'
class Node {
  constructor(name, dir, attrs = 0, t = Date.now()) {
    this.ino = inoSeq++; this.name = name; this.short = ''; this.dir = dir;
    this.attrs = (attrs & ~ATTR.DIRECTORY) | (dir ? ATTR.DIRECTORY : 0);
    this.ctime = this.mtime = this.atime = t;
    this.parent = null; this.vol = null; this.opens = 0; this.absent = false;
    if (dir) { this.kids = new Map(); this.byShort = new Map(); } else { this.buf = new Uint8Array(0); this.size = 0; }
  }
}
class Volume {
  constructor(letter, o) {
    this.letter = letter.toUpperCase(); this.label = (o.label || '').toUpperCase().slice(0, 11);
    this.kind = o.kind || 'fixed'; this.readonly = !!o.readonly; this.ready = o.ready !== false;
    this.cluster = o.cluster || 4096; this.total = o.total || 0; this.used = 0; this.fsname = o.fsname || 'FAT';
    this.serial = o.serial ?? ((Math.random() * 0xffffffff) >>> 0);
    this.root = new Node('', true); this.root.vol = this;
  }
  alloc(n) { return Math.ceil(n / this.cluster) * this.cluster; }
  get free() { return Math.max(0, this.total - this.used); }
}

const FLAGS = {
  r: { read: 1 }, 'r+': { read: 1, write: 1 },
  w: { write: 1, create: 1, trunc: 1 }, 'w+': { read: 1, write: 1, create: 1, trunc: 1 },
  a: { write: 1, create: 1, append: 1 }, 'a+': { read: 1, write: 1, create: 1, append: 1 },
  wx: { write: 1, create: 1, excl: 1 }, 'wx+': { read: 1, write: 1, create: 1, excl: 1 },
};

const join = (a, ...b) => b.reduce((p, s) => (p.endsWith('\\') ? p : p + '\\') + s.replace(/^\\+/, ''), a);
const basename = p => p.replace(/\\+$/, '').split('\\').pop();
const dirname = p => { const s = p.replace(/\\+$/, ''); const i = s.lastIndexOf('\\'); return i <= 2 ? s.slice(0, 3) : s.slice(0, i); };
const extname = p => { const b = basename(p), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };

// ---------------------------------------------------------------- file system
class FileSystem {
  constructor() {
    this.vols = new Map(); this.fds = new Map(); this.inodes = new Map();
    this.nextFd = 3; this.cwd = 'C:\\'; this.version = 0; this.subs = new Set();
  }
  // ---- volumes
  mount(letter, o = {}) {
    const v = new Volume(letter, o); this.vols.set(v.letter, v); this.inodes.set(v.root.ino, v.root);
    this.emit('mount', v.letter + ':\\'); return v;
  }
  volInfo(v) {
    return { letter: v.letter, root: v.letter + ':\\', label: v.label, kind: v.kind, readonly: v.readonly, ready: v.ready,
      total: v.total, used: v.used, free: v.free, cluster: v.cluster, fsname: v.fsname, serial: v.serial };
  }
  volumes() { return [...this.vols.values()].sort((a, b) => a.letter.localeCompare(b.letter)).map(v => this.volInfo(v)); }
  statvfs(path) { return this.volInfo(this.vol(this.split(path).drive)); }
  setLabel(path, label) {
    const v = this.vol(this.split(path).drive); this.writable(v);
    if (label.length > 11 || BAD.test(label) || /[.+,;=[\]]/.test(label)) throw new FSError(E.INVALID_NAME, label);
    v.label = label.toUpperCase(); this.emit('label', v.letter + ':\\');
  }
  // ---- change notification
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(op, path, path2) {
    this.version++;
    for (const f of this.subs) { try { f({ op, path, path2 }); } catch (e) { console.error(e); } }
  }
  // ---- path resolution
  split(path) {
    if (typeof path !== 'string' || !path) throw new FSError(E.INVALID_PARAMETER, String(path));
    const p = path.replace(/\//g, '\\');
    let drive, rest;
    const m = /^([A-Za-z]):(.*)$/.exec(p);
    if (m) {
      drive = m[1].toUpperCase(); rest = m[2];
      if (!rest.startsWith('\\')) rest = (this.cwd[0] === drive ? this.cwd.slice(2) : '\\') + '\\' + rest;
    } else {
      drive = this.cwd[0]; rest = p.startsWith('\\') ? p : this.cwd.slice(2) + '\\' + p;
    }
    const parts = [];
    for (const seg of rest.split('\\')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop(); else parts.push(seg);
    }
    return { drive, parts };
  }
  vol(drive) {
    const v = this.vols.get(drive);
    if (!v) throw new FSError(E.PATH_NOT_FOUND, drive + ':\\');
    if (!v.ready) throw new FSError(E.NOT_READY, drive + ':\\');
    return v;
  }
  child(dir, name) { const k = name.toUpperCase(); return dir.kids.get(k) || dir.byShort.get(k) || null; }
  locate(path) {
    const { drive, parts } = this.split(path), vol = this.vol(drive);
    let node = vol.root;
    for (let i = 0; i < parts.length; i++) {
      if (!node.dir) throw new FSError(E.PATH_NOT_FOUND, path);
      const seg = parts[i].replace(/[. ]+$/, '') || parts[i];
      const nx = this.child(node, seg);
      if (!nx) {
        if (i === parts.length - 1) return { vol, node: null, parent: node, name: parts[i] };
        throw new FSError(E.PATH_NOT_FOUND, path);
      }
      node = nx;
    }
    return { vol, node, parent: node.parent, name: node.name };
  }
  need(path) { const r = this.locate(path); if (!r.node) throw new FSError(E.FILE_NOT_FOUND, path); return r.node; }
  pathOf(n) { const s = []; for (let x = n; x.parent; x = x.parent) s.unshift(x.name); return n.vol.letter + ':\\' + s.join('\\'); }
  shortPathOf(n) { const s = []; for (let x = n; x.parent; x = x.parent) s.unshift(x.short); return n.vol.letter + ':\\' + s.join('\\'); }
  writable(v) { if (v.readonly) throw new FSError(E.WRITE_PROTECT, v.letter + ':\\'); }
  // ---- tree maintenance
  link(parent, n, name) {
    n.name = name; n.short = shortFor(parent, name); n.parent = parent;
    parent.kids.set(name.toUpperCase(), n); parent.byShort.set(n.short, n);
    parent.mtime = Date.now(); this.setVol(n, parent.vol);
  }
  setVol(n, v) { n.vol = v; this.inodes.set(n.ino, n); if (n.dir) for (const k of n.kids.values()) this.setVol(k, v); }
  detach(n) {
    const p = n.parent; p.kids.delete(n.name.toUpperCase()); p.byShort.delete(n.short);
    n.parent = null; p.mtime = Date.now();
  }
  forget(n) {
    this.inodes.delete(n.ino);
    if (n.dir) for (const k of n.kids.values()) this.forget(k);
    else n.vol.used -= n.vol.alloc(n.size);
  }
  busy(n) { if (n.opens) return true; if (n.dir) for (const k of n.kids.values()) if (this.busy(k)) return true; return false; }
  inside(a, b) { for (let p = a; p; p = p.parent) if (p === b) return true; return false; }
  resize(n, size) {
    const v = n.vol, delta = v.alloc(size) - v.alloc(n.size);
    if (delta > 0 && delta > v.free) throw new FSError(E.DISK_FULL, this.pathOf(n));
    v.used += delta;
    if (size > n.buf.length) {
      const b = new Uint8Array(Math.max(size, n.buf.length * 2, 64)); b.set(n.buf.subarray(0, n.size)); n.buf = b;
    } else if (size < n.size) n.buf.fill(0, size, n.size);
    n.size = size;
  }
  info(n) {
    return {
      name: n.parent ? n.name : n.vol.letter + ':\\', shortName: n.parent ? n.short : '', path: this.pathOf(n), shortPath: this.shortPathOf(n),
      isDir: n.dir, type: n.dir ? 'dir' : 'file', size: n.dir ? 0 : n.size, alloc: n.dir ? 0 : n.vol.alloc(n.size), attrs: n.attrs,
      readonly: !!(n.attrs & ATTR.READONLY), hidden: !!(n.attrs & ATTR.HIDDEN), system: !!(n.attrs & ATTR.SYSTEM), archive: !!(n.attrs & ATTR.ARCHIVE),
      ctime: n.ctime, mtime: n.mtime, atime: n.atime, ino: n.ino, drive: n.vol.letter, absent: n.absent, open: n.opens > 0,
    };
  }
  // ---- queries
  stat(path) { return this.info(this.need(path)); }
  exists(path) { try { return !!this.locate(path).node; } catch (_) { return false; } }
  realpath(path) { return this.pathOf(this.need(path)); }
  inoOf(path) { return this.need(path).ino; }
  pathOfIno(ino) { const n = this.inodes.get(ino); return n && (n.parent || !n.vol || n === n.vol.root) ? this.pathOf(n) : null; }
  readdir(path, pattern) {
    const n = this.need(path);
    if (!n.dir) throw new FSError(E.DIRECTORY, path);
    const re = wildRe(pattern);
    return [...n.kids.values()].filter(c => !re || re.test(c.name) || re.test(c.short)).map(c => this.info(c));
  }
  du(path) {
    const out = { files: 0, dirs: 0, bytes: 0, alloc: 0 };
    const walk = n => { for (const k of n.kids.values()) { if (k.dir) { out.dirs++; walk(k); } else { out.files++; out.bytes += k.size; out.alloc += k.vol.alloc(k.size); } } };
    const n = this.need(path); if (n.dir) walk(n); else { out.files = 1; out.bytes = n.size; out.alloc = n.vol.alloc(n.size); }
    return out;
  }
  chdir(path) { const n = this.need(path); if (!n.dir) throw new FSError(E.DIRECTORY, path); this.cwd = this.pathOf(n); }
  // ---- directory operations
  mkdir(path, o = {}) {
    if (o.recursive) {
      const { drive, parts } = this.split(path); let cur = drive + ':\\';
      for (const p of parts) {
        cur = join(cur, p);
        const r = this.locate(cur);
        if (!r.node) this.mkdir(cur); else if (!r.node.dir) throw new FSError(E.ALREADY_EXISTS, cur);
      }
      return this.stat(path);
    }
    const r = this.locate(path); this.writable(r.vol);
    if (r.node) throw new FSError(E.ALREADY_EXISTS, path);
    const name = cleanName(r.name, path), d = new Node(name, true, o.attrs || 0);
    this.link(r.parent, d, name); this.emit('mkdir', this.pathOf(d));
    return this.info(d);
  }
  rmdir(path, o = {}) {
    const n = this.need(path);
    if (!n.dir) throw new FSError(E.DIRECTORY, path);
    if (!n.parent || n.attrs & ATTR.READONLY) throw new FSError(E.ACCESS_DENIED, path);
    this.writable(n.vol);
    if (n.kids.size && !o.recursive) throw new FSError(E.DIR_NOT_EMPTY, path);
    if (this.busy(n)) throw new FSError(E.SHARING_VIOLATION, path);
    const p = this.pathOf(n); this.detach(n); this.forget(n); this.emit('rmdir', p);
  }
  // ---- file operations
  unlink(path) {
    const n = this.need(path);
    if (n.dir) throw new FSError(E.ACCESS_DENIED, path);
    this.writable(n.vol);
    if (n.attrs & ATTR.READONLY) throw new FSError(E.ACCESS_DENIED, path);
    if (n.opens) throw new FSError(E.SHARING_VIOLATION, path);
    const p = this.pathOf(n); this.detach(n); this.forget(n); this.emit('unlink', p);
  }
  rename(from, to, o = {}) {
    const src = this.need(from), dst = this.locate(to);
    if (!src.parent) throw new FSError(E.ACCESS_DENIED, from);
    if (dst.vol !== src.vol) {
      if (src.dir) throw new FSError(E.NOT_SAME_DEVICE, to);
      this.copy(from, to, { overwrite: o.overwrite }); this.unlink(from); return this.stat(to);
    }
    this.writable(src.vol);
    if (dst.node && dst.node !== src) {
      if (!o.overwrite || dst.node.dir || src.dir) throw new FSError(E.ALREADY_EXISTS, to);
      this.unlink(this.pathOf(dst.node));
    }
    const parent = dst.node === src ? src.parent : dst.parent;
    if (src.dir && this.inside(parent, src)) throw new FSError(E.ACCESS_DENIED, to);
    if (this.busy(src)) throw new FSError(E.SHARING_VIOLATION, from);
    const name = cleanName(dst.node === src ? basename(to.replace(/\//g, '\\')) : dst.name, to);
    const old = this.pathOf(src); this.detach(src); this.link(parent, src, name);
    this.emit('rename', old, this.pathOf(src));
    return this.info(src);
  }
  copy(from, to, o = {}) {
    const src = this.need(from);
    if (src.dir) return this.copyTree(src, to);
    if (src.absent) throw new FSError(E.READ_FAULT, from);
    const dst = this.locate(to); this.writable(dst.vol);
    if (dst.node) {
      if (dst.node === src || dst.node.dir) throw new FSError(E.ACCESS_DENIED, to);
      if (o.overwrite === false) throw new FSError(E.FILE_EXISTS, to);
      if (dst.node.attrs & ATTR.READONLY) throw new FSError(E.ACCESS_DENIED, to);
    }
    const fd = this.open(to, 'w');
    try { this.write(fd, src.buf.subarray(0, src.size)); } finally { this.close(fd); }
    const n = this.need(to); n.mtime = src.mtime; n.attrs = (src.attrs | ATTR.ARCHIVE) & ~ATTR.READONLY | (src.attrs & ATTR.READONLY);
    return this.info(n);
  }
  copyTree(src, to) {
    const dst = this.locate(to);
    if (dst.node) throw new FSError(E.ALREADY_EXISTS, to);
    if (dst.vol === src.vol && this.inside(dst.parent, src)) throw new FSError(E.ACCESS_DENIED, to);
    this.mkdir(to);
    for (const k of [...src.kids.values()]) this.copy(this.pathOf(k), join(to, k.name));
    return this.stat(to);
  }
  setAttrs(path, attrs) {
    const n = this.need(path); this.writable(n.vol);
    n.attrs = (attrs & (ATTR.READONLY | ATTR.HIDDEN | ATTR.SYSTEM | ATTR.ARCHIVE)) | (n.dir ? ATTR.DIRECTORY : 0);
    this.emit('attrib', this.pathOf(n));
  }
  setTimes(path, t) {
    const n = this.need(path); this.writable(n.vol);
    for (const k of ['ctime', 'mtime', 'atime']) if (t[k] !== undefined) n[k] = +t[k];
    this.emit('attrib', this.pathOf(n));
  }
  // ---- handle I/O
  open(path, flags = 'r') {
    const f = FLAGS[flags]; if (!f) throw new FSError(E.INVALID_PARAMETER, flags);
    const r = this.locate(path); let n = r.node, created = false;
    if (n && n.dir) throw new FSError(E.ACCESS_DENIED, path);
    if (n && f.excl) throw new FSError(E.FILE_EXISTS, path);
    if (this.fds.size >= 255) throw new FSError(E.TOO_MANY_OPEN_FILES, path);
    if (!n) {
      if (!f.create) throw new FSError(E.FILE_NOT_FOUND, path);
      this.writable(r.vol);
      const name = cleanName(r.name, path); n = new Node(name, false, ATTR.ARCHIVE); this.link(r.parent, n, name); created = true;
    }
    if (f.write) { this.writable(n.vol); if (n.attrs & ATTR.READONLY) throw new FSError(E.ACCESS_DENIED, path); }
    if (f.read && n.absent) throw new FSError(E.READ_FAULT, path);
    if (f.trunc && n.size) { this.resize(n, 0); n.mtime = Date.now(); }
    const fd = this.nextFd++;
    this.fds.set(fd, { n, pos: f.append ? n.size : 0, read: !!f.read, write: !!f.write, append: !!f.append });
    n.opens++; n.atime = Date.now();
    if (created || f.trunc) this.emit(created ? 'create' : 'write', this.pathOf(n));
    return fd;
  }
  handle(fd) { const h = this.fds.get(fd); if (!h) throw new FSError(E.INVALID_HANDLE, String(fd)); return h; }
  read(fd, len) {
    const h = this.handle(fd), n = h.n;
    if (!h.read) throw new FSError(E.ACCESS_DENIED, this.pathOf(n));
    if (h.pos >= n.size) return new Uint8Array(0);
    const end = len === undefined ? n.size : Math.min(n.size, h.pos + Math.max(0, len));
    const out = n.buf.slice(h.pos, end); h.pos = end; n.atime = Date.now();
    return out;
  }
  write(fd, data) {
    const h = this.handle(fd), n = h.n;
    if (!h.write) throw new FSError(E.ACCESS_DENIED, this.pathOf(n));
    const b = typeof data === 'string' ? encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    if (h.append) h.pos = n.size;
    const end = h.pos + b.length;
    if (end > n.size) this.resize(n, end);
    n.buf.set(b, h.pos); h.pos = end; n.mtime = Date.now(); n.attrs |= ATTR.ARCHIVE;
    this.emit('write', this.pathOf(n));
    return b.length;
  }
  seek(fd, offset, whence = 0) {
    const h = this.handle(fd), base = whence === 1 ? h.pos : whence === 2 ? h.n.size : 0, p = base + offset;
    if (p < 0) throw new FSError(E.NEGATIVE_SEEK, this.pathOf(h.n));
    h.pos = p; return p;
  }
  tell(fd) { return this.handle(fd).pos; }
  truncate(fd, len) {
    const h = this.handle(fd);
    if (!h.write) throw new FSError(E.ACCESS_DENIED, this.pathOf(h.n));
    this.resize(h.n, len === undefined ? h.pos : len); h.n.mtime = Date.now(); this.emit('write', this.pathOf(h.n));
  }
  fstat(fd) { return this.info(this.handle(fd).n); }
  close(fd) { const h = this.handle(fd); this.fds.delete(fd); h.n.opens--; }
  // ---- whole-file helpers
  readFile(path) { const fd = this.open(path, 'r'); try { return this.read(fd); } finally { this.close(fd); } }
  readText(path) { return decode(this.readFile(path)); }
  writeFile(path, data, o = {}) {
    const fd = this.open(path, o.append ? 'a' : 'w');
    try { this.write(fd, data); } finally { this.close(fd); }
  }
  appendFile(path, data) { this.writeFile(path, data, { append: true }); }
  // ---- disk image: one volume's tree, names, attributes, times and bytes, saved and restored across runs
  dump(letter) {
    const v = this.vols.get(letter.toUpperCase()), parts = []; let off = 0;
    const walk = n => {
      const e = [n.name, n.short, n.attrs, n.ctime, n.mtime, n.atime];
      if (n.dir) e.push([...n.kids.values()].map(walk));
      else { e.push(null, off, n.size); parts.push(n.buf.subarray(0, n.size)); off += n.size; }
      return e;
    };
    const r = v.root, meta = new TextEncoder().encode(JSON.stringify({ label: v.label, serial: v.serial,
      times: [r.ctime, r.mtime, r.atime], kids: [...r.kids.values()].map(walk) }));
    const out = new Uint8Array(12 + meta.length + off), dv = new DataView(out.buffer);
    out.set(IMG_MAGIC); dv.setUint32(4, 1, true); dv.setUint32(8, meta.length, true); out.set(meta, 12);
    let at = 12 + meta.length; for (const b of parts) { out.set(b, at); at += b.length; }
    return out;
  }
  restore(letter, img) {
    const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
    if (IMG_MAGIC.some((c, i) => img[i] !== c) || dv.getUint32(4, true) !== 1) throw new FSError(E.INVALID_PARAMETER, letter + ':\\');
    const len = dv.getUint32(8, true), meta = JSON.parse(new TextDecoder().decode(img.subarray(12, 12 + len))), base = 12 + len;
    const v = this.vols.get(letter.toUpperCase()), r = v.root;
    for (const k of r.kids.values()) this.forget(k);
    r.kids.clear(); r.byShort.clear(); v.used = 0;
    const add = (parent, [name, short, attrs, ct, mt, at, kids, o, size]) => {
      const n = new Node(name, !!kids, attrs, ct);
      n.short = short; n.parent = parent; parent.kids.set(name.toUpperCase(), n); parent.byShort.set(short, n);
      if (kids) kids.forEach(k => add(n, k));
      else { n.buf = img.slice(base + o, base + o + size); n.size = size; v.used += v.alloc(size); }
      n.mtime = mt; n.atime = at;
    };
    meta.kids.forEach(k => add(r, k));
    [r.ctime, r.mtime, r.atime] = meta.times; v.label = meta.label; v.serial = meta.serial;
    this.setVol(r, v); this.emit('mount', v.letter + ':\\');
  }
  // ---- bulk load (bypasses read-only so CD images can be populated)
  load(letter, tree) {
    const v = this.vols.get(letter.toUpperCase());
    const add = (parent, e) => {
      const [name, t, kids, size, bytes] = e, dir = Array.isArray(kids);
      const n = new Node(name, dir, dir ? 0 : ATTR.READONLY, t);
      this.link(parent, n, name); n.ctime = n.mtime = n.atime = t;
      if (dir) { kids.forEach(k => add(n, k)); n.mtime = t; }
      else if (bytes) { n.buf = bytes; n.size = bytes.length; v.used += v.alloc(n.size); }
      else { n.size = size; n.absent = true; v.used += v.alloc(size); }
    };
    tree.forEach(e => add(v.root, e));
    if (v.readonly) v.total = Math.max(v.total, v.used);
    this.emit('mount', v.letter + ':\\');
  }
}

window.W95FS = { FileSystem, FSError, E, ATTR, encode, decode, join, basename, dirname, extname, is83 };
})();
