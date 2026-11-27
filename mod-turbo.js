// Turbo: the machine run x times ahead of the wall (braid.speed x), x its setting (the page's address, #mod=turbo:8; loaded
// by hand, sysApp.cmd('reload', ['mod-turbo.js', 8])). With programs named after an @, x@SETUP,W98SETUP,SUWIN,RUNONCE,
// only while one of them runs: a program by its file's name, .EXE or not (a 16-bit task by its module's, a 32-bit
// process by its file's), the machine at a person's pace again once none does (bench/setup98.mjs names Windows 98
// Setup's and RUNONCE's). The address's mods are loaded into each system's machine after it (Setup's restart), so the
// list holds across it. Ended (the parameter taken out, cmd 'modOff'), the machine runs at a person's pace again.
// An x below 1 is a slower processor while they run (worker.js 'speed'): the machine's time still the wall's, x of the
// code run in it, as a program whose own loop has no timing ran on a PC of its day (#mod=turbo:0.1@SOL, Solitaire)
(() => {
  const arg = String(self.W95ModArg == null ? '' : self.W95ModArg), at = arg.indexOf('@');
  const x = Math.min(64, Math.max(0.01, Number(at < 0 ? arg : arg.slice(0, at)) || 1)), W = self.W95Win32, p = machine.proc;
  const names = new Set((at < 0 ? '' : arg.slice(at + 1)).split(',').map(s => s.trim().toUpperCase().replace(/\.EXE$/, '')).filter(Boolean));
  const offs = self.W95ModOff || (self.W95ModOff = {});
  if (offs['mod-turbo.js']) offs['mod-turbo.js']();   // (loaded again: the last one's watch ended first)
  if (!names.size) {
    machine.cmd('speed', [x]);
    offs['mod-turbo.js'] = () => machine.cmd('speed', [1]);
    W.log('info', 'mod', `turbo: ${x} times the wall's pace`);
    return;
  }
  /** the programs running now, by name: each 16-bit task's module (its TDB's name, at F2h) and each live process's file */
  const running = () => {
    const out = [];
    for (const s of p.tdbList || []) { try { if (p.selValid(s)) out.push((p.readA(p.selBase(s) + 0xf2, 8) || '').trim().toUpperCase()); } catch (_) { /* gone */ } }
    for (const pc of (p.procs || new Map()).values()) if (pc && pc.path && (pc.exitCode === null || pc.exitCode === undefined)) out.push(pc.path.replace(/^.*\\/, '').toUpperCase().replace(/\.EXE$/, ''));
    return out;
  };
  let on = null;
  const check = () => {
    const who = running().find(n => names.has(n)), want = !!who;
    if (want === on) return;
    on = want; machine.cmd('speed', [want ? x : 1]);
    W.log('info', 'mod', want ? `turbo: ${who} runs, ${x} times the wall's pace` : 'turbo: none of its programs runs, the wall\'s pace');
  };
  const timer = setInterval(check, 500); check();
  offs['mod-turbo.js'] = () => { clearInterval(timer); machine.cmd('speed', [1]); };
  W.log('info', 'mod', `turbo: ${x} times the wall's pace while ${[...names].join(', ')} runs`);
})();
