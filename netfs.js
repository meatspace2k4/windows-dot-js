'use strict';
// A network drive's files, for fs.js: each operation is the INT 21h call Windows 95's KERNEL32 makes for it (the long
// file name API), run in the network's process through the file system manager's handler, which gives it to the
// redirector (VREDIR) for a drive it has connected. Paths and data pass through the process's transfer area.
(function () {
const { FSError } = window.W95FS;
const XFER_PATH = 0, XFER_PATH2 = 0x200, XFER_FIND = 0x400, XFER_DATA = 0x1000, CHUNK = 0xf000;
const ATTR_ALL = 0x37;   // read-only, hidden, system, directory, archive: everything a search can find
const fromFileTime = (lo, hi) => (lo === 0 && hi === 0 ? 0 : Math.round((hi * 4294967296 + lo) / 10000 - 11644473600000));
const dosDT = ms => { const d = new Date(ms), y = Math.max(1980, d.getFullYear());
  return { date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) }; };

/** the backend of drive `letter`, connected in `app`'s process (the network's) */
function backend(app, letter) {
  const proc = () => { if (!app.alive || !app.proc) throw new FSError(21, letter + ':\\'); return app.proc; };
  const full = rel => letter + ':\\' + rel;
  // INT 21h: the registers, DS and ES the transfer area; an FSError with DOS's code when it sets carry
  const int21 = (regs, what) => {
    const p = proc(), r = p.vmInt21(regs);
    if (r.cf) throw new FSError(r.eax & 0xffff, what || letter + ':\\');
    return r;
  };
  const put = (off, s) => { const p = proc(), x = p.vmXfer(); p.writeA(x.lin + off, s, 0x200); };
  const entry = () => {   // WIN32_FIND_DATA at XFER_FIND (times as FILETIMEs)
    const p = proc(), a = p.vmXfer().lin + XFER_FIND, attrs = p.r32(a);
    return { attrs: attrs & 0x27, dir: !!(attrs & 0x10), ctime: fromFileTime(p.r32(a + 4), p.r32(a + 8)), atime: fromFileTime(p.r32(a + 0xc), p.r32(a + 0x10)),
      mtime: fromFileTime(p.r32(a + 0x14), p.r32(a + 0x18)), size: p.r32(a + 0x20), name: p.readA(a + 0x2c, 260), short: p.readA(a + 0x130, 14) || '' };
  };
  // a search: 714Eh (DS:DX the pattern, ES:DI the data, SI 0 FILETIMEs), 714Fh the next, 71A1h the end of it
  const search = (pattern, first) => {
    put(XFER_PATH, pattern);
    let r; try { r = int21({ eax: 0x714e, ecx: ATTR_ALL, edx: XFER_PATH, esi: 0, edi: XFER_FIND }, pattern); }
    catch (e) { if ([2, 3, 18].includes(e.code)) return []; throw e; }
    const h = r.eax & 0xffff, out = [entry()];
    try { while (!first) { try { int21({ eax: 0x714f, ebx: h, esi: 0, edi: XFER_FIND }); } catch (e) { if (e.code === 18) break; throw e; } out.push(entry()); } }
    finally { try { int21({ eax: 0x71a1, ebx: h }); } catch (_) { /* closed with the search */ } }
    return out;
  };
  const seek = (h, pos) => int21({ eax: 0x4200, ebx: h, ecx: (pos / 65536) >>> 0, edx: pos & 0xffff });
  return {
    stat: rel => { if (!rel) return { dir: true, size: 0, attrs: 0x10, ctime: 0, mtime: 0, atime: 0, name: '' }; return search(full(rel), true)[0] || null; },
    list: rel => search(full(rel ? rel + '\\*.*' : '*.*'), false),
    // 716Ch: BX the access (0 read, 1 write, 2 both) with sharing allowed, CX the attributes, DX what to do (low
    // nibble with a file that is there: 1 open, 2 truncate; high nibble without one: 1 create), DS:SI the name
    open: (rel, f) => {
      put(XFER_PATH, full(rel));
      const access = f.read && f.write ? 2 : f.write ? 1 : 0, action = (f.create ? 0x10 : 0) | (f.trunc ? 2 : 1);
      return int21({ eax: 0x716c, ebx: 0x40 | access, ecx: 0x20, edx: action, esi: XFER_PATH }, full(rel)).eax & 0xffff;
    },
    read: (h, pos, n) => {
      const p = proc(), out = new Uint8Array(n); let got = 0;
      seek(h, pos);
      while (got < n) {
        const want = Math.min(CHUNK, n - got), k = int21({ eax: 0x3f00, ebx: h, ecx: want, edx: XFER_DATA }).eax & 0xffff;
        out.set(p.u8.subarray(p.vmXfer().lin + XFER_DATA, p.vmXfer().lin + XFER_DATA + k), got); got += k;
        if (k < want) break;   // the end of the file
      }
      return out.subarray(0, got);
    },
    write: (h, pos, b) => {
      const p = proc(); seek(h, pos);
      for (let at = 0; at < b.length; at += CHUNK) {
        const piece = b.subarray(at, at + CHUNK); p.u8.set(piece, p.vmXfer().lin + XFER_DATA);
        int21({ eax: 0x4000, ebx: h, ecx: piece.length, edx: XFER_DATA });
      }
    },
    truncate: (h, n) => { seek(h, n); int21({ eax: 0x4000, ebx: h, ecx: 0, edx: XFER_DATA }); },   // a write of nothing ends the file there
    size: h => { const r = int21({ eax: 0x4202, ebx: h, ecx: 0, edx: 0 }); return ((r.edx & 0xffff) * 65536 + (r.eax & 0xffff)) >>> 0; },
    close: h => { try { int21({ eax: 0x3e00, ebx: h }); } catch (_) { /* the connection may have gone */ } },
    mkdir: rel => { put(XFER_PATH, full(rel)); int21({ eax: 0x7139, edx: XFER_PATH }, full(rel)); },
    rmdir: rel => { put(XFER_PATH, full(rel)); int21({ eax: 0x713a, edx: XFER_PATH }, full(rel)); },
    unlink: rel => { put(XFER_PATH, full(rel)); int21({ eax: 0x7141, edx: XFER_PATH, esi: 0 }, full(rel)); },
    rename: (a, b) => { put(XFER_PATH, full(a)); put(XFER_PATH2, full(b)); int21({ eax: 0x7156, edx: XFER_PATH, edi: XFER_PATH2 }, full(a)); },
    setAttrs: (rel, attrs) => { put(XFER_PATH, full(rel)); int21({ eax: 0x7143, ebx: 1, ecx: attrs, edx: XFER_PATH }, full(rel)); },
    setTime: (rel, ms) => { const t = dosDT(ms); put(XFER_PATH, full(rel)); int21({ eax: 0x7143, ebx: 3, ecx: t.time, edi: t.date, edx: XFER_PATH }, full(rel)); },
    // 36h: AX sectors a cluster, BX clusters free, CX bytes a sector, DX clusters (DL the drive, 1 for A:)
    space: () => { const r = int21({ eax: 0x3600, edx: letter.charCodeAt(0) - 64 }); const c = (r.eax & 0xffff) * (r.ecx & 0xffff); return { total: c * (r.edx & 0xffff), free: c * (r.ebx & 0xffff) }; },
  };
}
window.W95NetFS = { backend };
})();
