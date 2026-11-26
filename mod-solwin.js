// Solitaire's Game menu has Win! (W its access key: Alt+G, W), which wins the game as Solitaire itself wins one
// (#mod=solwin; by hand, sysApp.cmd('reload', ['mod-solwin.js'])). Nothing is drawn by the page: the item is put in
// the menu Solitaire owns as Solitaire opens it, its command comes to Solitaire's window as any menu command does, and
// the win is Solitaire's own code run on its own game, as after the last card goes home.
//
// What it runs on, read from SOL.EXE (Windows 95's, 16-bit) and checked on the running program:
//   - the window procedure (class "Solitaire", seg 1:040Ch) takes WM_INITMENU (the Game menu opening: the item is put
//     before Exit there) and WM_COMMAND (an id it does not know goes to DefWindowProc: Win!'s is seen first here)
//   - DS:0018h is the game (Klondike): its procedure, a far pointer at +0, and its 13 piles' pointers from +36h: the
//     deck, the discard, the four foundations, the seven of the tableau. A pile: its rectangle from +6, its count of
//     cards at +10h (a foundation holds 13), its cards from +14h, 6 bytes each: the card (rank * 4 + suit: clubs,
//     diamonds, hearts, spades; 8000h face up) and where it is (x, y)
//   - after a card is played the game asks its procedure message 0Ch (each foundation 13 cards: won) and, won, message
//     0Dh: the bouncing cards from the foundations (seg 4:10C4h), then "Deal again?"
// Win! makes the four foundations whole (each a suit, ace to king, face up, where the foundation is), empties the
// other piles, has the window redrawn, asks the game's procedure 0Ch, and has Solitaire's window procedure go on as
// the game's procedure with 0Dh, as Solitaire does after a card (playWin).
(() => {
  const p = machine.proc, W = self.W95Win32;
  const offs = self.W95ModOff || (self.W95ModOff = {});
  if (offs['mod-solwin.js']) offs['mod-solwin.js']();   // (loaded again: the last one's hooks ended first)
  const ID = 1010, EXIT = 1004, WM_INITMENU = 0x116, WM_COMMAND = 0x111, TEXT = '&Win!';
  const user = p.ne && p.ne.get('USER');
  if (!user) { W.log('warn', 'mod', 'solwin: no USER'); return; }
  const u16 = (ord, args) => p.user16(ord, args);
  // (the item's text, kept where a far pointer reaches it: InsertMenu copies it)
  const lin = p.alloc(16), sel = p.allocSels(lin, 16);
  for (let i = 0; i < TEXT.length; i++) p.u8[lin + i] = TEXT.charCodeAt(i); p.u8[lin + TEXT.length] = 0;
  const far = (sel << 16) >>> 0;
  // the 16-bit stack at a hooked entry: its arguments from past the far return address
  const at = k => (p.cpu.ssb.value >>> 0) + (((p.cpu.esp.value & 0xffff) + 4 + k) & 0xffff);
  const lin16 = fp => (fp >>> 16) && p.selValid(fp >>> 16) ? (p.selBase(fp >>> 16) + (fp & 0xffff)) >>> 0 : 0;

  /** the Game menu (the menu bar's first) has Win!, before Exit */
  const ensureItem = hmenu => {
    const game = u16(159, [['w', hmenu], ['w', 0]]).ax;                                               // GetSubMenu
    if (!game) return;
    if ((u16(250, [['w', game], ['w', ID], ['w', 0]]).ax & 0xffff) !== 0xffff) return;              // GetMenuState(MF_BYCOMMAND): there already
    u16(410, [['w', game], ['w', EXIT], ['w', 0], ['w', ID], ['l', far]]);                            // InsertMenu(MF_BYCOMMAND | MF_STRING)
  };

  /** the game made won, and asked whether it is (message 0Ch, a short call made here): { proc, g, ds } when it is */
  const win = hwnd => {
    const ds = u16(133, [['w', hwnd], ['w', 0xfffa]]).ax;                                             // GetWindowWord(GWW_HINSTANCE): its DGROUP
    if (!ds || !p.selValid(ds)) { W.log('warn', 'mod', 'solwin: no data segment'); return; }
    const b = p.selBase(ds) >>> 0, g = p.r16(b + 0x18); if (!g) return;
    const proc = p.r32(b + g) >>> 0, piles = [];
    for (let i = 0; i < 13; i++) { const q = p.r16(b + g + 0x36 + 2 * i); if (q) piles.push(b + q); }
    if (piles.length !== 13 || !(proc >>> 16)) { W.log('warn', 'mod', `solwin: not Klondike's game (${piles.length} piles)`); return; }
    piles.forEach((pile, i) => {
      if (i < 2 || i > 5) { p.w16(pile + 0x10, 0); return; }
      const suit = i - 2, x = p.r16(pile + 6), y = p.r16(pile + 8);
      for (let r = 0; r < 13; r++) { const c = pile + 0x14 + 6 * r; p.w16(c, 0x8000 | (r * 4 + suit)); p.w16(c + 2, x); p.w16(c + 4, y); }
      p.w16(pile + 0x10, 13);
    });
    u16(125, [['w', hwnd], ['l', 0], ['w', 1]]); u16(124, [['w', hwnd]]);                              // InvalidateRect, UpdateWindow
    const won = p.call16(proc >>> 16, proc & 0xffff, [['w', g], ['w', 0x0c], ['l', 0]], { ds }).ax;
    if (!won) { W.log('warn', 'mod', 'solwin: Solitaire does not see a won game'); return null; }
    W.log('info', 'mod', 'solwin: the game is won; Solitaire plays its win (0Dh)');
    return { proc, g, ds };
  };
  // The win itself (message 0Dh: the bouncing cards until a click or Esc, then "Deal again?" and its dialog's own
  // loop) runs as Solitaire's code on its own thread, not inside a call the host makes: the window procedure's call is
  // made a call of the game's procedure in its place, the same caller and return. The procedure takes 8 bytes of
  // arguments (the game, the message, a long 0) where the window procedure took 10 (hwnd, msg, wParam, lParam): the
  // return address goes up 2 bytes, and the arguments under it, so the procedure's RETF 8 leaves the caller's stack
  // as the window procedure's RETF 10 would. AX, the procedure's answer, is the window procedure's result
  const playWin = r => {
    const ssb = p.cpu.ssb.value >>> 0, sp = p.cpu.esp.value & 0xffff, ip = p.r16(ssb + sp), cs = p.r16(ssb + sp + 2), sp2 = (sp + 2) & 0xffff;
    p.w16(ssb + sp2, ip); p.w16(ssb + sp2 + 2, cs); p.w32(ssb + sp2 + 4, 0); p.w16(ssb + sp2 + 8, 0x0d); p.w16(ssb + sp2 + 10, r.g);
    p.cpu.esp.value = ((p.cpu.esp.value & 0xffff0000) | sp2) >>> 0;
    p.seg('ds', r.ds); p.seg('cs', r.proc >>> 16);
    return (p.selBase(r.proc >>> 16) + (r.proc & 0xffff)) >>> 0;
  };

  const hooked = new Map();   // the window procedures hooked: linear -> its hook's end
  const hookProc = fp => {
    const a = lin16(fp); if (!a || hooked.has(a)) return;
    hooked.set(a, p.addEntryHook(a, function () {
      const msg = p.r16(at(6)), wp = p.r16(at(4)), hwnd = p.r16(at(8));
      try {
        if (msg === WM_INITMENU) ensureItem(wp);
        else if (msg === WM_COMMAND && wp === ID) { const r = win(hwnd); if (r) return playWin(r); }
      } catch (e) { W.log('error', 'mod', `solwin: ${e && e.message}`); }
      return undefined;
    }));
  };
  // Solitaire's class as it registers it (RegisterClass's WNDCLASS: lpfnWndProc at +2, lpszClassName at +22)
  const reg = p.neExport(user, 57), offs16 = [];
  if (reg) offs16.push(p.addEntryHook((p.selBase(reg >>> 16) + (reg & 0xffff)) >>> 0, function () {
    const wc = lin16(p.r32(at(0)) >>> 0); if (!wc) return undefined;
    const name = lin16(p.r32(wc + 22) >>> 0);
    if (name && /^Solitaire$/i.test(p.readA(name, 32) || '')) hookProc(p.r32(wc + 2) >>> 0);
    return undefined;
  }));
  // (a Solitaire already running: its window's procedure, GetWindowLong(GWL_WNDPROC))
  try {
    const h = u16(50, [['l', (() => { const n = p.alloc(16), s = p.allocSels(n, 16); 'Solitaire'.split('').forEach((c, i) => { p.u8[n + i] = c.charCodeAt(0); }); p.u8[n + 9] = 0; return (s << 16) >>> 0; })()], ['l', 0]]).ax;   // FindWindow
    if (h) hookProc(u16(135, [['w', h], ['w', 0xfffc]]).dxax >>> 0);
  } catch (e) { W.log('warn', 'mod', `solwin: ${e && e.message}`); }
  offs['mod-solwin.js'] = () => { for (const off of offs16) off(); for (const off of hooked.values()) off(); hooked.clear(); };
  W.log('info', 'mod', `solwin: Game > Win! in Solitaire${hooked.size ? ' (the running one too)' : ''}`);
})();
