// DBWIN.DLL, the Debug Monitor's library (DBWIN.EXE imports it; tools/build_dbwin.py), implemented here as the
// system's other stand-ins are (shell32.js, session-tray.js). Start makes the program's window, "Debug Monitor", with
// a read-only multi-line edit filling it; the machine's log (win32.js log: the emulator's messages, programs'
// OutputDebugString, KERNEL's LogError, and the page's lines, which the page sends on, worker.js 'logPut') is
// appended to it as the lines come, each as "level tag: text", as the SDK's DBWIN showed OutputDebugString. The
// window's menu: Edit > Clear, Copy All; Options > Verbose (the debug lines too, off at first, as DevTools' default
// level hides them); Help > About. The first line says whether DevTools are open (the registry's DevTools value, the
// page keeps it current)
(() => {
  if (typeof importScripts !== 'function' || !self.W95Win32) return;   // (the system's machine's worker only)
  const { def, log, regGet } = self.W95Win32;
  const WM = { CREATE: 1, DESTROY: 2, SIZE: 5, SETFOCUS: 7, CLOSE: 0x10, COMMAND: 0x111, SETFONT: 0x30, GETTEXTLENGTH: 0x0e, LINE: 0x8010 };
  const EM = { SETSEL: 0xb1, REPLACESEL: 0xc2, SCROLLCARET: 0xb7, SETLIMITTEXT: 0xc5 }, CMD = { CLEAR: 101, COPY: 102, VERBOSE: 201, ABOUT: 301 };
  const st = self.W95DbWinState = { hwnd: 0, edit: 0, verbose: false, pending: [], off: null, seen: 0 };
  const fn = (p, dll, nm) => { const m = p.byName.get(dll); return m && m.exports.get(nm); };
  const U = (p, nm, args) => p.call(fn(p, 'USER32', nm), args), G = (p, nm, args) => p.call(fn(p, 'GDI32', nm), args);
  const bufs = new Map(), str = (p, use, s) => {
    let b = bufs.get(use);
    if (!b || b.cap < s.length + 1) { if (b) p.free(b.at); b = { cap: Math.max(64, s.length + 1), at: 0 }; b.at = p.alloc(b.cap); bufs.set(use, b); }
    p.writeA(b.at, s); return b.at;
  };
  const fmt = l => `${l.level === 'warn' ? 'warning' : l.level}${l.machine && l.machine !== 'system' ? ` ${l.machine}` : ''} ${l.tag}: ${l.text}\r\n`;
  /** the lines waiting, appended to the edit (one WM_LINE per batch: the log is written from any thread, the edit is the window's) */
  function flush(p) {
    if (!st.edit || !st.pending.length) return;
    const text = st.pending.splice(0).filter(l => st.verbose || l.level !== 'debug').map(fmt).join('');
    if (!text) return;
    const n = U(p, 'SendMessageA', [st.edit, WM.GETTEXTLENGTH, 0, 0]);
    if (n > 60000) { U(p, 'SendMessageA', [st.edit, EM.SETSEL, 0, 20000]); U(p, 'SendMessageA', [st.edit, EM.REPLACESEL, 0, str(p, 'empty', '')]); }   // (the oldest fifth dropped when the control is full)
    U(p, 'SendMessageA', [st.edit, EM.SETSEL, 0x7fffffff, 0x7fffffff]);
    U(p, 'SendMessageA', [st.edit, EM.REPLACESEL, 0, str(p, 'line', text)]);
    U(p, 'SendMessageA', [st.edit, EM.SCROLLCARET, 0, 0]);
  }
  function menu(p) {
    const edit = U(p, 'CreatePopupMenu', []), opts = U(p, 'CreatePopupMenu', []), help = U(p, 'CreatePopupMenu', []), bar = U(p, 'CreateMenu', []);
    U(p, 'AppendMenuA', [edit, 0, CMD.CLEAR, str(p, 'm1', 'C&lear')]); U(p, 'AppendMenuA', [edit, 0, CMD.COPY, str(p, 'm2', 'Copy &All')]);
    U(p, 'AppendMenuA', [opts, st.verbose ? 8 : 0, CMD.VERBOSE, str(p, 'm3', '&Verbose')]);   // (MF_CHECKED)
    U(p, 'AppendMenuA', [help, 0, CMD.ABOUT, str(p, 'm4', '&About Debug Monitor...')]);
    U(p, 'AppendMenuA', [bar, 0x10, edit, str(p, 'm5', '&Edit')]); U(p, 'AppendMenuA', [bar, 0x10, opts, str(p, 'm6', '&Options')]); U(p, 'AppendMenuA', [bar, 0x10, help, str(p, 'm7', '&Help')]);   // (MF_POPUP)
    return bar;
  }
  // (wndproc), as DBWIN.EXE's entry calls it: the window, or 0
  def('DBWIN', 'Start', 1, function (wndproc) {
    const p = this, inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]), cls = str(p, 'class', 'W95DebugMonitor'), wc = p.alloc(40);
    const icon = U(p, 'LoadIconA', [0, 32516]), cursor = U(p, 'LoadCursorA', [0, 32512]);   // (IDI_WINLOGO, IDC_ARROW)
    for (const [o, v] of [[0, 0], [4, wndproc], [8, 0], [12, 0], [16, inst], [20, icon], [24, cursor], [28, 16], [32, 0], [36, cls]]) p.w32(wc + o, v);   // (COLOR_BTNFACE+1)
    U(p, 'RegisterClassA', [wc]);
    const sw = U(p, 'GetSystemMetrics', [0]), sh = U(p, 'GetSystemMetrics', [1]), w = Math.min(560, sw - 40), h = Math.min(320, sh - 80);
    const hm = menu(p);
    const hwnd = U(p, 'CreateWindowExA', [0, cls, str(p, 'title', 'Debug Monitor'), 0x00cf0000, sw - w - 20, 40, w, h, 0, hm, inst, 0]);   // WS_OVERLAPPEDWINDOW
    if (!hwnd) return 0;
    st.hwnd = hwnd; st.menu = hm;
    const r = p.alloc(16); U(p, 'GetClientRect', [hwnd, r]);
    st.edit = U(p, 'CreateWindowExA', [0x200, str(p, 'ecls', 'EDIT'), 0, 0x50b008c4, 0, 0, p.r32(r + 8), p.r32(r + 12), hwnd, 1, inst, 0]);   // WS_EX_CLIENTEDGE; WS_CHILD|WS_VISIBLE|WS_VSCROLL|WS_HSCROLL|ES_MULTILINE|ES_AUTOVSCROLL|ES_AUTOHSCROLL|ES_READONLY
    p.free(r);
    U(p, 'SendMessageA', [st.edit, WM.SETFONT, G(p, 'GetStockObject', [11]), 0]);   // (ANSI_FIXED_FONT)
    U(p, 'SendMessageA', [st.edit, EM.SETLIMITTEXT, 0x7fffffff, 0]);
    const dt = regGet('hklm\\software\\microsoft\\windows\\currentversion\\debug', 'DevTools');
    st.pending.push({ level: 'info', tag: 'dbwin', text: `Debug Monitor. DevTools are ${dt && dt.data && dt.data[0] ? 'open' : 'closed'}; the same lines are in their console at their levels.` });
    for (const l of log.lines(0)) st.pending.push(l);
    st.off = log.watch(line => { st.pending.push(line); if (st.hwnd && !st.posted) { st.posted = true; U(p, 'PostMessageA', [st.hwnd, WM.LINE, 0, 0]); } });
    U(p, 'PostMessageA', [hwnd, WM.LINE, 0, 0]); st.posted = true;
    U(p, 'ShowWindow', [hwnd, 1]); U(p, 'UpdateWindow', [hwnd]);
    return hwnd;
  });
  // (hwnd, msg, wp, lp, &result): 1 for a message it answered
  def('DBWIN', 'Handle', 5, function (h, msg, wp, lp, res) {
    const p = this, done = (v = 0) => { p.w32(res, v); return 1; };
    if (h !== st.hwnd) return 0;
    if (msg === WM.LINE) { st.posted = false; flush(p); return done(); }
    if (msg === WM.SIZE) { if (st.edit) U(p, 'MoveWindow', [st.edit, 0, 0, lp & 0xffff, lp >>> 16, 1]); return done(); }
    if (msg === WM.SETFOCUS) { if (st.edit) U(p, 'SetFocus', [st.edit]); return done(); }
    if (msg === WM.COMMAND) {
      const id = wp & 0xffff;
      if (id === CMD.CLEAR) { U(p, 'SetWindowTextA', [st.edit, str(p, 'empty', '')]); return done(); }
      if (id === CMD.COPY) { U(p, 'SendMessageA', [st.edit, EM.SETSEL, 0, -1]); U(p, 'SendMessageA', [st.edit, 0x301, 0, 0]); return done(); }   // (WM_COPY)
      if (id === CMD.VERBOSE) { st.verbose = !st.verbose; U(p, 'CheckMenuItem', [st.menu, CMD.VERBOSE, st.verbose ? 8 : 0]); return done(); }
      if (id === CMD.ABOUT) { U(p, 'MessageBoxA', [h, str(p, 'about', 'Debug Monitor shows what Windows and its programs write to the debug output (OutputDebugString), and the messages of the machine running them.\n\nThe same lines are in the browser\'s DevTools console, at their levels (Option+Cmd+I).'), str(p, 'title', 'Debug Monitor'), 0x40]); return done(); }
      return 0;
    }
    if (msg === WM.DESTROY) { if (st.off) st.off(); st.off = null; st.hwnd = 0; st.edit = 0; U(p, 'PostQuitMessage', [0]); return done(); }
    return 0;
  });
})();
