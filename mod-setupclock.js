// Windows 98 Setup's "Estimated time remaining" in real minutes: Setup's countdown is timed against the wall (what its
// last minutes took, each, times the minutes left); before it has counted 3, its minutes times the wall's time over the
// machine's (the taskbar's Turbo meter's ratio, session-tray.js). A figure past an hour is shown as 7. Hot-loaded (sysApp.cmd('reload',
// ['mod-setupclock.js'])): W98SETUP shows the figure with USER's wsprintf, "%d %s" with "minutes"; each integer of
// a format from Setup's tasks whose text, or a string it formats, says minutes is multiplied before USER formats it.
// Loaded again, it takes the place of the last one's hooks
(() => {
  const p = machine.proc, W = self.W95Win32, u = p.ne && p.ne.get('USER'), vc = machine.vclock;
  if (!u) { W.log('warn', 'mod', 'setupclock: no USER'); return; }
  for (const off of p.setupClockOff || []) off();
  const SETUP = /^(W98SETUP|SUWIN|SETUP)$/i, OVER_HOUR = 7, COUNT_SPAN = 30;   // (COUNT_SPAN: the countdown's last minutes its pace is taken over)
  // (the machine's clock against the wall's over the last two minutes, sampled every second. Over the meter's 8 s the
  // ratio swung with what the machine was doing that moment, a copy's bursts against its waits, and the figure with it:
  // 7, 10, 2, 1 within a minute)
  const samples = [[performance.now(), vc ? vc.now : 0]];
  const sample = () => { const now = [performance.now(), vc ? vc.now : 0]; samples.push(now); while (samples.length > 2 && now[0] - samples[1][0] >= 120000) samples.shift(); return now; };
  clearInterval(p.setupClockTimer); p.setupClockTimer = setInterval(sample, 1000);
  const multiplier = () => { const now = sample(), [w0, m0] = samples[0], dw = now[0] - w0, dm = now[1] - m0; return dw > 250 && dm > 0 ? dw / dm : 1; };
  const text = segptr => { try { return (segptr >>> 16 ? p.readA(p.lin(segptr), 256) : '') || ''; } catch (_) { return ''; } };
  /** the integers formatted by `fmt` from the arguments at linear `a0`, multiplied in place when the figure is minutes */
  const correct = (fmt, a0) => {
    const convs = [...fmt.matchAll(/%[-#0 +]*(?:\d+|\*)?(?:\.\d+)?(l?)([a-zA-Z])/g)];
    const args = []; let a = a0;
    for (const [, long, conv] of convs) { const ptr = /[sS]/.test(conv); args.push({ a, long: !!long, conv }); a += ptr || long ? 4 : 2; }
    if (!/minute/i.test(fmt) && !args.some(x => /[sS]/.test(x.conv) && /minute/i.test(text(p.r32(x.a))))) return;
    // (a figure past an hour is no estimate of this machine's: before the copy starts Setup's own figure, measured by
    // nothing yet, came out as 144 minutes. Shown as OVER_HOUR minutes until Setup has a figure under the hour)
    // (each figure that differs from the last is in the log with what it was made from: Setup's minutes, the wall's time
    // over the machine's, the minutes shown)
    // (the figure is Setup's countdown timed against the wall: the wall's time its last minutes took, each, times the
    // minutes left. Setup's minutes are no time of this machine's: its clock ran 80 times the wall's during the copy
    // (waits on the host counted at the turbo's scale), and 87 of them, 6 real minutes of copying, were shown as 1.
    // Until the countdown has gone 3 minutes, the minutes at the clocks' ratio)
    const k = multiplier(), real = v => {
      const now = performance.now(), h = p.setupClockSeen || (p.setupClockSeen = []);
      if (h.length && v > h[h.length - 1][0]) h.length = 0;   // (a figure that went up: another count)
      if (!h.length || v < h[h.length - 1][0]) h.push([v, now]);
      while (h.length > 2 && h[0][0] - v > COUNT_SPAN) h.shift();
      const [v0, t0] = h[0], counted = v0 - v;
      const m = Math.max(1, Math.round(counted >= 3 ? (now - t0) / 60000 / counted * v : v * k)), shown = m > 60 ? OVER_HOUR : m, key = `${v}:${shown}`;
      if (p.setupClockLast !== key) { p.setupClockLast = key; W.log('debug', 'mod', `setupclock: Setup's ${v} minutes shown as ${shown} (${counted >= 3 ? `${counted} of its minutes took ${Math.round((now - t0) / 1000)} s` : `x ${k.toFixed(3)}, wall over machine`}), at ${Math.round(now / 1000)} s`); }
      return shown;
    };
    for (const x of args) if (/[dui]/.test(x.conv)) { if (x.long) p.w32(x.a, real(p.r32(x.a))); else p.w16(x.a, real(p.r16(x.a))); }
  };
  const setup = () => { const t = p.thread16, mod = t && t.task && t.task.mod; return !!(mod && SETUP.test(mod.name || '')); };
  const at = (sp, k) => p.r32((p.cpu.ssb.value >>> 0) + ((sp + k) & 0xffff)) >>> 0;
  const offs = [];
  // _wsprintf (cdecl): the return address, lpOut, lpFmt, then the arguments
  const ws = p.neExport(u, '_WSPRINTF');
  if (ws) offs.push(p.addEntryHook((p.selBase(ws >>> 16) + (ws & 0xffff)) >>> 0, function () {
    if (setup()) { const sp = p.cpu.esp.value & 0xffff; correct(text(at(sp, 8)), (p.cpu.ssb.value >>> 0) + ((sp + 12) & 0xffff)); }
    return undefined;   // (USER formats it)
  }));
  // wvsprintf (pascal): the return address, lpArgs, lpFmt, lpOut
  const wv = p.neExport(u, 'WVSPRINTF');
  if (wv) offs.push(p.addEntryHook((p.selBase(wv >>> 16) + (wv & 0xffff)) >>> 0, function () {
    if (setup()) { const sp = p.cpu.esp.value & 0xffff; correct(text(at(sp, 8)), p.lin(at(sp, 4))); }
    return undefined;
  }));
  p.setupClockOff = offs;
  (self.W95ModOff || (self.W95ModOff = {}))['mod-setupclock.js'] = () => { for (const off of offs) off(); p.setupClockOff = []; clearInterval(p.setupClockTimer); };
  W.log('info', 'mod', `setupclock: Setup's minutes at the machine's speed (${offs.length} of USER's formatters)`);
})();
