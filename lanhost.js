'use strict';
// The other computer on the Ethernet segment (lan.js): a station that speaks what Windows 95's NetBEUI and its
// redirector speak, and serves folders the host gives it as shares. It is the far end of the wire, as a file server on
// a real LAN is: NetBIOS Frames (name queries, sessions, data, over LLC type 2 links) and SMB, the LAN Manager 2.1
// dialect, with share-level access. Its shares come from the host (window.W95HOST.shares in the app: folders of the
// Mac; a page without one gets none) through a small file interface (see shareOps).
(function () {
const LAN = window.W95LAN;
const enc = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
const dec = (b, o = 0, n = b.length - o) => { let s = ''; for (let i = o; i < o + n && b[i]; i++) s += String.fromCharCode(b[i]); return s; };
const nbName = (s, t) => { const b = new Uint8Array(16).fill(0x20); b.set(enc(s.toUpperCase().slice(0, 15))); b[15] = t; return b; };
const sameName = (a, ao, b) => { for (let i = 0; i < 16; i++) if (a[ao + i] !== b[i]) return false; return true; };
const le16 = (b, o) => b[o] | (b[o + 1] << 8), le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// ---------------------------------------------------------------- the station
const MAC = Uint8Array.from([0x02, 0x00, 0x4c, 0x41, 0x4e, 0x01]);
const NETBIOS_FUNCTIONAL = [0x03, 0x00, 0x00, 0x00, 0x00, 0x01];
const host = window.W95LANHOST = {
  name: ((window.W95HOST && window.W95HOST.computerName) || 'HOST').toUpperCase().replace(/[^A-Z0-9!@#$%^&()\-_'{}.~]/g, '').slice(0, 15) || 'HOST',
  workgroup: 'WORKGROUP', mac: MAC, links: new Map(), trace: null,
};
const names = () => [nbName(host.name, 0x20), nbName(host.name, 0x00), nbName(host.name, 0x03)];

const frame = (dst, llc, payload) => {
  const f = new Uint8Array(14 + llc.length + payload.length);
  f.set(dst, 0); f.set(MAC, 6); const len = llc.length + payload.length; f[12] = len >> 8; f[13] = len & 0xff;
  f.set(llc, 14); f.set(payload, 14 + llc.length);
  return f;
};
const send = f => LAN.send(station, f.length < 60 ? (() => { const g = new Uint8Array(60); g.set(f); return g; })() : f);
// NetBIOS headers: the 44-byte one of UI frames (names), the 14-byte one of a session's I frames
const uiHeader = (cmd, d1, d2, xc, rc, dst, src) => {
  const h = new Uint8Array(44); h[0] = 44; h[2] = 0xff; h[3] = 0xef; h[4] = cmd; h[5] = d1; h[6] = d2 & 0xff; h[7] = d2 >> 8;
  h[8] = xc & 0xff; h[9] = xc >> 8; h[10] = rc & 0xff; h[11] = rc >> 8; h.set(dst, 12); h.set(src, 28); return h;
};
const iHeader = (cmd, d1, d2, xc, rc, dnum, snum) => {
  const h = new Uint8Array(14); h[0] = 14; h[2] = 0xff; h[3] = 0xef; h[4] = cmd; h[5] = d1; h[6] = d2 & 0xff; h[7] = d2 >> 8;
  h[8] = xc & 0xff; h[9] = xc >> 8; h[10] = rc & 0xff; h[11] = rc >> 8; h[12] = dnum; h[13] = snum; return h;
};
const NB = { ADD_GROUP_NAME_QUERY: 0, ADD_NAME_QUERY: 1, NAME_IN_CONFLICT: 2, STATUS_QUERY: 3, DATAGRAM: 8, DATAGRAM_BROADCAST: 9,
  NAME_QUERY: 0x0a, ADD_NAME_RESPONSE: 0x0d, NAME_RECOGNIZED: 0x0e, STATUS_RESPONSE: 0x0f, DATA_ACK: 0x14, DATA_FIRST_MIDDLE: 0x15,
  DATA_ONLY_LAST: 0x16, SESSION_CONFIRM: 0x17, SESSION_END: 0x18, SESSION_INITIALIZE: 0x19, NO_RECEIVE: 0x1a,
  RECEIVE_OUTSTANDING: 0x1b, RECEIVE_CONTINUE: 0x1c, SESSION_ALIVE: 0x1f };
let corr = 1;
const nextCorr = () => (corr = (corr % 0xfffe) + 1);

// frames from the segment
const station = { mac: MAC, rx: f => { try { receive(f); } catch (e) { console.error('[lanhost]', e); } } };
LAN.attach(station);
function receive(f) {
  const d = f.subarray(0, 6), mine = d.every((x, i) => x === MAC[i]), func = d.every((x, i) => x === NETBIOS_FUNCTIONAL[i]), bcast = d.every(x => x === 0xff);
  if (!mine && !func && !bcast) return;
  const len = (f[12] << 8) | f[13]; if (len > 1500) return;   // 802.3 frames only (NetBEUI's)
  const llc = f.subarray(14, 14 + len); if (llc[0] !== 0xf0 && llc[0] !== 0xff) return;
  const src = f.slice(6, 12), c0 = llc[1] & 1 ? 'resp' : 'cmd', ctl = llc[2];
  if (host.trace) host.trace('rx', f);
  if ((ctl & 3) === 3) {   // U frame
    const u = ctl & ~0x10, pf = ctl & 0x10;
    if (u === 0x03) return ui(src, llc.subarray(3));
    if (u === 0x6f) return linkUp(src, pf);                       // SABME
    if (u === 0x43) return linkDown(src, pf);                     // DISC
    if (u === 0xaf || u === 0xe3) return send(frame(src, [0xf0, 0xf1, ctl], llc.subarray(3)));   // XID / TEST: echoed
    return;
  }
  const l = host.links.get(key(src)); if (!l) { send(frame(src, [0xf0, 0xf1, 0x1f], [])); return; }   // DM
  if ((ctl & 1) === 0) return iFrame(l, llc, c0);
  sFrame(l, llc, c0);
}
const key = mac => [...mac].join(':');

// ---------------------------------------------------------------- names and datagrams
function ui(src, nb) {
  if (nb.length < 44 || nb[2] !== 0xff || nb[3] !== 0xef) return;
  const cmd = nb[4], d2 = le16(nb, 6), xc = le16(nb, 8), rc = le16(nb, 10);
  if (cmd === NB.NAME_QUERY) {
    const n = names().find(x => sameName(nb, 12, x)); if (!n) return;
    // a session is wanted (the caller's session number in DATA2's low byte): ours is the link's next free one. The
    // answer carries the query's response correlator as its own transmit correlator, and a new response correlator
    // the caller's SESSION_INITIALIZE returns
    const want = d2 & 0xff, l = want ? linkFor(src) : null;
    let lsn = 0;
    if (l) { const same = [...l.pending].find(([, v]) => v.remote === want && v.qc === rc); lsn = same ? same[0] : l.nextLsn(); if (!same) l.pending.set(lsn, { remote: want, name: nb.slice(28, 44), corr: nextCorr(), qc: rc }); }
    const h = uiHeader(NB.NAME_RECOGNIZED, 0, lsn, rc, l ? l.pending.get(lsn).corr : 0, nb.subarray(28, 44), n);
    send(frame(src, [0xf0, 0xf0, 0x03], h));
    return;
  }
  if (cmd === NB.ADD_NAME_QUERY || cmd === NB.ADD_GROUP_NAME_QUERY) {   // someone taking one of our names: ours stands
    const n = names().find(x => sameName(nb, 28, x)); if (!n) return;
    send(frame(src, [0xf0, 0xf0, 0x03], uiHeader(NB.ADD_NAME_RESPONSE, 0, 0, 0, xc, n, n)));
    return;
  }
  if (cmd === NB.DATAGRAM || cmd === NB.DATAGRAM_BROADCAST) { if (host.datagram) host.datagram(src, nb.slice(28, 44), nb.slice(12, 28), nb.subarray(44)); }
}

// ---- the browser: this computer is the workgroup's master browser (WORKGROUP<1D>) and its only backup. A
// GetBackupListRequest (opcode 9: count, token) on \MAILSLOT\BROWSE is answered with a GetBackupListResponse (10:
// count, token, the backups' names) to the asker's name, as a mailslot write in a datagram; the asker then reads the
// list of computers from a backup with NetServerEnum2 (see trans)
const BROWSE = '\\MAILSLOT\\BROWSE';
host.datagram = function (src, from, to, smb) {
  if (smb.length < 36 || smb[0] !== 0xff || smb[1] !== 0x53 || smb[4] !== 0x25) return;   // a TRANSACTION
  const wc = smb[32], w = i => le16(smb, 33 + 2 * i); if (wc < 17) return;
  const name = dec(smb, 33 + 2 * wc + 2), data = smb.subarray(w(12), w(12) + w(11));
  if (name.toUpperCase() !== BROWSE || !data.length) return;
  const toWorkgroup = sameName(to, 0, nbName(host.workgroup, 0x1d)) || sameName(to, 0, nbName(host.workgroup, 0x1b));
  if (data[0] === 9 && toWorkgroup) mailslot(src, from, BROWSE, concat([10, 1], data.subarray(2, 6), enc(host.name), [0]));
};
// a mailslot write (TRANSACTION, setup: 1 write, priority 1, class 2 unreliable) in a datagram to `toName`
function mailslot(mac, toName, slot, data) {
  const nm = concat(enc(slot), [0]), wc = 17, words = 33 + 2 * wc, dataOff = words + 2 + nm.length;
  const h = new Uint8Array(32); h.set([0xff, 0x53, 0x4d, 0x42, 0x25]);
  const p = concat(h, [wc], u16(0), u16(data.length), u16(0), u16(0), [0, 0], u16(0), u32b(0), u16(0), u16(0), u16(dataOff), u16(data.length), u16(dataOff),
    [3, 0], u16(1), u16(1), u16(2), u16(nm.length + data.length), nm, data);
  send(frame(mac, [0xf0, 0xf0, 0x03], concat(uiHeader(NB.DATAGRAM, 0, 0, 0, 0, toName, nbName(host.name, 0x00)), p)));
}

// ---------------------------------------------------------------- LLC type 2 links
// one per remote station: V(S) and V(R), the I frames sent and not yet acknowledged, the NetBIOS sessions on it
class Link {
  constructor(mac) { this.mac = mac; this.vs = 0; this.vr = 0; this.unacked = []; this.sessions = new Map(); this.pending = new Map(); this.lsn = 0; this.up = false; }
  nextLsn() { do { this.lsn = (this.lsn % 254) + 1; } while (this.sessions.has(this.lsn) || this.pending.has(this.lsn)); return this.lsn; }
  sendI(payload) {
    const llc = [0xf0, 0xf0, this.vs << 1, this.vr << 1];
    const f = frame(this.mac, llc, payload); this.unacked.push({ ns: this.vs, f }); this.vs = (this.vs + 1) & 0x7f;
    send(f);
  }
  ack(nr) { while (this.unacked.length && ((nr - this.unacked[0].ns - 1) & 0x7f) < 0x40) this.unacked.shift(); }
  rr(final) { send(frame(this.mac, [0xf0, final ? 0xf1 : 0xf0, 0x01, (this.vr << 1) | (final ? 1 : 0)], [])); }
}
const linkFor = mac => { const k = key(mac); if (!host.links.has(k)) host.links.set(k, new Link(mac)); return host.links.get(k); };
function linkUp(src, pf) {
  const l = linkFor(src); l.vs = l.vr = 0; l.unacked = []; l.up = true;
  send(frame(src, [0xf0, 0xf1, 0x63 | (pf ? 0x10 : 0)], []));   // UA
}
function linkDown(src, pf) {
  const l = host.links.get(key(src)); if (l) { for (const s of l.sessions.values()) s.end(); host.links.delete(key(src)); }
  send(frame(src, [0xf0, 0xf1, 0x63 | (pf ? 0x10 : 0)], []));
}
function sFrame(l, llc, c) {
  const kind = llc[2] & 0x0c, nr = llc[3] >> 1, pf = llc[3] & 1;
  l.ack(nr);
  if (kind === 0x08) { const again = l.unacked.splice(0); for (const u of again) send(u.f); l.unacked = again; }   // REJ: resent from N(R)
  if (c === 'cmd' && pf) l.rr(true);   // a poll: answered with our V(R)
}
function iFrame(l, llc, c) {
  const ns = llc[2] >> 1, nr = llc[3] >> 1, pf = llc[3] & 1;
  l.ack(nr);
  if (ns !== l.vr) { send(frame(l.mac, [0xf0, 0xf1, 0x09, (l.vr << 1) | pf], [])); return; }   // out of sequence: REJ
  l.vr = (l.vr + 1) & 0x7f;
  const before = l.vs;
  session(l, llc.subarray(4));
  if (c === 'cmd' && pf) l.rr(true);
  else if (l.vs === before) l.rr(false);   // nothing sent back carried the acknowledgement
}

// ---------------------------------------------------------------- NetBIOS sessions
const MAX_DATA = 1500 - 4 - 14;
class Session {
  constructor(l, lsn, rsn) { this.l = l; this.lsn = lsn; this.rsn = rsn; this.rx = []; this.smb = new SmbConnection(this); }
  send(cmd, d1, d2, xc, rc, data) { this.l.sendI(data ? concat(iHeader(cmd, d1, d2, xc, rc, this.rsn, this.lsn), data) : iHeader(cmd, d1, d2, xc, rc, this.rsn, this.lsn)); }
  // a message: DATA_FIRST_MIDDLE pieces then DATA_ONLY_LAST, the last asking no acknowledgement
  message(b) {
    for (let at = 0; ; at += MAX_DATA) {
      const piece = b.subarray(at, at + MAX_DATA), last = at + MAX_DATA >= b.length;
      if (last) { this.send(NB.DATA_ONLY_LAST, 0x02, 0, nextCorr(), 0, piece); break; }   // DOL_OPTIONS_NO_ACK
      this.send(NB.DATA_FIRST_MIDDLE, 0, 0, nextCorr(), 0, piece);
    }
  }
  end() { this.l.sessions.delete(this.lsn); }
}
const concat = (...p) => { const n = p.reduce((t, x) => t + x.length, 0), o = new Uint8Array(n); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
function session(l, nb) {
  if (nb.length < 14 || nb[2] !== 0xff || nb[3] !== 0xef) return;
  const cmd = nb[4], d1 = nb[5], d2 = le16(nb, 6), xc = le16(nb, 8), rc = le16(nb, 10), dnum = nb[12], snum = nb[13];
  if (cmd === NB.SESSION_INITIALIZE) {
    const p = l.pending.get(dnum); if (!p) return;
    l.pending.delete(dnum);
    const s = new Session(l, dnum, snum); l.sessions.set(dnum, s);
    // SESSION_CONFIRM: version 2.0 (bit 0 of DATA1), the largest frame we take
    s.send(NB.SESSION_CONFIRM, 0x01, MAX_DATA, 0, xc);
    return;
  }
  const s = l.sessions.get(dnum); if (!s) return;
  const data = nb.subarray(14);
  switch (cmd) {
    case NB.DATA_FIRST_MIDDLE:
      s.rx.push(data.slice());
      if (d1 & 0x02 && s.rx.length === 1) s.send(NB.RECEIVE_CONTINUE, 0, 0, 0, xc);   // DFM_OPTIONS_RECEIVE_CONTINUE
      return;
    case NB.DATA_ONLY_LAST: {
      s.rx.push(data.slice());
      const msg = concat(...s.rx); s.rx = [];
      if (!(d1 & 0x02)) s.send(NB.DATA_ACK, 0, 0, 0, xc);   // not DOL_OPTIONS_NO_ACK: acknowledged
      const reply = s.smb.message(msg);
      if (reply) s.message(reply);
      return;
    }
    case NB.SESSION_END: s.end(); return;
    case NB.SESSION_ALIVE: case NB.DATA_ACK: case NB.RECEIVE_CONTINUE: case NB.NO_RECEIVE: case NB.RECEIVE_OUTSTANDING: return;
  }
}

// ---------------------------------------------------------------- SMB (LAN Manager 2.1)
// the shares: the host's folders (name -> share operations), and IPC$ for the LAN Manager remote API
const shareList = () => {
  const h = window.W95HOST && window.W95HOST.shares;
  return h ? h.list().map(s => ({ name: s.name.toUpperCase(), remark: s.remark || '', ops: shareOps(s.name) })) : (host.shares || []);
};
// a share's file operations, on paths relative to its root with backslashes: stat(p) -> {dir, size, mtime, ctime, atime,
// readonly} or null; list(p) -> [{name, ...stat}]; read(p, off, n) -> bytes; write(p, off, bytes); truncate(p, n);
// create(p, excl); mkdir(p); rmdir(p); unlink(p); rename(a, b); times(p, mtime); space() -> {total, free}
const shareOps = name => {
  const h = window.W95HOST.shares, f = (op, ...a) => { const r = h.op(name, op, ...a); if (r && r.err) throw Object.assign(new Error(r.err), { code: r.err }); return r ? r.ok : undefined; };
  return { stat: p => f('stat', p), list: p => f('list', p), read: (p, o, n) => f('read', p, o, n), write: (p, o, b) => f('write', p, o, b),
    truncate: (p, n) => f('truncate', p, n), create: (p, x) => f('create', p, x), mkdir: p => f('mkdir', p), rmdir: p => f('rmdir', p),
    unlink: p => f('unlink', p), rename: (a, b) => f('rename', a, b), times: (p, t) => f('times', p, t), space: () => f('space', '') };
};
host.shareList = shareList;

const ERR = { DOS: 1, SRV: 2 }, E = { badfunc: 1, badfile: 2, badpath: 3, nofids: 4, noaccess: 5, badfid: 6, nofiles: 18, filexists: 80, badshare: 32, dirnotempty: 145,
  invnetname: 6, invtid: 5, baduid: 91, nosupport: 0xffff };
class SmbError extends Error { constructor(cls, code) { super(`SMB error ${cls}/${code}`); this.cls = cls; this.code = code; } }
const fail = (cls, code) => { throw new SmbError(cls, code); };
const hostError = e => { const m = /^E(\w+)/.exec((e && (e.code || e.message)) || ''); const c = m ? m[1] : '';
  return c === 'NOENT' ? new SmbError(ERR.DOS, E.badfile) : c === 'NOTDIR' ? new SmbError(ERR.DOS, E.badpath) : c === 'EXIST' ? new SmbError(ERR.DOS, E.filexists)
    : c === 'NOTEMPTY' ? new SmbError(ERR.DOS, E.dirnotempty) : c === 'ACCES' || c === 'PERM' ? new SmbError(ERR.DOS, E.noaccess) : new SmbError(ERR.DOS, E.noaccess); };

// DOS dates and times, and LAN Manager's seconds since 1970 (local time)
const dosDT = ms => { const d = new Date(ms || 0), y = Math.max(1980, d.getFullYear());
  return { date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) }; };
const fromDos = (date, time) => new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
const utime = ms => Math.max(0, Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 1000));
const ATTR = { RO: 1, HIDDEN: 2, SYSTEM: 4, DIR: 0x10, ARCHIVE: 0x20 };
const attrsOf = st => (st.dir ? ATTR.DIR : ATTR.ARCHIVE) | (st.readonly ? ATTR.RO : 0) | (st.hidden ? ATTR.HIDDEN : 0);
// a DOS pattern (* and ?, *.* everything) as a test on long names
const wild = p => { if (!p || p === '*' || p === '*.*') return () => true; const r = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + (p.includes('.') ? '' : '(\\..*)?') + '$', 'i'); return n => r.test(n); };
// a core search's pattern against an 8.3 name as DOS compares them: both as 11-character FCB fields (name and
// extension padded with spaces), '?' any character there including the padding, '*' the rest of its field as '?'
const fcb = (n, pat) => {
  const dot = n.lastIndexOf('.'), base = dot >= 0 && n !== '.' && n !== '..' ? n.slice(0, dot) : n, ext = dot >= 0 && n !== '.' && n !== '..' ? n.slice(dot + 1) : '';
  const field = (f, w) => { let o = ''; for (const c of f.toUpperCase()) { if (o.length >= w) break; if (pat && c === '*') { o = o.padEnd(w, '?'); break; } o += c; } return o.padEnd(w, ' ').slice(0, w); };
  return field(base, 8) + field(ext, 3);
};
const match83 = (pat, name) => { if (!pat || pat === '*.*' || pat === '*') return true; const p = fcb(pat, true), n = fcb(name, false); for (let i = 0; i < 11; i++) if (p[i] !== '?' && p[i] !== n[i]) return false; return true; };
// 8.3 aliases for the core protocol's searches, as a FAT volume would give them (NAME~1.EXT)
const short83 = (name, taken) => {
  const up = name.toUpperCase(), m = /^([^.]{1,8})(?:\.([^.]{0,3}))?$/.exec(up);
  if (m && !/[ +,;=[\]]/.test(up) && !taken.has(up)) return up;
  const dot = up.lastIndexOf('.'), base = (dot > 0 ? up.slice(0, dot) : up).replace(/[^A-Z0-9_$~!#%&\-{}()@'`^]/g, '') || '_', ext = dot > 0 ? up.slice(dot + 1).replace(/[^A-Z0-9_$~!#%&\-{}()@'`^]/g, '').slice(0, 3) : '';
  for (let i = 1; ; i++) { const t = '~' + i, s = base.slice(0, 8 - t.length) + t + (ext ? '.' + ext : ''); if (!taken.has(s)) return s; }
};

class SmbConnection {
  constructor(s) { this.s = s; this.trees = new Map(); this.files = new Map(); this.searches = new Map(); this.nextTid = 1; this.nextFid = 1; this.nextSid = 1; this.uid = 0x0800; }
  message(m) {
    if (m.length < 33 || m[0] !== 0xff || m[1] !== 0x53 || m[2] !== 0x4d || m[3] !== 0x42) return null;
    const out = new Out(m);
    let cmd = m[4], at = 32;
    for (let guard = 0; cmd !== 0xff && guard < 8; guard++) {
      const wc = m[at], words = m.subarray(at + 1, at + 1 + 2 * wc), bc = le16(m, at + 1 + 2 * wc), bytes = m.subarray(at + 3 + 2 * wc, at + 3 + 2 * wc + bc);
      const req = { m, cmd, wc, w: i => le16(words, 2 * i), d: i => le32(words, 2 * i), words, bytes, bytesAt: at + 3 + 2 * wc, tid: le16(m, 24), pid: le16(m, 26), uid: le16(m, 28), mid: le16(m, 30), flags2: le16(m, 10) };
      const andx = ANDX.has(cmd) && wc ? words[0] : 0xff, andxOff = ANDX.has(cmd) && wc ? le16(words, 2) : 0;
      if (host.smbTrace) host.smbTrace(cmd, req);
      try { out.begin(cmd); this.handle(req, out); }
      catch (e) {
        if (!(e instanceof SmbError)) { console.error('[lanhost] SMB', cmd.toString(16), e); e = new SmbError(ERR.SRV, 1); }
        if (host.smbTrace) host.smbTrace(cmd, req, e);
        out.error(e.cls, e.code); break;
      }
      if (andx === 0xff) break;
      cmd = andx; at = andxOff;
    }
    return out.done();
  }
  tree(req) { const t = this.trees.get(req.tid); if (!t) fail(ERR.SRV, E.invtid); return t; }
  file(fid) { const f = this.files.get(fid); if (!f) fail(ERR.DOS, E.badfid); return f; }
  path(req, raw) {   // a share-relative path, without its leading backslash, with no way above the root
    const parts = []; for (const seg of raw.replace(/\//g, '\\').split('\\')) { if (!seg || seg === '.') continue; if (seg === '..') { if (!parts.length) fail(ERR.DOS, E.noaccess); parts.pop(); } else parts.push(seg); }
    return parts.join('\\');
  }
  op(t, fn) { try { return fn(t.ops); } catch (e) { if (e instanceof SmbError) throw e; throw hostError(e); } }
  handle(q, o) {
    const H = HANDLERS[q.cmd]; if (!H) fail(ERR.SRV, E.nosupport);
    H.call(this, q, o);
  }
}
const ANDX = new Set([0x73, 0x75, 0x74, 0x2d, 0x2e, 0x2f, 0x24]);
// a response: the header copied from the request with the reply bit, then each (AndX-chained) command's words and bytes
class Out {
  constructor(m) { this.parts = [m.slice(0, 32)]; this.len = 32; this.h = this.parts[0]; this.h[9] = 0x80 | 0x08 | (this.h[9] & 0x10); this.lastAndx = -1; this.patch = []; }
  begin(cmd) { this.cmd = cmd; }
  put(words, bytes = new Uint8Array(0), andx) {
    const wc = words.length, b = new Uint8Array(1 + 2 * wc + 2 + bytes.length);
    b[0] = wc; words.forEach((v, i) => { b[1 + 2 * i] = v & 0xff; b[2 + 2 * i] = (v >> 8) & 0xff; });
    b[1 + 2 * wc] = bytes.length & 0xff; b[2 + 2 * wc] = bytes.length >> 8; b.set(bytes, 3 + 2 * wc);
    if (this.lastAndx >= 0) this.patch.push([this.lastAndx, this.cmd, this.len]);   // the previous command's AndX names this one
    this.lastAndx = andx ? this.len + 1 : -1;
    this.parts.push(b); this.len += b.length;
  }
  error(cls, code) { this.h[5] = cls; this.h[6] = 0; this.h[7] = code & 0xff; this.h[8] = code >> 8; if (this.len === 32) this.put([]); }
  done() {
    const m = concat(...this.parts);
    for (const [at, cmd, off] of this.patch) { m[at] = cmd; m[at + 1] = 0; m[at + 2] = off & 0xff; m[at + 3] = off >> 8; }
    if (this.lastAndx >= 0) { m[this.lastAndx] = 0xff; m[this.lastAndx + 1] = 0; m[this.lastAndx + 2] = 0; m[this.lastAndx + 3] = 0; }
    return m;
  }
}
const W = (...v) => v;
const str = (...s) => concat(...s.map(x => (typeof x === 'string' ? concat(enc(x), [0]) : x)));
const u16 = v => [v & 0xff, (v >> 8) & 0xff], u32b = v => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

const DIALECT = 'DOS LANMAN2.1', MAXBUF = 4356;
const HANDLERS = {
  // NEGOTIATE: the LAN Manager 2.1 dialect, share-level security, no encryption
  0x72(q, o) {
    const list = []; for (let i = 0; i < q.bytes.length;) { if (q.bytes[i] !== 2) break; const s = dec(q.bytes, i + 1); list.push(s); i += s.length + 2; }
    let idx = list.indexOf(DIALECT); if (idx < 0) idx = list.indexOf('LANMAN2.1'); if (idx < 0) idx = list.indexOf('LM1.2X002');
    if (idx < 0) { o.put(W(0xffff)); return; }
    const t = dosDT(Date.now());
    o.put(W(idx, 0, MAXBUF, 16, 1, 0, 0, 0, t.time, t.date, new Date().getTimezoneOffset() & 0xffff, 0, 0), str(host.workgroup));
  },
  // SESSION_SETUP_ANDX: anyone (share-level); the account is not checked
  0x73(q, o) { o.put(W(0xff, 0, 0), str('Windows 95', 'Windows 95', host.workgroup), true); },
  0x74(q, o) { o.put(W(0xff, 0), undefined, true); },   // LOGOFF_ANDX
  // TREE_CONNECT_ANDX: \\HOST\SHARE (a host folder, A: service) or IPC$ (the remote API)
  0x75(q, o) {
    const pw = q.w(3), p = dec(q.bytes, pw), svc = dec(q.bytes, pw + p.length + 1), share = p.replace(/^\\\\[^\\]*\\/, '').toUpperCase();
    let t;
    if (share === 'IPC$') t = { ipc: true, name: 'IPC$' };
    else { const s = shareList().find(x => x.name === share); if (!s) fail(ERR.SRV, E.invnetname); t = { name: s.name, ops: s.ops }; }
    if (!t.ipc && svc === 'IPC') fail(ERR.SRV, E.invnetname);
    const tid = this.nextTid++; this.trees.set(tid, t); o.h[24] = tid & 0xff; o.h[25] = tid >> 8;
    o.put(W(0xff, 0, 1), str(t.ipc ? 'IPC' : 'A:', t.ipc ? '' : 'NTFS'), true);   // a file system with long names
  },
  0x71(q, o) { this.trees.delete(q.tid); o.put(W()); },   // TREE_DISCONNECT
  0x2b(q, o) { o.put(W(1), q.bytes.slice()); },        // ECHO
  // QUERY_INFORMATION_DISK: the folder's disk as 32 KB units of 64 512-byte blocks
  0x80(q, o) { const t = this.tree(q); const sp = this.op(t, x => x.space()) || { total: 0, free: 0 }, u = 64 * 512; o.put(W(Math.min(0xffff, Math.floor(sp.total / u)), 64, 512, Math.min(0xffff, Math.floor(sp.free / u)), 0)); },
  0x10(q, o) { const t = this.tree(q), p = this.path(q, dec(q.bytes, 1)), st = this.op(t, x => x.stat(p)); if (!st || !st.dir) fail(ERR.DOS, E.badpath); o.put(W()); },   // CHECK_DIRECTORY
  0x08(q, o) {   // QUERY_INFORMATION
    const t = this.tree(q), p = this.path(q, dec(q.bytes, 1)), st = p ? this.op(t, x => x.stat(p)) : { dir: true, size: 0, mtime: Date.now() };
    if (!st) fail(ERR.DOS, E.badfile);
    const ut = utime(st.mtime); o.put(W(attrsOf(st), ut & 0xffff, ut >>> 16, st.dir ? 0 : st.size & 0xffff, st.dir ? 0 : st.size >>> 16, 0, 0, 0, 0, 0));
  },
  0x09(q, o) { const t = this.tree(q), p = this.path(q, dec(q.bytes, 1)), ut = q.d(1); if (ut) this.op(t, x => x.times(p, (ut + new Date().getTimezoneOffset() * 60) * 1000)); o.put(W()); },   // SET_INFORMATION
  0x00(q, o) { const t = this.tree(q), p = this.path(q, dec(q.bytes, 1)); this.op(t, x => x.mkdir(p)); o.put(W()); },   // CREATE_DIRECTORY
  0x01(q, o) { const t = this.tree(q), p = this.path(q, dec(q.bytes, 1)); this.op(t, x => x.rmdir(p)); o.put(W()); },   // DELETE_DIRECTORY
  0x06(q, o) {   // DELETE: a name or a pattern in a folder
    const t = this.tree(q), p = this.path(q, dec(q.bytes, 1)), i = p.lastIndexOf('\\'), dir = i < 0 ? '' : p.slice(0, i), pat = p.slice(i + 1);
    if (!/[*?]/.test(pat)) { this.op(t, x => x.unlink(p)); o.put(W()); return; }
    const hit = this.op(t, x => x.list(dir)).filter(e => !e.dir && wild(pat)(e.name)); if (!hit.length) fail(ERR.DOS, E.badfile);
    for (const e of hit) this.op(t, x => x.unlink((dir ? dir + '\\' : '') + e.name));
    o.put(W());
  },
  0x07(q, o) { const t = this.tree(q), a = dec(q.bytes, 1), b = dec(q.bytes, a.length + 3); this.op(t, x => x.rename(this.path(q, a), this.path(q, b))); o.put(W()); },   // RENAME
  // OPEN (core): AccessMode's low bits read 0, write 1, read/write 2
  0x02(q, o) { const f = this.open(q, dec(q.bytes, 1), 1, q.w(0)); const ut = utime(f.st.mtime); o.put(W(f.fid, attrsOf(f.st), ut & 0xffff, ut >>> 16, f.st.size & 0xffff, f.st.size >>> 16, q.w(0) & 0x7f)); },
  0x03(q, o) { const f = this.open(q, dec(q.bytes, 1), 0x12, 2); o.put(W(f.fid)); },   // CREATE: made or truncated
  0x0f(q, o) { const f = this.open(q, dec(q.bytes, 1), 0x10, 2); o.put(W(f.fid)); },   // CREATE_NEW: made, failing if it is there
  0x04(q, o) { const f = this.file(q.w(0)), ut = q.d(1); if (ut && ut !== 0xffffffff) try { this.op(f.t, x => x.times(f.p, (ut + new Date().getTimezoneOffset() * 60) * 1000)); } catch (_) { /* the time is advice */ } this.files.delete(q.w(0)); o.put(W()); },   // CLOSE
  0x05(q, o) { o.put(W()); },   // FLUSH: the host writes through
  0x0a(q, o) {   // READ
    const f = this.file(q.w(0)), b = this.op(f.t, x => x.read(f.p, q.d(2), q.w(1)));
    o.put(W(b.length, 0, 0, 0, 0), concat([1], u16(b.length), b));
  },
  0x0b(q, o) {   // WRITE (a count of 0 sets the file's size to the offset)
    const f = this.file(q.w(0)), n = q.w(1), off = q.d(2);
    if (!n) this.op(f.t, x => x.truncate(f.p, off)); else this.op(f.t, x => x.write(f.p, off, q.bytes.slice(3, 3 + n)));
    o.put(W(n));
  },
  0x12(q, o) {   // SEEK: from the start, the position, or the end
    const f = this.file(q.w(0)), mode = q.w(1), off = q.d(2) | 0, end = mode === 2 ? (this.op(f.t, x => x.stat(f.p)) || { size: 0 }).size : 0;
    f.pos = Math.max(0, (mode === 0 ? 0 : mode === 1 ? f.pos || 0 : end) + off); o.put(W(f.pos & 0xffff, f.pos >>> 16));
  },
  0x0c(q, o) { this.file(q.w(0)); o.put(W()); }, 0x0d(q, o) { this.file(q.w(0)); o.put(W()); },   // LOCK / UNLOCK_BYTE_RANGE: one client
  0x24(q, o) { this.file(q.w(2)); o.put(W(0xff, 0), undefined, true); },                          // LOCKING_ANDX
  // OPEN_ANDX: OpenFunction's low bits what to do with a file that is there (0 fail, 1 open, 2 truncate), 10h make one
  // that is not; Action 1 opened, 2 made, 3 truncated
  0x2d(q, o) {
    const f = this.open(q, dec(q.bytes, 0), q.w(8), q.w(3)), ut = utime(f.st.mtime);
    o.put(W(0xff, 0, f.fid, attrsOf(f.st), ut & 0xffff, ut >>> 16, f.st.size & 0xffff, f.st.size >>> 16, q.w(3) & 0x7f, 0, 0, f.action, f.fid, 0, 0), undefined, true);
  },
  0x2e(q, o) {   // READ_ANDX: the data after a pad byte, its offset from the header
    const f = this.file(q.w(2)), n = Math.min(q.w(5), MAXBUF - 64), b = this.op(f.t, x => x.read(f.p, q.d(3), n));
    const dataOff = o.len + 1 + 2 * 12 + 2 + 1;
    o.put(W(0xff, 0, 0xffff, 0, 0, b.length, dataOff, 0, 0, 0, 0, 0), concat([0], b), true);
  },
  0x2f(q, o) {   // WRITE_ANDX: DataLength at word 10, DataOffset (from the header) at word 11
    const f = this.file(q.w(2)), n = q.w(10), at = q.w(11), off = q.d(3);
    this.op(f.t, x => x.write(f.p, off, q.m.slice(at, at + n)));
    o.put(W(0xff, 0, n, 0xffff, 0, 0), undefined, true);
  },
  0x23(q, o) {   // QUERY_INFORMATION2
    const f = this.file(q.w(0)), st = this.op(f.t, x => x.stat(f.p)) || f.st, c = dosDT(st.ctime || st.mtime), a = dosDT(st.atime || st.mtime), m = dosDT(st.mtime);
    o.put(W(c.date, c.time, a.date, a.time, m.date, m.time, st.size & 0xffff, st.size >>> 16, st.size & 0xffff, st.size >>> 16, attrsOf(st)));
  },
  0x22(q, o) { const f = this.file(q.w(0)), wd = q.w(5), wt = q.w(6); if (wd) this.op(f.t, x => x.times(f.p, fromDos(wd, wt))); o.put(W()); },   // SET_INFORMATION2
  // SEARCH (core): 43-byte entries with a 21-byte resume key; the 8.3 names of the folder's entries
  0x81(q, o) {
    const t = this.tree(q), max = q.w(0), sattr = q.w(1), name = dec(q.bytes, 1), kl = le16(q.bytes, name.length + 3), resume = q.bytes.subarray(name.length + 5, name.length + 5 + kl);
    let st;
    if (kl === 21) st = this.searches.get('core' + resume[12]); else {
      const p = this.path(q, name), i = p.lastIndexOf('\\'), dir = i < 0 ? '' : p.slice(0, i), pat = p.slice(i + 1) || '*.*';
      const all = this.op(t, x => x.list(dir)), taken = new Set();
      const ents = all.map(e => ({ ...e, short: short83(e.name, taken) })).map(e => { taken.add(e.short); return e; });
      const hit = ents.filter(e => match83(pat, e.short) && (!e.dir || sattr & ATTR.DIR) && (!e.hidden || sattr & ATTR.HIDDEN));
      const id = this.nextSid++ & 0xff; st = { id, list: hit, at: 0 }; this.searches.set('core' + id, st);
    }
    if (!st || st.at >= st.list.length) fail(ERR.DOS, E.nofiles);
    const out = [];
    for (; st.at < st.list.length && out.length < max; st.at++) {
      const e = st.list[st.at], b = new Uint8Array(43), m = dosDT(e.mtime);
      b[0] = 0; b.set(enc(e.short.padEnd(11).slice(0, 11)), 1); b[12] = st.id; b[13] = st.at + 1; b[14] = (st.at + 1) >> 8;
      b[21] = attrsOf(e); b.set(u16(m.time), 22); b.set(u16(m.date), 24); b.set(u32b(e.dir ? 0 : e.size), 26); b.set(enc(e.short.slice(0, 12)), 30);
      out.push(b);
    }
    const data = concat(...out); o.put(W(out.length), concat([5], u16(data.length), data));
  },
  0x34(q, o) { this.searches.delete(q.w(0)); o.put(W()); },   // FIND_CLOSE2
  0x84(q, o) { o.put(W()); },                                 // FIND_CLOSE (core)
  0x32(q, o) { this.trans2(q, o); },                          // TRANSACTION2
  0x25(q, o) { this.trans(q, o); },                           // TRANSACTION: \PIPE\LANMAN
};
// open, as OPEN, CREATE and OPEN_ANDX ask: fn the OpenFunction, access the mode (low 3 bits: 0 read, 1 write, 2 both)
SmbConnection.prototype.open = function (q, raw, fn, access) {
  const t = this.tree(q); if (t.ipc) fail(ERR.DOS, E.noaccess);
  const p = this.path(q, raw); let st = this.op(t, x => x.stat(p)), action = 1;
  if (st && st.dir) fail(ERR.DOS, E.noaccess);
  if (st) { if ((fn & 3) === 0) fail(ERR.DOS, E.filexists); if ((fn & 3) === 2) { this.op(t, x => x.truncate(p, 0)); action = 3; } }
  else { if (!(fn & 0x10)) fail(ERR.DOS, E.badfile); this.op(t, x => x.create(p, false)); action = 2; }
  st = this.op(t, x => x.stat(p)) || { size: 0, mtime: Date.now() };
  if ((access & 7) && st.readonly) fail(ERR.DOS, E.noaccess);
  const fid = this.nextFid++ & 0xffff || this.nextFid++;
  const f = { fid, t, p, st, action, pos: 0 }; this.files.set(fid, f); return f;
};

// ---- TRANSACTION2: the parameters and data where the request's offsets put them; the reply's likewise
const trans = q => {
  const pc = q.w(9), po = q.w(10), dc = q.w(11), doff = q.w(12), sc = q.words[26], setup = []; for (let i = 0; i < sc; i++) setup.push(q.w(14 + i));
  return { setup, params: q.m.slice(po, po + pc), data: q.m.slice(doff, doff + dc), maxData: q.w(3), name: q.cmd === 0x25 ? dec(q.bytes, 0) : '' };
};
const transReply = (o, params, data, setup = []) => {
  const wc = 10 + setup.length, base = o.len + 1 + 2 * wc + 2, pad1 = (4 - (base % 4)) % 4, po = base + pad1, pad2 = (4 - ((po + params.length) % 4)) % 4, dof = po + params.length + pad2;
  o.put(W(params.length, data.length, 0, params.length, po, 0, data.length, data.length ? dof : 0, 0, setup.length, ...setup),
    concat(new Uint8Array(pad1), params, new Uint8Array(pad2), data));
};
SmbConnection.prototype.trans2 = function (q, o) {
  const t = this.tree(q), r = trans(q), sub = r.setup[0], P = r.params;
  const std = (st, withEa) => { const c = dosDT(st.ctime || st.mtime), a = dosDT(st.atime || st.mtime), m = dosDT(st.mtime), size = st.dir ? 0 : st.size;
    return concat(u16(c.date), u16(c.time), u16(a.date), u16(a.time), u16(m.date), u16(m.time), u32b(size), u32b(Math.ceil(size / 4096) * 4096), u16(attrsOf(st)), withEa ? u32b(0) : []); };
  const entries = (st, n, flags, level) => {
    const out = [];
    for (; st.at < st.list.length && out.length < n; st.at++) {
      const e = st.list[st.at], nm = enc(e.name);
      out.push(concat(flags & 4 ? u32b(st.at + 1) : [], std(e, level === 2), [nm.length], nm, [0]));
    }
    return out;
  };
  switch (sub) {
    case 1: case 2: {   // FIND_FIRST2 / FIND_NEXT2 at SMB_INFO_STANDARD (1) or with EA sizes (2)
      let st, n, flags, level;
      if (sub === 1) {
        const sattr = le16(P, 0); n = le16(P, 2); flags = le16(P, 4); level = le16(P, 6);
        const p = this.path(q, dec(P, 12)), i = p.lastIndexOf('\\'), dir = i < 0 ? '' : p.slice(0, i), pat = p.slice(i + 1) || '*';
        if (t.ipc) fail(ERR.DOS, E.badfile);
        const all = this.op(t, x => x.list(dir)), ent = [];
        if (pat === '*' || pat === '*.*') ent.push({ name: '.', dir: true, size: 0, mtime: Date.now() }, { name: '..', dir: true, size: 0, mtime: Date.now() });
        for (const e of all) if (wild(pat)(e.name) && (!e.dir || sattr & ATTR.DIR) && (!e.hidden || sattr & ATTR.HIDDEN)) ent.push(e);
        if (!ent.length || (dir && dir !== '' && !this.op(t, x => x.stat(dir)))) fail(ERR.DOS, E.badfile);
        st = { id: this.nextSid++ & 0xffff, list: ent, at: 0 }; this.searches.set(st.id, st);
      } else {
        st = this.searches.get(le16(P, 0)); n = le16(P, 2); level = le16(P, 4); flags = le16(P, 10);
        if (!st) fail(ERR.DOS, E.badfid);
      }
      if (level !== 1 && level !== 2) fail(ERR.DOS, E.badfunc);
      const out = entries(st, n, flags, level), end = st.at >= st.list.length;
      let lastName = 0, k = 0; for (let i = 0; i < out.length - 1; i++) k += out[i].length; lastName = out.length ? k : 0;
      if (end && (flags & 2 || flags & 1)) this.searches.delete(st.id);
      if (sub === 1 && flags & 1) this.searches.delete(st.id);
      const params = sub === 1 ? concat(u16(st.id), u16(out.length), u16(end ? 1 : 0), u16(0), u16(lastName)) : concat(u16(out.length), u16(end ? 1 : 0), u16(0), u16(lastName));
      transReply(o, params, concat(...out)); return;
    }
    case 3: {   // QUERY_FS_INFORMATION: 1 the allocation (32 KB units), 2 the volume
      const lv = le16(P, 0), sp = this.op(t, x => x.space()) || { total: 0, free: 0 };
      if (lv === 1) { transReply(o, new Uint8Array(0), concat(u32b(0), u32b(64), u32b(Math.floor(sp.total / 32768)), u32b(Math.floor(sp.free / 32768)), u16(512))); return; }
      if (lv === 2) { const l = enc(t.name.slice(0, 11)); transReply(o, new Uint8Array(0), concat(u32b(0x4d414321), [l.length], l, [0])); return; }
      fail(ERR.DOS, E.badfunc); return;
    }
    case 5: {   // QUERY_PATH_INFORMATION: 1 standard, 2 with EA size, 6 whether the name is valid
      const lv = le16(P, 0), p = this.path(q, dec(P, 6)), st = p ? this.op(t, x => x.stat(p)) : { dir: true, size: 0, mtime: Date.now() };
      if (lv === 6) { if (/[<>|"]/.test(p)) fail(ERR.DOS, 123); transReply(o, concat(u16(0)), new Uint8Array(0)); return; }
      if (!st) fail(ERR.DOS, E.badfile);
      if (lv === 1 || lv === 2) { transReply(o, concat(u16(0)), std(st, lv === 2)); return; }
      if (lv === 4) { transReply(o, concat(u16(0)), u32b(0)); return; }
      fail(ERR.DOS, E.badfunc); return;
    }
    case 7: {   // QUERY_FILE_INFORMATION
      const f = this.file(le16(P, 0)), lv = le16(P, 2), st = this.op(f.t, x => x.stat(f.p)) || f.st;
      if (lv === 1 || lv === 2) { transReply(o, concat(u16(0)), std(st, lv === 2)); return; }
      fail(ERR.DOS, E.badfunc); return;
    }
    case 6: case 8: {   // SET_PATH_INFORMATION / SET_FILE_INFORMATION at level 1: the write time
      const isFile = sub === 8, f = isFile ? this.file(le16(P, 0)) : null, p = isFile ? f.p : this.path(q, dec(P, 6)), lv = le16(P, isFile ? 2 : 0), D = r.data;
      if (lv === 1 && D.length >= 12) { const wd = le16(D, 8), wt = le16(D, 10); if (wd) this.op(t, x => x.times(p, fromDos(wd, wt))); }
      transReply(o, concat(u16(0)), new Uint8Array(0)); return;
    }
    case 0x0d: { const p = this.path(q, dec(P, 4)); this.op(t, x => x.mkdir(p)); transReply(o, concat(u16(0)), new Uint8Array(0)); return; }   // CREATE_DIRECTORY
  }
  fail(ERR.DOS, E.badfunc);
};

// ---- TRANSACTION on \PIPE\LANMAN: the LAN Manager remote API (RAP) the shell and the provider use
SmbConnection.prototype.trans = function (q, o) {
  const r = trans(q), P = r.params, api = le16(P, 0);
  if (!/PIPE\\LANMAN$/i.test(r.name)) fail(ERR.DOS, E.badfunc);
  const pdesc = dec(P, 2), ddesc = dec(P, 3 + pdesc.length), at = 4 + pdesc.length + ddesc.length, level = le16(P, at), bufLen = le16(P, at + 2);
  const ret = (status, extra, data) => transReply(o, concat(u16(status), u16(0), ...extra), data || new Uint8Array(0));
  const strings = []; let strAt = 0;
  // a structure's string pointers point past its fixed parts (offsets from the data's start; converter 0)
  const fixed = (records, size) => { strAt = records * size; return s => { const b = enc(s + '\0'); const off = strAt; strings.push(b); strAt += b.length; return off; }; };
  const shares = shareList();
  if (api === 0) {   // NetShareEnum, level 0 (13-byte names) or 1 (name, pad, type, remark)
    const size = level === 1 ? 20 : 13, n = Math.min(shares.length, Math.floor(bufLen / (size + 32)) || shares.length), sp = fixed(n, size), recs = [];
    for (const s of shares.slice(0, n)) { const b = new Uint8Array(size); b.set(enc(s.name.slice(0, 12))); if (level === 1) { b.set(u16(0), 14); b.set(u32b(sp(s.remark)), 16); } recs.push(b); }
    ret(0, [u16(n), u16(shares.length)], concat(...recs, ...strings)); return;
  }
  if (api === 1) {   // NetShareGetInfo: the share named, level 1
    const name = dec(P, at).toUpperCase(), lvl = le16(P, at + name.length + 1), s = shares.find(x => x.name === name);
    if (!s) { ret(2310, [u16(0)]); return; }
    const sp = fixed(1, 20), b = new Uint8Array(20); b.set(enc(s.name.slice(0, 12))); b.set(u32b(sp(s.remark)), 16);
    ret(0, [u16(20)], concat(lvl === 0 ? b.subarray(0, 13) : b, ...strings)); return;
  }
  if (api === 13) {   // NetServerGetInfo, level 1: name, version 4.0, type (workstation and server), comment
    const sp = fixed(1, 26), b = new Uint8Array(26); b.set(enc(host.name)); b[16] = 4; b[17] = 0; b.set(u32b(0x00000003), 18); b.set(u32b(sp('')), 22);
    ret(0, [u16(level === 0 ? 16 : 26)], concat(level === 0 ? b.subarray(0, 16) : b, ...strings)); return;
  }
  if (api === 104) {   // NetServerEnum2: the computers this one knows of (itself, and those the browser heard)
    // after the level and the buffer's size: the types wanted; SV_TYPE_DOMAIN_ENUM asks for the workgroups instead
    const types = le32(P, at + 4), domains = (types & 0x80000000) !== 0;
    const known = domains ? [{ name: host.workgroup, comment: host.name }] : [{ name: host.name, comment: '' }, ...[...(host.peers || new Map()).values()]];
    const size = level === 1 ? 26 : 16, sp = fixed(known.length, size), recs = [];
    for (const k of known) { const b = new Uint8Array(size); b.set(enc(k.name.slice(0, 15))); if (level === 1) { b[16] = 4; b.set(u32b(domains ? 0x80000000 : 3), 18); b.set(u32b(sp(k.comment || '')), 22); } recs.push(b); }
    ret(0, [u16(known.length), u16(known.length)], concat(...recs, ...strings)); return;
  }
  if (api === 63) {   // NetWkstaGetInfo, level 10: computer, user, domain
    ret(0, [u16(0)]); return;
  }
  ret(50, [u16(0)]);   // NERR: not supported
};
host.Session = Session;
})();
