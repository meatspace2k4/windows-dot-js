// W95DBG.DLL, the Debugger's library (W95DBG.EXE imports it; tools/build_debugger.py), implemented here as the Debug
// Monitor's is (dbwin.js). The Debugger is a program of the machine it debugs: a window with the translated modules
// (left), the code of the block last asked for (middle), the processor and stack (right), an output log, and a command
// line. Everything it shows comes from the machine's debug API (dynjs.js W95DynJs.debug, the page's win95.debug).
//
// Commands (HELP lists them): LM, JS, BP, BL, BC, BA, BD, U, D, R, LN, CLS.
// A place is an address in hex, MODULE+offset or an API DLL!Export. Breakpoints record a hit and run on: the hit's
// registers and stack come up in the window as it happens. Stopping a thread is not in this version.
(() => {
  if (typeof importScripts !== 'function' || !self.W95Win32) return;   // (the system's machine's worker only)
  const { def } = self.W95Win32;
  const WM = { DESTROY: 2, SIZE: 5, SETFOCUS: 7, NOTIFY: 0x4e, COMMAND: 0x111, TIMER: 0x113, CTLCOLORSTATIC: 0x138, SETFONT: 0x30, GETTEXTLENGTH: 0x0e };
  const EM = { SETSEL: 0xb1, REPLACESEL: 0xc2, SCROLLCARET: 0xb7, SETLIMITTEXT: 0xc5 }, LV = { INSERTCOLUMN: 0x101b, INSERTITEM: 0x1007, SETITEMTEXT: 0x102e, DELETEALL: 0x1009, GETNEXTITEM: 0x100c };
  const ID = { MODS: 1, CODE: 2, REGS: 3, OUT: 4, CMD: 5, STATUS: 6 }, CMD = { REFRESH: 101, CLEARBP: 102, CLS: 103, EXIT: 104, HELP: 201 };
  const st = self.W95DebuggerState = { hwnd: 0, mods: 0, code: 0, regs: 0, out: 0, cmd: 0, seen: 0, names: [] };
  const fn = (p, dll, nm) => { const m = p.byName.get(dll); return m && m.exports.get(nm); };
  const U = (p, nm, args) => p.call(fn(p, 'USER32', nm), args), G = (p, nm, args) => p.call(fn(p, 'GDI32', nm), args);
  const bufs = new Map(), str = (p, use, s) => {
    let b = bufs.get(use);
    if (!b || b.cap < s.length + 1) { if (b) p.free(b.at); b = { cap: Math.max(64, s.length + 1), at: 0 }; b.at = p.alloc(b.cap); bufs.set(use, b); }
    p.writeA(b.at, s); return b.at;
  };
  const hx = v => (v >>> 0).toString(16).toUpperCase(), h8 = v => hx(v).padStart(8, '0');
  const dbg = (p, ...a) => self.W95DynJs.debug(p, a, machine);
  const crlf = s => String(s).replace(/\r?\n/g, '\r\n');
  const setText = (p, h, s) => U(p, 'SetWindowTextA', [h, str(p, 'pane', crlf(s))]);
  /** a line (or several) at the end of the output log */
  function say(p, s) {
    const n = U(p, 'SendMessageA', [st.out, WM.GETTEXTLENGTH, 0, 0]);
    if (n > 50000) { U(p, 'SendMessageA', [st.out, EM.SETSEL, 0, 20000]); U(p, 'SendMessageA', [st.out, EM.REPLACESEL, 0, str(p, 'empty', '')]); }
    U(p, 'SendMessageA', [st.out, EM.SETSEL, 0x7fffffff, 0x7fffffff]);
    U(p, 'SendMessageA', [st.out, EM.REPLACESEL, 0, str(p, 'line', crlf(s) + '\r\n')]);
    U(p, 'SendMessageA', [st.out, EM.SCROLLCARET, 0, 0]);
  }
  /** a list view's row: its cells' text */
  function row(p, lv, i, cells) {
    const it = p.alloc(36); p.u8.fill(0, it, it + 36); p.w32(it, 1); p.w32(it + 4, i);   // LVIF_TEXT
    cells.forEach((t, k) => { p.w32(it + 8, k); p.w32(it + 20, str(p, 'cell', t)); U(p, 'SendMessageA', [lv, k ? LV.SETITEMTEXT : LV.INSERTITEM, i, it]); });
    p.free(it);
  }
  /** the modules list: each translated module, its code's place, its blocks, and how it runs */
  function listModules(p) {
    const m = dbg(p, 'modules'); st.names = m.map(x => x.name);
    U(p, 'SendMessageA', [st.mods, LV.DELETEALL, 0, 0]);
    m.forEach((x, i) => row(p, st.mods, i, [x.name, h8(x.lo), String(x.blocks), x.js ? 'JavaScript' : 'WebAssembly']));
    status(p, `${m.length} modules, ${m.filter(x => x.js).length} run as JavaScript`);
    return m;
  }
  const status = (p, s) => { if (st.status) U(p, 'SendMessageA', [st.status, 0x401, 0, str(p, 'status', s)]); };   // SB_SETTEXT
  /** the processor pane: registers, flags, thread and the stack with code addresses named */
  function showState(p, s, title) {
    const r = s.regs, R = k => String(r[k]).toUpperCase().padStart(8, '0');
    setText(p, st.regs, [title, s.at || '', '',
      ...['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip'].map(k => `${k.toUpperCase()}  ${R(k)}`),
      `CS ${String(r.cs).toUpperCase()} DS ${String(r.ds).toUpperCase()} SS ${String(r.ss).toUpperCase()}`, `flags ${s.flags || '-'}`,
      `thread ${s.thread}  level ${s.sysLevel}`, s.program ? s.program.split('\\').pop() : '', '', 'Stack', ...s.stack.map(l => l.toUpperCase().replace(/  ([A-Z0-9_.]+\+[0-9A-F]+.*)$/, (m, w) => '  ' + w))].join('\n'));
  }
  /** a recorded hit as the processor pane shows it, its stack's code addresses named */
  const hitState = (p, h) => ({ at: dbg(p, 'where', h.at), regs: Object.fromEntries(Object.entries(h.regs).map(([k, v]) => [k, hx(v)])), flags: ['cf', 'zf', 'sf', 'of', 'df'].filter(k => h.regs[k]).join(' '),
    thread: h.thread, sysLevel: '-', program: null, stack: h.stack.map((v, i) => { const w = dbg(p, 'where', v); return `+${hx(4 * i)}  ${h8(v)}${/\+/.test(w) ? '  ' + w : ''}`; }) });
  /** what came since the last look: breakpoint hits and traced API calls, into the log; the last hit into the pane */
  function poll(p) {
    const hits = dbg(p, 'hits', st.seen);
    for (const b of dbg(p, 'breakpoints')) if (b.error && !st.told.has(b.id)) { st.told.add(b.id); say(p, `Break ${b.id} ended: ${b.error}`); }
    for (const h of hits) { st.seen = h.seq; say(p, `Break ${h.id} at ${dbg(p, 'where', h.at)}  thread ${h.thread}  hit ${h.n}${h.value !== undefined ? '  = ' + (typeof h.value === 'number' ? hx(h.value) : JSON.stringify(h.value)) : ''}`); }
    if (hits.length) showState(p, hitState(p, hits[hits.length - 1]), `Break ${hits[hits.length - 1].id}`);
    if (st.watching) for (const c of dbg(p, 'calls') || []) if (c.eax !== undefined) say(p, `${c.name}(${c.args.join(', ').toUpperCase()}) -> ${String(c.eax).toUpperCase()}  thread ${c.thread}  from ${c.from}${(c.text || []).some(Boolean) ? '  ' + JSON.stringify(c.text.filter(Boolean)) : ''}`);
  }
  const HELP = ['LM                  list the translated modules',
    'JS name [name..]    run these modules as JavaScript (JS * for all, JS - for none)',
    'BP place [IF expr] [SAY expr]   break at a block: record registers and stack, run on',
    'BL / BC id|*        list / clear breakpoints',
    'BA DLL!Export [n]   trace calls of an API with n arguments (BA USER32!/^Draw/ for a pattern)',
    'BD DLL              end the API traces of a DLL',
    'U place             the code of the block holding a place',
    'D place [length]    dump memory',
    'R                   registers and stack now',
    'LN place            the name of an address',
    'CLS                 clear this log',
    'A place is an address in hex, MODULE+offset or DLL!Export. Expressions see R (R.eax), r8/r16/r32(addr), n, thread.'];
  /** one command line run; what it answers goes to the log */
  function run(p, line) {
    const m = /^\s*(\S+)\s*(.*?)\s*$/.exec(line); if (!m) return;
    const c = m[1].toUpperCase(), a = m[2];
    say(p, '> ' + line.trim());
    if (c === 'HELP' || c === '?') return say(p, HELP.join('\n'));
    if (c === 'CLS') return setText(p, st.out, '');
    if (c === 'LM') { const l = listModules(p); return say(p, l.map(x => `${x.js ? 'JS' : '  '} ${x.name.padEnd(12)} ${h8(x.lo)}-${h8(x.hi)}  ${x.blocks} blocks`).join('\n')); }
    if (c === 'JS') { const names = a === '-' || !a ? [] : a.split(/[\s,]+/), now = dbg(p, 'run', names); listModules(p); return say(p, now.length ? `JavaScript: ${now.join(', ')}` : 'every module runs as WebAssembly'); }
    if (c === 'BP') {
      const q = /^(.*?)(?:\s+IF\s+(.*?))?(?:\s+SAY\s+(.*))?$/i.exec(a), place = q[1].trim(); if (!place) return say(p, 'BP place [IF expr] [SAY expr]');
      const { addr, name } = dbg(p, 'resolve', place), src = dbg(p, 'source', addr);
      if (!src) return say(p, `${name} is not in a translated module`);
      if (src.block !== addr) return say(p, `no block starts at ${name}; it is inside the block at ${dbg(p, 'where', src.block)} (${hx(src.block)})`);
      const mods = dbg(p, 'modules'), mod = mods.find(x => x.name === src.module);
      if (!mod.js) { dbg(p, 'run', [...mods.filter(x => x.js).map(x => x.name), mod.name]); listModules(p); say(p, `${mod.name} now runs as JavaScript`); }
      const b = dbg(p, 'breakpoint', { at: addr, when: q[2] || undefined, capture: q[3] || undefined });
      return say(p, `Break ${b.id} at ${name}${q[2] ? '  if ' + q[2] : ''}${q[3] ? '  say ' + q[3] : ''}`);
    }
    if (c === 'BL') { const l = dbg(p, 'breakpoints'); return say(p, l.length ? l.map(b => `${b.id}  ${dbg(p, 'where', b.at)}  hits ${b.n}${b.when ? '  if ' + b.when : ''}${b.capture ? '  say ' + b.capture : ''}${b.error ? '  ENDED: ' + b.error : ''}`).join('\n') : 'no breakpoints'); }
    if (c === 'BC') { if (a === '*') { dbg(p, 'clear'); st.seen = 0; return say(p, 'breakpoints cleared'); } return say(p, dbg(p, 'remove', Number(a)) ? `Break ${a} cleared` : `no breakpoint ${a}`); }
    if (c === 'BA') {
      const q = /^([\w.]+)!(\S+)(?:\s+(\d+))?$/.exec(a); if (!q) return say(p, 'BA DLL!Export [arguments]');
      const names = dbg(p, 'watch', q[1], q[2], q[3] ? Number(q[3]) : 4); st.watching = true;
      return say(p, names ? `tracing ${q[1]}!${names.join(', ' + q[1] + '!')}` : `${a}: no such export`);
    }
    if (c === 'BD') { dbg(p, 'unwatch', a); return say(p, `traces of ${a} ended`); }
    if (c === 'U') {
      const src = dbg(p, 'source', a); if (!src) return say(p, `${a} is not in a translated module`);
      setText(p, st.code, `; ${dbg(p, 'where', src.block)}  (block ${hx(src.block)} of ${src.module})\n` + src.text);
      return say(p, `block ${hx(src.block)} of ${src.module}`);
    }
    if (c === 'D') {
      const q = /^(\S+)(?:\s+([0-9a-f]+))?$/i.exec(a); if (!q) return say(p, 'D place [length]');
      const { addr } = dbg(p, 'resolve', q[1]), b = dbg(p, 'read', addr, q[2] ? parseInt(q[2], 16) : 64), out = [];
      for (let i = 0; i < b.length; i += 16) { const row = b.slice(i, i + 16); out.push(`${h8(addr + i)}  ${row.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ').padEnd(47)}  ${row.map(x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}`); }
      return say(p, out.join('\n'));
    }
    if (c === 'R') { showState(p, dbg(p, 'state'), 'Now'); return say(p, 'registers and stack as they are now (this thread: the Debugger\'s own)'); }
    if (c === 'LN') { const r = dbg(p, 'resolve', a); return say(p, `${h8(r.addr)}  ${r.name}`); }
    say(p, `${c}: not a command (HELP lists them)`);
  }
  /** the panes placed: modules and code over the processor's, the log, the command line, each under its caption */
  function layout(p, w, h) {
    const SB = 20, T = 16, L = 292, R = 190, C = 22, G = 4, O = Math.max(90, Math.floor(h * 0.3)), top = h - SB - C - G - O - T - G, cw = Math.max(80, w - L - R - 4 * G);
    const put = (x, X, Y, W, H) => U(p, 'MoveWindow', [x, X, Y, W, H, 1]);
    put(st.lMods, G, 2, L, T); put(st.mods, G, T + 2, L, top - T - 2);
    put(st.lCode, L + 2 * G, 2, cw, T); put(st.code, L + 2 * G, T + 2, cw, top - T - 2);
    put(st.lRegs, w - R - G, 2, R, T); put(st.regs, w - R - G, T + 2, R, top - T - 2);
    put(st.lOut, G, top + G, w - 2 * G, T); put(st.out, G, top + G + T, w - 2 * G, O);
    put(st.lCmd, G, h - SB - C - 1, 62, C); put(st.cmd, G + 64, h - SB - C - 2, w - 2 * G - 64, C);
    U(p, 'SendMessageA', [st.status, WM.SIZE, 0, 0]);
  }
  function menu(p) {
    const file = U(p, 'CreatePopupMenu', []), d = U(p, 'CreatePopupMenu', []), help = U(p, 'CreatePopupMenu', []), bar = U(p, 'CreateMenu', []);
    U(p, 'AppendMenuA', [file, 0, CMD.EXIT, str(p, 'm', 'E&xit')]);
    U(p, 'AppendMenuA', [d, 0, CMD.REFRESH, str(p, 'm', '&Refresh modules')]); U(p, 'AppendMenuA', [d, 0, CMD.CLEARBP, str(p, 'm', '&Clear breakpoints')]); U(p, 'AppendMenuA', [d, 0, CMD.CLS, str(p, 'm', 'Clear &log')]);
    U(p, 'AppendMenuA', [help, 0, CMD.HELP, str(p, 'm', '&Commands')]);
    U(p, 'AppendMenuA', [bar, 0x10, file, str(p, 'm', '&File')]); U(p, 'AppendMenuA', [bar, 0x10, d, str(p, 'm', '&Debug')]); U(p, 'AppendMenuA', [bar, 0x10, help, str(p, 'm', '&Help')]);   // (MF_POPUP)
    return bar;
  }
  // (wndproc), as W95DBG.EXE's entry calls it: the window, or 0
  def('W95DBG', 'Start', 1, function (wndproc) {
    const p = this, inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]), cls = str(p, 'class', 'W95Debugger'), wc = p.alloc(40);
    for (const [o, v] of [[0, 0], [4, wndproc], [8, 0], [12, 0], [16, inst], [20, U(p, 'LoadIconA', [0, 32512])], [24, U(p, 'LoadCursorA', [0, 32512])], [28, 16], [32, 0], [36, cls]]) p.w32(wc + o, v);
    U(p, 'RegisterClassA', [wc]);
    const sw = U(p, 'GetSystemMetrics', [0]), sh = U(p, 'GetSystemMetrics', [1]), w = Math.min(820, sw - 20), h = Math.min(540, sh - 60);
    const hwnd = U(p, 'CreateWindowExA', [0, cls, str(p, 'title', 'Debugger'), 0x00cf0000, 10, 10, w, h, 0, menu(p), inst, 0]);   // WS_OVERLAPPEDWINDOW
    if (!hwnd) return 0;
    st.hwnd = hwnd; st.seen = (dbg(p, 'hits').pop() || { seq: 0 }).seq; st.watching = false; st.told = new Set();
    // (the common controls' classes, the list view's and the status bar's, are this process's once it has the library)
    p.call(p.thunkFor('KERNEL32', 'LoadLibraryA'), [str(p, 'lib', 'COMCTL32.DLL')]); { const init = fn(p, 'COMCTL32', 'InitCommonControls'); if (init) p.call(init, []); }
    const gui = G(p, 'GetStockObject', [17]);   // (DEFAULT_GUI_FONT: the system's dialog font)
    const mono = G(p, 'CreateFontA', [-12, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0x31, str(p, 'face', 'Courier New')]) || G(p, 'GetStockObject', [11]);   // (fixed pitch, for code and registers)
    const make = (c, ex, style, id, font, text) => { const x = U(p, 'CreateWindowExA', [ex, str(p, 'ccls', c), text ? str(p, 'ctext', text) : 0, style, 0, 0, 10, 10, hwnd, id, inst, 0]); U(p, 'SendMessageA', [x, WM.SETFONT, font, 0]); return x; };
    const label = t => make('STATIC', 0, 0x50000000, 0xffff, gui, t);
    st.lMods = label('Modules (double-click: JavaScript / WebAssembly)'); st.lCode = label('Code'); st.lRegs = label('Processor'); st.lOut = label('Output'); st.lCmd = label('Command:');
    st.mods = make('SysListView32', 0x200, 0x5000000d, ID.MODS, gui);   // WS_CHILD|WS_VISIBLE|LVS_REPORT|LVS_SINGLESEL|LVS_SHOWSELALWAYS
    { const col = p.alloc(24); [['Module', 82], ['Code at', 66], ['Blocks', 44], ['Runs as', 80]].forEach(([t, cx], i) => { p.w32(col, 0xf); p.w32(col + 4, i === 2 ? 1 : 0); p.w32(col + 8, cx); p.w32(col + 12, str(p, 'col', t)); p.w32(col + 16, 0); p.w32(col + 20, i); U(p, 'SendMessageA', [st.mods, LV.INSERTCOLUMN, i, col]); }); p.free(col); }
    st.code = make('EDIT', 0x200, 0x50b008c4, ID.CODE, mono);      // multi-line, read-only, both scroll bars
    st.regs = make('EDIT', 0x200, 0x50200844, ID.REGS, mono);      // WS_VSCROLL|ES_MULTILINE|ES_AUTOVSCROLL|ES_READONLY
    st.out = make('EDIT', 0x200, 0x50b008c4, ID.OUT, mono);
    st.cmd = make('EDIT', 0x200, 0x500010c4, ID.CMD, mono);        // ES_MULTILINE|ES_AUTOVSCROLL|ES_AUTOHSCROLL|ES_WANTRETURN: Enter ends a command
    st.status = make('msctls_statusbar32', 0, 0x50000100, ID.STATUS, gui);   // SBARS_SIZEGRIP
    for (const e of [st.code, st.out]) U(p, 'SendMessageA', [e, EM.SETLIMITTEXT, 0x7fffffff, 0]);
    const r = p.alloc(16); U(p, 'GetClientRect', [hwnd, r]); layout(p, p.r32(r + 8), p.r32(r + 12)); p.free(r);
    listModules(p);
    setText(p, st.code, '; U place shows the code of a block here');
    say(p, 'Debugger. HELP lists the commands; type one below and press Enter.');
    U(p, 'SetTimer', [hwnd, 1, 400, 0]);
    U(p, 'ShowWindow', [hwnd, 1]); U(p, 'UpdateWindow', [hwnd]); U(p, 'SetFocus', [st.cmd]);
    return hwnd;
  });
  // (hwnd, msg, wp, lp, &result): 1 for a message it answered
  def('W95DBG', 'Handle', 5, function (h, msg, wp, lp, res) {
    const p = this, done = (v = 0) => { p.w32(res, v); return 1; };
    if (h !== st.hwnd) return 0;
    const guard = f => { try { f(); } catch (e) { say(p, String(e && e.message || e)); } };
    if (msg === WM.TIMER) { guard(() => poll(p)); return done(); }
    if (msg === WM.SIZE) { if (st.cmd) layout(p, lp & 0xffff, lp >>> 16); return done(); }
    if (msg === WM.SETFOCUS) { if (st.cmd) U(p, 'SetFocus', [st.cmd]); return done(); }
    // (the read-only panes in the system's window colours, as its editable ones are: an edit that cannot be typed in
    // takes the button face otherwise. The colours are Windows' own, Display Properties > Appearance)
    if (msg === WM.CTLCOLORSTATIC && (lp === st.code || lp === st.regs || lp === st.out)) {
      G(p, 'SetBkColor', [wp, U(p, 'GetSysColor', [5])]); G(p, 'SetTextColor', [wp, U(p, 'GetSysColor', [8])]); return done(U(p, 'GetSysColorBrush', [5]));   // COLOR_WINDOW, COLOR_WINDOWTEXT
    }
    if (msg === 0x15) { for (const c of [st.mods, st.status]) U(p, 'SendMessageA', [c, 0x15, wp, lp]); U(p, 'InvalidateRect', [h, 0, 1]); return 0; }   // WM_SYSCOLORCHANGE: the common controls told
    if (msg === WM.NOTIFY && p.r32(lp + 4) === ID.MODS && (p.r32(lp + 8) | 0) === -3) {   // NM_DBLCLK: the module run the other way
      guard(() => {
        const i = U(p, 'SendMessageA', [st.mods, LV.GETNEXTITEM, 0xffffffff, 2]) | 0, mods = dbg(p, 'modules'), m = i >= 0 && mods.find(x => x.name === st.names[i]); if (!m) return;   // LVNI_SELECTED
        const js = mods.filter(x => x.js && x.name !== m.name).map(x => x.name); if (!m.js) js.push(m.name);
        run(p, js.length ? 'JS ' + js.join(' ') : 'JS -');
      });
      return done();
    }
    if (msg === WM.COMMAND) {
      const id = wp & 0xffff, code = wp >>> 16;
      if (id === ID.CMD && code === 0x300) {   // EN_CHANGE: a line ended with Enter is a command
        const n = U(p, 'SendMessageA', [st.cmd, WM.GETTEXTLENGTH, 0, 0]); if (!n) return done();
        const b = p.alloc(n + 2); U(p, 'GetWindowTextA', [st.cmd, b, n + 1]); const text = p.readA(b, n + 1) || ''; p.free(b);
        if (!/\r|\n/.test(text)) return done();
        U(p, 'SetWindowTextA', [st.cmd, str(p, 'empty', '')]);
        for (const line of text.split(/\r?\n/)) if (line.trim()) guard(() => run(p, line));
        return done();
      }
      if (code === 0 && id === CMD.REFRESH) { guard(() => listModules(p)); return done(); }
      if (code === 0 && id === CMD.CLEARBP) { guard(() => run(p, 'BC *')); return done(); }
      if (code === 0 && id === CMD.CLS) { setText(p, st.out, ''); return done(); }
      if (code === 0 && id === CMD.HELP) { guard(() => run(p, 'HELP')); return done(); }
      if (code === 0 && id === CMD.EXIT) { U(p, 'DestroyWindow', [h]); return done(); }
      return 0;
    }
    if (msg === WM.DESTROY) { U(p, 'KillTimer', [h, 1]); st.hwnd = 0; st.cmd = 0; U(p, 'PostQuitMessage', [0]); return done(); }
    return 0;
  });
})();
