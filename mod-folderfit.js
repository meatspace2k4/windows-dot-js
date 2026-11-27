// Folder windows open at one size, large enough that an ordinary folder shows without scroll bars: Explorer's own
// windows (CabinetWClass, ExploreWClass) are given it before anything of them is drawn, and the icons are arranged
// into it. Explorer makes the frame at USER's default size (CW_USEDEFAULT, a third of a 640 by 480 screen: My Computer's
// ten icons and the web view's pane both scrolled) and then places it, still hidden, where the folder was left
// (SetWindowPlacement): the first is given the size and a place, the second keeps its place and takes the size. No
// window is moved or sized after it shows.
// The size is the mod's setting, WIDTHxHEIGHT (mod=folderfit:512x388); without one, 512 by 388, less where the screen
// above the taskbar is smaller.
// Hot-loaded: sysApp.cmd('reload', ['mod-folderfit.js']); loaded again, it takes the place of the last one's hooks
(() => {
  const p = machine.proc, W = self.W95Win32, u = p.byName && p.byName.get('USER32');
  const offs = self.W95ModOff || (self.W95ModOff = {});
  if (offs['mod-folderfit.js']) offs['mod-folderfit.js']();
  const make = u && u.exports && u.exports.get('CreateWindowExA'), place = u && u.exports && u.exports.get('SetWindowPlacement');
  if (!make || !place) { W.log('warn', 'mod', 'folderfit: no USER32'); return; }
  const m = /^(\d+)x(\d+)$/i.exec(String(self.W95ModArg == null ? '' : self.W95ModArg).trim());
  const WIDTH = m ? +m[1] : 512, HEIGHT = m ? +m[2] : 388;
  const FOLDER = /^(CabinetWClass|ExploreWClass)$/, DEFAULT = 0x80000000, TASKBAR = 30, MARGIN = 4, STEP = 22;
  let n = 0, busy = false;
  /** the screen above the taskbar, and the size inside it (GetSystemMetrics: SM_CXSCREEN, SM_CYSCREEN) */
  const room = () => { busy = true; try { const sw = p.user16(179, [['w', 0]]).ax, sh = p.user16(179, [['w', 1]]).ax - TASKBAR; return { sw, sh, w: Math.min(WIDTH, sw - 2 * MARGIN), h: Math.min(HEIGHT, sh - MARGIN) }; } finally { busy = false; } };
  const hooks = [];
  // CreateWindowExA(exStyle, class, name, style, x, y, width, height, ...): the return address, then the arguments.
  // A folder window at the default size: the size, each one a step down and right of the last while it stays on the screen
  hooks.push(p.addEntryHook(make, function () {
    if (busy) return undefined;
    const sp = p.cpu.esp.value >>> 0, cls = p.r32(sp + 8) >>> 0;
    if (cls < 0x10000 || !FOLDER.test(p.readA(cls, 32) || '') || (p.r32(sp + 28) >>> 0) !== DEFAULT) return undefined;
    const r = room(), k = n++ % 4, x = Math.min(MARGIN + STEP * k, r.sw - MARGIN - r.w), y = Math.min(MARGIN + STEP * k, r.sh - r.h);
    p.w32(sp + 20, x); p.w32(sp + 24, y); p.w32(sp + 28, r.w); p.w32(sp + 32, r.h);
    return undefined;   // (USER makes it)
  }));
  // SetWindowPlacement(hwnd, WINDOWPLACEMENT*): rcNormalPosition (left, top, right, bottom) at 28. By the folder
  // window's own code (BROWSEUI's on Windows 98, SHELL32's on Windows 95: the return address): the place it was left,
  // moved up and left as far as it must to be on the screen, at the size
  hooks.push(p.addEntryHook(place, function () {
    if (busy) return undefined;
    const sp = p.cpu.esp.value >>> 0, ret = p.r32(sp) >>> 0, wp = p.r32(sp + 8) >>> 0;
    if (!wp || !['BROWSEUI', 'SHELL32'].some(name => { const d = p.byName.get(name); return d && ret >= d.base && ret < d.base + d.size; })) return undefined;
    const r = room(), l = Math.max(0, Math.min(p.r32(wp + 28) | 0, r.sw - MARGIN - r.w)), t = Math.max(0, Math.min(p.r32(wp + 32) | 0, r.sh - r.h));
    p.w32(wp + 28, l); p.w32(wp + 32, t); p.w32(wp + 36, l + r.w); p.w32(wp + 40, t + r.h);
    return undefined;
  }));
  offs['mod-folderfit.js'] = () => { for (const off of hooks) off(); };
  W.log('info', 'mod', `folderfit: folder windows open ${WIDTH} by ${HEIGHT}`);
})();
