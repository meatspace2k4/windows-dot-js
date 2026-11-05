// Windows 98 Setup's "Estimated time remaining" at the machine's speed: the minutes Setup works out are multiplied by
// the wall's time over the machine's (the taskbar's Turbo meter's ratio, session-tray.js), so the figure is real
// minutes when the machine runs faster than the wall's (braid.speed). Hot-loaded (sysApp.cmd('reload',
// ['mod-setupclock.js'])): W98SETUP shows the figure with USER's wsprintf, "%d %s" with "minutes"; each integer of
// a format from Setup's tasks whose text, or a string it formats, says minutes is multiplied before USER formats it.
// Loaded again, it takes the place of the last one's hooks
(() => {
  const p = machine.proc, W = self.W95Win32, u = p.ne && p.ne.get('USER'), vc = machine.vclock;
  if (!u) { W.log('warn', 'mod', 'setupclock: no USER'); return; }
  for (const off of p.setupClockOff || []) off();
  const SETUP = /^(W98SETUP|SUWIN|SETUP)$/i;
  // (the machine's clock against the wall's over the last 8 s, sampled every second, as the meter measures it)
  const samples = [[performance.now(), vc ? vc.now : 0]];
  const sample = () => { const now = [performance.now(), vc ? vc.now : 0]; samples.push(now); while (samples.length > 2 && now[0] - samples[1][0] >= 8000) samples.shift(); return now; };
  clearInterval(p.setupClockTimer); p.setupClockTimer = setInterval(sample, 1000);
  const multiplier = () => { const now = sample(), [w0, m0] = samples[0], dw = now[0] - w0, dm = now[1] - m0; return dw > 250 && dm > 0 ? dw / dm : 1; };
  const text = segptr => { try { return (segptr >>> 16 ? p.readA(p.lin(segptr), 256) : '') || ''; } catch (_) { return ''; } };
  /** the integers formatted by `fmt` from the arguments at linear `a0`, multiplied in place when the figure is minutes */
  const correct = (fmt, a0) => {
    const convs = [...fmt.matchAll(/%[-#0 +]*(?:\d+|\*)?(?:\.\d+)?(l?)([a-zA-Z])/g)];
    const args = []; let a = a0;
    for (const [, long, conv] of convs) { const ptr = /[sS]/.test(conv); args.push({ a, long: !!long, conv }); a += ptr || long ? 4 : 2; }
    if (!/minute/i.test(fmt) && !args.some(x => /[sS]/.test(x.conv) && /minute/i.test(text(p.r32(x.a))))) return;
    const k = multiplier();
    for (const x of args) if (/[dui]/.test(x.conv)) { if (x.long) p.w32(x.a, Math.max(1, Math.round(p.r32(x.a) * k))); else p.w16(x.a, Math.max(1, Math.round(p.r16(x.a) * k))); }
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
  W.log('info', 'mod', `setupclock: Setup's minutes at the machine's speed (${offs.length} of USER's formatters)`);
})();
