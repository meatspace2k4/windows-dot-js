// the running machine given ne16.js's imgUse change without a restart: a Windows 3.x task's thread leaves the arena's
// process views as they are (its code never runs in a process's image at 400000h)
(() => {
  const P = self.W95Win32 && self.W95Win32.Process.prototype; if (!P || P.imgUse.__arenaskip) return;
  const was = P.imgUse;
  P.imgUse = function (pc) { const t = this.thread16; if (!pc && t && t.task && !t.pc) return this.dllUse(pc); return was.call(this, pc); };
  P.imgUse.__arenaskip = true;
})();
