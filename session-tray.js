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
  const NIM = { ADD: 0, MODIFY: 1, DELETE: 2 }, CMD = { WHERE: 1001, FOLLOW: 1002, WINDOW: 2000 };   // (WINDOW + n: the person's nth window)
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
  function icon(p, [r, g, b]) {
    const mask = p.alloc(32), bmi = p.alloc(48), bits = p.alloc(64), info = p.alloc(20);
    FIGURE.forEach((row, y) => {
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

  // (wndproc), as SESSTRAY.EXE's entry calls it: the window, or 0
  def('SESSTRAY', 'Start', 1, function (wndproc) {
    const p = this, inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]), cls = str(p, 'class', 'W95SessionTray'), wc = p.alloc(40);
    for (const [o, v] of [[0, 0], [4, wndproc], [8, 0], [12, 0], [16, inst], [20, 0], [24, 0], [28, 0], [32, 0], [36, cls]]) p.w32(wc + o, v);
    U(p, 'RegisterClassA', [wc]);
    const h = U(p, 'CreateWindowExA', [0, cls, str(p, 'title', 'Session'), 0x80000000, 0, 0, 0, 0, 0, 0, inst, 0]);   // WS_POPUP, never shown
    if (!h) return 0;
    st.hwnd = h; st.pt = p.alloc(8); st.people.clear();
    sync(p);
    return h;
  });
  // (hwnd, msg, wp, lp, &result): 1 for a message it answered
  def('SESSTRAY', 'Handle', 5, function (h, msg, wp, lp, res) {
    const p = this, done = (v = 0) => { p.w32(res, v); return 1; };
    if (h !== st.hwnd) return 0;
    if (msg === WM.PEOPLE) { sync(p); return done(); }
    if (msg === WM.FREE) { const who = st.gone && st.gone.get(wp); if (who) { st.gone.delete(wp); U(p, 'DestroyIcon', [who.icon]); p.free(who.nid); } return done(); }
    if (msg === WM.ICON && (lp === WM.LBUTTONUP || lp === WM.RBUTTONUP)) {
      const who = [...st.people.values()].find(x => x.uid === wp); if (!who) return done();
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
