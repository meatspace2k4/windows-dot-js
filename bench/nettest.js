// dev-page harness for the network bring-up: window.__net(budgetMs) starts MPREXE with traces and a time budget
window.__net = function (budget = 10000, opts = {}) {
  window.__e = []; window.__r = []; window.__t = [];
  const oe = console.error, ow = console.warn;
  console.error = (...a) => { __e.push(a.map(x => (x && x.message) || String(x)).join(' ').slice(0, 400)); oe(...a); };
  console.warn = (...a) => { __e.push('W ' + a.join(' ').slice(0, 400)); ow(...a); };
  window.W95VXDTRACE = (d, n, p, at) => { if (d === 1 && n === 0x3f) return; __t.push(d.toString(16) + ':' + n.toString(16) + '@' + at.toString(16)); if (__t.length > 600) __t.shift(); };
  window.W95VXDRET = (d, n, p, arg, r) => {
    let s = ''; try { s = [0, 1, 2, 3].map(i => arg(i).toString(16)).join(','); } catch (e) {}
    __r.push(d.toString(16) + ':' + n.toString(16) + ' (' + s + ') -> ' + r.toString(16)); if (__r.length > 600) __r.shift();
  };
  // the budget is for one stretch of the main thread: a timer the page runs between stretches marks where the last ended
  window.__b = new Uint32Array(256); window.__bn = 0; window.__tick = performance.now();
  clearInterval(window.__tickTimer); window.__tickTimer = setInterval(() => { window.__tick = performance.now(); }, 50);
  window.W95BTRACE = e => { __b[__bn++ & 255] = e; if ((__bn & 0xffff) === 0 && performance.now() - __tick > budget) throw new Error('budget'); };
  window.__done = false;
  setTimeout(() => win95.startNetwork().finally(() => { window.__done = true; }), 0);
};
window.__blocks = n => { const out = []; for (let i = n; i > 0; i--) out.push(__b[(__bn - i) & 255].toString(16)); return out.join(' '); };
// a share for the dev page's LAN host, kept in a file system of its own (fs.js) on volume S:
window.__testShare = function (name = 'PUBLIC') {
  const F = new W95FS.FileSystem(); F.mount('S', { total: 1 << 30 }); F.writeFile('S:\\readme.txt', 'Hello from the LAN.\r\n'); F.mkdir('S:\\Folder');
  const at = p => 'S:\\' + p, st = i => ({ name: i.name, size: i.size, dir: i.isDir, mtime: i.mtime, ctime: i.ctime, atime: i.atime, readonly: i.readonly, hidden: i.hidden });
  const wrap = fn => (...a) => { try { return fn(...a); } catch (e) { throw Object.assign(new Error('E' + ({ 2: 'NOENT', 3: 'NOTDIR', 5: 'ACCES', 80: 'EXIST', 183: 'EXIST', 145: 'NOTEMPTY' }[e.code] || 'IO')), { code: 'E' + ({ 2: 'NOENT', 3: 'NOTDIR', 5: 'ACCES', 80: 'EXIST', 183: 'EXIST', 145: 'NOTEMPTY' }[e.code] || 'IO') }); } };
  const ops = {
    stat: wrap(p => (F.exists(at(p)) ? st(F.stat(at(p))) : null)), list: wrap(p => F.readdir(at(p)).map(st)),
    read: wrap((p, o, n) => { const fd = F.open(at(p), 'r'); try { F.seek(fd, o); return F.read(fd, n); } finally { F.close(fd); } }),
    write: wrap((p, o, b) => { const fd = F.open(at(p), 'r+'); try { F.seek(fd, o); F.write(fd, b); } finally { F.close(fd); } }),
    truncate: wrap((p, n) => { const fd = F.open(at(p), 'r+'); try { F.truncate(fd, n); } finally { F.close(fd); } }),
    create: wrap((p, x) => F.writeFile(at(p), new Uint8Array(0))), mkdir: wrap(p => F.mkdir(at(p))), rmdir: wrap(p => F.rmdir(at(p))),
    unlink: wrap(p => F.unlink(at(p))), rename: wrap((a, b) => F.rename(at(a), at(b))), times: wrap((p, t) => F.setTimes(at(p), { mtime: t })),
    space: () => ({ total: 1 << 30, free: 1 << 29 }),
  };
  W95LANHOST.shares = [{ name, remark: 'test share', ops }]; window.__shareFs = F; return F;
};
// MPR's WNetAddConnection2A in the network's process: the local device (N:) to \\HOST\SHARE; its result
window.__netUse = function (local, remote) {
  const p = win95.netApp.proc, mpr = p.byName.get('MPR'), fn = mpr && mpr.exports.get('WNetAddConnection2A');
  const nr = p.alloc(32), l = p.alloc(16), r = p.alloc(260);
  p.u8.fill(0, nr, nr + 32); p.writeA(l, local); p.writeA(r, remote);
  p.w32(nr + 4, 1); p.w32(nr + 16, l); p.w32(nr + 20, r);   // RESOURCETYPE_DISK, lpLocalName, lpRemoteName
  const t = performance.now(), ret = p.call(fn, [nr, 0, 0, 0]);
  return { ret, ms: +(performance.now() - t).toFixed(1), lastError: p.lastError };
};
// WNetLogonA(NULL, NULL) on a thread of the network's process: a stub `push 0; push 0; call [WNetLogonA]; ret 4`
window.__netLogon = function () {
  const p = win95.netApp.proc, fn = p.byName.get('MPR').exports.get('WNetLogonA'), a = p.alloc(32);
  p.w32(a + 16, fn);
  p.u8.set([0x6a, 0x00, 0x6a, 0x00, 0xff, 0x15, ...[0, 8, 16, 24].map(s => ((a + 16) >>> s) & 0xff), 0xc2, 0x04, 0x00], a);
  return p.newThread(a, 0, 0x10000, true, false);
};
// the logon on a thread of the network's process, its dialog answered with OK (the user name it remembers, no password)
window.__netLogonOk = async function () {
  const t = __netLogon(), a = win95.netApp, t0 = performance.now();
  while (t.state !== 'done' && performance.now() - t0 < 20000) {
    const w = [...a.wins.values()].find(x => /Password/.test(x.title));
    if (w) win95.click(w.x + w.w - 45, w.y + 37);   // its OK button
    await new Promise(r => setTimeout(r, 500));
  }
  return t.state;
};
// the network up with N: on \\HOST\PUBLIC (the test share): the process, the logon, the connection
window.__netUp = async function () {
  __testShare(); window.__smb = []; W95LANHOST.smbTrace = (cmd, q, e) => { const sub = cmd === 0x32 ? '/' + q.w(14).toString(16) : ''; __smb.push(cmd.toString(16) + sub + (e ? ' ERR ' + e.cls + '/' + e.code : '')); if (__smb.length > 500) __smb.shift(); };
  // the shell's own start: the logon (its dialog answered with OK) and the connections it restores
  const boot = win95.netBoot(); let done = false; boot.then(() => { done = true; });
  for (const t0 = performance.now(); !done && performance.now() - t0 < 30000;) {
    const a = win95.netApp, w = a && [...a.wins.values()].find(x => /Password/.test(x.title));
    if (w) win95.click(w.x + w.w - 45, w.y + 37);   // its OK button
    await new Promise(r => setTimeout(r, 500));
  }
  const a = win95.netApp, use = __netUse('N:', '\\\\HOST\\PUBLIC'); win95.syncNetDrives();
  return { alive: a.alive, logon: done, use };
};
// IFSMGR's ring-0 file API in the network's process: EAX the function, the rest as given
window.__r0 = regs => { const p = win95.netApp.proc, r = p.vxdCall(p.vxdService(0x40, 0x32), regs); return { eax: r.eax, cf: r.cf, ecx: r.ecx, edx: r.edx }; };

// MPR's enumeration (WNetOpenEnumA scope, type 0, usage 0, below `nr`): every NETRESOURCE it gives
window.__en = async function (scope, nr = 0) {
  const p = win95.netApp.proc, ph = p.alloc(4), r = await win95.netCall('WNetOpenEnumA', [scope, 0, 0, nr, ph]);
  if (r) return { open: r };
  const h = p.r32(ph), res = [];
  for (;;) {
    const cnt = p.alloc(4), sz = p.alloc(4), buf = p.alloc(16384); p.w32(cnt, 0xffffffff); p.w32(sz, 16384);
    const r2 = await win95.netCall('WNetEnumResourceA', [h, cnt, buf, sz]); if (r2) { if (r2 !== 259) res.push({ enumErr: r2 }); break; }
    for (let i = 0, n = p.r32(cnt); i < n; i++) {
      const a = buf + 32 * i, s = o => p.readA(p.r32(a + o));
      res.push({ scope: p.r32(a), type: p.r32(a + 4), disp: p.r32(a + 8), usage: p.r32(a + 12), local: s(16), remote: s(20), comment: s(24), prov: s(28), nr: a });
    }
  }
  await win95.netCall('WNetCloseEnum', [h]);
  return res;
};
