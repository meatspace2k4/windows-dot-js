// Windows 98 Setup on a 4 by 3 screen in the middle of the machine's, black around it (#mod=setupscreen)
(() => {
  const p = machine.proc, W = self.W95Win32, SETUP = /^(W98SETUP|SUWIN|SETUP)$/i;
  for (const off of p.setupScreenOff || []) off();
  const setup = () => { const t = p.thread16, mod = t && t.task && t.task.mod; return !!(mod && SETUP.test(mod.name || '')); };
  const real = () => { const a = p.scanout(); return [a.w || p.host.width, a.h || p.host.height]; };
  const screen = () => { const [sw, sh] = real(), w = Math.min(sw, Math.floor(sh * 4 / 3)) & ~3, h = w * 3 / 4; return { x: (sw - w) >> 1, y: (sh - h) >> 1, w, h }; };
  const at = k => (p.cpu.ssb.value >>> 0) + (((p.cpu.esp.value & 0xffff) + 4 + k) & 0xffff), arg16 = k => p.r16(at(k));
  const move = (kx, ky) => { const s = screen(); p.w16(at(kx), (p.r16(at(kx)) + s.x) & 0xffff); p.w16(at(ky), (p.r16(at(ky)) + s.y) & 0xffff); };
  const style = h => p.user16(135, [['w', h], ['w', 0xfff0]]).dxax, parent = h => p.user16(46, [['w', h]]).ax;
  // (a window Setup places: a top-level one, or a child of its main window, from the 4 by 3 screen's corner)
  const placed = h => h !== p.setupScreenMain && (!(style(h) & 0x40000000) || parent(h) === p.setupScreenMain);
  const up = () => !!p.setupScreenMain && !!p.user16(47, [['w', p.setupScreenMain]]).ax;   // (Setup's main window there: IsWindow)
  let busy = false, making = false;
  const once = (self_, fn) => { if (busy) return; busy = true; self_.onReturn(() => { busy = false; }); fn(); };
  const offs = [], hook = (mod, ord, fn) => { const m = p.ne && p.ne.get(mod), a = m && p.neExport(m, ord); if (a) offs.push(p.addEntryHook((p.selBase(a >>> 16) + (a & 0xffff)) >>> 0, fn)); };
  hook('USER', 179, function () {   // GetSystemMetrics: SM_CXSCREEN, SM_CYSCREEN
    if (!setup()) return undefined;
    const i = arg16(0); if (i !== 0 && i !== 1) return undefined;
    // (W98SETUP's main window sets its own size the screen's whenever it is placed, WM_WINDOWPOSCHANGING, its calls
    // that return to 3:23Bh and 3:243h: the machine's whole screen there, the black around the 4 by 3 its own)
    const ip = p.r16(at(-4)), t = p.thread16, own = (ip === 0x23b || ip === 0x243) && /^W98SETUP$/i.test(t.task.mod.name || '');
    const s = screen(), [sw, sh] = real(); p.ax(own ? (i ? sh : sw) : i ? s.h : s.w); return p.retf16(2);
  });
  hook('GDI', 80, function () {   // GetDeviceCaps: HORZRES, VERTRES
    if (!setup()) return undefined;
    const i = arg16(0); if (i !== 8 && i !== 10) return undefined;
    const s = screen(); p.ax(i === 10 ? s.h : s.w); return p.retf16(4);
  });
  const create = function () {   // CreateWindow, CreateWindowEx
    if (!setup() || busy) return undefined;
    const s = screen(), kid = !!(arg16(20) & 0x4000);
    if (!kid && !arg16(16) && !arg16(14) && arg16(12) === s.w && arg16(10) === s.h) {
      // Setup's main window, the size of its screen: over the whole of the machine's, its own black around the 4 by 3
      const [sw, sh] = real(); p.w16(at(12), sw); p.w16(at(10), sh);
      making = true; this.onReturn(eax => { making = false; p.setupScreenMain = eax & 0xffff; });
    } else {
      if (kid && making) p.setupScreenMain = arg16(8);   // (a child made as the main window is: its parent is it)
      if (kid ? arg16(8) === p.setupScreenMain : arg16(16) !== 0x8000) once(this, () => move(16, 14));
    }
    return undefined;
  };
  hook('USER', 41, create); hook('USER', 452, create);
  hook('USER', 232, function () {   // SetWindowPos
    if (setup() && !(arg16(0) & 2)) once(this, () => { if (placed(arg16(12))) move(8, 6); });
    return undefined;
  });
  hook('USER', 56, function () {   // MoveWindow
    if (setup()) once(this, () => { if (placed(arg16(10))) move(8, 6); });
    return undefined;
  });
  hook('USER', 33, function () {   // GetClientRect of the main window: the 4 by 3 screen in it
    if (!setup() || arg16(4) !== p.setupScreenMain) return undefined;
    const rc = p.lin(p.r32(at(0)));
    this.onReturn(() => { const s = screen(); p.w16(rc, s.x); p.w16(rc + 2, s.y); p.w16(rc + 4, s.x + s.w); p.w16(rc + 6, s.y + s.h); });
    return undefined;
  });
  hook('USER', 39, function () {   // BeginPaint of the main window, which erases nothing: what is around the 4 by 3, black
    if (!setup() || arg16(4) !== p.setupScreenMain) return undefined;
    this.onReturn(eax => {
      const hdc = eax & 0xffff; if (!hdc) return;
      if (!p.setupScreenRc) { p.setupScreenRcLin = p.alloc(16); p.setupScreenRc = p.allocSels(p.setupScreenRcLin, 16); }
      const s = screen(), [sw, sh] = real(), g = p.neExport(p.ne.get('GDI'), 87), brush = p.call16(g >>> 16, g & 0xffff, [['w', 4]]).ax;
      for (const [l, t, r, b] of [[0, 0, sw, s.y], [0, s.y + s.h, sw, sh], [0, s.y, s.x, s.y + s.h], [s.x + s.w, s.y, sw, s.y + s.h]]) {
        if (r <= l || b <= t) continue;
        [l, t, r, b].forEach((v, i) => p.w16(p.setupScreenRcLin + 2 * i, v));
        p.user16(81, [['w', hdc], ['l', (p.setupScreenRc << 16) >>> 0], ['w', brush]]);   // FillRect
      }
    });
    return undefined;
  });
  // The machine's screen stays as it is while Setup's is up: Setup lays its screen out once and has no answer to a
  // change of the display (its windows left where they were, USER's own moved), so a change asked for is refused,
  // DISP_CHANGE_FAILED, and the page keeps the screen it has (its modeRefused), in the middle of its own
  { const u = p.byName && p.byName.get('USER32'), a = u && u.exports && u.exports.get('ChangeDisplaySettingsA');
    if (a) offs.push(p.addEntryHook(a, function () {
      if (!up()) return undefined;
      const sp = p.cpu.esp.value >>> 0, ret = p.r32(sp); p.cpu.eax.value = 0xffffffff; p.cpu.esp.value = sp + 12; return ret >>> 0;
    })); }
  p.setupScreenOff = offs;
  (self.W95ModOff || (self.W95ModOff = {}))['mod-setupscreen.js'] = () => { for (const off of offs) off(); p.setupScreenOff = []; };
  const s = screen(); W.log('info', 'mod', `setupscreen: ${s.w} by ${s.h} at ${s.x},${s.y} (${offs.length} hooks)`);
})();
