// SESSTRAY.DLL, the shared session's notification-area program's library (SESSTRAY.EXE imports it;
// tools/build_sesstray.py), implemented here as the system's other stand-ins are (shell32.js). Start makes the
// program's hidden window; each other person in the session has an icon in the taskbar's notification area, a figure
// in their colour, with their name as its tip, put there by the program's own code (Shell_NotifyIconA, WM_APP+6).
// Clicking one shows that person's menu (their name; Where Is: their pointer marked on this screen). Who is here
// comes from the page (worker.js 'tray': self.W95TrayPeople), told to the window as WM_APP+5.
(() => {
  if (typeof importScripts !== 'function' || !self.W95Win32) return;   // (the system's machine's worker only)
  const { def } = self.W95Win32;
  const WM = { DESTROY: 2, COMMAND: 0x111, LBUTTONUP: 0x202, RBUTTONUP: 0x205, POPUP: 0x8002, ICON: 0x8003, PEOPLE: 0x8005, NOTIFY: 0x8006, FREE: 0x8007 };
  const NIM = { ADD: 0, MODIFY: 1, DELETE: 2 }, CMD = { WHERE: 1001, FOLLOW: 1002, WINDOW: 2000, MARK: 3001, ANCHOR: 3002, TRAVEL: 3100 };   // (WINDOW + n: the person's nth window; TRAVEL + n: the nth moment)
  // the Braid icon (its own uid, past any person's): the session's line from inside Windows. Its menu marks or anchors
  // a moment, or travels to one, as the session's (every machine's, at one place in the session's history: the page
  // makes the choice, braid-page.js viaLine); the moments come from the page (W95TrayMoments, with the people)
  const BRAID_UID = 0x7fff;
  const HOURGLASS = [
    '................', '..############..', '..############..', '...##......##...', '....##....##....', '.....##..##.....', '......####......', '.......##.......',
    '.......##.......', '......####......', '.....######.....', '....########....', '...##########...', '..############..', '..############..', '................'];
  const st = self.W95TrayState = { hwnd: 0, people: new Map(), uid: 1, pt: 0, menuFor: null, menuWins: [], following: null };
  const fn = (p, dll, nm) => { const m = p.byName.get(dll); return m && m.exports.get(nm); };
  const U = (p, nm, args) => p.call(fn(p, 'USER32', nm), args), G = (p, nm, args) => p.call(fn(p, 'GDI32', nm), args);
  // a string in the program's memory, one buffer per use, grown as the text grows
  const bufs = new Map(), str = (p, use, s) => {
    let b = bufs.get(use);
    if (!b || b.cap < s.length + 1) { if (b) p.free(b.at); b = { cap: Math.max(64, s.length + 1), at: 0 }; b.at = p.alloc(b.cap); bufs.set(use, b); }
    p.writeA(b.at, s); return b.at;
  };

  // a person's figure, 16 by 16: a head and shoulders in their colour, the rest of the icon clear (its mask: 1)
  const FIGURE = [
    '................', '......####......', '.....######.....', '.....######.....', '.....######.....', '......####......', '.......##.......', '....########....',
    '...##########...', '..############..', '..############..', '..############..', '..############..', '..############..', '..############..', '................'];
  function icon(p, [r, g, b], shape = FIGURE) {
    const mask = p.alloc(32), bmi = p.alloc(48), bits = p.alloc(64), info = p.alloc(20);
    shape.forEach((row, y) => {
      let m = 0xffff, c = 0;
      for (let x = 0; x < 16; x++) if (row[x] === '#') { m &= ~(0x8000 >> x); c |= 0x8000 >> x; }
      p.u8[mask + 2 * y] = m >> 8; p.u8[mask + 2 * y + 1] = m & 0xff;                       // (a bitmap's rows, top first)
      p.u8[bits + 4 * (15 - y)] = c >> 8; p.u8[bits + 4 * (15 - y) + 1] = c & 0xff;           // (a DIB's, bottom first, to 4 bytes)
    });
    // BITMAPINFOHEADER (16 by 16, one plane, 1 bit) and its two colours: clear (black), the person's
    p.u8.fill(0, bmi, bmi + 48); p.w32(bmi, 40); p.w32(bmi + 4, 16); p.w32(bmi + 8, 16); p.w16(bmi + 12, 1); p.w16(bmi + 14, 1);
    p.u8[bmi + 44] = b; p.u8[bmi + 45] = g; p.u8[bmi + 46] = r;
    const dc = U(p, 'GetDC', [0]), color = G(p, 'CreateDIBitmap', [dc, bmi, 4, bits, bmi, 0]);   // CBM_INIT, DIB_RGB_COLORS
    U(p, 'ReleaseDC', [0, dc]);
    const hmask = G(p, 'CreateBitmap', [16, 16, 1, 1, mask]);
    p.w32(info, 1); p.w32(info + 4, 0); p.w32(info + 8, 0); p.w32(info + 12, hmask); p.w32(info + 16, color);   // ICONINFO: an icon
    const h = U(p, 'CreateIconIndirect', [info]);
    G(p, 'DeleteObject', [hmask]); G(p, 'DeleteObject', [color]);
    for (const a of [mask, bmi, bits, info]) p.free(a);
    return h || U(p, 'LoadIconA', [0, 32512]);
  }
  // NOTIFYICONDATAA: cbSize, hWnd, uID, uFlags (message, icon, tip), uCallbackMessage, hIcon, szTip[64]
  function nid(p, who) {
    const d = who.nid || (who.nid = p.alloc(88));
    p.u8.fill(0, d, d + 88); p.w32(d, 88); p.w32(d + 4, st.hwnd); p.w32(d + 8, who.uid); p.w32(d + 12, 7); p.w32(d + 16, WM.ICON); p.w32(d + 20, who.icon);
    p.writeA(d + 24, String(who.user).slice(0, 63)); return d;
  }
  /** the people here, as the page last told: each one's icon added, renamed or taken away */
  function sync(p) {
    const want = new Map((self.W95TrayPeople || []).map(x => [x.client, x]));
    for (const [client, who] of st.people) if (!want.has(client)) {
      st.people.delete(client); U(p, 'PostMessageA', [st.hwnd, WM.NOTIFY, NIM.DELETE, who.nid]);
      (st.gone || (st.gone = new Map())).set(who.uid, who); U(p, 'PostMessageA', [st.hwnd, WM.FREE, who.uid, 0]);   // (its buffers freed once the icon has gone)
    }
    for (const [client, x] of want) {
      const who = st.people.get(client);
      if (!who) { const w = { client, user: x.user, uid: st.uid++, icon: icon(p, x.color || [0, 0, 128]) }; st.people.set(client, w); U(p, 'PostMessageA', [st.hwnd, WM.NOTIFY, NIM.ADD, nid(p, w)]); }
      else if (who.user !== x.user) { who.user = x.user; U(p, 'PostMessageA', [st.hwnd, WM.NOTIFY, NIM.MODIFY, nid(p, who)]); }
      st.people.get(client).wins = x.wins || [];   // (the windows they opened, for their menu)
    }
  }

  // the Turbo icon (a gauge): the machine's own speed, opened as a window of Windows' own (its caption and frame USER's,
  // its face painted with GDI): how much of each 8 s of the wall's time the machine spends running its threads (ne16.js
  // threads16's switchMs.run, as the page's speed meter reads it), as a smooth progress bar, and how far its clock moves
  // meanwhile (the worker's vclock, which braid.speed stretches)
  const METER_UID = 0x7ffe, METER_TIMER = 1, METER_WINDOW = 8000;
  const GAUGE = [
    '................', '................', '.....######.....', '...##......##...', '..#..........#..', '.#............#.', '.#.......##...#.', '#.......##.....#',
    '#......##......#', '#.....###......#', '#.....###......#', '.#............#.', '..############..', '................', '................', '................'];
  const meterSample = () => {
    const m = typeof machine !== 'undefined' && machine, p = m && m.proc, sw = p && p.switchMs;
    return [performance.now(), sw ? sw.run : 0, m && m.vclock ? m.vclock.now : 0];
  };
  function meterOpen(p) {
    if (st.meterHwnd && U(p, 'IsWindow', [st.meterHwnd])) { U(p, 'ShowWindow', [st.meterHwnd, 5]); U(p, 'SetForegroundWindow', [st.meterHwnd]); return; }
    const inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]), w = 220, hh = 104;
    const sx = U(p, 'GetSystemMetrics', [0]), sy = U(p, 'GetSystemMetrics', [1]);
    // WS_EX_TOPMOST | WS_EX_TOOLWINDOW; WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE: by the taskbar's corner, over the rest
    st.meterHwnd = U(p, 'CreateWindowExA', [0x88, str(p, 'class', 'W95SessionTray'), str(p, 'mtitle', 'Machine Speed'), 0x90C80000, sx - w - 8, sy - hh - 40, w, hh, 0, 0, inst, 0]);
    st.meterSamples = [meterSample()]; st.meterRun = null; st.meterMach = null;
    if (st.meterHwnd) U(p, 'SetTimer', [st.meterHwnd, METER_TIMER, 1000, 0]);
  }
  function meterPaint(p, h) {
    const ps = st.meterPs || (st.meterPs = p.alloc(64)), rc = st.meterRc || (st.meterRc = p.alloc(16));
    const dc = U(p, 'BeginPaint', [h, ps]);
    U(p, 'GetClientRect', [h, rc]); const cw = p.r32(rc + 8), ch = p.r32(rc + 12);
    U(p, 'FillRect', [dc, rc, 16]);                                                     // COLOR_BTNFACE + 1
    const old = G(p, 'SelectObject', [dc, G(p, 'GetStockObject', [17])]);              // DEFAULT_GUI_FONT
    G(p, 'SetBkMode', [dc, 1]); G(p, 'SetTextColor', [dc, U(p, 'GetSysColor', [18])]);  // TRANSPARENT; COLOR_BTNTEXT
    const out = (s, x, y) => G(p, 'TextOutA', [dc, x, y, str(p, `m${x}${y}`, s), s.length]);
    out('Turbo', 10, 8);
    const bx = 10, by = 26, bw = cw - 20, bh = 18;
    p.w32(rc, bx); p.w32(rc + 4, by); p.w32(rc + 8, bx + bw); p.w32(rc + 12, by + bh);
    U(p, 'DrawEdge', [dc, rc, 2, 0x0f]);                                                // BDR_SUNKENOUTER, BF_RECT: the progress bar's well
    if (st.meterRun !== null) {
      const fw = Math.round((bw - 4) * Math.min(1, st.meterRun / 8));
      if (fw > 0) { p.w32(rc, bx + 2); p.w32(rc + 4, by + 2); p.w32(rc + 8, bx + 2 + fw); p.w32(rc + 12, by + bh - 2); U(p, 'FillRect', [dc, rc, 14]); }   // COLOR_HIGHLIGHT + 1
    }
    const l = st.meterRun === null ? '...' : `${st.meterRun.toFixed(1)} s run`, r = st.meterMach === null ? '' : `${st.meterMach.toFixed(1)} s machine`;
    out(l, bx, by + bh + 8);
    if (r) { const sz = st.meterSz || (st.meterSz = p.alloc(8)); G(p, 'GetTextExtentPoint32A', [dc, str(p, 'mr', r), r.length, sz]); out(r, bx + bw - p.r32(sz), by + bh + 8); }
    G(p, 'SelectObject', [dc, old]);
    U(p, 'EndPaint', [h, ps]);
    void ch;
  }
  function meterTick(p, h) {
    const s = st.meterSamples || (st.meterSamples = []), t = meterSample(); s.push(t);
    while (s.length > 1 && t[0] - s[0][0] > METER_WINDOW) s.shift();
    if (s.length > 1) { const [w0, r0, m0] = s[0], [w1, r1, m1] = s[s.length - 1], k = METER_WINDOW / (w1 - w0); st.meterRun = (r1 - r0) * k / 1000; st.meterMach = (m1 - m0) * k / 1000; }
    U(p, 'InvalidateRect', [h, 0, 0]);
  }

  // (wndproc), as SESSTRAY.EXE's entry calls it: the window, or 0
  def('SESSTRAY', 'Start', 1, function (wndproc) {
    const p = this, inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]), cls = str(p, 'class', 'W95SessionTray'), wc = p.alloc(40);
    for (const [o, v] of [[0, 0], [4, wndproc], [8, 0], [12, 0], [16, inst], [20, 0], [24, 0], [28, 0], [32, 0], [36, cls]]) p.w32(wc + o, v);
    U(p, 'RegisterClassA', [wc]);
    const h = U(p, 'CreateWindowExA', [0, cls, str(p, 'title', 'Session'), 0x80000000, 0, 0, 0, 0, 0, 0, inst, 0]);   // WS_POPUP, never shown
    if (!h) return 0;
    st.hwnd = h; st.pt = p.alloc(8); st.people.clear();
    sync(p);
    st.braid = { user: 'Braid: the session\'s line', uid: BRAID_UID, icon: icon(p, [128, 0, 128], HOURGLASS) };
    U(p, 'PostMessageA', [h, WM.NOTIFY, NIM.ADD, nid(p, st.braid)]);
    st.meter = { user: 'Turbo: the machine\'s speed', uid: METER_UID, icon: icon(p, [0, 0, 128], GAUGE) };
    U(p, 'PostMessageA', [h, WM.NOTIFY, NIM.ADD, nid(p, st.meter)]);
    return h;
  });
  // (hwnd, msg, wp, lp, &result): 1 for a message it answered
  def('SESSTRAY', 'Handle', 5, function (h, msg, wp, lp, res) {
    const p = this, done = (v = 0) => { p.w32(res, v); return 1; };
    if (st.meterHwnd && h === st.meterHwnd) {   // the Turbo window: painted here, its figures every second; closed, it is hidden
      if (msg === 0x0f) { meterPaint(p, h); return done(); }                               // WM_PAINT
      if (msg === 0x113 && wp === METER_TIMER) { meterTick(p, h); return done(); }         // WM_TIMER
      if (msg === 0x10) { U(p, 'ShowWindow', [h, 0]); return done(); }                      // WM_CLOSE
      return 0;
    }
    if (h !== st.hwnd) return 0;
    if (msg === WM.ICON && (lp === WM.LBUTTONUP || lp === WM.RBUTTONUP) && wp === METER_UID) { meterOpen(p); return done(); }
    if (msg === WM.PEOPLE) { sync(p); return done(); }
    if (msg === WM.FREE) { const who = st.gone && st.gone.get(wp); if (who) { st.gone.delete(wp); U(p, 'DestroyIcon', [who.icon]); p.free(who.nid); } return done(); }
    if (msg === WM.ICON && (lp === WM.LBUTTONUP || lp === WM.RBUTTONUP) && wp === BRAID_UID) {
      const m = U(p, 'CreatePopupMenu', []);
      U(p, 'AppendMenuA', [m, 1, 0, str(p, 'bname', 'Braid: the session\'s line')]);           // (grayed: what it is)
      U(p, 'AppendMenuA', [m, 0x800, 0, 0]);
      U(p, 'AppendMenuA', [m, 0, CMD.MARK, str(p, 'bmark', '&Mark Now')]);
      U(p, 'AppendMenuA', [m, 0, CMD.ANCHOR, str(p, 'banchor', '&Anchor Now')]);
      const ms = (self.W95TrayMoments || []).slice(0, 20); st.menuMoments = ms;
      const sub = U(p, 'CreatePopupMenu', []);
      if (!ms.length) U(p, 'AppendMenuA', [sub, 1, 0, str(p, 'bnone', '(no moments yet)')]);
      ms.forEach((x, i) => U(p, 'AppendMenuA', [sub, 0, CMD.TRAVEL + i, str(p, `bm${i}`, `${String(x.name).replace(/&/g, '&&').slice(0, 48)}${x.anchored ? '  (anchored)' : ''}${x.broken ? '  (broken)' : ''}`)]));
      U(p, 'AppendMenuA', [m, 0x10, sub, str(p, 'btravel', '&Travel To')]);   // (MF_POPUP)
      U(p, 'SetForegroundWindow', [h]); U(p, 'GetCursorPos', [st.pt]);
      U(p, 'PostMessageA', [h, WM.POPUP, m, st.pt]);
      return done();
    }
    if (msg === WM.COMMAND && (wp & 0xffff) === CMD.MARK) { self.postMessage({ t: 'trayBraid', op: 'mark' }); return done(); }
    if (msg === WM.COMMAND && (wp & 0xffff) === CMD.ANCHOR) { self.postMessage({ t: 'trayBraid', op: 'anchor' }); return done(); }
    if (msg === WM.COMMAND && (wp & 0xffff) >= CMD.TRAVEL && (wp & 0xffff) < CMD.TRAVEL + 100) { const x = (st.menuMoments || [])[(wp & 0xffff) - CMD.TRAVEL]; if (x) self.postMessage({ t: 'trayBraid', op: 'travel', name: x.name }); return done(); }
    if (msg === WM.ICON && (lp === WM.LBUTTONUP || lp === WM.RBUTTONUP)) {
      const who =[...st.people.values()].find(x => x.uid === wp); if (!who) return done();
      const m = U(p, 'CreatePopupMenu', []);
      U(p, 'AppendMenuA', [m, 1, 0, str(p, 'name', who.user)]);                         // MF_GRAYED: their name
      U(p, 'AppendMenuA', [m, 0x800, 0, 0]);                                           // a separator
      U(p, 'AppendMenuA', [m, 0, CMD.WHERE, str(p, 'where', `&Where Is ${who.user}?`)]);
      // Follow: their pointer marked on this screen until Follow is chosen again (checked while it is)
      U(p, 'AppendMenuA', [m, st.following === who.client ? 8 : 0, CMD.FOLLOW, str(p, 'follow', `&Follow ${who.user}`)]);
      // the windows they opened (the session's objects whose origin is their machine, from the page: W95TrayPeople),
      // each brought to the front here when chosen
      const wins = (who.wins || []).slice(0, 20); st.menuWins = wins;
      if (wins.length) {
        const sub = U(p, 'CreatePopupMenu', []);
        wins.forEach((w, i) => U(p, 'AppendMenuA', [sub, 0, CMD.WINDOW + i, str(p, `win${i}`, String(w.title || w.id).replace(/&/g, '&&').slice(0, 60))]));
        U(p, 'AppendMenuA', [m, 0x10, sub, str(p, 'wins', `${who.user}'s &Windows`)]);   // (MF_POPUP)
      }
      U(p, 'AppendMenuA', [m, 0x800, 0, 0]);
      U(p, 'AppendMenuA', [m, 1, 0, str(p, 'owner', `Settings changes go to ${(self.W95TrayOwner || 'the session owner')}'s profile`)]);   // (grayed: the session's one HKCU)
      st.menuFor = who.client;
      U(p, 'SetForegroundWindow', [h]); U(p, 'GetCursorPos', [st.pt]);                  // (as a notification-area menu is tracked: its window in front, at the pointer)
      U(p, 'PostMessageA', [h, WM.POPUP, m, st.pt]);
      return done();
    }
    if (msg === WM.COMMAND && (wp & 0xffff) === CMD.WHERE) { self.postMessage({ t: 'trayWhere', client: st.menuFor }); return done(); }
    if (msg === WM.COMMAND && (wp & 0xffff) === CMD.FOLLOW) { st.following = st.following === st.menuFor ? null : st.menuFor; self.postMessage({ t: 'trayFollow', client: st.following }); return done(); }
    if (msg === WM.COMMAND && (wp & 0xffff) >= CMD.WINDOW && (wp & 0xffff) < CMD.WINDOW + 100) { const w = st.menuWins[(wp & 0xffff) - CMD.WINDOW]; if (w) self.postMessage({ t: 'trayWindow', id: w.id, client: st.menuFor }); return done(); }
    if (msg === WM.DESTROY) { st.hwnd = 0; U(p, 'PostQuitMessage', [0]); return done(); }
    return 0;
  });
})();
