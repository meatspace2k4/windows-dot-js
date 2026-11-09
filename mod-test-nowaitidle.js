// (a test, as a boot mod (bootmods=): ne16.js's pass-by of Win16 tasks waiting in WaitEvent (waitBlocked's task branch)
// turned off, for an A/B of the boot)
(() => {
  const P = self.W95Win32 && self.W95Win32.Process.prototype; if (!P || P.__noWaitIdle) return; P.__noWaitIdle = true;
  const was = P.waitBlocked;
  P.waitBlocked = function (t) { if (t.task && t.slept) return false; return was.call(this, t); };
  self.W95Win32.log('warn', 'ab', 'waitBlocked: Win16 tasks in WaitEvent run every round again');
})();
