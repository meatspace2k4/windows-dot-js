// A honeypot: what a program does that reaches past its own folder (the network, other programs, the system's start-up,
// the browser's settings, mail) is recorded as it happens, and is still done as Windows would do it. Nothing is
// refused here: there is no network under WSOCK32, so a connection fails as on a computer with no modem, after it
// has been seen. Recorded in the machines' log (tag honeypot: win95.log(), DevTools' console, Debug Monitor) and in
// self.W95Honeypot (worker_eval, or sysApp.cmd('honeypot')); a record has the program, the call, what it named, its
// result, and `flag` when it is what spyware does (start-up entries, browser hijacks, mail, a connection, a download).
// #mod=honeypot, or a line of a .mod file. Loaded again, it takes the place of the last one's hooks.
//
// Two kinds of call are watched:
//   - the stand-ins (win32.js, shell32.js def): their functions are wrapped in place in W95Win32.API, so programs that
//     already hold them come through the wrapper
//   - Windows' own DLLs (WSOCK32, WS2_32, WININET, URLMON, RASAPI32, MAPI32, and the mail and registration DLLs a
//     program brings, by name): an entry hook at each export, its result as the call returns
(() => {
  const p = machine.proc, W = self.W95Win32, NAME = 'mod-honeypot.js';
  const offs = self.W95ModOff || (self.W95ModOff = {});
  if (offs[NAME]) offs[NAME]();
  const ends = [], recs = self.W95Honeypot || (self.W95Honeypot = []);
  const MAX = 5000;

  const prog = () => { const pc = p.thread16 && p.thread16.pc; return (pc && pc.path ? pc.path : 'system').replace(/^.*\\/, '').toUpperCase(); };
  const str = a => { a >>>= 0; if (a < 0x10000 || a >= p.u8.length - 2) return null; try { return p.readA(a, 260); } catch (_) { return null; } };
  const wstr = a => { a >>>= 0; if (a < 0x10000 || a >= p.u8.length - 2) return null; try { return p.readW(a, 260); } catch (_) { return null; } };
  const bytes = (a, n) => { a >>>= 0; n = Math.min(n >>> 0, 160); if (a < 0x1000 || a + n > p.u8.length) return null; let s = ''; for (let i = 0; i < n; i++) { const c = p.u8[a + i]; s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : c === 10 ? '\\n' : c === 13 ? '\\r' : '.'; } return s; };
  const sockaddr = a => { a >>>= 0; if (a < 0x1000 || a + 8 > p.u8.length) return null; const fam = p.r16(a), port = p.u8[a + 2] << 8 | p.u8[a + 3]; return `${fam === 2 ? '' : `family ${fam} `}${p.u8[a + 4]}.${p.u8[a + 5]}.${p.u8[a + 6]}.${p.u8[a + 7]}:${port}`; };

  const record = (call, what, flag) => {
    const r = { t: Math.round(performance.now()), program: prog(), call, what, ...(flag ? { flag } : {}) };
    recs.push(r); if (recs.length > MAX) recs.splice(0, recs.length - MAX);
    W.log(flag ? 'warn' : 'info', 'honeypot', `${r.program} ${call} ${what}${flag ? ` [${flag}]` : ''}`);
    return r;
  };

  // ---- what is spyware's, by what a call names
  const REG_FLAGS = [
    [/\\currentversion\\run(once|services|servicesonce)?(\\|$)/i, 'start-up entry'],
    [/\\internet explorer\\(main|search|searchurl|toolbar|extensions)/i, 'browser settings'],
    [/\\explorer\\browser helper objects/i, 'browser helper object'],
    [/\\policies\\/i, 'policy'],
    [/\\winsock2?\\|\\services\\vxd\\mstcp/i, 'network stack'],
    [/\\currentversion\\(app paths|uninstall)/i, null],
    [/\\software\\(bonzi|bonzi\.com|bonzisoftware)/i, null],
  ];
  const regFlag = path => { for (const [re, f] of REG_FLAGS) if (re.test(path)) return f; return null; };
  const FILE_FLAGS = [
    [/\\windows\\(system\\)?[^\\]+\.(exe|dll|vxd|386|drv|com|ocx)$/i, 'system file'],
    [/\\windows\\start menu\\programs\\startup\\/i, 'start-up entry'],
    [/\\(win|system)\.ini$/i, 'start-up file'],
    [/\\autoexec\.bat$|\\config\.sys$/i, 'start-up file'],
    [/\\(hosts|lmhosts)$/i, 'network stack'],
    [/\\windows\\(cookies|history|temporary internet files)\\/i, 'browser data'],
    [/\\(\w+\.pab|\w+\.wab|\w+\.mbx|\w+\.dbx|inbox\.\w+)$/i, 'mail data'],
  ];
  const fileFlag = path => { for (const [re, f] of FILE_FLAGS) if (re.test(path || '')) return f; return null; };
  const HK = { 0x80000000: 'HKCR', 0x80000001: 'HKCU', 0x80000002: 'HKLM', 0x80000003: 'HKU', 0x80000005: 'HKCC', 0x80000006: 'HKDD' };
  const keyOf = hk => HK[hk >>> 0] || ((p.obj(hk) || {}).path) || `hkey ${(hk >>> 0).toString(16)}`;

  // ---- the stand-ins, wrapped in place
  const wrap = (dll, name, before) => {
    const e = W.API[dll] && W.API[dll][name]; if (!e) return;
    const orig = e[1], fn = function (...a) {
      let r = null; try { r = before.apply(this, a); } catch (_) { /* a record is never the call's failure */ }
      const ret = orig.apply(this, a);
      if (r) r.result = typeof ret === 'number' ? (ret >>> 0).toString(16) : ret === undefined ? undefined : String(ret).slice(0, 40);
      return ret;
    };
    e[1] = fn; ends.push(() => { if (e[1] === fn) e[1] = orig; });
  };
  const self32 = () => !/^(EXPLORER|SYSTEM|MSGSRV32|MPREXE|KERNEL32|RUNDLL32|RUNDLL)\.EXE$|^SYSTEM$/i.test(prog());

  wrap('KERNEL32', 'WinExec', cmd => record('WinExec', str(cmd), 'runs a program'));
  wrap('KERNEL32', 'CreateProcessA', (app, cmd) => record('CreateProcessA', [str(app), str(cmd)].filter(Boolean).join(' | '), 'runs a program'));
  wrap('KERNEL32', 'CreateProcessW', (app, cmd) => record('CreateProcessW', [wstr(app), wstr(cmd)].filter(Boolean).join(' | '), 'runs a program'));
  for (const n of ['ShellExecuteA', 'ShellExecuteW']) wrap('SHELL32', n, (h, verb, file, params) => {
    const r = n.endsWith('W') ? wstr : str, f = r(file) || '', args = r(params) || '';
    return record(n, `${r(verb) || 'open'} ${f}${args ? ' ' + args : ''}`, /^(https?|ftp|mailto|news):/i.test(f) ? 'opens the network' : 'runs a program');
  });
  wrap('SHELL32', 'ShellExecuteExA', sei => { const f = str(p.r32(sei + 16)) || '', a = str(p.r32(sei + 20)) || ''; return record('ShellExecuteExA', `${str(p.r32(sei + 12)) || 'open'} ${f}${a ? ' ' + a : ''}`, /^(https?|ftp|mailto|news):/i.test(f) ? 'opens the network' : 'runs a program'); });
  for (const n of ['RegSetValueExA', 'RegSetValueA']) wrap('ADVAPI32', n, function (hk, name, x, type, data, len) {
    if (!self32()) return null;
    const key = n === 'RegSetValueA' ? `${keyOf(hk)}\\${str(name) || ''}` : keyOf(hk), val = n === 'RegSetValueA' ? '' : str(name) || '(default)';
    const d = n === 'RegSetValueA' ? str(data) : type === 1 || type === 2 ? str(data) : type === 4 ? (p.r32(data) >>> 0).toString(16) : `${len >>> 0} bytes`;
    const f = regFlag(key); return f || /run|start|url|search|home|page/i.test(val) ? record(n, `${key} ${val} = ${d}`, f) : record(n, `${key} ${val} = ${d}`);
  });
  for (const n of ['RegCreateKeyExA', 'RegCreateKeyA']) wrap('ADVAPI32', n, function (hk, sub) { if (!self32()) return null; const k = `${keyOf(hk)}\\${str(sub) || ''}`; const f = regFlag(k); return f ? record(n, k, f) : null; });
  for (const n of ['RegDeleteKeyA', 'RegDeleteValueA']) wrap('ADVAPI32', n, function (hk, sub) { if (!self32()) return null; const k = `${keyOf(hk)}\\${str(sub) || ''}`; return record(n, k, regFlag(k)); });
  wrap('KERNEL32', 'CreateFileA', (name, access, share, sa, disp) => {
    if (!self32()) return null;
    const f = str(name) || '', writes = (access & 0x40000000) || disp === 1 || disp === 2 || disp === 4 || disp === 5;
    if (/^\\\\\.\\/.test(f)) return record('CreateFileA', f, 'opens a device');
    const flag = fileFlag(f); return flag && (writes || flag === 'mail data' || flag === 'browser data') ? record('CreateFileA', `${f} (${writes ? 'write' : 'read'})`, flag) : null;
  });
  for (const n of ['CopyFileA', 'MoveFileA']) wrap('KERNEL32', n, (a, b) => { if (!self32()) return null; const t = str(b); const f = fileFlag(t); return f ? record(n, `${str(a)} -> ${t}`, f) : null; });
  wrap('KERNEL32', 'DeleteFileA', a => { if (!self32()) return null; const t = str(a); const f = fileFlag(t); return f ? record('DeleteFileA', t, f) : null; });
  wrap('KERNEL32', 'WritePrivateProfileStringA', (sec, key, val, file) => {
    if (!self32()) return null; const fl = str(file) || 'WIN.INI', s = str(sec) || '', k = str(key) || '';
    return /^(load|run|shell)$/i.test(k) || /^\[?boot\]?$/i.test(s) ? record('WritePrivateProfileStringA', `${fl} [${s}] ${k}=${str(val)}`, 'start-up entry') : null;
  });
  wrap('KERNEL32', 'WriteProfileStringA', (sec, key, val) => {
    if (!self32()) return null; const k = str(key) || '';
    return /^(load|run)$/i.test(k) ? record('WriteProfileStringA', `WIN.INI [${str(sec)}] ${k}=${str(val)}`, 'start-up entry') : null;
  });

  // ---- Windows' own network and mail DLLs: each export's entry, with what its arguments name, and its result
  const NET = {
    WSOCK32: 'connection', WS2_32: 'connection', WININET: 'connection', URLMON: 'download', RASAPI32: 'dial-up',
    MAPI32: 'mail', EMPOP3: 'mail', RACREG32: 'registration', ODKOB32: null,
  };
  const QUIET = /^(WSAGetLastError|WSASetLastError|__WSAFDIsSet|htons|ntohs|htonl|ntohl|WSAIsBlocking|DllMain|DllCanUnloadNow|DllGetClassObject)$/i;
  const describe = (mod, name, a) => {
    switch (name) {
      case 'connect': case 'bind': return `socket ${a[0].toString(16)} ${sockaddr(a[1])}`;
      case 'sendto': return `${sockaddr(a[4])} "${bytes(a[1], a[2])}"`;
      case 'send': return `socket ${a[0].toString(16)} ${a[2]} bytes "${bytes(a[1], a[2])}"`;
      case 'recv': case 'recvfrom': return `socket ${a[0].toString(16)} up to ${a[2]}`;
      case 'gethostbyname': case 'inet_addr': return str(a[0]);
      case 'gethostbyaddr': return a[0] > 0x1000 ? `${p.u8[a[0]]}.${p.u8[a[0] + 1]}.${p.u8[a[0] + 2]}.${p.u8[a[0] + 3]}` : '';
      case 'socket': return `af ${a[0]} type ${a[1]} proto ${a[2]}`;
    }
    // (otherwise each argument that is text, as the call sees it)
    const t = a.map(v => { const s = str(v); if (s && /^[\x20-\x7e]{2,}$/.test(s)) return JSON.stringify(s.slice(0, 200)); const w = wstr(v); return w && /^[\x20-\x7e]{2,}$/.test(w) ? JSON.stringify(w.slice(0, 200)) : null; }).filter(Boolean);
    return t.join(' ');
  };
  const hooked = new Set();
  const hookModule = (name, m) => {
    const dll = String(name).toUpperCase().replace(/\.DLL$/, '');
    if (!(dll in NET) || hooked.has(m) || m.kind === 'ne' || !m.exports) return;
    hooked.add(m);
    record('load', `${dll} (${m.path || m.name || ''})`, NET[dll] ? `${NET[dll]} library` : null);
    for (const [nm, at] of m.exports) {
      if (typeof at !== 'number' || !at || QUIET.test(nm)) continue;
      ends.push(p.addEntryHook(at, function () {
        const sp = this.reg('esp') >>> 0, a = [1, 2, 3, 4, 5, 6].map(k => this.r32(sp + 4 * k) >>> 0);
        let r; try { r = record(`${dll}!${nm}`, describe(dll, nm, a), NET[dll]); } catch (_) { return undefined; }
        this.onReturn(eax => { r.result = eax.toString(16); });
        return undefined;
      }));
    }
  };
  const was = p.onModuleLoad, onLoad = function (name, m) { if (was) was.call(this, name, m); try { hookModule(name, m); } catch (e) { W.log('warn', 'honeypot', `hook ${name}: ${e && e.message}`); } };
  p.onModuleLoad = onLoad;
  ends.push(() => { if (p.onModuleLoad === onLoad) p.onModuleLoad = was; });
  for (const m of p.modules || []) if (m.name) hookModule(m.name, m);

  offs[NAME] = () => { for (const f of ends.splice(0)) try { f(); } catch (_) { /* gone with its module */ } };
  W.log('info', 'honeypot', `watching: ${Object.keys(NET).join(', ')}, program starts, ShellExecute, the registry's start-up and browser keys, system files`);
})();
